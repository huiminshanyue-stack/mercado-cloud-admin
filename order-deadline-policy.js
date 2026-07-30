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

function resolveWeekdayHandlingHours(dateCreated) {
  const createdAt = validDate(dateCreated);
  if (!createdAt) return null;
  const fallback = addChinaBusinessDays(createdAt,3);
  return (fallback.deadline.getTime() - createdAt.getTime()) / 3600000;
}

function addChinaBusinessDays(createdAt, businessDays) {
  const createdMs = createdAt.getTime();
  let deadlineMs = createdMs;
  let countedBusinessDays = 0;
  const holidayDates = [];
  while (countedBusinessDays < businessDays) {
    deadlineMs += 86400000;
    const { weekday } = chinaDateParts(deadlineMs);
    const key = chinaDateKey(deadlineMs);
    if (CHINA_HOLIDAY_DATES.has(key)) {
      holidayDates.push(key);
      continue;
    }
    if (weekday === 0 || weekday === 6) continue;
    countedBusinessDays += 1;
  }
  return { deadline:new Date(deadlineMs),holidayDates };
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

  const fallback = addChinaBusinessDays(createdAt,3);
  if (fallback.deadline) {
    const fallbackHours = (fallback.deadline.getTime() - createdAt.getTime()) / 3600000;
    return {
      deadline: fallback.deadline.toISOString(),
      isEstimated: true,
      source: fallback.holidayDates.length ? 'fallback_three_business_days_with_china_holidays' : 'fallback_three_business_days',
      handlingHours: fallbackHours,
      holidayDates: fallback.holidayDates
    };
  }

  return { deadline: null, isEstimated: false, source: '', handlingHours: null };
}

module.exports = { CHINA_HOLIDAY_DATES, resolveOfficialHandlingDeadline, resolveWeekdayHandlingHours };
