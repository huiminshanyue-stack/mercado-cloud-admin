const assert = require('assert');
const {
  buildYeekeInboundPayload,
  buildShopeexStockPayload,
  normalizeStockAllocations,
  createStockAllocationPool,
  takeStockAllocations,
  validateFulfillmentStockAllocations,
  normalizeYeekeInbound,
  normalizeShopeexStock
} = require('../warehouse-inventory');

assert.deepStrictEqual(normalizeStockAllocations([{ sku:' SKU-1 ',stockId:'S1',quantity:'2' },{ sku:'',stockId:'S2',quantity:1 }]),
  [{ sku:'SKU-1',remoteProductId:'S1',quantity:2 }]);
const allocationPool = createStockAllocationPool([{ sku:'SKU-1',remoteProductId:'S1',quantity:2 },{ sku:'SKU-1',remoteProductId:'S2',quantity:1 }]);
assert.deepStrictEqual(takeStockAllocations(allocationPool,'sku-1',3),[
  { remoteProductId:'S1',quantity:2 },{ remoteProductId:'S2',quantity:1 }
]);
const validAllocation = validateFulfillmentStockAllocations(
  [{ items:[{ item:{ seller_custom_field:'SKU-1' },quantity:3 }] }],
  [{ sku:'SKU-1',remoteProductId:'REMOTE-1',quantity:2 }],
  [{ sku:'SKU-1',remoteProductId:'REMOTE-1',productName:'商品一',availableQuantity:2 }]
);
assert.strictEqual(validAllocation[0].productName,'商品一');
assert.throws(() => validateFulfillmentStockAllocations(
  [{ items:[{ item:{ seller_custom_field:'SKU-1' },quantity:3 }] }],
  [{ sku:'SKU-1',remoteProductId:'REMOTE-1',quantity:3 }],
  [{ sku:'SKU-1',remoteProductId:'REMOTE-1',availableQuantity:2 }]
),/仅剩 2 件可发/);
assert.throws(() => validateFulfillmentStockAllocations(
  [{ items:[{ item:{ seller_custom_field:'SKU-1' },quantity:1 }] }],
  [{ sku:'SKU-2',remoteProductId:'REMOTE-2',quantity:1 }],
  [{ sku:'SKU-2',remoteProductId:'REMOTE-2',availableQuantity:1 }]
),/SKU SKU-1 尚未选择/);
assert.throws(() => validateFulfillmentStockAllocations(
  [{ items:[{ item:{ seller_custom_field:'SAME-SKU' },quantity:1 }] }],
  [{ sku:'SAME-SKU',remoteProductId:'OTHER-USER-STOCK',quantity:1 }],
  [{ sku:'SAME-SKU',remoteProductId:'CURRENT-USER-STOCK',availableQuantity:5 }]
),/不属于当前用户/);
assert.throws(() => validateFulfillmentStockAllocations(
  [{ items:[{ item:{ seller_custom_field:'ORDER-SKU' },quantity:1 }] }],
  [{ sku:'ORDER-SKU',stockSku:'WAREHOUSE-SKU',remoteProductId:'CURRENT-STOCK',quantity:1 }],
  [{ sku:'WAREHOUSE-SKU',remoteProductId:'CURRENT-STOCK',availableQuantity:1 }]
),/请人工确认后再提交/);
const manualSkuMapping = validateFulfillmentStockAllocations(
  [{ items:[{ item:{ seller_custom_field:'ORDER-SKU' },quantity:1 }] }],
  [{ sku:'ORDER-SKU',stockSku:'WAREHOUSE-SKU',skuMismatchConfirmed:true,remoteProductId:'CURRENT-STOCK',quantity:1 }],
  [{ sku:'WAREHOUSE-SKU',remoteProductId:'CURRENT-STOCK',availableQuantity:1 }]
);
assert.strictEqual(manualSkuMapping[0].skuMismatchConfirmed,true);

const yeeke = buildYeekeInboundPayload({
  warehouseCode: 'th', localInboundNo: 'IN-SY12345-1', trackingNumber: 'YT100',
  userIdentity: 'SY12345', carrierCode: 'yt', transportType: 0, expectedDate: '2026-08-05', note: '整箱入库',
  items: [{ sysCode: 'P100', sku: 'SKU-1', quantity: 3 }, { sku: 'SKU-2', quantity: 2 }]
});
assert.strictEqual(yeeke.storageType, '0');
assert.strictEqual(yeeke.boxItems[0].goodsQuantity, 5);
assert.strictEqual(yeeke.boxItems[0].skuQuantity, 2);
assert.ok(yeeke.expressNote.includes('山月ERP SY12345'));
assert.ok(yeeke.expressNote.includes('IN-SY12345-1'));
assert.deepStrictEqual(yeeke.boxItems[0].productItems[0], { sysCode: 'P100', num: 3 });
assert.deepStrictEqual(yeeke.boxItems[0].productItems[1], { variationSku: 'SKU-2', num: 2 });

const shopeex = buildShopeexStockPayload({
  storeAddressId: 180, localInboundNo: 'IN-SY12345-2', userIdentity: 'SY12345',
  trackingNumber: 'SF100', note: '易碎', item: { sku: 'SKU-3', name: '测试商品', quantity: 6, logisticsCost: 1.25 }
});
assert.strictEqual(shopeex.stockType, 2);
assert.strictEqual(shopeex.stockPlusDeliveryId, 180);
assert.strictEqual(shopeex.skuNum, 6);
assert.deepStrictEqual(shopeex.itemNoList, ['SKU-3']);
assert.strictEqual(shopeex.logisticsCost, 125);
assert.ok(shopeex.desp.includes('SY12345'));
assert.ok(shopeex.desp.includes('SF100'));

const yi = normalizeYeekeInbound({ id: 5, storageBillCode: 'RK100', status: 4, countSkuNum: 5,
  skuItems: [{ num: 3, abroadReceiveNum: 3 }, { num: 2, abroadReceiveNum: 1 }] });
assert.strictEqual(yi.remoteInboundNo, 'RK100');
assert.strictEqual(yi.requestedQuantity, 5);
assert.strictEqual(yi.receivedQuantity, 4);

const si = normalizeShopeexStock({ stockPlusId: 8, trackingNumber: 'KC100', status: 2,
  arrivedStore: 1, skuNum: 6, trackingAmount: 5, itemNo: 'SKU-3',
  stockAreaCodeTitle:'X',stockGoodsCodeTitle:'01',locationNo:5 });
assert.strictEqual(si.remoteInboundNo, 'KC100');
assert.strictEqual(si.warehouseLocation, 'X-01-5');
assert.strictEqual(si.requestedQuantity, 6);
assert.strictEqual(si.receivedQuantity, 5);

console.log('Warehouse inventory tests passed');
