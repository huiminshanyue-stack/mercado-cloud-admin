'use strict';

const assert = require('node:assert/strict');
const { resolveOfficialOrderPayout } = require('../order-payout');

const resolve = overrides => resolveOfficialOrderPayout({
  orderStatus: 'paid',
  shipmentStatus: 'ready_to_ship',
  grossAmount: 40.86,
  refundAmount: 0,
  explicitOfficialNet: null,
  hasOfficialLedger: true,
  officialLedgerDelta: 0,
  paymentOfficialNet: null,
  ...overrides
});

assert.deepEqual(resolve({ orderStatus: 'cancelled' }), {
  amount: 0,
  source: 'cancelled_before_dispatch_ledger'
});
assert.deepEqual(resolve({ orderStatus: 'cancelled', grossAmount: 27.24, officialLedgerDelta: 0 }), {
  amount: 0,
  source: 'cancelled_before_dispatch_ledger'
});
assert.equal(resolve({ orderStatus: 'cancelled', officialLedgerDelta: -2.5 }).amount, -2.5);
assert.equal(resolve({ orderStatus: 'cancelled', hasOfficialLedger: false }).amount, null);
assert.equal(resolve({ orderStatus: 'cancelled', shipmentStatus: 'shipped' }).amount, null);
assert.equal(resolve({ orderStatus: 'cancelled', explicitOfficialNet: 4.22 }).amount, 4.22);
assert.equal(resolve({ refundAmount: 40.86 }).amount, 0);
assert.equal(resolve({ refundAmount: 40.86, officialLedgerDelta: -1.25 }).amount, -1.25);
assert.equal(resolve({ refundAmount: 10 }).amount, null);
assert.equal(resolve({ officialLedgerDelta: -7.53 }).amount, 33.33);
assert.equal(resolve({ hasOfficialLedger: false, paymentOfficialNet: 35.7 }).amount, 35.7);

console.log('order payout regression tests passed');
