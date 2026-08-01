const assert = require('assert');
const {
  SHOPEEX_MERCADO_PLATFORM_ID,
  SHOPEEX_COUNTRY_IDS,
  buildShopeexEnvelope,
  createShopeexClient,
  buildShopeexOrderPayload
} = require('../shopeex-client');

async function run() {
  const envelope = buildShopeexEnvelope('app-key', 'secret', { idss: ['123'] });
  assert.strictEqual(envelope.appKey, 'app-key');
  assert.strictEqual(envelope.sign, Buffer.from(require('crypto').createHash('md5').update('{"idss":["123"]}secret').digest('hex')).toString('base64'));

  const calls = [];
  const request = { async post(url, body, options) {
    calls.push({ url, body, options });
    if (url.endsWith('/authLogin')) return { status: 200, data: { code: 1000, data: { openId: 'OPEN-1', userId: 7 }, message: '' } };
    if (url.endsWith('/kjxUser/list')) return { status: 200, data: { code: 1000, data: { userInfo: { userId: 7 } }, message: '' } };
    if (url.endsWith('/uploadbase64/pdf')) return { status: 200, data: { code: 1000, data: { fileUrl: 'https://static.example/label.pdf' }, message: '' } };
    if (url.endsWith('/batch/add')) return { status: 200, data: { code: 1000, data: { kjxOrderIds: 'KJX-1' }, message: '' } };
    throw new Error(`unexpected URL ${url}`);
  } };
  const client = createShopeexClient({ appKey: 'app-key', appSecret: 'secret' }, request);
  await client.authorize('c888.shopeex.cn', 'seller', 'password');
  await client.userInfo();
  assert.strictEqual(calls[1].options.headers.openId, 'OPEN-1');
  const uploaded = await client.uploadPdf('data/application/pdf/base64/JVBERi0=');
  assert.strictEqual(uploaded.fileUrl, 'https://static.example/label.pdf');
  const created = await client.createAndPackage({ orderSn: '200001' });
  assert.strictEqual(created.kjxOrderIds, 'KJX-1');

  const payload = buildShopeexOrderPayload({
    row: {
      ml_order_id: '2000014231142463', country: 'CL', currency: 'USD', total_amount: 3.01,
      date_created: '2026-07-28T04:02:56.000Z', handling_deadline: '2026-08-03T15:59:59.000Z',
      tracking_number: 'INTL-9988', tracking_method: 'MEL Distribution',
      items: [{ item: { title: 'Ventilation Clips', seller_custom_field: 'SKU-1', thumbnail: 'http://img.example/a.jpg' }, quantity: 3 }],
      raw_data: { buyer: { nickname: 'buyer' }, shipping: { receiver_address: { receiver_name: 'A', address_line: 'Street 1', zip_code: '123' } } }
    },
    storeAddressId: 11, carrier: '圆通速递', carrierCode: '285', trackingNumber: 'YT123',
    shippingQuantity: 2, shippingRemark: '易碎', externalUserId: 'SY12345',
    airwayBillUrl: 'https://static.example/label.pdf', serviceCodes: ['12', '13', '12']
  });
  assert.strictEqual(payload.orderSn, '2000014231142463');
  assert.strictEqual(payload.kjxPlatformId, SHOPEEX_MERCADO_PLATFORM_ID);
  assert.strictEqual(payload.kjxCountryId, SHOPEEX_COUNTRY_IDS.CL);
  assert.strictEqual(payload.trackingNo, 'INTL-9988');
  assert.strictEqual(payload.airwayBillUrl, 'https://static.example/label.pdf');
  assert.strictEqual(payload.kjxOrderItems[0].skuImages, 'https://img.example/a.jpg');
  assert.strictEqual(payload.kjxOrderItems[0].variationQuantityPurchased, 2);
  assert.strictEqual(payload.kjxOrderItems[0].batchItemLogisticsDTOs[0].logisticsNo, 'YT123');
  assert.strictEqual(payload.kjxOrderItems[0].batchItemLogisticsDTOs[0].logisticsShortCorp, '285');
  assert.deepStrictEqual(payload.kjxOrderPackageDTO.kjxStoreChargeIdList, ['12', '13']);
  assert.strictEqual(payload.kjxOrderPackageDTO.storeAddressId, 11);
  assert.ok(payload.kjxPackageDespDTO.packageDesp.includes('山月ERP SY12345'));
  assert.ok(payload.kjxPackageDespDTO.packageDesp.includes('易碎'));
  console.log('Shopeex client tests passed');
}

run().catch(error => { console.error(error); process.exit(1); });
