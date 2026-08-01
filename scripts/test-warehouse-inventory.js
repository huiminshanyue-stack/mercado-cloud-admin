const assert = require('assert');
const {
  buildYeekeInboundPayload,
  buildShopeexStockPayload,
  normalizeYeekeInbound,
  normalizeShopeexStock
} = require('../warehouse-inventory');

const yeeke = buildYeekeInboundPayload({
  warehouseCode: 'th', localInboundNo: 'IN-SY12345-1', trackingNumber: 'YT100',
  carrierCode: 'yt', transportType: 0, expectedDate: '2026-08-05', note: '整箱入库',
  items: [{ sysCode: 'P100', sku: 'SKU-1', quantity: 3 }, { sku: 'SKU-2', quantity: 2 }]
});
assert.strictEqual(yeeke.storageType, '0');
assert.strictEqual(yeeke.boxItems[0].goodsQuantity, 5);
assert.strictEqual(yeeke.boxItems[0].skuQuantity, 2);
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
  arrivedStore: 1, skuNum: 6, trackingAmount: 5, itemNo: 'SKU-3' });
assert.strictEqual(si.remoteInboundNo, 'KC100');
assert.strictEqual(si.requestedQuantity, 6);
assert.strictEqual(si.receivedQuantity, 5);

console.log('Warehouse inventory tests passed');
