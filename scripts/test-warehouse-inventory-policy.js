const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const frontend = fs.readFileSync(path.join(__dirname,'..','..','frontend','src','components','WarehouseInventoryManagement.vue'),'utf8');

assert.ok(server.includes('CREATE TABLE IF NOT EXISTS warehouse_inbounds'), 'warehouse inbound ledger must exist');
assert.ok(server.includes('CREATE TABLE IF NOT EXISTS warehouse_inbound_items'), 'warehouse inbound items must exist');
assert.ok(server.includes("app.post('/api/admin/warehouse-inbounds', requireOrderAccess"), 'inbound creation must require order access');
assert.ok(server.includes("app.post('/api/admin/warehouse-inbounds/:id/sync', requireOrderAccess"), 'inbound sync must require order access');
assert.ok(server.includes('w.owner_username=$1 AND w.id=$2'), 'inbound detail must be isolated by owner');
assert.ok(server.includes("['yeeke','shopeex']"), 'only supported official warehouse providers may be used');
assert.ok(server.includes('client.createOrUpdateInbound(payload)'), 'Yeeke official inbound endpoint must be called');
assert.ok(server.includes('client.addOrUpdateStock(payload)'), 'Shopeex official stock creation endpoint must be called');
assert.ok(frontend.includes('山月入库批次'), 'frontend must display the local inbound number');
assert.ok(frontend.includes('仓库入库/库存编号'), 'frontend must display remote inbound or stock number');
assert.ok(frontend.includes('申报 {{ s.row.requestedQuantity }} / 实收 {{ s.row.receivedQuantity }}'), 'frontend must display requested and received quantities');

console.log('Warehouse inventory policy tests passed');
