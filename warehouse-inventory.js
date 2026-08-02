function positiveInteger(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function normalizeStockAllocations(value) {
  return (Array.isArray(value) ? value : []).map(item => compactObject({
    sku: String(item?.sku || '').trim(),
    stockSku: String(item?.stockSku || '').trim() || undefined,
    skuMismatchConfirmed: item?.skuMismatchConfirmed === true ? true : undefined,
    remoteProductId: String(item?.remoteProductId || item?.stockId || item?.sysCode || '').trim(),
    remoteFulfillmentId: String(item?.remoteFulfillmentId || '').trim() || undefined,
    quantity: positiveInteger(item?.quantity)
  })).filter(item => item.sku && item.remoteProductId && item.quantity > 0);
}

function createStockAllocationPool(value) {
  const pool = new Map();
  for (const item of normalizeStockAllocations(value)) {
    const key = item.sku.toUpperCase();
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push({ ...item,remaining:item.quantity });
  }
  return pool;
}

function takeStockAllocations(pool, sku, maximumQuantity) {
  const entries = pool.get(String(sku || '').trim().toUpperCase()) || [];
  let remaining = positiveInteger(maximumQuantity);
  const allocations = [];
  for (const entry of entries) {
    if (remaining <= 0) break;
    const quantity = Math.min(remaining,entry.remaining);
    if (quantity > 0) allocations.push(compactObject({
      remoteProductId:entry.remoteProductId,
      remoteFulfillmentId:entry.remoteFulfillmentId,
      quantity
    }));
    entry.remaining -= quantity;
    remaining -= quantity;
  }
  return allocations;
}

function fulfillmentOrderSkuQuantities(orderRows) {
  const quantities = new Map();
  for (const row of (Array.isArray(orderRows) ? orderRows : [orderRows])) {
    const raw = row?.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
    const items = Array.isArray(row?.items) && row.items.length ? row.items
      : (Array.isArray(raw.order_items) ? raw.order_items : (Array.isArray(raw.items) ? raw.items : []));
    for (const entry of items) {
      const item = entry?.item && typeof entry.item === 'object' ? entry.item : entry;
      const sku = String(item?.seller_custom_field || item?.variation_sku || item?.seller_sku || item?.sku || entry?.seller_sku || entry?.sku || '').trim();
      if (!sku) throw new Error('订单商品缺少 SKU，无法安全匹配仓库库存，请先补充商品 SKU');
      const quantity = positiveInteger(entry?.quantity || item?.quantity,1);
      quantities.set(sku.toUpperCase(),(quantities.get(sku.toUpperCase()) || 0) + quantity);
    }
  }
  return quantities;
}

function validateFulfillmentStockAllocations(orderRows, requested, availableRows) {
  const allocations = normalizeStockAllocations(requested);
  if (!allocations.length) throw new Error('请选择已经成功入库的商品库存');
  const ordered = fulfillmentOrderSkuQuantities(orderRows);
  const available = new Map((availableRows || []).map(item => [String(item.remoteProductId),item]));
  const allocatedBySku = new Map(),allocatedByStock = new Map();
  for (const allocation of allocations) {
    const stock = available.get(allocation.remoteProductId);
    if (!stock) throw new Error(`库存 ${allocation.remoteProductId} 不属于当前用户、尚未成功入库或已经没有可用数量`);
    const actualStockSku = String(stock.sku || '').trim();
    const skuMismatch = actualStockSku.toUpperCase() !== allocation.sku.toUpperCase();
    if (allocation.stockSku && allocation.stockSku.toUpperCase() !== actualStockSku.toUpperCase()) {
      throw new Error(`库存 ${allocation.remoteProductId} 的 SKU 已变化，请重新选择库存`);
    }
    if (skuMismatch && !allocation.skuMismatchConfirmed) throw new Error(`库存 ${actualStockSku} 与订单 SKU ${allocation.sku} 不匹配，请人工确认后再提交`);
    const skuKey = allocation.sku.toUpperCase();
    allocatedBySku.set(skuKey,(allocatedBySku.get(skuKey) || 0) + allocation.quantity);
    allocatedByStock.set(allocation.remoteProductId,(allocatedByStock.get(allocation.remoteProductId) || 0) + allocation.quantity);
  }
  for (const [sku,quantity] of ordered) {
    const allocated = allocatedBySku.get(sku) || 0;
    if (!allocated) throw new Error(`订单 SKU ${sku} 尚未选择已入库库存`);
    if (allocated > quantity) throw new Error(`订单 SKU ${sku} 库存发货数量 ${allocated} 超过订单数量 ${quantity}`);
  }
  for (const sku of allocatedBySku.keys()) if (!ordered.has(sku)) throw new Error(`选择的库存 SKU ${sku} 不在当前订单中`);
  for (const [stockId,quantity] of allocatedByStock) {
    const stock = available.get(stockId);
    if (quantity > Number(stock.availableQuantity || 0)) throw new Error(`库存 ${stock.sku} 仅剩 ${stock.availableQuantity} 件可发，不能提交 ${quantity} 件`);
  }
  return allocations.map(allocation => {
    const stock = available.get(allocation.remoteProductId) || {};
    return compactObject({
      ...allocation,
      remoteFulfillmentId:String(stock.remoteFulfillmentId || '').trim() || undefined,
      productName:stock.productName || ''
    });
  });
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
  const identity = String(input.userIdentity || '').trim();
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
    expressNote: [identity && `山月ERP ${identity}`,localInboundNo && `入库批次 ${localInboundNo}`,
      String(input.note || '').trim()].filter(Boolean).join('；').slice(0, 500) || undefined,
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

function selectYeekeInboundRecord(records, inbound = {}) {
  const list = Array.isArray(records) ? records : [];
  const remoteId = String(inbound.remoteId || '').trim();
  const remoteInboundNo = String(inbound.remoteInboundNo || '').trim();
  const trackingNumber = String(inbound.trackingNumber || '').trim();
  return list.find(record => remoteId && String(record?.id || '').trim() === remoteId)
    || list.find(record => remoteInboundNo && String(record?.storageBillCode || record?.sotrageBillCode || '').trim() === remoteInboundNo)
    || list.find(record => trackingNumber && String(record?.trackingNo || '').trim() === trackingNumber)
    || null;
}

function normalizeShopeexStock(record = {}) {
  const warehouseLocation = String(record.stockLocation || '').trim()
    || [record.stockAreaCodeTitle,record.stockGoodsCodeTitle,record.locationNo]
      .map(value => String(value ?? '').trim()).filter(Boolean).join('-');
  return {
    remoteId: String(record.stockPlusId || ''),
    remoteInboundNo: String(record.trackingNumber || record.stockPlusId || ''),
    // Shopeex documents trackingNumber as the inventory number used for order packing.
    remoteFulfillmentId: String(record.trackingNumber || '').trim(),
    warehouseLocation,
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
  normalizeStockAllocations,
  createStockAllocationPool,
  takeStockAllocations,
  fulfillmentOrderSkuQuantities,
  validateFulfillmentStockAllocations,
  extractRecords,
  buildYeekeInboundPayload,
  buildShopeexStockPayload,
  normalizeYeekeInbound,
  selectYeekeInboundRecord,
  normalizeShopeexStock
};
