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

async function normalizeOfficialMoneyAmount({
  amount,sourceCurrency,currencyUnknown,targetCurrency,receiverCurrency,
  localToUsdRate,grossAmount,getFxRate
}) {
  const rawAmount=finiteNumber(amount);
  const target=String(targetCurrency || '').toUpperCase();
  const source=String(sourceCurrency || '').toUpperCase();
  const receiver=String(receiverCurrency || '').toUpperCase();
  const officialRate=finiteNumber(localToUsdRate);
  if (rawAmount===null || !target) return { amount:null,currencyMismatch:true,currencyInferred:false };
  const plausibleLimit=Math.max(1000,Math.abs(finiteNumber(grossAmount) || 0)*20);
  let normalized=null,currencyMismatch=false,currencyInferred=false;
  if (!currencyUnknown) {
    const rate=!source || source===target ? 1 : await getFxRate(source,target);
    if (rate===null) currencyMismatch=true;
    else normalized=rawAmount*rate;
  } else {
    currencyMismatch=true;
  }
  if ((currencyUnknown || (normalized!==null && Math.abs(normalized)>plausibleLimit)) &&
      receiver && receiver!==target && Math.abs(rawAmount)>plausibleLimit) {
    const rate=target==='USD' && officialRate!==null ? officialRate : await getFxRate(receiver,target);
    const inferred=rate===null ? null : rawAmount*rate;
    if (inferred!==null && Math.abs(inferred)<=plausibleLimit) {
      normalized=inferred;
      currencyMismatch=false;
      currencyInferred=true;
    }
  }
  if (normalized!==null && Math.abs(normalized)>plausibleLimit) {
    normalized=null;
    currencyMismatch=true;
  }
  return { amount:normalized,currencyMismatch,currencyInferred };
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
  let explicitNetCurrencyMismatch=false,explicitNetCurrencyInferred=false;
  const netCurrency=String(parsed.netAmountCurrency || '').toUpperCase();
  const rawNetAmount=finiteNumber(parsed.netAmount);
  const receiverCurrency=String(parsed.receiverCurrency || '').toUpperCase();
  const officialLocalToUsd=finiteNumber(parsed.localToUsdRate);
  const grossAmount=Math.abs(finiteNumber(parsed.grossAmount) || 0);
  if (rawNetAmount!==null) {
    const result=await normalizeOfficialMoneyAmount({ amount:rawNetAmount,sourceCurrency:netCurrency,
      currencyUnknown:parsed.netAmountCurrencyUnknown,targetCurrency:target,receiverCurrency,
      localToUsdRate:officialLocalToUsd,grossAmount,getFxRate });
    normalizedNetAmount=result.amount;
    explicitNetCurrencyMismatch=result.currencyMismatch;
    explicitNetCurrencyInferred=result.currencyInferred;
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
  normalizeEntryAmount,normalizeOfficialMoneyAmount,normalizeParsedOrderBilling };
