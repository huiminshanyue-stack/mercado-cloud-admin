const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query("SELECT * FROM ml_store_authorizations WHERE enabled=TRUE AND nickname ILIKE '%TONRON%' ORDER BY updated_at DESC LIMIT 1");
  const auth = rows[0];
  if (!auth) throw new Error('authorization not found');
  const keySource = process.env.ERP_CREDENTIAL_KEY || process.env.ML_CLIENT_SECRET || process.env.SYNC_API_KEY;
  const [version, iv, tag, encrypted] = String(auth.access_token_encrypted).split(':');
  const key = crypto.createHash('sha256').update(keySource).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const token = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
  const headers = { Authorization: `Bearer ${token}`, version: 'v2', ...(process.env.ML_CLIENT_ID ? { 'X-Client-Id': process.env.ML_CLIENT_ID, 'X-Caller-Id': process.env.ML_CLIENT_ID } : {}) };
  const discovered = new Map();
  const search = await axios.get(`https://api.mercadolibre.com/users/${auth.ml_user_id}/items/search`, { params: { status: 'active', limit: 50, offset: 0 }, headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
  const ids = (search.data?.results || []).map(String);
  for (const itemId of ids.slice(0, 20)) {
    try {
      const detail = (await axios.get(`https://api.mercadolibre.com/marketplace/items/${itemId}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })).data || {};
      const walk = value => {
        if (!value || typeof value !== 'object') return;
        const rawId = String(value.item_id || value.id || '');
        const siteId = String(value.site_id || rawId.match(/^(MLM|MLB|MLC|MCO|MLA)/)?.[1] || '').toUpperCase();
        const userId = String(value.seller_id || value.seller?.id || value.user_id || '');
        if (['MLM','MLB','MLC','MCO','MLA'].includes(siteId) && userId) discovered.set(siteId, userId);
        for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
      };
      walk(detail);
    } catch {}
  }
  let advertisers = [];
  try { advertisers = (await axios.get('https://api.mercadolibre.com/advertising/advertisers', { params: { product_id: 'PADS', type: 'SELLER' }, headers: { Authorization: `Bearer ${token}`, 'api-version': '1' }, timeout: 20000 })).data?.advertisers || []; } catch {}
  for (const advertiser of advertisers) {
    const userId = String(advertiser.account_name || '').match(/(?:ID\s*-\s*)?(\d+)\s*$/i)?.[1] || '';
    if (advertiser.site_id && userId && !discovered.has(advertiser.site_id)) discovered.set(advertiser.site_id, userId);
  }
  const results = [];
  for (const siteId of ['MLM','MLB','MLC','MCO','MLA']) {
    const userId = discovered.get(siteId) || String(auth.ml_user_id);
    try {
      const response = await axios.get(`https://api.mercadolibre.com/marketplace/seller-promotions/users/${userId}`, { headers, timeout: 20000 });
      const promotions = response.data?.results || [];
      results.push({ siteId, userId, discovered: discovered.has(siteId), total: promotions.length, ids: promotions.map(x => x.id).slice(0, 10) });
    } catch (error) { results.push({ siteId, userId, discovered: discovered.has(siteId), error: error.response?.status || error.message }); }
  }
  console.log(JSON.stringify({ root: auth.ml_user_id, searched: ids.length, discovered: Object.fromEntries(discovered), results }, null, 2));
  await pool.end();
})().catch(error => { console.error(error.message); process.exit(1); });
