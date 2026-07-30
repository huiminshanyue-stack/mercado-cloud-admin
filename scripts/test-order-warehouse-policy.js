const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { canAccessOrderManagement, canManageWarehouses } = require('../order-warehouse-policy');

for (const role of ['admin', 'agent', 'user']) {
  assert.strictEqual(canAccessOrderManagement({ role }), true, `${role} should access order management`);
}
assert.strictEqual(canAccessOrderManagement({ role: 'guest' }), false);
assert.strictEqual(canAccessOrderManagement({ role: 'guest', username: 'CNTORO' }), true);

assert.strictEqual(canManageWarehouses({ role: 'admin' }), true);
assert.strictEqual(canManageWarehouses({ role: 'agent' }), false);
assert.strictEqual(canManageWarehouses({ role: 'user' }), false);

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const route of [
  "app.post('/api/admin/erp-connectors', requireAdmin",
  "app.post('/api/admin/erp-connectors/:id/sync-services', requireAdmin",
  "app.delete('/api/admin/erp-connectors/:id', requireAdmin",
  "app.post('/api/admin/fulfillment-services', requireAdmin",
  "app.delete('/api/admin/fulfillment-services/:id', requireAdmin",
  "app.post('/api/admin/logistics-companies', requireAdmin",
  "app.delete('/api/admin/logistics-companies/:id', requireAdmin"
]) assert.ok(serverSource.includes(route), `${route} must stay admin-only`);
assert.ok(serverSource.includes("JOIN users u ON u.username=c.owner_username AND u.role='admin'"), 'warehouse reads must use the shared admin catalog');
assert.ok(serverSource.includes("WHERE c.id=$1 AND c.enabled=TRUE"), 'order submission must accept an enabled shared admin warehouse');
assert.ok(serverSource.includes('UPDATE erp_connectors c SET owner_username='), 'legacy user-owned warehouses must be adopted by an administrator');
assert.ok(serverSource.includes("String(req.query.fulfillmentView || '') === 'submitted'"), 'submitted orders must support full order-list retrieval');
const warehouseChangeRouteStart = serverSource.indexOf("app.post('/api/admin/fulfillment/submissions/:id/change-warehouse', requireOrderAccess");
const warehouseChangeRouteEnd = serverSource.indexOf("app.get('/api/admin/erp-connectors'", warehouseChangeRouteStart);
const warehouseChangeRoute = serverSource.slice(warehouseChangeRouteStart, warehouseChangeRouteEnd);
assert.ok(warehouseChangeRouteStart >= 0 && warehouseChangeRouteEnd > warehouseChangeRouteStart, 'the warehouse-change compatibility route must exist');
assert.ok(!warehouseChangeRoute.includes('sendOrderToConnector'), 'an unsupported warehouse change must not push a replacement order');
assert.ok(!warehouseChangeRoute.includes('updateOrderStatus'), 'an unsupported warehouse change must not cancel the original order');
assert.ok(!warehouseChangeRoute.includes('UPDATE fulfillment_submissions'), 'an unsupported warehouse change must not falsify the local warehouse');
assert.ok(serverSource.includes("app.post('/api/admin/fulfillment/submissions/sync-status', requireOrderAccess"), 'order owners must be able to synchronize warehouse returns');
assert.ok(serverSource.includes("fs.status<>'returned'"), 'returned fulfillment orders must leave the submitted group');
assert.ok(serverSource.includes("status='returned',remote_returned=TRUE"), 'Yeeke returns must restore orders to the workbench');
assert.ok(serverSource.includes("app.put('/api/admin/erp-connectors/:id/price', requireAdmin"), 'warehouse unit prices must stay admin-only');
assert.ok(serverSource.includes('billingKey = `fulfillment:${req.authUser.username}:${displayOrderId}`'), 'production billing integration must have an idempotent per-user order key');
assert.ok(serverSource.includes("billing_status='charged'"), 'reserved billing events must preserve an externally completed charge');
assert.ok(!serverSource.includes('replacementProviderOrderNumber'), 'warehouse changes must never generate replacement order numbers');
assert.ok(serverSource.includes('Yeeke 当前公开 API 未提供原订单修改仓库接口'), 'unsupported Yeeke warehouse changes must fail safely without repushing');
assert.ok(!serverSource.includes('wallet_transactions'), 'the test deployment must not create a local wallet ledger');
assert.ok(!serverSource.includes("/recharge'"), 'the test deployment must not expose a recharge endpoint');
assert.ok(serverSource.includes("billingIntegration: 'reserved-for-www.shanyue.site'") || serverSource.includes("fulfillmentBillingIntegration: 'reserved-for-www.shanyue.site'"), 'billing must remain an explicit shanyue.site integration reservation');

console.log('order warehouse permission policy tests passed');
