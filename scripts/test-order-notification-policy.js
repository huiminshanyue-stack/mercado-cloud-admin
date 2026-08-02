const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf8');
const publicIndex = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const rootAssetName = publicIndex.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
assert.ok(rootAssetName, 'production index must reference its JavaScript asset');

const rootAssetSource = fs.readFileSync(path.join(rootDir, 'public', 'assets', rootAssetName), 'utf8');
const orderScriptName = rootAssetSource.match(/(OrderManagement-[A-Za-z0-9_-]+\.js)/)?.[1];
const orderStyleName = rootAssetSource.match(/(OrderManagement-[A-Za-z0-9_-]+\.css)/)?.[1];
assert.ok(orderScriptName, 'production bundle must reference the order-management JavaScript chunk');
assert.ok(orderStyleName, 'production bundle must reference the order-management stylesheet');

const orderScript = fs.readFileSync(path.join(rootDir, 'public', 'assets', orderScriptName), 'utf8');
const orderStyle = fs.readFileSync(path.join(rootDir, 'public', 'assets', orderStyleName), 'utf8');

assert.ok(
  serverSource.includes("orderOperationNotifications: 'viewport-top-right'"),
  'health metadata must report viewport operation notifications'
);
for (const marker of ['order-operation-notification', 'top-right', '操作成功', '操作失败']) {
  assert.ok(orderScript.includes(marker), `order production bundle must contain ${marker}`);
}
assert.ok(
  orderStyle.includes('.order-operation-notification') && orderStyle.includes('z-index:4000'),
  'order operation notifications must remain visible above dialogs'
);

console.log('order viewport notification policy tests passed');
