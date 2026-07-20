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
    return data.access_token;
  } catch (e) {
    console.error('[ML] Token刷新失败:', e.response?.data || e.message);
    return null;
  }
}

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

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:80px">
        <h2 style="color:#00a650">✅ Mercado Libre 授权成功！</h2>
        <p>选品工具已可以正常使用，你可以关闭此页面了。</p>
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
          (country, item_id, title, price, currency, discount, image_url, product_url, category_name, category_url, listing_time, last_seen_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (country, item_id) DO UPDATE SET
          title=EXCLUDED.title, price=EXCLUDED.price, currency=EXCLUDED.currency,
          discount=EXCLUDED.discount, image_url=EXCLUDED.image_url, product_url=EXCLUDED.product_url,
          category_name=EXCLUDED.category_name, category_url=EXCLUDED.category_url,
          listing_time=COALESCE(EXCLUDED.listing_time, international_products.listing_time), last_seen_at=NOW()`,
        [country, String(item.itemId).slice(0, 40), String(item.title).slice(0, 1000),
          Number.isFinite(Number(item.price)) ? Number(item.price) : null, String(item.currency || '').slice(0, 3),
          String(item.discount || '').slice(0, 80), String(item.imageUrl || '').slice(0, 3000),
          String(item.productUrl).slice(0, 3000), String(item.categoryName || '').slice(0, 300),
          String(item.categoryUrl || '').slice(0, 3000), item.listingTime ? new Date(item.listingTime) : null]
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
    image_url AS "imageUrl", product_url AS "productUrl", category_name AS "categoryName",
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log('============================================');
    console.log('  美客多爆品选品雷达 - 云端管理后台');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`  管理页面: http://localhost:${PORT}/`);
    console.log('============================================');
  });
}

start();
