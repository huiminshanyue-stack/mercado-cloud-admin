'use strict';

const LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE=Object.freeze({
  orderCurrency:'USD',grossAmount:5.31,salesCommission:0.77,sellerShippingCharge:6.49,
  buyerShippingOriginalAmount:4536,buyerShippingOriginalCurrency:'CLP',buyerShippingUsdCredit:4.99,
  expectedPayoutUsd:3.04,forbiddenPollutedPayoutUsd:4534.05
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number=Number(value);
  return Number.isFinite(number) ? number : null;
}

function billingEntryDirection(entry) {
  const type=String(entry?.detail_type || '').toUpperCase();
  const text=`${entry?.transaction_detail || ''} ${entry?.detail_description || ''}`.toLowerCase();
  return entry?._ledgerDirection === 'credit' || type === 'BONUS' || type === 'CREDIT' || /bonus|rebate|credit/.test(text)
    ? 'credit'
    : 'charge';
}

function billingEntryBucket(entry) {
  const subType=String(entry?.detail_sub_type || '').toUpperCase();
  const conceptType=String(entry?.concept_type || '').toUpperCase();
  const text=`${entry?.transaction_detail || ''} ${entry?.detail_description || ''} ${subType} ${conceptType}`.toLowerCase();
  if (subType === 'CXD' || conceptType === 'SHIPPING' || /shipping|shipment|freight|logistic|env[ií]o|mercado env[ií]os/.test(text)) return 'shippingFee';
  if (subType === 'CV' || /sale.?fee|commission|selling.?fee|cargo por venta|cargo por vender|tarifa de venta/.test(text)) return 'saleFee';
  return 'otherFee';
}

async function normalizeEntryAmount(entry,targetCurrency,getFxRate) {
  const target=String(targetCurrency || '').toUpperCase();
  const rawCurrency=String(entry?._currencyId || '').toUpperCase();
  const rawAmount=finiteNumber(entry?.detail_amount);
  if (!entry?._currencyUnknown && rawCurrency && rawCurrency===target && rawAmount!==null) return Math.abs(rawAmount);
  const normalizedUsd=finiteNumber(entry?._normalizedUsdAmount);
  if (normalizedUsd !== null) {
    const rate=await getFxRate('USD',target);
    return rate === null ? null : Math.abs(normalizedUsd)*rate;
  }
  if (entry?._currencyUnknown) return null;
  const sourceCurrency=rawCurrency || target;
  const rate=await getFxRate(sourceCurrency,target);
  return rate === null || rawAmount === null ? null : Math.abs(rawAmount)*rate;
}

/**
 * LOCKED CURRENCY BOUNDARY — all official billing entries must be converted to
 * the order currency before they can affect fees or payout. In particular,
 * receiver_shipping_cost may be CLP/COP/BRL/MXN/ARS while a CBT order is USD.
 * Never sum detail_amount values from different currencies directly.
 */
async function normalizeParsedOrderBilling(parsed,targetCurrency,getFxRate) {
  if (!parsed) return null;
  const target=String(targetCurrency || '').toUpperCase();
  if (!target) return { ...parsed,hasOfficialLedger:false,currencyMismatch:true,ledgerCurrencyNormalized:false };
  const entries=Array.isArray(parsed.entries) ? parsed.entries : [];
  let normalizedNetAmount=parsed.netAmount;
  const netCurrency=String(parsed.netCurrency || target).toUpperCase();
  if (finiteNumber(parsed.netAmount)!==null && netCurrency!==target) {
    const rate=await getFxRate(netCurrency,target);
    if (rate===null) normalizedNetAmount=null;
    else normalizedNetAmount=finiteNumber(parsed.netAmount)*rate;
  }
  if (!entries.length) return { ...parsed,netAmount:normalizedNetAmount,ledgerCurrency:target,ledgerCurrencyNormalized:true,currencyMismatch:false };

  let saleFee=0,shippingFee=0,otherFee=0,totalCharges=0,totalBonuses=0,ledgerDelta=0;
  for (const entry of entries) {
    const amount=await normalizeEntryAmount(entry,target,getFxRate);
    if (amount===null) return {
      ...parsed,netAmount:normalizedNetAmount,saleFee:null,shippingFee:null,otherFee:null,ledgerDelta:null,
      hasOfficialLedger:false,currencyMismatch:true,
      ledgerCurrency:target,ledgerCurrencyNormalized:false
    };
    const direction=billingEntryDirection(entry);
    if (direction==='credit') { totalBonuses+=amount;ledgerDelta+=amount; }
    else {
      totalCharges+=amount;ledgerDelta-=amount;
      const bucket=billingEntryBucket(entry);
      if (bucket==='saleFee') saleFee+=amount;
      else if (bucket==='shippingFee') shippingFee+=amount;
      else otherFee+=amount;
    }
  }
  return {
    ...parsed,netAmount:normalizedNetAmount,saleFee,shippingFee,otherFee,totalCharges,totalBonuses,ledgerDelta,
    hasOfficialLedger:true,currencyMismatch:false,ledgerCurrency:target,ledgerCurrencyNormalized:true
  };
}

module.exports={ LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE,finiteNumber,billingEntryDirection,billingEntryBucket,
  normalizeEntryAmount,normalizeParsedOrderBilling };
