const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');

const databaseUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl?.includes('localhost') ? false : { rejectUnauthorized: false } });
function decrypt(value) {
  const secret = process.env.ERP_CREDENTIAL_KEY || process.env.ML_CLIENT_SECRET || process.env.SYNC_API_KEY;
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const [version, iv, tag, encrypted] = String(value).split(':');
  if (version !== 'v1') throw new Error('Unsupported credential format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}
async function main() {
  const { rows } = await pool.query(`SELECT p.item_id,p.title,p.price,p.available_quantity,a.access_token_encrypted
    FROM ml_store_products p JOIN ml_store_authorizations a ON a.owner_username=p.owner_username AND a.ml_user_id=p.store_user_id
    WHERE p.item_id LIKE 'CBT%' AND a.enabled=TRUE ORDER BY p.last_synced_at DESC LIMIT 1`);
  if (!rows[0]) throw new Error('No authorized CBT product found');
  const row = rows[0];
  const headers = { Authorization: `Bearer ${decrypt(row.access_token_encrypted)}` };
  const result = { itemId: row.item_id, tests: {} };
  let marketplaceItems = [];
  for (const path of [`items/${row.item_id}`, `marketplace/items/${row.item_id}`]) {
    try {
      const response = await axios.get(`https://api.mercadolibre.com/${path}`, { headers, timeout: 20000 });
      const data = response.data?.body || response.data || {};
      result.tests[path] = { status: response.status, keys: Object.keys(data), id: data.id, siteId: data.site_id, userProductId: data.user_product_id,
        marketplaceItems: data.marketplace_items, siteItems: data.site_items, itemIds: data.item_ids };
      if (Array.isArray(data.marketplace_items)) marketplaceItems = data.marketplace_items;
    } catch (error) {
      result.tests[path] = { status: error.response?.status, error: error.response?.data?.message || error.message, cause: error.response?.data?.cause };
    }
  }
  result.childTests = {};
  for (const child of marketplaceItems.slice(0, 3)) {
    const childId = child.item_id;
    try {
      const currentResponse = await axios.get(`https://api.mercadolibre.com/items/${childId}`, { headers, timeout: 20000 });
      const current = currentResponse.data || {};
      const tests = {};
      for (const [name, payload] of Object.entries({
        price: { price: current.price },
        inventory: { available_quantity: current.available_quantity },
        status: { status: current.status }
      })) {
        try {
          const response = await axios.put(`https://api.mercadolibre.com/items/${childId}`, payload, { headers, timeout: 20000 });
          tests[name] = { status: response.status, accepted: true };
        } catch (error) {
          tests[name] = { status: error.response?.status, accepted: false, error: error.response?.data?.message || error.message, cause: error.response?.data?.cause };
        }
      }
      result.childTests[childId] = { siteId: child.site_id, current: { price: current.price, availableQuantity: current.available_quantity, status: current.status }, tests };
    } catch (error) {
      result.childTests[childId] = { siteId: child.site_id, readError: error.response?.data?.message || error.message, status: error.response?.status };
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
main().finally(() => pool.end());
