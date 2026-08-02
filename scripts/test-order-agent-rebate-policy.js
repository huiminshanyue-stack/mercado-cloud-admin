const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const publicIndex = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const rootAssetName = publicIndex.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
assert.ok(rootAssetName, 'production index must reference its JavaScript asset');
const rootAssetSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', rootAssetName), 'utf8');
const orderAssetName = rootAssetSource.match(/(OrderManagement-[A-Za-z0-9_-]+\.js)/)?.[1];
assert.ok(orderAssetName, 'production bundle must reference the order-management chunk');
const orderFrontendSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', orderAssetName), 'utf8');

assert.ok(serverSource.includes('fulfillmentAgentRebateEnabled: false'), 'health metadata must explicitly report that fulfillment agent rebates are disabled');
for (const removed of [
  'CREATE TABLE IF NOT EXISTS fulfillment_agent_rebate_rules',
  'CREATE TABLE IF NOT EXISTS fulfillment_agent_rebates',
  'recordFulfillmentAgentRebate',
  'reverseFulfillmentAgentRebate',
  "app.get('/api/admin/fulfillment-agent-rebate-rules'",
  "app.post('/api/admin/fulfillment-agent-rebate-rules'",
  "app.get('/api/admin/fulfillment-agent-rebates'",
  "app.post('/api/admin/fulfillment-agent-rebates/",
  'rebateWarning'
]) {
  assert.ok(!serverSource.includes(removed), `disabled agent rebate runtime must not contain ${removed}`);
}

for (const text of ['代理返利', '代理每单返利设置', '当前服务器测试账本', '仓库退回冲正', '增值服务不参与返利']) {
  assert.ok(!orderFrontendSource.includes(text), `production UI must not contain ${text}`);
}
for (const route of ['/api/admin/fulfillment-agent-rebate-rules', '/api/admin/fulfillment-agent-rebates']) {
  assert.ok(!orderFrontendSource.includes(route), `production UI must not call ${route}`);
}

console.log('order agent rebate disabled policy tests passed');
