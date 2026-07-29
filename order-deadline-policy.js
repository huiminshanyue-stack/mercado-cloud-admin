'use strict';

function validDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function resolveOfficialHandlingDeadline({ leadTime } = {}) {
  const exactDeadline = validDate(leadTime?.estimated_schedule_limit?.date);
  if (exactDeadline) {
    return {
      deadline: exactDeadline.toISOString(),
      isEstimated: false,
      source: 'estimated_schedule_limit.date',
      handlingHours: null
    };
  }

  return { deadline: null, isEstimated: false, source: '', handlingHours: null };
}

module.exports = { resolveOfficialHandlingDeadline };
