'use strict';

const crypto = require('crypto');

const SUPPORTED_TOPICS = new Set(['orders_v2','shipments','messages','claims']);
const MAX_RETRIES = 8;
const RETRY_DELAYS_SECONDS = [15,60,300,900,1800,3600,7200,14400];

function resourceId(resource) {
  const parts=String(resource || '').split('?')[0].split('/').filter(Boolean);
  return parts.length ? String(parts[parts.length-1]) : '';
}

function normalizeMercadoLibreNotification(payload,expectedApplicationId = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const topic=String(payload.topic || '').trim().toLowerCase();
  const resource=String(payload.resource || '').trim().slice(0,500);
  const userId=String(payload.user_id || payload.userId || '').trim().slice(0,100);
  const applicationId=String(payload.application_id || payload.applicationId || '').trim().slice(0,100);
  if (!SUPPORTED_TOPICS.has(topic) || !resource || !userId) return null;
  if (expectedApplicationId && applicationId !== String(expectedApplicationId)) return null;
  const externalId=String(payload._id || payload.id || '').trim().slice(0,180);
  const rawSentAt=String(payload.sent || '').trim();
  const sentAt=rawSentAt && Number.isFinite(Date.parse(rawSentAt)) ? rawSentAt : '';
  const base=externalId || [topic,resource,userId,applicationId,sentAt].join('|');
  const eventKey=crypto.createHash('sha256').update(base).digest('hex');
  return {
    eventKey,externalId,topic,resource,resourceId:resourceId(resource),userId,applicationId,
    attempts:Math.max(0,Number(payload.attempts) || 0),sentAt:sentAt || null,payload
  };
}

function retryDelaySeconds(retryCount) {
  return RETRY_DELAYS_SECONDS[Math.min(Math.max(0,retryCount-1),RETRY_DELAYS_SECONDS.length-1)];
}

async function touchOrderRealtimeState(pool,ownerUsername,topic,orderId = '') {
  await pool.query(`INSERT INTO order_realtime_state(owner_username,version,last_topic,last_order_id,updated_at)
    VALUES($1,1,$2,$3,NOW()) ON CONFLICT(owner_username) DO UPDATE SET
    version=order_realtime_state.version+1,last_topic=EXCLUDED.last_topic,last_order_id=EXCLUDED.last_order_id,updated_at=NOW()`,
  [String(ownerUsername),String(topic || ''),String(orderId || '')]);
}

async function getOrderRealtimeState(pool,ownerUsername) {
  const { rows }=await pool.query(`SELECT version,last_topic AS "lastTopic",last_order_id AS "lastOrderId",updated_at AS "updatedAt"
    FROM order_realtime_state WHERE owner_username=$1`,[String(ownerUsername)]);
  return rows[0] || { version:0,lastTopic:'',lastOrderId:'',updatedAt:null };
}

function createMercadoLibreWebhookService({ pool,expectedApplicationId,resolveTargets,processEvent,logger = console }) {
  let timer=null,running=false,stopped=false;

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ml_webhook_events (
      id BIGSERIAL PRIMARY KEY,event_key VARCHAR(64) UNIQUE NOT NULL,external_id VARCHAR(180),topic VARCHAR(50) NOT NULL,
      resource VARCHAR(500) NOT NULL,resource_id VARCHAR(180),user_id VARCHAR(100) NOT NULL,application_id VARCHAR(100),
      official_attempts INTEGER NOT NULL DEFAULT 0,payload JSONB NOT NULL DEFAULT '{}'::jsonb,status VARCHAR(20) NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_error TEXT,result_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      sent_at TIMESTAMPTZ,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),processed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_webhook_queue ON ml_webhook_events(status,available_at,id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS order_realtime_state (
      owner_username VARCHAR(120) PRIMARY KEY,version BIGINT NOT NULL DEFAULT 0,last_topic VARCHAR(50),last_order_id VARCHAR(100),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`UPDATE ml_webhook_events SET status='retry',available_at=NOW(),updated_at=NOW()
      WHERE status='processing' AND updated_at<NOW()-INTERVAL '10 minutes'`);
    await pool.query(`DELETE FROM ml_webhook_events WHERE status IN ('done','ignored')
      AND processed_at<NOW()-INTERVAL '90 days'`);
  }

  async function enqueue(payload) {
    const event=normalizeMercadoLibreNotification(payload,expectedApplicationId);
    if (!event) return { accepted:false };
    const { rowCount }=await pool.query(`INSERT INTO ml_webhook_events
      (event_key,external_id,topic,resource,resource_id,user_id,application_id,official_attempts,payload,sent_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      ON CONFLICT(event_key) DO UPDATE SET official_attempts=GREATEST(ml_webhook_events.official_attempts,EXCLUDED.official_attempts),
      received_at=NOW(),updated_at=NOW()`,[
      event.eventKey,event.externalId || null,event.topic,event.resource,event.resourceId || null,event.userId,event.applicationId || null,
      event.attempts,JSON.stringify(event.payload),event.sentAt
    ]);
    trigger();
    return { accepted:true,inserted:Boolean(rowCount),eventKey:event.eventKey };
  }

  async function claimNext() {
    const { rows }=await pool.query(`WITH candidate AS (
      SELECT id FROM ml_webhook_events WHERE status IN ('pending','retry') AND available_at<=NOW()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE ml_webhook_events e SET status='processing',updated_at=NOW()
      FROM candidate WHERE e.id=candidate.id RETURNING e.*`);
    return rows[0] || null;
  }

  async function markComplete(id,status,result = {}) {
    await pool.query(`UPDATE ml_webhook_events SET status=$2,result_data=$3::jsonb,last_error=NULL,processed_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [id,status,JSON.stringify(result || {})]);
  }

  async function markFailed(event,error) {
    const nextRetry=Number(event.retry_count || 0)+1;
    const final=nextRetry>=MAX_RETRIES;
    const delay=retryDelaySeconds(nextRetry);
    await pool.query(`UPDATE ml_webhook_events SET status=$2,retry_count=$3,last_error=$4,
      available_at=CASE WHEN $2='failed' THEN available_at ELSE NOW()+($5::int*INTERVAL '1 second') END,updated_at=NOW() WHERE id=$1`,
      [event.id,final ? 'failed' : 'retry',nextRetry,String(error?.response?.data?.message || error?.message || error).slice(0,2000),delay]);
  }

  async function processOne(event) {
    try {
      const targets=await resolveTargets(String(event.user_id));
      if (!targets.length) {
        await markComplete(event.id,'ignored',{ reason:'no_enabled_store_authorization' });
        return;
      }
      const results=[];
      for (const target of targets) results.push(await processEvent({
        id:event.id,topic:event.topic,resource:event.resource,resourceId:event.resource_id || resourceId(event.resource),
        userId:event.user_id,applicationId:event.application_id,payload:event.payload
      },target));
      await markComplete(event.id,'done',{ targets:targets.length,results });
    } catch (error) {
      logger.error('[Webhook] 美客多通知处理失败:',event.topic,event.resource,error.response?.data || error.message);
      await markFailed(event,error);
    }
  }

  async function run() {
    if (running || stopped) return;
    running=true;
    try {
      for (let i=0;i<20;i++) {
        const event=await claimNext();
        if (!event) break;
        await processOne(event);
      }
    } finally { running=false; }
  }

  function trigger() { if (!stopped) setImmediate(()=>run().catch(error=>logger.error('[Webhook] 队列异常:',error.message))); }
  function start() {
    stopped=false;
    if (!timer) { timer=setInterval(trigger,5000); timer.unref?.(); }
    trigger();
  }
  function stop() { stopped=true; if (timer) clearInterval(timer); timer=null; }

  function registerRoutes(app) {
    app.post('/api/webhooks/mercadolibre',async (req,res) => {
      // Persist before acknowledging; processing stays asynchronous and does not delay the callback.
      try {
        const result=await enqueue(req.body || {});
        res.status(200).json({ code:0,message:'received',accepted:result.accepted });
      } catch (error) {
        logger.error('[Webhook] notification persistence failed:',error.message);
        res.status(503).json({ code:503,message:'queue unavailable' });
      }
    });
    app.get('/api/health/mercadolibre-webhook',(req,res) => res.json({ code:0,data:{
      enabled:Boolean(expectedApplicationId),topics:[...SUPPORTED_TOPICS],queueRunning:Boolean(timer) && !stopped,
      processing:running,callback:'/api/webhooks/mercadolibre'
    } }));
  }

  return { init,enqueue,run,start,stop,registerRoutes };
}

module.exports={
  SUPPORTED_TOPICS,normalizeMercadoLibreNotification,resourceId,retryDelaySeconds,
  touchOrderRealtimeState,getOrderRealtimeState,createMercadoLibreWebhookService
};
