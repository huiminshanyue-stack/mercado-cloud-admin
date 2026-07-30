'use strict';

function validDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

const CHINA_HOLIDAY_DATES = new Set([
  '2026-01-01','2026-01-02','2026-01-03',
  '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23',
  '2026-04-04','2026-04-05','2026-04-06',
  '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
  '2026-06-19','2026-06-20','2026-06-21',
  '2026-09-25','2026-09-26','2026-09-27',
  '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07'
]);

function chinaDateParts(timestamp) {
  const shifted = new Date(timestamp + 8 * 3600000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    weekday: shifted.getUTCDay()
  };
}

function chinaDateKey(timestamp) {
  const { year,month,date } = chinaDateParts(timestamp);
  return `${year}-${String(month + 1).padStart(2,'0')}-${String(date).padStart(2,'0')}`;
}

function chinaDayStart(timestamp) {
  const { year,month,date } = chinaDateParts(timestamp);
  return Date.UTC(year,month,date) - 8 * 3600000;
}

function resolveWeekdayHandlingHours(dateCreated) {
  const createdAt = validDate(dateCreated);
  if (!createdAt) return null;
  const weekday = chinaDateParts(createdAt.getTime()).weekday;
  if (weekday === 0 || weekday === 4) return 96;
  if (weekday === 5 || weekday === 6) return 120;
  return 72;
}

function addChinaHolidayExtension(createdAt, handlingHours) {
  const createdMs = createdAt.getTime();
  let deadlineMs = createdMs + handlingHours * 3600000;
  let cursor = chinaDayStart(createdMs);
  const counted = [];
  while (cursor < deadlineMs) {
    const key = chinaDateKey(cursor);
    if (CHINA_HOLIDAY_DATES.has(key) && cursor + 86400000 > createdMs) {
      deadlineMs += 86400000;
      counted.push(key);
    }
    cursor += 86400000;
  }
  return { deadline:new Date(deadlineMs),holidayDates:counted };
}

function resolveOfficialHandlingDeadline({ dateCreated, leadTime } = {}) {
  const exactDeadline = validDate(leadTime?.estimated_schedule_limit?.date);
  if (exactDeadline) {
    return {
      deadline: exactDeadline.toISOString(),
      isEstimated: false,
      source: 'estimated_schedule_limit.date',
      handlingHours: null
    };
  }

  const createdAt = validDate(dateCreated);
  if (!createdAt) {
    return { deadline: null, isEstimated: false, source: '', handlingHours: null };
  }

  const officialHandlingHours = Number(leadTime?.estimated_delivery_time?.handling);
  if (Number.isFinite(officialHandlingHours) && officialHandlingHours > 0) {
    return {
      deadline: new Date(createdAt.getTime() + officialHandlingHours * 3600000).toISOString(),
      isEstimated: true,
      source: 'estimated_delivery_time.handling',
      handlingHours: officialHandlingHours
    };
  }

  const fallbackHours = resolveWeekdayHandlingHours(dateCreated);
  if (fallbackHours) {
    const fallback = addChinaHolidayExtension(createdAt,fallbackHours);
    return {
      deadline: fallback.deadline.toISOString(),
      isEstimated: true,
      source: fallback.holidayDates.length ? 'fallback_weekday_rule_with_china_holidays' : 'fallback_weekday_rule',
      handlingHours: fallbackHours,
      holidayDates: fallback.holidayDates
    };
  }

  return { deadline: null, isEstimated: false, source: '', handlingHours: null };
}

module.exports = { CHINA_HOLIDAY_DATES, resolveOfficialHandlingDeadline, resolveWeekdayHandlingHours };
