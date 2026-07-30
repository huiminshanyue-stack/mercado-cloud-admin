'use strict';

const assert = require('node:assert/strict');
const { orderSyncPageDecision,resolveRequestedOrderScope } = require('../order-sync-policy');

const decide = overrides => orderSyncPageDecision({
  fullRangeSync: true,
  pageResultCount: 50,
  pageSize: 50,
  nextOffset: 50,
  officialTotal: 73,
  maxOffset: 10000,
  ...overrides
});

assert.deepEqual(decide({}), { continue: true, truncated: false, reason: 'next_page' });
assert.equal(decide({ nextOffset: 100, officialTotal: 73 }).continue, false);
assert.equal(decide({ pageResultCount: 23, nextOffset: 100 }).continue, false);
assert.equal(decide({ fullRangeSync: false }).reason, 'single_page');
assert.deepEqual(decide({ nextOffset: 10000, officialTotal: 12000 }), {
  continue: false,
  truncated: true,
  reason: 'offset_limit'
});

const localRows = [
  { ml_order_id:'child-a',pack_id:'pack-1' },
  { ml_order_id:'child-b',pack_id:'pack-1' },
  { ml_order_id:'unrelated',pack_id:'pack-2' }
];
assert.deepEqual(resolveRequestedOrderScope({
  requestedOrderId:'pack-1',
  matchedRows:localRows.filter(row=>row.pack_id==='pack-1'),
  siblingRows:localRows
}),{ packId:'pack-1',orderIds:['child-a','child-b'] });
assert.deepEqual(resolveRequestedOrderScope({
  requestedOrderId:'child-a',
  matchedRows:localRows.filter(row=>row.ml_order_id==='child-a'),
  siblingRows:localRows
}),{ packId:'pack-1',orderIds:['child-a','child-b'] });
assert.equal(resolveRequestedOrderScope({
  requestedOrderId:'child-a',matchedRows:[localRows[0]],siblingRows:localRows
}).orderIds.includes('unrelated'),false);
assert.deepEqual(resolveRequestedOrderScope({
  requestedOrderId:'missing',matchedRows:[],siblingRows:localRows
}),{ packId:'',orderIds:[] });

console.log('order sync pagination regression tests passed');
