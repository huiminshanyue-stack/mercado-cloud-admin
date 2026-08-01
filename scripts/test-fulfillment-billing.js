const assert = require('assert');
const { calculateFulfillmentBillingTransition } = require('../fulfillment-billing');

const supplement = calculateFulfillmentBillingTransition({
  type:'switch',previousWarehouseFee:2.5,previousServiceFee:1,finalWarehouseFee:4,finalServiceFee:1
});
assert.deepStrictEqual(supplement,{
  type:'switch',previousTotal:3.5,finalTotal:5,adjustment:1.5,direction:'charge',status:'supplement_reserved'
});

const refund = calculateFulfillmentBillingTransition({
  type:'switch',previousWarehouseFee:5,previousServiceFee:1,finalWarehouseFee:2.5,finalServiceFee:0.5
});
assert.strictEqual(refund.adjustment,-3);
assert.strictEqual(refund.direction,'refund');
assert.strictEqual(refund.status,'refund_reserved');

const samePrice = calculateFulfillmentBillingTransition({
  type:'switch',previousWarehouseFee:2.5,previousServiceFee:1,finalWarehouseFee:2.5,finalServiceFee:1
});
assert.strictEqual(samePrice.adjustment,0);
assert.strictEqual(samePrice.direction,'none');
assert.strictEqual(samePrice.status,'no_charge');

const initial = calculateFulfillmentBillingTransition({ type:'initial',finalWarehouseFee:2.5,finalServiceFee:1 });
assert.strictEqual(initial.adjustment,3.5);
assert.strictEqual(initial.status,'charge_reserved');

const reversal = calculateFulfillmentBillingTransition({ type:'reversal',previousWarehouseFee:2.5,previousServiceFee:1 });
assert.strictEqual(reversal.adjustment,-3.5);
assert.strictEqual(reversal.status,'refund_reserved');

console.log('Fulfillment billing tests passed');
