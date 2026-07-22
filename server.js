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
    nickname VARCHAR(300),
    remark VARCHAR(300),
    site_id VARCHAR(20),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ml_orders (
      id BIGSERIAL PRIMARY KEY,
      ml_order_id VARCHAR(80) UNIQUE NOT NULL,
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
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(18,2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS product_cost NUMERIC(18,2) NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS cost_note VARCHAR(500)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS other_fee NUMERIC(18,2)');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS billing_data JSONB NOT NULL DEFAULT \'{}\'::jsonb');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS finance_is_official BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE ml_orders ADD COLUMN IF NOT EXISTS finance_synced_at TIMESTAMPTZ');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_orders_store ON ml_orders(store_user_id, date_created DESC)');
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
  await pool.query(`CREATE TABLE IF NOT EXISTS ml_store_products (
    id BIGSERIAL PRIMARY KEY,
    owner_username VARCHAR(120) NOT NULL,
    store_user_id VARCHAR(80) NOT NULL,
    item_id VARCHAR(80) NOT NULL,
    title TEXT,
    status VARCHAR(50),
    price NUMERIC(18,2),
    currency VARCHAR(10),
    available_quantity INTEGER,
    sold_quantity INTEGER,
    thumbnail TEXT,
    permalink TEXT,
    category_id VARCHAR(80),
    listing_type_id VARCHAR(80),
    condition VARCHAR(30),
    health NUMERIC(8,4),
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    ml_updated_at TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_username,item_id)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_store_products_owner_store ON ml_store_products(owner_username,store_user_id,status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_ml_store_products_updated ON ml_store_products(last_synced_at DESC)');
  await pool.query('ALTER TABLE ml_store_products ADD COLUMN IF NOT EXISTS ignored BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query(`CREATE TABLE IF NOT EXISTS order_alerts (
    id BIGSERIAL PRIMARY KEY, order_id VARCHAR(80), alert_type VARCHAR(50) NOT NULL,
    title VARCHAR(300) NOT NULL, content TEXT, is_read BOOLEAN NOT NULL DEFAULT FALSE,
    event_key VARCHAR(300) UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_order_alerts_unread ON order_alerts(is_read, created_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_connectors (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      endpoint TEXT NOT NULL,
      auth_header VARCHAR(120),
      auth_value TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_push_logs (
      id BIGSERIAL PRIMARY KEY,
      order_id VARCHAR(80) NOT NULL,
      connector_id BIGINT REFERENCES erp_connectors(id) ON DELETE SET NULL,
      success BOOLEAN NOT NULL,
      http_status INTEGER,
      response_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS fulfillment_services (
    id BIGSERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, code VARCHAR(100), description VARCHAR(500), enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fulfillment_submissions (
    id BIGSERIAL PRIMARY KEY, order_id VARCHAR(80) NOT NULL, warehouse_id BIGINT REFERENCES erp_connectors(id) ON DELETE SET NULL,
    carrier VARCHAR(200) NOT NULL, tracking_number VARCHAR(300) NOT NULL, service_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'pending', request_data JSONB NOT NULL DEFAULT '{}'::jsonb, response_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(order_id)
  )`);
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
  if (!token) return res.json({ code: 401, message: '未登录或登录已过期' });

  const { rows } = await pool.query(
    "SELECT username, role, validuntil, created_at FROM user_sessions WHERE token = $1 AND created_at >= NOW() - ($2 * INTERVAL '1 day')",
    [token, SESSION_MAX_AGE_DAYS]
  );
  if (rows.length === 0) return res.json({ code: 401, message: '未登录或登录已过期' });

  const user = { username: rows[0].username, role: rows[0].role, validUntil: rows[0].validuntil };

  // 检查账号是否到期
  if (isUserExpired(user)) {
    await pool.query('DELETE FROM user_sessions WHERE token = $1', [token]);
    return res.json({ code: 403, message: '账号已到期，请联系管理员' });
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
  const limit = getAgentMaxValidUntil();
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
function getAgentMaxValidUntil() {
  const now = new Date();
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
    const limit = getAgentMaxValidUntil();
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
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of searchCache) {
    if (now - val.time > CACHE_TTL) searchCache.delete(key);
  }
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
  await pool.query(`INSERT INTO ml_stores(ml_user_id,nickname,site_id,updated_at) VALUES($1,$2,$3,NOW())
    ON CONFLICT(ml_user_id) DO UPDATE SET nickname=EXCLUDED.nickname,site_id=EXCLUDED.site_id,updated_at=NOW()`,
    [mlUserId, me.nickname || '', me.site_id || '']);
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
  const params = [String(storeUserId)];
  let where = 'ml_user_id=$1 AND enabled=TRUE';
  if (authUser.role !== 'admin') {
    params.push(authUser.username);
    where += ` AND owner_username=$${params.length}`;
  }
  const { rows } = await pool.query(`SELECT * FROM ml_store_authorizations WHERE ${where} ORDER BY updated_at DESC LIMIT 1`, params);
  return rows[0] || null;
}

app.post('/api/store-products/oauth-link', requireAuth, async (req, res) => {
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
  let saleFee = 0, shippingFee = 0, otherFee = 0, totalCharges = 0, totalBonuses = 0;
  for (const entry of entries) {
    const amount = Math.abs(Number(entry.detail_amount || 0));
    const type = String(entry.detail_type || '').toUpperCase();
    const subType = String(entry.detail_sub_type || '').toUpperCase();
    const conceptType = String(entry.concept_type || '').toUpperCase();
    const text = `${entry.transaction_detail || ''} ${entry.detail_description || ''} ${subType} ${conceptType}`.toLowerCase();
    if (type === 'BONUS' || /bonus|rebate|credit/.test(text)) totalBonuses += amount;
    else {
      totalCharges += amount;
      if (subType === 'CXD' || conceptType === 'SHIPPING' || /shipping|shipment|freight|logistic|env[ií]o|mercado env[ií]os/.test(text)) shippingFee += amount;
      else if (subType === 'CV' || /sale.?fee|commission|selling.?fee|cargo por venta|cargo por vender|tarifa de venta/.test(text)) saleFee += amount;
      else otherFee += amount;
    }
  }
  const explicitSaleFee = Number(detail.sale_fee?.amount ?? detail.sale_fee ?? 0);
  const explicitShipping = Number(detail.shipping_info?.sender_shipping_cost ?? detail.shipping_cost ?? 0);
  if (!saleFee && explicitSaleFee) saleFee = Math.abs(explicitSaleFee);
  if (!shippingFee && explicitShipping) shippingFee = Math.abs(explicitShipping);
  const officialNet = Math.max(0, Number(grossAmount || 0) - totalCharges + totalBonuses);
  return { saleFee, shippingFee, otherFee, totalCharges, totalBonuses, netAmount: officialNet, entries };
}

const billingFxCache = new Map();
async function getBillingFxRate(fromCurrency, toCurrency) {
  const from = String(fromCurrency || '').toUpperCase(), to = String(toCurrency || '').toUpperCase();
  if (!from || !to || from === to) return 1;
  const key = `${from}:${to}`, cached = billingFxCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rate;
  try {
    const token = await getMLAccessToken();
    const response = await axios.get('https://api.mercadolibre.com/currency_conversions/search', { params: { from, to }, headers: { Authorization: `Bearer ${token}` }, timeout: 12000 });
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
    if (!groups.has(groupId)) groups.set(groupId, { ...row, displayOrderId: groupId, internalOrderIds: [], shipmentIds: [], items: [], paidAmount: 0, totalAmount: 0, saleFee: 0, shippingFee: 0, otherFee: 0, paymentFee: 0, transferFee: 0, cancellationFee: 0, taxFee: 0, adjustmentFee: 0, bonusAmount: 0, refundAmount: 0, productCost: 0, financeIsOfficial: false, billingBreakdown: [], _fallbackNetAmount: 0, _hasFallbackNetAmount: false, _billingEntryIds: new Set(), _officialEntryCount: 0, _officialFees: { saleFee: 0, shippingFee: 0, paymentFee: 0, transferFee: 0, cancellationFee: 0, taxFee: 0, adjustmentFee: 0, bonusAmount: 0 }, _officialSignedFees: { saleFee: 0, shippingFee: 0, paymentFee: 0, transferFee: 0, cancellationFee: 0, taxFee: 0, adjustmentFee: 0, bonusAmount: 0 } });
    const group = groups.get(groupId);
    group.internalOrderIds.push(String(row.orderId));
    if (row.shippingId) group.shipmentIds.push(String(row.shippingId));
    group.items.push(...(Array.isArray(row.items) ? row.items : []));
    if (row.reputationImpact === true) group.reputationImpact = true;
    if (row.reputationReason && !String(group.reputationReason || '').includes(row.reputationReason)) {
      group.reputationReason = [group.reputationReason, row.reputationReason].filter(Boolean).join('；');
    }
    for (const field of ['paidAmount','totalAmount','saleFee','shippingFee','otherFee','refundAmount','productCost']) group[field] += Number(row[field] || 0);
    if (row.netAmount !== null && row.netAmount !== undefined) {
      group._fallbackNetAmount += Number(row.netAmount || 0);
      group._hasFallbackNetAmount = true;
    }
    group.financeIsOfficial ||= Boolean(row.financeIsOfficial);
    const parsed = parseOrderBilling(row.billingData, Number(row.paidAmount || 0));
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
    const totalCharges = group.saleFee + group.shippingFee + group.paymentFee + group.transferFee + group.cancellationFee + group.taxFee + group.adjustmentFee;
    group.netAmount = group.status === 'cancelled'
      ? 0
      : (group.financeIsOfficial && !group.billingCurrencyMismatch
        ? Math.max(0, Number((group.paidAmount - totalCharges + group.bonusAmount).toFixed(2)))
        : (group._hasFallbackNetAmount ? Math.max(0, Number(group._fallbackNetAmount.toFixed(2))) : null));
    delete group._fallbackNetAmount; delete group._hasFallbackNetAmount; delete group._billingEntryIds; delete group._officialEntryCount; delete group._officialFees; delete group._officialSignedFees;
  }
  return [...groups.values()];
}

function extractReputationInfo(rawData) {
  const raw = rawData && typeof rawData === 'object' ? rawData : {};
  const values = [
    raw.affects_reputation,
    raw.reputation_affected,
    raw.reputation?.affected,
    raw.reputation?.affects,
    raw.feedback?.affects_reputation,
    raw.feedback?.sale?.affects_reputation
  ];
  const explicit = values.find(value => typeof value === 'boolean');
  const rating = String(raw.feedback?.sale?.rating || raw.feedback?.rating || '').toLowerCase();
  const impact = explicit === true || ['negative', 'neutral'].includes(rating)
    ? true
    : (explicit === false ? false : null);
  const reason = raw.reputation?.reason || raw.reputation_reason ||
    raw.feedback?.sale?.reason || raw.feedback?.reason ||
    (rating === 'negative' ? 'negative_feedback' : (rating === 'neutral' ? 'neutral_feedback' : ''));
  return { impact, reason: String(reason || '') };
}

app.post('/api/admin/orders/sync', requireAdmin, async (req, res) => {
  try {
    const accessToken = await getMLAccessToken();
    if (!accessToken) return res.status(401).json({ code: 401, message: '美客多应用尚未授权或授权已失效' });
    const sellerId = await getMLSellerId(accessToken);
    const [accountResponse, listingsResponse] = await Promise.all([
      axios.get('https://api.mercadolibre.com/users/me', { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }),
      axios.get(`https://api.mercadolibre.com/users/${sellerId}/items/search`, { params: { limit: 1 }, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }).catch(() => null)
    ]);
    const me = accountResponse.data || {};
    await pool.query(`INSERT INTO ml_stores(ml_user_id,nickname,site_id,updated_at) VALUES($1,$2,$3,NOW())
      ON CONFLICT(ml_user_id) DO UPDATE SET nickname=EXCLUDED.nickname,site_id=EXCLUDED.site_id,updated_at=NOW()`,
      [String(me.id || sellerId), me.nickname || '', me.site_id || '']);
    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 50));
    let response, sourceOrders;
    if (me.site_id === 'CBT') {
      response = await axios.get('https://api.mercadolibre.com/marketplace/orders/search', {
        params: { sort: 'date_desc', limit }, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 30000
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
        params: { seller: sellerId, sort: 'date_desc', limit, offset: 0 },
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
        const extraDays = created.getDay() === 5 ? 2 : ([0, 6].includes(created.getDay()) ? 1 : 0);
        handlingDeadline = new Date(created.getTime() + (48 + extraDays * 24) * 3600000).toISOString();
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
      const finalNetAmount = order.status === 'cancelled'
        ? 0
        : (officialFinance ? officialFinance.netAmount : (netAmount === null ? null : Math.max(0, Number(netAmount) - Number(refundAmount || 0))));
      const previous = await pool.query('SELECT status,shipment_status FROM ml_orders WHERE ml_order_id=$1', [String(order.id)]);
      await pool.query(`
        INSERT INTO ml_orders
          (ml_order_id,status,date_created,date_closed,buyer_id,buyer_nickname,currency,total_amount,paid_amount,shipping_id,items,raw_data,
           site_id,country,shipment_status,shipment_substatus,tracking_number,tracking_method,logistic_type,pack_id,handling_deadline,deadline_is_estimated,cancellation_reason,shipment_data,store_user_id,sale_fee,shipping_fee,net_amount,refund_amount,other_fee,billing_data,finance_is_official,finance_synced_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26,$27,$28,$29,$30,$31::jsonb,$32,CASE WHEN $32 THEN NOW() ELSE NULL END,NOW())
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
          finance_synced_at=EXCLUDED.finance_synced_at,updated_at=NOW()`,
        [String(order.id), order.status || '', order.date_created || null, order.date_closed || null,
          order.buyer?.id ? String(order.buyer.id) : null, order.buyer?.nickname || '', order.currency_id || '',
          order.total_amount || 0, order.paid_amount || 0, order.shipping?.id ? String(order.shipping.id) : null,
          JSON.stringify(orderItems), JSON.stringify(order), siteId, country, shipment.status || '', shipment.substatus || '',
          shipment.tracking_number || '', shipment.tracking_method || '', shipment.logistic?.type || shipment.logistic_type || '',
          order.pack_id ? String(order.pack_id) : String(order.id), handlingDeadline, !officialHandlingDeadline,
          String(cancellationReason).slice(0, 500), JSON.stringify(shipment), String(me.id || sellerId),
          finalSaleFee, finalShippingFee, finalNetAmount, refundAmount, otherFee, JSON.stringify(billingDetail || {}), Boolean(billingDetail)]
      );
      const old = previous.rows[0];
      if (!old) await pool.query(`INSERT INTO order_alerts(order_id,alert_type,title,content,event_key) VALUES($1,'new_order','收到新订单',$2,$3) ON CONFLICT(event_key) DO NOTHING`, [String(order.id), `${country || '未知站点'} · ${order.currency_id || ''} ${order.paid_amount || order.total_amount || 0}`, `new:${order.id}`]);
      if (order.status === 'cancelled' && old?.status !== 'cancelled') await pool.query(`INSERT INTO order_alerts(order_id,alert_type,title,content,event_key) VALUES($1,'cancelled','订单已取消',$2,$3) ON CONFLICT(event_key) DO NOTHING`, [String(order.id), `${country || '未知站点'}订单已被取消`, `cancelled:${order.id}`]);
      if (handlingDeadline && new Date(handlingDeadline).getTime() > Date.now() && new Date(handlingDeadline).getTime() - Date.now() <= 86400000 && !['shipped','delivered','cancelled'].includes(shipment.status)) {
        await pool.query(`INSERT INTO order_alerts(order_id,alert_type,title,content,event_key) VALUES($1,'deadline','订单即将延误',$2,$3) ON CONFLICT(event_key) DO NOTHING`, [String(order.id), `官方待发货截止时间：${handlingDeadline}`, `deadline:${order.id}:${handlingDeadline}`]);
      }
      imported++;
    }
    res.json({ code: 0, data: { imported, available: response.data?.paging?.total || imported, sellerId,
      account: { id: me.id, nickname: me.nickname || '', siteId: me.site_id || '', countryId: me.country_id || '',
        listings: listingsResponse?.data?.paging?.total ?? listingsResponse?.data?.results?.length ?? null } } });
  } catch (e) {
    console.error('[Orders] 同步失败:', e.response?.data || e.message);
    res.status(502).json({ code: 502, message: e.response?.data?.message || e.message });
  }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const params = [], where = [];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`o.status = $${params.length}`); }
  if (req.query.pushStatus) { params.push(String(req.query.pushStatus)); where.push(`o.push_status = $${params.length}`); }
  if (req.query.country) { params.push(String(req.query.country)); where.push(`o.country = $${params.length}`); }
  if (req.query.shipmentStatus) { params.push(String(req.query.shipmentStatus)); where.push(`o.shipment_status = $${params.length}`); }
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`o.store_user_id = $${params.length}`); }
  if (req.query.buyer) { params.push(String(req.query.buyer)); where.push(`o.buyer_nickname = $${params.length}`); }
  if (req.query.orderId) { params.push(String(req.query.orderId).trim()); where.push(`(o.ml_order_id = $${params.length} OR o.pack_id = $${params.length})`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(DISTINCT COALESCE(NULLIF(o.pack_id,''),o.ml_order_id))::int AS total FROM ml_orders o ${clause}`, params);
  params.push(size, (page - 1) * size);
  const rows = await pool.query(`SELECT o.ml_order_id AS "orderId",o.status,o.date_created AS "dateCreated",o.buyer_nickname AS buyer,o.currency,o.total_amount AS "totalAmount",o.paid_amount AS "paidAmount",o.shipping_id AS "shippingId",o.items,o.push_status AS "pushStatus",o.last_pushed_at AS "lastPushedAt",o.site_id AS "siteId",o.country,o.shipment_status AS "shipmentStatus",o.shipment_substatus AS "shipmentSubstatus",o.tracking_number AS "trackingNumber",o.tracking_method AS "trackingMethod",o.logistic_type AS "logisticType",o.pack_id AS "packId",o.handling_deadline AS "handlingDeadline",o.deadline_is_estimated AS "deadlineIsEstimated",o.cancellation_reason AS "cancellationReason",o.shipment_data AS "shipmentData",o.raw_data AS "rawData",o.store_user_id AS "storeId",COALESCE(NULLIF(s.remark,''),NULLIF(s.nickname,''),o.store_user_id,'未标记店铺') AS "storeName",s.nickname AS "storeNickname",s.remark AS "storeRemark",o.sale_fee AS "saleFee",o.shipping_fee AS "shippingFee",o.net_amount AS "netAmount",o.refund_amount AS "refundAmount",o.other_fee AS "otherFee",o.finance_is_official AS "financeIsOfficial",o.product_cost AS "productCost",o.cost_note AS "costNote" FROM ml_orders o LEFT JOIN ml_stores s ON s.ml_user_id=o.store_user_id ${clause} ORDER BY o.date_created DESC NULLS LAST LIMIT $${params.length-1} OFFSET $${params.length}`, params);
  const financeRows = rows.rows.length ? await pool.query('SELECT ml_order_id,billing_data FROM ml_orders WHERE ml_order_id=ANY($1::varchar[])', [rows.rows.map(row => row.orderId)]) : { rows: [] };
  const financeMap = new Map(financeRows.rows.map(row => [row.ml_order_id, row.billing_data]));
  for (const row of rows.rows) {
    row.billingData = financeMap.get(row.orderId) || {};
    const reputation = extractReputationInfo(row.rawData);
    row.reputationImpact = reputation.impact;
    row.reputationReason = reputation.reason;
    delete row.rawData;
  }
  const packedRows = await aggregatePackedOrders(rows.rows);
  res.json({ code: 0, data: { items: packedRows, total: count.rows[0].total, page, size } });
});

app.get('/api/admin/order-stores', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT s.ml_user_id AS id,s.nickname,s.remark,COALESCE(NULLIF(s.remark,''),s.nickname,s.ml_user_id) AS "displayName",s.site_id AS "siteId",COUNT(o.id)::int AS "orderCount" FROM ml_stores s LEFT JOIN ml_orders o ON o.store_user_id=s.ml_user_id GROUP BY s.ml_user_id ORDER BY "displayName"`);
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

function mapStoreProduct(item, ownerUsername, storeUserId) {
  return {
    ownerUsername,
    storeUserId,
    itemId: String(item.id || ''),
    title: item.title || '', status: item.status || '', price: Number(item.price || 0),
    currency: item.currency_id || '', availableQuantity: Number(item.available_quantity || 0),
    soldQuantity: Number(item.sold_quantity || 0), thumbnail: item.thumbnail || item.pictures?.[0]?.secure_url || item.pictures?.[0]?.url || '',
    permalink: item.permalink || '', categoryId: item.category_id || '', listingTypeId: item.listing_type_id || '',
    condition: item.condition || '', health: item.health == null ? null : Number(item.health),
    mlUpdatedAt: item.last_updated || item.date_created || null, rawData: item
  };
}

async function upsertStoreProduct(product) {
  await pool.query(`INSERT INTO ml_store_products
    (owner_username,store_user_id,item_id,title,status,price,currency,available_quantity,sold_quantity,thumbnail,permalink,category_id,listing_type_id,condition,health,raw_data,ml_updated_at,last_synced_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
    ON CONFLICT(owner_username,item_id) DO UPDATE SET
      store_user_id=EXCLUDED.store_user_id,title=EXCLUDED.title,status=EXCLUDED.status,price=EXCLUDED.price,
      currency=EXCLUDED.currency,available_quantity=EXCLUDED.available_quantity,sold_quantity=EXCLUDED.sold_quantity,
      thumbnail=EXCLUDED.thumbnail,permalink=EXCLUDED.permalink,category_id=EXCLUDED.category_id,
      listing_type_id=EXCLUDED.listing_type_id,condition=EXCLUDED.condition,health=EXCLUDED.health,
      raw_data=EXCLUDED.raw_data,ml_updated_at=EXCLUDED.ml_updated_at,last_synced_at=NOW()`, [
    product.ownerUsername, product.storeUserId, product.itemId, product.title, product.status, product.price,
    product.currency, product.availableQuantity, product.soldQuantity, product.thumbnail, product.permalink,
    product.categoryId, product.listingTypeId, product.condition, product.health, product.rawData,
    product.mlUpdatedAt
  ]);
}

app.get('/api/store-products/stores', requireAuth, async (req, res) => {
  await ensureLegacyStoreAuthorization(req.authUser);
  const params = [], where = ['a.enabled=TRUE'];
  if (req.authUser.role !== 'admin') { params.push(req.authUser.username); where.push(`a.owner_username=$${params.length}`); }
  const { rows } = await pool.query(`SELECT a.ml_user_id AS id,a.owner_username AS owner,a.nickname,a.site_id AS "siteId",a.updated_at AS "authorizedAt",COUNT(p.id)::int AS "productCount",MAX(p.last_synced_at) AS "lastSyncedAt" FROM ml_store_authorizations a LEFT JOIN ml_store_products p ON p.owner_username=a.owner_username AND p.store_user_id=a.ml_user_id WHERE ${where.join(' AND ')} GROUP BY a.ml_user_id,a.owner_username,a.nickname,a.site_id,a.updated_at ORDER BY a.updated_at DESC`, params);
  res.json({ code: 0, data: rows });
});

app.post('/api/store-products/sync', requireAuth, async (req, res) => {
  try {
    let auth = await findScopedStoreAuthorization(req.authUser, req.body?.storeId);
    if (!auth) auth = await ensureLegacyStoreAuthorization(req.authUser);
    if (!auth || (req.body?.storeId && String(auth.ml_user_id) !== String(req.body.storeId))) return res.status(404).json({ code: 404, message: '未找到该用户可访问的授权店铺' });
    const token = await getStoreAuthorizationToken(auth);
    if (!token) return res.status(401).json({ code: 401, message: '店铺授权已失效，请重新授权' });
    const ids = [];
    let scrollId = '', rounds = 0;
    do {
      const response = await axios.get(`https://api.mercadolibre.com/users/${auth.ml_user_id}/items/search`, {
        params: scrollId ? { search_type: 'scan', scroll_id: scrollId, limit: 100 } : { search_type: 'scan', limit: 100 },
        headers: { Authorization: `Bearer ${token}` }, timeout: 25000
      });
      const batch = response.data?.results || [];
      ids.push(...batch.map(String));
      scrollId = response.data?.scroll_id || '';
      rounds++;
      if (!batch.length || !scrollId || rounds >= 100) break;
    } while (true);
    let synced = 0, failed = 0;
    for (let i = 0; i < ids.length; i += 10) {
      const batch = await Promise.all(ids.slice(i, i + 10).map(async itemId => {
        try {
          const response = await axios.get(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 15000
          });
          await upsertStoreProduct(mapStoreProduct(response.data || {}, auth.owner_username, auth.ml_user_id));
          return true;
        } catch (error) { console.warn('[StoreProducts] 商品同步失败:', itemId, error.response?.status || error.message); return false; }
      }));
      synced += batch.filter(Boolean).length; failed += batch.filter(value => !value).length;
    }
    res.json({ code: 0, data: { discovered: ids.length, synced, failed, storeId: auth.ml_user_id } });
  } catch (e) {
    res.status(e.response?.status || 500).json({ code: e.response?.status || 500, message: e.response?.data?.message || e.message });
  }
});

app.get('/api/store-products', requireAuth, async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1)), size = Math.min(100, Math.max(10, Number(req.query.size || 20)));
  const params = [], where = [];
  if (req.authUser.role !== 'admin') { params.push(req.authUser.username); where.push(`p.owner_username=$${params.length}`); }
  if (req.query.owner && req.authUser.role === 'admin') { params.push(String(req.query.owner)); where.push(`p.owner_username=$${params.length}`); }
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`p.store_user_id=$${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status)); where.push(`p.status=$${params.length}`); }
  if (req.query.keyword) { params.push(`%${String(req.query.keyword).trim()}%`); where.push(`(p.title ILIKE $${params.length} OR p.item_id ILIKE $${params.length})`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = await pool.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='active')::int AS active,COUNT(*) FILTER(WHERE status='paused')::int AS paused,COUNT(*) FILTER(WHERE status='closed')::int AS closed FROM ml_store_products p ${clause}`, params);
  const listParams = [...params, size, (page - 1) * size];
  const { rows } = await pool.query(`SELECT p.item_id AS "itemId",p.owner_username AS owner,p.store_user_id AS "storeId",COALESCE(NULLIF(a.nickname,''),p.store_user_id) AS "storeName",p.title,p.status,p.price,p.currency,p.available_quantity AS "availableQuantity",p.sold_quantity AS "soldQuantity",p.thumbnail,p.permalink,p.category_id AS "categoryId",p.listing_type_id AS "listingTypeId",p.condition,p.health,p.ignored,p.raw_data->'variations' AS variations,p.ml_updated_at AS "mlUpdatedAt",p.last_synced_at AS "lastSyncedAt" FROM ml_store_products p LEFT JOIN ml_store_authorizations a ON a.owner_username=p.owner_username AND a.ml_user_id=p.store_user_id ${clause} ORDER BY p.ml_updated_at DESC NULLS LAST,p.item_id LIMIT $${listParams.length-1} OFFSET $${listParams.length}`, listParams);
  res.json({ code: 0, data: { items: rows, page, size, ...count.rows[0] } });
});

async function findScopedStoreProduct(authUser, itemId) {
  const params = [String(itemId)];
  let where = 'item_id=$1';
  if (authUser.role !== 'admin') {
    params.push(authUser.username);
    where += ` AND owner_username=$${params.length}`;
  }
  const { rows } = await pool.query(`SELECT * FROM ml_store_products WHERE ${where} ORDER BY last_synced_at DESC LIMIT 1`, params);
  return rows[0] || null;
}

app.get('/api/store-products/:itemId/detail', requireAuth, async (req, res) => {
  try {
    const product = await findScopedStoreProduct(req.authUser, req.params.itemId);
    if (!product) return res.status(404).json({ code: 404, message: '商品不存在，请先同步' });
    const auth = await findScopedStoreAuthorization(req.authUser, product.store_user_id);
    const token = await getStoreAuthorizationToken(auth);
    if (!token) return res.status(401).json({ code: 401, message: '店铺授权已失效，请重新授权' });
    const [itemResponse, descriptionResponse] = await Promise.all([
      axios.get(`https://api.mercadolibre.com/items/${encodeURIComponent(product.item_id)}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }),
      axios.get(`https://api.mercadolibre.com/items/${encodeURIComponent(product.item_id)}/description`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }).catch(() => ({ data: {} }))
    ]);
    res.json({ code: 0, data: { ...itemResponse.data, description: descriptionResponse.data?.plain_text || '' } });
  } catch (e) {
    res.status(e.response?.status || 500).json({ code: e.response?.status || 500, message: e.response?.data?.message || e.message });
  }
});

app.patch('/api/store-products/:itemId', requireAuth, async (req, res) => {
  try {
    const itemId = String(req.params.itemId);
    const product = await findScopedStoreProduct(req.authUser, itemId);
    if (!product) return res.status(404).json({ code: 404, message: '商品不存在，请先同步' });
    const auth = await findScopedStoreAuthorization(req.authUser, product.store_user_id);
    const token = await getStoreAuthorizationToken(auth);
    if (!token) return res.status(401).json({ code: 401, message: '店铺授权已失效，请重新授权' });
    const update = {};
    if (req.body?.price !== undefined) {
      const price = Number(req.body.price); if (!(price > 0)) return res.status(400).json({ code: 400, message: '价格必须大于0' }); update.price = price;
    }
    if (req.body?.availableQuantity !== undefined) {
      const quantity = Number(req.body.availableQuantity); if (!Number.isInteger(quantity) || quantity < 0) return res.status(400).json({ code: 400, message: '库存必须是大于等于0的整数' }); update.available_quantity = quantity;
    }
    if (req.body?.status !== undefined) {
      const status = String(req.body.status); if (!['active','paused','closed'].includes(status)) return res.status(400).json({ code: 400, message: '仅支持上架、暂停或关闭商品' }); update.status = status;
    }
    if (req.body?.title !== undefined) update.title = String(req.body.title || '').trim().slice(0, 255);
    if (req.body?.pictures !== undefined) {
      if (!Array.isArray(req.body.pictures) || !req.body.pictures.length) return res.status(400).json({ code: 400, message: '至少保留一张商品图片' });
      update.pictures = req.body.pictures.slice(0, 12).map(source => ({ source: String(source).trim() })).filter(picture => picture.source);
    }
    if (req.body?.variations !== undefined) {
      if (!Array.isArray(req.body.variations)) return res.status(400).json({ code: 400, message: '变体数据格式不正确' });
      update.variations = req.body.variations;
    }
    if (req.body?.weight !== undefined) {
      const weight = String(req.body.weight || '').trim();
      if (!/^\d+(?:\.\d+)?\s*(?:g|kg)$/i.test(weight)) return res.status(400).json({ code: 400, message: '重量格式示例：500 g 或 1.2 kg' });
      update.attributes = [{ id: 'PACKAGE_WEIGHT', value_name: weight }];
    }
    if (!Object.keys(update).length && req.body?.description === undefined) return res.status(400).json({ code: 400, message: '没有可更新的商品字段' });
    if (Object.keys(update).length) await axios.put(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`, update, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000
    });
    if (req.body?.description !== undefined) await axios.put(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description?api_version=2`, {
      plain_text: String(req.body.description || '').slice(0, 50000)
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    const fresh = await axios.get(`https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000
    });
    await upsertStoreProduct(mapStoreProduct(fresh.data || {}, product.owner_username, product.store_user_id));
    res.json({ code: 0, data: mapStoreProduct(fresh.data || {}, product.owner_username, product.store_user_id) });
  } catch (e) {
    res.status(e.response?.status || 500).json({ code: e.response?.status || 500, message: e.response?.data?.message || e.message });
  }
});

app.post('/api/store-products/:itemId/relist', requireAuth, async (req, res) => {
  try {
    const product = await findScopedStoreProduct(req.authUser, req.params.itemId);
    if (!product) return res.status(404).json({ code: 404, message: '商品不存在，请先同步' });
    const auth = await findScopedStoreAuthorization(req.authUser, product.store_user_id);
    const token = await getStoreAuthorizationToken(auth);
    if (!token) return res.status(401).json({ code: 401, message: '店铺授权已失效，请重新授权' });
    if (product.status !== 'closed') return res.status(400).json({ code: 400, message: '只有已关闭且关闭未超过 60 天的商品可以重新发布' });
    const raw = product.raw_data || {};
    const relistBody = { listing_type_id: product.listing_type_id || raw.listing_type_id };
    if (Array.isArray(raw.variations) && raw.variations.length) {
      relistBody.variations = raw.variations.map(variation => ({
        id: variation.id,
        price: Number(variation.price || product.price),
        quantity: Math.max(0, Number(variation.available_quantity || 0))
      }));
    } else {
      relistBody.price = Number(product.price);
      relistBody.quantity = Math.max(1, Number(product.available_quantity || 1));
    }
    const response = await axios.post(`https://api.mercadolibre.com/items/${encodeURIComponent(product.item_id)}/relist`, relistBody, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    const fresh = await axios.get(`https://api.mercadolibre.com/items/${encodeURIComponent(response.data?.id || product.item_id)}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    await upsertStoreProduct(mapStoreProduct(fresh.data || {}, product.owner_username, product.store_user_id));
    res.json({ code: 0, data: response.data });
  } catch (e) {
    res.status(e.response?.status || 500).json({ code: e.response?.status || 500, message: e.response?.data?.message || e.message });
  }
});

app.patch('/api/store-products/:itemId/local', requireAuth, async (req, res) => {
  const product = await findScopedStoreProduct(req.authUser, req.params.itemId);
  if (!product) return res.status(404).json({ code: 404, message: '商品不存在' });
  await pool.query('UPDATE ml_store_products SET ignored=$1 WHERE id=$2', [Boolean(req.body?.ignored), product.id]);
  res.json({ code: 0 });
});

app.delete('/api/store-products/:itemId/local', requireAuth, async (req, res) => {
  const product = await findScopedStoreProduct(req.authUser, req.params.itemId);
  if (!product) return res.status(404).json({ code: 404, message: '商品不存在' });
  await pool.query('DELETE FROM ml_store_products WHERE id=$1', [product.id]);
  res.json({ code: 0 });
});

app.patch('/api/admin/order-stores/:id', requireAdmin, async (req, res) => {
  const remark = String(req.body?.remark || '').trim().slice(0, 300);
  const { rowCount } = await pool.query('UPDATE ml_stores SET remark=$1,updated_at=NOW() WHERE ml_user_id=$2', [remark, req.params.id]);
  if (!rowCount) return res.status(404).json({ code: 404, message: '店铺不存在' });
  res.json({ code: 0 });
});

app.get('/api/admin/order-buyers', requireAdmin, async (req, res) => {
  const params = [], where = ["buyer_nickname IS NOT NULL", "buyer_nickname<>''"];
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`store_user_id=$${params.length}`); }
  if (req.query.country) { params.push(String(req.query.country)); where.push(`country=$${params.length}`); }
  const { rows } = await pool.query(`SELECT buyer_nickname AS buyer,COUNT(*)::int AS "orderCount",MIN(date_created) AS "firstOrderAt",MAX(date_created) AS "lastOrderAt",ARRAY_REMOVE(ARRAY_AGG(DISTINCT country),NULL) AS countries FROM ml_orders WHERE ${where.join(' AND ')} GROUP BY buyer_nickname ORDER BY COUNT(*) DESC,MAX(date_created) DESC LIMIT 500`, params);
  res.json({ code: 0, data: rows });
});

app.get('/api/admin/order-buyers/:buyer', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT ml_order_id AS "orderId",date_created AS "dateCreated",country,currency,paid_amount AS "paidAmount",status,shipment_status AS "shipmentStatus",items,store_user_id AS "storeId" FROM ml_orders WHERE buyer_nickname=$1 ORDER BY date_created DESC LIMIT 200`, [req.params.buyer]);
  const totals = {};
  for (const order of rows) totals[order.currency || '-'] = Number((totals[order.currency || '-'] || 0) + Number(order.paidAmount || 0)).toFixed(2);
  res.json({ code: 0, data: { buyer: req.params.buyer, orders: rows, totals } });
});

app.patch('/api/admin/orders/:orderId/cost', requireAdmin, async (req, res) => {
  const cost = Number(req.body?.cost);
  if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ code: 400, message: '成本必须是大于等于0的数字' });
  const note = String(req.body?.note || '').trim().slice(0, 500);
  const { rowCount } = await pool.query('UPDATE ml_orders SET product_cost=$1,cost_note=$2,updated_at=NOW() WHERE ml_order_id=$3', [cost, note, req.params.orderId]);
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
  const params = [], where = [];
  if (req.query.storeId) { params.push(String(req.query.storeId)); where.push(`o.store_user_id=$${params.length}`); }
  if (req.query.country) { params.push(String(req.query.country)); where.push(`o.country=$${params.length}`); }
  if (req.query.orderId) { params.push(String(req.query.orderId).trim()); where.push(`(o.ml_order_id = $${params.length} OR o.pack_id = $${params.length})`); }
  const days = Number(req.query.days || 0);
  if ([1,3,7,15,30,90,180,365].includes(days)) { params.push(days); where.push(`o.date_created >= NOW() - ($${params.length}::int * INTERVAL '1 day')`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT o.ml_order_id AS "orderId",o.status,o.shipment_status AS "shipmentStatus",o.date_created AS "dateCreated",o.country,o.currency,o.paid_amount AS "paidAmount",o.sale_fee AS "saleFee",o.shipping_fee AS "shippingFee",o.net_amount AS "netAmount",o.refund_amount AS "refundAmount",o.other_fee AS "otherFee",o.finance_is_official AS "financeIsOfficial",o.product_cost AS "productCost",o.cost_note AS "costNote",o.items,COALESCE(NULLIF(s.remark,''),s.nickname,o.store_user_id) AS "storeName" FROM ml_orders o LEFT JOIN ml_stores s ON s.ml_user_id=o.store_user_id ${clause} ORDER BY o.date_created DESC LIMIT 500`, params);
  const idRows = rows.length ? await pool.query('SELECT ml_order_id,pack_id,billing_data,shipping_id FROM ml_orders WHERE ml_order_id=ANY($1::varchar[])', [rows.map(row => row.orderId)]) : { rows: [] };
  const displayIdMap = new Map(idRows.rows.map(row => [row.ml_order_id, row.pack_id || row.ml_order_id]));
  const idDetailMap = new Map(idRows.rows.map(row => [row.ml_order_id, row]));
  for (const row of rows) { const detail = idDetailMap.get(row.orderId); row.packId = detail?.pack_id || row.orderId; row.shippingId = detail?.shipping_id || ''; row.billingData = detail?.billing_data || {}; }
  const packedProfitRows = await aggregatePackedOrders(rows);
  const exchangeRate = await getUsdCnyRate();
  const summary = {};
  for (const row of packedProfitRows) {
    const currency = row.currency || '-';
    const payoutForProfit = row.financeIsOfficial
      ? Number(row.netAmount ?? 0)
      : Number(row.netAmount ?? row.paidAmount ?? 0) - Number(row.refundAmount || 0);
    row.profitCny = currency === 'USD' && row.netAmount !== null ? payoutForProfit * exchangeRate - Number(row.productCost || 0) : null;
    row.profitBasis = 'net_payout';
    summary[currency] ||= { paidAmount: 0, netAmount: 0, refundAmount: 0, productCostCny: 0, profitCny: 0, orderCount: 0 };
    summary[currency].paidAmount += Number(row.paidAmount || 0); summary[currency].netAmount += Number(row.netAmount ?? row.paidAmount ?? 0);
    summary[currency].refundAmount += Number(row.refundAmount || 0); summary[currency].productCostCny += Number(row.productCost || 0);
    summary[currency].profitCny += Number(row.profitCny || 0); summary[currency].orderCount++;
  }
  res.json({ code: 0, data: { items: packedProfitRows, summary, exchangeRate } });
});

app.get('/api/admin/order-inquiries', requireAdmin, async (req, res) => {
  try {
    const token = await getMLAccessToken();
    const sellerId = await getMLSellerId(token);
    const unreadResponse = await axios.get('https://api.mercadolibre.com/marketplace/messages/unread', {
      params: { user_id: sellerId }, headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    }).catch(() => ({ data: {} }));
    const raw = unreadResponse.data || {};
    const source = Array.isArray(raw) ? raw : (raw.results || raw.messages || raw.unread_messages || raw.data || []);
    const list = Array.isArray(source) ? source : [];
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
      const result = await pool.query(`SELECT ml_order_id AS "orderId",pack_id AS "packId",buyer_nickname AS buyer,country,date_created AS "dateCreated",items FROM ml_orders WHERE pack_id=ANY($1::varchar[]) OR ml_order_id=ANY($1::varchar[]) ORDER BY date_created DESC`, [packIds]);
      unreadOrders = result.rows;
    }
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayItems = list.filter(item => {
      const value = item.message_date || item.date_created || item.created_at || item.last_updated;
      const date = value ? new Date(value) : null;
      return !date || Number.isNaN(date.getTime()) || date >= todayStart;
    });
    const todayPackIds = new Set(todayItems.flatMap(messageOrderRefs));
    const matchedUnreadOrders = todayPackIds.size ? unreadOrders.filter(order => todayPackIds.has(String(order.packId)) || todayPackIds.has(String(order.orderId))) : unreadOrders;

    // “今日咨询”必须包含已经被管理员点开、但今天确实收到过买家消息的订单，不能只依赖 unread。
    const recentResult = await pool.query(`SELECT DISTINCT ON (COALESCE(NULLIF(pack_id,''),ml_order_id)) ml_order_id AS "orderId",pack_id AS "packId",buyer_nickname AS buyer,country,date_created AS "dateCreated",items FROM ml_orders WHERE date_created >= CURRENT_DATE - INTERVAL '1 day' ORDER BY COALESCE(NULLIF(pack_id,''),ml_order_id),date_created DESC LIMIT 40`);
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
            if (sender && sender === String(sellerId)) return false;
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
    res.json({ code: 0, data: { count: itemMap.size, items: [...itemMap.values()], orders: [...orderMap.values()] } });
  } catch (e) {
    const status = e.response?.status || 502;
    res.status(status).json({ code: status, message: status === 403 ? '该店铺暂不支持美客多售后消息接口' : (e.response?.data?.message || e.message) });
  }
});

app.get('/api/admin/order-after-sales', requireAdmin, async (req, res) => {
  try {
    const token = await getMLAccessToken();
    const sellerId = await getMLSellerId(token);
    const response = await axios.get('https://api.mercadolibre.com/post-purchase/v1/claims/search', {
      params: { status: 'opened', seller_id: sellerId, sort: 'last_updated:desc' }, headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    });
    const raw = response.data || {};
    const claims = Array.isArray(raw) ? raw : (raw.data || raw.results || []);
    const orderIds = [...new Set(claims.map(claim => String(claim.resource_id || claim.order_id || claim.resource?.split('/')?.pop() || '')).filter(Boolean))];
    const orderResult = orderIds.length ? await pool.query(`SELECT ml_order_id AS "orderId",pack_id AS "packId",buyer_nickname AS buyer,country,date_created AS "dateCreated",items FROM ml_orders WHERE ml_order_id=ANY($1::varchar[]) OR pack_id=ANY($1::varchar[])`, [orderIds]) : { rows: [] };
    const ordersById = new Map();
    for (const order of orderResult.rows) { ordersById.set(String(order.orderId), order); ordersById.set(String(order.packId), order); }
    const items = claims.map(claim => ({ ...claim, order: ordersById.get(String(claim.resource_id || claim.order_id || claim.resource?.split('/')?.pop() || '')) || null }));
    res.json({ code: 0, data: { count: Number(raw.paging?.total || raw.total || items.length), items, orders: items.map(item => item.order).filter(Boolean) } });
  } catch (e) {
    const status = e.response?.status || 502;
    res.status(status).json({ code: status, message: status === 403 ? '该店铺暂不支持售后申诉接口' : (e.response?.data?.message || e.message) });
  }
});

app.get('/api/admin/order-claims/:claimId/messages', requireAdmin, async (req, res) => {
  try {
    const token = await getMLAccessToken();
    const response = await axios.get(`https://api.mercadolibre.com/post-purchase/v1/claims/${encodeURIComponent(req.params.claimId)}/messages`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    res.json({ code: 0, data: response.data });
  } catch (e) { const status = e.response?.status || 502; res.status(status).json({ code: status, message: e.response?.data?.message || e.message }); }
});

app.post('/api/admin/order-claims/:claimId/messages', requireAdmin, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ code: 400, message: '回复内容不能为空' });
  try {
    const token = await getMLAccessToken();
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
  const params = [], where = [];
  if (req.query.type) { params.push(String(req.query.type)); where.push(`alert_type=$${params.length}`); }
  if (req.query.read === 'true' || req.query.read === 'false') { params.push(req.query.read === 'true'); where.push(`is_read=$${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows }, unread] = await Promise.all([
    pool.query(`SELECT a.id,a.order_id AS "orderId",COALESCE(NULLIF(o.pack_id,''),a.order_id) AS "displayOrderId",a.alert_type AS type,a.title,a.content,a.is_read AS "isRead",a.created_at AS "createdAt",o.country,COALESCE(NULLIF(s.remark,''),NULLIF(s.nickname,''),o.store_user_id,'授权店铺') AS "storeName" FROM order_alerts a LEFT JOIN ml_orders o ON o.ml_order_id=a.order_id LEFT JOIN ml_stores s ON s.ml_user_id=o.store_user_id ${clause ? clause.replaceAll('alert_type','a.alert_type').replaceAll('is_read','a.is_read') : ''} ORDER BY a.created_at DESC LIMIT 200`, params),
    pool.query('SELECT COUNT(*)::int AS count FROM order_alerts WHERE is_read=FALSE')
  ]);
  res.json({ code: 0, data: { items: rows, unread: unread.rows[0].count } });
});

app.post('/api/admin/order-alerts/read-all', requireAdmin, async (req, res) => {
  await pool.query('UPDATE order_alerts SET is_read=TRUE WHERE is_read=FALSE');
  res.json({ code: 0 });
});

app.post('/api/admin/order-alerts/:id/read', requireAdmin, async (req, res) => {
  await pool.query('UPDATE order_alerts SET is_read=TRUE WHERE id=$1', [req.params.id]);
  res.json({ code: 0 });
});

app.get('/api/admin/orders/:orderId/label', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT shipping_id FROM ml_orders WHERE ml_order_id=$1 OR pack_id=$1 ORDER BY date_created', [req.params.orderId]);
    const shipmentIds = [...new Set(rows.map(row => row.shipping_id).filter(Boolean))];
    if (!shipmentIds.length) return res.status(404).json({ code: 404, message: '该订单暂无可下载面单' });
    const token = await getMLAccessToken();
    let pdfResponse;
    for (const path of ['shipment_labels', 'marketplace/shipment_labels']) {
      try {
        pdfResponse = await axios.get(`https://api.mercadolibre.com/${path}`, {
          params: { shipment_ids: shipmentIds.join(','), response_type: 'pdf' },
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' }, responseType: 'arraybuffer', timeout: 30000
        });
        if (pdfResponse?.data) break;
      } catch (error) { if (error.response?.status !== 404) throw error; }
    }
    if (!pdfResponse?.data) return res.status(404).json({ code: 404, message: '美客多暂未生成该订单面单' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mercado-label-${req.params.orderId}.pdf"`);
    res.send(Buffer.from(pdfResponse.data));
  } catch (e) {
    const status = e.response?.status || 502;
    res.status(status).json({ code: status, message: e.response?.data?.message || e.message });
  }
});

app.get('/api/admin/orders/:orderId/messages', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT pack_id FROM ml_orders WHERE ml_order_id=$1', [req.params.orderId]);
    if (!rows[0]) return res.status(404).json({ code: 404, message: '订单不存在' });
    const token = await getMLAccessToken();
    const packId = rows[0].pack_id || req.params.orderId;
    const response = await axios.get(`https://api.mercadolibre.com/marketplace/messages/packs/${packId}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 20000
    });
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
    const { rows } = await pool.query('SELECT pack_id FROM ml_orders WHERE ml_order_id=$1', [req.params.orderId]);
    if (!rows[0]) return res.status(404).json({ code: 404, message: '订单不存在' });
    const token = await getMLAccessToken();
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
  const { rows } = await pool.query('SELECT id,name,code,description,enabled FROM fulfillment_services ORDER BY id DESC');
  res.json({ code: 0, data: rows });
});

app.post('/api/admin/fulfillment-services', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ code: 400, message: '增值服务名称不能为空' });
  const { rows } = await pool.query('INSERT INTO fulfillment_services(name,code,description) VALUES($1,$2,$3) RETURNING id', [name.slice(0,120), String(req.body?.code || '').trim().slice(0,100), String(req.body?.description || '').trim().slice(0,500)]);
  res.json({ code: 0, data: rows[0] });
});

app.delete('/api/admin/fulfillment-services/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM fulfillment_services WHERE id=$1', [req.params.id]);
  res.json({ code: 0 });
});

app.post('/api/admin/fulfillment/submit', requireAdmin, async (req, res) => {
  const orderIds = [...new Set((Array.isArray(req.body?.orderIds) ? req.body.orderIds : []).map(String).filter(Boolean))];
  const warehouseId = Number(req.body?.warehouseId), carrier = String(req.body?.carrier || '').trim();
  const trackingByOrder = req.body?.trackingByOrder || {}, serviceIds = (req.body?.serviceIds || []).map(Number).filter(Number.isFinite);
  if (!orderIds.length || !warehouseId || !carrier) return res.status(400).json({ code: 400, message: '请选择订单、仓库和物流公司' });
  const connectorResult = await pool.query('SELECT * FROM erp_connectors WHERE id=$1 AND enabled=TRUE', [warehouseId]);
  if (!connectorResult.rows[0]) return res.status(404).json({ code: 404, message: '仓库不存在或已停用' });
  const serviceResult = serviceIds.length ? await pool.query('SELECT id,name,code,description FROM fulfillment_services WHERE enabled=TRUE AND id=ANY($1::bigint[])', [serviceIds]) : { rows: [] };
  const warehouse = connectorResult.rows[0], headers = { 'Content-Type': 'application/json' };
  if (warehouse.auth_header && warehouse.auth_value) headers[warehouse.auth_header] = decryptErpCredential(warehouse.auth_value);
  const results = [];
  for (const displayOrderId of orderIds) {
    const trackingNumber = String(trackingByOrder[displayOrderId] || '').trim();
    if (!trackingNumber) { results.push({ orderId: displayOrderId, success: false, message: '缺少快递单号' }); continue; }
    const orderResult = await pool.query('SELECT * FROM ml_orders WHERE ml_order_id=$1 OR pack_id=$1 ORDER BY date_created', [displayOrderId]);
    if (!orderResult.rows.length) { results.push({ orderId: displayOrderId, success: false, message: '订单不存在' }); continue; }
    const payload = { source: 'shanyue-erp', action: 'fulfillment_label', order_id: displayOrderId, carrier, tracking_number: trackingNumber, value_added_services: serviceResult.rows, orders: orderResult.rows.map(row => row.raw_data) };
    try {
      const pushed = await axios.post(warehouse.endpoint, payload, { headers, timeout: 30000, maxRedirects: 0 });
      await pool.query(`INSERT INTO fulfillment_submissions(order_id,warehouse_id,carrier,tracking_number,service_ids,status,request_data,response_text) VALUES($1,$2,$3,$4,$5::jsonb,'success',$6::jsonb,$7) ON CONFLICT(order_id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,carrier=EXCLUDED.carrier,tracking_number=EXCLUDED.tracking_number,service_ids=EXCLUDED.service_ids,status='success',request_data=EXCLUDED.request_data,response_text=EXCLUDED.response_text,updated_at=NOW()`, [displayOrderId,warehouseId,carrier,trackingNumber,JSON.stringify(serviceIds),JSON.stringify(payload),JSON.stringify(pushed.data).slice(0,5000)]);
      results.push({ orderId: displayOrderId, success: true });
    } catch (error) {
      await pool.query(`INSERT INTO fulfillment_submissions(order_id,warehouse_id,carrier,tracking_number,service_ids,status,request_data,response_text) VALUES($1,$2,$3,$4,$5::jsonb,'failed',$6::jsonb,$7) ON CONFLICT(order_id) DO UPDATE SET status='failed',response_text=EXCLUDED.response_text,updated_at=NOW()`, [displayOrderId,warehouseId,carrier,trackingNumber,JSON.stringify(serviceIds),JSON.stringify(payload),JSON.stringify(error.response?.data || error.message).slice(0,5000)]);
      results.push({ orderId: displayOrderId, success: false, message: error.response?.data?.message || error.message });
    }
  }
  const success = results.filter(item => item.success).length;
  res.status(success ? 200 : 502).json({ code: success ? 0 : 502, data: { success, failed: results.length - success, results }, message: success ? '代贴单已提交' : '代贴单提交失败' });
});

app.get('/api/admin/erp-connectors', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,endpoint,auth_header AS "authHeader",enabled,created_at AS "createdAt" FROM erp_connectors ORDER BY id DESC');
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
  const { rows } = await pool.query('INSERT INTO erp_connectors(name,endpoint,auth_header,auth_value) VALUES($1,$2,$3,$4) RETURNING id', [String(name).slice(0,120), target.href, String(authHeader || '').slice(0,120), encryptedAuth]);
  res.json({ code: 0, data: { id: rows[0].id } });
});

app.delete('/api/admin/erp-connectors/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM erp_connectors WHERE id=$1', [req.params.id]);
  res.json({ code: 0 });
});

app.post('/api/admin/orders/:orderId/push', requireAdmin, async (req, res) => {
  const order = await pool.query('SELECT * FROM ml_orders WHERE ml_order_id=$1', [req.params.orderId]);
  const connector = await pool.query('SELECT * FROM erp_connectors WHERE id=$1 AND enabled=TRUE', [req.body?.connectorId]);
  if (!order.rows[0] || !connector.rows[0]) return res.status(404).json({ code: 404, message: '订单或ERP连接不存在' });
  const c = connector.rows[0], headers = { 'Content-Type': 'application/json' };
  try {
    if (c.auth_header && c.auth_value) headers[c.auth_header] = decryptErpCredential(c.auth_value);
    const pushed = await axios.post(c.endpoint, { source: 'shanyue-erp', order: order.rows[0].raw_data }, { headers, timeout: 30000, maxRedirects: 0 });
    await pool.query("UPDATE ml_orders SET push_status='success',last_pushed_at=NOW() WHERE ml_order_id=$1", [req.params.orderId]);
    await pool.query('INSERT INTO erp_push_logs(order_id,connector_id,success,http_status,response_text) VALUES($1,$2,TRUE,$3,$4)', [req.params.orderId,c.id,pushed.status,JSON.stringify(pushed.data).slice(0,5000)]);
    res.json({ code: 0, data: { status: pushed.status } });
  } catch (e) {
    await pool.query("UPDATE ml_orders SET push_status='failed',last_pushed_at=NOW() WHERE ml_order_id=$1", [req.params.orderId]);
    await pool.query('INSERT INTO erp_push_logs(order_id,connector_id,success,http_status,response_text) VALUES($1,$2,FALSE,$3,$4)', [req.params.orderId,c.id,e.response?.status || null,JSON.stringify(e.response?.data || e.message).slice(0,5000)]);
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log('============================================');
    console.log('  美客多爆品选品雷达 - 云端管理后台');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`  管理页面: http://localhost:${PORT}/`);
    console.log('============================================');
  });
}

start();
