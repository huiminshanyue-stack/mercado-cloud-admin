'use strict';

function validDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
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
  const rawHandling = leadTime?.estimated_delivery_time?.handling;
  const handlingHours = Number(rawHandling);
  if (
    createdAt &&
    rawHandling !== null &&
    rawHandling !== undefined &&
    rawHandling !== '' &&
    Number.isFinite(handlingHours) &&
    handlingHours >= 0
  ) {
    return {
      deadline: new Date(createdAt.getTime() + handlingHours * 3600000).toISOString(),
      isEstimated: true,
      source: 'estimated_delivery_time.handling',
      handlingHours
    };
  }

  return { deadline: null, isEstimated: false, source: '', handlingHours: null };
}

module.exports = { resolveOfficialHandlingDeadline };
