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
assert.ok(serverSource.includes("app.post('/api/admin/fulfillment/submissions/:id/change-warehouse', requireOrderAccess"), 'order owners must be able to change a submitted Yeeke warehouse');

console.log('order warehouse permission policy tests passed');
