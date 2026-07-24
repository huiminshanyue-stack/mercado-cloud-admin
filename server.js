const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3002;
const SALT_ROUNDS = 10;
const SESSION_MAX_AGE_DAYS = 30;
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';
const PUBLIC_SETTING_KEYS = new Set([
  'latestVersion',
  'appTitle',
  'priceCurrency',
  'loginBackground',
  'bannerInterval',
  'downloadUrl'
]);

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
    client_encoding: 'utf8',
    max: Number(process.env.DB_POOL_MAX || 6),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000
  });
  pool.on('error', error => console.error('[DB] idle client error:', error.message));

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
      created_by VARCHAR(100) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // 兼容旧表：添加 created_by 列
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) DEFAULT NULL");
  } catch (e) { console.log('[DB] created_by 列已存在'); }
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
  // 持久化 Token 存储（部署不踢人）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      token VARCHAR(100) PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      role VARCHAR(20) NOT NULL,
      validuntil TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // 清理 30 天前的过期 session
  try {
    await pool.query("DELETE FROM user_sessions WHERE created_at < NOW() - INTERVAL '30 days'");
  } catch (e) { /* ignore */ }
  console.log('[DB] ✅ 数据库表已就绪');
}

async function initDashboardTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hot_products (
      id SERIAL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      price VARCHAR(100) NOT NULL,
      currency VARCHAR(10) DEFAULT 'USD',
      sales30 VARCHAR(50) NOT NULL,
      revenue VARCHAR(100) NOT NULL,
      region VARCHAR(10) DEFAULT 'MLM',
      image_url TEXT DEFAULT '',
      link_url TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try {
    await pool.query('ALTER TABLE hot_products ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT \'\'');
  } catch (e) { console.log('[DB] image_url 列已存在'); }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hot_keywords (
      id SERIAL PRIMARY KEY,
      keyword VARCHAR(255) NOT NULL,
      search_vol VARCHAR(50) NOT NULL,
      sales_vol VARCHAR(50) NOT NULL,
      product_count VARCHAR(50) NOT NULL,
      trend NUMERIC DEFAULT 0,
      region VARCHAR(10) DEFAULT 'MLM',
      week_index INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_stats (
      id SERIAL PRIMARY KEY,
      stat_date DATE NOT NULL UNIQUE,
      total_products BIGINT DEFAULT 0,
      active_products BIGINT DEFAULT 0,
      active_rate VARCHAR(10) DEFAULT '0%',
      total_sold30 BIGINT DEFAULT 0,
      sold_mom VARCHAR(10) DEFAULT '0%',
      total_revenue30 BIGINT DEFAULT 0,
      revenue_mom VARCHAR(10) DEFAULT '0%',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] ✅ Dashboard 榜单表已就绪');
}

async function seedAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM users');
  if (parseInt(rows[0].count) === 0) {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
    if (!initialPassword) {
      throw new Error('ADMIN_INITIAL_PASSWORD must be configured before creating the first administrator');
    }
    const hash = bcrypt.hashSync(initialPassword, SALT_ROUNDS);
    await pool.query(
      'INSERT INTO users (username, password, nickname, role) VALUES ($1, $2, $3, $4)',
      ['admin', hash, '管理员', 'admin']
    );
    console.log('[DB] ✅ 已创建初始管理员');
  }
}

async function initInternationalProductTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS international_products (
      id BIGSERIAL PRIMARY KEY,
      country VARCHAR(2) NOT NULL,
      item_id VARCHAR(40) NOT NULL,
      title TEXT NOT NULL,
      price NUMERIC(18,2),
      currency VARCHAR(3),
      discount VARCHAR(80),
      image_url TEXT,
      product_url TEXT NOT NULL,
      category_name VARCHAR(300),
      category_url TEXT,
      listing_time TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(country, item_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_international_products_country ON international_products(country)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_international_products_last_seen ON international_products(last_seen_at DESC)');
  await pool.query('ALTER TABLE international_products ADD COLUMN IF NOT EXISTS original_price NUMERIC(18,2)');
  await pool.query('ALTER TABLE international_products ADD COLUMN IF NOT EXISTS rating NUMERIC(4,2)');
  await pool.query('ALTER TABLE international_products ADD COLUMN IF NOT EXISTS review_count INTEGER');
  await pool.query('ALTER TABLE international_products ADD COLUMN IF NOT EXISTS sold_text VARCHAR(120)');
  await pool.query('ALTER TABLE international_products ADD COLUMN IF NOT EXISTS seller VARCHAR(300)');
  await pool.query('ALTER TABLE international_products ADD COLUMN IF NOT EXISTS shipping_text VARCHAR(500)');
  await pool.query('ALTER TABLE international_products ADD COLUMN IF NOT EXISTS origin_text VARCHAR(200)');
}

async function initOrderManagementTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_stores (
    ml_user_id VARCHAR(80) PRIMARY KEY,
    owner_username VARCHAR(120),
    nickname VARCHAR(300),
    remark VARCHAR(300),
    site_id VARCHAR(20),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE ml_stores ADD COLUMN IF NOT EXISTS owner_username VARCHAR(120)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ml_orders (
      id BIGSERIAL PRIMARY KEY,
      ml_order_id VARCHAR(80) UNIQUE NOT NULL,
      owner_username VARCHAR(120),
      status VARCHAR(80),
      date_created TIMESTAMPTZ,
      date_closed TIMESTAMPTZ,
      buyer_id VARCHAR(80),
      buyer_nickname VARCHAR(300),
      currency VARCHAR(10),
      total_amount NUMERIC(18,2),
      paid_amount NUMERIC(18,2),
      shipping_id VARCHAR(80),
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      push_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      last_pushed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_orders_date ON ml_orders(date_created DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_orders_status ON ml_orders(status, push_status)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS site_id VARCHAR(10)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS owner_username VARCHAR(120)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS country VARCHAR(10)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS shipment_status VARCHAR(50)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS shipment_substatus VARCHAR(100)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(200)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS tracking_method VARCHAR(200)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS logistic_type VARCHAR(100)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS pack_id VARCHAR(80)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS handling_deadline TIMESTAMPTZ');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS deadline_is_estimated BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(500)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS store_user_id VARCHAR(80)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS sale_fee NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS shipping_fee NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS net_amount NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS gross_amount_usd NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS net_amount_usd NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS refund_amount_usd NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(18,2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS product_cost NUMERIC(18,2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS cost_note VARCHAR(500)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS other_fee NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS billing_data JSONB NOT NULL DEFAULT \'{}\'::jsonb');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS finance_is_official BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS finance_synced_at TIMESTAMPTZ');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_orders_store ON ml_orders(store_user_id, date_created DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_orders_owner_date ON ml_orders(owner_username,date_created DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_orders_buyer ON ml_orders(buyer_nickname, date_created DESC)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS shipment_data JSONB NOT NULL DEFAULT \'{}\'::jsonb');
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_store_authorizations (
    id BIGSERIAL PRIMARY KEY,
    owner_username VARCHAR(120) NOT NULL,
    ml_user_id VARCHAR(80) NOT NULL,
    nickname VARCHAR(300),
    site_id VARCHAR(20),
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT,
    expires_at BIGINT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_username, ml_user_id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_store_auth_owner ON ml_store_authorizations(owner_username,enabled)');
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_oauth_states (
    state VARCHAR(128) PRIMARY KEY,
    owner_username VARCHAR(120) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_alerts (
    id BIGSERIAL PRIMARY KEY, owner_username VARCHAR(120), order_id VARCHAR(80), alert_type VARCHAR(50) NOT NULL,
    title VARCHAR(300) NOT NULL, content TEXT, is_read BOOLEAN NOT NULL DEFAULT FALSE,
    event_key VARCHAR(300) UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE order_alerts ADD COLUMN IF NOT EXISTS owner_username VARCHAR(120)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_order_alerts_unread ON order_alerts(is_read, created_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_connectors (
      id BIGSERIAL PRIMARY KEY,
      owner_username VARCHAR(120),
      name VARCHAR(120) NOT NULL,
      endpoint TEXT NOT NULL,
      auth_header VARCHAR(120),
      auth_value TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE erp_connectors ADD COLUMN IF NOT EXISTS owner_username VARCHAR(120)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_push_logs (
      id BIGSERIAL PRIMARY KEY,
      owner_username VARCHAR(120),
      order_id VARCHAR(80) NOT NULL,
      connector_id BIGINT REFERENCES erp_connectors(id) ON DELETE SET NULL,
      success BOOLEAN NOT NULL,
      http_status INTEGER,
      response_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE erp_push_logs ADD COLUMN IF NOT EXISTS owner_username VARCHAR(120)');
  await pool.query(`CREATE TABLE IF NOT EXISTS fulfillment_services (
    id BIGSERIAL PRIMARY KEY, owner_username VARCHAR(120), name VARCHAR(120) NOT NULL, code VARCHAR(100), description VARCHAR(500), enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE fulfillment_services ADD COLUMN IF NOT EXISTS owner_username VARCHAR(120)');
  await pool.query(`CREATE TABLE IF NOT EXISTS logistics_companies (
    id BIGSERIAL PRIMARY KEY, owner_username VARCHAR(120) NOT NULL,
    name VARCHAR(120) NOT NULL, code VARCHAR(100), enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(owner_username,name)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fulfillment_submissions (
    id BIGSERIAL PRIMARY KEY, owner_username VARCHAR(120), order_id VARCHAR(80) NOT NULL, warehouse_id BIGINT REFERENCES erp_connectors(id) ON DELETE SET NULL,
    carrier VARCHAR(200) NOT NULL, tracking_number VARCHAR(300) NOT NULL, service_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'pending', request_data JSONB NOT NULL DEFAULT '{}'::jsonb, response_text TEXT,
    failure_reason TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(order_id)
  )`);
  await pool.query('ALTER TABLE fulfillment_submissions ADD COLUMN IF NOT EXISTS owner_username VARCHAR(120)');
  await pool.query('ALTER TABLE fulfillment_submissions ADD COLUMN IF NOT EXISTS failure_reason TEXT');
  await pool.query('ALTER TABLE fulfillment_submissions ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0');
  await pool.query(`CREATE TABLE IF NOT EXISTS order_message_reads (
    owner_username VARCHAR(120) NOT NULL, thread_type VARCHAR(30) NOT NULL,
    thread_id VARCHAR(120) NOT NULL, last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_username,thread_type,thread_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_api_audits (
    id BIGSERIAL PRIMARY KEY, owner_username VARCHAR(120) NOT NULL,
    store_user_id VARCHAR(80), order_id VARCHAR(80), api_type VARCHAR(50) NOT NULL,
    external_id VARCHAR(160) NOT NULL, raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_username,api_type,external_id)
  )`);

  // 将升级前的存量数据归属到其已授权用户；无法确定归属的数据保持不可见，避免跨用户泄露。
  await pool.query(`UPDATE ml_stores s SET owner_username=a.owner_username
    FROM (SELECT DISTINCT ON (ml_user_id) ml_user_id,owner_username FROM ml_store_authorizations ORDER BY ml_user_id,updated_at DESC) a
    WHERE s.ml_user_id=a.ml_user_id AND s.owner_username IS NULL`);
  await pool.query(`UPDATE ml_orders o SET owner_username=a.owner_username
    FROM (SELECT DISTINCT ON (ml_user_id) ml_user_id,owner_username FROM ml_store_authorizations ORDER BY ml_user_id,updated_at DESC) a
    WHERE o.store_user_id=a.ml_user_id AND o.owner_username IS NULL`);
  await pool.query(`UPDATE order_alerts a SET owner_username=o.owner_username FROM ml_orders o
    WHERE a.order_id=o.ml_order_id AND a.owner_username IS NULL`);
  // 预计发货时效统一为：周一至周四 72 小时；周五、周六 120 小时；周日 96 小时。
  // 迁移只执行一次且仅调整系统估算值，不覆盖 Mercado Libre 官方返回的 handling deadline。
  const deadlineRuleVersion = '2026-07-24-72h-v1';
  const deadlineRuleSetting = await pool.query("SELECT value FROM settings WHERE key='order_deadline_rule_version'");
  if (deadlineRuleSetting.rows[0]?.value !== deadlineRuleVersion) {
    await pool.query(`UPDATE ml_orders SET handling_deadline=date_created + CASE EXTRACT(DOW FROM
      COALESCE(NULLIF(LEFT(raw_data->>'date_created',10),'')::date,(date_created AT TIME ZONE 'Asia/Shanghai')::date))
      WHEN 5 THEN INTERVAL '120 hours'
      WHEN 6 THEN INTERVAL '120 hours'
      WHEN 0 THEN INTERVAL '96 hours'
      ELSE INTERVAL '72 hours' END,updated_at=NOW()
      WHERE deadline_is_estimated=TRUE AND date_created IS NOT NULL`);
    await pool.query(`UPDATE order_alerts SET is_read=TRUE
      WHERE alert_type='deadline' AND event_key LIKE 'deadline:%'`);
    await pool.query(`INSERT INTO settings(key,value,updated_at) VALUES('order_deadline_rule_version',$1,NOW())
      ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()`, [deadlineRuleVersion]);
  }
  await pool.query(`UPDATE erp_connectors SET owner_username=(SELECT username FROM users WHERE role='admin' ORDER BY created_at LIMIT 1) WHERE owner_username IS NULL`);
  await pool.query(`UPDATE fulfillment_services SET owner_username=(SELECT username FROM users WHERE role='admin' ORDER BY created_at LIMIT 1) WHERE owner_username IS NULL`);
  await pool.query(`UPDATE fulfillment_submissions SET owner_username=(SELECT username FROM users WHERE role='admin' ORDER BY created_at LIMIT 1) WHERE owner_username IS NULL`);
  await pool.query(`UPDATE erp_push_logs SET owner_username=(SELECT username FROM users WHERE role='admin' ORDER BY created_at LIMIT 1) WHERE owner_username IS NULL`);
}

async function seedDashboardData() {
  // 仅在首次初始化的空数据库中写入示例数据，避免部署或重启覆盖运营数据。
  const [productCount, keywordCount] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM hot_products'),
    pool.query('SELECT COUNT(*)::int AS count FROM hot_keywords')
  ]);
  if (productCount.rows[0].count > 0 || keywordCount.rows[0].count > 0) {
    console.log('[DB] Dashboard 已有数据，跳过示例数据初始化');
    return;
  }
  const defaultImage = 'https://images.unsplash.com/photo-1605106702734-205df6f24ab3?w=120&h=120&fit=crop';
  const products = [
      { title: 'Smartphone Samsung Galaxy S24 Ultra 512GB', price: '1,299', currency: 'USD', sales30: '28,431', revenue: '$36.9M', region: 'MLM', image_url: '', sort_order: 1 },
      { title: 'Apple iPhone 15 Pro Max 256GB', price: '1,499', currency: 'USD', sales30: '24,762', revenue: '$37.1M', region: 'MLM', image_url: '', sort_order: 2 },
      { title: 'Zapatillas Nike Air Max 90 Originales', price: '129', currency: 'USD', sales30: '22,154', revenue: '$2.86M', region: 'MLM', image_url: '', sort_order: 3 },
      { title: 'Auriculares Inalámbricos Sony WH-1000XM5', price: '349', currency: 'USD', sales30: '19,876', revenue: '$6.94M', region: 'MLM', image_url: '', sort_order: 4 },
      { title: 'Smart TV Samsung 65" 4K UHD', price: '899', currency: 'USD', sales30: '17,432', revenue: '$15.7M', region: 'MLM', image_url: '', sort_order: 5 },
      { title: 'Celular Xiaomi Redmi Note 13 Pro 256GB', price: '329', currency: 'USD', sales30: '16,821', revenue: '$5.53M', region: 'MLB', image_url: '', sort_order: 6 },
      { title: 'Tênis Nike Air Force 1 Masculino', price: '119', currency: 'USD', sales30: '15,432', revenue: '$1.84M', region: 'MLB', image_url: '', sort_order: 7 },
      { title: 'Fritadeira Elétrica Air Fryer 5L', price: '89', currency: 'USD', sales30: '14,876', revenue: '$1.32M', region: 'MLB', image_url: '', sort_order: 8 },
      { title: 'Relógio Smartwatch Apple Watch Series 9', price: '429', currency: 'USD', sales30: '13,542', revenue: '$5.81M', region: 'MLB', image_url: '', sort_order: 9 },
      { title: 'Notebook Dell Inspiron 15 8GB RAM 512GB SSD', price: '649', currency: 'USD', sales30: '12,098', revenue: '$7.85M', region: 'MLC', image_url: '', sort_order: 10 },
      { title: 'Aspiradora Robot Xiaomi Mi Robot Vacuum', price: '279', currency: 'USD', sales30: '11,654', revenue: '$3.25M', region: 'MLC', image_url: '', sort_order: 11 },
      { title: 'Cámara de Seguridad WiFi 360°', price: '59', currency: 'USD', sales30: '18,432', revenue: '$1.09M', region: 'MLM', image_url: '', sort_order: 12 },
      { title: 'Tablet Samsung Galaxy Tab S9 FE 128GB', price: '449', currency: 'USD', sales30: '10,876', revenue: '$4.88M', region: 'MLM', image_url: '', sort_order: 13 },
      { title: 'Mochila Escolar Antirrobo USB', price: '39', currency: 'USD', sales30: '21,543', revenue: '$0.84M', region: 'MLM', image_url: '', sort_order: 14 },
      { title: 'Lámpara LED de Escritorio Recargable', price: '25', currency: 'USD', sales30: '26,876', revenue: '$0.67M', region: 'MLM', image_url: '', sort_order: 15 },
      { title: 'iPad Pro 12.9" M2 256GB', price: '1,099', currency: 'USD', sales30: '9,876', revenue: '$10.9M', region: 'MLM', image_url: '', sort_order: 16 },
      { title: 'PlayStation 5 Slim 1TB', price: '499', currency: 'USD', sales30: '9,654', revenue: '$4.82M', region: 'MLM', image_url: '', sort_order: 17 },
      { title: 'Cámara Sony Alpha 7 IV', price: '2,499', currency: 'USD', sales30: '4,321', revenue: '$10.8M', region: 'MLM', image_url: '', sort_order: 18 },
      { title: 'Bicicleta Eléctrica Plegable 750W', price: '899', currency: 'USD', sales30: '5,432', revenue: '$4.88M', region: 'MLM', image_url: '', sort_order: 19 },
      { title: 'Licuadora Vitamix 5200', price: '399', currency: 'USD', sales30: '6,789', revenue: '$2.71M', region: 'MLM', image_url: '', sort_order: 20 },
      { title: 'Perfume Chanel No. 5 100ml', price: '149', currency: 'USD', sales30: '14,567', revenue: '$2.17M', region: 'MLM', image_url: '', sort_order: 21 },
      { title: 'Cepillo Dyson Airwrap', price: '549', currency: 'USD', sales30: '5,234', revenue: '$2.87M', region: 'MLM', image_url: '', sort_order: 22 },
      { title: 'Maletín Ejecutivo Cuero Genuino', price: '189', currency: 'USD', sales30: '7,654', revenue: '$1.45M', region: 'MLM', image_url: '', sort_order: 23 },
      { title: 'Gafas de Sol Ray-Ban Aviator', price: '179', currency: 'USD', sales30: '11,234', revenue: '$2.01M', region: 'MLM', image_url: '', sort_order: 24 },
      { title: 'Cafetera Nespresso Vertuo', price: '199', currency: 'USD', sales30: '8,765', revenue: '$1.74M', region: 'MLM', image_url: '', sort_order: 25 },
      { title: 'Silla Ergonómica de Oficina', price: '349', currency: 'USD', sales30: '6,543', revenue: '$2.28M', region: 'MLM', image_url: '', sort_order: 26 },
      { title: 'Monitor Gamer 27" 165Hz', price: '329', currency: 'USD', sales30: '7,890', revenue: '$2.59M', region: 'MLC', image_url: '', sort_order: 27 },
      { title: 'Teclado Mecánico Logitech G Pro', price: '129', currency: 'USD', sales30: '13,456', revenue: '$1.74M', region: 'MLC', image_url: '', sort_order: 28 },
      { title: 'Mouse Inalámbrico Logitech MX Master 3S', price: '99', currency: 'USD', sales30: '15,678', revenue: '$1.55M', region: 'MLC', image_url: '', sort_order: 29 },
      { title: 'Disco Duro Externo SSD 1TB', price: '89', currency: 'USD', sales30: '12,345', revenue: '$1.10M', region: 'MLC', image_url: '', sort_order: 30 },
      { title: 'Router WiFi 6 Mesh TP-Link', price: '149', currency: 'USD', sales30: '9,876', revenue: '$1.47M', region: 'MLC', image_url: '', sort_order: 31 },
      { title: 'Patineta Eléctrica Xiaomi', price: '399', currency: 'USD', sales30: '4,567', revenue: '$1.82M', region: 'MLB', image_url: '', sort_order: 32 },
      { title: 'Chaleco Térmico para Invierno', price: '79', currency: 'USD', sales30: '16,543', revenue: '$1.31M', region: 'MLB', image_url: '', sort_order: 33 },
      { title: 'Set de Maquillaje Profesional', price: '59', currency: 'USD', sales30: '18,765', revenue: '$1.11M', region: 'MLB', image_url: '', sort_order: 34 },
      { title: 'Kit de Herramientas Bosch 108 piezas', price: '129', currency: 'USD', sales30: '8,234', revenue: '$1.06M', region: 'MLB', image_url: '', sort_order: 35 },
      { title: 'Juego de Ollas Antiadherentes', price: '169', currency: 'USD', sales30: '7,432', revenue: '$1.26M', region: 'MLB', image_url: '', sort_order: 36 },
      { title: 'Auriculares Bluetooth AirPods Pro 2', price: '249', currency: 'USD', sales30: '14,567', revenue: '$3.63M', region: 'MLA', image_url: '', sort_order: 37 },
      { title: 'Smartband Xiaomi Mi Band 8', price: '49', currency: 'USD', sales30: '22,345', revenue: '$1.10M', region: 'MLA', image_url: '', sort_order: 38 },
      { title: 'Consola Nintendo Switch OLED', price: '349', currency: 'USD', sales30: '6,789', revenue: '$2.37M', region: 'MLA', image_url: '', sort_order: 39 },
      { title: 'Lente Sony 50mm f/1.8', price: '299', currency: 'USD', sales30: '3,456', revenue: '$1.03M', region: 'MLA', image_url: '', sort_order: 40 },
      { title: 'Mochila de Senderismo 40L', price: '89', currency: 'USD', sales30: '9,876', revenue: '$0.88M', region: 'MLA', image_url: '', sort_order: 41 },
      { title: 'Colchón Viscoelástico Queen', price: '399', currency: 'USD', sales30: '5,432', revenue: '$2.17M', region: 'MCO', image_url: '', sort_order: 42 },
      { title: 'Juego de Sabanas 1800 Hilos', price: '79', currency: 'USD', sales30: '11,234', revenue: '$0.89M', region: 'MCO', image_url: '', sort_order: 43 },
      { title: 'Tostadora Oster 4 Rebanadas', price: '59', currency: 'USD', sales30: '13,456', revenue: '$0.79M', region: 'MCO', image_url: '', sort_order: 44 },
      { title: 'Plancha de Vapor Philips', price: '69', currency: 'USD', sales30: '10,987', revenue: '$0.76M', region: 'MCO', image_url: '', sort_order: 45 },
      { title: 'Vaporizador Facial Profesional', price: '45', currency: 'USD', sales30: '19,876', revenue: '$0.89M', region: 'MCO', image_url: '', sort_order: 46 },
      { title: 'Tensiómetro Digital Omron', price: '49', currency: 'USD', sales30: '12,345', revenue: '$0.60M', region: 'MLM', image_url: '', sort_order: 47 },
      { title: 'Kit de Suplementos Gym Proteína', price: '59', currency: 'USD', sales30: '17,654', revenue: '$1.04M', region: 'MLM', image_url: '', sort_order: 48 },
      { title: 'Parrilla Eléctrica de Interior', price: '129', currency: 'USD', sales30: '8,234', revenue: '$1.06M', region: 'MLM', image_url: '', sort_order: 49 },
      { title: 'Bolso de Cuero Crossbody', price: '89', currency: 'USD', sales30: '14,321', revenue: '$1.27M', region: 'MLM', image_url: '', sort_order: 50 }
    ];
    for (const p of products) {
      const exist = await pool.query('SELECT id, image_url FROM hot_products WHERE title = $1', [p.title]);
      if (exist.rows.length > 0) {
        // 只补充图片，不覆盖管理员编辑的其他字段
        if (!exist.rows[0].image_url) {
          await pool.query('UPDATE hot_products SET image_url = $1 WHERE id = $2', [p.image_url || defaultImage, exist.rows[0].id]);
        }
      } else {
        await pool.query(
          'INSERT INTO hot_products (title, price, currency, sales30, revenue, region, image_url, sort_order, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)',
          [p.title, p.price, p.currency, p.sales30, p.revenue, p.region, p.image_url || defaultImage, p.sort_order]
        );
      }
    }
    console.log('[DB] ✅ 已更新热销商品图片与数据');

  // 热搜词：按周轮换，符合拉美市场热点
  const keywordsCount = await pool.query('SELECT COUNT(*) as count FROM hot_keywords');
  if (parseInt(keywordsCount.rows[0].count) === 0) {
    // 第1-4周，每周一套词，覆盖世界杯、季节、节日等拉美热点
    const weeklyKeywords = [
      // 第1周
      [
        { keyword: 'zapatillas deportivas', searchVol: '892,431', salesVol: '142,786', productCount: '38,421', trend: 15.3, region: 'MLM' },
        { keyword: 'samsung galaxy s24', searchVol: '756,210', salesVol: '98,342', productCount: '12,567', trend: 28.7, region: 'MLM' },
        { keyword: 'iphone 15 pro max', searchVol: '712,886', salesVol: '87,654', productCount: '8,923', trend: -5.2, region: 'MLM' },
        { keyword: 'smart tv 4k', searchVol: '654,327', salesVol: '123,456', productCount: '21,876', trend: 10.8, region: 'MLM' },
        { keyword: 'balón mundial 2026', searchVol: '589,432', salesVol: '167,890', productCount: '5,432', trend: 122.1, region: 'MLM' },
        { keyword: 'camiseta selección mexicana', searchVol: '523,176', salesVol: '89,234', productCount: '6,765', trend: 85.4, region: 'MLM' },
        { keyword: 'reloj inteligente', searchVol: '498,765', salesVol: '76,543', productCount: '14,321', trend: 18.9, region: 'MLM' },
        { keyword: 'cargador rápido usb-c', searchVol: '445,678', salesVol: '234,567', productCount: '32,109', trend: 8.2, region: 'MLM' },
        { keyword: 'televisor 55 pulgadas', searchVol: '412,345', salesVol: '65,432', productCount: '11,098', trend: -2.1, region: 'MLM' },
        { keyword: 'laptop para gaming', searchVol: '387,654', salesVol: '54,321', productCount: '9,876', trend: 12.5, region: 'MLM' }
      ],
      // 第2周
      [
        { keyword: 'tênis de futebol', searchVol: '934,521', salesVol: '156,432', productCount: '42,109', trend: 18.7, region: 'MLB' },
        { keyword: 'copo do mundo 2026', searchVol: '812,345', salesVol: '134,567', productCount: '8,234', trend: 135.6, region: 'MLB' },
        { keyword: 'camisa brasil seleção', searchVol: '678,901', salesVol: '112,345', productCount: '9,876', trend: 98.2, region: 'MLB' },
        { keyword: 'iphone 15 pro max', searchVol: '645,231', salesVol: '91,234', productCount: '10,567', trend: 6.5, region: 'MLB' },
        { keyword: 'smart tv 4k samsung', searchVol: '598,765', salesVol: '87,654', productCount: '25,432', trend: 11.3, region: 'MLB' },
        { keyword: 'air fryer', searchVol: '487,654', salesVol: '145,678', productCount: '28,765', trend: 22.1, region: 'MLB' },
        { keyword: 'relogio smartwatch', searchVol: '456,789', salesVol: '78,901', productCount: '16,543', trend: 15.8, region: 'MLB' },
        { keyword: 'notebook gamer', searchVol: '398,765', salesVol: '54,321', productCount: '11,234', trend: 9.4, region: 'MLB' },
        { keyword: 'mochila antifurto', searchVol: '345,678', salesVol: '67,890', productCount: '13,456', trend: 31.2, region: 'MLB' },
        { keyword: 'fone bluetooth', searchVol: '312,456', salesVol: '98,765', productCount: '22,109', trend: 14.6, region: 'MLB' }
      ],
      // 第3周
      [
        { keyword: 'zapatillas running', searchVol: '823,456', salesVol: '128,765', productCount: '35,678', trend: 22.4, region: 'MLC' },
        { keyword: 'camiseta selección chilena', searchVol: '745,678', salesVol: '103,456', productCount: '7,654', trend: 76.5, region: 'MLC' },
        { keyword: 'iphone 15 pro max', searchVol: '687,234', salesVol: '82,345', productCount: '9,012', trend: 4.8, region: 'MLC' },
        { keyword: 'smart tv 50 pulgadas', searchVol: '612,345', salesVol: '71,234', productCount: '18,765', trend: 13.2, region: 'MLC' },
        { keyword: 'audífonos inalámbricos', searchVol: '534,678', salesVol: '156,789', productCount: '24,321', trend: 19.7, region: 'MLC' },
        { keyword: 'cafetera espresso', searchVol: '456,789', salesVol: '67,890', productCount: '12,456', trend: 28.3, region: 'MLC' },
        { keyword: 'tablet samsung', searchVol: '398,234', salesVol: '45,678', productCount: '8,234', trend: 16.5, region: 'MLC' },
        { keyword: 'mochila escolar', searchVol: '345,678', salesVol: '89,012', productCount: '15,678', trend: 35.1, region: 'MLC' },
        { keyword: 'reloj inteligente', searchVol: '312,456', salesVol: '54,321', productCount: '11,234', trend: 12.8, region: 'MLC' },
        { keyword: 'laptop para trabajar', searchVol: '287,654', salesVol: '32,109', productCount: '6,543', trend: 7.9, region: 'MLC' }
      ],
      // 第4周
      [
        { keyword: 'zapatillas deportivas', searchVol: '856,234', salesVol: '134,567', productCount: '36,789', trend: 17.6, region: 'MLA' },
        { keyword: 'camiseta selección argentina', searchVol: '778,901', salesVol: '145,678', productCount: '8,234', trend: 88.3, region: 'MLA' },
        { keyword: 'balón mundial 2026', searchVol: '689,234', salesVol: '98,765', productCount: '4,567', trend: 115.7, region: 'MLA' },
        { keyword: 'iphone 15 pro max', searchVol: '612,345', salesVol: '76,543', productCount: '8,901', trend: -3.2, region: 'MLA' },
        { keyword: 'smart tv android', searchVol: '545,678', salesVol: '89,012', productCount: '19,234', trend: 14.5, region: 'MLA' },
        { keyword: 'auriculares bluetooth', searchVol: '478,901', salesVol: '165,432', productCount: '26,543', trend: 21.3, region: 'MLA' },
        { keyword: 'aire acondicionado portátil', searchVol: '423,456', salesVol: '78,901', productCount: '9,876', trend: 45.2, region: 'MLA' },
        { keyword: 'reloj smartwatch', searchVol: '367,890', salesVol: '61,234', productCount: '13,456', trend: 11.7, region: 'MLA' },
        { keyword: 'mochila antirrobo', searchVol: '334,567', salesVol: '82,345', productCount: '14,567', trend: 29.8, region: 'MLA' },
        { keyword: 'notebook student', searchVol: '298,765', salesVol: '41,234', productCount: '7,890', trend: 8.6, region: 'MLA' }
      ],
      // 第5周
      [
        { keyword: 'colchón ortopédico', searchVol: '456,789', salesVol: '67,890', productCount: '12,345', trend: 23.5, region: 'MCO' },
        { keyword: 'silla gamer', searchVol: '412,345', salesVol: '54,321', productCount: '8,234', trend: 18.2, region: 'MCO' },
        { keyword: 'batidora de mano', searchVol: '387,654', salesVol: '76,543', productCount: '15,678', trend: 14.8, region: 'MCO' },
        { keyword: 'parrilla eléctrica', searchVol: '345,678', salesVol: '43,210', productCount: '6,543', trend: 31.6, region: 'MCO' },
        { keyword: 'tostadora eléctrica', searchVol: '312,456', salesVol: '38,765', productCount: '9,012', trend: 12.4, region: 'MCO' },
        { keyword: 'aspiradora sin cable', searchVol: '289,765', salesVol: '51,234', productCount: '10,567', trend: 27.9, region: 'MLM' },
        { keyword: 'termo eléctrico', searchVol: '265,432', salesVol: '47,890', productCount: '7,234', trend: 19.3, region: 'MLM' },
        { keyword: 'plancha de ropa', searchVol: '243,109', salesVol: '35,678', productCount: '8,901', trend: 8.7, region: 'MLM' },
        { keyword: 'set de maquillaje', searchVol: '221,876', salesVol: '62,345', productCount: '13,456', trend: 16.5, region: 'MLM' },
        { keyword: 'cámara de seguridad', searchVol: '198,765', salesVol: '28,901', productCount: '5,678', trend: 33.2, region: 'MLM' }
      ]
    ];

    for (let week = 0; week < weeklyKeywords.length; week++) {
      for (const k of weeklyKeywords[week]) {
        await pool.query(
          'INSERT INTO hot_keywords (keyword, search_vol, sales_vol, product_count, trend, region, week_index, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)',
          [k.keyword, k.searchVol, k.salesVol, k.productCount, k.trend, k.region, week]
        );
      }
    }
    console.log('[DB] ✅ 已初始化热搜词数据（按周轮换）');
  }
}

// 生成基于日期的 Dashboard 顶部统计数据（每日更新）
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function formatPercent(val) {
  const prefix = val >= 0 ? '+' : '';
  return prefix + val.toFixed(1) + '%';
}

async function seedDashboardStats() {
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await pool.query('SELECT * FROM dashboard_stats WHERE stat_date = $1', [today]);
  if (rows.length > 0) return;

  const dateSeed = parseInt(today.replace(/-/g, ''));
  const rand = seededRandom(dateSeed);

  const baseTotal = 228000000 + Math.round(rand() * 2000000);
  const baseActive = 19000000 + Math.round(rand() * 1000000);
  const baseSold = 62000000 + Math.round(rand() * 5000000);
  const baseRevenue = 1700000000 + Math.round(rand() * 100000000);

  const activeRate = (baseActive / baseTotal * 100).toFixed(2);
  const soldMom = (rand() * 30 - 5).toFixed(1); // -5% ~ +25%
  const revenueMom = (rand() * 25 - 3).toFixed(1); // -3% ~ +22%

  await pool.query(
    `INSERT INTO dashboard_stats (stat_date, total_products, active_products, active_rate, total_sold30, sold_mom, total_revenue30, revenue_mom)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (stat_date) DO NOTHING`,
    [today, baseTotal, baseActive, activeRate + '%', baseSold, soldMom + '%', baseRevenue, revenueMom + '%']
  );
  console.log('[DB] ✅ 已初始化今日 Dashboard 统计数据');
}

// ========== 中间件 ==========
app.use(express.json({ limit: '10mb' }));

// 强制关闭所有缓存
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// 自定义静态资源路由（绕过 CDN 缓存，直接读磁盘）
const fs = require('fs')
app.get('/assets/:file', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'assets', req.params.file)
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Not found: ' + req.params.file)
  }
  const ext = path.extname(req.params.file).toLowerCase()
  const mimeMap = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }
  res.set('Content-Type', mimeMap[ext] || 'application/octet-stream')
  res.sendFile(filePath)
})
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=UTF-8')
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})
// express.static 作为 fallback
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }))

// 管理后台 /mgmt 页面（直接读磁盘，避开 CDN）
app.get('/mgmt', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'admin', 'index.html')
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('admin page not found')
  }
  res.set('Content-Type', 'text/html; charset=UTF-8')
  res.sendFile(filePath)
})

// ========== Token 认证系统（使用数据库持久化，部署不会踢人） ==========
// 不再使用单设备登录踢下线机制

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isUserExpired(user) {
  if (!user) return false;
  const validUntil = user.validuntil || user.validUntil;
  if (!validUntil) return false;
  const end = new Date(validUntil);
  if (isNaN(end.getTime())) return false;
  // validUntil 在数据库中存储为 UTC 日期（如 2026-07-09T00:00:00.000Z）
  // 管理员在 GMT+8 时区操作，期望用户用到当天结束（北京时区）
  // 北京 7月9日 23:59:59 = UTC 7月9日 15:59:59
  // 所以从 UTC 午夜加 15小时59分59秒即为北京时区的当天结束
  const expireTime = end.getTime() + 15 * 3600 * 1000 + 59 * 60 * 1000 + 59 * 1000 + 999;
  return Date.now() > expireTime;
}

async function getAuthUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const { rows } = await pool.query(
    "SELECT username, role, validuntil, created_at FROM user_sessions WHERE token = $1 AND created_at >= NOW() - ($2 * INTERVAL '1 day')",
    [token, SESSION_MAX_AGE_DAYS]
  );
  if (rows.length === 0) return null;
  return { username: rows[0].username, role: rows[0].role, validUntil: rows[0].validuntil };
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ code: 401, message: '未登录或登录已过期' });

  const { rows } = await pool.query(
    "SELECT username, role, validuntil, created_at FROM user_sessions WHERE token = $1 AND created_at >= NOW() - ($2 * INTERVAL '1 day')",
    [token, SESSION_MAX_AGE_DAYS]
  );
  if (rows.length === 0) return res.status(401).json({ code: 401, message: '未登录或登录已过期' });

  const user = { username: rows[0].username, role: rows[0].role, validUntil: rows[0].validuntil };

  // 检查账号是否到期
  if (isUserExpired(user)) {
    await pool.query('DELETE FROM user_sessions WHERE token = $1', [token]);
    return res.status(403).json({ code: 403, message: '账号已到期，请联系管理员' });
  }

  req.authUser = user;
  req.currentToken = token;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.authUser.role !== 'admin') {
      return res.status(403).json({ code: 403, message: '需要管理员权限' });
    }
    next();
  });
}

function requireSyncKey(req, res, next) {
  if (!SYNC_API_KEY) {
    return res.status(503).json({ code: 503, message: '同步服务未配置' });
  }
  const provided = req.headers['x-sync-key'];
  if (typeof provided !== 'string') {
    return res.status(401).json({ code: 401, message: '同步认证失败' });
  }
  const expectedBuffer = Buffer.from(SYNC_API_KEY);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return res.status(401).json({ code: 401, message: '同步认证失败' });
  }
  next();
}

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const previous = loginAttempts.get(key);
  const attempt = !previous || now >= previous.resetAt
    ? { count: 0, resetAt: now + 15 * 60 * 1000 }
    : previous;
  attempt.count += 1;
  loginAttempts.set(key, attempt);
  if (attempt.count > 20) {
    return res.status(429).json({ code: 429, message: '登录尝试过多，请稍后再试' });
  }
  next();
}

// 管理后台 /mgmt 路由（已在前面自定义处理，直接读磁盘）

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

app.get('/api/users', requireAdmin, async (req, res) => {
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

app.post('/api/users', requireAdmin, async (req, res) => {
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

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
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

app.put('/api/users/:id', requireAdmin, async (req, res) => {
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
app.post('/api/verify-login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (rows.length === 0) return res.json(jsonFail('账号或密码不正确，请重试'));

    const user = rows[0];
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.json(jsonFail('账号或密码不正确，请重试'));

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
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json(jsonFail('请输入用户名和密码'));

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (rows.length === 0) return res.json({ code: 401, message: '账号或密码不正确，请重试' });

    const user = rows[0];
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.json({ code: 401, message: '账号或密码不正确，请重试' });

    // 检查账号是否到期
    if (isUserExpired(user)) {
      return res.json({ code: 403, message: '账号已到期，请联系管理员' });
    }

    const token = generateToken();
    // 持久化到数据库（部署不踢人）
    await pool.query(
      'INSERT INTO user_sessions (token, username, role, validuntil) VALUES ($1, $2, $3, $4)',
      [token, user.username, user.role, user.validuntil || null]
    );
    loginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');

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
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    await pool.query('DELETE FROM user_sessions WHERE token = $1', [token]);
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

app.get('/api/ads', requireAdmin, async (req, res) => {
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

app.post('/api/ads', requireAdmin, async (req, res) => {
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

app.put('/api/ads/:id', requireAdmin, async (req, res) => {
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

app.delete('/api/ads/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query('DELETE FROM ads WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.json(jsonFail('广告不存在'));
    res.json(jsonOk(null, '广告已删除'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// 代理开户规则
app.get('/api/admin/agent/rule', requireAuth, async (req, res) => {
  if (req.authUser.role !== 'agent' && req.authUser.role !== 'admin') {
    return res.json(jsonFail('无权操作'));
  }
  const limit = getAgentMaxValidUntil(req.authUser.username);
  res.json(jsonOk(limit));
});

// ========== 管理后台 API（需要登录） ==========

// 用户管理
app.post('/api/admin/users', requireAdmin, async (req, res) => {
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
    console.error('[Admin] 添加用户失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.delete('/api/admin/users/:username', requireAuth, async (req, res) => {
  const username = req.params.username;
  if (username === 'admin') return res.json(jsonFail('不能删除默认管理员'));

  const authUser = req.authUser;

  try {
    if (authUser.role === 'admin') {
      // 管理员可以删除任何用户
      const result = await pool.query('DELETE FROM users WHERE username = $1', [username]);
      if (result.rowCount === 0) return res.json(jsonFail('用户不存在'));
      return res.json(jsonOk(null, '用户已删除'));
    } else if (authUser.role === 'agent') {
      // 代理只能删除自己开的用户
      const result = await pool.query(
        'DELETE FROM users WHERE username = $1 AND created_by = $2',
        [username, authUser.username]
      );
      if (result.rowCount === 0) return res.json(jsonFail('无权删除该用户或用户不存在'));
      return res.json(jsonOk(null, '用户已删除'));
    } else {
      return res.json(jsonFail('无权操作'));
    }
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// 管理员编辑用户信息
app.put('/api/admin/users/:username', requireAdmin, async (req, res) => {
  if (req.authUser.role !== 'admin') return res.json(jsonFail('仅管理员可编辑用户'));

  const username = req.params.username;
  const { password, nickname, role, validUntil } = req.body;

  try {
    const user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
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
      params.push(username);
      const result = await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE username = $${idx}`, params);
      if (result.rowCount === 0) return res.json(jsonFail('用户不存在'));
    }
    res.json(jsonOk(null, '用户已更新'));
  } catch (e) {
    console.error('[Admin] 编辑用户失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// ========== 代理/管理员 客户开户接口 ==========

// 计算代理可开设的最大有效期
function getAgentMaxValidUntil(agentUsername = '') {
  const now = new Date();
  // CNTORO 代理仅允许开通最长 3 天体验账号。
  if (String(agentUsername).trim().toUpperCase() === 'CNTORO') {
    const maxDays = 3;
    const maxDate = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);
    return { maxDays, maxDate, rule: 'CNTORO 代理体验账号最长可开通3天' };
  }
  const aug1 = new Date(2026, 7, 1); // 2026-08-01 00:00 GMT+8
  // 当前北京时间
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingTime = now.getTime() + beijingOffset;
  const aug1Time = aug1.getTime();

  if (beijingTime < aug1Time) {
    // 7月底前：最多14天
    const maxDays = 14;
    const maxDate = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);
    return { maxDays, maxDate, rule: '7月优惠期，最长可开14天' };
  } else {
    // 8月起：最多1天
    const maxDays = 1;
    const maxDate = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);
    return { maxDays, maxDate, rule: '8月起，最长可开1天' };
  }
}

// 代理/管理员开户接口（软件端调用）
app.post('/api/admin/agent/user', requireAuth, async (req, res) => {
  // 仅允许 agent 和 admin 角色
  if (req.authUser.role !== 'agent' && req.authUser.role !== 'admin') {
    return res.json(jsonFail('无权操作'));
  }

  const { username, password, nickname, validUntil } = req.body;
  if (!username || !password) return res.json(jsonFail('用户名和密码不能为空'));

  const authUser = req.authUser;

  if (authUser.role === 'agent') {
    const limit = getAgentMaxValidUntil(authUser.username);
    let finalValidUntil = validUntil ? new Date(validUntil) : new Date(Date.now() + limit.maxDays * 24 * 60 * 60 * 1000);

    if (finalValidUntil.getTime() > limit.maxDate.getTime()) {
      finalValidUntil = limit.maxDate;
    }
    const minDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (finalValidUntil.getTime() < minDate.getTime()) {
      finalValidUntil = minDate;
    }

    try {
      const exist = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (exist.rows.length > 0) return res.json(jsonFail('用户名已存在'));
      const hash = bcrypt.hashSync(password, SALT_ROUNDS);
      const result = await pool.query(
        'INSERT INTO users (username, password, nickname, role, validUntil, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [username, hash, nickname || '', 'user', finalValidUntil, authUser.username]
      );
      res.json(jsonOk({
        id: result.rows[0].id,
        validUntil: finalValidUntil.toISOString(),
        rule: limit.rule
      }, '开户成功'));
    } catch (e) {
      console.error('[Agent] 开户失败:', e.message);
      res.status(500).json(jsonFail('数据库错误'));
    }
  } else {
    // admin 不受限制
    try {
      const exist = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (exist.rows.length > 0) return res.json(jsonFail('用户名已存在'));
      const hash = bcrypt.hashSync(password, SALT_ROUNDS);
      const result = await pool.query(
        'INSERT INTO users (username, password, nickname, role, validUntil, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [username, hash, nickname || '', 'user', validUntil ? new Date(validUntil) : null, authUser.username]
      );
      res.json(jsonOk({ id: result.rows[0].id }, '用户添加成功'));
    } catch (e) {
      console.error('[Agent] 添加用户失败:', e.message);
      res.status(500).json(jsonFail('数据库错误'));
    }
  }
});

// 代理获取自己开通的用户列表
app.get('/api/admin/agent/users', requireAuth, async (req, res) => {
  if (req.authUser.role !== 'agent' && req.authUser.role !== 'admin') {
    return res.json(jsonFail('无权操作'));
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, username, nickname, role, validUntil, created_by, created_at FROM users WHERE created_by = $1 ORDER BY id",
      [req.authUser.username]
    );
    const list = rows.map(u => ({
      id: u.id, username: u.username, nickname: u.nickname,
      role: u.role, validUntil: u.validuntil || null,
      createdBy: u.created_by || null,
      created_at: u.created_at ? new Date(u.created_at).toISOString() : ''
    }));
    res.json(jsonOk(list));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// 管理员获取所有用户（含 created_by）
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  if (req.authUser.role !== 'admin') {
    return res.json(jsonFail('仅管理员可查看全部用户'));
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, nickname, role, validUntil, created_by, created_at FROM users ORDER BY id'
    );
    const list = rows.map(u => ({
      id: u.id, username: u.username, nickname: u.nickname,
      role: u.role, validUntil: u.validuntil || null,
      createdBy: u.created_by || null,
      created_at: u.created_at ? new Date(u.created_at).toISOString() : ''
    }));
    res.json(jsonOk(list));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// 广告管理
app.get('/api/admin/ads', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ads ORDER BY id');
    const list = rows.map(a => ({
      id: a.id, title: a.title, content: a.content || '',
      imageUrl: a.imageurl || '', linkUrl: a.linkurl || '',
      enabled: a.enabled === 1, popup: a.ispopup === 1, banner: a.isbanner === 1,
      created_at: a.created_at ? new Date(a.created_at).toISOString() : ''
    }));
    res.json(jsonOk(list));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.post('/api/admin/ads', requireAdmin, async (req, res) => {
  const { title, content, imageUrl, linkUrl, enabled, popup } = req.body;
  if (!title) return res.json(jsonFail('广告标题不能为空'));
  try {
    const result = await pool.query(
      'INSERT INTO ads (title, content, imageUrl, linkUrl, enabled, isPopup, isBanner) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [title, content || '', imageUrl || '', linkUrl || '', enabled !== false ? 1 : 0, popup ? 1 : 0, 0]
    );
    res.json(jsonOk({ id: result.rows[0].id }, '广告添加成功'));
  } catch (e) {
    console.error('[Admin] 添加广告失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.put('/api/admin/ads/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, content, imageUrl, linkUrl, enabled, popup } = req.body;
  try {
    const updates = [];
    const params = [];
    let idx = 1;
    if (title !== undefined) { updates.push(`title = $${idx++}`); params.push(title); }
    if (content !== undefined) { updates.push(`content = $${idx++}`); params.push(content); }
    if (imageUrl !== undefined) { updates.push(`imageUrl = $${idx++}`); params.push(imageUrl); }
    if (linkUrl !== undefined) { updates.push(`linkUrl = $${idx++}`); params.push(linkUrl); }
    if (enabled !== undefined) { updates.push(`enabled = $${idx++}`); params.push(enabled !== false ? 1 : 0); }
    if (popup !== undefined) { updates.push(`isPopup = $${idx++}`); params.push(popup ? 1 : 0); }
    if (updates.length === 0) return res.json(jsonOk(null, '无更新'));
    params.push(id);
    const result = await pool.query(`UPDATE ads SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    if (result.rowCount === 0) return res.json(jsonFail('广告不存在'));
    res.json(jsonOk(null, '广告已更新'));
  } catch (e) {
    console.error('[Admin] 更新广告失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.delete('/api/admin/ads/:id', requireAdmin, async (req, res) => {
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
    const { rows } = await pool.query(
      'SELECT key, value FROM settings WHERE key = ANY($1::text[])',
      [Array.from(PUBLIC_SETTING_KEYS)]
    );
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json(jsonOk(data));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings ORDER BY key');
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json(jsonOk(data));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
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
app.get('/api/sync', requireSyncKey, async (req, res) => {
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

// ========== 搜索缓存（降低 meikeduoshuju WAF 命中率） ==========
const searchCache = new Map();
const SEARCH_CACHE_MAX_ENTRIES = 200;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of searchCache) {
    if (now - val.time > CACHE_TTL) searchCache.delete(key);
  }
  while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) searchCache.delete(searchCache.keys().next().value);
}, 60000); // 每分钟清理一次过期缓存

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

    // 生成缓存 key：使用全部过滤参数（避免改筛选条件还返回旧数据）
    const cacheKey = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('|')
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      return res.json(cached.data);
    }

    const response = await axios.get('https://api.meikeduoshuju.com/api/v1/goods/search', {
      params, timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://meikeduoshuju.com',
        'Referer': 'https://meikeduoshuju.com/'
      }
    });
    // 检测是否为 HTML 反爬页面（WAF 拦截）
    const body = response.data;
    if (typeof body === 'string' && body.trim().startsWith('<')) {
      console.error('[Search] meikeduoshuju API 返回了 HTML 反爬页面');
      return res.status(502).json({ code: 502, message: '上游 API 访问被拦截，建议使用桌面客户端操作' });
    }
    // 缓存成功响应
    searchCache.set(cacheKey, { data: response.data, time: Date.now() });
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

// ========== Mercado Libre OAuth 认证 ==========
const ML_CLIENT_ID = process.env.ML_CLIENT_ID || '';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || '';
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || 'https://mercado-cloud-admin-production.up.railway.app/api/ml/oauth/callback';
const ERP_CREDENTIAL_KEY = process.env.ERP_CREDENTIAL_KEY || ML_CLIENT_SECRET || SYNC_API_KEY;

function encryptErpCredential(value) {
  if (!value) return '';
  if (!ERP_CREDENTIAL_KEY) throw new Error('服务器尚未配置 ERP_CREDENTIAL_KEY');
  const key = crypto.createHash('sha256').update(ERP_CREDENTIAL_KEY).digest();
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptErpCredential(value) {
  if (!value) return '';
  if (!ERP_CREDENTIAL_KEY) throw new Error('服务器尚未配置 ERP_CREDENTIAL_KEY');
  const [version, iv, tag, encrypted] = String(value).split(':');
  if (version !== 'v1') throw new Error('ERP凭据格式不受支持');
  const key = crypto.createHash('sha256').update(ERP_CREDENTIAL_KEY).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

// 从数据库获取 refresh_token
async function getMLRefreshToken() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'ml_refresh_token'");
  return rows.length > 0 ? rows[0].value : null;
}

// 保存 refresh_token 到数据库
async function setMLRefreshToken(token) {
  await pool.query(
    "INSERT INTO settings (key, value, updated_at) VALUES ('ml_refresh_token', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
    [token]
  );
}

// 获取有效的 access_token（自动刷新）
async function getMLAccessToken() {
  const refreshToken = await getMLRefreshToken();
  if (!refreshToken) return null;

  // 尝试从缓存获取
  const expiresAtRow = await pool.query("SELECT value FROM settings WHERE key = 'ml_token_expires_at'");
  const cached = await pool.query("SELECT value FROM settings WHERE key = 'ml_access_token'");

  if (cached.rows.length > 0 && expiresAtRow.rows.length > 0) {
    const expiresAt = parseInt(expiresAtRow.rows[0].value);
    if (Date.now() < expiresAt) return cached.rows[0].value; // 还没过期
  }

  // 过期了，用 refresh_token 换新的
  try {
    const resp = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'refresh_token',
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        refresh_token: refreshToken
      },
      timeout: 15000
    });
    const data = resp.data;
    // 保存新的 access_token + 过期时间
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('ml_access_token', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [data.access_token]
    );
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('ml_token_expires_at', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [(Date.now() + data.expires_in * 1000 - 60000).toString()] // 提前1分钟过期
    );
    // 保存新的 refresh_token（ML 每次刷新都会给新的）
    if (data.refresh_token) await setMLRefreshToken(data.refresh_token);
    if (data.user_id) await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('ml_user_id', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [String(data.user_id)]
    );
    return data.access_token;
  } catch (e) {
    console.error('[ML] Token刷新失败:', e.response?.data || e.message);
    return null;
  }
}

async function saveStoreAuthorization(ownerUsername, tokenData) {
  const accessToken = String(tokenData.access_token || '');
  const refreshToken = String(tokenData.refresh_token || '');
  if (!ownerUsername || !accessToken) throw new Error('店铺授权数据不完整');
  const account = await axios.get('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000
  });
  const me = account.data || {};
  const mlUserId = String(tokenData.user_id || me.id || '');
  if (!mlUserId) throw new Error('无法识别授权店铺');
  await pool.query(`INSERT INTO ml_store_authorizations
    (owner_username,ml_user_id,nickname,site_id,access_token_encrypted,refresh_token_encrypted,expires_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT(owner_username,ml_user_id) DO UPDATE SET
      nickname=EXCLUDED.nickname,site_id=EXCLUDED.site_id,
      access_token_encrypted=EXCLUDED.access_token_encrypted,
      refresh_token_encrypted=CASE WHEN EXCLUDED.refresh_token_encrypted<>'' THEN EXCLUDED.refresh_token_encrypted ELSE ml_store_authorizations.refresh_token_encrypted END,
      expires_at=EXCLUDED.expires_at,enabled=TRUE,updated_at=NOW()`, [
    ownerUsername, mlUserId, me.nickname || '', me.site_id || '',
    encryptErpCredential(accessToken), refreshToken ? encryptErpCredential(refreshToken) : '',
    Date.now() + Number(tokenData.expires_in || 21600) * 1000 - 60000
  ]);
  await pool.query(`INSERT INTO ml_stores(ml_user_id,owner_username,nickname,site_id,updated_at) VALUES($1,$2,$3,$4,NOW())
    ON CONFLICT(ml_user_id) DO UPDATE SET owner_username=EXCLUDED.owner_username,nickname=EXCLUDED.nickname,site_id=EXCLUDED.site_id,updated_at=NOW()`,
    [mlUserId, ownerUsername, me.nickname || '', me.site_id || '']);
  await pool.query('UPDATE ml_orders SET owner_username=$1 WHERE store_user_id=$2 AND owner_username IS NULL',[ownerUsername,mlUserId]);
  await pool.query(`UPDATE order_alerts a SET owner_username=$1 FROM ml_orders o WHERE a.order_id=o.ml_order_id AND o.store_user_id=$2 AND a.owner_username IS NULL`,[ownerUsername,mlUserId]);
  return { mlUserId, nickname: me.nickname || '', siteId: me.site_id || '' };
}

async function getStoreAuthorizationToken(row) {
  if (!row) return null;
  if (Number(row.expires_at || 0) > Date.now()) return decryptErpCredential(row.access_token_encrypted);
  const refreshToken = decryptErpCredential(row.refresh_token_encrypted || '');
  if (!refreshToken) return null;
  const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
    params: { grant_type: 'refresh_token', client_id: ML_CLIENT_ID, client_secret: ML_CLIENT_SECRET, refresh_token: refreshToken },
    timeout: 15000
  });
  await saveStoreAuthorization(row.owner_username, response.data || {});
  return response.data?.access_token || null;
}

async function findScopedStoreAuthorization(authUser, storeUserId) {
  const params = [String(storeUserId), authUser.username];
  const where = 'ml_user_id=$1 AND owner_username=$2 AND enabled=TRUE';
  const { rows } = await pool.query(`SELECT * FROM ml_store_authorizations WHERE ${where} ORDER BY updated_at DESC LIMIT 1`, params);
  return rows[0] || null;
}

async function listOrderStoreAuthorizations(authUser, requestedStoreId = '') {
  const params = [authUser.username], where = ['owner_username=$1', 'enabled=TRUE'];
  if (requestedStoreId) { params.push(String(requestedStoreId)); where.push(`ml_user_id=$${params.length}`); }
  let { rows } = await pool.query(`SELECT * FROM ml_store_authorizations WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params);

  // 兼容升级前仅保存于 settings 的管理员授权。首次使用时迁入用户隔离授权表。
  if (!rows.length && authUser.role === 'admin' && !requestedStoreId) {
    const legacyToken = await getMLAccessToken();
    if (legacyToken) {
      const legacyRefreshToken = await getMLRefreshToken();
      const account = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${legacyToken}` }, timeout: 15000
      });
      const me = account.data || {};
      await saveStoreAuthorization(authUser.username, {
        access_token: legacyToken,
        refresh_token: legacyRefreshToken || '',
        user_id: me.id,
        expires_in: 3600
      });
      ({ rows } = await pool.query(`SELECT * FROM ml_store_authorizations WHERE owner_username=$1 AND enabled=TRUE ORDER BY updated_at DESC`, [authUser.username]));
    }
  }
  return rows;
}

async function getOrderStoreContext(authUser, storeUserId) {
  const authorization = await findScopedStoreAuthorization(authUser, storeUserId);
  if (!authorization) return null;
  const token = await getStoreAuthorizationToken(authorization);
  if (!token) return null;
  return { authorization, token, sellerId: String(authorization.ml_user_id) };
}

async function resolveOrderStoreContext(authUser, requestedStoreId = '') {
  if (requestedStoreId) return getOrderStoreContext(authUser, requestedStoreId);
  const authorizations = await listOrderStoreAuthorizations(authUser);
  if (!authorizations.length) return null;
  return getOrderStoreContext(authUser, authorizations[0].ml_user_id);
}

async function getOrderMarketplaceSellerIds(ownerUsername, storeUserId) {
  const { rows } = await pool.query(`SELECT DISTINCT COALESCE(NULLIF(raw_data->'seller'->>'id',''),store_user_id) AS id
    FROM ml_orders WHERE owner_username=$1 AND store_user_id=$2 LIMIT 20`,[ownerUsername,String(storeUserId)]);
  return [...new Set([String(storeUserId),...rows.map(row=>String(row.id || '')).filter(Boolean)])];
}

app.post('/api/marketing/oauth-link', requireAuth, async (req, res) => {
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) return res.status(503).json({ code: 503, message: 'Mercado Libre OAuth 尚未配置' });
  const state = crypto.randomBytes(32).toString('hex');
  await pool.query('DELETE FROM ml_oauth_states WHERE expires_at<NOW()');
  await pool.query('INSERT INTO ml_oauth_states(state,owner_username,expires_at) VALUES($1,$2,NOW()+INTERVAL \'10 minutes\')', [state, req.authUser.username]);
  const url = 'https://global-selling.mercadolibre.com/authorization' +
    `?response_type=code&client_id=${encodeURIComponent(ML_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(ML_REDIRECT_URI)}&state=${encodeURIComponent(state)}`;
  res.json({ code: 0, data: { url } });
});

// OAuth 第一步：跳转到 ML 授权页
app.get('/api/ml/oauth/start', (req, res) => {
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) {
    return res.status(503).json({ code: 503, message: 'Mercado Libre OAuth 尚未配置' });
  }
  const authUrl = 'https://global-selling.mercadolibre.com/authorization' +
    '?response_type=code' +
    '&client_id=' + ML_CLIENT_ID +
    '&redirect_uri=' + encodeURIComponent(ML_REDIRECT_URI);
  res.redirect(authUrl);
});

// OAuth 回调：ML 授权后跳回这里
app.get('/api/ml/oauth/callback', async (req, res) => {
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) {
    return res.status(503).send('Mercado Libre OAuth 尚未配置');
  }
  const code = req.query.code;
  if (!code) return res.status(400).send('缺少授权码');

  try {
    const resp = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code: code,
        redirect_uri: ML_REDIRECT_URI
      },
      timeout: 15000
    });
    const data = resp.data;
    // 保存 token
    await setMLRefreshToken(data.refresh_token);
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('ml_access_token', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [data.access_token]
    );
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('ml_token_expires_at', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [(Date.now() + data.expires_in * 1000 - 60000).toString()]
    );
    if (data.user_id) await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('ml_user_id', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [String(data.user_id)]
    );

    let scopedStore = null;
    if (req.query.state) {
      const stateResult = await pool.query(
        'DELETE FROM ml_oauth_states WHERE state=$1 AND expires_at>NOW() RETURNING owner_username',
        [String(req.query.state)]
      );
      if (stateResult.rows[0]) scopedStore = await saveStoreAuthorization(stateResult.rows[0].owner_username, data);
    }

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:80px">
        <h2 style="color:#00a650">✅ Mercado Libre 授权成功！</h2>
        <p>${scopedStore ? `店铺 ${scopedStore.nickname || scopedStore.mlUserId} 已绑定到商品管理。` : '选品工具已可以正常使用，你可以关闭此页面了。'}</p>
        <p><small>Refresh Token 已保存，6个月内无需再次授权。</small></p>
      </body></html>
    `);
  } catch (e) {
    console.error('[ML] 授权回调失败:', e.response?.data || e.message);
    res.status(500).send('授权失败：' + JSON.stringify(e.response?.data || e.message));
  }
});

// ML 类目树
app.get('/api/ml/categories', async (req, res) => {
  try {
    const accessToken = await getMLAccessToken();
    if (!accessToken) return res.json({ code: 401, message: '未授权', oauthUrl: '/api/ml/oauth/start' });

    const site = req.query.site || 'MLM';
    const response = await axios.get(`https://api.mercadolibre.com/sites/${site}/categories`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000
    });
    res.json({ code: 0, data: response.data });
  } catch (e) {
    res.json({ code: 500, message: e.response?.data?.message || e.message });
  }
});

// ML 类目下的商品（畅销榜）
app.get('/api/ml/category-items', async (req, res) => {
  try {
    const accessToken = await getMLAccessToken();
    if (!accessToken) return res.json({ code: 401, message: '未授权', oauthUrl: '/api/ml/oauth/start' });

    const site = req.query.site || 'MLM';
    const categoryId = req.query.category;
    if (!categoryId) return res.json({ code: 400, message: '缺少 category 参数' });

    const response = await axios.get(`https://api.mercadolibre.com/highlights/${site}/category/${categoryId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000
    });

    // highlights 只返回 item ID 列表，需要批量获取详情
    const items = response.data?.content || [];
    const itemIds = items.filter(i => i.type === 'PRODUCT').map(i => i.id).slice(0, 20);

    // 批量获取商品详情（multi-get 接口）
    let itemsDetail = [];
    if (itemIds.length > 0) {
      try {
        const multiGet = await axios.get(`https://api.mercadolibre.com/items?ids=${itemIds.join(',')}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000
        });
        itemsDetail = (multiGet.data || []).map(d => {
          if (d.code !== 200) return null;
          const r = d.body;
          return {
            id: r.id,
            title: r.title,
            price: r.price,
            currency: r.currency_id,
            soldQuantity: r.sold_quantity || 0,
            availableQuantity: r.available_quantity || 0,
            condition: r.condition,
            categoryId: r.category_id,
            sellerId: r.seller_id,
            link: r.permalink,
            thumbnail: r.thumbnail,
            freeShipping: r.shipping?.free_shipping || false,
            listingType: r.listing_type_id
          };
        }).filter(Boolean);
      } catch (e) {
        console.error('[ML] 批量获取商品详情失败:', e.message);
      }
    }

    res.json({
      code: 0,
      data: {
        highlight: items[0]?.highlight_type || 'BEST_SELLER',
        total: items.length,
        items: itemsDetail
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.response?.data?.message || e.message });
  }
});

// ML 商品详情
app.get('/api/ml/item', async (req, res) => {
  try {
    const accessToken = await getMLAccessToken();
    if (!accessToken) return res.json({ code: 401, message: '未授权', oauthUrl: '/api/ml/oauth/start' });

    const id = req.query.id;
    if (!id) return res.json({ code: 400, message: '缺少 id 参数' });

    const [itemResp, descResp] = await Promise.all([
      axios.get(`https://api.mercadolibre.com/items/${id}`, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000
      }),
      axios.get(`https://api.mercadolibre.com/items/${id}/description`, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000
      }).catch(() => null)
    ]);

    const r = itemResp.data;
    res.json({
      code: 0,
      data: {
        id: r.id,
        title: r.title,
        price: r.price,
        originalPrice: r.original_price,
        currency: r.currency_id,
        soldQuantity: r.sold_quantity || 0,
        availableQuantity: r.available_quantity || 0,
        condition: r.condition,
        categoryId: r.category_id,
        sellerId: r.seller_id,
        link: r.permalink,
        thumbnail: r.thumbnail,
        freeShipping: r.shipping?.free_shipping || false,
        listingType: r.listing_type_id,
        warranty: r.warranty,
        attributes: (r.attributes || []).filter(a => a.value_name).slice(0, 10),
        pictures: (r.pictures || []).slice(0, 6).map(p => p.url),
        description: descResp?.data?.plain_text || ''
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.response?.data?.message || e.message });
  }
});

// ML 关键词找类目
app.get('/api/ml/keyword-to-category', async (req, res) => {
  try {
    const accessToken = await getMLAccessToken();
    if (!accessToken) return res.json({ code: 401, message: '未授权', oauthUrl: '/api/ml/oauth/start' });

    const site = req.query.site || 'MLM';
    const q = req.query.q || '';
    if (!q) return res.json({ code: 0, data: [] });

    const response = await axios.get(`https://api.mercadolibre.com/sites/${site}/domain_discovery/search`, {
      params: { q, limit: 5 },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000
    });
    res.json({ code: 0, data: response.data || [] });
  } catch (e) {
    res.json({ code: 500, message: e.response?.data?.message || e.message });
  }
});

// ML 官方热搜词（Trends）
app.get('/api/ml/trends', async (req, res) => {
  try {
    const accessToken = await getMLAccessToken();
    if (!accessToken) return res.json({ code: 401, message: '未授权', oauthUrl: '/api/ml/oauth/start' });

    const site = req.query.site || 'MLM';
    const response = await axios.get(`https://api.mercadolibre.com/trends/${site}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000
    });
    res.json({ code: 0, data: response.data || [] });
  } catch (e) {
    res.json({ code: 500, message: e.response?.data?.message || e.message });
  }
});

// ML 单个类目详情（真实商品总数 + 路径）
app.get('/api/ml/category-info', async (req, res) => {
  try {
    const accessToken = await getMLAccessToken();
    if (!accessToken) return res.json({ code: 401, message: '未授权', oauthUrl: '/api/ml/oauth/start' });

    const categoryId = req.query.id;
    if (!categoryId) return res.json({ code: 400, message: '缺少 id 参数' });

    const response = await axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000
    });
    const r = response.data;
    res.json({
      code: 0,
      data: {
        id: r.id,
        name: r.name,
        totalItems: r.total_items_in_this_category || 0,
        pathFromRoot: r.path_from_root || [],
        childrenCategories: r.children_categories || [],
        buyingAllowed: r.settings?.buying_allowed
      }
    });
  } catch (e) {
    res.json({ code: 500, message: e.response?.data?.message || e.message });
  }
});

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

// ========== 汇率转换 API ==========
// 缓存汇率，默认 1 小时刷新一次
let exchangeRateCache = { rate: null, base: null, timestamp: 0 };
const EXCHANGE_RATE_TTL = 60 * 60 * 1000; // 1小时

app.get('/api/exchange-rate', async (req, res) => {
  const base = req.query.base || 'MXN';
  const target = req.query.target || 'USD';

  // 检查缓存
  const now = Date.now();
  if (exchangeRateCache.rate && exchangeRateCache.base === base && exchangeRateCache.target === target && (now - exchangeRateCache.timestamp) < EXCHANGE_RATE_TTL) {
    return res.json({ code: 0, data: { base, target, rate: exchangeRateCache.rate } });
  }

  try {
    const response = await axios.get(`https://api.exchangerate-api.com/v4/latest/${base}`, { timeout: 10000 });
    const rate = response.data?.rates?.[target];
    if (!rate) return res.status(500).json({ code: 1, message: '获取汇率失败' });

    exchangeRateCache = { rate, base, target, timestamp: now };
    res.json({ code: 0, data: { base, target, rate } });
  } catch (error) {
    console.error('[ExchangeRate] 获取失败:', error.message);
    res.status(500).json({ code: 1, message: '汇率服务暂时不可用' });
  }
});

// ========== Dashboard 榜单 API（公开） ==========

function getCurrentWeekIndex() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start;
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const week = Math.floor(diff / oneWeek);
  return week % 5; // 0-4 轮换
}

function getRegionDomain(region) {
  const r = (region || 'MLM').toLowerCase();
  const map = {
    mlb: 'mercadolibre.com.br',
    mla: 'mercadolibre.com.ar',
    mlc: 'mercadolibre.cl',
    mco: 'mercadolibre.com.co',
    mlm: 'mercadolibre.com.mx'
  };
  return map[r] || map.mlm;
}

function buildSearchUrl(region, keyword) {
  const domain = getRegionDomain(region);
  const q = encodeURIComponent(keyword);
  return `https://listado.${domain}/${q}`;
}

// 热销商品榜
app.get('/api/dashboard/hot-products', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM hot_products WHERE enabled = 1 ORDER BY sort_order ASC, id ASC LIMIT 50'
    );
    const list = rows.map(p => {
      const url = p.link_url || buildSearchUrl(p.region, p.title);
      return {
        id: p.id,
        title: p.title,
        price: p.price,
        currency: p.currency,
        sales30: p.sales30,
        revenue: p.revenue,
        region: p.region,
        imageUrl: p.image_url || '',
        link: url
      };
    });
    res.json(jsonOk(list));
  } catch (e) {
    console.error('[Dashboard] 热销商品查询失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// 热搜词榜（展示全部 50 个）
app.get('/api/dashboard/hot-keywords', async (req, res) => {
  try {
    const weekIndex = getCurrentWeekIndex();
    const { rows } = await pool.query(
      'SELECT * FROM hot_keywords WHERE enabled = 1 ORDER BY id ASC LIMIT 50'
    );
    const list = rows.map(k => ({
      id: k.id,
      keyword: k.keyword,
      searchVol: k.search_vol,
      salesVol: k.sales_vol,
      productCount: k.product_count,
      trend: parseFloat(k.trend),
      region: k.region,
      link: buildSearchUrl(k.region, k.keyword)
    }));
    res.json(jsonOk({ weekIndex: weekIndex + 1, list }));
  } catch (e) {
    console.error('[Dashboard] 热搜词查询失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// Dashboard 顶部统计（每日自动更新）
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    let { rows } = await pool.query('SELECT * FROM dashboard_stats WHERE stat_date = $1', [today]);
    if (rows.length === 0) {
      await seedDashboardStats();
      ({ rows } = await pool.query('SELECT * FROM dashboard_stats WHERE stat_date = $1', [today]));
    }
    const s = rows[0] || {};

    // 获取昨日数据计算日增量
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { rows: yRows } = await pool.query('SELECT total_products FROM dashboard_stats WHERE stat_date = $1', [yesterday]);
    let productsDelta = 0;
    if (yRows.length > 0 && s.total_products) {
      productsDelta = s.total_products - yRows[0].total_products;
    }

    const formatNum = n => Number(n).toLocaleString('en-US');
    const data = {
      totalProducts: formatNum(s.total_products || 0),
      totalProductsDelta: (productsDelta >= 0 ? '+' : '') + formatNum(productsDelta),
      activeProducts: formatNum(s.active_products || 0),
      activeRate: s.active_rate || '0%',
      totalSold30: formatNum(s.total_sold30 || 0),
      soldMoM: s.sold_mom || '0%',
      totalRevenue30: '$' + formatNum(s.total_revenue30 || 0),
      revenueMoM: s.revenue_mom || '0%'
    };
    res.json(jsonOk(data));
  } catch (e) {
    console.error('[Dashboard] 统计查询失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// ========== 刷新畅销榜（从 meikeduoshuju API 获取真实数据） ==========

function getField(obj, keys) {
  if (!obj) return '';
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
    // 支持嵌套 key 如 'data.title' → obj.data?.title
    if (key.includes('.')) {
      const parts = key.split('.');
      let cur = obj;
      let found = true;
      for (const p of parts) {
        if (cur && cur[p] !== undefined && cur[p] !== null) {
          cur = cur[p];
        } else {
          found = false;
          break;
        }
      }
      if (found) return cur;
    }
  }
  return '';
}

app.post('/api/dashboard/refresh-hot-products', requireAdmin, async (req, res) => {
  try {
    const { rows: keywords } = await pool.query(
      'SELECT keyword, region FROM hot_keywords WHERE enabled = 1 GROUP BY keyword, region ORDER BY MIN(id)'
    );
    if (keywords.length === 0) return res.json(jsonFail('没有可用的热搜词，请先在管理后台添加热搜词'));

    let totalProducts = 0;
    const seenTitles = new Set();

    for (const kw of keywords) {
      try {
        const response = await axios.get('https://api.meikeduoshuju.com/api/v1/goods/search', {
          params: {
            keyword: kw.keyword,
            region: kw.region,
            shippedFrom: 'Envío desde China',
            crossBorder: 'true',
            sort: 'totalSales',
            order: 'descend',
            page: '1',
            size: '20'
          },
          timeout: 15000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Origin': 'https://meikeduoshuju.com',
            'Referer': 'https://meikeduoshuju.com/'
          }
        });

        const data = response.data;
        // 检测是否为 HTML 反爬页面
        if (typeof data === 'string' && data.trim().startsWith('<')) {
          console.error(`[Refresh] meikeduoshuju API 返回 HTML 反爬页面，跳过热搜词 "${kw.keyword}"`);
          continue;
        }
        // 尝试提取商品列表（兼容多种返回格式）
        let items = data?.data?.list || data?.data?.records || data?.list || data?.records || [];
        if (!Array.isArray(items)) items = [];

        for (const item of items) {
          if (!item) continue;
          const title = getField(item, ['goodsTitle', 'title', 'itemTitle', 'productName', 'goodsName']);
          if (!title || seenTitles.has(title)) continue;
          seenTitles.add(title);

          const price = getField(item, ['goodsPrice', 'price', 'sellPrice', 'currentPrice']);
          const currency = getField(item, ['tradeSymbol', 'currency', 'currencySign']) || 'USD';
          // 月销量优先取 monthSold，无则按 totalSales/price 估算
          let sales30 = getField(item, ['monthSold', 'weekSold', 'daySold', 'realSales', 'sold', 'totalSold', 'sales', 'sales30']) || '0';
          let revenue = getField(item, ['salesAmount', 'revenue', 'totalRevenue', 'sales30Amount', 'totalSales']) || '0';
          // 如果月销量缺失或为 100（可能是平台下限值），用月销售额/单价估算
          if ((!sales30 || sales30 === '0' || sales30 === '100') && price && revenue) {
            const est = Math.round(Number(revenue) / Number(price));
            if (est > 0 && est > Number(sales30)) sales30 = String(est);
          }
          revenue = Math.round(Number(revenue)).toString();
          const imageUrl = getField(item, ['thumbnail', 'image', 'imgUrl', 'mainImage', 'goodsImage']);
          const goodsId = getField(item, ['goodsId', 'productId', 'id', 'itemId']);
          const itemRegion = getField(item, ['region', 'site']) || kw.region;
          const goodsUrl = getField(item, ['goodsUrl', 'linkUrl', 'url', 'detailUrl']);

          // 优先使用 API 返回的真实商品链接，否则生成链接
          const linkUrl = goodsUrl || (goodsId && goodsId !== '-'
            ? (() => {
                const domain = { mlb: 'produto.mercadolivre.com.br', mla: 'articulo.mercadolibre.com.ar', mlc: 'articulo.mercadolibre.cl', mco: 'articulo.mercadolibre.com.co', mlm: 'articulo.mercadolibre.com.mx' }[itemRegion.toLowerCase()] || 'articulo.mercadolibre.com.mx';
                return `https://${domain}/${goodsId}`;
              })()
            : '');

          // 商品标题作为唯一标识，存在则更新，不存在则插入
          const exist = await pool.query('SELECT id FROM hot_products WHERE title = $1', [title]);
          if (exist.rows.length === 0) {
            await pool.query(
              'INSERT INTO hot_products (title, price, currency, sales30, revenue, region, image_url, link_url, sort_order, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)',
              [title, String(price || 0), currency, String(sales30), String(revenue), itemRegion, String(imageUrl || ''), linkUrl, totalProducts + 1]
            );
            totalProducts++;
          } else {
            // 更新已有商品数据/链接/图片，保持榜单最新
            await pool.query(
              'UPDATE hot_products SET price = $1, currency = $2, sales30 = $3, revenue = $4, region = $5, image_url = $6, link_url = $7 WHERE title = $8',
              [String(price || 0), currency, String(sales30), String(revenue), itemRegion, String(imageUrl || ''), linkUrl, title]
            );
          }
        }
      } catch (searchErr) {
        console.error(`[Refresh] 热搜词 "${kw.keyword}" 搜索失败:`, searchErr.message);
        continue;
      }
    }

    // 清除旧 Unsplash 占位图（让下次刷新可以补充真实图片）
    await pool.query("UPDATE hot_products SET image_url = '' WHERE image_url LIKE '%unsplash%'");

    res.json(jsonOk({ total: totalProducts, message: `成功获取 ${totalProducts} 条真实商品数据` }));
  } catch (e) {
    console.error('[Refresh] 刷新畅销榜失败:', e.message);
    res.status(500).json(jsonFail('刷新失败: ' + e.message));
  }
});

// ========== 管理后台 Dashboard 榜单 API ==========

// 热销商品管理
app.get('/api/admin/dashboard/hot-products', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM hot_products ORDER BY sort_order ASC, id ASC');
    const list = rows.map(p => ({
      id: p.id, title: p.title, price: p.price, currency: p.currency,
      sales30: p.sales30, revenue: p.revenue, region: p.region,
      imageUrl: p.image_url || '', linkUrl: p.link_url || '', sortOrder: p.sort_order, enabled: p.enabled === 1
    }));
    res.json(jsonOk(list));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.post('/api/admin/dashboard/hot-products', requireAdmin, async (req, res) => {
  const { title, price, currency, sales30, revenue, region, imageUrl, linkUrl, sortOrder, enabled } = req.body;
  if (!title || !price || !sales30 || !revenue) return res.json(jsonFail('缺少必填字段'));
  try {
    const result = await pool.query(
      'INSERT INTO hot_products (title, price, currency, sales30, revenue, region, image_url, link_url, sort_order, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [title, price, currency || 'USD', sales30, revenue, region || 'MLM', imageUrl || '', linkUrl || '', sortOrder || 0, enabled !== false ? 1 : 0]
    );
    res.json(jsonOk({ id: result.rows[0].id }, '添加成功'));
  } catch (e) {
    console.error('[Admin] 添加热销商品失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.put('/api/admin/dashboard/hot-products/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { title, price, currency, sales30, revenue, region, imageUrl, linkUrl, sortOrder, enabled } = req.body;
  try {
    const updates = [];
    const params = [];
    let idx = 1;
    if (title !== undefined) { updates.push(`title = $${idx++}`); params.push(title); }
    if (price !== undefined) { updates.push(`price = $${idx++}`); params.push(price); }
    if (currency !== undefined) { updates.push(`currency = $${idx++}`); params.push(currency); }
    if (sales30 !== undefined) { updates.push(`sales30 = $${idx++}`); params.push(sales30); }
    if (revenue !== undefined) { updates.push(`revenue = $${idx++}`); params.push(revenue); }
    if (region !== undefined) { updates.push(`region = $${idx++}`); params.push(region); }
    if (imageUrl !== undefined) { updates.push(`image_url = $${idx++}`); params.push(imageUrl); }
    if (linkUrl !== undefined) { updates.push(`link_url = $${idx++}`); params.push(linkUrl); }
    if (sortOrder !== undefined) { updates.push(`sort_order = $${idx++}`); params.push(sortOrder); }
    if (enabled !== undefined) { updates.push(`enabled = $${idx++}`); params.push(enabled !== false ? 1 : 0); }
    if (updates.length === 0) return res.json(jsonOk(null, '无更新'));
    params.push(id);
    const result = await pool.query(`UPDATE hot_products SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    if (result.rowCount === 0) return res.json(jsonFail('记录不存在'));
    res.json(jsonOk(null, '更新成功'));
  } catch (e) {
    console.error('[Admin] 更新热销商品失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.delete('/api/admin/dashboard/hot-products/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query('DELETE FROM hot_products WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.json(jsonFail('记录不存在'));
    res.json(jsonOk(null, '删除成功'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// 热搜词管理
app.get('/api/admin/dashboard/hot-keywords', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM hot_keywords ORDER BY week_index ASC, id ASC');
    const list = rows.map(k => ({
      id: k.id, keyword: k.keyword, searchVol: k.search_vol, salesVol: k.sales_vol,
      productCount: k.product_count, trend: parseFloat(k.trend), region: k.region,
      weekIndex: k.week_index, enabled: k.enabled === 1
    }));
    res.json(jsonOk(list));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.post('/api/admin/dashboard/hot-keywords', requireAdmin, async (req, res) => {
  const { keyword, searchVol, salesVol, productCount, trend, region, weekIndex, enabled } = req.body;
  if (!keyword || !searchVol || !salesVol || !productCount) return res.json(jsonFail('缺少必填字段'));
  try {
    const result = await pool.query(
      'INSERT INTO hot_keywords (keyword, search_vol, sales_vol, product_count, trend, region, week_index, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [keyword, searchVol, salesVol, productCount, trend || 0, region || 'MLM', weekIndex || 0, enabled !== false ? 1 : 0]
    );
    res.json(jsonOk({ id: result.rows[0].id }, '添加成功'));
  } catch (e) {
    console.error('[Admin] 添加热搜词失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.put('/api/admin/dashboard/hot-keywords/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { keyword, searchVol, salesVol, productCount, trend, region, weekIndex, enabled } = req.body;
  try {
    const updates = [];
    const params = [];
    let idx = 1;
    if (keyword !== undefined) { updates.push(`keyword = $${idx++}`); params.push(keyword); }
    if (searchVol !== undefined) { updates.push(`search_vol = $${idx++}`); params.push(searchVol); }
    if (salesVol !== undefined) { updates.push(`sales_vol = $${idx++}`); params.push(salesVol); }
    if (productCount !== undefined) { updates.push(`product_count = $${idx++}`); params.push(productCount); }
    if (trend !== undefined) { updates.push(`trend = $${idx++}`); params.push(trend); }
    if (region !== undefined) { updates.push(`region = $${idx++}`); params.push(region); }
    if (weekIndex !== undefined) { updates.push(`week_index = $${idx++}`); params.push(weekIndex); }
    if (enabled !== undefined) { updates.push(`enabled = $${idx++}`); params.push(enabled !== false ? 1 : 0); }
    if (updates.length === 0) return res.json(jsonOk(null, '无更新'));
    params.push(id);
    const result = await pool.query(`UPDATE hot_keywords SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    if (result.rowCount === 0) return res.json(jsonFail('记录不存在'));
    res.json(jsonOk(null, '更新成功'));
  } catch (e) {
    console.error('[Admin] 更新热搜词失败:', e.message);
    res.status(500).json(jsonFail('数据库错误'));
  }
});

app.delete('/api/admin/dashboard/hot-keywords/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await pool.query('DELETE FROM hot_keywords WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.json(jsonFail('记录不存在'));
    res.json(jsonOk(null, '删除成功'));
  } catch (e) {
    res.status(500).json(jsonFail('数据库错误'));
  }
});

// ========== 管理员国际购选品 ==========
app.post('/api/admin/international-import', requireAdmin, async (req, res) => {
  const country = String(req.body?.country || '').toUpperCase();
  const products = Array.isArray(req.body?.products) ? req.body.products.slice(0, 100) : [];
  if (!['MX', 'BR', 'CL', 'CO'].includes(country)) return res.status(400).json(jsonFail('国家代码无效'));
  if (!products.length) return res.json(jsonOk({ imported: 0 }));
  let imported = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of products) {
      if (!item?.itemId || !item?.title || !item?.productUrl) continue;
      await client.query(`
        INSERT INTO international_products
          (country, item_id, title, price, currency, discount, image_url, product_url, category_name, category_url, listing_time,
           original_price, rating, review_count, sold_text, seller, shipping_text, origin_text, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        ON CONFLICT (country, item_id) DO UPDATE SET
          title=EXCLUDED.title, price=EXCLUDED.price, currency=EXCLUDED.currency,
          discount=EXCLUDED.discount, image_url=EXCLUDED.image_url, product_url=EXCLUDED.product_url,
          category_name=EXCLUDED.category_name, category_url=EXCLUDED.category_url,
          original_price=EXCLUDED.original_price, rating=EXCLUDED.rating, review_count=EXCLUDED.review_count,
          sold_text=EXCLUDED.sold_text, seller=EXCLUDED.seller, shipping_text=EXCLUDED.shipping_text, origin_text=EXCLUDED.origin_text,
          listing_time=COALESCE(EXCLUDED.listing_time, international_products.listing_time), last_seen_at=NOW()`,
        [country, String(item.itemId).slice(0, 40), String(item.title).slice(0, 1000),
          item.price !== null && item.price !== '' && Number.isFinite(Number(item.price)) ? Number(item.price) : null, String(item.currency || '').slice(0, 3),
          String(item.discount || '').slice(0, 80), String(item.imageUrl || '').slice(0, 3000),
          String(item.productUrl).slice(0, 3000), String(item.categoryName || '').slice(0, 300),
          String(item.categoryUrl || '').slice(0, 3000), item.listingTime ? new Date(item.listingTime) : null,
          item.originalPrice !== null && item.originalPrice !== '' && Number.isFinite(Number(item.originalPrice)) ? Number(item.originalPrice) : null,
          item.rating !== null && item.rating !== '' && Number.isFinite(Number(item.rating)) ? Number(item.rating) : null,
          item.reviewCount !== null && item.reviewCount !== '' && Number.isFinite(Number(item.reviewCount)) ? Number(item.reviewCount) : null,
          String(item.soldText || '').slice(0, 120), String(item.seller || '').slice(0, 300),
          String(item.shippingText || '').slice(0, 500), String(item.originText || '').slice(0, 200)]
      );
      imported++;
    }
    await client.query('COMMIT');
    res.json(jsonOk({ imported }));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[International] 导入失败:', e.message);
    res.status(500).json(jsonFail('导入失败'));
  } finally { client.release(); }
});

async function getMLSellerId(accessToken) {
  const me = await axios.get('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000
  });
  const id = String(me.data.id);
  await pool.query("INSERT INTO settings (key, value, updated_at) VALUES ('ml_user_id', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [id]);
  return id;
}

function parseOrderBilling(detail, grossAmount) {
  if (!detail || typeof detail !== 'object') return null;
  const seen = new Set(), entries = [];
  const walk = (value, inheritedCurrency = '') => {
    if (Array.isArray(value)) return value.forEach(item => walk(item, inheritedCurrency));
    if (!value || typeof value !== 'object') return;
    const currency = String(value.currency_info?.currency_id || value.currency_info?.id || value.currency_id || inheritedCurrency || '').toUpperCase();
    if (value.detail_amount !== undefined && value.detail_amount !== null) {
      const key = String(value.detail_id || `${value.detail_sub_type || ''}:${value.detail_description || ''}:${value.detail_amount}`);
      if (!seen.has(key)) { seen.add(key); entries.push({ ...value, _currencyId: currency }); }
    }
    Object.values(value).forEach(child => walk(child, currency));
  };
  walk(detail);
  let saleFee = 0, shippingFee = 0, otherFee = 0, totalCharges = 0, totalBonuses = 0, ledgerDelta = 0;
  for (const entry of entries) {
    const signedAmount = Number(entry.detail_amount || 0);
    const amount = Math.abs(signedAmount);
    const type = String(entry.detail_type || '').toUpperCase();
    const subType = String(entry.detail_sub_type || '').toUpperCase();
    const conceptType = String(entry.concept_type || '').toUpperCase();
    const text = `${entry.transaction_detail || ''} ${entry.detail_description || ''} ${subType} ${conceptType}`.toLowerCase();
    if (type === 'BONUS' || /bonus|rebate|credit/.test(text)) {
      totalBonuses += amount;
      ledgerDelta += signedAmount;
    }
    else {
      totalCharges += amount;
      ledgerDelta -= signedAmount;
      if (subType === 'CXD' || conceptType === 'SHIPPING' || /shipping|shipment|freight|logistic|env[ií]o|mercado env[ií]os/.test(text)) shippingFee += amount;
      else if (subType === 'CV' || /sale.?fee|commission|selling.?fee|cargo por venta|cargo por vender|tarifa de venta/.test(text)) saleFee += amount;
      else otherFee += amount;
    }
  }
  const explicitSaleFee = Number(detail.sale_fee?.net ?? detail.sale_fee?.amount ?? detail.sale_fee?.gross ?? detail.sale_fee ?? 0);
  const explicitShipping = Number(detail.shipping_info?.sender_shipping_cost ?? detail.shipping_cost ?? 0);
  if (!saleFee && explicitSaleFee) {
    saleFee = Math.abs(explicitSaleFee);
    if (!entries.length) ledgerDelta -= explicitSaleFee;
  }
  if (!shippingFee && explicitShipping) {
    shippingFee = Math.abs(explicitShipping);
    if (!entries.length) ledgerDelta -= explicitShipping;
  }
  const netCandidates = [
    detail.net_received_amount, detail.net_amount, detail.total_net_amount,
    detail.settlement_amount, detail.amount_to_receive,
    detail.amounts?.net, detail.amounts?.net_amount, detail.summary?.net_amount
  ];
  const officialNetValue = netCandidates.find(value => value !== undefined && value !== null && Number.isFinite(Number(value)));
  const hasOfficialLedger = entries.length > 0 || explicitSaleFee !== 0 || explicitShipping !== 0 || officialNetValue !== undefined;
  return { saleFee, shippingFee, otherFee, totalCharges, totalBonuses, ledgerDelta, hasOfficialLedger,
    netAmount: officialNetValue === undefined ? null : Number(officialNetValue), entries };
}

const billingFxCache = new Map();
async function getBillingFxRate(fromCurrency, toCurrency) {
  const from = String(fromCurrency || '').toUpperCase(), to = String(toCurrency || '').toUpperCase();
  if (!from || !to || from === to) return 1;
  const key = `${from}:${to}`, cached = billingFxCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rate;
  try {
    const response = await axios.get('https://api.mercadolibre.com/currency_conversions/search', { params: { from, to }, timeout: 12000 });
    const rate = Number(response.data?.ratio || response.data?.rate || 0);
    if (rate > 0) { billingFxCache.set(key, { rate, expiresAt: Date.now() + 6 * 3600000 }); return rate; }
  } catch (error) { console.warn('[Orders] 账单币种换算失败:', from, to, error.response?.status || error.message); }
  return null;
}

function translateBillingDescription(value, category, subType) {
  const text = String(value || '').trim();
  const key = text.toLowerCase();
  const rules = [
    [/shipping costs?.*gross weight.*dimensions|costos? de env[ií]o.*peso|cargo por mercado env[ií]os/, '按商品毛重和尺寸计算的物流运输费'],
    [/anulaci[oó]n.*transferencia de dinero.*cuenta internacional|cancellation.*money transfer/, '撤销国际账户转账手续费'],
    [/anulaci[oó]n.*cargo por gesti[oó]n de venta|cancellation of cost for selling|cancellation.*selling fee/, '撤销美客多平台销售佣金'],
    [/cargo por transferencia de dinero a.*cuenta internacional|money transfer.*international account/, '国际账户转账手续费'],
    [/fee for receiving payments.*mercado pago|tarifa por recibir pagos/, 'Mercado Pago 收款手续费'],
    [/selling fee|sale fee|cost for selling on mercado libre|cargo por (venta|vender|gesti[oó]n de venta)/, '美客多平台销售佣金'],
    [/refund|reembolso|devoluci[oó]n/, '退款相关调整'],
    [/tax|impuesto|iva/, '税费'],
    [/financing|financiaci[oó]n/, '分期付款服务费']
  ];
  for (const [pattern, translated] of rules) if (pattern.test(key)) return translated;
  const safeCategory = category || '官方账单费用';
  return subType ? `${safeCategory}（费用代码 ${subType}）` : safeCategory;
}

function classifyBillingEntry(entry) {
  const subType = String(entry.detail_sub_type || '').toUpperCase();
  const conceptType = String(entry.concept_type || '').toUpperCase();
  const raw = String(entry.transaction_detail || entry.detail_description || '');
  const text = `${raw} ${subType} ${conceptType}`.toLowerCase();
  if (String(entry.detail_type || '').toUpperCase() === 'BONUS') return { key: 'bonusAmount', category: '优惠/返还' };
  if (subType === 'CV' || subType.startsWith('CVML') || /selling fee|sale fee|cost for selling|cargo por (venta|vender|gesti[oó]n de venta)/.test(text)) return { key: 'saleFee', category: '销售佣金' };
  if (subType === 'CVMPCB' || /receiving payments|recibir pagos|mercado pago.*(fee|tarifa)/.test(text)) return { key: 'paymentFee', category: '收款手续费' };
  if (subType === 'CVMPI' || /transferencia de dinero.*cuenta internacional|international account.*transfer/.test(text)) return { key: 'transferFee', category: '国际转账手续费' };
  if (subType === 'CXD' || subType === 'CCSI' || conceptType === 'SHIPPING' || /shipping|shipment|freight|logistic|env[ií]o/.test(text)) return { key: 'shippingFee', category: '物流运输' };
  if (/cancel|anulaci[oó]n/.test(text)) return { key: 'cancellationFee', category: '取消费用' };
  if (/tax|impuesto|iva/.test(text)) return { key: 'taxFee', category: '税费' };
  return { key: 'adjustmentFee', category: '官方账单调整' };
}

async function aggregatePackedOrders(rows) {
  const groups = new Map();
  for (const row of rows) {
    const groupId = String(row.packId || row.orderId);
    if (!groups.has(groupId)) groups.set(groupId, { ...row, displayOrderId: groupId, internalOrderIds: [], shipmentIds: [], items: [], paidAmount: 0, totalAmount: 0, grossAmountUsd: 0, netAmountUsd: 0, refundAmountUsd: 0, saleFee: 0, shippingFee: 0, otherFee: 0, paymentFee: 0, transferFee: 0, cancellationFee: 0, taxFee: 0, adjustmentFee: 0, bonusAmount: 0, refundAmount: 0, productCost: 0, financeIsOfficial: false, billingBreakdown: [], _fallbackNetAmount: 0, _hasFallbackNetAmount: false, _hasGrossAmountUsd: false, _hasNetAmountUsd: false, _hasRefundAmountUsd: false, _billingEntryIds: new Set(), _officialEntryCount: 0, _officialLedgerDelta: 0, _hasOfficialLedger: false, _officialFees: { saleFee: 0, shippingFee: 0, paymentFee: 0, transferFee: 0, cancellationFee: 0, taxFee: 0, adjustmentFee: 0, bonusAmount: 0 }, _officialSignedFees: { saleFee: 0, shippingFee: 0, paymentFee: 0, transferFee: 0, cancellationFee: 0, taxFee: 0, adjustmentFee: 0, bonusAmount: 0 } });
    const group = groups.get(groupId);
    group.internalOrderIds.push(String(row.orderId));
    if (row.shippingId) group.shipmentIds.push(String(row.shippingId));
    group.items.push(...(Array.isArray(row.items) ? row.items : []));
    if (row.reputationImpact === true) group.reputationImpact = true;
    if (row.reputationReason && !String(group.reputationReason || '').includes(row.reputationReason)) {
      group.reputationReason = [group.reputationReason, row.reputationReason].filter(Boolean).join('；');
    }
    for (const field of ['paidAmount','totalAmount','saleFee','shippingFee','otherFee','refundAmount','productCost']) group[field] += Number(row[field] || 0);
    for (const [field, flag] of [['grossAmountUsd','_hasGrossAmountUsd'],['netAmountUsd','_hasNetAmountUsd'],['refundAmountUsd','_hasRefundAmountUsd']]) {
      if (row[field] !== null && row[field] !== undefined) { group[field] += Number(row[field] || 0); group[flag] = true; }
    }
    if (row.netAmount !== null && row.netAmount !== undefined) {
      group._fallbackNetAmount += Number(row.netAmount || 0);
      group._hasFallbackNetAmount = true;
    }
    group.financeIsOfficial ||= Boolean(row.financeIsOfficial);
    const parsed = parseOrderBilling(row.billingData, Number(row.paidAmount || 0));
    if (parsed?.hasOfficialLedger) group._hasOfficialLedger = true;
    if (parsed?.hasOfficialLedger && !parsed.entries?.length) group._officialLedgerDelta += Number(parsed.ledgerDelta || 0);
    for (const entry of parsed?.entries || []) {
      const subType = String(entry.detail_sub_type || '').toUpperCase();
      const conceptType = String(entry.concept_type || '').toUpperCase();
      const rawDescription = String(entry.transaction_detail || entry.detail_description || subType || '官方账单费用');
      const classified = classifyBillingEntry(entry), category = classified.category;
      const description = translateBillingDescription(rawDescription, category, subType);
      const entryId = String(entry.detail_id || `${subType}:${description}:${entry.detail_amount}`);
      if (!group._billingEntryIds.has(entryId)) {
        const entryCurrency = String(entry._currencyId || row.currency || '').toUpperCase();
        const fxRate = await getBillingFxRate(entryCurrency, row.currency);
        group._billingEntryIds.add(entryId); group._officialEntryCount++;
        if (fxRate === null) { group.billingCurrencyMismatch = true; continue; }
        const normalizedAmount = Math.abs(Number(entry.detail_amount || 0)) * fxRate;
        const normalizedSignedAmount = Number(entry.detail_amount || 0) * fxRate;
        const isBonus = String(entry.detail_type || '').toUpperCase() === 'BONUS' || /bonus|rebate|credit/.test(rawDescription.toLowerCase());
        group._officialLedgerDelta += isBonus ? normalizedSignedAmount : -normalizedSignedAmount;
        group._officialFees[classified.key] += normalizedAmount;
        group._officialSignedFees[classified.key] += normalizedSignedAmount;
        group.billingBreakdown.push({ id: entryId, category, description, subType, amount: normalizedAmount, signedAmount: normalizedSignedAmount, originalAmount: Number(entry.detail_amount || 0), originalCurrency: entryCurrency, type: entry.detail_type || '' });
      }
    }
  }
  for (const group of groups.values()) {
    if (group._officialEntryCount) for (const field of Object.keys(group._officialFees)) group[field] = group._officialFees[field];
    if (group._officialEntryCount) {
      for (const field of Object.keys(group._officialSignedFees)) {
        group[`${field}Signed`] = Number(group._officialSignedFees[field].toFixed(2));
      }
      group.otherFeeSigned = group.cancellationFeeSigned;
    }
    for (const field of ['saleFee','shippingFee','paymentFee','transferFee','cancellationFee','taxFee','adjustmentFee','bonusAmount']) group[field] = Number(group[field].toFixed(2));
    if (group._officialEntryCount) group.otherFee = group.cancellationFee;
    group.netAmount = group._hasFallbackNetAmount ? Number(group._fallbackNetAmount.toFixed(2)) : null;
    group.grossAmountUsd = group._hasGrossAmountUsd ? Number(group.grossAmountUsd.toFixed(2)) : null;
    group.netAmountUsd = group._hasNetAmountUsd ? Number(group.netAmountUsd.toFixed(2)) : null;
    group.refundAmountUsd = group._hasRefundAmountUsd ? Number(group.refundAmountUsd.toFixed(2)) : null;
    if (group.netAmountUsd === null && group._hasOfficialLedger && !group.billingCurrencyMismatch) {
      const payoutLocal = Number((Number(group.paidAmount || 0) - Number(group.refundAmount || 0) + group._officialLedgerDelta).toFixed(2));
      const payoutFxRate = await getBillingFxRate(group.currency, 'USD');
      if (payoutFxRate === null) group.billingCurrencyMismatch = true;
      else {
        group.netAmount = payoutLocal;
        group.netAmountUsd = Number((payoutLocal * payoutFxRate).toFixed(2));
        group.payoutSource = 'official_billing_ledger';
        group.payoutCalculation = {
          paidAmount: Number(group.paidAmount || 0),
          refundAmount: Number(group.refundAmount || 0),
          officialLedgerDelta: Number(group._officialLedgerDelta.toFixed(2)),
          currency: group.currency,
          usdRate: payoutFxRate
        };
      }
    }
    group.payoutIsOfficial = group.netAmountUsd !== null;
    if (!group.payoutSource && group.payoutIsOfficial) group.payoutSource = 'official_net_amount';
    delete group._fallbackNetAmount; delete group._hasFallbackNetAmount; delete group._hasGrossAmountUsd; delete group._hasNetAmountUsd; delete group._hasRefundAmountUsd; delete group._billingEntryIds; delete group._officialEntryCount; delete group._officialLedgerDelta; delete group._hasOfficialLedger; delete group._officialFees; delete group._officialSignedFees;
  }
  return [...groups.values()];
}

function extractReputationInfo(rawData) {
  const raw = rawData && typeof rawData === 'object' ? rawData : {};
  const official = raw._official_reputation && typeof raw._official_reputation === 'object' ? raw._official_reputation : {};
  const values = [
    official.affects_reputation,
    official.reputation_affected,
    official.sale?.affects_reputation,
    raw.affects_reputation,
    raw.reputation_affected,
    raw.reputation?.affected,
    raw.reputation?.affects,
    raw.feedback?.affects_reputation,
    raw.feedback?.sale?.affects_reputation
  ];
  const explicit = values.find(value => typeof value === 'boolean');
  const rating = String(official.sale?.rating || official.rating || raw.feedback?.sale?.rating || raw.feedback?.rating || '').toLowerCase();
  const impact = explicit === true || ['negative', 'neutral'].includes(rating)
    ? true
    : (explicit === false ? false : null);
  const reason = official.reputation?.reason || official.reason || official.sale?.reason || raw.reputation?.reason || raw.reputation_reason ||
    raw.feedback?.sale?.reason || raw.feedback?.reason ||
    (rating === 'negative' ? 'negative_feedback' : (rating === 'neutral' ? 'neutral_feedback' : ''));
  return {
    impact,
    reason: String(reason || ''),
    feedback: String(official.message || official.feedback || official.sale?.message || ''),
    responsibility: String(official.responsible_party || official.reputation?.responsible_party || ''),
    advice: String(official.recommendation || official.reputation?.recommendation || ''),
    source: Object.keys(official).length ? 'official_feedback' : (explicit !== undefined ? 'order' : '')
  };
}

app.get('/api/health/order-management', (req, res) => {
  res.json({ code: 0, data: {
    version: '2026-07-24.4',
    dispatchDeadlineRule: 'mon-thu-72h_fri-sat-120h_sun-96h',
    onlineDeadlineRule: 'handling-deadline-plus-24h',
    officialPayoutFromLedger: true,
    shippingActionsHorizontal: true,
    userIsolation: true,
    officialPayoutOnly: true,
    multiStoreSync: true,
    fulfillmentAudit: true,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || ''
  } });
});

async function saveOrderApiAudit(ownerUsername, storeUserId, orderId, apiType, externalId, rawData) {
  if (!ownerUsername || !apiType || !externalId) return;
  await pool.query(`INSERT INTO order_api_audits(owner_username,store_user_id,order_id,api_type,external_id,raw_data,fetched_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,NOW()) ON CONFLICT(owner_username,api_type,external_id)
    DO UPDATE SET store_user_id=EXCLUDED.store_user_id,order_id=EXCLUDED.order_id,raw_data=EXCLUDED.raw_data,fetched_at=NOW()`,
    [ownerUsername,String(storeUserId || ''),String(orderId || ''),String(apiType),String(externalId),JSON.stringify(rawData || {})]);
}

app.post('/api/admin/orders/sync', requireAdmin, async (req, res) => {
  try {
    const requestedStoreId = String(req.body?.storeId || '').trim();
    const authorizations = await listOrderStoreAuthorizations(req.authUser, requestedStoreId);
    if (!authorizations.length) return res.status(401).json({ code: 401, message: '当前账号尚未授权可同步的美客多店铺' });
    const selectedAuthorization = authorizations[0];
    const accessToken = await getStoreAuthorizationToken(selectedAuthorization);
    if (!accessToken) return res.status(401).json({ code: 401, message: '店铺授权已失效，请重新授权' });
    const sellerId = String(selectedAuthorization.ml_user_id);
    const [accountResponse, listingsResponse] = await Promise.all([
      axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }),
      axios.get(`https://api.mercadolibre.com/users/${sellerId}/items/search`, { params: { limit: 1 }, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }).catch(() => null)
    ]);
    const me = accountResponse.data || {};
    await pool.query(`INSERT INTO ml_stores(ml_user_id,owner_username,nickname,site_id,updated_at) VALUES($1,$2,$3,$4,NOW())
      ON CONFLICT(ml_user_id) DO UPDATE SET owner_username=EXCLUDED.owner_username,nickname=EXCLUDED.nickname,site_id=EXCLUDED.site_id,updated_at=NOW()`,
      [String(me.id || sellerId), req.authUser.username, me.nickname || '', me.site_id || '']);
    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 50));
    const offset = Math.min(5000,Math.max(0,Number(req.body?.offset)||0));
    let response, sourceOrders;
    if (me.site_id === 'CBT') {
      response = await axios.get('https://api.mercadolibre.com/marketplace/orders/search', {
        params: { sort: 'date_desc', limit, offset }, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000
      });
      const orderIds = [...new Set((response.data?.results || []).flatMap(pack =>
        (pack.orders || []).map(order => order.id).filter(Boolean)
      ))].slice(0, limit);
      sourceOrders = [];
      for (let i = 0; i < orderIds.length; i += 5) {
        const batch = await Promise.all(orderIds.slice(i, i + 5).map(id =>
          axios.get(`https://api.mercadolibre.com/marketplace/orders/${id}`, {
            headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000
          }).then(r => r.data).catch(error => {
            console.warn('[Orders] CBT订单详情读取失败:', id, error.response?.status || error.message);
            return null;
          })
        ));
        sourceOrders.push(...batch.filter(Boolean));
      }
      for (let i = 0; i < sourceOrders.length; i += 5) {
        await Promise.all(sourceOrders.slice(i, i + 5).map(async order => {
          const shipmentId = order.shipping?.id;
          if (!shipmentId) return;
          try {
            const shipment = await axios.get(`https://api.mercadolibre.com/marketplace/shipments/${shipmentId}`, {
              headers: { Authorization: `Bearer ${accessToken}`, 'x-format-new': 'true' }, timeout: 20000
            });
            order._shipment_detail = shipment.data;
          } catch (error) {
            console.warn('[Orders] CBT物流详情读取失败:', shipmentId, error.response?.status || error.message);
          }
        }));
      }
    } else {
      response = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: sellerId, sort: 'date_desc', limit, offset },
        headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000
      });
      sourceOrders = response.data?.results || [];
    }
    const itemIds = [...new Set(sourceOrders.flatMap(order =>
      (order.order_items || []).map(entry => entry.item?.id).filter(Boolean)
    ))];
    const itemPictures = new Map();
    for (let i = 0; i < itemIds.length; i += 10) {
      await Promise.all(itemIds.slice(i, i + 10).map(async id => {
        try {
          let item = {};
          for (const path of me.site_id === 'CBT' ? [`marketplace/items/${id}`, `items/${id}`] : [`items/${id}`, `marketplace/items/${id}`]) {
            try {
              const itemResponse = await axios.get(`https://api.mercadolibre.com/${path}`, {
                headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000
              });
              item = itemResponse.data || {};
              if (item.thumbnail || item.secure_thumbnail || item.pictures?.length) break;
            } catch (_) { /* 尝试下一个兼容接口 */ }
          }
          const picture = item.thumbnail || item.secure_thumbnail || item.pictures?.[0]?.secure_url || item.pictures?.[0]?.url || item.picture_url || '';
          if (picture) itemPictures.set(String(id), picture.replace(/^http:/, 'https:'));
        } catch (error) {
          console.warn('[Orders] 商品图片读取失败:', id, error.response?.status || error.message);
        }
      }));
    }
    const billingByOrder = new Map();
    const billingGroups = new Map();
    for (const order of sourceOrders) {
      const localSellerId = String(order.seller?.id || sellerId);
      if (!billingGroups.has(localSellerId)) billingGroups.set(localSellerId, []);
      billingGroups.get(localSellerId).push(String(order.id));
    }
    for (const [localSellerId, ids] of billingGroups) {
      for (let i = 0; i < ids.length; i += 60) {
        try {
          const billingResponse = await axios.get('https://api.mercadolibre.com/billing/integration/group/ML/order/details', {
            params: { order_ids: ids.slice(i, i + 60).join(','), seller_id: localSellerId },
            headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000
          });
          for (const detail of billingResponse.data?.results || []) billingByOrder.set(String(detail.order_id), detail);
        } catch (error) {
          console.warn('[Orders] 官方对账明细读取失败:', localSellerId, error.response?.status || error.message);
        }
      }
    }
    // 官方评价/声誉反馈优先于取消原因推断；不支持的站点静默保留为空。
    for (let i = 0; i < sourceOrders.length; i += 5) {
      await Promise.all(sourceOrders.slice(i,i+5).map(async order => {
        for (const path of [`orders/${order.id}/feedback`,`marketplace/orders/${order.id}/feedback`]) {
          try {
            const feedbackResponse = await axios.get(`https://api.mercadolibre.com/${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 12000 });
            order._official_reputation = feedbackResponse.data || {};
            break;
          } catch (error) { if (![403,404].includes(error.response?.status)) break; }
        }
      }));
    }
    let imported = 0;
    for (const order of sourceOrders) {
      const shipment = order._shipment_detail || {};
      const orderItems = (order.order_items || []).map(entry => ({
        ...entry,
        item: { ...entry.item, thumbnail: entry.item?.thumbnail || entry.item?.secure_thumbnail || entry.item?.picture_url || entry.item?.pictures?.[0]?.secure_url || entry.item?.pictures?.[0]?.url || itemPictures.get(String(entry.item?.id)) || '' }
      }));
      const itemId = order.order_items?.[0]?.item?.id || '';
      const siteId = shipment.source?.site_id || shipment.site_id || itemId.match(/^(MLM|MLB|MLC|MCO|MLA)/)?.[1] || '';
      const country = ({ MLM:'MX', MLB:'BR', MLC:'CL', MCO:'CO', MLA:'AR' })[siteId] || siteId;
      const officialHandlingDeadline = shipment.shipping_option?.estimated_handling_limit?.date ||
        shipment.lead_time?.estimated_handling_limit?.date || shipment.estimated_handling_limit?.date || null;
      let handlingDeadline = officialHandlingDeadline;
      if (!handlingDeadline && order.date_created) {
        const created = new Date(order.date_created);
        const sourceCalendarDate = String(order.date_created).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
        const createdWeekday = sourceCalendarDate
          ? new Date(`${sourceCalendarDate}T12:00:00Z`).getUTCDay()
          : created.getUTCDay();
        const dispatchHours = createdWeekday === 5 || createdWeekday === 6
          ? 120
          : (createdWeekday === 0 ? 96 : 72);
        handlingDeadline = new Date(created.getTime() + dispatchHours * 3600000).toISOString();
      }
      const cancelActor = order.cancel_detail?.group || order.cancel_detail?.initiated_by ||
        order.cancel_detail?.responsible || order.cancellation?.initiated_by ||
        order.cancellation?.cancelled_by || order.cancelled_by || '';
      const cancelDescription = order.cancel_detail?.description || order.cancel_detail?.reason ||
        order.cancellation?.reason || order.status_detail || order.reason || '';
      const cancellationReason = cancelActor
        ? `${String(cancelActor).toLowerCase()}|${cancelDescription}`
        : cancelDescription;
      const payments = Array.isArray(order.payments) ? order.payments : [];
      const saleFeeParts = [
        ...(orderItems || []).map(x => x.sale_fee).filter(v => v !== undefined && v !== null),
        ...payments.flatMap(p => (p.fee_details || []).filter(f => /marketplace|sale|commission/i.test(f.type || f.name || '')).map(f => f.amount))
      ];
      const saleFee = saleFeeParts.length ? saleFeeParts.reduce((sum, v) => sum + Number(v || 0), 0) : null;
      const shippingCandidates = [shipment.cost, shipment.base_cost, order.shipping?.cost,
        ...payments.map(p => p.shipping_cost),
        ...payments.flatMap(p => (p.fee_details || []).filter(f => /shipping|freight|logistic/i.test(f.type || f.name || '')).map(f => f.amount))
      ].filter(v => v !== undefined && v !== null);
      const nonZeroShipping = shippingCandidates.find(v => Number(v) !== 0);
      const shippingFee = shippingCandidates.length ? Number(nonZeroShipping ?? shippingCandidates[0] ?? 0) : null;
      const netParts = payments.map(p => p.transaction_details?.net_received_amount).filter(v => v !== undefined && v !== null);
      const grossAmount = Number(order.paid_amount || order.total_amount || 0);
      const netAmount = netParts.length ? netParts.reduce((sum, v) => sum + Number(v || 0), 0) :
        (saleFee !== null || shippingFee !== null ? grossAmount - Number(saleFee || 0) - Number(shippingFee || 0) : null);
      const refundAmount = payments.reduce((sum, p) => sum + Number(p.total_refunded_amount || p.refunded_amount || 0), 0) ||
        Number(order.refund_amount || order.total_refunded_amount || 0);
      const billingDetail = billingByOrder.get(String(order.id));
      const officialFinance = parseOrderBilling(billingDetail, grossAmount);
      const finalSaleFee = officialFinance ? officialFinance.saleFee : saleFee;
      const finalShippingFee = officialFinance ? officialFinance.shippingFee : shippingFee;
      const otherFee = officialFinance ? officialFinance.otherFee : null;
      // 应回款只接受官方明确返回的净额；不能用销售额减费用伪造，也不能因取消直接强制归零。
      const paymentOfficialNet = netParts.length ? netParts.reduce((sum, value) => sum + Number(value || 0), 0) : null;
      const hasReversal = order.status === 'cancelled' || Number(refundAmount || 0) > 0;
      const officialLedgerNet = officialFinance?.hasOfficialLedger
        ? Number((grossAmount - Number(refundAmount || 0) + Number(officialFinance.ledgerDelta || 0)).toFixed(2))
        : null;
      const finalNetAmount = officialFinance?.netAmount ?? officialLedgerNet ?? (hasReversal ? null : paymentOfficialNet) ?? null;
      const orderCurrency = String(order.currency_id || '').toUpperCase();
      const usdRate = await getBillingFxRate(orderCurrency, 'USD');
      const grossAmountUsd = usdRate === null ? null : Number((grossAmount * usdRate).toFixed(2));
      const refundAmountUsd = usdRate === null ? null : Number((Number(refundAmount || 0) * usdRate).toFixed(2));
      const finalNetAmountUsd = finalNetAmount === null || usdRate === null ? null : Number((Number(finalNetAmount) * usdRate).toFixed(2));
      const previous = await pool.query('SELECT status,shipment_status FROM ml_orders WHERE ml_order_id=$1 AND (owner_username=$2 OR owner_username IS NULL)', [String(order.id),req.authUser.username]);
      await pool.query(`
        INSERT INTO ml_orders
          (ml_order_id,status,date_created,date_closed,buyer_id,buyer_nickname,currency,total_amount,paid_amount,shipping_id,items,raw_data,
           site_id,country,shipment_status,shipment_substatus,tracking_number,tracking_method,logistic_type,pack_id,handling_deadline,deadline_is_estimated,cancellation_reason,shipment_data,store_user_id,sale_fee,shipping_fee,net_amount,refund_amount,other_fee,billing_data,finance_is_official,finance_synced_at,owner_username,gross_amount_usd,net_amount_usd,refund_amount_usd,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26,$27,$28,$29,$30,$31::jsonb,$32,CASE WHEN $32 THEN NOW() ELSE NULL END,$33,$34,$35,$36,NOW())
        ON CONFLICT (ml_order_id) DO UPDATE SET
          status=EXCLUDED.status,date_closed=EXCLUDED.date_closed,buyer_id=EXCLUDED.buyer_id,
          buyer_nickname=EXCLUDED.buyer_nickname,currency=EXCLUDED.currency,total_amount=EXCLUDED.total_amount,
          paid_amount=EXCLUDED.paid_amount,shipping_id=EXCLUDED.shipping_id,items=EXCLUDED.items,
          raw_data=EXCLUDED.raw_data,site_id=EXCLUDED.site_id,country=EXCLUDED.country,
          shipment_status=EXCLUDED.shipment_status,shipment_substatus=EXCLUDED.shipment_substatus,
          tracking_number=EXCLUDED.tracking_number,tracking_method=EXCLUDED.tracking_method,
          logistic_type=EXCLUDED.logistic_type,pack_id=EXCLUDED.pack_id,
          handling_deadline=EXCLUDED.handling_deadline,deadline_is_estimated=EXCLUDED.deadline_is_estimated,
          cancellation_reason=EXCLUDED.cancellation_reason,shipment_data=EXCLUDED.shipment_data,
          store_user_id=EXCLUDED.store_user_id,sale_fee=EXCLUDED.sale_fee,shipping_fee=EXCLUDED.shipping_fee,
          net_amount=EXCLUDED.net_amount,refund_amount=EXCLUDED.refund_amount,other_fee=EXCLUDED.other_fee,
          billing_data=EXCLUDED.billing_data,finance_is_official=EXCLUDED.finance_is_official,
          finance_synced_at=EXCLUDED.finance_synced_at,owner_username=EXCLUDED.owner_username,
          gross_amount_usd=EXCLUDED.gross_amount_usd,net_amount_usd=EXCLUDED.net_amount_usd,
          refund_amount_usd=EXCLUDED.refund_amount_usd,updated_at=NOW()`,
        [String(order.id), order.status || '', order.date_created || null, order.date_closed || null,
          order.buyer?.id ? String(order.buyer.id) : null, order.buyer?.nickname || '', order.currency_id || '',
          order.total_amount || 0, order.paid_amount || 0, order.shipping?.id ? String(order.shipping.id) : null,
          JSON.stringify(orderItems), JSON.stringify(order), siteId, country, shipment.status || '', shipment.substatus || '',
          shipment.tracking_number || '', shipment.tracking_method || '', shipment.logistic?.type || shipment.logistic_type || '',
          order.pack_id ? String(order.pack_id) : String(order.id), handlingDeadline, !officialHandlingDeadline,
          String(cancellationReason).slice(0, 500), JSON.stringify(shipment), String(me.id || sellerId),
          finalSaleFee, finalShippingFee, finalNetAmount, refundAmount, otherFee, JSON.stringify(billingDetail || {}), Boolean(billingDetail),
          req.authUser.username, grossAmountUsd, finalNetAmountUsd, refundAmountUsd]
      );
      if (billingDetail) await saveOrderApiAudit(req.authUser.username,String(me.id || sellerId),String(order.id),'billing',String(order.id),billingDetail);
      if (Object.keys(shipment).length) await saveOrderApiAudit(req.authUser.username,String(me.id || sellerId),String(order.id),'shipment',String(order.shipping?.id || order.id),shipment);
      if (order._official_reputation) await saveOrderApiAudit(req.authUser.username,String(me.id || sellerId),String(order.id),'reputation',String(order.id),order._official_reputation);
      const old = previous.rows[0];
      if (!old) await pool.query(`INSERT INTO order_alerts(owner_username,order_id,alert_type,title,content,event_key) VALUES($1,$2,'new_order','收到新订单',$3,$4) ON CONFLICT(event_key) DO NOTHING`, [req.authUser.username,String(order.id), `${country || '未知站点'} · ${order.currency_id || ''} ${order.paid_amount || order.total_amount || 0}`, `new:${order.id}`]);
      if (order.status === 'cancelled' && old?.status !== 'cancelled') await pool.query(`INSERT INTO order_alerts(owner_username,order_id,alert_type,title,content,event_key) VALUES($1,$2,'cancelled','订单已取消',$3,$4) ON CONFLICT(event_key) DO NOTHING`, [req.authUser.username,String(order.id), `${country || '未知站点'}订单已被取消`, `cancelled:${order.id}`]);
      const deadlineFinished = refundAmount > 0 || ['cancelled','refunded'].includes(order.status) || ['shipped','delivered','cancelled'].includes(shipment.status);
      if (deadlineFinished) await pool.query(`UPDATE order_alerts SET is_read=TRUE
        WHERE owner_username=$1 AND order_id=$2 AND alert_type='deadline'`, [req.authUser.username,String(order.id)]);
      if (handlingDeadline && !deadlineFinished && new Date(handlingDeadline).getTime() > Date.now() && new Date(handlingDeadline).getTime() - Date.now() <= 86400000) {
        await pool.query(`INSERT INTO order_alerts(owner_username,order_id,alert_type,title,content,event_key) VALUES($1,$2,'deadline','订单即将延误',$3,$4) ON CONFLICT(event_key) DO NOTHING`, [req.authUser.username,String(order.id), `${officialHandlingDeadline ? '官方' : '预计'}待发货截止时间：${handlingDeadline}`, `deadline:${order.id}:${handlingDeadline}`]);
      }
      imported++;
    }
    res.json({ code: 0, data: { imported, available: response.data?.paging?.total || imported, sellerId, storeId: sellerId,
      account: { id: me.id, nickname: me.nickname || '', siteId: me.site_id || '', countryId: me.country_id || '',
        listings: listingsResponse?.data?.paging?.total ?? listingsResponse?.data?.results?.length ?? null } } });
  } catch (e) {
    console.error('[Orders] 同步失败:', e.response?.data || e.message);
    res.status(502).json({ code: 502, message: e.response?.data?.message || e.message });
  }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const params = [req.authUser.username], where = ['o.owner_username=$1'];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`o.status = $${params.length}`); }
  if (req.query.pushStatus) { params.push(String(req.query.pushStatus)); where.push(`o.push_status = $${params.length}`); }
  if (req.query.country) { params.push(String(req.query.country)); where.push(`o.country = $${params.length}`); }
  const fulfillmentStatus = String(req.query.fulfillmentStatus || req.query.shipmentStatus || '');
  if (fulfillmentStatus === 'cancelled') where.push(`o.status='cancelled'`);
  else if (fulfillmentStatus === 'refunded') where.push(`o.refund_amount>0`);
  else if (fulfillmentStatus) { params.push(fulfillmentStatus); where.push(`o.shipment_status = $${params.length}`); }
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`o.store_user_id = $${params.length}`); }
  if (req.query.buyer) { params.push(String(req.query.buyer)); where.push(`o.buyer_nickname = $${params.length}`); }
  if (req.query.orderId) { params.push(String(req.query.orderId).trim()); where.push(`COALESCE(NULLIF(o.pack_id,''),o.ml_order_id) = $${params.length}`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || ''))) { params.push(String(req.query.dateFrom)); where.push(`(o.date_created AT TIME ZONE 'Asia/Shanghai')::date >= $${params.length}::date`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || ''))) { params.push(String(req.query.dateTo)); where.push(`(o.date_created AT TIME ZONE 'Asia/Shanghai')::date <= $${params.length}::date`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(DISTINCT COALESCE(NULLIF(o.pack_id,''),o.ml_order_id))::int AS total FROM ml_orders o ${clause}`, params);
  params.push(size, (page - 1) * size);
  const rows = await pool.query(`WITH page_groups AS (
    SELECT COALESCE(NULLIF(o.pack_id,''),o.ml_order_id) AS display_id,MAX(o.date_created) AS group_date
    FROM ml_orders o ${clause} GROUP BY COALESCE(NULLIF(o.pack_id,''),o.ml_order_id)
    ORDER BY group_date DESC NULLS LAST LIMIT $${params.length-1} OFFSET $${params.length}
  ) SELECT o.ml_order_id AS "orderId",o.status,o.date_created AS "dateCreated",o.buyer_nickname AS buyer,o.currency,o.total_amount AS "totalAmount",o.paid_amount AS "paidAmount",o.gross_amount_usd AS "grossAmountUsd",o.net_amount_usd AS "netAmountUsd",o.refund_amount_usd AS "refundAmountUsd",o.shipping_id AS "shippingId",o.items,o.push_status AS "pushStatus",o.last_pushed_at AS "lastPushedAt",o.site_id AS "siteId",o.country,o.shipment_status AS "shipmentStatus",o.shipment_substatus AS "shipmentSubstatus",o.tracking_number AS "trackingNumber",o.tracking_method AS "trackingMethod",o.logistic_type AS "logisticType",o.pack_id AS "packId",o.handling_deadline AS "handlingDeadline",o.deadline_is_estimated AS "deadlineIsEstimated",o.cancellation_reason AS "cancellationReason",o.shipment_data AS "shipmentData",o.raw_data AS "rawData",o.store_user_id AS "storeId",COALESCE(NULLIF(s.remark,''),NULLIF(s.nickname,''),o.store_user_id,'未标记店铺') AS "storeName",s.nickname AS "storeNickname",s.remark AS "storeRemark",o.sale_fee AS "saleFee",o.shipping_fee AS "shippingFee",o.net_amount AS "netAmount",o.refund_amount AS "refundAmount",o.other_fee AS "otherFee",o.finance_is_official AS "financeIsOfficial",o.product_cost AS "productCost",o.cost_note AS "costNote"
    FROM page_groups pg JOIN ml_orders o ON COALESCE(NULLIF(o.pack_id,''),o.ml_order_id)=pg.display_id AND o.owner_username=$1
    LEFT JOIN ml_stores s ON s.ml_user_id=o.store_user_id ORDER BY pg.group_date DESC NULLS LAST,o.date_created`, params);
  const financeRows = rows.rows.length ? await pool.query('SELECT ml_order_id,billing_data FROM ml_orders WHERE owner_username=$2 AND ml_order_id=ANY($1::varchar[])', [rows.rows.map(row => row.orderId),req.authUser.username]) : { rows: [] };
  const financeMap = new Map(financeRows.rows.map(row => [row.ml_order_id, row.billing_data]));
  for (const row of rows.rows) {
    row.billingData = financeMap.get(row.orderId) || {};
    const reputation = extractReputationInfo(row.rawData);
    row.reputationImpact = reputation.impact;
    row.reputationReason = reputation.reason;
    row.reputationFeedback = reputation.feedback;
    row.reputationResponsibility = reputation.responsibility;
    row.reputationAdvice = reputation.advice;
    row.reputationSource = reputation.source;
    delete row.rawData;
  }
  const packedRows = await aggregatePackedOrders(rows.rows);
  res.json({ code: 0, data: { items: packedRows, total: count.rows[0].total, page, size } });
});

app.get('/api/admin/order-stores', requireAdmin, async (req, res) => {
  await listOrderStoreAuthorizations(req.authUser);
  const { rows } = await pool.query(`SELECT a.ml_user_id AS id,COALESCE(NULLIF(s.nickname,''),a.nickname) AS nickname,s.remark,
    COALESCE(NULLIF(s.remark,''),NULLIF(s.nickname,''),NULLIF(a.nickname,''),a.ml_user_id) AS "displayName",
    COALESCE(NULLIF(s.site_id,''),a.site_id) AS "siteId",COUNT(o.id)::int AS "orderCount"
    FROM ml_store_authorizations a LEFT JOIN ml_stores s ON s.ml_user_id=a.ml_user_id
    LEFT JOIN ml_orders o ON o.store_user_id=a.ml_user_id AND o.owner_username=a.owner_username
    WHERE a.owner_username=$1 AND a.enabled=TRUE
    GROUP BY a.ml_user_id,a.nickname,a.site_id,s.nickname,s.remark,s.site_id ORDER BY "displayName"`, [req.authUser.username]);
  res.json({ code: 0, data: rows });
});

async function ensureLegacyStoreAuthorization(authUser) {
  const existing = await pool.query('SELECT * FROM ml_store_authorizations WHERE owner_username=$1 AND enabled=TRUE ORDER BY updated_at DESC LIMIT 1', [authUser.username]);
  if (existing.rows[0] || authUser.role !== 'admin') return existing.rows[0] || null;
  const accessToken = await getMLAccessToken();
  if (!accessToken) return null;
  const refreshToken = await getMLRefreshToken();
  return saveStoreAuthorization(authUser.username, {
    access_token: accessToken,
    refresh_token: refreshToken || '',
    expires_in: 3600
  }).then(async store => {
    const result = await pool.query('SELECT * FROM ml_store_authorizations WHERE owner_username=$1 AND ml_user_id=$2', [authUser.username, store.mlUserId]);
    return result.rows[0] || null;
  });
}

app.get('/api/marketing/accounts', requireAuth, async (req, res) => {
  await ensureLegacyStoreAuthorization(req.authUser);
  const params = [], where = ['enabled=TRUE'];
  if (req.authUser.role !== 'admin') { params.push(req.authUser.username); where.push(`owner_username=$${params.length}`); }
  const { rows } = await pool.query(`SELECT ml_user_id AS id,nickname,site_id AS "siteId",updated_at AS "authorizedAt"
    FROM ml_store_authorizations WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params);
  res.json({ code: 0, data: rows });
});

const marketingCache = new Map();
const marketingItemCache = new Map();
const promotionNameTranslationCache = new Map();
const productAdsCache = new Map();
const productAdsAnalyticsCache = new Map();
const marketingProductsCache = new Map();
const promotionPageCursorCache = new Map();
const promotionItemsPageCache = new Map();
const MARKETING_CACHE_TTL = 60 * 1000;
const MARKETING_ITEM_CACHE_TTL = 10 * 60 * 1000;
const MARKETING_PRODUCTS_CACHE_TTL = 3 * 60 * 1000;

function marketingItemThumbnail(detail) {
  const value = detail?.secure_thumbnail || detail?.thumbnail || detail?.pictures?.[0]?.secure_url || detail?.pictures?.[0]?.url || '';
  return String(value).replace(/^http:\/\//i, 'https://');
}

function hasMarketingItemPresentation(detail) {
  return Boolean(detail?.title && marketingItemThumbnail(detail));
}
const PROMOTION_NAME_ZH_OVERRIDES = new Map([
  ['AON Home Industries', '家居行业全场优惠'],
  ['Best Shared Offers Jul!', '7月精选共享优惠'],
  ['Cyber Days', '网络购物节'],
  ['DD 8/8 Mega Ofertas', '8·8超级优惠'],
  ['Best Shared Offers Ago!', '8月精选共享优惠'],
  ['8.8 e Dia dos Pais', '8·8及父亲节优惠'],
  ['Activa Tus Descuentos', '开启你的折扣'],
  ['Shared Offers Jul Massive', '7月全场共享优惠'],
  ['T2 OFERTAZOS JULIO 2026', '2026年7月第二期超级优惠'],
  ['DIA DEL NINO 2026', '2026儿童节优惠'],
  ['Liqui moda invierno 2026', '2026冬季时尚清仓'],
  ['Dia de la ninez 2026', '2026儿童节优惠'],
  ['Black week julio 2026', '2026年7月黑色促销周']
]);

function readTimedCache(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.time > ttl) {
    if (entry) cache.delete(key);
    return null;
  }
  return entry.data;
}

function writeTimedCache(cache, key, data, maxEntries) {
  cache.set(key, { data, time: Date.now() });
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  return data;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return results;
}

async function translatePromotionName(name) {
  const original = String(name || '').trim();
  if (!original || /[\u3400-\u9fff]/.test(original)) return original;
  if (PROMOTION_NAME_ZH_OVERRIDES.has(original)) return PROMOTION_NAME_ZH_OVERRIDES.get(original);
  const cached = readTimedCache(promotionNameTranslationCache, original, 30 * 24 * 60 * 60 * 1000);
  if (cached) return cached;
  try {
    const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', q: original },
      timeout: 8000
    });
    const translated = Array.isArray(response.data?.[0])
      ? response.data[0].map(part => part?.[0] || '').join('').trim()
      : '';
    const result = translated || original;
    writeTimedCache(promotionNameTranslationCache, original, result, 1000);
    return result;
  } catch (error) {
    console.warn('[Marketing] 活动名称翻译失败:', original, error.message);
    return original;
  }
}

async function addChinesePromotionNames(promotions) {
  return mapWithConcurrency(promotions, 3, async promotion => ({
    ...promotion,
    nameZh: await translatePromotionName(promotion.name)
  }));
}

function getPromotionHeaders(token) {
  const headers = { Authorization: `Bearer ${token}`, version: 'v2' };
  if (ML_CLIENT_ID) {
    headers['X-Client-Id'] = ML_CLIENT_ID;
    headers['X-Caller-Id'] = ML_CLIENT_ID;
  }
  return headers;
}

function getProductAdsHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'api-version': '2' };
}

function getAdvertisingCenterUrl(siteId) {
  return ({
    MCO: 'https://www.mercadolibre.com.co/publicidad',
    MLB: 'https://www.mercadolivre.com.br/publicidade',
    MLM: 'https://www.mercadolibre.com.mx/publicidad',
    MLA: 'https://www.mercadolibre.com.ar/publicidad',
    MLC: 'https://www.mercadolibre.cl/publicidad'
  })[siteId] || 'https://www.mercadolibre.com/';
}

function productAdsDateRange(days) {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - (days - 1) * 86400000);
  return { dateFrom: dateFrom.toISOString().slice(0, 10), dateTo: dateTo.toISOString().slice(0, 10) };
}

function normalizeAdMetrics(metrics = {}) {
  return {
    impressions: Number(metrics.prints || 0),
    clicks: Number(metrics.clicks || 0),
    cost: Number(metrics.cost || 0),
    sales: Number(metrics.total_amount || 0),
    units: Number(metrics.units_quantity || 0)
  };
}

function addAdMetrics(target, metrics) {
  target.impressions += metrics.impressions;
  target.clicks += metrics.clicks;
  target.cost += metrics.cost;
  target.sales += metrics.sales;
  target.units += metrics.units;
}

function finalizeAdMetrics(metrics) {
  return {
    ...metrics,
    ctr: metrics.impressions ? metrics.clicks / metrics.impressions * 100 : 0,
    cpc: metrics.clicks ? metrics.cost / metrics.clicks : 0,
    acos: metrics.sales ? metrics.cost / metrics.sales * 100 : 0,
    roas: metrics.cost ? metrics.sales / metrics.cost : 0
  };
}

function extractAdvertiserUserId(advertiser) {
  const direct = advertiser?.user_id || advertiser?.seller_id || advertiser?.account_id || advertiser?.user?.id || advertiser?.seller?.id || advertiser?.account?.user_id;
  if (direct && /^\d+$/.test(String(direct))) return String(direct);
  const match = String(advertiser?.account_name || '').match(/(?:ID\s*-\s*)?(\d+)\s*$/i);
  return match?.[1] || '';
}

async function resolveMarketingAuthorization(authUser, storeId) {
  let auth = await findScopedStoreAuthorization(authUser, storeId);
  if (!auth) auth = await ensureLegacyStoreAuthorization(authUser);
  if (!auth) {
    const error = new Error('未找到已授权的美客多账号');
    error.statusCode = 404;
    throw error;
  }
  const token = await getStoreAuthorizationToken(auth);
  if (!token) {
    const error = new Error('账号授权已失效，请重新授权');
    error.statusCode = 401;
    throw error;
  }
  return { auth, token };
}

async function loadMarketingSites(auth, token, force = false) {
  const cacheKey = `sites:${auth.ml_user_id}`;
  if (!force) {
    const cached = readTimedCache(marketingCache, cacheKey, MARKETING_CACHE_TTL);
    if (cached) return cached;
  }
  const response = await axios.get('https://api.mercadolibre.com/advertising/advertisers', {
    params: { product_id: 'PADS', type: 'SELLER' },
    headers: { Authorization: `Bearer ${token}`, 'api-version': '1' },
    timeout: 20000
  });
  const sites = (response.data?.advertisers || []).map(advertiser => ({
    siteId: String(advertiser.site_id || ''),
    userId: extractAdvertiserUserId(advertiser),
    advertiserId: advertiser.advertiser_id,
    advertiserName: advertiser.advertiser_name || '',
    accountName: advertiser.account_name || ''
  })).filter(site => site.siteId && site.userId);
  return writeTimedCache(marketingCache, cacheKey, sites, 50);
}

async function loadPromotionSites(auth, token, force = false) {
  const cacheKey = `promotion-sites:${auth.ml_user_id}`;
  if (!force) {
    const cached = readTimedCache(marketingCache, cacheKey, 5 * 60 * 1000);
    if (cached) return cached;
  }
  const supportedSiteIds = new Set(['MLM', 'MLB', 'MLC', 'MCO', 'MLA']);
  const discovered = [];
  const directSiteId = String(auth.site_id || '').toUpperCase();
  if (directSiteId && directSiteId !== 'CBT') {
    discovered.push({ siteId: directSiteId, userId: String(auth.ml_user_id), source: 'authorization', logisticType: '', pricingModel: '' });
  }
  if (directSiteId === 'CBT') {
    const response = await axios.get(`https://api.mercadolibre.com/marketplace/users/${encodeURIComponent(auth.ml_user_id)}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    });
    for (const marketplace of Array.isArray(response.data?.marketplaces) ? response.data.marketplaces : []) {
      const siteId = String(marketplace.site_id || '').toUpperCase();
      const userId = String(marketplace.user_id || '');
      if (!supportedSiteIds.has(siteId) || !/^\d+$/.test(userId)) continue;
      discovered.push({
        siteId,
        userId,
        source: 'marketplace-identity',
        logisticType: String(marketplace.logistic_type || ''),
        pricingModel: String(marketplace.pricing_model || ''),
        businessModel: String(marketplace.business_model || '')
      });
    }
  }
  const unique = [...new Map(discovered.map(site => [`${site.siteId}:${site.userId}`, site])).values()]
    .sort((a, b) => {
      const order = ['MLM', 'MLB', 'MLC', 'MCO', 'MLA'];
      const siteOrder = order.indexOf(a.siteId) - order.indexOf(b.siteId);
      if (siteOrder) return siteOrder;
      if (a.logisticType === b.logisticType) return 0;
      return a.logisticType === 'remote' ? -1 : 1;
    });
  return writeTimedCache(marketingCache, cacheKey, unique, 50);
}

async function loadSitePromotions(token, site, force = false) {
  const cacheKey = `promotions:${site.siteId}:${site.userId}`;
  if (!force) {
    const cached = readTimedCache(marketingCache, cacheKey, MARKETING_CACHE_TTL);
    if (cached) return cached;
  }
  const response = await axios.get(`https://api.mercadolibre.com/marketplace/seller-promotions/users/${encodeURIComponent(site.userId)}`, {
    headers: getPromotionHeaders(token),
    timeout: 20000
  });
  let promotions = Array.isArray(response.data?.results) ? response.data.results : [];
  promotions = promotions.filter(promotion => {
    const promotionSite = String(promotion.id || '').toUpperCase().match(/(?:^|-)(MLM|MLB|MLC|MCO|MLA)(?:\d|$)/)?.[1];
    if (promotionSite) return promotionSite === site.siteId;
    return true;
  });
  return writeTimedCache(marketingCache, cacheKey, promotions, 50);
}

async function resolvePromotionSite(sites, token, siteId, promotionId, promotionType) {
  const matchingSites = sites.filter(site => site.siteId === siteId);
  for (const site of matchingSites) {
    try {
      const promotions = await loadSitePromotions(token, site);
      if (promotions.some(item => String(item.id) === promotionId && String(item.type).toUpperCase() === promotionType)) return { site, promotions };
    } catch {}
  }
  return { site: matchingSites[0] || null, promotions: [] };
}

function marketingApiError(error, fallback) {
  const data = error.response?.data;
  if (error.response?.status === 404 || /^(not_found|not found)$/i.test(String(data?.message || data?.error || ''))) return '美客多未找到对应资源。活动报名与广告账户相互独立；请刷新国家店铺身份和活动列表后重试';
  if (/ad group with status hold can'?t be updated/i.test(String(data?.message || data?.error || ''))) return '该广告组处于平台锁定（HOLD）状态，暂时不能激活、暂停或调整活动；请等待美客多解除限制后再操作';
  if (/target campaign not allowed/i.test(String(data?.message || data?.error || ''))) return '美客多不允许该广告组执行目标活动操作；请先刷新真实归属，若仍失败可暂停广告但不能从该受保护活动移除';
  const cause = Array.isArray(data?.cause) ? data.cause.map(item => item?.message || item?.code).filter(Boolean).join('；') : '';
  if (error.response?.status === 429) return '美客多接口请求过于频繁，请稍后重试';
  return cause || data?.message || data?.error || error.message || fallback;
}

app.get('/api/marketing/capabilities', requireAuth, async (req, res) => {
  try {
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.query.storeId);
    const force = String(req.query.force || '') === '1';
    const promotionSites = await loadPromotionSites(auth, token, force);
    const siteResults = await mapWithConcurrency(promotionSites, 3, async site => {
      try {
        const promotions = await addChinesePromotionNames(await loadSitePromotions(token, site, force));
        return { ...site, supported: true, promotions };
      } catch (error) {
        return { ...site, supported: false, message: marketingApiError(error, '活动接口不可用'), promotions: [] };
      }
    });
    const promotions = siteResults.flatMap(site => site.promotions.map(promotion => ({
      ...promotion,
      siteId: site.siteId,
      userId: site.userId,
      logisticType: site.logisticType || '',
      pricingModel: site.pricingModel || ''
    })));
    const countrySites = [...new Set(siteResults.map(site => site.siteId))];
    const connectedSites = [...new Set(siteResults.filter(site => site.supported).map(site => site.siteId))];
    const groupedSites = countrySites.map(siteId => {
      const accounts = siteResults.filter(site => site.siteId === siteId);
      const working = accounts.filter(site => site.supported);
      return {
        siteId,
        userId: (working[0] || accounts[0])?.userId || '',
        supported: working.length > 0,
        message: working.length ? '' : accounts.map(site => site.message).filter(Boolean)[0] || '',
        source: 'marketplace-identity',
        accountCount: accounts.length,
        promotionCount: new Set(accounts.flatMap(site => site.promotions.map(promotion => `${promotion.id}:${promotion.type}`))).size
      };
    });
    let advertisingSites = [];
    try { advertisingSites = await loadMarketingSites(auth, token, force); } catch {}
    const advertisers = advertisingSites.map(site => ({
      advertiserId: site.advertiserId,
      siteId: site.siteId,
      advertiserName: site.advertiserName,
      accountName: site.accountName
    }));
    res.json({ code: 0, data: {
      account: { id: auth.ml_user_id, nickname: auth.nickname, siteId: auth.site_id },
      promotions: {
        supported: siteResults.some(site => site.supported),
        status: siteResults.some(site => site.supported) ? 200 : 403,
        message: `已识别 ${connectedSites.length} 个国家子店铺，读取 ${promotions.length} 个活动；活动权限与广告账户完全独立`,
        items: promotions,
        sites: groupedSites
      },
      productAds: {
        supported: advertisers.length > 0,
        status: advertisers.length ? 200 : 404,
        message: advertisers.length ? `已读取 ${advertisers.length} 个广告账户` : '尚未开通任何国家的商品广告账户，不影响批量报名活动',
        advertisers
      }
    } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '营销接口读取失败') });
  }
});

app.get('/api/marketing/product-ads/overview', requireAuth, async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const force = String(req.query.force || '') === '1';
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.query.storeId);
    const cacheKey = `product-ads-overview:${auth.ml_user_id}:${days}`;
    if (!force) {
      const cached = readTimedCache(productAdsCache, cacheKey, MARKETING_CACHE_TTL);
      if (cached) return res.json({ code: 0, data: cached });
    }
    const sites = await loadMarketingSites(auth, token, force);
    const { dateFrom, dateTo } = productAdsDateRange(days);
    const metricNames = 'clicks,prints,cost,ctr,cpc,acos,roas,total_amount,units_quantity';
    const accounts = await mapWithConcurrency(sites, 2, async site => {
      const base = `https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(site.siteId)}/advertisers/${encodeURIComponent(site.advertiserId)}/product_ads`;
      try {
        const params = { limit: 50, offset: 0, date_from: dateFrom, date_to: dateTo, metrics: metricNames };
        const [campaignResponse, productResponse] = await Promise.all([
          axios.get(`${base}/campaigns/search`, { params, headers: getProductAdsHeaders(token), timeout: 25000 }),
          axios.get(`${base}/ads/search`, { params: { ...params, limit: 1 }, headers: getProductAdsHeaders(token), timeout: 25000 })
        ]);
        const rawCampaigns = Array.isArray(campaignResponse.data?.results) ? campaignResponse.data.results : [];
        const totals = { impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0 };
        const campaigns = rawCampaigns.map(campaign => {
          const metrics = normalizeAdMetrics(campaign.metrics);
          addAdMetrics(totals, metrics);
          return {
            id: campaign.id,
            name: campaign.name || '',
            status: campaign.status || '',
            budget: Number(campaign.budget || 0),
            currencyId: campaign.currency_id || 'USD',
            strategy: campaign.strategy || '',
            roasTarget: Number(campaign.roas_target || 0),
            lastUpdated: campaign.last_updated || '',
            metrics: finalizeAdMetrics(metrics)
          };
        });
        return {
          ...site,
          available: true,
          advertisingUrl: getAdvertisingCenterUrl(site.siteId),
          campaignTotal: Number(campaignResponse.data?.paging?.total || campaigns.length),
          activeCampaigns: campaigns.filter(item => item.status === 'active').length,
          pausedCampaigns: campaigns.filter(item => item.status === 'paused').length,
          productTotal: Number(productResponse.data?.paging?.total || 0),
          metrics: finalizeAdMetrics(totals),
          campaigns
        };
      } catch (error) {
        return { ...site, available: false, advertisingUrl: getAdvertisingCenterUrl(site.siteId), message: marketingApiError(error, '广告数据读取失败'), campaignTotal: 0, activeCampaigns: 0, pausedCampaigns: 0, productTotal: 0, metrics: finalizeAdMetrics({ impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0 }), campaigns: [] };
      }
    });
    const summaryBase = { impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0 };
    accounts.forEach(account => addAdMetrics(summaryBase, account.metrics));
    const result = {
      dateFrom, dateTo,
      summary: {
        accountTotal: accounts.length,
        campaignTotal: accounts.reduce((sum, item) => sum + item.campaignTotal, 0),
        activeCampaigns: accounts.reduce((sum, item) => sum + item.activeCampaigns, 0),
        productTotal: accounts.reduce((sum, item) => sum + item.productTotal, 0),
        metrics: finalizeAdMetrics(summaryBase)
      },
      accounts
    };
    writeTimedCache(productAdsCache, cacheKey, result, 50);
    res.json({ code: 0, data: result });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '广告数据读取失败') });
  }
});

app.get('/api/marketing/product-ads/analytics', requireAuth, async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const siteId = String(req.query.siteId || '').trim().toUpperCase();
    const campaignId = String(req.query.campaignId || '').trim();
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.query.storeId);
    const cacheKey = `product-ads-analytics:${auth.ml_user_id}:${siteId || 'all'}:${campaignId || 'all'}:${days}`;
    const cached = readTimedCache(productAdsAnalyticsCache, cacheKey, 5 * 60 * 1000);
    if (cached) return res.json({ code: 0, data: cached });
    const sites = (await loadMarketingSites(auth, token)).filter(site => !siteId || site.siteId === siteId);
    if (!sites.length) return res.status(404).json({ code: 404, message: '未找到对应国家广告账户' });
    const step = days === 90 ? 7 : 1;
    const end = new Date();
    const ranges = [];
    for (let offset = days - 1; offset >= 0; offset -= step) {
      const from = new Date(end.getTime() - offset * 86400000);
      const to = new Date(Math.min(end.getTime(), from.getTime() + (step - 1) * 86400000));
      ranges.push({ dateFrom: from.toISOString().slice(0, 10), dateTo: to.toISOString().slice(0, 10) });
    }
    const points = await mapWithConcurrency(ranges, 3, async range => {
      const totals = { impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0 };
      await mapWithConcurrency(sites, 2, async site => {
        try {
          const base = `https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(site.siteId)}/advertisers/${encodeURIComponent(site.advertiserId)}/product_ads/campaigns/search`;
          const response = await axios.get(base, { params: { limit: 50, offset: 0, date_from: range.dateFrom, date_to: range.dateTo, metrics: 'clicks,prints,cost,total_amount,units_quantity' }, headers: getProductAdsHeaders(token), timeout: 25000 });
          for (const campaign of response.data?.results || []) {
            if (!campaignId || String(campaign.id) === campaignId) addAdMetrics(totals, normalizeAdMetrics(campaign.metrics));
          }
        } catch (error) { console.warn('[Marketing] 广告趋势数据读取失败:', site.siteId, range.dateFrom, error.message); }
      });
      return { date: range.dateFrom, dateTo: range.dateTo, ...finalizeAdMetrics(totals) };
    });
    const result = { days, step, siteId: siteId || null, campaignId: campaignId || null, points };
    writeTimedCache(productAdsAnalyticsCache, cacheKey, result, 100);
    res.json({ code: 0, data: result });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '广告趋势报告读取失败') });
  }
});

app.get('/api/marketing/products', requireAuth, async (req, res) => {
  try {
    const siteId = String(req.query.siteId || '').trim().toUpperCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(30, Math.max(1, Number(req.query.size) || 20));
    const keyword = String(req.query.keyword || '').trim().toLowerCase();
    const force = String(req.query.force || '') === '1';
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.query.storeId);
    const sites = await loadPromotionSites(auth, token, force);
    const siteAccounts = sites.filter(item => item.siteId === siteId);
    if (!siteAccounts.length) return res.status(403).json({ code: 403, message: '该国家店铺不属于当前授权账户' });
    const cacheKey = `marketing-products:${auth.ml_user_id}:${siteId}:${page}:${size}`;
    let workspace = force ? null : readTimedCache(marketingProductsCache, cacheKey, MARKETING_PRODUCTS_CACHE_TTL);
    if (!workspace) {
      let itemIds = [];
      let itemTotal = 0;
      const source = 'marketplace-online-items';
      const accountStats = await mapWithConcurrency(siteAccounts, 2, async account => {
        try {
          const response = await axios.get(`https://api.mercadolibre.com/marketplace/users/${encodeURIComponent(account.userId)}/items/search`, {
            params: { status: 'active', limit: 1, offset: 0 },
            headers: { Authorization: `Bearer ${token}` }, timeout: 20000
          });
          return { account, total: Number(response.data?.paging?.total || 0) };
        } catch (error) {
          return { account, total: -1, error };
        }
      });
      const bestAccount = accountStats.sort((a, b) => b.total - a.total)[0];
      if (!bestAccount || bestAccount.total < 0) throw bestAccount?.error || new Error('无法读取国家店铺商品');
      const site = bestAccount.account;
      const searchResponse = await axios.get(`https://api.mercadolibre.com/marketplace/users/${encodeURIComponent(site.userId)}/items/search`, {
        params: { status: 'active', limit: size, offset: (page - 1) * size },
        headers: { Authorization: `Bearer ${token}` }, timeout: 25000
      });
      itemIds = Array.isArray(searchResponse.data?.results) ? searchResponse.data.results.map(String) : [];
      itemTotal = Number(searchResponse.data?.paging?.total || itemIds.length);
      const products = await mapWithConcurrency(itemIds, 4, async itemId => {
        const detailKey = `item:${itemId}`;
        let detail = readTimedCache(marketingItemCache, detailKey, MARKETING_ITEM_CACHE_TTL);
        if (!hasMarketingItemPresentation(detail)) {
          try {
            const detailResponse = await axios.get(`https://api.mercadolibre.com/marketplace/items/${encodeURIComponent(itemId)}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
            detail = writeTimedCache(marketingItemCache, detailKey, detailResponse.data || {}, 500);
          } catch { detail = {}; }
        }
        let promotions = [];
        try {
          const promotionResponse = await axios.get(`https://api.mercadolibre.com/marketplace/seller-promotions/items/${encodeURIComponent(itemId)}`, {
            params: { user_id: site.userId }, headers: getPromotionHeaders(token), timeout: 15000
          });
          promotions = Array.isArray(promotionResponse.data) ? promotionResponse.data : [];
        } catch {}
        return {
          itemId,
          cbtItemId: detail.cbt_item_id || '',
          title: detail.title || itemId,
          thumbnail: marketingItemThumbnail(detail),
          permalink: detail.permalink || '',
          price: Number(detail.price || 0),
          currency: detail.currency_id || 'USD',
          stock: Number(detail.available_quantity || 0),
          status: detail.status || 'active',
          eligiblePromotions: promotions.filter(item => item.status === 'candidate' && item.id).map(item => {
            const offer = Array.isArray(item.offers) ? (item.offers.find(entry => entry?.status === 'candidate') || item.offers[0] || {}) : {};
            return { id: item.id, type: item.type || '', name: item.name || '', offerId: item.offer_id || item.candidate_id || offer.id || '', activityPrice: Number(item.price || item.deal_price || offer.price || offer.deal_price || offer.new_price || 0), platformDiscountPercent: Number(item.discount_percentage || offer.discount_percentage || 0), minPrice: Number(item.min_discounted_price || 0), maxPrice: Number(item.max_discounted_price || 0), suggestedPrice: Number(item.suggested_discounted_price || 0) };
          }),
          joinedPromotions: promotions.filter(item => item.status === 'started' && item.id).map(item => ({ id: item.id, type: item.type || '', name: item.name || '' })),
          ad: null
        };
      });
      let advertisingSite = null;
      try { advertisingSite = (await loadMarketingSites(auth, token, force)).find(item => item.siteId === siteId) || null; } catch {}
      if (itemIds.length && advertisingSite) {
        await mapWithConcurrency(products, 5, async product => {
          try {
            const adResponse = await axios.get(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/advertisers/${encodeURIComponent(advertisingSite.advertiserId)}/product_ads/ad_groups/search`, {
              params: { 'filters[item_ids]': product.itemId, limit: 10, offset: 0 },
              headers: getProductAdsHeaders(token), timeout: 12000
            });
            const ad = adResponse.data?.results?.[0];
            if (ad) product.ad = { id: ad.id, campaignId: ad.campaign_id || null, status: String(ad.status || 'idle').toLowerCase() };
          } catch (error) {
            console.warn('[Marketing] 商品广告状态读取失败:', product.itemId, error.message);
          }
        });
      }
      workspace = { products, total: itemTotal, page, size, siteId, source, advertisingUrl: getAdvertisingCenterUrl(siteId) };
      writeTimedCache(marketingProductsCache, cacheKey, workspace, 100);
    }
    const filtered = keyword
      ? workspace.products.filter(item => `${item.title} ${item.itemId} ${item.cbtItemId}`.toLowerCase().includes(keyword))
      : workspace.products;
    res.json({ code: 0, data: { ...workspace, products: filtered, pageFiltered: Boolean(keyword) } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '店铺营销商品读取失败') });
  }
});

app.put('/api/marketing/product-ads/ad-groups/:adGroupId', requireAuth, async (req, res) => {
  try {
    const adGroupId = String(req.params.adGroupId || '').trim();
    const siteId = String(req.body?.siteId || '').trim().toUpperCase();
    const status = String(req.body?.status || '').trim().toLowerCase();
    const campaignId = String(req.body?.campaignId || '').trim();
    if (!adGroupId || !siteId || !campaignId) return res.status(400).json({ code: 400, message: '请选择商品、国家和广告活动' });
    if (!['active', 'paused'].includes(status)) return res.status(400).json({ code: 400, message: '广告状态只能设置为投放中或暂停' });
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.body?.storeId);
    const sites = await loadMarketingSites(auth, token);
    const site = sites.find(item => item.siteId === siteId);
    if (!site) return res.status(403).json({ code: 403, message: '该国家广告账户不属于当前授权店铺' });
    const campaignResponse = await axios.get(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/advertisers/${encodeURIComponent(site.advertiserId)}/product_ads/campaigns/search`, {
      params: { limit: 50, offset: 0 }, headers: getProductAdsHeaders(token), timeout: 20000
    });
    if (!(campaignResponse.data?.results || []).some(item => String(item.id) === campaignId)) {
      return res.status(400).json({ code: 400, message: '所选广告活动不存在或不属于该国家账户' });
    }
    const response = await axios.put(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/product_ads/ad_groups/${encodeURIComponent(adGroupId)}`, {
      status, campaign_id: Number(campaignId)
    }, { headers: { ...getProductAdsHeaders(token), 'Content-Type': 'application/json' }, timeout: 25000 });
    for (const key of productAdsCache.keys()) if (key.startsWith(`product-ads-overview:${auth.ml_user_id}:`)) productAdsCache.delete(key);
    for (const key of marketingProductsCache.keys()) if (key.startsWith(`marketing-products:${auth.ml_user_id}:${siteId}:`)) marketingProductsCache.delete(key);
    res.json({ code: 0, message: '商品广告已由美客多确认更新', data: { adGroupId, status: response.data?.status || status, campaignId: response.data?.campaign_id || Number(campaignId) } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '商品广告更新失败') });
  }
});

app.get('/api/marketing/product-ads/products', requireAuth, async (req, res) => {
  try {
    const siteId = String(req.query.siteId || '').trim().toUpperCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(50, Math.max(1, Number(req.query.size) || 20));
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.query.storeId);
    const sites = await loadMarketingSites(auth, token);
    const site = sites.find(item => item.siteId === siteId);
    if (!site) return res.status(403).json({ code: 403, message: '该国家广告账户不属于当前授权店铺' });
    const { dateFrom, dateTo } = productAdsDateRange(days);
    const base = `https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(site.siteId)}/advertisers/${encodeURIComponent(site.advertiserId)}/product_ads`;
    const response = await axios.get(`${base}/ads/search`, {
      params: { limit: size, offset: (page - 1) * size, date_from: dateFrom, date_to: dateTo, metrics: 'clicks,prints,cost,ctr,cpc,acos,roas,total_amount,units_quantity' },
      headers: getProductAdsHeaders(token), timeout: 25000
    });
    const products = (response.data?.results || []).map(item => ({
      itemId: item.item_id || '', campaignId: item.campaign_id || '', adGroupId: item.ad_group_id || '',
      title: item.title || item.item_id || '', status: item.status || '', thumbnail: item.thumbnail || '',
      permalink: item.permalink || '', price: Number(item.price_usd ?? item.price ?? 0),
      metrics: finalizeAdMetrics(normalizeAdMetrics(item.metrics))
    }));
    res.json({ code: 0, data: { products, total: Number(response.data?.paging?.total || products.length), page, size } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '广告商品读取失败') });
  }
});

app.get('/api/marketing/product-ads/campaign-products', requireAuth, async (req, res) => {
  try {
    const siteId = String(req.query.siteId || '').trim().toUpperCase();
    const campaignId = String(req.query.campaignId || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(50, Math.max(1, Number(req.query.size) || 20));
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    if (!siteId || !campaignId) return res.status(400).json({ code: 400, message: '请选择广告活动' });
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.query.storeId);
    const sites = await loadMarketingSites(auth, token);
    const site = sites.find(item => item.siteId === siteId);
    if (!site) return res.status(403).json({ code: 403, message: '该国家广告账户不属于当前授权店铺' });
    const { dateFrom, dateTo } = productAdsDateRange(days);
    const groupResponse = await axios.get(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/advertisers/${encodeURIComponent(site.advertiserId)}/product_ads/ad_groups/search`, {
      params: { 'filters[campaign_id]': campaignId, limit: size, offset: (page - 1) * size },
      headers: getProductAdsHeaders(token), timeout: 25000
    });
    const groups = (groupResponse.data?.results || []).filter(group => String(group.campaign_id || '') === campaignId);
    const groupProducts = await mapWithConcurrency(groups, 4, async group => {
      try {
        const response = await axios.get(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/product_ads/ad_groups/${encodeURIComponent(group.id)}/ads`, {
          params: { date_from: dateFrom, date_to: dateTo, metrics: 'clicks,prints,cost,acos,roas,total_amount' },
          headers: getProductAdsHeaders(token), timeout: 20000
        });
        const ads = Array.isArray(response.data?.results) ? response.data.results : [];
        const holdReason = group.status_detail || group.status_reason || group.reason || (Array.isArray(group.issues) ? group.issues.map(issue => issue.message || issue.code).filter(Boolean).join('；') : '') || '';
        if (!ads.length) return [{ itemId: group.ad_group_external_id || '', title: group.title || `广告组 ${group.id}`, status: String(group.status || '').toLowerCase(), holdReason, thumbnail: '', permalink: '', price: 0, adGroupId: group.id, campaignId: Number(campaignId), adGroupType: group.ad_group_type || '', variantCount: 0, metrics: finalizeAdMetrics({ impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0 }) }];
        return ads.map(ad => ({
          itemId: ad.item_id || ad.user_product_id || String(group.ad_group_external_id || ''),
          title: ad.title || ad.user_product_name || group.title || '',
          status: String(group.status || ad.status || '').toLowerCase(), holdReason,
          thumbnail: ad.thumbnail || '', permalink: ad.permalink || '', price: Number(ad.price || 0),
          adGroupId: group.id, campaignId: Number(group.campaign_id || campaignId), adGroupType: group.ad_group_type || '',
          variantCount: ads.length, metrics: finalizeAdMetrics(normalizeAdMetrics(ad.metrics))
        }));
      } catch (error) {
        return [{ itemId: group.ad_group_external_id || '', title: group.title || `广告组 ${group.id}`, status: String(group.status || '').toLowerCase(), thumbnail: '', permalink: '', price: 0, adGroupId: group.id, campaignId: Number(campaignId), adGroupType: group.ad_group_type || '', variantCount: 0, message: marketingApiError(error, '组内商品读取失败'), metrics: finalizeAdMetrics({ impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0 }) }];
      }
    });
    let products = groupProducts.flat();
    const itemIds = [...new Set(products.map(product => String(product.itemId || '')).filter(id => /^ML[A-Z]\d+$/i.test(id)))];
    const itemDetails = new Map();
    await mapWithConcurrency(itemIds, 4, async itemId => {
      const detailKey = `item:${itemId}`;
      let detail = readTimedCache(marketingItemCache, detailKey, MARKETING_ITEM_CACHE_TTL);
      if (!detail) {
        try {
          const detailResponse = await axios.get(`https://api.mercadolibre.com/marketplace/items/${encodeURIComponent(itemId)}`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 15000
          });
          detail = writeTimedCache(marketingItemCache, detailKey, detailResponse.data || {}, 500);
        } catch (error) {
          console.warn('[Marketing] CBT 商品资料补充失败:', itemId, marketingApiError(error, '读取失败'));
          detail = {};
        }
      }
      if (detail?.id || detail?.title || detail?.thumbnail || detail?.secure_thumbnail) itemDetails.set(String(itemId), detail);
    });
    products = products.map(product => {
      const detail = itemDetails.get(String(product.itemId));
      return detail ? { ...product, title: detail.title || product.title, thumbnail: detail.secure_thumbnail || detail.thumbnail || product.thumbnail, permalink: detail.permalink || product.permalink, price: Number(detail.price || product.price || 0), currencyId: detail.currency_id || 'USD' } : product;
    });
    res.json({ code: 0, data: { products, total: Number(groupResponse.data?.paging?.total || groups.length), groupTotal: groups.length, page, size, campaignId } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '广告活动商品读取失败') });
  }
});

app.patch('/api/marketing/product-ads/campaigns/:campaignId', requireAuth, async (req, res) => {
  try {
    const campaignId = String(req.params.campaignId || '').trim();
    const siteId = String(req.body?.siteId || '').trim().toUpperCase();
    if (!campaignId || !siteId) return res.status(400).json({ code: 400, message: '请选择需要修改的广告活动' });
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.body?.storeId);
    const sites = await loadMarketingSites(auth, token);
    const site = sites.find(item => item.siteId === siteId);
    if (!site) return res.status(403).json({ code: 403, message: '该国家广告账户不属于当前授权店铺' });

    const changes = req.body?.changes || {};
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(changes, 'name')) {
      const name = String(changes.name || '').trim();
      if (!name || name.length > 200) return res.status(400).json({ code: 400, message: '广告活动名称不能为空且不能超过 200 个字符' });
      payload.name = name;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'budget')) {
      const budget = Number(changes.budget);
      if (!Number.isFinite(budget) || budget <= 0) return res.status(400).json({ code: 400, message: '每日预算必须大于 0' });
      payload.budget = Number(budget.toFixed(2));
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'status')) {
      const status = String(changes.status || '').toLowerCase();
      if (!['active', 'paused'].includes(status)) return res.status(400).json({ code: 400, message: '投放状态只能设置为投放中或已暂停' });
      payload.status = status;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'roasTarget')) {
      const roasTarget = Number(changes.roasTarget);
      if (!Number.isFinite(roasTarget) || roasTarget < 1 || roasTarget > 35) return res.status(400).json({ code: 400, message: '目标 ROAS 必须在 1 至 35 之间' });
      payload.roas_target = Number(roasTarget.toFixed(2));
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'strategy')) {
      const strategy = String(changes.strategy || '').toLowerCase();
      if (!['profitability', 'increase', 'visibility'].includes(strategy)) return res.status(400).json({ code: 400, message: '请选择平台支持的投放策略' });
      payload.strategy = strategy;
    }
    if (!Object.keys(payload).length) return res.status(400).json({ code: 400, message: '没有需要保存的修改' });

    const url = `https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/product_ads/campaigns/${encodeURIComponent(campaignId)}`;
    const response = await axios.put(url, payload, { headers: { ...getProductAdsHeaders(token), 'Content-Type': 'application/json' }, timeout: 25000 });
    for (const key of productAdsCache.keys()) {
      if (key.startsWith(`product-ads-overview:${auth.ml_user_id}:`)) productAdsCache.delete(key);
    }
    const campaign = response.data || {};
    res.json({ code: 0, message: '广告活动已更新并由美客多确认', data: {
      id: campaign.id || campaignId,
      name: campaign.name || payload.name || '',
      status: campaign.status || payload.status || '',
      budget: Number(campaign.budget ?? payload.budget ?? 0),
      currencyId: campaign.currency_id || '',
      strategy: campaign.strategy || payload.strategy || '',
      roasTarget: Number(campaign.roas_target ?? payload.roas_target ?? 0),
      lastUpdated: campaign.last_updated || new Date().toISOString()
    } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '广告活动更新失败') });
  }
});

app.post('/api/marketing/product-ads/campaigns', requireAuth, async (req, res) => {
  try {
    const siteId = String(req.body?.siteId || '').trim().toUpperCase();
    const name = String(req.body?.name || '').trim();
    const status = String(req.body?.status || 'paused').toLowerCase();
    const strategy = String(req.body?.strategy || '').toLowerCase();
    const budget = Number(req.body?.budget);
    const roasTarget = Number(req.body?.roasTarget);
    if (!siteId || !name || name.length > 200) return res.status(400).json({ code: 400, message: '请选择国家并填写不超过 200 个字符的活动名称' });
    if (!['active', 'paused'].includes(status)) return res.status(400).json({ code: 400, message: '请选择有效的投放状态' });
    if (!['profitability', 'increase', 'visibility'].includes(strategy)) return res.status(400).json({ code: 400, message: '请选择有效的投放策略' });
    if (!Number.isFinite(budget) || budget <= 0) return res.status(400).json({ code: 400, message: '每日预算必须大于 0' });
    if (!Number.isFinite(roasTarget) || roasTarget < 1 || roasTarget > 35) return res.status(400).json({ code: 400, message: '目标 ROAS 必须在 1 至 35 之间' });
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.body?.storeId);
    const sites = await loadMarketingSites(auth, token);
    const site = sites.find(item => item.siteId === siteId);
    if (!site) return res.status(403).json({ code: 403, message: '该国家广告账户不属于当前授权店铺' });
    const response = await axios.post(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/advertisers/${encodeURIComponent(site.advertiserId)}/product_ads/campaigns`, {
      name, status, budget: Number(budget.toFixed(2)), strategy, channel: 'marketplace', roas_target: Number(roasTarget.toFixed(2))
    }, { headers: { ...getProductAdsHeaders(token), 'Content-Type': 'application/json' }, timeout: 25000 });
    for (const key of productAdsCache.keys()) if (key.startsWith(`product-ads-overview:${auth.ml_user_id}:`)) productAdsCache.delete(key);
    res.json({ code: 0, message: '广告活动已创建并由美客多确认', data: response.data || {} });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '广告活动创建失败') });
  }
});

app.delete('/api/marketing/product-ads/campaigns/:campaignId/ad-groups/:adGroupId', requireAuth, async (req, res) => {
  try {
    const campaignId = String(req.params.campaignId || '').trim();
    const adGroupId = String(req.params.adGroupId || '').trim();
    const siteId = String(req.body?.siteId || '').trim().toUpperCase();
    if (!campaignId || !adGroupId || !siteId) return res.status(400).json({ code: 400, message: '缺少广告活动或广告组信息' });
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.body?.storeId);
    const sites = await loadMarketingSites(auth, token);
    const site = sites.find(item => item.siteId === siteId);
    if (!site) return res.status(403).json({ code: 403, message: '该国家广告账户不属于当前授权店铺' });
    const detailResponse = await axios.get(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/product_ads/ad_groups/${encodeURIComponent(adGroupId)}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    });
    const actualCampaignId = String(detailResponse.data?.campaign_id || '').trim();
    if (!actualCampaignId) return res.status(409).json({ code: 409, message: '该广告组当前未加入任何广告活动，无需移除' });
    await axios.delete(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/product_ads/campaigns/${encodeURIComponent(actualCampaignId)}/ad_groups/${encodeURIComponent(adGroupId)}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 25000
    });
    let confirmedCampaignId = actualCampaignId;
    for (let attempt = 0; attempt < 3 && confirmedCampaignId === actualCampaignId; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        const confirmation = await axios.get(`https://api.mercadolibre.com/marketplace/advertising/${encodeURIComponent(siteId)}/product_ads/ad_groups/${encodeURIComponent(adGroupId)}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 15000
        });
        confirmedCampaignId = String(confirmation.data?.campaign_id || '').trim();
      } catch (confirmationError) {
        if (confirmationError.response?.status === 404) confirmedCampaignId = '';
        else throw confirmationError;
      }
    }
    if (confirmedCampaignId === actualCampaignId) {
      return res.status(409).json({ code: 409, message: '美客多已接收移除请求，但该广告组仍在原活动中，可能是平台锁定或受保护的主活动，当前不能移除' });
    }
    for (const key of productAdsCache.keys()) if (key.startsWith(`product-ads-overview:${auth.ml_user_id}:`)) productAdsCache.delete(key);
    for (const key of marketingProductsCache.keys()) if (key.startsWith(`marketing-products:${auth.ml_user_id}:${siteId}:`)) marketingProductsCache.delete(key);
    res.json({ code: 0, message: confirmedCampaignId ? '广告组已移出当前活动，并由美客多转入其他活动' : '广告组已从当前广告活动移除，店铺商品不会被删除', data: { previousCampaignId: actualCampaignId, currentCampaignId: confirmedCampaignId || null } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '移除广告商品失败') });
  }
});

app.post('/api/marketing/promotion-items/match-selected', requireAuth, async (req, res) => {
  try {
    const promotionId = String(req.body?.promotionId || '').trim();
    const promotionType = String(req.body?.promotionType || '').trim().toUpperCase();
    const siteId = String(req.body?.siteId || '').trim().toUpperCase();
    const itemIds = [...new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map(value => String(value || '').trim().toUpperCase()).filter(Boolean))].slice(0, 30);
    if (!promotionId || !promotionType || !siteId || !itemIds.length) return res.status(400).json({ code: 400, message: '请选择活动和需要核对的商品' });
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.body?.storeId);
    const sites = await loadPromotionSites(auth, token);
    const resolved = await resolvePromotionSite(sites, token, siteId, promotionId, promotionType);
    const site = resolved.site;
    if (!site || !resolved.promotions.some(item => String(item.id) === promotionId && String(item.type).toUpperCase() === promotionType)) {
      return res.status(404).json({ code: 404, message: '活动不存在或已结束，请刷新活动列表' });
    }
    const rows = await mapWithConcurrency(itemIds, 4, async itemId => {
      if (!itemId.startsWith(siteId)) return { itemId, matched: false, reason: '商品不属于所选国家店铺' };
      try {
        const promotionResponse = await axios.get(`https://api.mercadolibre.com/marketplace/seller-promotions/items/${encodeURIComponent(itemId)}`, {
          params: { user_id: site.userId }, headers: getPromotionHeaders(token), timeout: 15000
        });
        const promotion = (Array.isArray(promotionResponse.data) ? promotionResponse.data : []).find(item =>
          String(item?.id) === promotionId && String(item?.type || '').toUpperCase() === promotionType && String(item?.status || '').toLowerCase() === 'candidate'
        );
        if (!promotion) return { itemId, matched: false, reason: '平台未将该商品列为此活动候选' };
        const offer = Array.isArray(promotion.offers) ? (promotion.offers.find(entry => entry?.status === 'candidate') || promotion.offers[0] || {}) : {};
        const detailKey = `item:${itemId}`;
        let detail = readTimedCache(marketingItemCache, detailKey, MARKETING_ITEM_CACHE_TTL);
        if (!hasMarketingItemPresentation(detail)) {
          try {
            const detailResponse = await axios.get(`https://api.mercadolibre.com/marketplace/items/${encodeURIComponent(itemId)}`, {
              headers: { Authorization: `Bearer ${token}` }, timeout: 15000
            });
            detail = writeTimedCache(marketingItemCache, detailKey, detailResponse.data || {}, 500);
          } catch { detail = detail || {}; }
        }
        return {
          matched: true,
          itemId,
          cbtItemId: detail?.cbt_item_id || '',
          title: detail?.title || itemId,
          thumbnail: marketingItemThumbnail(detail),
          currentPrice: Number(promotion.original_price ?? detail?.price ?? 0),
          activityPrice: Number(promotion.price || promotion.deal_price || offer.price || offer.deal_price || offer.new_price || offer.suggested_discounted_price || 0),
          platformDiscountPercent: Number(promotion.discount_percentage || offer.discount_percentage || offer.discount_percent || 0),
          currency: promotion.currency_id || detail?.currency_id || 'USD',
          minPrice: Number(promotion.min_discounted_price || offer.min_discounted_price || 0),
          maxPrice: Number(promotion.max_discounted_price || offer.max_discounted_price || 0),
          suggestedPrice: Number(promotion.suggested_discounted_price || offer.suggested_discounted_price || 0),
          stock: Number(detail?.available_quantity || 0),
          offerId: promotion.offer_id || promotion.candidate_id || offer.id || '',
          subType: promotion.sub_type || ''
        };
      } catch (error) {
        return { itemId, matched: false, reason: marketingApiError(error, '候选资格读取失败') };
      }
    });
    res.json({ code: 0, data: {
      items: rows.filter(item => item.matched),
      unmatched: rows.filter(item => !item.matched),
      selectedCount: itemIds.length,
      matchedCount: rows.filter(item => item.matched).length
    } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '所选商品活动资格核对失败') });
  }
});

app.get('/api/marketing/promotion-items', requireAuth, async (req, res) => {
  try {
    const promotionId = String(req.query.promotionId || '').trim();
    const promotionType = String(req.query.promotionType || '').trim().toUpperCase();
    const siteId = String(req.query.siteId || '').trim().toUpperCase();
    const status = req.query.status === 'started' ? 'started' : 'candidate';
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(30, Math.max(1, Number(req.query.size) || 20));
    if (!promotionId || !promotionType || !siteId) return res.status(400).json({ code: 400, message: '请选择国家店铺和活动' });
    const { auth, token } = await resolveMarketingAuthorization(req.authUser, req.query.storeId);
    const sites = await loadPromotionSites(auth, token);
    const resolved = await resolvePromotionSite(sites, token, siteId, promotionId, promotionType);
    const site = resolved.site;
    if (!site) return res.status(403).json({ code: 403, message: '该国家店铺不属于当前授权账号' });
    const pageCacheKey = `${auth.ml_user_id}:${siteId}:${promotionId}:${promotionType}:${status}:${page}:${size}`;
    const cachedPage = readTimedCache(promotionItemsPageCache, pageCacheKey, 5 * 60 * 1000);
    if (cachedPage) return res.json({ code: 0, data: cachedPage });
    if (!resolved.promotions.some(item => String(item.id) === promotionId && String(item.type).toUpperCase() === promotionType)) {
      return res.status(404).json({ code: 404, message: '活动不存在或已结束，请刷新活动列表' });
    }
    const pagingKey = `${auth.ml_user_id}:${siteId}:${promotionId}:${promotionType}:${status}:${size}`;
    let cursorEntry = readTimedCache(promotionPageCursorCache, pagingKey, 10 * 60 * 1000) || { cursors: { 1: '' } };
    let response;
    let currentPage = 1;
    let cursor = '';
    const knownPages = Object.keys(cursorEntry.cursors).map(Number).filter(value => value <= page && value > 0).sort((a, b) => b - a);
    if (knownPages.length) {
      currentPage = knownPages[0];
      cursor = cursorEntry.cursors[currentPage] || '';
    }
    while (currentPage <= page) {
      const params = { user_id: site.userId, promotion_type: promotionType, status, limit: size };
      if (cursor) params.search_after = cursor;
      response = await axios.get(`https://api.mercadolibre.com/marketplace/seller-promotions/promotions/${encodeURIComponent(promotionId)}/items`, {
        params, headers: getPromotionHeaders(token), timeout: 25000
      });
      const nextCursor = String(response.data?.paging?.search_after || response.data?.paging?.searchAfter || '');
      if (currentPage < page) {
        if (!nextCursor) { response = { data: { results: [], paging: { total: response.data?.paging?.total || 0 } } }; break; }
        cursorEntry.cursors[currentPage + 1] = nextCursor;
        cursor = nextCursor;
      }
      currentPage++;
    }
    writeTimedCache(promotionPageCursorCache, pagingKey, cursorEntry, 200);
    const responseItems = Array.isArray(response.data?.results) ? response.data.results : [];
    const startedItemIds = new Set(responseItems
      .filter(item => item?.status === 'started')
      .map(item => String(item.id || '')));
    const seenItemIds = new Set();
    const rawItems = responseItems.filter(item => {
      const itemId = String(item?.id || '');
      const returnedStatus = String(item?.status || '').toLowerCase();
      if (!itemId || seenItemIds.has(itemId)) return false;
      if (status === 'started' && returnedStatus && returnedStatus !== 'started') return false;
      if (status === 'candidate' && returnedStatus === 'started') return false;
      if (status === 'candidate' && startedItemIds.has(itemId)) return false;
      seenItemIds.add(itemId);
      return true;
    });
    const missingDetailIds = rawItems.map(item => String(item.id || '')).filter(itemId => itemId && !hasMarketingItemPresentation(readTimedCache(marketingItemCache, `item:${itemId}`, MARKETING_ITEM_CACHE_TTL)));
    if (missingDetailIds.length) {
      try {
        const detailResponse = await axios.get('https://api.mercadolibre.com/items', {
          params: { ids: missingDetailIds.join(',') }, headers: { Authorization: `Bearer ${token}` }, timeout: 20000
        });
        for (const entry of Array.isArray(detailResponse.data) ? detailResponse.data : []) {
          const detail = entry?.body || entry;
          const itemId = String(detail?.id || '');
          if (itemId && hasMarketingItemPresentation(detail)) writeTimedCache(marketingItemCache, `item:${itemId}`, detail, 500);
        }
      } catch (error) {
        console.warn('[Marketing] 商品详情批量预取失败，改用逐件读取:', error.message);
      }
    }
    const items = await mapWithConcurrency(rawItems, 4, async item => {
      const offer = Array.isArray(item.offers) ? (item.offers.find(entry => entry?.status === 'candidate') || item.offers[0] || {}) : {};
      const cacheKey = `item:${item.id}`;
      let detail = readTimedCache(marketingItemCache, cacheKey, MARKETING_ITEM_CACHE_TTL);
      if (!hasMarketingItemPresentation(detail)) {
        try {
          const detailResponse = await axios.get(`https://api.mercadolibre.com/marketplace/items/${encodeURIComponent(item.id)}`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15000
          });
          detail = writeTimedCache(marketingItemCache, cacheKey, detailResponse.data || {}, 500);
        } catch (error) {
          detail = {};
        }
      }
      return {
        itemId: item.id,
        cbtItemId: detail.cbt_item_id || '',
        title: detail.title || item.id,
        thumbnail: marketingItemThumbnail(detail),
        siteId,
        userId: site.userId,
        status: item.status || status,
        currentPrice: Number(item.original_price ?? detail.price ?? 0),
        activityPrice: Number(item.price || item.deal_price || offer.price || offer.deal_price || offer.new_price || offer.suggested_discounted_price || 0),
        platformDiscountPercent: Number(item.discount_percentage || offer.discount_percentage || offer.discount_percent || 0),
        currency: item.currency_id || detail.currency_id || 'USD',
        minPrice: Number(item.min_discounted_price || 0),
        maxPrice: Number(item.max_discounted_price || 0),
        suggestedPrice: Number(item.suggested_discounted_price || 0),
        stock: Number(detail.available_quantity || 0),
        offerId: item.offer_id || item.candidate_id || offer.id || '',
        netProceeds: item.net_proceeds || null,
        startDate: item.start_date || '',
        endDate: item.end_date || item.finish_date || ''
      };
    });
    const pageData = {
      items,
      total: Number(response.data?.paging?.total || items.length),
      page,
      size,
      searchAfter: response.data?.paging?.search_after || response.data?.paging?.searchAfter || ''
    };
    writeTimedCache(promotionItemsPageCache, pageCacheKey, pageData, 300);
    res.json({ code: 0, data: pageData });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '活动商品读取失败') });
  }
});

function buildPromotionEnrollmentBody(promotionType, promotionId, item) {
  const dealPrice = Number(item.dealPrice);
  const originalPrice = Number(item.originalPrice);
  const offerId = String(item.offerId || '').trim();
  if (['DEAL', 'SELLER_CAMPAIGN'].includes(promotionType)) {
    if (!(dealPrice > 0)) throw new Error('请填写有效活动价');
    const body = { promotion_id: promotionId, promotion_type: promotionType, deal_price: dealPrice };
    if (Number(item.topDealPrice) > 0) body.top_deal_price = Number(item.topDealPrice);
    return body;
  }
  if (['SMART', 'PRICE_MATCHING', 'PRE_NEGOTIATED', 'UNHEALTHY_STOCK'].includes(promotionType)) {
    if (!offerId) throw new Error('平台未返回该商品的报名凭证，请刷新候选商品');
    return { promotion_id: promotionId, promotion_type: promotionType, offer_id: offerId };
  }
  if (['MARKETPLACE_CAMPAIGN', 'VOLUME'].includes(promotionType)) {
    return { promotion_id: promotionId, promotion_type: promotionType };
  }
  if (['LIGHTNING', 'DOD'].includes(promotionType)) {
    if (!(dealPrice > 0) || !(originalPrice > 0)) throw new Error('请填写有效活动价');
    const body = { deal_id: promotionId, promotion_type: promotionType, deal_price: dealPrice, original_price: originalPrice };
    if (promotionType === 'LIGHTNING') {
      const stock = Math.floor(Number(item.stock));
      if (!(stock > 0)) throw new Error('闪购活动必须填写有效活动库存');
      body.stock = stock;
    }
    return body;
  }
  throw new Error(`暂不支持 ${promotionType} 类型的接口报名`);
}

async function validatePromotionRequest(authUser, body) {
  const promotionId = String(body.promotionId || '').trim();
  const promotionType = String(body.promotionType || '').trim().toUpperCase();
  const siteId = String(body.siteId || '').trim().toUpperCase();
  const { auth, token } = await resolveMarketingAuthorization(authUser, body.storeId);
  const sites = await loadPromotionSites(auth, token);
  const resolved = await resolvePromotionSite(sites, token, siteId, promotionId, promotionType);
  const site = resolved.site;
  if (!site) throw Object.assign(new Error('该国家店铺不属于当前授权账号'), { statusCode: 403 });
  if (!resolved.promotions.some(item => String(item.id) === promotionId && String(item.type).toUpperCase() === promotionType)) {
    throw Object.assign(new Error('活动不存在或已结束，请刷新活动列表'), { statusCode: 404 });
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  if (!items.length) throw Object.assign(new Error('请至少选择一个商品'), { statusCode: 400 });
  return { auth, token, site, promotionId, promotionType, items };
}

app.post('/api/marketing/promotions/enroll-batch', requireAuth, async (req, res) => {
  try {
    const context = await validatePromotionRequest(req.authUser, req.body || {});
    const headers = { ...getPromotionHeaders(context.token), 'Content-Type': 'application/json' };
    const results = await mapWithConcurrency(context.items, 3, async item => {
      const itemId = String(item.itemId || '').trim().toUpperCase();
      if (!itemId.startsWith(context.site.siteId)) return { itemId, success: false, message: '商品不属于所选国家店铺' };
      try {
        const payload = buildPromotionEnrollmentBody(context.promotionType, context.promotionId, item);
        await axios.post(`https://api.mercadolibre.com/marketplace/seller-promotions/items/${encodeURIComponent(itemId)}`, payload, {
          params: { user_id: context.site.userId }, headers, timeout: 25000
        });
        marketingItemCache.delete(`item:${itemId}`);
        return { itemId, success: true, message: '报名成功' };
      } catch (error) {
        return { itemId, success: false, message: marketingApiError(error, '报名失败') };
      }
    });
    marketingCache.delete(`promotions:${context.site.siteId}:${context.site.userId}`);
    for (const key of promotionPageCursorCache.keys()) if (key.includes(`:${context.site.siteId}:${context.promotionId}:`)) promotionPageCursorCache.delete(key);
    for (const key of promotionItemsPageCache.keys()) if (key.includes(`:${context.site.siteId}:${context.promotionId}:`)) promotionItemsPageCache.delete(key);
    for (const key of marketingProductsCache.keys()) if (key.startsWith(`marketing-products:${context.auth.ml_user_id}:${context.site.siteId}:`)) marketingProductsCache.delete(key);
    res.json({ code: 0, data: {
      successCount: results.filter(item => item.success).length,
      failedCount: results.filter(item => !item.success).length,
      results
    } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '批量报名失败') });
  }
});

app.post('/api/marketing/promotions/exit-batch', requireAuth, async (req, res) => {
  try {
    const context = await validatePromotionRequest(req.authUser, req.body || {});
    const headers = getPromotionHeaders(context.token);
    const offerRequired = ['SMART', 'PRICE_MATCHING', 'PRE_NEGOTIATED', 'UNHEALTHY_STOCK', 'MARKETPLACE_CAMPAIGN'].includes(context.promotionType);
    const results = await mapWithConcurrency(context.items, 3, async item => {
      const itemId = String(item.itemId || '').trim().toUpperCase();
      if (!itemId.startsWith(context.site.siteId)) return { itemId, success: false, message: '商品不属于所选国家店铺' };
      try {
        const offerId = context.promotionType === 'SELLER_CAMPAIGN' ? context.site.userId : String(item.offerId || '').trim();
        if (offerRequired && !offerId) throw new Error('平台未返回该商品的活动凭证，请刷新已参加商品');
        const params = {
          user_id: context.site.userId,
          promotion_type: context.promotionType,
          promotion_id: context.promotionId
        };
        if (offerId) params.offer_id = offerId;
        await axios.delete(`https://api.mercadolibre.com/marketplace/seller-promotions/items/${encodeURIComponent(itemId)}`, {
          params, headers, timeout: 25000
        });
        marketingItemCache.delete(`item:${itemId}`);
        return { itemId, success: true, message: '退出成功' };
      } catch (error) {
        return { itemId, success: false, message: marketingApiError(error, '退出失败') };
      }
    });
    marketingCache.delete(`promotions:${context.site.siteId}:${context.site.userId}`);
    for (const key of promotionPageCursorCache.keys()) if (key.includes(`:${context.site.siteId}:${context.promotionId}:`)) promotionPageCursorCache.delete(key);
    for (const key of promotionItemsPageCache.keys()) if (key.includes(`:${context.site.siteId}:${context.promotionId}:`)) promotionItemsPageCache.delete(key);
    for (const key of marketingProductsCache.keys()) if (key.startsWith(`marketing-products:${context.auth.ml_user_id}:${context.site.siteId}:`)) marketingProductsCache.delete(key);
    res.json({ code: 0, data: {
      successCount: results.filter(item => item.success).length,
      failedCount: results.filter(item => !item.success).length,
      results
    } });
  } catch (error) {
    const status = error.statusCode || error.response?.status || 500;
    res.status(status).json({ code: status, message: marketingApiError(error, '批量退出失败') });
  }
});

app.patch('/api/admin/order-stores/:id', requireAdmin, async (req, res) => {
  const remark = String(req.body?.remark || '').trim().slice(0, 300);
  const { rowCount } = await pool.query('UPDATE ml_stores SET remark=$1,updated_at=NOW() WHERE ml_user_id=$2 AND owner_username=$3', [remark, req.params.id,req.authUser.username]);
  if (!rowCount) return res.status(404).json({ code: 404, message: '店铺不存在' });
  res.json({ code: 0 });
});

app.get('/api/admin/order-buyers', requireAdmin, async (req, res) => {
  const params = [req.authUser.username], where = ["owner_username=$1", "buyer_nickname IS NOT NULL", "buyer_nickname<>''"];
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`store_user_id=$${params.length}`); }
  if (req.query.country) { params.push(String(req.query.country)); where.push(`country=$${params.length}`); }
  const { rows } = await pool.query(`SELECT buyer_nickname AS buyer,COUNT(*)::int AS "orderCount",MIN(date_created) AS "firstOrderAt",MAX(date_created) AS "lastOrderAt",ARRAY_REMOVE(ARRAY_AGG(DISTINCT country),NULL) AS countries FROM ml_orders WHERE ${where.join(' AND ')} GROUP BY buyer_nickname ORDER BY COUNT(*) DESC,MAX(date_created) DESC LIMIT 500`, params);
  res.json({ code: 0, data: rows });
});

app.get('/api/admin/order-buyers/:buyer', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT ml_order_id AS "orderId",COALESCE(NULLIF(pack_id,''),ml_order_id) AS "displayOrderId",date_created AS "dateCreated",country,currency,paid_amount AS "paidAmount",gross_amount_usd AS "grossAmountUsd",refund_amount AS "refundAmount",status,shipment_status AS "shipmentStatus",items,store_user_id AS "storeId" FROM ml_orders WHERE buyer_nickname=$1 AND owner_username=$2 ORDER BY date_created DESC LIMIT 200`, [req.params.buyer,req.authUser.username]);
  const messageAudits = rows.length ? await pool.query(`SELECT order_id,COUNT(*)::int AS count,MAX(fetched_at) AS "lastMessageAt" FROM order_api_audits WHERE owner_username=$2 AND api_type IN ('order_messages','claim_messages') AND order_id=ANY($1::varchar[]) GROUP BY order_id`,[rows.map(row=>row.orderId),req.authUser.username]) : { rows: [] };
  const messageMap = new Map(messageAudits.rows.map(item=>[String(item.order_id),item]));
  for (const order of rows) { const message = messageMap.get(String(order.orderId)); order.messageCount = message?.count || 0; order.lastMessageAt = message?.lastMessageAt || null; }
  const totals = {};
  for (const order of rows) totals[order.currency || '-'] = Number((totals[order.currency || '-'] || 0) + Number(order.paidAmount || 0)).toFixed(2);
  res.json({ code: 0, data: { buyer: req.params.buyer, orders: rows, totals } });
});

app.patch('/api/admin/orders/:orderId/cost', requireAdmin, async (req, res) => {
  const cost = Number(req.body?.cost);
  if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ code: 400, message: '成本必须是大于等于0的数字' });
  const note = String(req.body?.note || '').trim().slice(0, 500);
  const { rowCount } = await pool.query('UPDATE ml_orders SET product_cost=$1,cost_note=$2,updated_at=NOW() WHERE ml_order_id=$3 AND owner_username=$4', [cost, note, req.params.orderId,req.authUser.username]);
  if (!rowCount) return res.status(404).json({ code: 404, message: '订单不存在' });
  res.json({ code: 0 });
});

let usdCnyRateCache = { value: 0, expiresAt: 0 };
async function getUsdCnyRate() {
  if (usdCnyRateCache.value && Date.now() < usdCnyRateCache.expiresAt) return usdCnyRateCache.value;
  const saved = await pool.query("SELECT value FROM settings WHERE key='usd_cny_rate'");
  let rate = Number(saved.rows[0]?.value || 0);
  try {
    const response = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
    const live = Number(response.data?.rates?.CNY || 0);
    if (live > 0) {
      rate = live;
      await pool.query("INSERT INTO settings(key,value,updated_at) VALUES('usd_cny_rate',$1,NOW()) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()", [String(rate)]);
    }
  } catch (e) { console.warn('[Orders] 汇率更新失败，使用已保存汇率:', e.message); }
  if (!rate) rate = 7.2;
  usdCnyRateCache = { value: rate, expiresAt: Date.now() + 6 * 3600000 };
  return rate;
}

app.patch('/api/admin/order-exchange-rate', requireAdmin, async (req, res) => {
  const rate = Number(req.body?.rate);
  if (!Number.isFinite(rate) || rate < 1 || rate > 20) return res.status(400).json({ code: 400, message: '请输入有效的 USD/CNY 汇率' });
  await pool.query("INSERT INTO settings(key,value,updated_at) VALUES('usd_cny_rate',$1,NOW()) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()", [String(rate)]);
  usdCnyRateCache = { value: rate, expiresAt: Date.now() + 24 * 3600000 };
  res.json({ code: 0, data: { rate } });
});

app.get('/api/admin/order-profits', requireAdmin, async (req, res) => {
  const params = [req.authUser.username], where = ['o.owner_username=$1'];
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`o.store_user_id=$${params.length}`); }
  if (req.query.country) { params.push(String(req.query.country)); where.push(`o.country=$${params.length}`); }
  if (req.query.orderId) { params.push(String(req.query.orderId).trim()); where.push(`COALESCE(NULLIF(o.pack_id,''),o.ml_order_id) = $${params.length}`); }
  const days = Number(req.query.days || 0);
  if ([1,3,7,15,30,90,180,365].includes(days)) { params.push(days); where.push(`o.date_created >= NOW() - ($${params.length}::int * INTERVAL '1 day')`); }
  const dateFrom = String(req.query.dateFrom || ''), dateTo = String(req.query.dateTo || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) { params.push(dateFrom); where.push(`(o.date_created AT TIME ZONE 'Asia/Shanghai')::date >= $${params.length}::date`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) { params.push(dateTo); where.push(`(o.date_created AT TIME ZONE 'Asia/Shanghai')::date <= $${params.length}::date`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT o.ml_order_id AS "orderId",o.status,o.shipment_status AS "shipmentStatus",o.date_created AS "dateCreated",o.country,o.currency,o.paid_amount AS "paidAmount",o.gross_amount_usd AS "grossAmountUsd",o.net_amount_usd AS "netAmountUsd",o.refund_amount_usd AS "refundAmountUsd",o.sale_fee AS "saleFee",o.shipping_fee AS "shippingFee",o.net_amount AS "netAmount",o.refund_amount AS "refundAmount",o.other_fee AS "otherFee",o.finance_is_official AS "financeIsOfficial",o.product_cost AS "productCost",o.cost_note AS "costNote",o.items,o.store_user_id AS "storeId",COALESCE(NULLIF(s.remark,''),s.nickname,o.store_user_id) AS "storeName" FROM ml_orders o LEFT JOIN ml_stores s ON s.ml_user_id=o.store_user_id ${clause} ORDER BY o.date_created DESC LIMIT 10000`, params);
  const idRows = rows.length ? await pool.query('SELECT ml_order_id,pack_id,billing_data,shipping_id FROM ml_orders WHERE owner_username=$2 AND ml_order_id=ANY($1::varchar[])', [rows.map(row => row.orderId),req.authUser.username]) : { rows: [] };
  const displayIdMap = new Map(idRows.rows.map(row => [row.ml_order_id, row.pack_id || row.ml_order_id]));
  const idDetailMap = new Map(idRows.rows.map(row => [row.ml_order_id, row]));
  for (const row of rows) { const detail = idDetailMap.get(row.orderId); row.packId = detail?.pack_id || row.orderId; row.shippingId = detail?.shipping_id || ''; row.billingData = detail?.billing_data || {}; }
  const packedProfitRows = await aggregatePackedOrders(rows);
  const exchangeRate = await getUsdCnyRate();
  const summary = { USD: { paidAmount: 0, netAmount: 0, refundAmount: 0, productCostCny: 0, profitCny: 0, orderCount: 0, pendingPayoutCount: 0 } };
  for (const row of packedProfitRows) {
    const payoutForProfit = row.netAmountUsd === null ? null : Number(row.netAmountUsd);
    row.profitCny = payoutForProfit === null ? null : payoutForProfit * exchangeRate - Number(row.productCost || 0);
    row.profitBasis = 'net_payout';
    summary.USD.paidAmount += Number(row.grossAmountUsd || 0); summary.USD.netAmount += Number(row.netAmountUsd || 0);
    summary.USD.refundAmount += Number(row.refundAmountUsd || 0); summary.USD.productCostCny += Number(row.productCost || 0);
    if (row.profitCny === null) summary.USD.pendingPayoutCount++;
    else summary.USD.profitCny += Number(row.profitCny);
    summary.USD.orderCount++;
  }
  res.json({ code: 0, data: { items: packedProfitRows, summary, exchangeRate } });
});

app.get('/api/admin/order-inquiries', requireAdmin, async (req, res) => {
  try {
    const context = await resolveOrderStoreContext(req.authUser, String(req.query.storeId || ''));
    if (!context) return res.status(404).json({ code: 404, message: '当前账号没有可用的店铺授权' });
    const { token, sellerId } = context;
    const marketplaceSellerIds = await getOrderMarketplaceSellerIds(req.authUser.username,sellerId);
    const unreadResponses = await Promise.all(marketplaceSellerIds.map(userId => axios.get('https://api.mercadolibre.com/marketplace/messages/unread', {
      params: { user_id: userId }, headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    }).catch(() => ({ data: {} }))));
    const list = unreadResponses.flatMap(unreadResponse => {
      const raw = unreadResponse.data || {};
      const source = Array.isArray(raw) ? raw : (raw.results || raw.messages || raw.unread_messages || raw.data || []);
      return Array.isArray(source) ? source : [];
    });
    const messageOrderRefs = item => {
      const direct = [
        item?.pack_id, item?.packId, item?.order_id, item?.orderId,
        item?.resource_id, item?.resource?.id,
        typeof item?.resource === 'string' ? item.resource.split('/').pop() : ''
      ];
      for (const resource of item?.message_resources || item?.resources || []) {
        direct.push(resource?.id, resource?.resource_id, resource?.name?.split('/')?.pop());
      }
      return direct.map(value => String(value || '').trim()).filter(value => /^\d{8,}$/.test(value));
    };
    const packIds = [...new Set(list.flatMap(messageOrderRefs))];
    let unreadOrders = [];
    if (packIds.length) {
      const result = await pool.query(`SELECT ml_order_id AS "orderId",pack_id AS "packId",buyer_nickname AS buyer,country,date_created AS "dateCreated",items,store_user_id AS "storeId" FROM ml_orders WHERE owner_username=$2 AND store_user_id=$3 AND (pack_id=ANY($1::varchar[]) OR ml_order_id=ANY($1::varchar[])) ORDER BY date_created DESC`, [packIds,req.authUser.username,sellerId]);
      unreadOrders = result.rows;
    }
    const chinaNow = new Date(Date.now() + 8 * 3600000);
    const todayStart = new Date(Date.UTC(chinaNow.getUTCFullYear(),chinaNow.getUTCMonth(),chinaNow.getUTCDate()) - 8 * 3600000);
    const todayItems = list.filter(item => {
      const value = item.message_date || item.date_created || item.created_at || item.last_updated;
      const date = value ? new Date(value) : null;
      return !date || Number.isNaN(date.getTime()) || date >= todayStart;
    });
    const todayPackIds = new Set(todayItems.flatMap(messageOrderRefs));
    const matchedUnreadOrders = todayPackIds.size ? unreadOrders.filter(order => todayPackIds.has(String(order.packId)) || todayPackIds.has(String(order.orderId))) : unreadOrders;

    // “今日咨询”必须包含已经被管理员点开、但今天确实收到过买家消息的订单，不能只依赖 unread。
    const recentResult = await pool.query(`SELECT DISTINCT ON (COALESCE(NULLIF(pack_id,''),ml_order_id)) ml_order_id AS "orderId",pack_id AS "packId",buyer_nickname AS buyer,country,date_created AS "dateCreated",items,store_user_id AS "storeId" FROM ml_orders WHERE owner_username=$1 AND store_user_id=$2 AND date_created >= NOW() - INTERVAL '2 days' ORDER BY COALESCE(NULLIF(pack_id,''),ml_order_id),date_created DESC LIMIT 40`, [req.authUser.username,sellerId]);
    const conversationOrders = [];
    const conversationItems = [];
    for (let i = 0; i < recentResult.rows.length; i += 5) {
      const batch = await Promise.all(recentResult.rows.slice(i, i + 5).map(async order => {
        const packId = order.packId || order.orderId;
        try {
          const response = await axios.get(`https://api.mercadolibre.com/marketplace/messages/packs/${packId}`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 12000
          });
          const payload = response.data || {};
          const messages = Array.isArray(payload) ? payload : (payload.messages || payload.results || payload.data?.messages || []);
          const buyerMessages = messages.filter(message => {
            const sender = String(message.from?.user_id || message.from || message.sender_id || '');
            if (sender && marketplaceSellerIds.includes(sender)) return false;
            const rawDate = message.message_date || message.date_created || message.created_at;
            const date = rawDate ? new Date(rawDate) : null;
            return !date || Number.isNaN(date.getTime()) || date >= todayStart;
          });
          return buyerMessages.length ? { order, messages: buyerMessages } : null;
        } catch (_) { return null; }
      }));
      for (const entry of batch.filter(Boolean)) {
        conversationOrders.push(entry.order);
        conversationItems.push(...entry.messages.map(message => ({ ...message, order_id: entry.order.orderId, pack_id: entry.order.packId || entry.order.orderId })));
      }
    }
    const orderMap = new Map();
    for (const order of [...matchedUnreadOrders, ...conversationOrders]) orderMap.set(String(order.packId || order.orderId), order);
    const itemMap = new Map();
    for (const item of [...todayItems, ...conversationItems]) itemMap.set(String(item.id || `${item.pack_id || item.order_id}:${item.message_date || item.date_created || ''}:${item.text || item.message || ''}`), item);
    for (const [messageKey, item] of itemMap) {
      const refs = messageOrderRefs(item);
      const linkedOrder = [...orderMap.values()].find(order => refs.includes(String(order.packId)) || refs.includes(String(order.orderId)));
      if (!linkedOrder) continue;
      await pool.query(`INSERT INTO order_alerts(owner_username,order_id,alert_type,title,content,event_key) VALUES($1,$2,'buyer_inquiry','买家订单咨询待回复',$3,$4) ON CONFLICT(event_key) DO NOTHING`,
        [req.authUser.username,String(linkedOrder.orderId),`买家 ${linkedOrder.buyer || ''} 发来新的订单咨询`,`inquiry:${sellerId}:${messageKey}`]);
    }
    res.json({ code: 0, data: { count: itemMap.size, items: [...itemMap.values()], orders: [...orderMap.values()] } });
  } catch (e) {
    const status = e.response?.status || 502;
    res.status(status).json({ code: status, message: status === 403 ? '该店铺暂不支持美客多售后消息接口' : (e.response?.data?.message || e.message) });
  }
});

app.get('/api/admin/order-after-sales', requireAdmin, async (req, res) => {
  try {
    const context = await resolveOrderStoreContext(req.authUser, String(req.query.storeId || ''));
    if (!context) return res.status(404).json({ code: 404, message: '当前账号没有可用的店铺授权' });
    const { token, sellerId } = context;
    const marketplaceSellerIds = await getOrderMarketplaceSellerIds(req.authUser.username,sellerId);
    const claimResponses = await Promise.all(marketplaceSellerIds.map(localSellerId => axios.get('https://api.mercadolibre.com/post-purchase/v1/claims/search', {
      params: { status: 'opened', seller_id: localSellerId, sort: 'last_updated:desc' }, headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    }).catch(error => ({ error }))));
    if (claimResponses.every(response => response.error)) throw claimResponses[0].error;
    const claims = [...new Map(claimResponses.flatMap(response => {
      if (response.error) return [];
      const raw = response.data || {};
      const source = Array.isArray(raw) ? raw : (raw.data || raw.results || []);
      return Array.isArray(source) ? source : [];
    }).map(claim=>[String(claim.id || `${claim.resource_id}:${claim.last_updated || ''}`),claim])).values()];
    const orderIds = [...new Set(claims.map(claim => String(claim.resource_id || claim.order_id || claim.resource?.split('/')?.pop() || '')).filter(Boolean))];
    const orderResult = orderIds.length ? await pool.query(`SELECT ml_order_id AS "orderId",pack_id AS "packId",buyer_nickname AS buyer,country,date_created AS "dateCreated",items,store_user_id AS "storeId" FROM ml_orders WHERE owner_username=$2 AND store_user_id=$3 AND (ml_order_id=ANY($1::varchar[]) OR pack_id=ANY($1::varchar[]))`, [orderIds,req.authUser.username,sellerId]) : { rows: [] };
    const ordersById = new Map();
    for (const order of orderResult.rows) { ordersById.set(String(order.orderId), order); ordersById.set(String(order.packId), order); }
    const items = claims.map(claim => ({ ...claim, storeId: sellerId, order: ordersById.get(String(claim.resource_id || claim.order_id || claim.resource?.split('/')?.pop() || '')) || null }));
    for (const item of items) if (item.order) {
      await saveOrderApiAudit(req.authUser.username,sellerId,item.order.orderId,'claim',String(item.id),item);
      await pool.query(`INSERT INTO order_alerts(owner_username,order_id,alert_type,title,content,event_key) VALUES($1,$2,'after_sales','售后申诉待回复',$3,$4) ON CONFLICT(event_key) DO NOTHING`,
        [req.authUser.username,String(item.order.orderId),`订单 ${item.order.packId || item.order.orderId} 存在待处理售后申诉`,`claim:${sellerId}:${item.id}`]);
    }
    res.json({ code: 0, data: { count: items.length, items, orders: items.map(item => item.order).filter(Boolean) } });
  } catch (e) {
    const status = e.response?.status || 502;
    res.status(status).json({ code: status, message: status === 403 ? '该店铺暂不支持售后申诉接口' : (e.response?.data?.message || e.message) });
  }
});

app.get('/api/admin/order-claims/:claimId/messages', requireAdmin, async (req, res) => {
  try {
    const context = await resolveOrderStoreContext(req.authUser, String(req.query.storeId || ''));
    if (!context) return res.status(404).json({ code: 404, message: '无法确定该售后线程所属店铺' });
    const token = context.token;
    const response = await axios.get(`https://api.mercadolibre.com/post-purchase/v1/claims/${encodeURIComponent(req.params.claimId)}/messages`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    const claimLink = await pool.query(`SELECT order_id FROM order_api_audits WHERE owner_username=$1 AND api_type='claim' AND external_id=$2 LIMIT 1`,[req.authUser.username,String(req.params.claimId)]);
    await saveOrderApiAudit(req.authUser.username,context.sellerId,claimLink.rows[0]?.order_id || '','claim_messages',String(req.params.claimId),response.data);
    if (claimLink.rows[0]?.order_id) await pool.query(`UPDATE order_alerts SET is_read=TRUE WHERE owner_username=$1 AND order_id=$2 AND alert_type='after_sales'`,[req.authUser.username,claimLink.rows[0].order_id]);
    res.json({ code: 0, data: response.data });
  } catch (e) { const status = e.response?.status || 502; res.status(status).json({ code: status, message: e.response?.data?.message || e.message }); }
});

app.post('/api/admin/order-claims/:claimId/messages', requireAdmin, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ code: 400, message: '回复内容不能为空' });
  try {
    const context = await resolveOrderStoreContext(req.authUser, String(req.body?.storeId || ''));
    if (!context) return res.status(404).json({ code: 404, message: '无法确定该售后线程所属店铺' });
    const token = context.token;
    const response = await axios.post(`https://api.mercadolibre.com/post-purchase/v1/claims/${encodeURIComponent(req.params.claimId)}/messages`, { receiver_role: 'complainant', message: text }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    res.json({ code: 0, data: response.data });
  } catch (e) { const status = e.response?.status || 502; res.status(status).json({ code: status, message: e.response?.data?.message || e.message }); }
});

app.post('/api/admin/translate', requireAdmin, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  const source = String(req.body?.source || 'zh-CN');
  const target = String(req.body?.target || 'en');
  if (!text) return res.status(400).json({ code: 400, message: '翻译内容不能为空' });
  if (text.length > 5000) return res.status(400).json({ code: 400, message: '单次翻译内容不能超过5000字' });
  try {
    const response = await axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: source, tl: target, dt: 't', q: text },
      timeout: 15000
    });
    const translated = Array.isArray(response.data?.[0])
      ? response.data[0].map(part => part?.[0] || '').join('')
      : '';
    if (!translated) throw new Error('翻译服务未返回结果');
    res.json({ code: 0, data: { text: translated, source, target } });
  } catch (e) {
    res.status(502).json({ code: 502, message: `翻译失败：${e.response?.data?.message || e.message}` });
  }
});

app.get('/api/admin/order-alerts', requireAdmin, async (req, res) => {
  const page = Math.max(1,Number(req.query.page)||1), size = Math.min(100,Math.max(1,Number(req.query.size)||20));
  const params = [req.authUser.username], where = ['a.owner_username=$1'];
  if (req.query.type) { params.push(String(req.query.type)); where.push(`a.alert_type=$${params.length}`); }
  if (req.query.read === 'true' || req.query.read === 'false') { params.push(req.query.read === 'true'); where.push(`a.is_read=$${params.length}`); }
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`o.store_user_id=$${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countParams = [...params];
  params.push(size,(page-1)*size);
  const [{ rows }, unread, total] = await Promise.all([
    pool.query(`SELECT a.id,a.order_id AS "orderId",COALESCE(NULLIF(o.pack_id,''),a.order_id) AS "displayOrderId",a.alert_type AS type,a.title,a.content,a.is_read AS "isRead",a.created_at AS "createdAt",o.country,o.store_user_id AS "storeId",COALESCE(NULLIF(s.remark,''),NULLIF(s.nickname,''),o.store_user_id,'授权店铺') AS "storeName" FROM order_alerts a LEFT JOIN ml_orders o ON o.ml_order_id=a.order_id AND o.owner_username=a.owner_username LEFT JOIN ml_stores s ON s.ml_user_id=o.store_user_id ${clause} ORDER BY a.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params),
    pool.query('SELECT COUNT(*)::int AS count FROM order_alerts WHERE owner_username=$1 AND is_read=FALSE',[req.authUser.username]),
    pool.query(`SELECT COUNT(*)::int AS count FROM order_alerts a LEFT JOIN ml_orders o ON o.ml_order_id=a.order_id AND o.owner_username=a.owner_username ${clause}`,countParams)
  ]);
  res.json({ code: 0, data: { items: rows, unread: unread.rows[0].count, total: total.rows[0].count, page, size } });
});

app.post('/api/admin/order-alerts/read-all', requireAdmin, async (req, res) => {
  await pool.query('UPDATE order_alerts SET is_read=TRUE WHERE owner_username=$1 AND is_read=FALSE',[req.authUser.username]);
  res.json({ code: 0 });
});

app.post('/api/admin/order-alerts/:id/read', requireAdmin, async (req, res) => {
  await pool.query('UPDATE order_alerts SET is_read=TRUE WHERE id=$1 AND owner_username=$2', [req.params.id,req.authUser.username]);
  res.json({ code: 0 });
});

function decodeOfficialLabelError(error) {
  const status = Number(error.response?.status || 502);
  let raw = error.response?.data;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  else if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
  else if (ArrayBuffer.isView(raw)) raw = Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength).toString('utf8');
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (_) { parsed = raw.trim(); }
  }
  const causes = Array.isArray(parsed?.cause)
    ? parsed.cause.map(item => item?.message || item?.description || item?.code).filter(Boolean).join('；')
    : '';
  const officialCode = parsed?.error || parsed?.code || '';
  const reason = parsed?.message || parsed?.description || causes || '';
  const message = reason
    ? `${officialCode ? `${officialCode}：` : ''}${reason}`
    : `美客多面单接口返回 HTTP ${status}`;
  const auditData = parsed && typeof parsed === 'object'
    ? parsed
    : { message: String(parsed || message).slice(0,4000) };
  return { status, message, auditData };
}

app.get('/api/admin/orders/:orderId/label', requireAdmin, async (req, res) => {
  let audit = { storeUserId: '', shipmentIds: [] };
  try {
    const { rows } = await pool.query('SELECT shipping_id,store_user_id FROM ml_orders WHERE owner_username=$2 AND (ml_order_id=$1 OR pack_id=$1) ORDER BY date_created', [req.params.orderId,req.authUser.username]);
    if (!rows.length) return res.status(404).json({ code: 404, message: '订单不存在或不属于当前账号' });
    const shipmentIds = [...new Set(rows.map(row => row.shipping_id).filter(Boolean))];
    if (!shipmentIds.length) return res.status(404).json({ code: 404, message: '该订单暂无国际运单，无法下载面单' });
    audit = { storeUserId: rows[0].store_user_id, shipmentIds };
    const context = await getOrderStoreContext(req.authUser, rows[0].store_user_id);
    if (!context) return res.status(403).json({ code: 403, message: '该订单所属店铺授权已失效，请重新授权后下载' });
    let pdfResponse;
    let lastOfficialError;
    for (const path of ['shipment_labels', 'marketplace/shipment_labels']) {
      try {
        pdfResponse = await axios.get(`https://api.mercadolibre.com/${path}`, {
          params: { shipment_ids: shipmentIds.join(','), response_type: 'pdf' },
          headers: { Authorization: `Bearer ${context.token}`, Accept: 'application/pdf' },
          responseType: 'arraybuffer', timeout: 30000
        });
        if (pdfResponse?.data) break;
      } catch (error) {
        lastOfficialError = error;
        if (error.response?.status !== 404) throw error;
      }
    }
    if (!pdfResponse?.data) {
      if (lastOfficialError) throw lastOfficialError;
      return res.status(404).json({ code: 404, message: '美客多暂未生成该订单面单' });
    }
    const pdf = Buffer.from(pdfResponse.data);
    if (pdf.subarray(0,5).toString('ascii') !== '%PDF-') {
      const invalidPdfError = new Error('美客多未返回有效的 PDF 面单');
      invalidPdfError.response = { status: 502, data: pdf };
      throw invalidPdfError;
    }
    await saveOrderApiAudit(req.authUser.username,audit.storeUserId,req.params.orderId,'shipment_label',req.params.orderId,
      { success: true, shipmentIds, contentType: pdfResponse.headers?.['content-type'] || 'application/pdf', size: pdf.length });
    res.setHeader('Content-Type', 'application/pdf');
    const safeOrderId = String(req.params.orderId).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80) || 'order';
    res.setHeader('Content-Disposition', `attachment; filename="mercado-label-${safeOrderId}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(pdf);
  } catch (error) {
    if (!error.response) {
      console.error('[Orders] 面单下载失败:', error.message);
      return res.status(500).json({ code: 500, message: '面单下载失败，请稍后重试' });
    }
    const official = decodeOfficialLabelError(error);
    await saveOrderApiAudit(req.authUser.username,audit.storeUserId,req.params.orderId,'shipment_label',req.params.orderId,
      { success: false, shipmentIds: audit.shipmentIds, status: official.status, officialError: official.auditData }).catch(() => {});
    res.status(official.status).json({ code: official.status, message: `美客多官方返回：${official.message}` });
  }
});

app.get('/api/admin/orders/:orderId/messages', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT pack_id,store_user_id FROM ml_orders WHERE ml_order_id=$1 AND owner_username=$2', [req.params.orderId,req.authUser.username]);
    if (!rows[0]) return res.status(404).json({ code: 404, message: '订单不存在' });
    const context = await getOrderStoreContext(req.authUser, rows[0].store_user_id);
    if (!context) return res.status(403).json({ code: 403, message: '该订单所属店铺授权已失效' });
    const token = context.token;
    const packId = rows[0].pack_id || req.params.orderId;
    const response = await axios.get(`https://api.mercadolibre.com/marketplace/messages/packs/${packId}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    });
    await saveOrderApiAudit(req.authUser.username,rows[0].store_user_id,req.params.orderId,'order_messages',String(packId),response.data);
    await pool.query(`INSERT INTO order_message_reads(owner_username,thread_type,thread_id,last_read_at) VALUES($1,'inquiry',$2,NOW()) ON CONFLICT(owner_username,thread_type,thread_id) DO UPDATE SET last_read_at=NOW()`, [req.authUser.username,String(packId)]);
    await pool.query(`UPDATE order_alerts SET is_read=TRUE WHERE owner_username=$1 AND order_id=$2 AND alert_type='buyer_inquiry'`,[req.authUser.username,req.params.orderId]);
    res.json({ code: 0, data: response.data });
  } catch (e) {
    const status = e.response?.status || 502;
    res.status(status).json({ code: status, message: status === 403 ? '该店铺或订单暂不支持美客多售后会话' : (e.response?.data?.message || e.message) });
  }
});

app.post('/api/admin/orders/:orderId/messages', requireAdmin, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ code: 400, message: '回复内容不能为空' });
  try {
    const { rows } = await pool.query('SELECT pack_id,store_user_id FROM ml_orders WHERE ml_order_id=$1 AND owner_username=$2', [req.params.orderId,req.authUser.username]);
    if (!rows[0]) return res.status(404).json({ code: 404, message: '订单不存在' });
    const context = await getOrderStoreContext(req.authUser, rows[0].store_user_id);
    if (!context) return res.status(403).json({ code: 403, message: '该订单所属店铺授权已失效' });
    const token = context.token;
    const packId = rows[0].pack_id || req.params.orderId;
    const response = await axios.post(`https://api.mercadolibre.com/marketplace/messages/packs/${packId}`, {
      text, text_translated: String(req.body?.textTranslated || '') || undefined, attachments: []
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    res.json({ code: 0, data: response.data });
  } catch (e) {
    const status = e.response?.status || 502;
    res.status(status).json({ code: status, message: status === 403 ? '该店铺或订单暂不支持美客多售后会话' : (e.response?.data?.message || e.message) });
  }
});

app.get('/api/admin/fulfillment-services', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,code,description,enabled FROM fulfillment_services WHERE owner_username=$1 ORDER BY id DESC',[req.authUser.username]);
  res.json({ code: 0, data: rows });
});

app.post('/api/admin/fulfillment-services', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ code: 400, message: '增值服务名称不能为空' });
  const { rows } = await pool.query('INSERT INTO fulfillment_services(owner_username,name,code,description) VALUES($1,$2,$3,$4) RETURNING id', [req.authUser.username,name.slice(0,120), String(req.body?.code || '').trim().slice(0,100), String(req.body?.description || '').trim().slice(0,500)]);
  res.json({ code: 0, data: rows[0] });
});

app.delete('/api/admin/fulfillment-services/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM fulfillment_services WHERE id=$1 AND owner_username=$2', [req.params.id,req.authUser.username]);
  res.json({ code: 0 });
});

app.get('/api/admin/logistics-companies', requireAdmin, async (req, res) => {
  const defaults = ['顺丰速运','中通快递','圆通速递','申通快递','韵达快递','极兔速递','邮政EMS','京东物流','菜鸟物流'];
  const existing = await pool.query('SELECT COUNT(*)::int AS count FROM logistics_companies WHERE owner_username=$1',[req.authUser.username]);
  if (!existing.rows[0].count) for (const name of defaults) await pool.query('INSERT INTO logistics_companies(owner_username,name) VALUES($1,$2) ON CONFLICT(owner_username,name) DO NOTHING',[req.authUser.username,name]);
  const { rows } = await pool.query('SELECT id,name,code,enabled FROM logistics_companies WHERE owner_username=$1 ORDER BY name',[req.authUser.username]);
  res.json({ code: 0, data: rows });
});

app.post('/api/admin/logistics-companies', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim(), code = String(req.body?.code || '').trim();
  if (!name) return res.status(400).json({ code: 400, message: '物流公司名称不能为空' });
  const { rows } = await pool.query(`INSERT INTO logistics_companies(owner_username,name,code) VALUES($1,$2,$3)
    ON CONFLICT(owner_username,name) DO UPDATE SET code=EXCLUDED.code,enabled=TRUE RETURNING id`,[req.authUser.username,name.slice(0,120),code.slice(0,100)]);
  res.json({ code: 0, data: rows[0] });
});

app.delete('/api/admin/logistics-companies/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM logistics_companies WHERE id=$1 AND owner_username=$2',[req.params.id,req.authUser.username]);
  res.json({ code: 0 });
});

app.post('/api/admin/fulfillment/submit', requireAdmin, async (req, res) => {
  const orderIds = [...new Set((Array.isArray(req.body?.orderIds) ? req.body.orderIds : []).map(String).filter(Boolean))];
  const warehouseId = Number(req.body?.warehouseId), carrier = String(req.body?.carrier || '').trim();
  const trackingByOrder = req.body?.trackingByOrder || {}, serviceIds = (req.body?.serviceIds || []).map(Number).filter(Number.isFinite);
  if (!orderIds.length || !warehouseId || !carrier) return res.status(400).json({ code: 400, message: '请选择订单、仓库和物流公司' });
  const connectorResult = await pool.query('SELECT * FROM erp_connectors WHERE id=$1 AND owner_username=$2 AND enabled=TRUE', [warehouseId,req.authUser.username]);
  if (!connectorResult.rows[0]) return res.status(404).json({ code: 404, message: '仓库不存在或已停用' });
  const carrierResult = await pool.query('SELECT id FROM logistics_companies WHERE owner_username=$1 AND name=$2 AND enabled=TRUE',[req.authUser.username,carrier]);
  if (!carrierResult.rows[0]) return res.status(404).json({ code: 404, message: '请选择管理员维护的物流公司' });
  const serviceResult = serviceIds.length ? await pool.query('SELECT id,name,code,description FROM fulfillment_services WHERE owner_username=$2 AND enabled=TRUE AND id=ANY($1::bigint[])', [serviceIds,req.authUser.username]) : { rows: [] };
  const warehouse = connectorResult.rows[0], headers = { 'Content-Type': 'application/json' };
  if (warehouse.auth_header && warehouse.auth_value) headers[warehouse.auth_header] = decryptErpCredential(warehouse.auth_value);
  const results = [];
  for (const displayOrderId of orderIds) {
    const trackingNumber = String(trackingByOrder[displayOrderId] || '').trim();
    if (!trackingNumber) { results.push({ orderId: displayOrderId, success: false, message: '缺少快递单号' }); continue; }
    const orderResult = await pool.query('SELECT * FROM ml_orders WHERE owner_username=$2 AND (ml_order_id=$1 OR pack_id=$1) ORDER BY date_created', [displayOrderId,req.authUser.username]);
    if (!orderResult.rows.length) { results.push({ orderId: displayOrderId, success: false, message: '订单不存在' }); continue; }
    const payload = { source: 'shanyue-erp', action: 'fulfillment_label', order_id: displayOrderId, carrier, tracking_number: trackingNumber, value_added_services: serviceResult.rows, orders: orderResult.rows.map(row => row.raw_data) };
    try {
      const pushed = await axios.post(warehouse.endpoint, payload, { headers, timeout: 30000, maxRedirects: 0 });
      await pool.query(`INSERT INTO fulfillment_submissions(owner_username,order_id,warehouse_id,carrier,tracking_number,service_ids,status,request_data,response_text,failure_reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,'success',$7::jsonb,$8,NULL) ON CONFLICT(order_id) DO UPDATE SET owner_username=EXCLUDED.owner_username,warehouse_id=EXCLUDED.warehouse_id,carrier=EXCLUDED.carrier,tracking_number=EXCLUDED.tracking_number,service_ids=EXCLUDED.service_ids,status='success',request_data=EXCLUDED.request_data,response_text=EXCLUDED.response_text,failure_reason=NULL,updated_at=NOW()`, [req.authUser.username,displayOrderId,warehouseId,carrier,trackingNumber,JSON.stringify(serviceIds),JSON.stringify(payload),JSON.stringify(pushed.data).slice(0,5000)]);
      results.push({ orderId: displayOrderId, success: true });
    } catch (error) {
      const failureReason = String(error.response?.data?.message || error.message || '提交失败').slice(0,2000);
      await pool.query(`INSERT INTO fulfillment_submissions(owner_username,order_id,warehouse_id,carrier,tracking_number,service_ids,status,request_data,response_text,failure_reason,retry_count) VALUES($1,$2,$3,$4,$5,$6::jsonb,'failed',$7::jsonb,$8,$9,1) ON CONFLICT(order_id) DO UPDATE SET owner_username=EXCLUDED.owner_username,status='failed',response_text=EXCLUDED.response_text,failure_reason=EXCLUDED.failure_reason,retry_count=fulfillment_submissions.retry_count+1,updated_at=NOW()`, [req.authUser.username,displayOrderId,warehouseId,carrier,trackingNumber,JSON.stringify(serviceIds),JSON.stringify(payload),JSON.stringify(error.response?.data || error.message).slice(0,5000),failureReason]);
      results.push({ orderId: displayOrderId, success: false, message: error.response?.data?.message || error.message });
    }
  }
  const success = results.filter(item => item.success).length;
  res.status(success ? 200 : 502).json({ code: success ? 0 : 502, data: { success, failed: results.length - success, results }, message: success ? '代贴单已提交' : '代贴单提交失败' });
});

app.get('/api/admin/fulfillment/submissions', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT f.id,f.order_id AS "orderId",f.carrier,f.tracking_number AS "trackingNumber",f.status,
    f.failure_reason AS "failureReason",f.retry_count AS "retryCount",f.created_at AS "createdAt",f.updated_at AS "updatedAt",
    c.name AS "warehouseName" FROM fulfillment_submissions f LEFT JOIN erp_connectors c ON c.id=f.warehouse_id
    WHERE f.owner_username=$1 ORDER BY f.updated_at DESC LIMIT 200`, [req.authUser.username]);
  res.json({ code: 0, data: rows });
});

app.post('/api/admin/fulfillment/submissions/:id/retry', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT f.*,c.endpoint,c.auth_header,c.auth_value FROM fulfillment_submissions f
    JOIN erp_connectors c ON c.id=f.warehouse_id AND c.owner_username=f.owner_username
    WHERE f.id=$1 AND f.owner_username=$2`, [req.params.id,req.authUser.username]);
  const submission = rows[0];
  if (!submission) return res.status(404).json({ code: 404, message: '代贴单提交记录不存在' });
  const headers = { 'Content-Type': 'application/json' };
  if (submission.auth_header && submission.auth_value) headers[submission.auth_header] = decryptErpCredential(submission.auth_value);
  try {
    const response = await axios.post(submission.endpoint, submission.request_data, { headers, timeout: 30000, maxRedirects: 0 });
    await pool.query(`UPDATE fulfillment_submissions SET status='success',response_text=$1,failure_reason=NULL,retry_count=retry_count+1,updated_at=NOW() WHERE id=$2 AND owner_username=$3`, [JSON.stringify(response.data).slice(0,5000),submission.id,req.authUser.username]);
    res.json({ code: 0, message: '重试成功' });
  } catch (error) {
    const reason = String(error.response?.data?.message || error.message || '重试失败').slice(0,2000);
    await pool.query(`UPDATE fulfillment_submissions SET status='failed',response_text=$1,failure_reason=$2,retry_count=retry_count+1,updated_at=NOW() WHERE id=$3 AND owner_username=$4`, [JSON.stringify(error.response?.data || error.message).slice(0,5000),reason,submission.id,req.authUser.username]);
    res.status(502).json({ code: 502, message: reason });
  }
});

app.get('/api/admin/erp-connectors', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,endpoint,auth_header AS "authHeader",enabled,created_at AS "createdAt" FROM erp_connectors WHERE owner_username=$1 ORDER BY id DESC',[req.authUser.username]);
  res.json({ code: 0, data: rows });
});

app.post('/api/admin/erp-connectors', requireAdmin, async (req, res) => {
  const { name, endpoint, authHeader, authValue } = req.body || {};
  if (!name || !endpoint) return res.status(400).json({ code: 400, message: '缺少连接名称或推单地址' });
  let target; try { target = new URL(endpoint); } catch { return res.status(400).json({ code: 400, message: '推单地址格式错误' }); }
  if (target.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(target.hostname)) return res.status(400).json({ code: 400, message: '只允许公网 HTTPS 推单地址' });
  let encryptedAuth;
  try { encryptedAuth = encryptErpCredential(String(authValue || '').slice(0,2000)); }
  catch (e) { return res.status(503).json({ code: 503, message: e.message }); }
  const { rows } = await pool.query('INSERT INTO erp_connectors(owner_username,name,endpoint,auth_header,auth_value) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.authUser.username,String(name).slice(0,120), target.href, String(authHeader || '').slice(0,120), encryptedAuth]);
  res.json({ code: 0, data: { id: rows[0].id } });
});

app.delete('/api/admin/erp-connectors/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM erp_connectors WHERE id=$1 AND owner_username=$2', [req.params.id,req.authUser.username]);
  res.json({ code: 0 });
});

app.post('/api/admin/orders/:orderId/push', requireAdmin, async (req, res) => {
  const order = await pool.query('SELECT * FROM ml_orders WHERE ml_order_id=$1 AND owner_username=$2', [req.params.orderId,req.authUser.username]);
  const connector = await pool.query('SELECT * FROM erp_connectors WHERE id=$1 AND owner_username=$2 AND enabled=TRUE', [req.body?.connectorId,req.authUser.username]);
  if (!order.rows[0] || !connector.rows[0]) return res.status(404).json({ code: 404, message: '订单或ERP连接不存在' });
  const c = connector.rows[0], headers = { 'Content-Type': 'application/json' };
  try {
    if (c.auth_header && c.auth_value) headers[c.auth_header] = decryptErpCredential(c.auth_value);
    const pushed = await axios.post(c.endpoint, { source: 'shanyue-erp', order: order.rows[0].raw_data }, { headers, timeout: 30000, maxRedirects: 0 });
    await pool.query("UPDATE ml_orders SET push_status='success',last_pushed_at=NOW() WHERE ml_order_id=$1 AND owner_username=$2", [req.params.orderId,req.authUser.username]);
    await pool.query('INSERT INTO erp_push_logs(owner_username,order_id,connector_id,success,http_status,response_text) VALUES($1,$2,$3,TRUE,$4,$5)', [req.authUser.username,req.params.orderId,c.id,pushed.status,JSON.stringify(pushed.data).slice(0,5000)]);
    res.json({ code: 0, data: { status: pushed.status } });
  } catch (e) {
    await pool.query("UPDATE ml_orders SET push_status='failed',last_pushed_at=NOW() WHERE ml_order_id=$1 AND owner_username=$2", [req.params.orderId,req.authUser.username]);
    await pool.query('INSERT INTO erp_push_logs(owner_username,order_id,connector_id,success,http_status,response_text) VALUES($1,$2,$3,FALSE,$4,$5)', [req.authUser.username,req.params.orderId,c.id,e.response?.status || null,JSON.stringify(e.response?.data || e.message).slice(0,5000)]);
    res.status(502).json({ code: 502, message: 'ERP推单失败', detail: e.response?.data || e.message });
  }
});

app.get('/api/admin/international-library', requireAdmin, async (req, res) => {
  const country = String(req.query.country || 'MX').toUpperCase();
  if (!['MX', 'BR', 'CL', 'CO'].includes(country)) return res.status(400).json(jsonFail('国家代码无效'));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 30));
  const keyword = String(req.query.keyword || '').trim();
  const params = [country];
  let where = 'WHERE country=$1';
  if (keyword) { params.push(`%${keyword}%`); where += ` AND (title ILIKE $${params.length} OR category_name ILIKE $${params.length})`; }
  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM international_products ${where}`, params);
  params.push(size, (page - 1) * size);
  const { rows } = await pool.query(`SELECT item_id AS "itemId", title, price, currency, discount,
    image_url AS "imageUrl", product_url AS "productUrl", category_name AS "categoryName", original_price AS "originalPrice",
    rating, review_count AS "reviewCount", sold_text AS "soldText", seller, shipping_text AS "shippingText", origin_text AS "originText",
    listing_time AS "listingTime", first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt"
    FROM international_products ${where} ORDER BY last_seen_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(jsonOk({ items: rows, total: countResult.rows[0].total, page, size }));
});

const INTERNATIONAL_SOURCES = {
  MX: { name: '墨西哥', currency: 'MXN', host: 'www.mercadolibre.com.mx', url: 'https://www.mercadolibre.com.mx/importados/compra-internacional' },
  BR: { name: '巴西', currency: 'BRL', host: 'www.mercadolivre.com.br', url: 'https://www.mercadolivre.com.br/importados/compra-internacional' },
  CL: { name: '智利', currency: 'CLP', host: 'www.mercadolibre.cl', url: 'https://www.mercadolibre.cl/importados/compra-internacional' },
  CO: { name: '哥伦比亚', currency: 'COP', host: 'www.mercadolibre.com.co', url: 'https://www.mercadolibre.com.co/importados/compra-internacional' }
};
const internationalCache = new Map();
const INTERNATIONAL_CACHE_MS = 15 * 60 * 1000;

function decodeInternationalText(value = '') {
  return value.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\u003D/g, '=')
    .replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

function parseInternationalProducts(html, source, limit) {
  const products = [], seen = new Set();
  const pattern = /\\"metadata\\":\{(.{0,5000}?)\\"card_type\\":\\"(?:grid|list)\\".{0,3000}?\\"components\\":\[(.{0,12000}?)\]\}/gs;
  let match;
  while ((match = pattern.exec(html)) && products.length < limit) {
    const metadata = match[1], components = match[2];
    if (!/international_context(?:%3D|=)true/i.test(metadata)) continue;
    const id = metadata.match(/\\"id\\":\\"(M[A-Z]{2}\d+)\\"/)?.[1];
    const title = components.match(/\\"type\\":\\"title\\".*?\\"text\\":\\"(.*?)\\"/)?.[1];
    const price = components.match(/\\"current_price\\":\{\\"value\\":([\d.]+)/)?.[1];
    const currency = components.match(/\\"current_price\\":\{.*?\\"currency\\":\\"([A-Z]{3})\\"/)?.[1] || source.currency;
    const discount = components.match(/\\"discount_label\\":\{\\"text\\":\\"(.*?)\\"/)?.[1] || '';
    const rawUrl = metadata.match(/\\"url\\":\\"(.*?)\\"/)?.[1];
    if (!id || !title || !price || !rawUrl || seen.has(id)) continue;
    const decodedUrl = decodeInternationalText(rawUrl);
    const productUrl = decodedUrl.startsWith('http') ? decodedUrl : `https://${decodedUrl.replace(/^\/+/, '')}`;
    try {
      const hostname = new URL(productUrl).hostname, baseHost = source.host.replace(/^www\./, '');
      if (hostname !== source.host && !hostname.endsWith(`.${baseHost}`)) continue;
    } catch (e) { continue; }
    seen.add(id);
    products.push({ id, title: decodeInternationalText(title), price: Number(price), currency,
      discount: decodeInternationalText(discount), url: productUrl });
  }
  return products;
}

async function fetchInternationalCountry(code, limit, forceRefresh) {
  const source = INTERNATIONAL_SOURCES[code], cached = internationalCache.get(code);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < INTERNATIONAL_CACHE_MS) return { ...cached, cached: true };
  try {
    const response = await axios.get(source.url, { timeout: 30000, maxRedirects: 5, responseType: 'text', headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': code === 'BR' ? 'pt-BR,pt;q=0.9' : 'es-419,es;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
    }});
    const products = parseInternationalProducts(String(response.data), source, limit);
    const result = { country: code, countryName: source.name, sourceUrl: source.url,
      status: products.length ? 'ok' : 'empty', message: products.length ? `已读取 ${products.length} 个国际购商品` : '页面可访问，但暂未解析到国际购商品',
      products, fetchedAt: Date.now(), cached: false };
    internationalCache.set(code, result);
    return result;
  } catch (error) {
    return { country: code, countryName: source.name, sourceUrl: source.url,
      status: error.response?.status === 403 ? 'blocked' : 'error',
      message: error.response?.status === 403 ? 'Mercado 暂时拦截了服务器访问，请稍后重试' : `采集失败：${error.code || error.message}`,
      products: [], fetchedAt: Date.now(), cached: false };
  }
}

app.get('/api/admin/international-products', requireAdmin, async (req, res) => {
  const requested = String(req.query.country || 'MX').toUpperCase();
  if (!INTERNATIONAL_SOURCES[requested]) return res.status(400).json({ code: 400, message: '只支持 MX、BR、CL、CO 四个国家' });
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 36));
  const data = await fetchInternationalCountry(requested, limit, req.query.refresh === '1');
  res.json(jsonOk(data));
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
  await initDashboardTables();
  await seedDashboardData();
  await seedDashboardStats();
  await initInternationalProductTable();
  await initOrderManagementTables();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('============================================');
    console.log('  美客多爆品选品雷达 - 云端管理后台');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`  管理页面: http://localhost:${PORT}/`);
    console.log('============================================');
  });
  const shutdown = signal => {
    console.log(`[Server] ${signal} received, closing gracefully`);
    server.close(async () => {
      try { await pool?.end(); } catch (error) { console.error('[DB] close error:', error.message); }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start();
