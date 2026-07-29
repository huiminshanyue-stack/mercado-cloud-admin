'use strict';

function validDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function resolveWeekdayHandlingHours(dateCreated) {
  const match = String(dateCreated || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  if (weekday === 0) return 96;
  if (weekday === 5 || weekday === 6) return 120;
  return 72;
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
    return {
      deadline: new Date(createdAt.getTime() + fallbackHours * 3600000).toISOString(),
      isEstimated: true,
      source: 'fallback_weekday_rule',
      handlingHours: fallbackHours
    };
  }

  return { deadline: null, isEstimated: false, source: '', handlingHours: null };
}

module.exports = { resolveOfficialHandlingDeadline };
