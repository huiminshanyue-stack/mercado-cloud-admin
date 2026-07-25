'use strict';

const assert = require('node:assert/strict');
const { DEFAULT_APP_ID,tokenHash,canTestOrders,registerMiniProgramRoutes } = require('../wechat-miniprogram');

assert.equal(DEFAULT_APP_ID,'wx0f97428df87ee76e');
assert.equal(tokenHash('山月助手').length,64);
assert.equal(tokenHash('same-token'),tokenHash('same-token'));
assert.notEqual(tokenHash('token-a'),tokenHash('token-b'));
assert.equal(canTestOrders({ role:'admin',username:'ADMIN' }),true);
assert.equal(canTestOrders({ role:'user',username:'cntoro' }),true);
assert.equal(canTestOrders({ role:'user',username:'other' }),false);

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode=code; return this; },
    json(body) { this.body=body; return this; }
  };
}

async function runHandlers(handlers,req,res) {
  let index=0;
  return new Promise((resolve,reject) => {
    const next = error => {
      if (error) return reject(error);
      const handler=handlers[index++];
      if (!handler) return resolve();
      Promise.resolve(handler(req,res,next)).then(() => {
        if (res.body !== null) resolve();
      }).catch(reject);
    };
    next();
  });
}

async function testRoutes() {
  const routes=new Map(),listCalls=[],costCalls=[],inquirySendCalls=[],claimSendCalls=[];
  const app={
    get(path,...handlers) { routes.set(`GET ${path}`,handlers); },
    post(path,...handlers) { routes.set(`POST ${path}`,handlers); },
    patch(path,...handlers) { routes.set(`PATCH ${path}`,handlers); }
  };
  const pool={
    async query(sql,params=[]) {
      if (sql.includes('FROM wechat_miniprogram_sessions')) return { rows:[] };
      if (sql.includes('FROM user_sessions')) {
        if (params[0]==='cntoro-token') return { rows:[{ username:'CNTORO',role:'user',validuntil:null }] };
        if (params[0]==='other-token') return { rows:[{ username:'OTHER',role:'user',validuntil:null }] };
        return { rows:[] };
      }
      if (sql.includes('COUNT(DISTINCT') && sql.includes('FROM ml_orders')) {
        assert.equal(params[0],'CNTORO');
        return { rows:[{ count:7 }] };
      }
      if (sql.includes('FROM order_alerts') && sql.includes("alert_type IN ('buyer_inquiry','after_sales')")) {
        assert.equal(params[0],'CNTORO');
        return { rows:[{ alert_type:'buyer_inquiry',count:2 },{ alert_type:'after_sales',count:1 }] };
      }
      return { rows:[] };
    }
  };
  registerMiniProgramRoutes(app,{
    pool,
    isUserExpired:()=>false,
    loginRateLimit:(req,res,next)=>next(),
    getOrderStoresData:async user=>[{ id:'store-1',owner:user.username }],
    getOrderListData:async (user,query) => {
      listCalls.push({ user,query });
      return { items:[{ orderId:'order-1' }],total:1,page:1,size:20 };
    },
    updateOrderCostData:async (user,orderId,body) => {
      costCalls.push({ user,orderId,body });
      return { orderId,cost:body.cost,note:body.note || '' };
    },
    getOrderInquiriesData:async()=>({ count:0,items:[],orders:[] }),
    getOrderAfterSalesData:async()=>({ count:0,items:[],orders:[] }),
    getOrderMessagesData:async()=>({ messages:[] }),
    sendOrderMessageData:async (user,orderId,body)=>{
      inquirySendCalls.push({ user,orderId,body });
      return { id:'message-1' };
    },
    getOrderClaimMessagesData:async()=>({ messages:[] }),
    sendOrderClaimMessageData:async (user,claimId,body)=>{
      claimSendCalls.push({ user,claimId,body });
      return { id:'claim-message-1' };
    },
    translateOrderTextData:async body=>({ text:body.text }),
    getOrderRealtimeStateData:async user=>({ version:3,lastTopic:'orders_v2',lastOrderId:'order-1',owner:user.username })
  });

  const configRes=responseRecorder();
  await runHandlers(routes.get('GET /api/miniprogram/v1/config'),{ headers:{} },configRes);
  assert.equal(configRes.statusCode,200);
  assert.equal(configRes.body.data.appId,DEFAULT_APP_ID);
  assert.equal(configRes.body.data.writeOperationsEnabled,true);
  assert.deepEqual(configRes.body.data.allowedWrites,['order_cost','inquiry_reply','after_sales_reply']);

  const anonymousRes=responseRecorder();
  await runHandlers(routes.get('GET /api/miniprogram/v1/orders'),{ headers:{},query:{} },anonymousRes);
  assert.equal(anonymousRes.statusCode,401);
  assert.equal(listCalls.length,0);

  const forbiddenRes=responseRecorder();
  await runHandlers(routes.get('GET /api/miniprogram/v1/orders'),{ headers:{ authorization:'Bearer other-token' },query:{} },forbiddenRes);
  assert.equal(forbiddenRes.statusCode,401);
  assert.equal(listCalls.length,0);

  const allowedRes=responseRecorder();
  await runHandlers(routes.get('GET /api/miniprogram/v1/orders'),{
    headers:{ authorization:'Bearer cntoro-token' },query:{ page:'2',storeId:'store-1' }
  },allowedRes);
  assert.equal(allowedRes.statusCode,200);
  assert.equal(allowedRes.body.code,0);
  assert.equal(listCalls.length,1);
  assert.equal(listCalls[0].user.username,'CNTORO');
  assert.deepEqual(listCalls[0].query,{ page:'2',storeId:'store-1' });

  const costRes=responseRecorder();
  await runHandlers(routes.get('PATCH /api/miniprogram/v1/orders/:orderId/cost'),{
    headers:{ authorization:'Bearer cntoro-token' },params:{ orderId:'order-1' },body:{ cost:-12.5,note:'赔付调整' }
  },costRes);
  assert.equal(costRes.statusCode,200);
  assert.equal(costCalls.length,1);
  assert.equal(costCalls[0].user.username,'CNTORO');
  assert.equal(costCalls[0].orderId,'order-1');
  assert.deepEqual(costCalls[0].body,{ cost:-12.5,note:'赔付调整' });

  const homeRes=responseRecorder();
  await runHandlers(routes.get('GET /api/miniprogram/v1/home-summary'),{
    headers:{ authorization:'Bearer cntoro-token' }
  },homeRes);
  assert.deepEqual(homeRes.body.data,{ orderCount:7,inquiryCount:2,afterSalesCount:1 });

  const realtimeRes=responseRecorder();
  await runHandlers(routes.get('GET /api/miniprogram/v1/realtime-state'),{
    headers:{ authorization:'Bearer cntoro-token' }
  },realtimeRes);
  assert.deepEqual(realtimeRes.body.data,{ version:3,lastTopic:'orders_v2',lastOrderId:'order-1',owner:'CNTORO' });

  const inquirySendRes=responseRecorder();
  await runHandlers(routes.get('POST /api/miniprogram/v1/inquiries/:orderId/messages'),{
    headers:{ authorization:'Bearer cntoro-token' },params:{ orderId:'order-1' },body:{ text:'Hello' }
  },inquirySendRes);
  assert.equal(inquirySendRes.statusCode,200);
  assert.equal(inquirySendCalls[0].user.username,'CNTORO');
  assert.deepEqual(inquirySendCalls[0],{ user:inquirySendCalls[0].user,orderId:'order-1',body:{ text:'Hello' } });

  const claimSendRes=responseRecorder();
  await runHandlers(routes.get('POST /api/miniprogram/v1/after-sales/:claimId/messages'),{
    headers:{ authorization:'Bearer cntoro-token' },params:{ claimId:'claim-1' },body:{ text:'Resolved',storeId:'store-1' }
  },claimSendRes);
  assert.equal(claimSendRes.statusCode,200);
  assert.equal(claimSendCalls[0].user.username,'CNTORO');
  assert.equal(claimSendCalls[0].claimId,'claim-1');
  assert.deepEqual(claimSendCalls[0].body,{ text:'Resolved',storeId:'store-1' });
}

testRoutes().then(() => console.log('wechat miniprogram security and route tests passed'));
