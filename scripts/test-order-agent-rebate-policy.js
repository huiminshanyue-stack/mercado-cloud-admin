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

for (const table of ['fulfillment_agent_rebate_rules', 'fulfillment_agent_rebates']) {
  assert.ok(serverSource.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} must be initialized on the current server`);
}
assert.ok(serverSource.includes("agent.username=customer.created_by AND agent.role='agent'"), 'rebates must follow the existing agent-created user relationship');
assert.ok(serverSource.includes("rule.enabled=TRUE AND rule.amount>0"), 'only an enabled positive fixed rebate rule may create a rebate');
assert.ok(serverSource.includes("'fulfillment_order',rule.amount,'pending'"), 'successful fulfillment must use only the configured fixed per-order amount');
assert.ok(!serverSource.slice(serverSource.indexOf('async function recordFulfillmentAgentRebate'), serverSource.indexOf('async function reverseFulfillmentAgentRebate')).includes('serviceFee'), 'value-added service fees must not enter agent rebate calculation');
assert.ok(serverSource.includes('submissionSeq:nextSubmissionSeq,warehouseId'), 'each successful resubmission must create a separately keyed rebate');
assert.ok(serverSource.includes('if (activeSwitch) {') && serverSource.includes('reason:`订单换仓至 ${warehouse.name}`'), 'warehouse switches must reverse the previous rebate before creating the replacement rebate');
assert.ok(serverSource.includes('submissionSeq:0,warehouseId'), 'the initial successful submission must create the first rebate entry');
assert.ok(serverSource.includes("'fulfillment_return_reversal'"), 'warehouse returns must create a reversal ledger entry');
assert.ok(serverSource.includes('-Math.abs(Number(original.amount || 0))'), 'the reversal entry must negate the original fixed rebate');
assert.ok(serverSource.includes("SET status='reversed'"), 'the original rebate must be marked reversed after a return');
assert.ok(serverSource.includes('reverseFulfillmentAgentRebate({ submissionId:submission.id'), 'warehouse status polling must invoke rebate reversal');
assert.ok(serverSource.includes("app.get('/api/admin/fulfillment-agent-rebate-rules', requireAdmin"), 'only administrators may read rebate pricing rules');
assert.ok(serverSource.includes("app.post('/api/admin/fulfillment-agent-rebate-rules', requireAdmin"), 'only administrators may change rebate pricing rules');
assert.ok(serverSource.includes("app.get('/api/admin/fulfillment-agent-rebates', requireAuth, requireAgentOrAdmin"), 'agents and administrators must have a protected ledger query');
assert.ok(serverSource.includes("if (req.authUser.role === 'agent')") && serverSource.includes('r.agent_username=$'), 'an agent ledger query must be restricted to that agent');
assert.ok(serverSource.includes('测试账本不修改主站余额'), 'manual settlement must explicitly remain a current-server test ledger');
assert.ok(!serverSource.includes('UPDATE users SET balance'), 'the test ledger must not mutate user balances');

for (const text of ['代理返利', '代理每单返利设置', '当前服务器测试账本', '仓库退回冲正', '增值服务不参与返利']) {
  assert.ok(orderFrontendSource.includes(text), `production UI must contain ${text}`);
}
for (const route of ['/api/admin/fulfillment-agent-rebate-rules', '/api/admin/fulfillment-agent-rebates']) {
  assert.ok(orderFrontendSource.includes(route), `production UI must call ${route}`);
}

console.log('order agent rebate policy tests passed');
