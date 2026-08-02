'use strict';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDispatchedShipment(status) {
  return ['shipped', 'delivered'].includes(String(status || '').trim().toLowerCase());
}

function parseCancelledOfficialFinalNet(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const payments = Array.isArray(detail.payment_info) ? detail.payment_info : [];
  if (!payments.length || !payments.every(payment =>
    ['refunded', 'cancelled'].includes(String(payment?.status || '').trim().toLowerCase())
  )) return null;

  const balances = new Map();
  for (const row of Array.isArray(detail.details) ? detail.details : []) {
    const charge = row?.charge_info;
    const amount = finiteNumber(charge?.detail_amount);
    const type = String(charge?.detail_type || '').trim().toUpperCase();
    if (amount === null || !['CHARGE', 'BONUS', 'CREDIT'].includes(type)) continue;
    const currency = String(row?.currency_info?.currency_id || row?.currency_info?.id ||
      charge?.currency_id || detail?.currency_info?.currency_id || detail?.currency_info?.id || '').toUpperCase();
    const balance = balances.get(currency) || 0;
    balances.set(currency, balance + (type === 'CHARGE' ? -Math.abs(amount) : Math.abs(amount)));
  }

  // The official response has reached a terminal refund state and every billed
  // charge has been reversed. Keep the resulting numeric zero; presentation-only
  // buyer shipping data must not replace this final cancelled-order settlement.
  if (balances.size && [...balances.values()].every(balance => Math.abs(balance) <= 0.01)) return 0;
  return null;
}

// LOCKED BUSINESS INVARIANT — 2026-07-25, confirmed by the product owner.
// Do not change these numbers or the payout rule without the owner's explicit
// approval. This exact official-billing example must always resolve to USD 7.83:
// gross USD 21.52 - combined commission USD 2.69 - seller shipping USD 11.00.
const LOCKED_PAYOUT_EXAMPLE = Object.freeze({
  grossAmount: 21.52,
  combinedSalesCommission: 2.69,
  sellerShippingCharge: 11.00,
  expectedPayout: 7.83
});

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
  paymentOfficialNet,
  cancelledFinalOfficialNet
}) {
  const gross = finiteNumber(grossAmount) ?? 0;
  const refunded = finiteNumber(refundAmount) ?? 0;
  const cancelled = String(orderStatus || '').trim().toLowerCase() === 'cancelled';
  const shipment = String(shipmentStatus || '').trim().toLowerCase();
  const dispatched = ['shipped', 'delivered', 'not_delivered', 'returned'].includes(shipment);
  const ledgerDelta = finiteNumber(officialLedgerDelta);
  const cancelledFinalNet = finiteNumber(cancelledFinalOfficialNet);

  if (cancelled && cancelledFinalNet !== null) {
    return { amount: Number(cancelledFinalNet.toFixed(2)), source: 'cancelled_official_final_net' };
  }

  // Some cancelled-before-dispatch orders expose a stale detail-level net amount
  // even though the complete official ledger has already reversed the full sale.
  // In that exact state, the reconciled official result is zero.
  if (
    cancelled
    && !dispatched
    && hasOfficialLedger
    && gross > 0
    && ledgerDelta !== null
    && Math.abs(gross + ledgerDelta) <= 0.01
  ) {
    return { amount: 0, source: 'cancelled_official_zero_settlement' };
  }

  const explicitNet = finiteNumber(explicitOfficialNet);
  if (explicitNet !== null) {
    return { amount: Number(explicitNet.toFixed(2)), source: 'official_explicit_net' };
  }

  const fullyRefunded = gross > 0 && refunded >= gross - 0.01;

  // A cancelled order has no remaining sale principal. Its payout is the balance
  // of Mercado Libre's official fee/credit reversal ledger. This also applies
  // after dispatch: a retained shipping charge remains negative, while a complete
  // official reversal resolves to zero instead of being stuck at “pending”.
  if (cancelled) {
    if (hasOfficialLedger) {
      const delta = finiteNumber(officialLedgerDelta) ?? 0;
      return { amount: Number(delta.toFixed(2)), source: 'cancelled_official_ledger' };
    }
    return { amount: null, source: 'awaiting_cancelled_order_settlement' };
  }

  if (fullyRefunded) {
    if (hasOfficialLedger) {
      const delta = finiteNumber(officialLedgerDelta) ?? 0;
      return { amount: Number(delta.toFixed(2)), source: 'official_full_refund_ledger' };
    }
    return { amount: null, source: 'awaiting_full_refund_settlement' };
  }

  // For partial refunds, wait for Mercado Libre's explicit settlement net.
  // Deriving it from gross sales would fabricate payout.
  if (refunded > 0) {
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

function assertLockedPayoutInvariant() {
  const example = LOCKED_PAYOUT_EXAMPLE;
  const result = resolveOfficialOrderPayout({
    orderStatus: 'paid',
    shipmentStatus: 'shipped',
    grossAmount: example.grossAmount,
    refundAmount: 0,
    explicitOfficialNet: null,
    hasOfficialLedger: true,
    officialLedgerDelta: -(example.combinedSalesCommission + example.sellerShippingCharge),
    paymentOfficialNet: null
  });
  if (result.amount !== example.expectedPayout) {
    throw new Error(`Locked payout invariant failed: expected ${example.expectedPayout}, received ${result.amount}`);
  }
  return true;
}

// Fail fast during server startup if a future change breaks the approved rule.
assertLockedPayoutInvariant();

module.exports = {
  LOCKED_PAYOUT_EXAMPLE,
  assertLockedPayoutInvariant,
  isDispatchedShipment,
  parseCancelledOfficialFinalNet,
  resolveOfficialOrderPayout
};
