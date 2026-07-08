const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3002;
const SALT_ROUNDS = 10;

// ========== PostgreSQL 连接 ==========
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

async function connectDB() {
  if (!DATABASE_URL) {
    console.error('[DB] ❌ 未设置 DATABASE_URL 环境变量！');
    console.error('[DB] 请在 Railway 中添加 PostgreSQL 数据库服务');
    process.exit(1);
  }

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    client_encoding: 'utf8'
  });

  try {
    const client = await pool.connect();
    console.log('[DB] ✅ PostgreSQL 连接成功');
    client.release();
  } catch (e) {
    console.error('[DB] ❌ 连接失败:', e.message);
    process.exit(1);
  }
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      nickname VARCHAR(100) DEFAULT '',
      role VARCHAR(20) DEFAULT 'user',
      validUntil TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      content TEXT DEFAULT '',
      imageUrl TEXT DEFAULT '',
      linkUrl TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      isPopup INTEGER DEFAULT 0,
      isBanner INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // 兼容旧表：添加 isBanner 列
  try {
    await pool.query('ALTER TABLE ads ADD COLUMN IF NOT EXISTS isBanner INTEGER DEFAULT 0');
  } catch (e) { console.log('[DB] isBanner 列已存在'); }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] ✅ 数据库表已就绪');
}

async function seedAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM users');
  if (parseInt(rows[0].count) === 0) {
    const hash = bcrypt.hashSync('admin123', SALT_ROUNDS);
    await pool.query(
      'INSERT INTO users (username, password, nickname, role) VALUES ($1, $2, $3, $4)',
      ['admin', hash, '管理员', 'admin']
    );
    console.log('[DB] ✅ 已创建默认管理员: admin / admin123');
  }
}

// ========== 中间件 ==========
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== Token 认证系统（单设备登录） ==========
const tokens = {};
const activeTokens = {};  // username -> 最新token，用于单设备登录踢下线

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isUserExpired(user) {
  if (!user || !user.validuntil) return false;
  const end = new Date(user.validuntil);
  if (isNaN(end.getTime())) return false;
  end.setHours(23, 59, 59, 999);
  return Date.now() > end.getTime();
}

function getAuthUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !tokens[token]) return null;
  return tokens[token];
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !tokens[token]) return res.json({ code: 401, message: '未登录或登录已过期' });

  const user = tokens[token];
  // 单设备检查：如果该用户有更新的token，则当前token被踢下线
  if (activeTokens[user.username] && activeTokens[user.username] !== token) {
    // 清除被踢的token
    delete tokens[token];
    return res.json({ code: 409, message: '您的账号已在其他设备登录，当前登录已失效' });
  }

  req.authUser = user;
  req.currentToken = token;
  next();
}

// 管理后台路由
app.get('/mgmt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// ========== 工具 ==========
function jsonOk(data, msg = 'ok') {
  return { code: 0, message: msg, data };
}
function jsonFail(msg = 'error') {
  return { code: 1, message: msg };
}

async function bumpVersion() {
  // 版本号用表的总行数变化表示
}

// ========== 用户管理 API ==========

app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, nickname, role, validUntil, created_at FROM users ORDER BY id'
    );
    const list = rows.map(u => ({
      id: u.id, username: u.username, nickname: u.nickname,
      role: u.role, validUntil: u.validuntil || null,
      created_at: u.created_at ? new Date(u.created_at).toISOString() : ''
    }));
    res.json(jsonOk(list));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.post('/api/users', async (req, res) => {
  const { username, password, nickname, role, validUntil } = req.body;
  if (!username || !password) return res.json(jsonFail('用户名和密码不能为空'));

  try {
    const exist = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (exist.rows.length > 0) return res.json(jsonFail('用户名已存在'));

    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (username, password, nickname, role, validUntil) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [username, hash, nickname || '', role || 'user', validUntil ? new Date(validUntil) : null]
    );
    res.json(jsonOk({ id: result.rows[0].id }, '用户添加成功'));
  } catch (e) {
    console.error('[Users] 添加失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === 1) return res.json(jsonFail('不能删除默认管理员'));

  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.json(jsonFail('用户不存在'));
    res.json(jsonOk(null, '用户已删除'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.put('/api/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { password, nickname, role, validUntil } = req.body;

  try {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (user.rows.length === 0) return res.json(jsonFail('用户不存在'));

    let updates = [];
    let params = [];
    let idx = 1;

    if (password) {
      const hash = bcrypt.hashSync(password, SALT_ROUNDS);
      updates.push(`password = $${idx++}`);
      params.push(hash);
    }
    if (nickname !== undefined) {
      updates.push(`nickname = $${idx++}`);
      params.push(nickname);
    }
    if (role !== undefined) {
      updates.push(`role = $${idx++}`);
      params.push(role);
    }
    if (validUntil !== undefined) {
      updates.push(`validUntil = $${idx++}`);
      params.push(validUntil ? new Date(validUntil) : null);
    }

    if (updates.length > 0) {
      params.push(id);
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    }

    res.json(jsonOk(null, '用户已更新'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// 验证登录（兼容旧版同步）
app.post('/api/verify-login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (rows.length === 0) return res.json(jsonFail('用户名或密码错误'));

    const user = rows[0];
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.json(jsonFail('用户名或密码错误'));

    res.json(jsonOk({
      id: user.id, username: user.username,
      nickname: user.nickname, role: user.role
    }));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// ========== 前端认证 API（前端 App.vue 调用） ==========

// 登录：验证密码 + 创建 token
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json(jsonFail('请输入用户名和密码'));

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (rows.length === 0) return res.json({ code: 401, message: '用户名或密码错误' });

    const user = rows[0];
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.json({ code: 401, message: '用户名或密码错误' });

    // 检查账号是否到期
    if (isUserExpired(user)) {
      return res.json({ code: 403, message: '账号已到期，请联系管理员' });
    }

    const token = generateToken();
    tokens[token] = {
      username: user.username,
      nickname: user.nickname,
      role: user.role,
      validUntil: user.validuntil || null,
      loginTime: Date.now()
    };

    // 单设备登录：清除该用户旧的 token，记录为最新的
    if (activeTokens[user.username]) {
      const oldToken = activeTokens[user.username];
      delete tokens[oldToken];
    }
    activeTokens[user.username] = token;

    res.json({
      code: 0,
      data: {
        token,
        user: {
          username: user.username,
          nickname: user.nickname,
          role: user.role,
          validUntil: user.validuntil || null
        }
      }
    });
  } catch (e) {
    console.error('[Auth] 登录失败:', e.message);
    res.status(500).json({ code: 500, message: '服务器错误，请稍后重试' });
  }
});

// 验证 token
app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({
    code: 0,
    data: { user: req.authUser }
  });
});

// 退出登录
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const user = tokens[token];
    // 如果退出的是该用户的活跃token，清除记录
    if (user && activeTokens[user.username] === token) {
      delete activeTokens[user.username];
    }
    delete tokens[token];
  }
  res.json({ code: 0, message: '已退出' });
});

// 前端配置接口
app.get('/api/config', (req, res) => {
  res.json({
    code: 0,
    data: {
      cloudUrl: 'https://mercado-cloud-admin-production.up.railway.app',
      cloudConnected: true
    }
  });
});

// ========== 广告管理 API ==========

app.get('/api/ads', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ads ORDER BY id');
    const list = rows.map(a => ({
      id: a.id, title: a.title, content: a.content || '',
      imageUrl: a.imageurl || '', linkUrl: a.linkurl || '',
      enabled: a.enabled, isPopup: a.ispopup, isBanner: a.isbanner,
      created_at: a.created_at ? new Date(a.created_at).toISOString() : ''
    }));
    res.json(jsonOk(list));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.post('/api/ads', async (req, res) => {
  const { title, content, imageUrl, linkUrl, enabled, isPopup, isBanner } = req.body;
  if (!title) return res.json(jsonFail('广告标题不能为空'));

  try {
    const result = await pool.query(
      'INSERT INTO ads (title, content, imageUrl, linkUrl, enabled, isPopup, isBanner) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [title, content || '', imageUrl || '', linkUrl || '', enabled !== false ? 1 : 0, isPopup ? 1 : 0, isBanner ? 1 : 0]
    );
    res.json(jsonOk({ id: result.rows[0].id }, '广告添加成功'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.put('/api/ads/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, content, imageUrl, linkUrl, enabled, isPopup, isBanner } = req.body;

  try {
    const updates = [];
    const params = [];
    let idx = 1;

    if (title !== undefined) { updates.push(`title = $${idx++}`); params.push(title); }
    if (content !== undefined) { updates.push(`content = $${idx++}`); params.push(content); }
    if (imageUrl !== undefined) { updates.push(`imageUrl = $${idx++}`); params.push(imageUrl); }
    if (linkUrl !== undefined) { updates.push(`linkUrl = $${idx++}`); params.push(linkUrl); }
    if (enabled !== undefined) { updates.push(`enabled = $${idx++}`); params.push(enabled !== false ? 1 : 0); }
    if (isPopup !== undefined) { updates.push(`isPopup = $${idx++}`); params.push(isPopup ? 1 : 0); }
    if (isBanner !== undefined) { updates.push(`isBanner = $${idx++}`); params.push(isBanner ? 1 : 0); }

    if (updates.length > 0) {
      params.push(id);
      const result = await pool.query(`UPDATE ads SET ${updates.join(', ')} WHERE id = $${idx}`, params);
      if (result.rowCount === 0) return res.json(jsonFail('广告不存在'));
    }
    res.json(jsonOk(null, '广告已更新'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.delete('/api/ads/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query('DELETE FROM ads WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.json(jsonFail('广告不存在'));
    res.json(jsonOk(null, '广告已删除'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// ========== 前端广告 API（供 App.vue 调用） ==========

// 获取启用的弹窗广告
app.get('/api/ads/active', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM ads WHERE enabled = 1 AND isPopup = 1 ORDER BY id");
    const list = rows.map(a => ({
      id: a.id, title: a.title, content: a.content || '',
      imageUrl: a.imageurl || '', linkUrl: a.linkurl || ''
    }));
    res.json({ code: 0, data: list });
  } catch (e) {
    res.status(500).json({ code: 500, message: '数据库错误' });
  }
});

// 获取启用的横幅广告
app.get('/api/ads/banner', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM ads WHERE enabled = 1 AND isBanner = 1 ORDER BY id");
    const list = rows.map(a => ({
      id: a.id, title: a.title,
      imageUrl: a.imageurl || '', linkUrl: a.linkurl || ''
    }));
    res.json({ code: 0, data: list });
  } catch (e) {
    res.status(500).json({ code: 500, message: '数据库错误' });
  }
});

// ========== 系统设置 API ==========

app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json(jsonOk(data));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.put('/api/settings', async (req, res) => {
  const settings = req.body;
  if (!settings || typeof settings !== 'object') return res.json(jsonFail('参数错误'));

  try {
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
        [key, value]
      );
    }
    res.json(jsonOk(null, '设置已更新'));
  } catch (e) {
    console.error('[Settings] 更新失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// ========== 同步接口 ==========
app.get('/api/sync', async (req, res) => {
  try {
    const usersResult = await pool.query('SELECT * FROM users ORDER BY id');
    const adsResult = await pool.query('SELECT * FROM ads ORDER BY id');
    const settingsResult = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    settingsResult.rows.forEach(r => { settings[r.key] = r.value; });

    // PostgreSQL 返回列名是小写，需映射为 camelCase
    const users = usersResult.rows.map(u => ({
      id: u.id, username: u.username, password: u.password,
      nickname: u.nickname, role: u.role,
      validUntil: u.validuntil || null,
      created_at: u.created_at
    }));
    const ads = adsResult.rows.map(a => ({
      id: a.id, title: a.title, content: a.content,
      imageUrl: a.imageurl || '', linkUrl: a.linkurl || '',
      enabled: a.enabled, isPopup: a.ispopup, isBanner: a.isbanner,
      created_at: a.created_at
    }));

    res.json({
      code: 0,
      data: { version: Date.now(), users, ads, settings }
    });
  } catch (e) {
    console.error('[Sync] 错误:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// ========== 搜索代理（前端 App.vue 调用） ==========
app.get('/api/search', async (req, res) => {
  try {
    const defaults = {
      keyword: '', region: 'MLM', full: 'false',
      shippedFrom: 'Envío desde China', crossBorder: 'true',
      sort: 'totalSold', order: 'descend', page: '1', size: '20'
    };
    const params = { ...defaults, ...req.query };
    params.page = String(params.page);
    params.size = String(params.size);

    const response = await axios.get('https://api.meikeduoshuju.com/api/v1/goods/search', {
      params, timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('[Search] 请求失败:', error.message);
    if (error.response) {
      res.status(error.response.status).json({ code: error.response.status, message: `上游接口错误: ${error.response.status}` });
    } else if (error.request) {
      res.status(504).json({ code: 504, message: '搜索接口超时或无响应' });
    } else {
      res.status(500).json({ code: 500, message: error.message });
    }
  }
});

// 品类列表代理
app.get('/api/category/list', async (req, res) => {
  try {
    const params = { region: req.query.region || 'MLM' };
    if (req.query.level) params.level = req.query.level;
    if (req.query.parentCatId) params.parentCatId = req.query.parentCatId;

    const response = await axios.get('https://api.meikeduoshuju.com/api/v1/category/list', {
      params, timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('[Category] 请求失败:', error.message);
    if (error.response) {
      res.status(error.response.status).json({ code: error.response.status, message: `上游接口错误: ${error.response.status}` });
    } else {
      res.status(500).json({ code: 500, message: error.message });
    }
  }
});

// ========== 健康检查 ==========
app.get('/api/health', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const ads = await pool.query('SELECT COUNT(*) as count FROM ads');
    res.json(jsonOk({
      version: Date.now(),
      users: parseInt(users.rows[0].count),
      ads: parseInt(ads.rows[0].count),
      uptime: process.uptime()
    }));
  } catch (e) {
    res.status(500).json({ code: 1, message: '数据库连接失败' });
  }
});

// ========== 启动 ==========
async function start() {
  await connectDB();
  await initSchema();
  await seedAdmin();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('============================================');
    console.log('  美客多爆品选品雷达 - 云端管理后台');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`  管理页面: http://localhost:${PORT}/`);
    console.log('  默认管理员: admin / admin123');
    console.log('============================================');
  });
}

start();
