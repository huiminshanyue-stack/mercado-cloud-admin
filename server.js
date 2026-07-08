const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3002;
const SALT_ROUNDS = 10;
const DATA_FILE = path.join(__dirname, 'cloud_data.json');

// ========== 数据初始化 ==========
let data = null;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Data] 加载失败:', e.message);
  }
  return {
    version: 0,
    users: [
      {
        id: 1,
        username: 'admin',
        password: bcrypt.hashSync('admin123', SALT_ROUNDS),
        nickname: '管理员',
        role: 'admin',
        created_at: new Date().toISOString()
      }
    ],
    ads: []
  };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Data] 保存失败:', e.message);
  }
}

function bumpVersion() {
  data.version = (data.version || 0) + 1;
  saveData();
}

let nextUserId = 2;
let nextAdId = 1;

function initIds() {
  if (data.users && data.users.length > 0) {
    nextUserId = Math.max(...data.users.map(u => u.id)) + 1;
  }
  if (data.ads && data.ads.length > 0) {
    nextAdId = Math.max(...data.ads.map(a => a.id)) + 1;
  }
}

// 初始化
data = loadData();
initIds();
console.log(`[Data] 已加载 ${data.users.length} 用户, ${data.ads.length} 广告, v${data.version}`);

// ========== 中间件 ==========
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== 工具 ==========
function jsonOk(data, msg = 'ok') {
  return { code: 0, message: msg, data };
}
function jsonFail(msg = 'error') {
  return { code: 1, message: msg };
}

// ========== 用户管理 API ==========

app.get('/api/users', (req, res) => {
  const list = data.users.map(u => ({
    id: u.id, username: u.username, nickname: u.nickname,
    role: u.role, created_at: u.created_at
  }));
  res.json(jsonOk(list));
});

app.post('/api/users', (req, res) => {
  const { username, password, nickname, role } = req.body;
  if (!username || !password) return res.json(jsonFail('用户名和密码不能为空'));

  const exist = data.users.find(u => u.username === username);
  if (exist) return res.json(jsonFail('用户名已存在'));

  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const newUser = {
    id: nextUserId++,
    username,
    password: hash,
    nickname: nickname || '',
    role: role || 'user',
    created_at: new Date().toISOString()
  };
  data.users.push(newUser);
  bumpVersion();
  res.json(jsonOk({ id: newUser.id }, '用户添加成功'));
});

app.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === 1) return res.json(jsonFail('不能删除默认管理员'));

  const idx = data.users.findIndex(u => u.id === id);
  if (idx === -1) return res.json(jsonFail('用户不存在'));

  data.users.splice(idx, 1);
  bumpVersion();
  res.json(jsonOk(null, '用户已删除'));
});

app.put('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const user = data.users.find(u => u.id === id);
  if (!user) return res.json(jsonFail('用户不存在'));

  const { password, nickname, role } = req.body;
  if (password) user.password = bcrypt.hashSync(password, SALT_ROUNDS);
  if (nickname !== undefined) user.nickname = nickname;
  if (role !== undefined) user.role = role;
  bumpVersion();
  res.json(jsonOk(null, '用户已更新'));
});

// 验证登录（供云端管理页面用，也可被本地服务器调用）
app.post('/api/verify-login', (req, res) => {
  const { username, password } = req.body;
  const user = data.users.find(u => u.username === username);
  if (!user) return res.json(jsonFail('用户名或密码错误'));

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.json(jsonFail('用户名或密码错误'));

  res.json(jsonOk({
    id: user.id, username: user.username,
    nickname: user.nickname, role: user.role
  }));
});

// ========== 广告管理 API ==========

app.get('/api/ads', (req, res) => {
  res.json(jsonOk(data.ads));
});

app.post('/api/ads', (req, res) => {
  const { title, content, imageUrl, linkUrl, enabled, isPopup } = req.body;
  if (!title) return res.json(jsonFail('广告标题不能为空'));

  const newAd = {
    id: nextAdId++,
    title,
    content: content || '',
    imageUrl: imageUrl || '',
    linkUrl: linkUrl || '',
    enabled: enabled !== false ? 1 : 0,
    isPopup: isPopup ? 1 : 0,
    created_at: new Date().toISOString()
  };
  data.ads.push(newAd);
  bumpVersion();
  res.json(jsonOk({ id: newAd.id }, '广告添加成功'));
});

app.put('/api/ads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const ad = data.ads.find(a => a.id === id);
  if (!ad) return res.json(jsonFail('广告不存在'));

  const { title, content, imageUrl, linkUrl, enabled, isPopup } = req.body;
  if (title !== undefined) ad.title = title;
  if (content !== undefined) ad.content = content;
  if (imageUrl !== undefined) ad.imageUrl = imageUrl;
  if (linkUrl !== undefined) ad.linkUrl = linkUrl;
  if (enabled !== undefined) ad.enabled = enabled !== false ? 1 : 0;
  if (isPopup !== undefined) ad.isPopup = isPopup ? 1 : 0;
  bumpVersion();
  res.json(jsonOk(null, '广告已更新'));
});

app.delete('/api/ads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = data.ads.findIndex(a => a.id === id);
  if (idx === -1) return res.json(jsonFail('广告不存在'));

  data.ads.splice(idx, 1);
  bumpVersion();
  res.json(jsonOk(null, '广告已删除'));
});

// ========== 同步接口（本地服务器每5秒轮询） ==========
app.get('/api/sync', (req, res) => {
  res.json({
    code: 0,
    data: {
      version: data.version,
      users: data.users,    // 含密码hash，本地验证登录需要
      ads: data.ads
    }
  });
});

// ========== 健康检查 ==========
app.get('/api/health', (req, res) => {
  res.json(jsonOk({
    version: data.version,
    users: data.users.length,
    ads: data.ads.length,
    uptime: process.uptime()
  }));
});

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================');
  console.log('  美客多爆品选品雷达 - 云端管理后台');
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  管理页面: http://localhost:${PORT}/`);
  console.log('  默认管理员: admin / admin123');
  console.log('============================================');
});
