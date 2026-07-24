const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');

function decrypt(value) {
  const source = process.env.ERP_CREDENTIAL_KEY || process.env.ML_CLIENT_SECRET || process.env.SYNC_API_KEY;
  const [, iv, tag, encrypted] = String(value).split(':');
  const key = crypto.createHash('sha256').update(source).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query("SELECT * FROM ml_store_authorizations WHERE enabled=TRUE AND nickname ILIKE '%TONRON%' ORDER BY updated_at DESC LIMIT 1");
  const auth = rows[0], token = decrypt(rows[0].access_token_encrypted);
  const authHeader = { Authorization: `Bearer ${token}` };
  const output = { root: auth.ml_user_id, searches: [], advertisers: [], samples: [], promotionProbes: [] };
  for (const base of ['users', 'marketplace/users']) {
    for (const siteId of ['', 'MLM', 'MLB', 'MLC', 'MCO', 'MLA']) {
      try {
        const response = await axios.get(`https://api.mercadolibre.com/${base}/${auth.ml_user_id}/items/search`, { params: { status: 'active', limit: 10, ...(siteId ? { site_id: siteId } : {}) }, headers: authHeader, timeout: 20000 });
        output.searches.push({ base, siteId: siteId || 'none', total: response.data?.paging?.total, ids: (response.data?.results || []).slice(0, 10) });
      } catch (error) { output.searches.push({ base, siteId: siteId || 'none', error: error.response?.status || error.message, body: error.response?.data?.message || error.response?.data?.error || '' }); }
    }
  }
  try {
    const response = await axios.get('https://api.mercadolibre.com/advertising/advertisers', { params: { product_id: 'PADS', type: 'SELLER' }, headers: { ...authHeader, 'api-version': '1' }, timeout: 20000 });
    output.advertisers = (response.data?.advertisers || []).map(value => Object.fromEntries(Object.entries(value).filter(([key]) => !/name/i.test(key))));
  } catch (error) { output.advertisers = [{ error: error.response?.status || error.message }]; }
  const ids = output.searches.find(item => item.base === 'users' && item.siteId === 'none')?.ids || [];
  const promotionHeaders = { ...authHeader, version: 'v2', ...(process.env.ML_CLIENT_ID ? { 'X-Client-Id': process.env.ML_CLIENT_ID, 'X-Caller-Id': process.env.ML_CLIENT_ID } : {}) };
  for (const itemId of ids.slice(0, 5)) {
    for (const params of [{ user_id: auth.ml_user_id }, {}, { user_id: auth.ml_user_id, site_id: 'MLM' }]) {
      try {
        const response = await axios.get(`https://api.mercadolibre.com/marketplace/seller-promotions/items/${itemId}`, { params, headers: promotionHeaders, timeout: 15000 });
        output.promotionProbes.push({ itemId, params, status: 200, count: Array.isArray(response.data) ? response.data.length : -1, data: response.data });
      } catch (error) { output.promotionProbes.push({ itemId, params, error: error.response?.status || error.message, body: error.response?.data?.message || error.response?.data?.error || '' }); }
    }
  }
  for (const itemId of ids.slice(0, 3)) {
    const sample = { itemId };
    try {
      const response = await axios.get(`https://api.mercadolibre.com/marketplace/items/${itemId}`, { headers: authHeader, timeout: 20000 });
      const detail = response.data || {};
      sample.top = Object.fromEntries(Object.entries(detail).filter(([key]) => /id|site|seller|market|child|listing/i.test(key)));
      const mappings = [];
      const walk = (value, path = '') => {
        if (!value || typeof value !== 'object' || mappings.length >= 30) return;
        const entry = Object.fromEntries(Object.entries(value).filter(([key]) => /^(id|item_id|site_id|seller_id|user_id|marketplace_id|logistic_type)$/.test(key)));
        if (Object.keys(entry).length >= 2) mappings.push({ path, ...entry });
        for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') walk(child, `${path}.${key}`);
      };
      walk(detail, 'root');
      sample.mappings = mappings;
    } catch (error) { sample.detailError = error.response?.status || error.message; }
    try {
      const response = await axios.get(`https://api.mercadolibre.com/marketplace/items/${itemId}/children`, { headers: authHeader, timeout: 15000 });
      sample.children = response.data;
    } catch (error) { sample.childrenError = error.response?.status || error.message; }
    output.samples.push(sample);
  }
  console.log(JSON.stringify(output, null, 2));
  await pool.end();
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
