const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
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

// 管理后台路由
app.get('/admin', (req, res) => {
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

// 验证登录
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
