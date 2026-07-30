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

function normalizeScopeRow(row = {}) {
  return {
    orderId: String(row.orderId || row.ml_order_id || '').trim(),
    packId: String(row.packId || row.pack_id || '').trim()
  };
}

function resolveRequestedOrderScope({ requestedOrderId, matchedRows = [], siblingRows = [] } = {}) {
  const requestedId = String(requestedOrderId || '').trim();
  if (!requestedId) return { packId: '', orderIds: [] };

  const matched = matchedRows.map(normalizeScopeRow).filter(row => row.orderId);
  const exactChild = matched.find(row => row.orderId === requestedId);
  const exactPackChild = matched.find(row => row.packId === requestedId);
  const packId = String(exactChild?.packId || exactChild?.orderId || exactPackChild?.packId || '').trim();
  if (!packId) return { packId: '', orderIds: [] };

  const candidates = [...matched, ...siblingRows.map(normalizeScopeRow)];
  const orderIds = [...new Set(candidates
    .filter(row => row.orderId && String(row.packId || row.orderId) === packId)
    .map(row => row.orderId))];
  return { packId, orderIds };
}

module.exports = { orderSyncPageDecision, resolveRequestedOrderScope };
