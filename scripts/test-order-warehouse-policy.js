const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { canAccessOrderManagement, canManageWarehouses, formatWarehouseAddressForUser } = require('../order-warehouse-policy');
const { fulfillmentSubmissionEligibility } = require('../order-fulfillment-policy');

for (const role of ['admin', 'agent', 'user']) {
  assert.strictEqual(canAccessOrderManagement({ role }), true, `${role} should access order management`);
}
assert.strictEqual(canAccessOrderManagement({ role: 'guest' }), false);
assert.strictEqual(canAccessOrderManagement({ role: 'guest', username: 'CNTORO' }), true);

assert.strictEqual(canManageWarehouses({ role: 'admin' }), true);
assert.strictEqual(canManageWarehouses({ role: 'agent' }), false);
assert.strictEqual(canManageWarehouses({ role: 'user' }), false);

const formattedAddress = formatWarehouseAddressForUser({
  recipientName:'山月',address:'浙江省义乌市测试路 1 号',phone:'13800000000',postalCode:'322000'
},'sy43571');
assert.strictEqual(formattedAddress.recipientDisplay,'山月（SY43571）');
assert.strictEqual(formattedAddress.addressDisplay,'浙江省义乌市测试路 1 号（SY43571）');
assert.strictEqual(formattedAddress.phone,'13800000000');
assert.strictEqual(formattedAddress.postalCode,'322000');

assert.deepStrictEqual(fulfillmentSubmissionEligibility([{ status:'paid',shipment_status:'ready_to_ship',refund_amount:0 }]), { allowed:true,message:'' });
for (const [row,reason] of [
  [{ status:'paid',shipment_status:'shipped' },'运输中'],
  [{ status:'paid',shipment_status:'delivered' },'已送达'],
  [{ status:'cancelled',shipment_status:'ready_to_ship' },'已取消'],
  [{ status:'paid',shipment_status:'ready_to_ship',refund_amount:1 },'已退款'],
  [{ status:'paid',shipment_status:'handling' },'处理中']
]) {
  const result = fulfillmentSubmissionEligibility([row]);
  assert.strictEqual(result.allowed,false,`${reason} orders must be rejected`);
  assert.ok(result.message.includes(reason),`${reason} rejection must be actionable`);
}
assert.strictEqual(fulfillmentSubmissionEligibility([
  { status:'paid',shipment_status:'ready_to_ship' },
  { status:'paid',shipment_status:'shipped' }
]).allowed,false,'a mixed-status pack must be rejected');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const returnSyncSource = serverSource.slice(
  serverSource.indexOf('async function syncYeekeSubmissionStatuses'),
  serverSource.indexOf('function startYeekeSubmissionStatusSync')
);
const yeekeSource = fs.readFileSync(path.join(__dirname, '..', 'yeeke-client.js'), 'utf8');
const miniDetailSource = fs.readFileSync(path.join(__dirname, '..', 'order-miniprogram', 'miniprogram', 'pages', 'order-detail', 'index.ts'), 'utf8');
const miniDetailTemplate = fs.readFileSync(path.join(__dirname, '..', 'order-miniprogram', 'miniprogram', 'pages', 'order-detail', 'index.wxml'), 'utf8');
const publicIndex = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const rootAssetName = publicIndex.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
assert.ok(rootAssetName, 'the production index must reference its root JavaScript asset');
const rootAssetSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', rootAssetName), 'utf8');
const orderAssetName = rootAssetSource.match(/(OrderManagement-[A-Za-z0-9_-]+\.js)/)?.[1];
assert.ok(orderAssetName, 'the production bundle must reference the order-management chunk');
const orderFrontendSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', orderAssetName), 'utf8');
const orderStyleName = rootAssetSource.match(/(OrderManagement-[A-Za-z0-9_-]+\.css)/)?.[1];
assert.ok(orderStyleName, 'the production bundle must reference the order-management stylesheet');
const orderStyleSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', orderStyleName), 'utf8');
for (const route of [
  "app.get('/api/admin/erp-connectors', requireAdmin",
  "app.post('/api/admin/erp-connectors', requireAdmin",
  "app.post('/api/admin/erp-connectors/:id/sync-services', requireAdmin",
  "app.delete('/api/admin/erp-connectors/:id', requireAdmin",
  "app.get('/api/admin/fulfillment-services', requireAdmin",
  "app.post('/api/admin/fulfillment-services', requireAdmin",
  "app.delete('/api/admin/fulfillment-services/:id', requireAdmin",
  "app.get('/api/admin/logistics-companies', requireAdmin",
  "app.post('/api/admin/logistics-companies', requireAdmin",
  "app.delete('/api/admin/logistics-companies/:id', requireAdmin",
  "app.post('/api/admin/warehouse-addresses', requireAdmin",
  "app.put('/api/admin/warehouse-addresses/:id', requireAdmin",
  "app.delete('/api/admin/warehouse-addresses/:id', requireAdmin"
]) assert.ok(serverSource.includes(route), `${route} must stay admin-only`);
assert.ok(serverSource.includes("app.get('/api/admin/warehouse-addresses', requireOrderAccess"), 'all order-management users must be able to read the shared address catalog');
assert.ok(serverSource.includes("app.get('/api/admin/fulfillment-options', requireOrderAccess"), 'order users must receive safe fulfillment choices without configuration access');
assert.ok(serverSource.includes("JOIN users u ON u.username=wa.owner_username AND u.role='admin'"), 'only administrator-owned addresses may enter the shared catalog');
assert.ok(serverSource.includes("JOIN users u ON u.username=c.owner_username AND u.role='admin'"), 'warehouse reads must use the shared admin catalog');
assert.ok(serverSource.includes("WHERE c.id=$1 AND c.enabled=TRUE"), 'order submission must accept an enabled shared admin warehouse');
assert.ok(serverSource.includes('UPDATE erp_connectors c SET owner_username='), 'legacy user-owned warehouses must be adopted by an administrator');
assert.ok(!serverSource.includes("String(req.query.fulfillmentView || '') === 'submitted'"), 'submitted orders must not be split into a second workbench query');
assert.ok(serverSource.includes('if (packedRows.length) {'), 'the main order workbench must hydrate fulfillment data');
assert.ok(serverSource.includes('SELECT DISTINCT ON (f.order_id)') && serverSource.includes('order.fulfillmentSubmission = fulfillment?.isReturned ? null'), 'returned submissions must clear the active warehouse while preserving a return marker');
assert.ok(serverSource.includes('fulfillmentMergedIntoWorkbench: true'), 'health metadata must expose the unified workbench');
assert.ok(serverSource.includes('fulfillmentResubmit: true'), 'users must be allowed to submit an already successful order again');
assert.ok(serverSource.includes("fulfillmentSubmissionAllowedShipmentStatus: 'ready_to_ship'"), 'only ready-to-ship orders may enter fulfillment submission');
assert.ok((serverSource.match(/fulfillmentSubmissionEligibility\(orderResult\.rows\)/g) || []).length >= 2, 'both new submissions and retries must enforce shipment eligibility');
assert.ok(serverSource.includes('请先选择需要提交代贴单的订单') && serverSource.includes('请选择要提交的仓库') && serverSource.includes('请选择国内物流公司'), 'missing submit parameters must return field-specific feedback');
assert.ok(serverSource.includes('quantityByOrder') && serverSource.includes('remarkByOrder'), 'shipping quantity and courier remarks must be accepted per order');
assert.ok(serverSource.includes('发货数量必须是 1 至') && serverSource.includes('快递备注不能超过 500 个字'), 'shipping quantity and remark validation must be actionable');
assert.ok(yeekeSource.includes('erpOrdersn: identity') && yeekeSource.includes('erpOrderSn: identity') && yeekeSource.includes('shopID: identity') && yeekeSource.includes('sysUserNote: externalUserId ? identity') && !yeekeSource.includes('shopId: identity') && yeekeSource.includes('`山月ERP ${identity}`'), 'Yeeke identity must use third-party, system-note, and shopID fields without populating shopName');
assert.ok(yeekeSource.includes('trackingNo: officialTrackingNumber') && yeekeSource.includes('expressInfos: domesticTrackingNumber'), 'international and domestic tracking numbers must use separate Yeeke fields');
assert.ok(yeekeSource.includes('sendQuantity') && yeekeSource.includes('note: domesticRemark'), 'Yeeke courier details must include shipping quantity and remark');
assert.ok(yeekeSource.includes("call('/deliveryinfo/delete'") && yeekeSource.includes("call('/express/add'"), 'Yeeke original-order courier updates must use the documented delete and add endpoints');
assert.ok(yeekeSource.includes('newOrderCreated: false') && yeekeSource.includes('replaceYeekeDomesticExpress'), 'courier correction must explicitly preserve the original Yeeke order');
assert.ok(serverSource.includes("app.post('/api/admin/fulfillment/update-express', requireOrderAccess"), 'order users must have a protected original-order courier correction route');
assert.ok(serverSource.includes('previousTrackingNo:previousTrackingNumber') && serverSource.includes('providerOrderNumber = String(submission.provider_order_number'), 'courier correction must target the stored original provider order and tracking number');
assert.ok(serverSource.includes('官方面单未申请成功，请先点击订单上的“申请面单”查看原因'), 'official label failures must tell the user how to recover');
assert.ok(serverSource.includes('const requestedResubmits = new Set'), 'resubmission must require an explicit order id list');
assert.ok(!serverSource.includes('requestedResubmit && Number(existing.warehouse_id) === warehouseId'), 'resubmission must allow the current warehouse to be selected again');
assert.ok(serverSource.includes("updateOrderStatus({ ordersn:existing.provider_order_number || displayOrderId,status:'cancelled' })"), 'a successful resubmission must push the Mercado cancellation status to the previous Yeeke order');
assert.ok(serverSource.includes('previous_provider_order_number=provider_order_number'), 'the previous provider order number must be retained for audit');
assert.ok(serverSource.includes('resubmit_count=resubmit_count+1'), 'each successful resubmission must be counted');
assert.ok(serverSource.includes('if (!isResubmit) {'), 'a failed resubmission must not overwrite the currently successful submission');
assert.ok(!serverSource.includes('submittedFulfillmentTab'), 'the separate submitted tab metadata must be removed');
assert.ok(!serverSource.includes('submittedFulfillmentFullOrderCards'), 'legacy submitted-group metadata must be removed');
assert.ok(!serverSource.includes("/change-warehouse'"), 'the unavailable direct warehouse-change route must be removed');
assert.ok(serverSource.includes("app.post('/api/admin/fulfillment/submissions/sync-status', requireOrderAccess"), 'order owners must be able to synchronize warehouse returns');
assert.ok(serverSource.includes("status='returned',warehouse_id=NULL,remote_returned=TRUE"), 'returned fulfillment orders must clear their warehouse and active workbench attachment');
assert.ok(!returnSyncSource.includes("JOIN users administrator ON administrator.username=c.owner_username AND administrator.role='admin'"), 'return polling must include legacy enabled Yeeke warehouses');
assert.ok(returnSyncSource.includes('if (!record && entry.config.warehouseCode)') && returnSyncSource.includes('listOrders({ ordersn:providerOrderNumber,pageNo:1,pageSize:20 })'), 'returned orders missing from the original warehouse view must be retried without a warehouse filter');
assert.ok(serverSource.includes("app.put('/api/admin/erp-connectors/:id/price', requireAdmin"), 'warehouse unit prices must stay admin-only');
assert.ok(serverSource.includes('billingKey = `fulfillment:${req.authUser.username}:${displayOrderId}`'), 'production billing integration must have an idempotent per-user order key');
assert.ok(serverSource.includes("billing_status='charged'"), 'reserved billing events must preserve an externally completed charge');
assert.ok(!serverSource.includes('replacementProviderOrderNumber'), 'legacy replacement-order code must stay removed');
assert.ok(!serverSource.includes('wallet_transactions'), 'the test deployment must not create a local wallet ledger');
assert.ok(!serverSource.includes("/recharge'"), 'the test deployment must not expose a recharge endpoint');
assert.ok(serverSource.includes("billingIntegration: 'reserved-for-www.shanyue.site'") || serverSource.includes("fulfillmentBillingIntegration: 'reserved-for-www.shanyue.site'"), 'billing must remain an explicit shanyue.site integration reservation');
assert.ok(serverSource.includes("domesticLogisticsMode: 'kuaidi100-prefilled-web-query'"), 'domestic logistics must use a prefilled public web query');
assert.ok(serverSource.includes('domesticLogisticsApiQuotaRequired: false'), 'domestic logistics must not consume a metered server API quota');
assert.ok(!serverSource.includes('KDNIAO_') && !serverSource.includes('/domestic-logistics'), 'the rejected quota-limited domestic logistics API must stay removed');
assert.ok(!orderFrontendSource.includes('暂无已提交代贴单订单'), 'the standalone submitted-fulfillment empty state must be removed');
assert.ok(!orderFrontendSource.includes('移入本分组'), 'the standalone submitted-fulfillment group notice must be removed');
assert.ok(orderFrontendSource.includes('仓库：'), 'submitted warehouse data must render on the main order card');
assert.ok(orderFrontendSource.includes('国内快递单号：'), 'domestic tracking data must render on the main order card');
assert.ok(orderFrontendSource.includes('提交代贴单时间：'), 'fulfillment submission time must render on the main order card');
assert.ok(orderFrontendSource.includes('代贴单提交失败') && orderFrontendSource.includes('已提交代贴单'), 'the submit action must switch to its attached submission state');
assert.ok(orderFrontendSource.includes('代贴单提交失败，点击重新推送'), 'failed submissions must expose a clickable retry action');
assert.ok(orderFrontendSource.includes('仅待发货可提交'), 'terminal and non-ready orders must show that fulfillment is unavailable');
assert.ok(orderFrontendSource.includes('缺少国内快递单号，请填写后再推送'), 'the submit dialog must validate domestic tracking numbers before calling the API');
assert.ok(orderFrontendSource.includes('尚未生成官方面单，请先同步订单状态并点击“申请面单”'), 'orders without a shipment label must receive actionable feedback');
assert.ok(!orderFrontendSource.includes('修改仓库'), 'the unavailable warehouse-change button must be removed');
assert.ok(orderFrontendSource.includes('重新提交代贴单'), 'successful submissions must expose the explicit second-push action');
assert.ok(orderFrontendSource.includes('resubmitOrderIds'), 'the second-push action must identify resubmitted orders to the API');
assert.ok(!orderFrontendSource.includes(':disabled="fulfillmentResubmitMode && String(w.id)'), 'the current warehouse must remain selectable during resubmission');
assert.ok(orderFrontendSource.includes('fulfillmentReturn') && orderFrontendSource.includes('仓库退单'), 'returned warehouse orders must render a visible return marker');
assert.ok(orderFrontendSource.includes('发货数量') && orderFrontendSource.includes('随国内快递一起推送'), 'the web fulfillment dialog must collect shipping quantity and courier remarks');
assert.ok(orderFrontendSource.includes('quantityByOrder') && orderFrontendSource.includes('remarkByOrder'), 'the web fulfillment request must send quantity and remark maps');
assert.ok(orderFrontendSource.includes('修改原订单国内快递号') && orderFrontendSource.includes('/api/admin/fulfillment/update-express'), 'the web workbench must expose original-order courier correction');
assert.ok(orderFrontendSource.includes('www.kuaidi100.com/chaxun'), 'domestic tracking must open a prefilled Kuaidi100 web query');
assert.ok(orderFrontendSource.includes('zhongtong') && orderFrontendSource.includes('shunfeng') && orderFrontendSource.includes('jtexpress'), 'common domestic carriers must be mapped for automatic query filling');
assert.ok(orderFrontendSource.includes('仓库收货地址') && orderFrontendSource.includes('recipientDisplay') && orderFrontendSource.includes('addressDisplay'), 'the workbench must render user-specific shared warehouse addresses');
assert.ok(orderFrontendSource.includes('/api/admin/warehouse-addresses'), 'the workbench must load and manage warehouse addresses through the protected API');
assert.ok(orderFrontendSource.includes('/api/admin/fulfillment-options'), 'non-admin users must load only safe fulfillment choices');
assert.ok(orderFrontendSource.includes('仓库地址') && orderFrontendSource.includes('warehouse-addresses'), 'warehouse addresses must have a standalone tab visible to order users');
assert.ok(serverSource.includes("warehouseAddressTabRoles: ['admin','agent','user']"), 'warehouse address tab metadata must allow all order roles');
assert.ok(serverSource.includes("orderManagementMenuRoles: ['admin','agent']"), 'the temporary web order-management menu must be limited to administrators and agents');
assert.ok(/admin","agent"\]\.includes\(/.test(rootAssetSource), 'the production root bundle must hide order management from ordinary users');
assert.ok(serverSource.includes("warehouseConfigurationTabRole: 'admin'"), 'warehouse configuration tab metadata must stay administrator-only');
assert.ok(serverSource.includes("warehouseConfigurationReadRole: 'admin'") && serverSource.includes('fulfillmentOptionsExcludeCredentials: true'), 'configuration reads must stay admin-only while safe options exclude credentials');
assert.ok(orderFrontendSource.includes('二次推单会在所选仓库创建新订单') && orderFrontendSource.includes('可以继续选择当前仓库'), 'the UI must explain the second-push and same-warehouse flow');
assert.ok(/\.order-card\[[^\]]+\]\{[^}]*font-size:12px/.test(orderStyleSource), 'all order cards must use the compact 12px base font');
assert.ok(orderStyleSource.includes('flex-wrap:nowrap'), 'the order header must not wrap and clip the warehouse label');
assert.ok(orderStyleSource.includes('grid-template-columns:minmax(0,1fr) auto'), 'the fulfillment summary must use the compact two-column layout');
assert.ok(orderStyleSource.includes('flex-wrap:wrap') && orderStyleSource.includes('font-size:10px'), 'the fulfillment actions must wrap compactly instead of covering order details');
assert.ok(miniDetailSource.includes('/api/miniprogram/v1/fulfillment-options') && miniDetailSource.includes('/api/miniprogram/v1/fulfillment/submit'), 'the mini-program order detail must use the protected fulfillment APIs');
assert.ok(miniDetailSource.includes('/api/miniprogram/v1/fulfillment/update-express'), 'the mini-program must update courier details on the original Yeeke order');
assert.ok(miniDetailSource.includes('quantityByOrder') && miniDetailSource.includes('remarkByOrder'), 'the mini-program must submit quantity and courier remarks');
for (const label of ['选择仓库','快递公司','国内快递单号','发货数量','备注','提交代贴单']) {
  assert.ok(miniDetailTemplate.includes(label), `the mini-program fulfillment form must include ${label}`);
}

console.log('order warehouse permission policy tests passed');
