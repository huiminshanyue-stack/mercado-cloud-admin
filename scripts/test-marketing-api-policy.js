'use strict';

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const marketingStart = source.indexOf("app.get('/api/marketing/accounts'");
const marketingEnd = source.indexOf("app.get('/api/warehouses'", marketingStart);
const marketingSource = source.slice(marketingStart, marketingEnd > marketingStart ? marketingEnd : source.length);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(marketingStart >= 0, 'Marketing center source section was not found');
assert(!marketingSource.includes("https://api.mercadolibre.com/items'"), 'Legacy batch item endpoint /items is still used');
assert(marketingSource.includes('/marketplace/items/${encodeURIComponent(normalizedItemId)}'), 'Global Selling marketplace item endpoint is not used');
assert(marketingSource.includes('marketingItemDetailInflight'), 'Item-detail request coalescing is missing');
assert(marketingSource.includes('marketingItemDetailRetryAfter'), 'Item-detail retry cooldown is missing');
assert(marketingSource.includes('mapWithConcurrency(missingDetailIds, 3'), 'Promotion item prefetch concurrency must be limited to 3');
assert(!source.includes("app.get('/api/marketing/products'"), 'Disabled legacy marketing products route is still public');
assert(!source.includes("app.post('/api/marketing/promotion-items/match-selected'"), 'Disabled legacy promotion matching route is still public');
assert(marketingSource.includes("'api-version': '2'"), 'Product Ads requests are missing api-version 2');

const productAdsCalls = marketingSource.match(/axios\.(?:get|post|put|delete)\([^;]*?product_ads[^;]*?\);/gs) || [];
assert(productAdsCalls.length > 0, 'No Product Ads calls were detected');
for (const call of productAdsCalls) {
  assert(call.includes('getProductAdsHeaders(token)'), `A Product Ads call does not use the shared v2 headers: ${call.slice(0, 160)}`);
}

const clearanceGuardCount = (marketingSource.match(/promotionType === 'CLEARANCE'/g) || []).length;
assert(clearanceGuardCount >= 2, 'CLEARANCE write guards are incomplete');
assert(marketingSource.includes('官方接口不允许通过 API 报名、改价或退出'), 'CLEARANCE write rejection is missing a clear message');
assert(marketingSource.includes('/^ML[A-Z]$/.test(siteId)'), 'Marketing sites still use a hard-coded country allowlist');

console.log('Marketing center API policy checks passed');
