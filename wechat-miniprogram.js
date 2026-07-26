'use strict';

const axios = require('axios');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DEFAULT_APP_ID = 'wx0f97428df87ee76e';
const MINI_SESSION_DAYS = 30;
const ORDER_TEST_USERNAMES = new Set(['CNTORO']);

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function describeWechatLoginError(data = {}) {
  const errcode = Number(data.errcode || 0);
  const errmsg = String(data.errmsg || '').trim();
  if (errcode === 40164 || /invalid\s+ip/i.test(errmsg)) {
    return '微信登录失败：Railway 当前出口 IP 不在小程序 API 白名单。测试环境请关闭小程序 AppSecret 下方的 API IP 白名单保护；正式环境请先配置固定出口 IP。';
  }
  if (errcode === 40029 || /invalid\s+code/i.test(errmsg)) return '微信登录凭证已失效，请重新点击微信登录';
  if (errcode === 45011) return '微信登录请求过于频繁，请稍后再试';
  return errmsg || '微信身份验证失败';
}

function canTestOrders(user) {
  return user?.role === 'admin' || ORDER_TEST_USERNAMES.has(String(user?.username || '').toUpperCase());
}

async function initMiniProgramTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS wechat_miniprogram_identities (
    id BIGSERIAL PRIMARY KEY,
    app_id VARCHAR(80) NOT NULL,
    open_id VARCHAR(160) NOT NULL,
    union_id VARCHAR(160),
    erp_username VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(app_id,open_id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_identity_erp ON wechat_miniprogram_identities(erp_username)');
  await pool.query(`CREATE TABLE IF NOT EXISTS wechat_miniprogram_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    identity_id BIGINT NOT NULL REFERENCES wechat_miniprogram_identities(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_wechat_session_identity ON wechat_miniprogram_sessions(identity_id,expires_at DESC)');
  await pool.query('DELETE FROM wechat_miniprogram_sessions WHERE expires_at<NOW()');
}

function registerMiniProgramRoutes(app, dependencies) {
  const {
    pool,
    isUserExpired,
    loginRateLimit,
    getOrderListData,
    getOrderStoresData,
    refreshOrderDimensionsData,
    updateOrderCostData,
    getOrderInquiriesData,
    getOrderAfterSalesData,
    getOrderMessagesData,
    sendOrderMessageData,
    getOrderClaimMessagesData,
    sendOrderClaimMessageData,
    translateOrderTextData,
    translateOrderMessageData,
    getOrderRealtimeStateData,
    getOfficialNotificationPreferences,
    updateOfficialNotificationPreferences,
    getOfficialAccountBindingStatus,
    enqueueOfficialNotification,
    syncOfficialFollowers,
    exchangeMiniProgramCode
  } = dependencies;
  const appId = process.env.WECHAT_MINIPROGRAM_APPID || DEFAULT_APP_ID;
  const appSecret = process.env.WECHAT_MINIPROGRAM_SECRET || '';

  async function exchangeCode(code) {
    if (typeof exchangeMiniProgramCode === 'function') return exchangeMiniProgramCode({ appId,appSecret,code });
    const response = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: { appid: appId,secret: appSecret,js_code: code,grant_type: 'authorization_code' },
      timeout: 15000
    });
    return response.data || {};
  }

  async function loadMiniAuth(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    const { rows } = await pool.query(`SELECT s.identity_id,i.erp_username,u.nickname,u.role,u.validuntil
      FROM wechat_miniprogram_sessions s
      JOIN wechat_miniprogram_identities i ON i.id=s.identity_id
      LEFT JOIN users u ON u.username=i.erp_username
      WHERE s.token_hash=$1 AND s.expires_at>NOW()`,[tokenHash(token)]);
    if (rows[0]) {
      await pool.query('UPDATE wechat_miniprogram_sessions SET last_seen_at=NOW() WHERE token_hash=$1',[tokenHash(token)]);
      const row = rows[0];
      return {
        source: 'wechat',
        identityId: row.identity_id,
        bound: Boolean(row.erp_username),
        user: row.erp_username ? {
          username: row.erp_username,
          nickname: row.nickname || row.erp_username,
          role: row.role || 'user',
          validUntil: row.validuntil || null
        } : null
      };
    }

    // During certification, admin/CNTORO may use the existing ERP token to test
    // the mini-program against real isolated data. This never bypasses a password.
    const legacy = await pool.query(`SELECT username,role,validuntil FROM user_sessions
      WHERE token=$1 AND created_at>=NOW()-($2*INTERVAL '1 day')`,[token,MINI_SESSION_DAYS]);
    if (!legacy.rows[0]) return null;
    const user = {
      username: legacy.rows[0].username,
      role: legacy.rows[0].role,
      validUntil: legacy.rows[0].validuntil || null
    };
    if (!canTestOrders(user) || isUserExpired(user)) return null;
    return { source: 'erp_test', identityId: null, bound: true, user };
  }

  async function requireMiniAuth(req,res,next) {
    try {
      const auth = await loadMiniAuth(req);
      if (!auth) return res.status(401).json({ code: 401, message: '小程序登录已失效，请重新登录' });
      req.miniAuth = auth;
      req.authUser = auth.user;
      next();
    } catch (error) {
      console.error('[MiniProgram] auth failed:', error.message);
      res.status(500).json({ code: 500, message: '小程序身份校验失败' });
    }
  }

  function requireBoundOrderUser(req,res,next) {
    return requireMiniAuth(req,res,() => {
      if (!req.miniAuth.bound || !req.authUser) return res.status(403).json({ code: 403, message: '请先绑定山月ERP账号' });
      if (!canTestOrders(req.authUser)) return res.status(403).json({ code: 403, message: '订单小程序目前仅向管理员及CNTORO内测账号开放' });
      if (isUserExpired(req.authUser)) return res.status(403).json({ code: 403, message: 'ERP账号已到期，请联系管理员' });
      next();
    });
  }

  app.get('/api/miniprogram/v1/config',(req,res) => {
    res.json({ code: 0, data: {
      apiVersion: 'v1',
      appId,
      wechatLoginEnabled: Boolean(appSecret),
      erpTestLoginEnabled: true,
      writeOperationsEnabled: true,
      allowedWrites: ['order_cost','inquiry_reply','after_sales_reply','dimension_refresh'],
      environment: process.env.NODE_ENV || 'production'
    } });
  });

  app.post('/api/miniprogram/v1/auth/wechat-login',loginRateLimit,async (req,res) => {
    const code = String(req.body?.code || '').trim();
    if (!code || code.length > 200) return res.status(400).json({ code: 400, message: '微信登录凭证无效' });
    if (!appSecret) return res.status(503).json({ code: 503, message: '微信登录等待认证完成，请暂时使用ERP内测登录' });
    try {
      const data = await exchangeCode(code);
      if (data.errcode || !data.openid) {
        return res.status(401).json({ code: 401, message: describeWechatLoginError(data) });
      }
      const identity = await pool.query(`INSERT INTO wechat_miniprogram_identities(app_id,open_id,union_id,updated_at)
        VALUES($1,$2,$3,NOW()) ON CONFLICT(app_id,open_id) DO UPDATE SET
        union_id=COALESCE(EXCLUDED.union_id,wechat_miniprogram_identities.union_id),updated_at=NOW()
        RETURNING id,erp_username,union_id`,[appId,String(data.openid),data.unionid ? String(data.unionid) : null]);
      if (identity.rows[0].erp_username && identity.rows[0].union_id) {
        await pool.query(`UPDATE wechat_official_followers SET erp_username=$1,updated_at=NOW()
          WHERE union_id=$2 AND subscribed=TRUE`,[identity.rows[0].erp_username,identity.rows[0].union_id]);
      }
      const rawToken = crypto.randomBytes(32).toString('hex');
      await pool.query(`INSERT INTO wechat_miniprogram_sessions(token_hash,identity_id,expires_at)
        VALUES($1,$2,NOW()+($3::int*INTERVAL '1 day'))`,[tokenHash(rawToken),identity.rows[0].id,MINI_SESSION_DAYS]);
      const username = identity.rows[0].erp_username;
      const userResult = username ? await pool.query('SELECT username,nickname,role,validuntil FROM users WHERE username=$1',[username]) : { rows: [] };
      const user = userResult.rows[0] || null;
      res.json({ code: 0, data: {
        token: rawToken,
        bound: Boolean(user),
        user: user ? { username: user.username,nickname: user.nickname,role: user.role,validUntil: user.validuntil || null } : null
      } });
    } catch (error) {
      console.error('[MiniProgram] WeChat login failed:', error.response?.data || error.message);
      res.status(502).json({ code: 502, message: '连接微信登录服务失败，请稍后重试' });
    }
  });

  app.post('/api/miniprogram/v1/auth/bind',loginRateLimit,requireMiniAuth,async (req,res) => {
    if (req.miniAuth.source !== 'wechat' || !req.miniAuth.identityId) {
      return res.status(400).json({ code: 400, message: 'ERP内测登录无需重复绑定' });
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password || username.length > 120 || password.length > 200) {
      return res.status(400).json({ code: 400, message: '请输入有效的ERP账号和密码' });
    }
    const { rows } = await pool.query('SELECT username,nickname,role,validuntil,password FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1',[username]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password,user.password)) return res.status(401).json({ code: 401, message: 'ERP账号或密码错误' });
    if (!canTestOrders(user)) return res.status(403).json({ code: 403, message: '当前仅允许管理员及CNTORO内测账号绑定' });
    if (isUserExpired(user)) return res.status(403).json({ code: 403, message: 'ERP账号已到期，请联系管理员' });
    const identity=await pool.query(`UPDATE wechat_miniprogram_identities SET erp_username=$1,updated_at=NOW()
      WHERE id=$2 RETURNING union_id`,[user.username,req.miniAuth.identityId]);
    if (identity.rows[0]?.union_id) await pool.query(`UPDATE wechat_official_followers SET erp_username=$1,updated_at=NOW()
      WHERE union_id=$2 AND subscribed=TRUE`,[user.username,identity.rows[0].union_id]);
    if (typeof enqueueOfficialNotification==='function') {
      try {
        await enqueueOfficialNotification({
          ownerUsername:user.username,eventType:'binding_success',eventKey:`binding:${req.miniAuth.identityId}:${user.username}`,
          payload:{ title:'ERP账号绑定成功',username:user.nickname || user.username,bindingAccount:user.username,
            productName:'山月ERP',remark:'微信身份已成功绑定山月ERP账号' }
        });
      } catch (error) { console.error('[MiniProgram] binding notification queue failed:',error.message); }
    }
    res.json({ code: 0, data: { bound: true,user: { username:user.username,nickname:user.nickname,role:user.role,validUntil:user.validuntil || null } } });
  });

  app.get('/api/miniprogram/v1/me',requireMiniAuth,(req,res) => {
    res.json({ code: 0, data: {
      bound: req.miniAuth.bound,
      authSource: req.miniAuth.source,
      user: req.authUser || null,
      writeOperationsEnabled: true,
      allowedWrites: ['order_cost','inquiry_reply','after_sales_reply','dimension_refresh']
    } });
  });

  app.get('/api/miniprogram/v1/notification-preferences',requireBoundOrderUser,async (req,res) => {
    try {
      const [preferences,binding]=await Promise.all([
        getOfficialNotificationPreferences(req.authUser.username),
        getOfficialAccountBindingStatus(req.authUser.username)
      ]);
      res.json({ code:0,data:{ preferences,binding } });
    } catch (error) { res.status(500).json({ code:500,message:error.message || '读取公众号提醒设置失败' }); }
  });

  // Bind the currently signed-in ERP test account to the real WeChat identity.
  // This is deliberately separate from the order data path: it never changes
  // order, billing or store ownership data.
  app.post('/api/miniprogram/v1/official-account-binding/refresh',loginRateLimit,requireBoundOrderUser,async (req,res) => {
    const code=String(req.body?.code || '').trim();
    if (!code || code.length>200) return res.status(400).json({ code:400,message:'微信登录凭证无效，请重新检测' });
    if (!appSecret) return res.status(503).json({ code:503,message:'服务器尚未配置小程序 AppSecret，暂时无法识别当前微信。请在 Railway 添加 WECHAT_MINIPROGRAM_SECRET 后重新部署。' });
    try {
      const data=await exchangeCode(code);
      if (data.errcode || !data.openid) return res.status(401).json({ code:401,message:describeWechatLoginError(data) });
      const unionId=data.unionid ? String(data.unionid) : null;
      const currentUsername=String(req.authUser.username);
      const identity=await pool.query(`INSERT INTO wechat_miniprogram_identities(app_id,open_id,union_id,erp_username,updated_at)
        VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(app_id,open_id) DO UPDATE SET
        union_id=COALESCE(EXCLUDED.union_id,wechat_miniprogram_identities.union_id),updated_at=NOW()
        RETURNING id,union_id,erp_username`,[appId,String(data.openid),unionId,currentUsername]);
      const identityRow=identity.rows[0];
      if (identityRow?.erp_username && String(identityRow.erp_username).toLowerCase()!==currentUsername.toLowerCase()) {
        return res.status(409).json({ code:409,message:`当前微信已绑定其他 ERP 账号（${identityRow.erp_username}），请先解除原绑定后再操作。` });
      }
      await pool.query(`UPDATE wechat_miniprogram_identities SET erp_username=$1,updated_at=NOW() WHERE id=$2`,
        [currentUsername,identityRow.id]);

      const resolvedUnionId=String(identityRow.union_id || unionId || '');
      if (!resolvedUnionId) {
        const binding=await getOfficialAccountBindingStatus(currentUsername);
        return res.json({ code:0,data:{ status:'unionid_unavailable',binding,
          message:'微信暂未返回 UnionID。请确认“山月助手”小程序与“山月跨境”服务号已绑定到同一微信开放平台账号，然后重新检测。' } });
      }

      let syncWarning='';
      let matched=await pool.query(`UPDATE wechat_official_followers SET erp_username=$1,updated_at=NOW()
        WHERE union_id=$2 AND subscribed=TRUE RETURNING open_id`,[currentUsername,resolvedUnionId]);
      if (!matched.rows.length && typeof syncOfficialFollowers==='function') {
        try { await syncOfficialFollowers(); }
        catch (error) {
          syncWarning='公众号关注名单同步暂时失败，请稍后重试';
          console.error('[MiniProgram] official follower sync failed:',error.response?.data || error.message);
        }
        matched=await pool.query(`UPDATE wechat_official_followers SET erp_username=$1,updated_at=NOW()
          WHERE union_id=$2 AND subscribed=TRUE RETURNING open_id`,[currentUsername,resolvedUnionId]);
      }
      const binding=await getOfficialAccountBindingStatus(currentUsername);
      if (matched.rows.length>0 || Number(binding?.bound || 0)>0) {
        if (typeof enqueueOfficialNotification==='function') {
          try {
            await enqueueOfficialNotification({ ownerUsername:currentUsername,eventType:'binding_success',
              eventKey:`official-binding:${identityRow.id}:${currentUsername}`,
              payload:{ title:'公众号绑定成功',username:req.authUser.nickname || currentUsername,
                bindingAccount:currentUsername,productName:'山月ERP',remark:'公众号已与山月ERP账号匹配' } });
          } catch (error) { console.error('[MiniProgram] official binding notification queue failed:',error.message); }
        }
        return res.json({ code:0,data:{ status:'bound',binding,message:'绑定成功，山月跨境公众号已与当前 ERP 账号匹配。' } });
      }
      const follower=await pool.query(`SELECT subscribed FROM wechat_official_followers WHERE union_id=$1 ORDER BY updated_at DESC LIMIT 1`,[resolvedUnionId]);
      const message=follower.rows[0]?.subscribed===false
        ? '已识别当前微信，但公众号关注状态为未关注。请重新关注“山月跨境”后再检测。'
        : `${syncWarning ? `${syncWarning}；` : ''}尚未查询到当前微信对“山月跨境”的关注记录。请打开公众号主页确认已关注，再返回小程序检测。`;
      res.json({ code:0,data:{ status:'not_following',binding,message } });
    } catch (error) {
      console.error('[MiniProgram] official binding refresh failed:',error.response?.data || error.message);
      res.status(502).json({ code:502,message:'连接微信身份服务失败，请稍后重新检测' });
    }
  });

  app.put('/api/miniprogram/v1/notification-preferences',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await updateOfficialNotificationPreferences(req.authUser.username,req.body || {}) }); }
    catch (error) { res.status(500).json({ code:500,message:error.message || '保存公众号提醒设置失败' }); }
  });

  app.post('/api/miniprogram/v1/auth/logout',requireMiniAuth,async (req,res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (req.miniAuth.source === 'wechat') await pool.query('DELETE FROM wechat_miniprogram_sessions WHERE token_hash=$1',[tokenHash(token)]);
    if (req.miniAuth.source === 'erp_test') await pool.query('DELETE FROM user_sessions WHERE token=$1',[token]);
    res.json({ code: 0, message: '已退出小程序登录' });
  });

  app.get('/api/miniprogram/v1/stores',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code: 0, data: await getOrderStoresData(req.authUser) }); }
    catch (error) { res.status(500).json({ code: 500, message: error.message || '读取授权店铺失败' }); }
  });

  app.get('/api/miniprogram/v1/orders',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code: 0, data: await getOrderListData(req.authUser,req.query || {}) }); }
    catch (error) { res.status(500).json({ code: 500, message: error.message || '读取订单失败' }); }
  });

  app.get('/api/miniprogram/v1/realtime-state',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await getOrderRealtimeStateData(req.authUser) }); }
    catch (error) { res.status(500).json({ code:500,message:error.message || 'Failed to read realtime order state' }); }
  });

  app.get('/api/miniprogram/v1/orders/:orderId',requireBoundOrderUser,async (req,res) => {
    try {
      const data = await getOrderListData(req.authUser,{ orderId: String(req.params.orderId),page:1,size:1 });
      if (!data.items.length) return res.status(404).json({ code: 404, message: '订单不存在或无权查看' });
      res.json({ code: 0, data: data.items[0] });
    } catch (error) { res.status(500).json({ code: 500, message: error.message || '读取订单详情失败' }); }
  });

  app.post('/api/miniprogram/v1/orders/:orderId/dimensions/refresh',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await refreshOrderDimensionsData(req.authUser,req.params.orderId) }); }
    catch (error) {
      const status=error.status || error.response?.status || 500;
      res.status(status).json({ code:status,message:error.response?.data?.message || error.message || '获取尺寸重量失败' });
    }
  });

  app.get('/api/miniprogram/v1/home-summary',requireBoundOrderUser,async (req,res) => {
    try {
      const [orders,alerts] = await Promise.all([
        pool.query(`SELECT COUNT(DISTINCT COALESCE(NULLIF(pack_id,''),ml_order_id))::int AS count FROM ml_orders WHERE owner_username=$1 AND hidden_at IS NULL`,[req.authUser.username]),
        pool.query(`SELECT alert_type,COUNT(*)::int AS count FROM order_alerts WHERE owner_username=$1 AND is_read=FALSE AND alert_type IN ('buyer_inquiry','after_sales') GROUP BY alert_type`,[req.authUser.username])
      ]);
      const counts=Object.fromEntries(alerts.rows.map(row=>[row.alert_type,Number(row.count || 0)]));
      res.json({ code:0,data:{ orderCount:Number(orders.rows[0]?.count || 0),inquiryCount:counts.buyer_inquiry || 0,afterSalesCount:counts.after_sales || 0 } });
    } catch (error) { res.status(500).json({ code:500,message:error.message || '读取主页数据失败' }); }
  });

  app.patch('/api/miniprogram/v1/orders/:orderId/cost',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await updateOrderCostData(req.authUser,req.params.orderId,req.body || {}) }); }
    catch (error) { const status=error.status || 500; res.status(status).json({ code:status,message:error.message || '保存订单成本失败' }); }
  });

  app.get('/api/miniprogram/v1/inquiries',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await getOrderInquiriesData(req.authUser,req.query || {}) }); }
    catch (error) { const status=error.status || error.response?.status || 502; res.status(status).json({ code:status,message:error.response?.data?.message || error.message || '读取售前咨询失败' }); }
  });

  app.get('/api/miniprogram/v1/inquiries/:orderId/messages',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await getOrderMessagesData(req.authUser,req.params.orderId) }); }
    catch (error) { const status=error.status || error.response?.status || 502; res.status(status).json({ code:status,message:error.response?.data?.message || error.message || '读取订单咨询失败' }); }
  });

  app.post('/api/miniprogram/v1/inquiries/:orderId/messages',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await sendOrderMessageData(req.authUser,req.params.orderId,req.body || {}) }); }
    catch (error) { const status=error.status || error.response?.status || 502; res.status(status).json({ code:status,message:error.response?.data?.message || error.message || '发送订单咨询回复失败' }); }
  });

  app.get('/api/miniprogram/v1/after-sales',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await getOrderAfterSalesData(req.authUser,req.query || {}) }); }
    catch (error) { const status=error.status || error.response?.status || 502; res.status(status).json({ code:status,message:error.response?.data?.message || error.message || '读取售后消息失败' }); }
  });

  app.get('/api/miniprogram/v1/after-sales/:claimId/messages',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await getOrderClaimMessagesData(req.authUser,req.params.claimId,req.query.storeId || '') }); }
    catch (error) { const status=error.status || error.response?.status || 502; res.status(status).json({ code:status,message:error.response?.data?.message || error.message || '读取售后会话失败' }); }
  });

  app.post('/api/miniprogram/v1/after-sales/:claimId/messages',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await sendOrderClaimMessageData(req.authUser,req.params.claimId,req.body || {}) }); }
    catch (error) { const status=error.status || error.response?.status || 502; res.status(status).json({ code:status,message:error.response?.data?.message || error.message || '发送售后回复失败' }); }
  });

  app.post('/api/miniprogram/v1/translate',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await translateOrderTextData(req.body || {}) }); }
    catch (error) { const status=error.status || 502; res.status(status).json({ code:status,message:error.message || '翻译服务暂不可用' }); }
  });

  app.post('/api/miniprogram/v1/message-translations',requireBoundOrderUser,async (req,res) => {
    try { res.json({ code:0,data:await translateOrderMessageData(req.authUser,req.body || {}) }); }
    catch (error) { const status=error.status || 502; res.status(status).json({ code:status,message:error.message || '消息翻译服务暂不可用' }); }
  });
}

module.exports = {
  DEFAULT_APP_ID,
  tokenHash,
  describeWechatLoginError,
  canTestOrders,
  initMiniProgramTables,
  registerMiniProgramRoutes
};
