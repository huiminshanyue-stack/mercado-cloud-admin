'use strict';

const NEW_ORDER_ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FULFILLMENT_FINISHED_ORDER_STATUSES = new Set(['cancelled', 'refunded']);
const FULFILLMENT_FINISHED_SHIPMENT_STATUSES = new Set(['shipped', 'delivered', 'cancelled']);

function isFulfillmentFinished({ orderStatus, shipmentStatus, refundAmount = 0 }) {
  return Number(refundAmount || 0) > 0
    || FULFILLMENT_FINISHED_ORDER_STATUSES.has(String(orderStatus || '').toLowerCase())
    || FULFILLMENT_FINISHED_SHIPMENT_STATUSES.has(String(shipmentStatus || '').toLowerCase());
}

function shouldCreateNewOrderAlert({ existed, orderStatus, shipmentStatus, refundAmount, dateCreated, now = Date.now() }) {
  if (existed || isFulfillmentFinished({ orderStatus, shipmentStatus, refundAmount })) return false;
  const createdAt = new Date(dateCreated || 0).getTime();
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  const age = now - createdAt;
  return age >= 0 && age <= NEW_ORDER_ALERT_MAX_AGE_MS;
}

module.exports = {
  NEW_ORDER_ALERT_MAX_AGE_MS,
  isFulfillmentFinished,
  shouldCreateNewOrderAlert
};
