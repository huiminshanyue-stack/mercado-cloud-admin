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
    getOrderStoresData
  } = dependencies;
  const appId = process.env.WECHAT_MINIPROGRAM_APPID || DEFAULT_APP_ID;
  const appSecret = process.env.WECHAT_MINIPROGRAM_SECRET || '';

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
      writeOperationsEnabled: false,
      environment: process.env.NODE_ENV || 'production'
    } });
  });

  app.post('/api/miniprogram/v1/auth/wechat-login',loginRateLimit,async (req,res) => {
    const code = String(req.body?.code || '').trim();
    if (!code || code.length > 200) return res.status(400).json({ code: 400, message: '微信登录凭证无效' });
    if (!appSecret) return res.status(503).json({ code: 503, message: '微信登录等待认证完成，请暂时使用ERP内测登录' });
    try {
      const response = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
        params: { appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' },
        timeout: 15000
      });
      const data = response.data || {};
      if (data.errcode || !data.openid) {
        return res.status(401).json({ code: 401, message: data.errmsg || '微信身份验证失败' });
      }
      const identity = await pool.query(`INSERT INTO wechat_miniprogram_identities(app_id,open_id,union_id,updated_at)
        VALUES($1,$2,$3,NOW()) ON CONFLICT(app_id,open_id) DO UPDATE SET
        union_id=COALESCE(EXCLUDED.union_id,wechat_miniprogram_identities.union_id),updated_at=NOW()
        RETURNING id,erp_username`,[appId,String(data.openid),data.unionid ? String(data.unionid) : null]);
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
    await pool.query('UPDATE wechat_miniprogram_identities SET erp_username=$1,updated_at=NOW() WHERE id=$2',[user.username,req.miniAuth.identityId]);
    res.json({ code: 0, data: { bound: true,user: { username:user.username,nickname:user.nickname,role:user.role,validUntil:user.validuntil || null } } });
  });

  app.get('/api/miniprogram/v1/me',requireMiniAuth,(req,res) => {
    res.json({ code: 0, data: {
      bound: req.miniAuth.bound,
      authSource: req.miniAuth.source,
      user: req.authUser || null,
      writeOperationsEnabled: false
    } });
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

  app.get('/api/miniprogram/v1/orders/:orderId',requireBoundOrderUser,async (req,res) => {
    try {
      const data = await getOrderListData(req.authUser,{ orderId: String(req.params.orderId),page:1,size:1 });
      if (!data.items.length) return res.status(404).json({ code: 404, message: '订单不存在或无权查看' });
      res.json({ code: 0, data: data.items[0] });
    } catch (error) { res.status(500).json({ code: 500, message: error.message || '读取订单详情失败' }); }
  });
}

module.exports = {
  DEFAULT_APP_ID,
  tokenHash,
  canTestOrders,
  initMiniProgramTables,
  registerMiniProgramRoutes
};
