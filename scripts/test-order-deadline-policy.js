'use strict';

const assert = require('assert');
const { resolveOfficialHandlingDeadline } = require('../order-deadline-policy');

const exact = resolveOfficialHandlingDeadline({
  dateCreated: '2026-07-28T04:02:56.000Z',
  leadTime: {
    estimated_schedule_limit: { date: '2026-07-31T18:00:00.000Z' },
    estimated_delivery_time: { handling: 72 }
  }
});
assert.deepStrictEqual(exact, {
  deadline: '2026-07-31T18:00:00.000Z',
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
  deadline: '2026-07-31T04:02:56.000Z',
  isEstimated: true,
  source: 'fallback_weekday_rule',
  handlingHours: 72,
  holidayDates: []
});

const invalid = resolveOfficialHandlingDeadline({
  dateCreated: 'not-a-date',
  leadTime: { estimated_delivery_time: { handling: 72 } }
});
assert.deepStrictEqual(invalid, {
  deadline: null,
  isEstimated: false,
  source: '',
  handlingHours: null
});

const fallbackTuesday = resolveOfficialHandlingDeadline({
  dateCreated: '2026-07-28T04:02:56.000Z',
  leadTime: null
});
assert.deepStrictEqual(fallbackTuesday, {
  deadline: '2026-07-31T04:02:56.000Z',
  isEstimated: true,
  source: 'fallback_weekday_rule',
  handlingHours: 72,
  holidayDates: []
});

for (const [dateCreated, deadline, handlingHours] of [
  ['2026-07-31T04:00:00.000Z', '2026-08-05T04:00:00.000Z', 120],
  ['2026-08-01T04:00:00.000Z', '2026-08-06T04:00:00.000Z', 120],
  ['2026-08-02T04:00:00.000Z', '2026-08-06T04:00:00.000Z', 96],
  ['2026-07-30T04:00:00.000Z', '2026-08-03T04:00:00.000Z', 96]
]) {
  assert.deepStrictEqual(resolveOfficialHandlingDeadline({ dateCreated, leadTime: null }), {
    deadline,
    isEstimated: true,
    source: 'fallback_weekday_rule',
    handlingHours,
    holidayDates: []
  });
}

assert.deepStrictEqual(resolveOfficialHandlingDeadline({
  dateCreated:'2026-09-24T04:00:00.000Z',leadTime:null
}),{
  deadline:'2026-10-08T04:00:00.000Z',
  isEstimated:true,
  source:'fallback_weekday_rule_with_china_holidays',
  handlingHours:96,
  holidayDates:['2026-09-25','2026-09-26','2026-09-27','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07']
});

console.log('order deadline policy tests passed');
