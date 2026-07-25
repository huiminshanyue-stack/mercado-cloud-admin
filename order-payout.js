'use strict';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDispatchedShipment(status) {
  return ['shipped', 'delivered'].includes(String(status || '').trim().toLowerCase());
}

/**
 * Resolve an order payout without inventing settlement data.
 *
 * Billing expense details describe fees and reversals, but they do not prove that
 * the order principal was actually settled. In particular, a cancelled order can
 * contain a commission debit and its matching credit while its real payout is 0.
 */
function resolveOfficialOrderPayout({
  orderStatus,
  shipmentStatus,
  grossAmount,
  refundAmount,
  explicitOfficialNet,
  hasOfficialLedger,
  officialLedgerDelta,
  paymentOfficialNet
}) {
  const explicitNet = finiteNumber(explicitOfficialNet);
  if (explicitNet !== null) {
    return { amount: Number(explicitNet.toFixed(2)), source: 'official_explicit_net' };
  }

  const gross = finiteNumber(grossAmount) ?? 0;
  const refunded = finiteNumber(refundAmount) ?? 0;
  const cancelled = String(orderStatus || '').trim().toLowerCase() === 'cancelled';
  const dispatched = isDispatchedShipment(shipmentStatus);
  const fullyRefunded = gross > 0 && refunded >= gross - 0.01;

  // An order cancelled before dispatch has no sale principal to settle. Fee debit
  // and credit entries are cancellation reversals, not evidence of a gross payout.
  if (cancelled && !dispatched) {
    return { amount: 0, source: 'cancelled_before_dispatch' };
  }

  if (fullyRefunded) {
    return { amount: 0, source: 'official_full_refund' };
  }

  // For dispatched cancellations and partial refunds, wait for Mercado Libre's
  // explicit settlement net. Deriving it from gross sales would fabricate payout.
  if (cancelled || refunded > 0) {
    return { amount: null, source: 'awaiting_official_reversal_settlement' };
  }

  if (hasOfficialLedger) {
    const delta = finiteNumber(officialLedgerDelta) ?? 0;
    return { amount: Number((gross + delta).toFixed(2)), source: 'official_billing_ledger' };
  }

  const paymentNet = finiteNumber(paymentOfficialNet);
  if (paymentNet !== null) {
    return { amount: Number(paymentNet.toFixed(2)), source: 'official_payment_net' };
  }

  return { amount: null, source: 'awaiting_official_settlement' };
}

module.exports = {
  isDispatchedShipment,
  resolveOfficialOrderPayout
};
