const crypto = require('crypto');
const axios = require('axios');

const YEEKE_API_PREFIX = '/agent-foreign/erp/api';
const DEFAULT_YEEKE_BASE_URL = 'https://mi.yeeke.com';

function buildYeekeEnvelope(appId, appSecret, data) {
  if (!appId || !appSecret) throw new Error('Yeeke appId/appSecret 未配置');
  const dataText = JSON.stringify(data || {});
  return {
    appId: String(appId),
    data: dataText,
    sign: crypto.createHmac('md5', String(appSecret)).update(dataText, 'utf8').digest('hex').toUpperCase()
  };
}

function createYeekeClient(config, request = axios) {
  const baseURL = String(config.baseUrl || DEFAULT_YEEKE_BASE_URL).replace(/\/+$/, '');
  const appId = String(config.appId || '').trim();
  const appSecret = String(config.appSecret || '').trim();
  let accessToken = String(config.accessToken || '').trim();

  async function call(path, data) {
    const response = await request.post(`${baseURL}${YEEKE_API_PREFIX}${path}`, buildYeekeEnvelope(appId, appSecret, data), {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
    const body = response.data || {};
    if (String(body.code) !== '0') {
      const error = new Error(body.message || `Yeeke 接口失败: ${body.code || response.status}`);
      error.response = response;
      throw error;
    }
    return body.data;
  }

  return {
    async authorize(userName, password) {
      const data = await call('/auth', { timestamp: Date.now(), userName, password });
      accessToken = String(data?.accessToken || '');
      if (!accessToken) throw new Error('Yeeke 授权成功但未返回 accessToken');
      return data;
    },
    async listWarehouses() {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/ware/list', { accessToken, timestamp: Date.now() });
    },
    async listServices() {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/otherService/list', { accessToken, timestamp: Date.now() });
    },
    async createOrderV2(order) {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/order/create/v2', { ...order, accessToken, timestamp: Date.now() });
    },
    async listOrders(filters = {}) {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/order/list', {
        pageNo: 1,
        pageSize: 20,
        ...filters,
        accessToken,
        timestamp: Date.now()
      });
    },
    async changeAirwaybill(order) {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/airwaybill/change', { ...order, accessToken, timestamp: Date.now() });
    },
    async updateOrderStatus(order) {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/status/update', { ...order, accessToken, timestamp: Date.now() });
    },
    async deleteDeliveryInfo(expressId) {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/deliveryinfo/delete', { expressId: String(expressId), accessToken, timestamp: Date.now() });
    },
    async addExpress(express) {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/express/add', { ...express, accessToken, timestamp: Date.now() });
    }
  };
}

function toTimestamp(value) {
  if (!value) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function marketplaceCountry(value) {
  const code = String(value || '').toUpperCase();
  return ({ MLM: 'MX', MLB: 'BR', MLC: 'CL', MCO: 'CO', MLA: 'AR', MLU: 'UY' })[code] || code;
}

function buildYeekeErpOrderNumber(externalUserId, orderId) {
  const identity = String(externalUserId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
  const sourceOrderId = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!identity) return sourceOrderId.slice(0, 32);
  return identity;
}

function buildYeekeResubmitOrderNumber(orderId, timestamp = Date.now()) {
  const source = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '') || 'ORDER';
  const time = Number.isFinite(Number(timestamp)) ? Math.floor(Number(timestamp)) : Date.now();
  const suffix = `-R${time.toString(36).toUpperCase()}`;
  return `${source.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
}

function extractYeekeOrderRecords(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

function isYeekeOrderReturned(order) {
  const returnFlag = String(order?.returnFlag ?? '').trim().toLowerCase();
  return String(order?.dgStatus ?? '').trim() === '7'
    || returnFlag === '1'
    || returnFlag === 'true';
}

function yeekeOrderReturnReason(order) {
  return String(order?.messageToUser || order?.returnReason || order?.refundReason || '仓库已退回订单').trim().slice(0, 2000);
}

function yeekeExpressCode(carrier) {
  const name = String(carrier || '').trim();
  const codes = {
    '圆通快递': 'yt', '圆通速递': 'yt', '中通快递': 'zt', '申通快递': 'st',
    '韵达快递': 'yds', '韵达速递': 'yds', '顺丰快递': 'sf', '顺丰速运': 'sf',
    '京东快递': 'jd', '京东物流': 'jd', '邮政EMS': 'ems', 'EMS': 'ems',
    '德邦快递': 'db', '德邦物流': 'db', '安能物流': 'aneng', '菜鸟物流': 'tmdn'
  };
  return codes[name] || (/^[a-z0-9-]+$/i.test(name) ? name : 'other');
}

async function replaceYeekeDomesticExpress(client, options = {}) {
  const ordersn = String(options.ordersn || '').trim();
  const previousTrackingNo = String(options.previousTrackingNo || '').trim();
  const trackingNo = String(options.trackingNo || '').trim();
  const carrier = String(options.carrier || '').trim();
  const remark = String(options.remark || '').trim().slice(0, 500);
  if (!ordersn) throw new Error('缺少 Yeeke 原订单号');
  if (!previousTrackingNo) throw new Error('缺少原国内快递单号');
  if (!trackingNo) throw new Error('请填写新的国内快递单号');

  const remoteData = await client.listOrders({
    ordersn,
    wareHouse: String(options.warehouseCode || '').trim() || undefined,
    pageNo: 1,
    pageSize: 20
  });
  const record = extractYeekeOrderRecords(remoteData).find(item => String(item?.ordersn || '') === ordersn);
  if (!record) throw new Error(`Yeeke 未找到原订单 ${ordersn}`);
  const matches = (Array.isArray(record.expressList) ? record.expressList : []).filter(item =>
    String(item?.trackingNo || '').trim() === previousTrackingNo
  );
  if (!matches.length) throw new Error(`Yeeke 原订单中未找到快递号 ${previousTrackingNo}，未执行任何修改`);
  if (matches.some(item => String(item?.status ?? '').trim() === '1')) {
    throw new Error('该快递已被仓库收货，Yeeke 不允许再修改快递号');
  }
  const snapshots = matches.map(item => ({
    id: String(item.id || '').trim(),
    itemId: String(item.itemId || '').trim() || undefined,
    goodsNum: Math.max(1, Math.floor(Number(item.sendQuantity) || 1))
  }));
  if (snapshots.some(item => !item.id)) throw new Error('Yeeke 快递记录缺少 expressId，未执行任何修改');

  const deleted = [];
  const added = [];
  const addPayload = (snapshot, targetTrackingNo, targetCarrier, targetRemark) => ({
    ordersn,
    itemId: snapshot.itemId,
    trackingNo: targetTrackingNo,
    goodsNum: snapshot.goodsNum,
    expressCode: yeekeExpressCode(targetCarrier),
    desp: targetRemark || undefined
  });
  try {
    for (const snapshot of snapshots) {
      await client.deleteDeliveryInfo(snapshot.id);
      deleted.push(snapshot);
    }
    for (const snapshot of snapshots) {
      await client.addExpress(addPayload(snapshot, trackingNo, carrier, remark));
      added.push(snapshot);
    }
  } catch (error) {
    const rollbackErrors = [];
    if (added.length) {
      try {
        const currentData = await client.listOrders({ ordersn, pageNo:1, pageSize:20 });
        const currentRecord = extractYeekeOrderRecords(currentData).find(item => String(item?.ordersn || '') === ordersn);
        const newEntries = (Array.isArray(currentRecord?.expressList) ? currentRecord.expressList : []).filter(item =>
          String(item?.trackingNo || '').trim() === trackingNo && String(item?.id || '').trim()
        );
        for (const entry of newEntries) await client.deleteDeliveryInfo(String(entry.id));
      } catch (cleanupError) {
        rollbackErrors.push(`新快递记录清理失败：${cleanupError.response?.data?.message || cleanupError.message || cleanupError}`);
      }
    }
    for (const snapshot of deleted) {
      try {
        await client.addExpress(addPayload(snapshot, previousTrackingNo, options.previousCarrier || carrier, options.previousRemark || ''));
      } catch (rollbackError) {
        rollbackErrors.push(String(rollbackError.response?.data?.message || rollbackError.message || rollbackError));
      }
    }
    if (rollbackErrors.length) {
      error.message = `${error.message || 'Yeeke 快递号修改失败'}；原快递恢复也失败，请立即联系管理员：${rollbackErrors.join('；')}`;
    }
    throw error;
  }
  return {
    ordersn,
    previousTrackingNo,
    trackingNo,
    deletedExpressIds: snapshots.map(item => item.id),
    addedCount: added.length,
    newOrderCreated: false
  };
}

function buildYeekeOrderPayload({ row, rows, warehouseCode, carrier, trackingNumber, shippingQuantity, shippingRemark, displayOrderId, providerOrderNumber, externalUserId, pdfString, serviceCodes }) {
  const sourceRows = (Array.isArray(rows) && rows.length ? rows : [row]).filter(Boolean);
  row = sourceRows[0] || {};
  const raw = row?.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  const sourceItems = sourceRows.flatMap((sourceRow) => {
    const sourceRaw = sourceRow?.raw_data && typeof sourceRow.raw_data === 'object' ? sourceRow.raw_data : {};
    return Array.isArray(sourceRow?.items) && sourceRow.items.length
      ? sourceRow.items
      : (Array.isArray(sourceRaw.order_items) ? sourceRaw.order_items : (Array.isArray(sourceRaw.items) ? sourceRaw.items : []));
  });
  const totalItemQuantity = sourceItems.reduce((total, entry) => {
    const item = entry?.item && typeof entry.item === 'object' ? entry.item : entry;
    return total + Math.max(1, Math.floor(Number(entry?.quantity || item?.quantity || 1)));
  }, 0);
  let remainingShippingQuantity = Math.min(
    Math.max(1, Math.floor(Number(shippingQuantity) || totalItemQuantity || 1)),
    Math.max(1, totalItemQuantity || 1)
  );
  const domesticTrackingNumber = String(trackingNumber || '').trim();
  const domesticRemark = String(shippingRemark || '').trim().slice(0, 500);
  const orderItems = sourceItems.map((entry) => {
    const item = entry?.item && typeof entry.item === 'object' ? entry.item : entry;
    const quantity = Math.max(1, Math.floor(Number(entry?.quantity || item?.quantity || 1)));
    const sendQuantity = Math.min(quantity, remainingShippingQuantity);
    remainingShippingQuantity = Math.max(0, remainingShippingQuantity - sendQuantity);
    const sku = item?.seller_custom_field || item?.variation_sku || item?.seller_sku || item?.sku || '';
    const imageUrl = item?.secure_thumbnail || item?.thumbnail || item?.picture_url || item?.pictures?.[0]?.secure_url || item?.pictures?.[0]?.url || '';
    return {
      itemName: String(item?.title || item?.itemName || item?.name || 'Mercado Libre 商品').slice(0, 500),
      itemNum: quantity,
      url: imageUrl ? String(imageUrl).replace(/^http:/i, 'https:') : undefined,
      variationSku: sku ? String(sku).slice(0, 200) : undefined,
      variationName: item?.variation_name ? String(item.variation_name).slice(0, 200) : undefined,
      productEnName: item?.title ? String(item.title).slice(0, 500) : undefined,
      expressInfos: domesticTrackingNumber && sendQuantity > 0 ? [{
        trackingNo: domesticTrackingNumber,
        sendQuantity,
        expressCode: yeekeExpressCode(carrier),
        note: domesticRemark || undefined
      }] : [],
      stockInfos: [],
      distributionProducts: []
    };
  });
  if (!orderItems.length) orderItems.push({ itemName: 'Mercado Libre 商品', itemNum: 1, expressInfos: [], stockInfos: [], distributionProducts: [] });
  const receiver = raw.shipping?.receiver_address || raw.shipping?.receiverInfo || raw.receiverInfo || {};
  const receiverInfo = Object.keys(receiver).length ? {
    name: receiver.receiver_name || receiver.name || receiver.receiver || raw.buyer?.nickname || '',
    phone: receiver.receiver_phone || receiver.phone || receiver.mobile || '',
    zipcode: receiver.zip_code || receiver.zipcode || receiver.zipCode || '',
    fullAddress: receiver.address_line || receiver.fullAddress || receiver.address || '',
    city: receiver.city?.name || receiver.city || '',
    state: receiver.state?.name || receiver.state || '',
    district: receiver.neighborhood?.name || receiver.neighborhood || receiver.district || '',
    country: receiver.country?.id || receiver.country || row.country || ''
  } : undefined;
  const sourceOrderId = String(displayOrderId || row.pack_id || row.ml_order_id || raw.pack_id || raw.id || raw.order_id || '');
  const orderId = String(providerOrderNumber || sourceOrderId);
  const identity = buildYeekeErpOrderNumber(externalUserId, sourceOrderId);
  const officialTrackingNumber = String(sourceRows.map((sourceRow) => {
    const sourceRaw = sourceRow?.raw_data && typeof sourceRow.raw_data === 'object' ? sourceRow.raw_data : {};
    return sourceRow?.tracking_number
      || sourceRaw?._shipment_detail?.tracking_number
      || sourceRaw?.shipping?.tracking_number
      || sourceRaw?.shipping?.tracking_no
      || '';
  }).find(Boolean) || '').trim();
  const internationalCarrier = String(sourceRows.map((sourceRow) => {
    const sourceRaw = sourceRow?.raw_data && typeof sourceRow.raw_data === 'object' ? sourceRow.raw_data : {};
    return sourceRow?.tracking_method
      || sourceRaw?._shipment_detail?.tracking_method
      || sourceRaw?.shipping?.tracking_method
      || '';
  }).find(Boolean) || '').trim();
  const totalAmount = sourceRows.reduce((total, sourceRow) => total + Number(sourceRow.total_amount || sourceRow.raw_data?.total_amount || 0), 0);
  const payload = {
    ordersn: orderId,
    erpOrdersn: identity,
    shopId: identity,
    note: externalUserId ? `山月ERP ${identity}` : '山月ERP',
    pdfString: pdfString || undefined,
    trackingNo: officialTrackingNumber || undefined,
    selectProList: [...new Set((Array.isArray(serviceCodes) ? serviceCodes : []).map(String).filter(Boolean))],
    packageType: 1,
    wareHouse: String(warehouseCode),
    autoRelateStock: 0,
    shopType: 'mercado',
    country: marketplaceCountry(row.country || raw.site_id) || undefined,
    currency: String(row.currency || raw.currency_id || '').toUpperCase() || undefined,
    totalAmount: totalAmount || Number(raw.paid_amount || 0) || undefined,
    orderCreateTime: toTimestamp(row.date_created || raw.date_created),
    shipByDate: toTimestamp(row.handling_deadline || row.ship_by_date),
    payTime: toTimestamp(raw.payments?.[0]?.date_created || raw.paid_at),
    orderStatus: String(row.status || raw.status || '').slice(0, 100) || undefined,
    shippingCarrier: internationalCarrier.slice(0, 100) || undefined,
    receiverInfo,
    orderItems
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== ''));
}

module.exports = {
  DEFAULT_YEEKE_BASE_URL,
  YEEKE_API_PREFIX,
  buildYeekeEnvelope,
  createYeekeClient,
  buildYeekeErpOrderNumber,
  buildYeekeResubmitOrderNumber,
  buildYeekeOrderPayload,
  extractYeekeOrderRecords,
  isYeekeOrderReturned,
  yeekeOrderReturnReason,
  yeekeExpressCode,
  replaceYeekeDomesticExpress
};
