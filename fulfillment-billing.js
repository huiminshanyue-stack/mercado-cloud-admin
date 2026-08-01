function money(value) {
  const amount = Number(value);
  return Number((Number.isFinite(amount) ? amount : 0).toFixed(2));
}

function calculateFulfillmentBillingTransition({
  type = 'initial',
  previousWarehouseFee = 0,
  previousServiceFee = 0,
  finalWarehouseFee = 0,
  finalServiceFee = 0
} = {}) {
  const previousTotal = money(money(previousWarehouseFee) + money(previousServiceFee));
  const finalTotal = money(money(finalWarehouseFee) + money(finalServiceFee));
  let adjustment;
  if (type === 'switch') adjustment = money(finalTotal - previousTotal);
  else if (type === 'reversal') adjustment = money(-previousTotal);
  else adjustment = finalTotal;
  const direction = adjustment > 0 ? 'charge' : (adjustment < 0 ? 'refund' : 'none');
  const status = direction === 'charge'
    ? (type === 'switch' ? 'supplement_reserved' : 'charge_reserved')
    : (direction === 'refund' ? 'refund_reserved' : 'no_charge');
  return { type,previousTotal,finalTotal,adjustment,direction,status };
}

module.exports = { money,calculateFulfillmentBillingTransition };
