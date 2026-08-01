function text(value) {
  return String(value == null ? '' : value).trim();
}

function orderLabelRowsForShipment(rows, shipmentId = '') {
  const source = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  const requested = text(shipmentId);
  if (!requested) return source;
  const matched = source.filter(row => text(row.shipping_id || row.shippingId) === requested);
  return matched.length ? matched : source;
}

function orderLabelExpectedStoreIds(rows, shipmentId = '') {
  const values = [];
  for (const row of orderLabelRowsForShipment(rows,shipmentId)) {
    values.push(row.store_user_id,row.storeUserId,row.raw_data?.seller?.id,row.rawData?.seller?.id);
  }
  return [...new Set(values.map(text).filter(Boolean))];
}

function orderLabelOrderIds(rows, shipmentId = '') {
  const values = [];
  for (const row of orderLabelRowsForShipment(rows,shipmentId)) {
    values.push(row.ml_order_id,row.orderId,row.raw_data?.id,row.rawData?.id);
  }
  return [...new Set(values.map(text).filter(Boolean))];
}

function orderLabelAuthorizationCandidates(rows, authorizations, shipmentId = '') {
  const expected = new Set(orderLabelExpectedStoreIds(rows,shipmentId));
  return [...(authorizations || [])].sort((left,right) => {
    const leftExact = expected.has(text(left?.ml_user_id || left?.storeUserId));
    const rightExact = expected.has(text(right?.ml_user_id || right?.storeUserId));
    return Number(rightExact) - Number(leftExact);
  });
}

module.exports = {
  orderLabelRowsForShipment,
  orderLabelExpectedStoreIds,
  orderLabelOrderIds,
  orderLabelAuthorizationCandidates
};
