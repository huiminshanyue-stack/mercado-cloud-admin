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
  const routes=new Map(),listCalls=[];
  const app={
    get(path,...handlers) { routes.set(`GET ${path}`,handlers); },
    post(path,...handlers) { routes.set(`POST ${path}`,handlers); }
  };
  const pool={
    async query(sql,params=[]) {
      if (sql.includes('FROM wechat_miniprogram_sessions')) return { rows:[] };
      if (sql.includes('FROM user_sessions')) {
        if (params[0]==='cntoro-token') return { rows:[{ username:'CNTORO',role:'user',validuntil:null }] };
        if (params[0]==='other-token') return { rows:[{ username:'OTHER',role:'user',validuntil:null }] };
        return { rows:[] };
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
    }
  });

  const configRes=responseRecorder();
  await runHandlers(routes.get('GET /api/miniprogram/v1/config'),{ headers:{} },configRes);
  assert.equal(configRes.statusCode,200);
  assert.equal(configRes.body.data.appId,DEFAULT_APP_ID);
  assert.equal(configRes.body.data.writeOperationsEnabled,false);

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
}

testRoutes().then(() => console.log('wechat miniprogram security and route tests passed'));
