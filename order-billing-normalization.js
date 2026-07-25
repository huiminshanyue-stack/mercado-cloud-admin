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
  let explicitNetCurrencyMismatch=false;
  let explicitNetCurrencyInferred=false;
  const netCurrency=String(parsed.netAmountCurrency || '').toUpperCase();
  const rawNetAmount=finiteNumber(parsed.netAmount);
  const receiverCurrency=String(parsed.receiverCurrency || '').toUpperCase();
  const officialLocalToUsd=finiteNumber(parsed.localToUsdRate);
  const grossAmount=Math.abs(finiteNumber(parsed.grossAmount) || 0);
  const plausibleNetLimit=Math.max(1000,grossAmount*20);
  const receiverToTargetRate=async()=>target==='USD' && officialLocalToUsd!==null
    ? officialLocalToUsd
    : await getFxRate(receiverCurrency,target);
  if (rawNetAmount!==null && parsed.netAmountCurrencyUnknown) {
    // Some cross-border billing responses omit the currency on an amount that is
    // clearly in the buyer site's local currency (for example COP 65,004 for a
    // USD 25 order). Infer only when the raw value is impossible as order
    // currency and the official/local conversion yields a plausible settlement.
    const inferredRate=receiverCurrency && receiverCurrency!==target && Math.abs(rawNetAmount)>plausibleNetLimit
      ? await receiverToTargetRate()
      : null;
    const inferredAmount=inferredRate===null ? null : rawNetAmount*inferredRate;
    if (inferredAmount!==null && Math.abs(inferredAmount)<=plausibleNetLimit) {
      normalizedNetAmount=inferredAmount;
      explicitNetCurrencyInferred=true;
    } else {
      normalizedNetAmount=null;
      explicitNetCurrencyMismatch=true;
    }
  } else if (rawNetAmount!==null && netCurrency && netCurrency!==target) {
    const rate=target==='USD' && netCurrency===receiverCurrency && officialLocalToUsd!==null
      ? officialLocalToUsd
      : await getFxRate(netCurrency,target);
    if (rate===null) { normalizedNetAmount=null;explicitNetCurrencyMismatch=true; }
    else normalizedNetAmount=rawNetAmount*rate;
  }
  // A few responses incorrectly inherit the order currency onto a local-currency
  // net field. A value thousands of times larger than the order can never be a
  // USD settlement. Use the response's own local/USD ratio when it proves the
  // converted amount is plausible; otherwise suppress the field to pending.
  if (rawNetAmount!==null && normalizedNetAmount!==null && Math.abs(normalizedNetAmount)>plausibleNetLimit) {
    const inferredRate=receiverCurrency && receiverCurrency!==target ? await receiverToTargetRate() : null;
    const inferredAmount=inferredRate===null ? null : rawNetAmount*inferredRate;
    if (inferredAmount!==null && Math.abs(inferredAmount)<=plausibleNetLimit) {
      normalizedNetAmount=inferredAmount;
      explicitNetCurrencyInferred=true;
      explicitNetCurrencyMismatch=false;
    } else {
      normalizedNetAmount=null;
      explicitNetCurrencyMismatch=true;
    }
  }
  if (!entries.length) {
    const ledgerCurrency=String(parsed.ledgerCurrency || target).toUpperCase();
    const rate=await getFxRate(ledgerCurrency,target);
    if (rate===null) return { ...parsed,netAmount:normalizedNetAmount,hasOfficialLedger:false,currencyMismatch:true,
      explicitNetCurrencyMismatch,explicitNetCurrencyInferred,ledgerCurrency:target,ledgerCurrencyNormalized:false };
    const scale=value=>finiteNumber(value)===null ? value : finiteNumber(value)*rate;
    return { ...parsed,netAmount:normalizedNetAmount,saleFee:scale(parsed.saleFee),shippingFee:scale(parsed.shippingFee),
      otherFee:scale(parsed.otherFee),totalCharges:scale(parsed.totalCharges),totalBonuses:scale(parsed.totalBonuses),
      ledgerDelta:scale(parsed.ledgerDelta),ledgerCurrency:target,ledgerCurrencyNormalized:true,
      hasOfficialLedger:explicitNetCurrencyMismatch ? false : parsed.hasOfficialLedger,
      currencyMismatch:explicitNetCurrencyMismatch,explicitNetCurrencyMismatch,explicitNetCurrencyInferred };
  }

  let saleFee=0,shippingFee=0,otherFee=0,totalCharges=0,totalBonuses=0,ledgerDelta=0;
  for (const entry of entries) {
    const amount=await normalizeEntryAmount(entry,target,getFxRate);
    if (amount===null) return {
      ...parsed,netAmount:normalizedNetAmount,saleFee:null,shippingFee:null,otherFee:null,ledgerDelta:null,
      hasOfficialLedger:false,currencyMismatch:true,
      explicitNetCurrencyMismatch,explicitNetCurrencyInferred,ledgerCurrency:target,ledgerCurrencyNormalized:false
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
    hasOfficialLedger:true,currencyMismatch:false,explicitNetCurrencyMismatch,explicitNetCurrencyInferred,
    ledgerCurrency:target,ledgerCurrencyNormalized:true
  };
}

module.exports={ LOCKED_MIXED_CURRENCY_PAYOUT_EXAMPLE,finiteNumber,billingEntryDirection,billingEntryBucket,
  normalizeEntryAmount,normalizeParsedOrderBilling };
