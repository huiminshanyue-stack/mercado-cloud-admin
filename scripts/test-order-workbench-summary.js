'use strict';

const assert=require('node:assert/strict');
const { normalizeSummaryPeriod,buildOrderWorkbenchSummary }=require('../order-workbench-summary');

assert.equal(normalizeSummaryPeriod('week'),'week');
assert.equal(normalizeSummaryPeriod('all'),'all');
assert.equal(normalizeSummaryPeriod('invalid'),'today');

const summary=buildOrderWorkbenchSummary([
  { displayOrderId:'pack-1',netAmountUsd:10,productCost:20 },
  { displayOrderId:'pack-2',netAmountUsd:5,productCost:7 },
  { displayOrderId:'pack-3',netAmountUsd:null,productCost:99 }
],7.2,'month');

assert.deepEqual(summary,{
  period:'month',orderCount:3,knownPayoutCount:2,pendingPayoutCount:1,
  payoutUsd:15,salesCny:108,costCny:27,profitCny:81,profitRate:75,
  exchangeRate:7.2,salesBasis:'official_payout_usd_times_usd_cny',
  profitBasis:'official_payout_cny_minus_product_cost_cny'
});

const zeroRevenue=buildOrderWorkbenchSummary([{ netAmountUsd:0,productCost:12 }],7.2,'today');
assert.equal(zeroRevenue.salesCny,0);
assert.equal(zeroRevenue.profitCny,-12);
assert.equal(zeroRevenue.profitRate,null);

console.log('order workbench summary tests passed');
