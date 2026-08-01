const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.resolve(root, '..', 'frontend', 'src', 'components', 'OrderManagement.vue'), 'utf8');
const assetDir = path.join(root, 'public', 'assets');
const orderAssets = fs.readdirSync(assetDir).filter((name) => /^OrderManagement-.*\.js$/.test(name));
const builtSources = orderAssets.map((name) => fs.readFileSync(path.join(assetDir, name), 'utf8'));

assert.ok(frontendSource.includes('>批量打印面单</el-button'), 'the toolbar must expose batch label printing');
assert.ok(!frontendSource.includes('>同步仓库退回状态</el-button'), 'the warehouse return status button must be replaced');
assert.ok(frontendSource.includes('title="批量打印面单"'), 'batch printing must open a dedicated order window');
assert.ok(frontendSource.includes('fulfillmentStatus: "ready_to_ship"'), 'the window must load ready-to-ship orders');
assert.ok(frontendSource.includes('size: 100'), 'all pending orders must be loaded through bounded pagination');
assert.ok(frontendSource.includes('batchLabelSelectedIds.value = batchLabelOrders.value'), 'printable pending orders must be selected by default');
assert.ok(frontendSource.includes('order.shippingId && selected.has'), 'orders without a shipment label must not enter the print batch');
assert.ok(frontendSource.includes('await import("pdf-lib")'), 'official label PDFs must be merged client-side');
assert.ok(frontendSource.includes('merged.copyPages'), 'each official PDF page must enter the merged print document');
assert.ok(frontendSource.includes('Math.min(3, targets.length)'), 'official label requests must use bounded concurrency');
assert.ok(frontendSource.includes('printPdfBlob('), 'the merged PDF must use the existing browser print flow');

assert.ok(serverSource.includes("app.get('/api/admin/orders', requireOrderAccess"), 'pending order discovery must preserve user isolation');
assert.ok(serverSource.includes("app.get('/api/admin/orders/:orderId/label', requireOrderAccess"), 'every official label request must preserve user isolation');
assert.ok(serverSource.includes('batchLabelPrint: true'), 'health metadata must expose batch label printing');
assert.ok(serverSource.includes("batchLabelPrintScope: 'current-user-ready-to-ship-orders'"), 'health metadata must describe batch scope');
assert.ok(serverSource.includes("batchLabelPrintOutput: 'single-merged-pdf'"), 'health metadata must describe the merged PDF output');
assert.ok(serverSource.includes("orderLabelAuthorizationScope: 'per-order-store'") && serverSource.includes('orderLabelCrossStorePrintAttempts: false'), 'multi-store label printing must isolate authorization per order');
assert.ok((serverSource.match(/resolveOfficialLabelStoreContext\(/g) || []).length >= 3, 'label download and warehouse push must share the order-scoped authorization resolver');
assert.ok(serverSource.includes('verifiedOrderOwnership') && serverSource.includes('https://api.mercadolibre.com/orders/'), 'store ownership must be verified through the official order API');
assert.ok(serverSource.includes('audit.attemptedStoreUserIds = [context.sellerId]'), 'only the resolved order store may attempt official label printing');
assert.ok(!serverSource.includes('labelAttemptCount'), 'the legacy all-store print loop must be removed');

const currentBuiltSource = builtSources.find((source) => source.includes('批量打印面单')) || '';
assert.ok(currentBuiltSource, 'deployed order bundle must contain batch label printing');
assert.ok(!currentBuiltSource.includes('同步仓库退回状态'), 'the current order bundle must not show the replaced button');
assert.ok(currentBuiltSource.includes('ready_to_ship'), 'the current order bundle must contain the pending order filter');

console.log('order batch label policy regression tests passed');
