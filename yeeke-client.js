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
    async changeAirwaybill(order) {
      if (!accessToken) throw new Error('Yeeke 尚未授权');
      return call('/airwaybill/change', { ...order, accessToken, timestamp: Date.now() });
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
  const availableOrderLength = Math.max(1, 32 - identity.length - 1);
  return `${identity}-${sourceOrderId.slice(-availableOrderLength)}`;
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

function buildYeekeOrderPayload({ row, rows, warehouseCode, carrier, trackingNumber, displayOrderId, externalUserId, pdfString }) {
  const sourceRows = (Array.isArray(rows) && rows.length ? rows : [row]).filter(Boolean);
  row = sourceRows[0] || {};
  const raw = row?.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  const sourceItems = sourceRows.flatMap((sourceRow) => {
    const sourceRaw = sourceRow?.raw_data && typeof sourceRow.raw_data === 'object' ? sourceRow.raw_data : {};
    return Array.isArray(sourceRow?.items) && sourceRow.items.length
      ? sourceRow.items
      : (Array.isArray(sourceRaw.order_items) ? sourceRaw.order_items : (Array.isArray(sourceRaw.items) ? sourceRaw.items : []));
  });
  const orderItems = sourceItems.map((entry) => {
    const item = entry?.item && typeof entry.item === 'object' ? entry.item : entry;
    const quantity = Math.max(1, Number(entry?.quantity || item?.quantity || 1));
    const sku = item?.seller_custom_field || item?.variation_sku || item?.seller_sku || item?.sku || '';
    const imageUrl = item?.secure_thumbnail || item?.thumbnail || item?.picture_url || item?.pictures?.[0]?.secure_url || item?.pictures?.[0]?.url || '';
    return {
      itemName: String(item?.title || item?.itemName || item?.name || 'Mercado Libre 商品').slice(0, 500),
      itemNum: quantity,
      url: imageUrl ? String(imageUrl).replace(/^http:/i, 'https:') : undefined,
      variationSku: sku ? String(sku).slice(0, 200) : undefined,
      variationName: item?.variation_name ? String(item.variation_name).slice(0, 200) : undefined,
      productEnName: item?.title ? String(item.title).slice(0, 500) : undefined,
      expressInfos: trackingNumber ? [{ trackingNo: String(trackingNumber), sendQuantity: quantity, expressCode: yeekeExpressCode(carrier) }] : [],
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
  const orderId = String(displayOrderId || row.pack_id || row.ml_order_id || raw.pack_id || raw.id || raw.order_id || '');
  const totalAmount = sourceRows.reduce((total, sourceRow) => total + Number(sourceRow.total_amount || sourceRow.raw_data?.total_amount || 0), 0);
  const payload = {
    ordersn: orderId,
    erpOrdersn: buildYeekeErpOrderNumber(externalUserId, orderId),
    pdfString: pdfString || undefined,
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
    shippingCarrier: String(carrier || '').slice(0, 100) || undefined,
    receiverInfo,
    orderItems
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== ''));
}

module.exports = { DEFAULT_YEEKE_BASE_URL, YEEKE_API_PREFIX, buildYeekeEnvelope, createYeekeClient, buildYeekeErpOrderNumber, buildYeekeOrderPayload };
