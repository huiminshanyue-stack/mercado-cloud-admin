'use strict';

const assert = require('assert');
const { resolveOfficialHandlingDeadline } = require('../order-deadline-policy');

const exact = resolveOfficialHandlingDeadline({
  dateCreated: '2026-07-28T04:02:56.000Z',
  leadTime: {
    estimated_schedule_limit: { date: '2026-07-31T04:02:56.000Z' },
    estimated_delivery_time: { handling: 48 }
  }
});
assert.deepStrictEqual(exact, {
  deadline: '2026-07-31T04:02:56.000Z',
  isEstimated: false,
  source: 'estimated_schedule_limit.date',
  handlingHours: null
});

const duration = resolveOfficialHandlingDeadline({
  dateCreated: '2026-07-28T04:02:56.000Z',
  leadTime: {
    estimated_schedule_limit: { date: null },
    estimated_delivery_time: { handling: '72' }
  }
});
assert.deepStrictEqual(duration, {
  deadline: '2026-07-31T04:02:56.000Z',
  isEstimated: true,
  source: 'estimated_delivery_time.handling',
  handlingHours: 72
});

const zeroDuration = resolveOfficialHandlingDeadline({
  dateCreated: '2026-07-28T04:02:56.000Z',
  leadTime: { estimated_delivery_time: { handling: 0 } }
});
assert.deepStrictEqual(zeroDuration, {
  deadline: '2026-07-28T04:02:56.000Z',
  isEstimated: true,
  source: 'estimated_delivery_time.handling',
  handlingHours: 0
});

assert.strictEqual(resolveOfficialHandlingDeadline({
  dateCreated: 'invalid',
  leadTime: { estimated_delivery_time: { handling: 72 } }
}).deadline, null);

assert.strictEqual(resolveOfficialHandlingDeadline({
  dateCreated: '2026-07-28T04:02:56.000Z',
  leadTime: { estimated_delivery_time: { handling: null } }
}).deadline, null);

console.log('order deadline policy tests passed');
