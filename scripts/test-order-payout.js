'use strict';

const assert = require('node:assert/strict');
const {
  LOCKED_PAYOUT_EXAMPLE,
  assertLockedPayoutInvariant,
  resolveOfficialOrderPayout
} = require('../order-payout');
const { LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE,normalizeParsedOrderBilling } = require('../order-billing-normalization');

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

(async()=>{

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
assert.equal(assertLockedPayoutInvariant(), true);
assert.deepEqual(LOCKED_PAYOUT_EXAMPLE, {
  grossAmount: 21.52,
  combinedSalesCommission: 2.69,
  sellerShippingCharge: 11,
  expectedPayout: 7.83
});

// LOCKED MIXED-CURRENCY REGRESSION — official Chile example confirmed by
// the product owner. CLP 4,536 buyer shipping credit is officially USD 4.99;
// its raw CLP number must never enter a USD payout calculation.
const chileBilling=await normalizeParsedOrderBilling({
  netAmount:null,netCurrency:'',hasOfficialLedger:true,entries:[
    { detail_amount:LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.buyerShippingOriginalAmount,detail_type:'CREDIT',
      detail_sub_type:'RECEIVER_SHIPPING_COST',concept_type:'SHIPPING',
      _currencyId:LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.buyerShippingOriginalCurrency,
      _normalizedUsdAmount:LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.buyerShippingUsdCredit,_ledgerDirection:'credit' },
    { detail_amount:LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.salesCommission,detail_type:'CHARGE',detail_sub_type:'CV',_currencyId:'USD' },
    { detail_amount:LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.sellerShippingCharge,detail_type:'CHARGE',
      detail_sub_type:'CXD',concept_type:'SHIPPING',_currencyId:'USD' }
  ]
},'USD',async (from,to)=>from===to ? 1 : null);
assert.equal(chileBilling.currencyMismatch,false);
assert.equal(Number(chileBilling.ledgerDelta.toFixed(2)),-2.27);
assert.equal(Number(chileBilling.saleFee.toFixed(2)),0.77);
assert.equal(Number(chileBilling.shippingFee.toFixed(2)),6.49);
const chilePayout=resolve({ grossAmount:LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.grossAmount,officialLedgerDelta:chileBilling.ledgerDelta });
assert.equal(chilePayout.amount,LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.expectedPayoutUsd);
assert.equal(Number((LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.grossAmount-
  LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.salesCommission-LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.sellerShippingCharge+
  LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.buyerShippingOriginalAmount).toFixed(2)),
LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE.forbiddenPollutedPayoutUsd);

console.log('order payout regression tests passed');
})().catch(error=>{ console.error(error);process.exitCode=1; });
