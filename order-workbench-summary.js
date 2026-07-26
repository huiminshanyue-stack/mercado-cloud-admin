'use strict';

const PERIODS = new Set(['today','week','month','all']);

function normalizeSummaryPeriod(value) {
  const period=String(value || '').trim().toLowerCase();
  return PERIODS.has(period) ? period : 'today';
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function buildOrderWorkbenchSummary(orders,exchangeRate,period='today') {
  const safeOrders=Array.isArray(orders) ? orders : [];
  const rate=Number(exchangeRate);
  const safeRate=Number.isFinite(rate) && rate>0 ? rate : 0;
  let payoutUsd=0,salesCny=0,costCny=0,profitCny=0,knownPayoutCount=0,pendingPayoutCount=0;

  for (const order of safeOrders) {
    if (order?.netAmountUsd===null || order?.netAmountUsd===undefined || !Number.isFinite(Number(order.netAmountUsd))) {
      pendingPayoutCount++;
      continue;
    }
    const payout=Number(order.netAmountUsd);
    const cost=Number(order.productCost || 0);
    const orderSales=payout*safeRate;
    knownPayoutCount++;
    payoutUsd+=payout;
    salesCny+=orderSales;
    costCny+=cost;
    profitCny+=orderSales-cost;
  }

  const profitRate=salesCny>0 ? Number((profitCny/salesCny*100).toFixed(1)) : null;
  return {
    period:normalizeSummaryPeriod(period),
    orderCount:safeOrders.length,
    knownPayoutCount,
    pendingPayoutCount,
    payoutUsd:roundMoney(payoutUsd),
    salesCny:roundMoney(salesCny),
    costCny:roundMoney(costCny),
    profitCny:roundMoney(profitCny),
    profitRate,
    exchangeRate:Number(safeRate.toFixed(6)),
    salesBasis:'official_payout_usd_times_usd_cny',
    profitBasis:'official_payout_cny_minus_product_cost_cny'
  };
}

module.exports={ normalizeSummaryPeriod,buildOrderWorkbenchSummary };
