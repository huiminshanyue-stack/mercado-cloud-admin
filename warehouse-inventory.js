function positiveInteger(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function extractRecords(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['records', 'list', 'rows', 'dataList']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  for (const key of ['pageInfo', 'page', 'result']) {
    const nested = data?.[key];
    if (nested && nested !== data) {
      const records = extractRecords(nested);
      if (records.length) return records;
    }
  }
  return [];
}

function buildYeekeInboundPayload(input = {}) {
  const warehouseCode = String(input.warehouseCode || '').trim();
  const trackingNumber = String(input.trackingNumber || '').trim();
  const localInboundNo = String(input.localInboundNo || '').trim();
  const items = (Array.isArray(input.items) ? input.items : []).map((item) => {
    const sysCode = String(item.sysCode || item.remoteProductCode || '').trim();
    const variationSku = String(item.variationSku || item.sku || '').trim();
    const quantity = positiveInteger(item.quantity);
    if (!quantity || (!sysCode && !variationSku)) throw new Error('Yeeke 入库商品缺少商品编码或有效数量');
    return compactObject({ sysCode: sysCode || undefined, variationSku: sysCode ? undefined : variationSku, num: quantity });
  });
  if (!warehouseCode) throw new Error('Yeeke 入库缺少仓库代码');
  if (!trackingNumber) throw new Error('Yeeke 入库缺少国内快递单号');
  if (!items.length) throw new Error('Yeeke 入库至少需要一个商品');
  const goodsQuantity = items.reduce((total, item) => total + item.num, 0);
  return compactObject({
    wareHouse: warehouseCode,
    storageType: '0',
    trackingNo: trackingNumber,
    estimateDate: String(input.expectedDate || '').trim() || undefined,
    expressType: ['0', '1', '2'].includes(String(input.transportType)) ? String(input.transportType) : undefined,
    expressNote: String(input.note || '').trim().slice(0, 500) || undefined,
    expressCode: String(input.carrierCode || '').trim() || undefined,
    boxItems: [{
      trackingNo: trackingNumber,
      goodsQuantity,
      skuQuantity: items.length,
      boxNum: `${localInboundNo || 'SY-IN'}-B1`.slice(0, 80),
      productItems: items
    }]
  });
}

function buildShopeexStockPayload(input = {}) {
  const item = input.item || {};
  const storeAddressId = positiveInteger(input.storeAddressId);
  const quantity = positiveInteger(item.quantity);
  const sku = String(item.sku || item.itemNo || '').trim();
  const name = String(item.name || item.productName || sku).trim();
  if (!storeAddressId) throw new Error('Shopeex/KJX 入库缺少仓库地址ID');
  if (!sku || !name || !quantity) throw new Error('Shopeex/KJX 入库商品缺少 SKU、名称或有效数量');
  const identity = String(input.userIdentity || '').trim();
  const localInboundNo = String(input.localInboundNo || '').trim();
  const trackingNumber = String(input.trackingNumber || '').trim();
  const note = [identity && `山月ERP ${identity}`, localInboundNo && `入库批次 ${localInboundNo}`,
    trackingNumber && `国内快递 ${trackingNumber}`, String(input.note || '').trim()].filter(Boolean).join('；').slice(0, 500);
  return compactObject({
    stockPlusId: positiveInteger(item.stockPlusId) || undefined,
    desp: note || undefined,
    stockName: name.slice(0, 200),
    stockType: 2,
    stockPlusDeliveryId: storeAddressId,
    skuNum: quantity,
    itemNoList: [sku.slice(0, 200)],
    skuImage: String(item.image || '').trim() || undefined,
    ordinaryWarnNum: Math.max(0, Math.floor(Number(item.warningQuantity) || 0)),
    highWarnNum: Math.max(0, Math.floor(Number(item.highWarningQuantity) || 0)),
    purchasePrice: Number.isFinite(Number(item.purchasePrice)) ? Number(item.purchasePrice) : undefined,
    weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
    logisticsCost: Number.isFinite(Number(item.logisticsCost)) ? Math.round(Number(item.logisticsCost) * 100) : undefined,
    anotherName: localInboundNo.slice(0, 120) || undefined
  });
}

function normalizeYeekeInbound(record = {}) {
  const skuItems = Array.isArray(record.skuItems) ? record.skuItems : [];
  const requestedQuantity = positiveInteger(record.countSkuNum)
    || skuItems.reduce((total, item) => total + positiveInteger(item.num), 0);
  const receivedQuantity = skuItems.reduce((total, item) => total
    + positiveInteger(item.abroadReceiveNum || item.domesticReceiveNum), 0);
  return {
    remoteId: String(record.id || ''),
    remoteInboundNo: String(record.storageBillCode || record.sotrageBillCode || ''),
    remoteStatus: String(record.status ?? ''),
    requestedQuantity,
    receivedQuantity,
    raw: record
  };
}

function normalizeShopeexStock(record = {}) {
  return {
    remoteId: String(record.stockPlusId || ''),
    remoteInboundNo: String(record.trackingNumber || record.stockPlusId || ''),
    remoteStatus: String(record.status ?? ''),
    requestedQuantity: positiveInteger(record.skuNum),
    receivedQuantity: Number(record.arrivedStore) === 1
      ? positiveInteger(record.trackingAmount || record.skuNum)
      : positiveInteger(record.trackingAmount),
    sku: String(record.itemNo || ''),
    raw: record
  };
}

module.exports = {
  positiveInteger,
  extractRecords,
  buildYeekeInboundPayload,
  buildShopeexStockPayload,
  normalizeYeekeInbound,
  normalizeShopeexStock
};
