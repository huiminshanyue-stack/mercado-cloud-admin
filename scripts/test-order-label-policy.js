const assert = require('assert');
const {
  orderLabelExpectedStoreIds,
  orderLabelOrderIds,
  orderLabelAuthorizationCandidates,
  officialShipmentSenderIds,
  selectOrderLabelContext
} = require('../order-label-policy');

const authorizations = [{ ml_user_id:'store-a' },{ ml_user_id:'store-b' },{ ml_user_id:'store-c' }];
const storeAOrder = [{ ml_order_id:'order-a',shipping_id:'shipment-a',store_user_id:'store-a',raw_data:{ seller:{ id:'seller-a' } } }];
const storeBOrder = [{ ml_order_id:'order-b',shipping_id:'shipment-b',store_user_id:'store-b',raw_data:{ seller:{ id:'seller-b' } } }];

assert.deepStrictEqual(orderLabelExpectedStoreIds(storeAOrder,'shipment-a'),['store-a','seller-a']);
assert.deepStrictEqual(orderLabelOrderIds(storeBOrder,'shipment-b'),['order-b']);
assert.strictEqual(orderLabelAuthorizationCandidates(storeAOrder,authorizations,'shipment-a')[0].ml_user_id,'store-a');
assert.strictEqual(orderLabelAuthorizationCandidates(storeBOrder,authorizations,'shipment-b')[0].ml_user_id,'store-b');
assert.notStrictEqual(
  orderLabelAuthorizationCandidates(storeAOrder,authorizations,'shipment-a')[0].ml_user_id,
  orderLabelAuthorizationCandidates(storeBOrder,authorizations,'shipment-b')[0].ml_user_id,
  'orders from different stores must resolve independently'
);

assert.deepStrictEqual(
  officialShipmentSenderIds({ sender_id:'store-a',origin:{ sender_id:'store-b' } }),
  ['store-a','store-b']
);
const shipmentContexts = [
  { sellerId:'store-a',actualCallerId:'store-a',token:'a',verifiedOrderOwnership:true,verifiedShipmentAccess:true,shipmentSenderIds:['store-b'] },
  { sellerId:'store-b',actualCallerId:'store-b',token:'b',verifiedOrderOwnership:true,verifiedShipmentAccess:true,shipmentSenderIds:['store-b'] }
];
assert.strictEqual(
  selectOrderLabelContext(shipmentContexts,['store-a']).actualCallerId,
  'store-b',
  'official shipment sender must take priority over the locally stored order store'
);
assert.strictEqual(
  selectOrderLabelContext([
    { sellerId:'store-a',token:'a',verifiedShipmentAccess:true,shipmentSenderIds:[] },
    { sellerId:'store-b',token:'b',verifiedShipmentAccess:true,shipmentSenderIds:[] }
  ],['store-b']).sellerId,
  'store-b',
  'when the shipment omits a sender, keep the exact order-store authorization'
);
assert.strictEqual(
  selectOrderLabelContext([
    { sellerId:'unrelated-store',token:'x',verifiedShipmentAccess:true,verifiedOrderOwnership:true,shipmentSenderIds:[] }
  ],['store-a']),
  null,
  'an unrelated readable store must never become the label caller'
);

console.log('order label store-isolation policy tests passed');
