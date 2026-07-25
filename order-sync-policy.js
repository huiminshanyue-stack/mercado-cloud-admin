'use strict';

function orderSyncPageDecision({ fullRangeSync, pageResultCount, pageSize, nextOffset, officialTotal, maxOffset }) {
  if (!fullRangeSync) return { continue: false, truncated: false, reason: 'single_page' };
  if (pageResultCount <= 0 || pageResultCount < pageSize) return { continue: false, truncated: false, reason: 'last_page' };
  if (Number.isFinite(officialTotal) && nextOffset >= officialTotal) return { continue: false, truncated: false, reason: 'official_total_reached' };
  if (nextOffset >= maxOffset) {
    return {
      continue: false,
      truncated: !Number.isFinite(officialTotal) || nextOffset < officialTotal,
      reason: 'offset_limit'
    };
  }
  return { continue: true, truncated: false, reason: 'next_page' };
}

module.exports = { orderSyncPageDecision };
