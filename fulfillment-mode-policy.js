function hasStockAllocations(stockByOrder) {
  if (!stockByOrder || typeof stockByOrder !== 'object' || Array.isArray(stockByOrder)) return false;
  return Object.values(stockByOrder).some(value => Array.isArray(value) && value.length > 0);
}

function resolveFulfillmentModeRequest(body = {}) {
  const requested = body.fulfillmentMode == null ? 'express' : String(body.fulfillmentMode).trim();
  if (!['express','stock'].includes(requested)) throw new Error('发货方式无效，请重新选择国内快递发仓或仓库库存发货');
  const stockByOrder = body.stockByOrder && typeof body.stockByOrder === 'object' && !Array.isArray(body.stockByOrder)
    ? body.stockByOrder
    : {};
  if (requested === 'stock' && body.stockModeConfirmed !== true) {
    throw new Error('库存发货必须由用户在当前提交窗口主动选择，系统不会自动继承库存发货方式');
  }
  if (requested === 'express' && hasStockAllocations(stockByOrder)) {
    throw new Error('国内快递发仓请求不能携带库存商品，请关闭窗口后重新提交');
  }
  return {
    fulfillmentMode:requested,
    stockModeConfirmed:requested === 'stock',
    stockByOrder:requested === 'stock' ? stockByOrder : {}
  };
}

module.exports = { hasStockAllocations,resolveFulfillmentModeRequest };
