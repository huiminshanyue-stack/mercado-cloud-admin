'use strict';

const assert = require('node:assert/strict');
const { orderSyncPageDecision } = require('../order-sync-policy');

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

console.log('order sync pagination regression tests passed');
