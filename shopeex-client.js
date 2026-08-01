const crypto = require('crypto');
const axios = require('axios');

const DEFAULT_SHOPEEX_BASE_URL = 'https://openapi-v3.shopeex.cn';
const SHOPEEX_MERCADO_PLATFORM_ID = 48;
const SHOPEEX_COUNTRY_IDS = Object.freeze({ BR: 12, MX: 13, CO: 23, CL: 25 });

function normalizeShopeexAccessUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try { return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname; }
  catch (_) { return text.replace(/^https?:\/\//i, '').replace(/\/+$/, ''); }
}

function selectShopeexWarehouseAddress(addresses, { requestedId, defaultId, connectorName } = {}) {
  const active = (Array.isArray(addresses) ? addresses : []).filter(item => Number(item?.status ?? 1) !== 0 && Number(item?.storeAddressId) > 0);
  const requested = Number(requestedId);
  if (requested) return active.find(item => Number(item.storeAddressId) === requested) || null;
  const localName = String(connectorName || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').toLowerCase();
  const nameMatched = active.find(item => {
    const remoteName = String(item?.storeName || item?.desp || '').trim();
    const compact = remoteName.replace(/\s+/g, '').toLowerCase();
    const lastToken = String(remoteName.split(/[\s,，/]+/).filter(Boolean).pop() || '').toLowerCase();
    return [compact,lastToken].some(alias => alias.length >= 3 && (localName.includes(alias) || alias.includes(localName)));
  });
  return nameMatched || active.find(item => Number(item.storeAddressId) === Number(defaultId)) || active[0] || null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function buildShopeexEnvelope(appKey, appSecret, requestBody = {}) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const digest = crypto.createHash('md5').update(`${JSON.stringify(body)}${String(appSecret || '')}`, 'utf8').digest('hex');
  return {
    appKey: String(appKey || ''),
    sign: Buffer.from(digest, 'utf8').toString('base64'),
    requestBody: body
  };
}

function createShopeexClient(config = {}, request = axios) {
  const baseUrl = String(config.baseUrl || DEFAULT_SHOPEEX_BASE_URL).replace(/\/+$/, '');
  const appKey = String(config.appKey || '');
  const appSecret = String(config.appSecret || '');
  let openId = String(config.openId || '');
  if (!appKey || !appSecret) throw new Error('Shopeex/KJX appKey 或 appSecret 未配置');

  async function call(path, requestBody = {}, { requireOpenId = true } = {}) {
    if (requireOpenId && !openId) throw new Error('Shopeex/KJX openId 未配置');
    const headers = { 'Content-Type': 'application/json' };
    if (openId) headers.openId = openId;
    const response = await request.post(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`,
      buildShopeexEnvelope(appKey, appSecret, requestBody), { headers, timeout: 30000, maxRedirects: 0 });
    const result = response?.data || {};
    if (Number(result.code) !== 1000) {
      const error = new Error(String(result.message || `Shopeex/KJX 接口返回错误 ${result.code ?? ''}`).trim());
      error.response = { status: response?.status || 502, data: result };
      throw error;
    }
    return result.data;
  }

  return {
    async authorize(accessUrl, username, password) {
      const data = await call('/api/kjxUser/authLogin', {
        accessUrl: normalizeShopeexAccessUrl(accessUrl),
        username: String(username || '').trim(),
        password: String(password || '')
      }, { requireOpenId: false });
      openId = String(data?.openId || '');
      if (!openId) throw new Error('Shopeex/KJX 登录成功但未返回 openId');
      return data;
    },
    getOpenId: () => openId,
    userInfo: () => call('/api/kjxUser/list', {}),
    listWarehouseAddresses: () => call('/api/kjxStoreAddress/list', {}),
    listWarehouses: () => call('/api/kjxStoreInfo/list', {}),
    listServices: () => call('/api/kjxStoreCharge/list', {}),
    listStock: payload => call('/api/kjxStock/list', payload || {}),
    addOrUpdateStock: payload => call('/api/kjxStock/user/addOrUpdate', payload || {}),
    uploadPdf: base64Content => call('/api/upload/uploadbase64/pdf', { base64Content }),
    createAndPackage: payload => call('/api/batch/add', payload),
    listPendingOrderIds: payload => call('/api/order/idsList', payload),
    listPackagedOrderIds: payload => call('/api/order/user/idsPackageList', payload),
    getOrderDetails: ids => call('/api/order/orderList', { idss: (Array.isArray(ids) ? ids : [ids]).map(String) }),
    getPackagedOrderDetails: ids => call('/api/order/user/orderPackageList', { idss: (Array.isArray(ids) ? ids : [ids]).map(String) }),
    cancelPackage: kjxPackageIds => call('/api/packaged/packageCancel', { kjxPackageIds: String(kjxPackageIds || '') }),
    addPackageRemark: (kjxOrderIds, packageDesp, packageImages = []) => call('/api/packaged/addPackageDesp', {
      kjxOrderIds: String(kjxOrderIds || ''), packageDesp: String(packageDesp || ''), packageImages
    })
  };
}

function timestamp(value) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function countryCode(row = {}) {
  const raw = row.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  const site = String(row.country || row.site_id || raw.site_id || '').toUpperCase();
  return site.replace(/^ML/, '');
}

function orderItemEntries(row = {}) {
  const raw = row.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  return Array.isArray(row.items) && row.items.length ? row.items
    : (Array.isArray(raw.order_items) ? raw.order_items : (Array.isArray(raw.items) ? raw.items : []));
}

function itemImage(item = {}) {
  const value = item.thumbnail || item.secure_thumbnail || item.picture_url || item.image_url || item.image || '';
  return String(value).replace(/^http:\/\//i, 'https://');
}

function buildShopeexOrderPayload({ row, rows, displayOrderId, providerOrderNumber, externalUserId,
  airwayBillUrl, serviceCodes = [], storeAddressId, carrier, carrierCode, trackingNumber,
  shippingQuantity, shippingRemark } = {}) {
  const sourceRows = (Array.isArray(rows) && rows.length ? rows : [row]).filter(Boolean);
  if (!sourceRows.length) throw new Error('Shopeex/KJX 推单缺少订单数据');
  const primary = sourceRows[0];
  const primaryRaw = primary.raw_data && typeof primary.raw_data === 'object' ? primary.raw_data : {};
  const orderSn = String(providerOrderNumber || displayOrderId || primary.pack_id || primary.ml_order_id || primaryRaw.pack_id || primaryRaw.id || '');
  if (!orderSn) throw new Error('Shopeex/KJX 推单缺少订单号');
  const domesticTrackingNumber = String(trackingNumber || '').trim();
  const domesticCarrier = String(carrier || '').trim();
  const domesticCarrierCode = String(carrierCode || '').trim();
  if (!domesticTrackingNumber || !domesticCarrier || !domesticCarrierCode) throw new Error('Shopeex/KJX 推单需要国内快递公司、快递代码和快递单号');

  const officialTrackingNumber = String(sourceRows.map(sourceRow => {
    const raw = sourceRow.raw_data && typeof sourceRow.raw_data === 'object' ? sourceRow.raw_data : {};
    return sourceRow.tracking_number || raw?._shipment_detail?.tracking_number || raw?.shipping?.tracking_number || raw?.shipping?.tracking_no || '';
  }).find(Boolean) || '').trim();
  const shipmentType = String(sourceRows.map(sourceRow => {
    const raw = sourceRow.raw_data && typeof sourceRow.raw_data === 'object' ? sourceRow.raw_data : {};
    return sourceRow.tracking_method || raw?._shipment_detail?.tracking_method || raw?.shipping?.tracking_method || '';
  }).find(Boolean) || '').trim();
  const receiver = primaryRaw.shipping?.receiver_address || primaryRaw.shipping?.receiverInfo || primaryRaw.receiverInfo || {};
  const totalAmount = sourceRows.reduce((total, sourceRow) => total + Number(sourceRow.total_amount || sourceRow.raw_data?.total_amount || 0), 0);
  const availableQuantity = sourceRows.reduce((total, sourceRow) => total + orderItemEntries(sourceRow).reduce((sum, entry) => {
    const item = entry?.item && typeof entry.item === 'object' ? entry.item : entry;
    return sum + Math.max(1, Math.floor(Number(entry?.quantity || item?.quantity || 1)));
  }, 0), 0) || 1;
  let remainingQuantity = Math.min(availableQuantity, Math.max(1, Math.floor(Number(shippingQuantity) || availableQuantity)));
  const orderItems = [];
  for (const sourceRow of sourceRows) {
    for (const entry of orderItemEntries(sourceRow)) {
      if (remainingQuantity <= 0) break;
      const item = entry?.item && typeof entry.item === 'object' ? entry.item : entry;
      const orderedQuantity = Math.max(1, Math.floor(Number(entry?.quantity || item?.quantity || 1)));
      const quantity = Math.min(orderedQuantity, remainingQuantity);
      remainingQuantity -= quantity;
      orderItems.push(compactObject({
        skuImages: itemImage(item),
        itemName: String(item?.title || entry?.title || 'Mercado Libre 商品').slice(0,500),
        variationQuantityPurchased: quantity,
        variationSku: String(item?.seller_custom_field || item?.seller_sku || entry?.seller_sku || entry?.sku || '').slice(0,200),
        variationName: String(entry?.variation_name || item?.variation_name || '').slice(0,500),
        batchItemLogisticsDTOs: [{
          logisticsCorp: domesticCarrier,
          logisticsShortCorp: domesticCarrierCode,
          logisticsNo: domesticTrackingNumber,
          logisticsType: 1,
          stockCount: 0
        }]
      }));
    }
  }
  if (!orderItems.length) throw new Error('Shopeex/KJX 推单缺少商品信息');
  const createdAt = timestamp(primary.date_created || primaryRaw.date_created);
  const shipTime = timestamp(primary.handling_deadline || primary.ship_by_date);
  const daysToShip = createdAt && shipTime ? Math.max(0, Math.ceil((shipTime - createdAt) / 86400000)) : 0;
  const identity = String(externalUserId || '').trim();
  const remark = [identity ? `山月ERP ${identity}` : '山月ERP', String(shippingRemark || '').trim()].filter(Boolean).join('；').slice(0,500);
  return {
    orderSn,
    trackingNo: officialTrackingNumber,
    kjxPlatformId: SHOPEEX_MERCADO_PLATFORM_ID,
    isCb: 1,
    kjxCountryId: SHOPEEX_COUNTRY_IDS[countryCode(primary)] || 1,
    totalAmount: totalAmount || Number(primaryRaw.paid_amount || 0) || 0,
    currency: String(primary.currency || primaryRaw.currency_id || '').toUpperCase(),
    shipTime,
    cancelTime: timestamp(primaryRaw.expiration_date || primaryRaw.cancel_time),
    daysToShip,
    cod: 0,
    airwayBillUrl: String(airwayBillUrl || ''),
    shipmentType,
    recipientCity: String(receiver.city?.name || receiver.city || ''),
    recipientDistrict: String(receiver.neighborhood?.name || receiver.neighborhood || receiver.district || ''),
    recipientFullAddress: String(receiver.address_line || receiver.fullAddress || receiver.address || ''),
    recipientName: String(receiver.receiver_name || receiver.name || receiver.receiver || primaryRaw.buyer?.nickname || ''),
    recipientPhone: String(receiver.receiver_phone || receiver.phone || receiver.mobile || ''),
    recipientState: String(receiver.state?.name || receiver.state || ''),
    recipientTown: String(receiver.municipality?.name || receiver.municipality || receiver.town || ''),
    recipientZipcode: String(receiver.zip_code || receiver.zipcode || receiver.zipCode || ''),
    kjxOrderItems: orderItems,
    kjxOrderPackageDTO: {
      kjxStoreChargeIdList: [...new Set((Array.isArray(serviceCodes) ? serviceCodes : []).map(String).filter(Boolean))],
      packageIsGrantScore: 0,
      storeAddressId: Number(storeAddressId),
      totalScore: 0
    },
    kjxPackageDespDTO: { packageDesp: remark, packageImageList: [] }
  };
}

module.exports = {
  DEFAULT_SHOPEEX_BASE_URL,
  SHOPEEX_MERCADO_PLATFORM_ID,
  SHOPEEX_COUNTRY_IDS,
  normalizeShopeexAccessUrl,
  selectShopeexWarehouseAddress,
  buildShopeexEnvelope,
  createShopeexClient,
  buildShopeexOrderPayload
};
