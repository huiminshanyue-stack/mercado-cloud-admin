'use strict';

const ONLINE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
const FULFILLMENT_FINISHED_ORDER_STATUSES = new Set(['cancelled', 'refunded']);
const FULFILLMENT_FINISHED_SHIPMENT_STATUSES = new Set(['shipped', 'delivered', 'cancelled']);

function isFulfillmentFinished({ orderStatus, shipmentStatus, refundAmount = 0 }) {
  return Number(refundAmount || 0) > 0
    || FULFILLMENT_FINISHED_ORDER_STATUSES.has(String(orderStatus || '').toLowerCase())
    || FULFILLMENT_FINISHED_SHIPMENT_STATUSES.has(String(shipmentStatus || '').toLowerCase());
}

function isWithinOrderAlertWindow({ dateCreated, handlingDeadline, now = Date.now() }) {
  const createdAt = new Date(dateCreated || 0).getTime();
  const deadlineAt = new Date(handlingDeadline || 0).getTime();
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(deadlineAt) || deadlineAt <= 0) return false;
  return now >= createdAt && now <= deadlineAt + ONLINE_GRACE_PERIOD_MS;
}

function shouldCreateNewOrderAlert({ existed, orderStatus, shipmentStatus, refundAmount, dateCreated, handlingDeadline, now = Date.now() }) {
  if (existed || isFulfillmentFinished({ orderStatus, shipmentStatus, refundAmount })) return false;
  return isWithinOrderAlertWindow({ dateCreated, handlingDeadline, now });
}

function shouldCreateCancellationAlert({ existed, previousStatus, orderStatus, shipmentStatus, dateCreated, handlingDeadline, now = Date.now() }) {
  if (!existed || String(previousStatus || '').toLowerCase() === 'cancelled') return false;
  if (String(orderStatus || '').toLowerCase() !== 'cancelled') return false;
  if (['shipped','delivered'].includes(String(shipmentStatus || '').toLowerCase())) return false;
  return isWithinOrderAlertWindow({ dateCreated, handlingDeadline, now });
}

function shouldCreateShippedAlert({ existed, previousShipmentStatus, orderStatus, shipmentStatus }) {
  if (!existed) return false;
  if (['cancelled','refunded'].includes(String(orderStatus || '').toLowerCase())) return false;
  if (String(shipmentStatus || '').toLowerCase() !== 'shipped') return false;
  return !['shipped','delivered'].includes(String(previousShipmentStatus || '').toLowerCase());
}

module.exports = {
  ONLINE_GRACE_PERIOD_MS,
  isFulfillmentFinished,
  isWithinOrderAlertWindow,
  shouldCreateNewOrderAlert,
  shouldCreateCancellationAlert,
  shouldCreateShippedAlert
};
