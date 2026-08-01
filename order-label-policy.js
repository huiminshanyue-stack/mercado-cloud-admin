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

function officialShipmentSenderIds(shipment) {
  const values = [
    shipment?.sender_id,
    shipment?.sender?.id,
    shipment?.origin?.sender_id,
    shipment?.origin?.sender?.id
  ];
  return [...new Set(values.map(text).filter(Boolean))];
}

function selectOrderLabelContext(contexts, expectedStoreIds = []) {
  const available = (contexts || []).filter(context => context?.token);
  const expected = new Set((expectedStoreIds || []).map(text).filter(Boolean));
  const callerId = context => text(context.actualCallerId || context.sellerId);
  const shipmentOwner = available.find(context =>
    context.verifiedShipmentAccess
    && (context.shipmentSenderIds || []).includes(callerId(context))
  );
  if (shipmentOwner) return shipmentOwner;
  const exactShipmentReader = available.find(context =>
    context.verifiedShipmentAccess && expected.has(callerId(context))
  );
  if (exactShipmentReader) return exactShipmentReader;
  const exactOrderOwner = available.find(context =>
    context.verifiedOrderOwnership && expected.has(callerId(context))
  );
  if (exactOrderOwner) return exactOrderOwner;
  return null;
}

module.exports = {
  orderLabelRowsForShipment,
  orderLabelExpectedStoreIds,
  orderLabelOrderIds,
  orderLabelAuthorizationCandidates,
  officialShipmentSenderIds,
  selectOrderLabelContext
};
