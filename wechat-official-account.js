'use strict';

const crypto=require('crypto');
const axios=require('axios');

const DEFAULT_OFFICIAL_APP_ID='wx1758849125581a06';
const DEFAULT_MINIPROGRAM_APP_ID='wx0f97428df87ee76e';
const EVENT_TYPES=['new_order','cancelled','deadline','refund','shipped','buyer_inquiry','after_sales','binding_success'];
const RETRY_DELAYS_SECONDS=[15,60,300,900,1800,3600,7200,14400];
const OFFICIAL_TEMPLATE_PRESETS={
  new_order:{ title:'客户新订单处理通知',pagePath:'pages/order-detail/index?id={{orderId}}',dataMapping:{
    character_string5:{ source:'orderNumber',maxLength:32 },amount7:{ source:'amount',maxLength:16 },
    character_string15:{ source:'quantity',maxLength:12 },time4:{ source:'eventTime',maxLength:20 }
  } },
  cancelled:{ title:'订单取消成功通知',pagePath:'pages/order-detail/index?id={{orderId}}',dataMapping:{
    character_string8:{ source:'orderNumber',maxLength:32 },amount4:{ source:'amount',maxLength:16 },
    time6:{ source:'eventTime',maxLength:20 }
  } },
  deadline:{ title:'订单物流异常通知',pagePath:'pages/order-detail/index?id={{orderId}}',dataMapping:{
    character_string4:{ source:'orderNumber',maxLength:32 },const1:{ source:'title',maxLength:20 }
  } },
  refund:{ title:'订单退款成功通知',pagePath:'pages/order-detail/index?id={{orderId}}',dataMapping:{
    character_string1:{ source:'orderNumber',maxLength:32 },time2:{ source:'eventTime',maxLength:20 },
    thing3:{ source:'productName',maxLength:20 },thing4:{ source:'quantity',maxLength:20 },amount5:{ source:'amount',maxLength:16 }
  } },
  shipped:{ title:'订单发货通知',pagePath:'pages/order-detail/index?id={{orderId}}',dataMapping:{
    character_string1:{ source:'orderNumber',maxLength:32 },time3:{ source:'eventTime',maxLength:20 }
  } },
  buyer_inquiry:{ title:'服务工单已推送提醒',pagePath:'pages/inquiries/index',dataMapping:{
    time12:{ source:'eventTime',maxLength:20 },phrase5:{ source:'notificationStatus',maxLength:5 },
    character_string2:{ source:'orderNumber',maxLength:32 }
  } },
  after_sales:{ title:'收到客户投诉提醒',pagePath:'pages/after-sales/index',dataMapping:{
    character_string8:{ source:'orderNumber',maxLength:32 },time2:{ source:'eventTime',maxLength:20 },
    const5:{ source:'title',maxLength:20 }
  } },
  binding_success:{ title:'账号绑定成功提醒',pagePath:'pages/home/index',dataMapping:{
    thing1:{ source:'username',maxLength:20 },time3:{ source:'eventTime',maxLength:20 },
    character_string4:{ source:'bindingAccount',maxLength:32 },thing6:{ source:'productName',maxLength:20 }
  } }
};

function sha1Signature(parts) {
  return crypto.createHash('sha1').update(parts.map(value=>String(value || '')).sort().join('')).digest('hex');
}

function safeEqualText(left,right) {
  const a=Buffer.from(String(left || '')),b=Buffer.from(String(right || ''));
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

function xmlValue(xml,name) {
  const match=String(xml || '').match(new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${name}>`,'i'));
  return match ? String(match[1] ?? match[2] ?? '').trim() : '';
}

function parseWeChatXml(xml) {
  const fields=['ToUserName','FromUserName','CreateTime','MsgType','Event','EventKey','Ticket','Encrypt','MsgID','Status'];
  return Object.fromEntries(fields.map(field=>[field,xmlValue(xml,field)]));
}

function unpadPkcs7(buffer) {
  if (!buffer.length) throw new Error('Empty encrypted WeChat message');
  const padding=buffer[buffer.length-1];
  if (padding<1 || padding>32 || padding>buffer.length) throw new Error('Invalid WeChat message padding');
  return buffer.subarray(0,buffer.length-padding);
}

function decryptWeChatMessage(encrypted,encodingAesKey,expectedAppId) {
  const key=Buffer.from(`${String(encodingAesKey || '')}=`, 'base64');
  if (key.length!==32) throw new Error('WECHAT_OFFICIAL_ACCOUNT_AES_KEY is invalid');
  const decipher=crypto.createDecipheriv('aes-256-cbc',key,key.subarray(0,16));
  decipher.setAutoPadding(false);
  const decrypted=unpadPkcs7(Buffer.concat([decipher.update(String(encrypted || ''),'base64'),decipher.final()]));
  if (decrypted.length<20) throw new Error('Encrypted WeChat message is incomplete');
  const xmlLength=decrypted.readUInt32BE(16);
  const xmlStart=20,xmlEnd=xmlStart+xmlLength;
  if (xmlEnd>decrypted.length) throw new Error('Encrypted WeChat message length is invalid');
  const appId=decrypted.subarray(xmlEnd).toString('utf8');
  if (expectedAppId && appId!==expectedAppId) throw new Error('Encrypted WeChat message AppID does not match');
  return decrypted.subarray(xmlStart,xmlEnd).toString('utf8');
}

function preferenceColumn(eventType) {
  return {
    new_order:'new_order_enabled',cancelled:'cancelled_enabled',deadline:'deadline_enabled',refund:'refund_enabled',
    shipped:'shipped_enabled',buyer_inquiry:'buyer_inquiry_enabled',after_sales:'after_sales_enabled',
    binding_success:'binding_success_enabled'
  }[eventType] || '';
}

function retryDelaySeconds(retryCount) {
  return RETRY_DELAYS_SECONDS[Math.min(Math.max(0,Number(retryCount || 1)-1),RETRY_DELAYS_SECONDS.length-1)];
}

function renderValue(template,payload) {
  if (typeof template!=='string') return String(template ?? '');
  if (Object.prototype.hasOwnProperty.call(payload,template)) return String(payload[template] ?? '');
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,(_,key)=>String(payload[key] ?? ''));
}

function renderTemplateData(mapping,payload) {
  const result={};
  for (const [field,definition] of Object.entries(mapping || {})) {
    const source=definition && typeof definition==='object' ? definition.source : definition;
    const maxLength=Math.max(1,Math.min(200,Number(definition?.maxLength || 40)));
    const value=renderValue(source,payload).slice(0,maxLength);
    result[field]={ value };
    if (definition?.color && /^#[0-9a-f]{6}$/i.test(String(definition.color))) result[field].color=definition.color;
  }
  return result;
}

function createOfficialAccountService({ pool,requireAdmin,logger=console }) {
  const appId=process.env.WECHAT_OFFICIAL_ACCOUNT_APPID || DEFAULT_OFFICIAL_APP_ID;
  const appSecret=process.env.WECHAT_OFFICIAL_ACCOUNT_SECRET || '';
  const callbackToken=process.env.WECHAT_OFFICIAL_ACCOUNT_TOKEN || '';
  const encodingAesKey=process.env.WECHAT_OFFICIAL_ACCOUNT_AES_KEY || '';
  const miniProgramAppId=process.env.WECHAT_MINIPROGRAM_APPID || DEFAULT_MINIPROGRAM_APP_ID;
  const callbackPath='/api/wechat/official-account/events';
  let accessTokenCache={ token:'',expiresAt:0 },accessTokenPromise=null;
  let scanTimer=null,workerTimer=null,followerSyncTimer=null,templateSyncTimer=null;
  let scanning=false,working=false,syncingFollowers=false,stopped=false;
  let templateSyncStatus={ synced:false,configured:0,missing:EVENT_TYPES.length,lastAt:null,error:'' };

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS wechat_official_followers (
      open_id VARCHAR(160) PRIMARY KEY,union_id VARCHAR(160),erp_username VARCHAR(120),subscribed BOOLEAN NOT NULL DEFAULT TRUE,
      subscribe_scene VARCHAR(120),profile_data JSONB NOT NULL DEFAULT '{}'::jsonb,subscribed_at TIMESTAMPTZ,
      unsubscribed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_official_union ON wechat_official_followers(union_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_official_erp ON wechat_official_followers(erp_username,subscribed)');
    await pool.query(`CREATE TABLE IF NOT EXISTS wechat_official_notification_preferences (
      owner_username VARCHAR(120) PRIMARY KEY,enabled BOOLEAN NOT NULL DEFAULT TRUE,new_order_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      cancelled_enabled BOOLEAN NOT NULL DEFAULT TRUE,deadline_enabled BOOLEAN NOT NULL DEFAULT TRUE,refund_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      shipped_enabled BOOLEAN NOT NULL DEFAULT TRUE,buyer_inquiry_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      after_sales_enabled BOOLEAN NOT NULL DEFAULT TRUE,binding_success_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('ALTER TABLE wechat_official_notification_preferences ADD COLUMN IF NOT EXISTS shipped_enabled BOOLEAN NOT NULL DEFAULT TRUE');
    await pool.query('ALTER TABLE wechat_official_notification_preferences ADD COLUMN IF NOT EXISTS binding_success_enabled BOOLEAN NOT NULL DEFAULT TRUE');
    await pool.query(`CREATE TABLE IF NOT EXISTS wechat_official_template_configs (
      event_type VARCHAR(40) PRIMARY KEY,template_id VARCHAR(160) NOT NULL DEFAULT '',data_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
      page_path VARCHAR(500) NOT NULL DEFAULT '',enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS wechat_official_notification_outbox (
      id BIGSERIAL PRIMARY KEY,event_key VARCHAR(320) UNIQUE NOT NULL,owner_username VARCHAR(120) NOT NULL,open_id VARCHAR(160) NOT NULL,
      event_type VARCHAR(40) NOT NULL,order_id VARCHAR(100),payload JSONB NOT NULL DEFAULT '{}'::jsonb,status VARCHAR(30) NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),wechat_msg_id VARCHAR(160),last_error TEXT,
      response_data JSONB NOT NULL DEFAULT '{}'::jsonb,sent_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_official_outbox_queue ON wechat_official_notification_outbox(status,available_at,id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS wechat_official_callback_audits (
      id BIGSERIAL PRIMARY KEY,event_type VARCHAR(80),open_id VARCHAR(160),payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (const eventType of EVENT_TYPES) {
      const envKey=`WECHAT_OFFICIAL_TEMPLATE_${eventType.toUpperCase()}_ID`;
      const fieldsKey=`WECHAT_OFFICIAL_TEMPLATE_${eventType.toUpperCase()}_FIELDS_JSON`;
      const preset=OFFICIAL_TEMPLATE_PRESETS[eventType] || {};
      let mapping=preset.dataMapping || {};
      try { mapping=JSON.parse(process.env[fieldsKey] || '{}'); } catch (_) { mapping={}; }
      if (!Object.keys(mapping).length) mapping=preset.dataMapping || {};
      const pagePath=preset.pagePath || 'pages/order-detail/index?id={{orderId}}';
      await pool.query(`INSERT INTO wechat_official_template_configs(event_type,template_id,data_mapping,page_path)
        VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(event_type) DO UPDATE SET
        template_id=CASE WHEN wechat_official_template_configs.template_id='' AND EXCLUDED.template_id<>'' THEN EXCLUDED.template_id ELSE wechat_official_template_configs.template_id END,
        data_mapping=CASE WHEN wechat_official_template_configs.data_mapping='{}'::jsonb AND EXCLUDED.data_mapping<>'{}'::jsonb THEN EXCLUDED.data_mapping ELSE wechat_official_template_configs.data_mapping END`,
      [eventType,String(process.env[envKey] || ''),JSON.stringify(mapping),pagePath]);
    }
    await pool.query(`INSERT INTO settings(key,value,updated_at)
      SELECT 'wechat_official_alert_cursor',COALESCE(MAX(id),0)::text,NOW() FROM order_alerts ON CONFLICT(key) DO NOTHING`);
    await pool.query(`UPDATE wechat_official_notification_outbox SET status='retry',available_at=NOW(),updated_at=NOW()
      WHERE status='processing' AND updated_at<NOW()-INTERVAL '10 minutes'`);
    await pool.query(`DELETE FROM wechat_official_callback_audits WHERE received_at<NOW()-INTERVAL '90 days'`);
  }

  async function getAccessToken(force=false) {
    if (!appSecret) throw new Error('WECHAT_OFFICIAL_ACCOUNT_SECRET is not configured');
    if (!force && accessTokenCache.token && accessTokenCache.expiresAt>Date.now()+60000) return accessTokenCache.token;
    if (accessTokenPromise) return accessTokenPromise;
    accessTokenPromise=(async()=>{
      const response=await axios.post('https://api.weixin.qq.com/cgi-bin/stable_token',{
        grant_type:'client_credential',appid:appId,secret:appSecret,force_refresh:Boolean(force)
      },{ timeout:15000 });
      const data=response.data || {};
      if (data.errcode || !data.access_token) throw new Error(data.errmsg || `WeChat access token error ${data.errcode || ''}`);
      accessTokenCache={ token:String(data.access_token),expiresAt:Date.now()+Number(data.expires_in || 7200)*1000 };
      return accessTokenCache.token;
    })();
    try { return await accessTokenPromise; } finally { accessTokenPromise=null; }
  }

  async function weChatApi(method,url,body,allowTokenRetry=true) {
    const token=await getAccessToken(false);
    const response=await axios({ method,url,params:{ access_token:token },data:body,timeout:20000 });
    const data=response.data || {};
    if (allowTokenRetry && [40001,40014,42001].includes(Number(data.errcode))) {
      await getAccessToken(true);
      return weChatApi(method,url,body,false);
    }
    if (data.errcode) throw Object.assign(new Error(data.errmsg || `WeChat API error ${data.errcode}`),{ wechat:data });
    return data;
  }

  async function resolveErpUsername(unionId) {
    if (!unionId) return '';
    const { rows }=await pool.query(`SELECT erp_username FROM wechat_miniprogram_identities
      WHERE union_id=$1 AND erp_username IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,[String(unionId)]);
    return String(rows[0]?.erp_username || '');
  }

  async function persistCallbackAudit(payload) {
    const openId=String(payload.FromUserName || '');
    const event=String(payload.Event || '').toLowerCase();
    await pool.query(`INSERT INTO wechat_official_callback_audits(event_type,open_id,payload)
      VALUES($1,$2,$3::jsonb)`,[event || String(payload.MsgType || ''),openId,JSON.stringify(payload)]);
  }

  async function handleCallbackEvent(payload) {
    const openId=String(payload.FromUserName || '');
    const event=String(payload.Event || '').toLowerCase();
    if (!openId) return;
    if (event==='subscribe') {
      let profile={};
      if (appSecret) {
        const token=await getAccessToken(false);
        const response=await axios.get('https://api.weixin.qq.com/cgi-bin/user/info',{
          params:{ access_token:token,openid:openId,lang:'zh_CN' },timeout:15000
        });
        profile=response.data?.errcode ? {} : (response.data || {});
      }
      const unionId=String(profile.unionid || '');
      const ownerUsername=await resolveErpUsername(unionId);
      await pool.query(`INSERT INTO wechat_official_followers(open_id,union_id,erp_username,subscribed,subscribe_scene,profile_data,subscribed_at,unsubscribed_at,updated_at)
        VALUES($1,$2,$3,TRUE,$4,$5::jsonb,NOW(),NULL,NOW()) ON CONFLICT(open_id) DO UPDATE SET
        union_id=COALESCE(NULLIF(EXCLUDED.union_id,''),wechat_official_followers.union_id),
        erp_username=COALESCE(NULLIF(EXCLUDED.erp_username,''),wechat_official_followers.erp_username),subscribed=TRUE,
        subscribe_scene=EXCLUDED.subscribe_scene,profile_data=EXCLUDED.profile_data,subscribed_at=NOW(),unsubscribed_at=NULL,updated_at=NOW()`,
      [openId,unionId,ownerUsername,String(payload.EventKey || ''),JSON.stringify(profile)]);
    } else if (event==='unsubscribe') {
      await pool.query(`UPDATE wechat_official_followers SET subscribed=FALSE,unsubscribed_at=NOW(),updated_at=NOW() WHERE open_id=$1`,[openId]);
    } else if (event==='templatesendjobfinish') {
      await pool.query(`UPDATE wechat_official_notification_outbox SET response_data=response_data||$1::jsonb,updated_at=NOW()
        WHERE wechat_msg_id=$2`,[JSON.stringify({ deliveryStatus:payload.Status || '',deliveryAt:new Date().toISOString() }),String(payload.MsgID || '')]);
    }
  }

  async function upsertFollowerProfile(profile) {
    const openId=String(profile?.openid || '');
    if (!openId || Number(profile?.subscribe)===0) return false;
    const unionId=String(profile?.unionid || '');
    const ownerUsername=await resolveErpUsername(unionId);
    await pool.query(`INSERT INTO wechat_official_followers(open_id,union_id,erp_username,subscribed,subscribe_scene,profile_data,subscribed_at,unsubscribed_at,updated_at)
      VALUES($1,$2,$3,TRUE,$4,$5::jsonb,COALESCE(TO_TIMESTAMP(NULLIF($6,0)),NOW()),NULL,NOW()) ON CONFLICT(open_id) DO UPDATE SET
      union_id=COALESCE(NULLIF(EXCLUDED.union_id,''),wechat_official_followers.union_id),
      erp_username=COALESCE(NULLIF(EXCLUDED.erp_username,''),wechat_official_followers.erp_username),subscribed=TRUE,
      subscribe_scene=EXCLUDED.subscribe_scene,profile_data=EXCLUDED.profile_data,
      subscribed_at=COALESCE(wechat_official_followers.subscribed_at,EXCLUDED.subscribed_at),unsubscribed_at=NULL,updated_at=NOW()`,
    [openId,unionId,ownerUsername,String(profile.subscribe_scene || ''),JSON.stringify(profile),Number(profile.subscribe_time || 0)]);
    return true;
  }

  async function syncFollowers() {
    if (!appSecret) return { skipped:true,reason:'app_secret_not_configured',followers:0 };
    if (syncingFollowers) return { skipped:true,reason:'already_running',followers:0 };
    syncingFollowers=true;
    try {
      const openIds=[];
      let nextOpenId='';
      do {
        const suffix=nextOpenId ? `?next_openid=${encodeURIComponent(nextOpenId)}` : '';
        const page=await weChatApi('GET',`https://api.weixin.qq.com/cgi-bin/user/get${suffix}`,undefined,true);
        const ids=Array.isArray(page?.data?.openid) ? page.data.openid.map(String) : [];
        openIds.push(...ids);
        nextOpenId=String(page.next_openid || '');
        if (!ids.length) break;
      } while (nextOpenId && openIds.length<100000);
      let imported=0;
      for (let index=0;index<openIds.length;index+=100) {
        const batch=openIds.slice(index,index+100).map(openid=>({ openid,lang:'zh_CN' }));
        const response=await weChatApi('POST','https://api.weixin.qq.com/cgi-bin/user/info/batchget',{ user_list:batch },true);
        for (const profile of response.user_info_list || []) if (await upsertFollowerProfile(profile)) imported+=1;
      }
      return { skipped:false,followers:openIds.length,imported };
    } finally { syncingFollowers=false; }
  }

  function verifyPlainSignature(query) {
    return callbackToken && safeEqualText(sha1Signature([callbackToken,query.timestamp,query.nonce]),query.signature);
  }

  async function callbackPost(req,res) {
    if (!callbackToken) return res.status(503).send('callback token is not configured');
    try {
      let xml=String(req.body || '');
      if (String(req.query.encrypt_type || '').toLowerCase()==='aes') {
        const envelope=parseWeChatXml(xml),encrypted=envelope.Encrypt;
        const expected=sha1Signature([callbackToken,req.query.timestamp,req.query.nonce,encrypted]);
        if (!safeEqualText(expected,req.query.msg_signature)) return res.status(403).send('invalid signature');
        xml=decryptWeChatMessage(encrypted,encodingAesKey,appId);
      } else if (!verifyPlainSignature(req.query || {})) return res.status(403).send('invalid signature');
      const payload=parseWeChatXml(xml);
      await persistCallbackAudit(payload);
      res.status(200).send('success');
      handleCallbackEvent(payload).catch(error=>logger.error('[WeChatOfficial] callback processing failed:',error.message));
    } catch (error) {
      logger.error('[WeChatOfficial] callback rejected:',error.message);
      res.status(400).send('invalid message');
    }
  }

  async function scanDeadlineAlerts() {
    await pool.query(`INSERT INTO order_alerts(owner_username,order_id,alert_type,title,content,event_key)
      SELECT o.owner_username,o.ml_order_id,'deadline','订单即将延误',
        CASE WHEN o.deadline_is_estimated THEN '预计' ELSE '官方' END||'待发货截止时间：'||o.handling_deadline::text,
        'deadline:'||o.ml_order_id||':'||o.handling_deadline::text
      FROM ml_orders o WHERE o.owner_username IS NOT NULL AND o.hidden_at IS NULL AND o.handling_deadline>NOW()
        AND o.handling_deadline<=NOW()+INTERVAL '24 hours' AND COALESCE(o.refund_amount,0)<=0
        AND LOWER(COALESCE(o.status,'')) NOT IN ('cancelled','refunded')
        AND LOWER(COALESCE(o.shipment_status,'')) NOT IN ('shipped','delivered','cancelled','refunded')
      ON CONFLICT(event_key) DO NOTHING`);
  }

  function formatBeijingTime(value) {
    const date=new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    const parts=new Intl.DateTimeFormat('zh-CN',{ timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false }).formatToParts(date);
    const read=type=>parts.find(part=>part.type===type)?.value || '';
    return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}:${read('second')}`;
  }

  function summarizeItems(items) {
    const list=Array.isArray(items) ? items : [];
    const first=list[0] || {},item=first.item || first;
    const title=String(item.title || first.title || '订单商品').trim();
    const quantity=list.reduce((sum,entry)=>sum+Math.max(0,Number(entry.quantity || entry.item?.quantity || 0)),0);
    return { productName:title || '订单商品',quantity:String(quantity || 1) };
  }

  function alertPayload(row) {
    const itemSummary=summarizeItems(row.items);
    const eventSource=['new_order','cancelled'].includes(row.alert_type) ? row.date_created : row.created_at;
    const eventTime=formatBeijingTime(eventSource);
    const currency=String(row.currency || '');
    const money=Number(row.alert_type==='refund' ? row.refund_amount || 0 : row.paid_amount || 0);
    return {
      title:String(row.title || ''),content:String(row.content || ''),eventType:String(row.alert_type || ''),
      orderId:String(row.order_id || ''),orderNumber:String(row.display_order_id || row.order_id || ''),
      storeName:String(row.store_name || '授权店铺'),country:String(row.country || ''),currency,
      amount:`${currency} ${money.toFixed(2)}`.trim(),productName:itemSummary.productName,quantity:itemSummary.quantity,
      status:String(row.status || row.shipment_status || ''),deadline:String(row.handling_deadline || ''),eventTime,
      notificationStatus:row.alert_type==='buyer_inquiry' ? '待回复' : String(row.status || row.shipment_status || ''),
      remark:'请进入山月助手小程序查看详情'
    };
  }

  async function enqueueNewAlerts() {
    if (scanning || stopped) return;
    scanning=true;
    try {
      await scanDeadlineAlerts();
      const cursorResult=await pool.query("SELECT value FROM settings WHERE key='wechat_official_alert_cursor'");
      const cursor=Number(cursorResult.rows[0]?.value || 0);
      const { rows }=await pool.query(`SELECT a.*,COALESCE(NULLIF(o.pack_id,''),o.ml_order_id,a.order_id) AS display_order_id,
        o.country,o.currency,o.paid_amount,o.refund_amount,o.status,o.shipment_status,o.handling_deadline,
        o.date_created,o.date_closed,o.items,
        COALESCE(NULLIF(s.remark,''),NULLIF(s.nickname,''),o.store_user_id,'授权店铺') AS store_name
        FROM order_alerts a LEFT JOIN ml_orders o ON o.owner_username=a.owner_username AND o.ml_order_id=a.order_id
        LEFT JOIN ml_stores s ON s.ml_user_id=o.store_user_id
        WHERE a.id>$1 AND a.alert_type=ANY($2::varchar[]) ORDER BY a.id LIMIT 200`,[cursor,EVENT_TYPES]);
      let nextCursor=cursor;
      for (const alert of rows) {
        nextCursor=Math.max(nextCursor,Number(alert.id));
        if (!alert.owner_username) continue;
        const column=preferenceColumn(alert.alert_type);
        const followers=await pool.query(`SELECT f.open_id FROM wechat_official_followers f
          LEFT JOIN wechat_official_notification_preferences p ON LOWER(p.owner_username)=LOWER(f.erp_username)
          WHERE f.subscribed=TRUE AND LOWER(f.erp_username)=LOWER($1)
            AND COALESCE(p.enabled,TRUE)=TRUE AND COALESCE(p.${column},TRUE)=TRUE`,[alert.owner_username]);
        const payload=alertPayload(alert);
        for (const follower of followers.rows) await pool.query(`INSERT INTO wechat_official_notification_outbox
          (event_key,owner_username,open_id,event_type,order_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)
          ON CONFLICT(event_key) DO NOTHING`,[
          `alert:${alert.id}:${follower.open_id}`,alert.owner_username,follower.open_id,alert.alert_type,alert.order_id,JSON.stringify(payload)
        ]);
      }
      if (nextCursor>cursor) await pool.query(`UPDATE settings SET value=$1,updated_at=NOW() WHERE key='wechat_official_alert_cursor'`,[String(nextCursor)]);
      triggerWorker();
    } finally { scanning=false; }
  }

  async function enqueueNotification(input={}) {
    const eventType=String(input.eventType || '');
    const ownerUsername=String(input.ownerUsername || '').trim();
    if (!EVENT_TYPES.includes(eventType)) throw new Error('Unsupported notification event type');
    if (!ownerUsername) throw new Error('ownerUsername is required');
    const column=preferenceColumn(eventType);
    const followers=await pool.query(`SELECT f.open_id FROM wechat_official_followers f
      LEFT JOIN wechat_official_notification_preferences p ON LOWER(p.owner_username)=LOWER(f.erp_username)
      WHERE f.subscribed=TRUE AND LOWER(f.erp_username)=LOWER($1)
        AND COALESCE(p.enabled,TRUE)=TRUE AND COALESCE(p.${column},TRUE)=TRUE`,[ownerUsername]);
    const payload={ eventTime:formatBeijingTime(Date.now()),...(input.payload || {}) };
    let queued=0;
    for (const follower of followers.rows) {
      const eventKey=`direct:${String(input.eventKey || `${eventType}:${Date.now()}`).slice(0,140)}:${follower.open_id}`;
      const result=await pool.query(`INSERT INTO wechat_official_notification_outbox
        (event_key,owner_username,open_id,event_type,order_id,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT(event_key) DO NOTHING RETURNING id`,[
        eventKey,ownerUsername,follower.open_id,eventType,input.orderId ? String(input.orderId) : null,JSON.stringify(payload)
      ]);
      queued+=result.rows.length;
    }
    triggerWorker();
    return { queued,followers:followers.rows.length };
  }

  async function claimNext() {
    const { rows }=await pool.query(`WITH candidate AS (
      SELECT id FROM wechat_official_notification_outbox WHERE status IN ('pending','retry','waiting_config') AND available_at<=NOW()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE wechat_official_notification_outbox o SET status='processing',updated_at=NOW()
      FROM candidate WHERE o.id=candidate.id RETURNING o.*`);
    return rows[0] || null;
  }

  async function sendOutbox(event) {
    const follower=await pool.query(`SELECT subscribed,erp_username FROM wechat_official_followers WHERE open_id=$1`,[event.open_id]);
    if (!follower.rows[0]?.subscribed || String(follower.rows[0]?.erp_username || '').toLowerCase()!==String(event.owner_username).toLowerCase()) {
      await pool.query(`UPDATE wechat_official_notification_outbox SET status='skipped',last_error='follower_unavailable',updated_at=NOW() WHERE id=$1`,[event.id]);
      return;
    }
    if (!appSecret) {
      await pool.query(`UPDATE wechat_official_notification_outbox SET status='waiting_config',last_error='app_secret_not_configured',
        available_at=NOW()+INTERVAL '10 minutes',updated_at=NOW() WHERE id=$1`,[event.id]);
      return;
    }
    const configResult=await pool.query(`SELECT * FROM wechat_official_template_configs WHERE event_type=$1 AND enabled=TRUE`,[event.event_type]);
    const config=configResult.rows[0];
    if (!config?.template_id || !Object.keys(config.data_mapping || {}).length) {
      await pool.query(`UPDATE wechat_official_notification_outbox SET status='waiting_config',last_error='template_not_configured',
        available_at=NOW()+INTERVAL '10 minutes',updated_at=NOW() WHERE id=$1`,[event.id]);
      return;
    }
    const payload=event.payload || {};
    const pagepath=renderValue(config.page_path || '',payload);
    const body={ touser:event.open_id,template_id:config.template_id,data:renderTemplateData(config.data_mapping,payload) };
    if (pagepath) body.miniprogram={ appid:miniProgramAppId,pagepath };
    const result=await weChatApi('POST','https://api.weixin.qq.com/cgi-bin/message/template/send',body,true);
    await pool.query(`UPDATE wechat_official_notification_outbox SET status='sent',wechat_msg_id=$2,response_data=$3::jsonb,
      last_error=NULL,sent_at=NOW(),updated_at=NOW() WHERE id=$1`,[event.id,String(result.msgid || ''),JSON.stringify(result)]);
  }

  async function markFailed(event,error) {
    const retryCount=Number(event.retry_count || 0)+1,final=retryCount>=8;
    await pool.query(`UPDATE wechat_official_notification_outbox SET status=$2,retry_count=$3,last_error=$4,
      available_at=CASE WHEN $2='failed' THEN available_at ELSE NOW()+($5::int*INTERVAL '1 second') END,updated_at=NOW() WHERE id=$1`,
    [event.id,final?'failed':'retry',retryCount,String(error?.wechat?.errmsg || error?.message || error).slice(0,2000),retryDelaySeconds(retryCount)]);
  }

  async function runWorker() {
    if (working || stopped) return;
    working=true;
    try {
      for (let i=0;i<20;i++) {
        const event=await claimNext();
        if (!event) break;
        try { await sendOutbox(event); } catch (error) { await markFailed(event,error); }
      }
    } finally { working=false; }
  }

  function triggerWorker() { if (!stopped) setImmediate(()=>runWorker().catch(error=>logger.error('[WeChatOfficial] worker failed:',error.message))); }

  async function getPreferences(ownerUsername) {
    const { rows }=await pool.query(`SELECT * FROM wechat_official_notification_preferences WHERE LOWER(owner_username)=LOWER($1)`,[ownerUsername]);
    const row=rows[0] || {};
    return {
      enabled:row.enabled ?? true,newOrder:row.new_order_enabled ?? true,cancelled:row.cancelled_enabled ?? true,
      deadline:row.deadline_enabled ?? true,refund:row.refund_enabled ?? true,shipped:row.shipped_enabled ?? true,
      buyerInquiry:row.buyer_inquiry_enabled ?? true,afterSales:row.after_sales_enabled ?? true,
      bindingSuccess:row.binding_success_enabled ?? true
    };
  }

  async function updatePreferences(ownerUsername,input={}) {
    const current=await getPreferences(ownerUsername);
    const next={ ...current,...Object.fromEntries(Object.entries(input).filter(([key,value])=>Object.hasOwn(current,key) && typeof value==='boolean')) };
    await pool.query(`INSERT INTO wechat_official_notification_preferences
      (owner_username,enabled,new_order_enabled,cancelled_enabled,deadline_enabled,refund_enabled,shipped_enabled,
       buyer_inquiry_enabled,after_sales_enabled,binding_success_enabled,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) ON CONFLICT(owner_username) DO UPDATE SET
      enabled=EXCLUDED.enabled,new_order_enabled=EXCLUDED.new_order_enabled,cancelled_enabled=EXCLUDED.cancelled_enabled,
      deadline_enabled=EXCLUDED.deadline_enabled,refund_enabled=EXCLUDED.refund_enabled,shipped_enabled=EXCLUDED.shipped_enabled,
      buyer_inquiry_enabled=EXCLUDED.buyer_inquiry_enabled,after_sales_enabled=EXCLUDED.after_sales_enabled,
      binding_success_enabled=EXCLUDED.binding_success_enabled,updated_at=NOW()`,
    [ownerUsername,next.enabled,next.newOrder,next.cancelled,next.deadline,next.refund,next.shipped,next.buyerInquiry,next.afterSales,next.bindingSuccess]);
    return next;
  }

  async function getBindingStatus(ownerUsername) {
    const { rows }=await pool.query(`SELECT COUNT(*)::int AS followers,
      COUNT(*) FILTER(WHERE subscribed=TRUE)::int AS subscribed,
      COUNT(*) FILTER(WHERE subscribed=TRUE AND erp_username IS NOT NULL)::int AS bound
      FROM wechat_official_followers WHERE LOWER(erp_username)=LOWER($1)`,[ownerUsername]);
    return rows[0] || { followers:0,subscribed:0,bound:0 };
  }

  async function listTemplateConfigs() {
    const { rows }=await pool.query(`SELECT event_type AS "eventType",template_id AS "templateId",data_mapping AS "dataMapping",
      page_path AS "pagePath",enabled,updated_at AS "updatedAt" FROM wechat_official_template_configs ORDER BY event_type`);
    return rows;
  }

  async function saveTemplateConfig(eventType,input={}) {
    if (!EVENT_TYPES.includes(eventType)) throw Object.assign(new Error('Unsupported notification event type'),{ status:400 });
    const templateId=String(input.templateId || '').trim().slice(0,160);
    const dataMapping=input.dataMapping && typeof input.dataMapping==='object' && !Array.isArray(input.dataMapping) ? input.dataMapping : {};
    const pagePath=String(input.pagePath || '').trim().slice(0,500);
    await pool.query(`UPDATE wechat_official_template_configs SET template_id=$2,data_mapping=$3::jsonb,page_path=$4,
      enabled=$5,updated_at=NOW() WHERE event_type=$1`,[eventType,templateId,JSON.stringify(dataMapping),pagePath,input.enabled!==false]);
    triggerWorker();
    return (await listTemplateConfigs()).find(item=>item.eventType===eventType);
  }

  async function listAvailableTemplates() {
    return weChatApi('GET','https://api.weixin.qq.com/cgi-bin/template/get_all_private_template',undefined,true);
  }

  async function syncTemplateConfigsFromOfficial() {
    if (!appSecret) return { skipped:true,reason:'app_secret_not_configured',configured:0,missing:EVENT_TYPES };
    try {
      const remote=await listAvailableTemplates();
      const templates=Array.isArray(remote?.template_list) ? remote.template_list : [];
      const configured=[],missing=[];
      for (const eventType of EVENT_TYPES) {
        const preset=OFFICIAL_TEMPLATE_PRESETS[eventType];
        const template=templates.find(item=>String(item.title || '').trim()===preset.title);
        if (!template?.template_id) { missing.push(eventType); continue; }
        await pool.query(`UPDATE wechat_official_template_configs SET template_id=$2,data_mapping=$3::jsonb,
          page_path=$4,enabled=TRUE,updated_at=NOW() WHERE event_type=$1`,[
          eventType,String(template.template_id),JSON.stringify(preset.dataMapping),preset.pagePath
        ]);
        configured.push(eventType);
      }
      await pool.query(`UPDATE wechat_official_notification_outbox SET status='skipped',
        last_error='template_activated_after_event',updated_at=NOW()
        WHERE status='waiting_config' AND created_at<NOW()-INTERVAL '10 minutes'`);
      templateSyncStatus={ synced:true,configured:configured.length,missing:missing.length,lastAt:new Date().toISOString(),error:'' };
      triggerWorker();
      return { skipped:false,configured,missing };
    } catch (error) {
      templateSyncStatus={ ...templateSyncStatus,synced:false,lastAt:new Date().toISOString(),error:String(error.message || error).slice(0,300) };
      throw error;
    }
  }

  async function getStatus() {
    const [followers,outbox,templates]=await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE subscribed=TRUE)::int AS subscribed,
        COUNT(*) FILTER(WHERE subscribed=TRUE AND erp_username IS NOT NULL)::int AS bound FROM wechat_official_followers`),
      pool.query(`SELECT status,COUNT(*)::int AS count FROM wechat_official_notification_outbox GROUP BY status`),
      listTemplateConfigs()
    ]);
    return { appId,miniProgramAppId,callbackPath,configured:{ secret:Boolean(appSecret),token:Boolean(callbackToken),aesKey:Boolean(encodingAesKey) },
      workerRunning:Boolean(workerTimer)&&!stopped,processing:working,syncingFollowers,templateSync:templateSyncStatus,
      followers:followers.rows[0],outbox:Object.fromEntries(outbox.rows.map(row=>[row.status,row.count])),templates };
  }

  function registerRoutes(app) {
    app.get(callbackPath,(req,res)=>{
      if (!verifyPlainSignature(req.query || {})) return res.status(403).send('invalid signature');
      res.status(200).send(String(req.query.echostr || ''));
    });
    app.post(callbackPath,require('express').text({ type:['text/xml','application/xml','*/xml'],limit:'1mb' }),callbackPost);
    app.get('/api/health/wechat-official-account',(req,res)=>{
      res.json({ code:0,data:{ appId,callbackPath,eventTypes:EVENT_TYPES,
        configured:{ secret:Boolean(appSecret),token:Boolean(callbackToken),aesKey:Boolean(encodingAesKey) },
        workerRunning:Boolean(workerTimer)&&!stopped,processing:working,templateSync:templateSyncStatus } });
    });
    app.get('/api/admin/wechat-official/status',requireAdmin,async (req,res)=>{
      try { res.json({ code:0,data:await getStatus() }); } catch (error) { res.status(500).json({ code:500,message:error.message }); }
    });
    app.get('/api/admin/wechat-official/templates',requireAdmin,async (req,res)=>{
      try { res.json({ code:0,data:await listTemplateConfigs() }); } catch (error) { res.status(500).json({ code:500,message:error.message }); }
    });
    app.get('/api/admin/wechat-official/available-templates',requireAdmin,async (req,res)=>{
      try { res.json({ code:0,data:await listAvailableTemplates() }); }
      catch (error) { res.status(502).json({ code:502,message:error.message }); }
    });
    app.post('/api/admin/wechat-official/templates/sync',requireAdmin,async (req,res)=>{
      try { res.json({ code:0,data:await syncTemplateConfigsFromOfficial() }); }
      catch (error) { res.status(502).json({ code:502,message:error.message }); }
    });
    app.post('/api/admin/wechat-official/sync-followers',requireAdmin,async (req,res)=>{
      try { res.json({ code:0,data:await syncFollowers() }); }
      catch (error) { res.status(502).json({ code:502,message:error.message }); }
    });
    app.put('/api/admin/wechat-official/templates/:eventType',requireAdmin,async (req,res)=>{
      try { res.json({ code:0,data:await saveTemplateConfig(String(req.params.eventType),req.body || {}) }); }
      catch (error) { const status=error.status || 500; res.status(status).json({ code:status,message:error.message }); }
    });
  }

  function start() {
    stopped=false;
    if (!scanTimer) { scanTimer=setInterval(()=>enqueueNewAlerts().catch(error=>logger.error('[WeChatOfficial] alert scan failed:',error.message)),5000); scanTimer.unref?.(); }
    if (!workerTimer) { workerTimer=setInterval(triggerWorker,5000); workerTimer.unref?.(); }
    if (!followerSyncTimer) { followerSyncTimer=setInterval(()=>syncFollowers().catch(error=>logger.error('[WeChatOfficial] follower sync failed:',error.message)),6*60*60*1000); followerSyncTimer.unref?.(); }
    if (!templateSyncTimer) { templateSyncTimer=setInterval(()=>syncTemplateConfigsFromOfficial().catch(error=>logger.error('[WeChatOfficial] template sync retry failed:',error.message)),5*60*1000); templateSyncTimer.unref?.(); }
    enqueueNewAlerts().catch(error=>logger.error('[WeChatOfficial] initial scan failed:',error.message));
    syncFollowers().catch(error=>logger.error('[WeChatOfficial] initial follower sync failed:',error.message));
    syncTemplateConfigsFromOfficial().catch(error=>logger.error('[WeChatOfficial] template sync failed:',error.message));
    triggerWorker();
  }

  function stop() {
    stopped=true;
    if (scanTimer) clearInterval(scanTimer);
    if (workerTimer) clearInterval(workerTimer);
    if (followerSyncTimer) clearInterval(followerSyncTimer);
    if (templateSyncTimer) clearInterval(templateSyncTimer);
    scanTimer=null;workerTimer=null;followerSyncTimer=null;templateSyncTimer=null;
  }

  return { init,registerRoutes,start,stop,getPreferences,updatePreferences,getBindingStatus,getStatus,listTemplateConfigs,
    saveTemplateConfig,syncFollowers,syncTemplateConfigsFromOfficial,enqueueNotification };
}

module.exports={ DEFAULT_OFFICIAL_APP_ID,EVENT_TYPES,OFFICIAL_TEMPLATE_PRESETS,sha1Signature,parseWeChatXml,decryptWeChatMessage,
  preferenceColumn,retryDelaySeconds,renderTemplateData,createOfficialAccountService };
