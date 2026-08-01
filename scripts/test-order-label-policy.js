const assert = require('assert');
const {
  orderLabelExpectedStoreIds,
  orderLabelOrderIds,
  orderLabelAuthorizationCandidates
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

console.log('order label store-isolation policy tests passed');
