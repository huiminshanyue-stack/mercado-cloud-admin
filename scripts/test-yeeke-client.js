const assert = require('assert');
const {
  buildYeekeEnvelope,
  createYeekeClient,
  YEEKE_SWITCH_CANCELLATION_NOTICE,
  buildYeekeErpOrderNumber,
  buildYeekeResubmitOrderNumber,
  buildYeekeOrderPayload,
  extractYeekeOrderRecords,
  isYeekeOrderReturned,
  yeekeOrderReturnReason,
  replaceYeekeDomesticExpress
} = require('../yeeke-client');

async function run() {
  const signed = buildYeekeEnvelope(
    '1374933528042541058',
    'fR6nkYXWUdzaPTKSrZEpRhIv59E4Z2',
    { password: '123456', userName: '张三', timestamp: 1616643338337 }
  );
  assert.strictEqual(signed.sign, '764D26019278BD36CB9201F191465F43');
  assert.strictEqual(typeof signed.data, 'string');

  const calls = [];
  const request = {
    async post(url, envelope) {
      calls.push({ url, body: JSON.parse(envelope.data), envelope });
      if (url.endsWith('/auth')) return { status: 200, data: { code: '0', message: '成功', data: { accessToken: 'token', userCode: 'u1' } } };
      if (url.endsWith('/ware/list')) return { status: 200, data: { code: '0', message: '成功', data: [{ wareHouse: 'th', wareName: '东莞仓' }] } };
      if (url.endsWith('/otherService/list')) return { status: 200, data: { code: '0', message: '成功', data: [{ id: 'service-1', name: '打包', price: 1 }] } };
      if (url.endsWith('/stock/list')) return { status: 200, data: { code: '0', message: '成功', data: { records: [{ sysCode: 'P1', availableNum: 8 }] } } };
      if (url.endsWith('/userLocalProduct/list')) return { status: 200, data: { code: '0', message: '成功', data: { records: [{ sysCode: 'P1', sku: 'SKU-1' }] } } };
      if (url.endsWith('/product/add')) return { status: 200, data: { code: '0', message: '成功', data: { id: '1', sysCode: 'P1' } } };
      if (url.endsWith('/storage/add')) return { status: 200, data: { code: '0', message: '成功', data: { id: 'S1', storageBillCode: 'RK1' } } };
      if (url.endsWith('/storage/list')) return { status: 200, data: { code: '0', message: '成功', data: { records: [{ id: 'S1', storageBillCode: 'RK1' }] } } };
      if (url.endsWith('/order/create/v2')) return { status: 200, data: { code: '0', message: '成功', data: { id: 'Y1' } } };
      if (url.endsWith('/order/list') && JSON.parse(envelope.data).ordersn === 'ORIGINAL-1') return { status: 200, data: { code: '0', message: '成功', data: { records: [{ ordersn: 'ORIGINAL-1', dgStatus: '3', expressList: [{ id:'EXP-1',itemId:'ITEM-1',trackingNo:'OLD123',sendQuantity:2,status:'0' }] }] } } };
      if (url.endsWith('/order/list')) return { status: 200, data: { code: '0', message: '成功', data: { records: [{ ordersn: '200001', dgStatus: '3' }] } } };
      if (url.endsWith('/airwaybill/change')) return { status: 200, data: { code: '0', message: '成功', data: null } };
      if (url.endsWith('/status/update')) return { status: 200, data: { code: '0', message: '成功', data: null } };
      if (url.endsWith('/order/status')) return { status: 200, data: { code: '0', message: '成功', data: null } };
      if (url.endsWith('/deliveryinfo/delete')) return { status: 200, data: { code: '0', message: '成功', data: null } };
      if (url.endsWith('/express/add')) return { status: 200, data: { code: '0', message: '成功', data: null } };
      throw new Error(`unexpected URL ${url}`);
    }
  };
  const client = createYeekeClient({ appId: 'app', appSecret: 'secret' }, request);
  await client.authorize('seller', 'password.');
  const warehouses = await client.listWarehouses();
  assert.strictEqual(warehouses[0].wareHouse, 'th');
  await client.createOrderV2({ ordersn: '200001', wareHouse: 'th', packageType: 1, autoRelateStock: 0, orderItems: [] });
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[2].body.accessToken, 'token');
  assert.strictEqual(calls[2].body.ordersn, '200001');
  const listedOrders = await client.listOrders({ ordersn: '200001' });
  assert.strictEqual(listedOrders.records[0].ordersn, '200001');
  assert.strictEqual(calls[3].body.pageNo, 1);
  assert.strictEqual(calls[3].body.pageSize, 20);
  await client.changeAirwaybill({ ordersn: '200001', pdfString: 'JVBERi0=' });
  assert.strictEqual(calls[4].body.pdfString, 'JVBERi0=');
  const remoteServices = await client.listServices();
  assert.strictEqual(remoteServices[0].id, 'service-1');
  await client.updateOrderStatus({ ordersn: '200001', status: 'cancelled' });
  assert.strictEqual(calls[6].body.status, 'cancelled');
  assert.ok(calls[6].url.endsWith('/status/update'));
  await client.cancelOrder('200001');
  assert.strictEqual(calls[7].body.status, '7');
  assert.ok(calls[7].url.endsWith('/order/status'));
  const stock = await client.listStock({ wareHouse: 'th' });
  assert.strictEqual(stock.records[0].availableNum, 8);
  assert.strictEqual(calls[8].body.pageSize, 50);
  const products = await client.listLocalProducts({ sku: 'SKU-1' });
  assert.strictEqual(products.records[0].sysCode, 'P1');
  const product = await client.createLocalProduct({ name: '商品', sku: 'SKU-1', productType: '0' });
  assert.strictEqual(product.sysCode, 'P1');
  const inbound = await client.createOrUpdateInbound({ wareHouse: 'th', storageType: '0', trackingNo: 'YT1', boxItems: [] });
  assert.strictEqual(inbound.storageBillCode, 'RK1');
  const inbounds = await client.listInbounds({ storageBillCode: 'RK1' });
  assert.strictEqual(inbounds.records[0].id, 'S1');
  assert.strictEqual(calls[12].body.storageType, '0');

  const expressUpdate = await replaceYeekeDomesticExpress(client,{
    ordersn:'ORIGINAL-1',warehouseCode:'th',previousTrackingNo:'OLD123',trackingNo:'NEW456',
    carrier:'中通快递',remark:'更正快递号',previousCarrier:'圆通快递',previousRemark:'原备注'
  });
  assert.strictEqual(expressUpdate.newOrderCreated,false);
  assert.deepStrictEqual(expressUpdate.deletedExpressIds,['EXP-1']);
  assert.ok(calls[14].url.endsWith('/deliveryinfo/delete'));
  assert.strictEqual(calls[14].body.expressId,'EXP-1');
  assert.ok(calls[15].url.endsWith('/express/add'));
  assert.strictEqual(calls[15].body.ordersn,'ORIGINAL-1');
  assert.strictEqual(calls[15].body.trackingNo,'NEW456');
  assert.strictEqual(calls[15].body.itemId,'ITEM-1');
  assert.strictEqual(calls[15].body.goodsNum,2);
  assert.strictEqual(calls[15].body.expressCode,'zt');
  assert.strictEqual(calls[15].body.desp,'更正快递号');
  let receivedDeleteCalled = false;
  await assert.rejects(() => replaceYeekeDomesticExpress({
    listOrders:async()=>({ records:[{ ordersn:'RECEIVED-1',expressList:[{ id:'EXP-2',trackingNo:'OLD',sendQuantity:1,status:'1' }] }] }),
    deleteDeliveryInfo:async()=>{ receivedDeleteCalled = true; },
    addExpress:async()=>{}
  },{ ordersn:'RECEIVED-1',previousTrackingNo:'OLD',trackingNo:'NEW',carrier:'中通快递' }),/已被仓库收货/);
  assert.strictEqual(receivedDeleteCalled,false);
  let rollbackListCount=0,newAddCount=0;
  const rollbackDeleted=[],rollbackAdds=[];
  await assert.rejects(() => replaceYeekeDomesticExpress({
    listOrders:async()=>{
      rollbackListCount++;
      return rollbackListCount === 1
        ? { records:[{ ordersn:'ROLLBACK-1',expressList:[
          { id:'OLD-1',itemId:'ITEM-1',trackingNo:'OLD',sendQuantity:1,status:'0' },
          { id:'OLD-2',itemId:'ITEM-2',trackingNo:'OLD',sendQuantity:1,status:'0' }
        ] }] }
        : { records:[{ ordersn:'ROLLBACK-1',expressList:[{ id:'NEW-REMOTE-1',trackingNo:'NEW',sendQuantity:1,status:'0' }] }] };
    },
    deleteDeliveryInfo:async id=>rollbackDeleted.push(id),
    addExpress:async payload=>{
      rollbackAdds.push(payload);
      if (payload.trackingNo === 'NEW' && ++newAddCount === 2) throw new Error('second add failed');
    }
  },{ ordersn:'ROLLBACK-1',previousTrackingNo:'OLD',trackingNo:'NEW',carrier:'中通快递',previousCarrier:'圆通快递' }),/second add failed/);
  assert.deepStrictEqual(rollbackDeleted,['OLD-1','OLD-2','NEW-REMOTE-1']);
  assert.strictEqual(rollbackAdds.filter(item=>item.trackingNo === 'OLD').length,2);

  const payload = buildYeekeOrderPayload({
    row: {
      ml_order_id: '2000014231142463',
      date_created: '2026-07-28T04:02:56.000Z',
      handling_deadline: '2026-08-03T15:59:59.000Z',
      tracking_number: 'INTL-ML-9988',
      tracking_method: 'MEL Distribution',
      country: 'CL', currency: 'USD', total_amount: 3.01,
      items: [{ item: { title: 'Ventilation Clips', seller_custom_field: 'CBT-5024470568', thumbnail: 'http://http2.mlstatic.com/image.jpg', permalink: 'https://articulo.mercadolibre.com/item' }, quantity: 3 }],
      raw_data: { buyer: { nickname: 'buyer' }, shipping: { receiver_address: { receiver_name: 'A', address_line: 'Street 1', zip_code: '123' } } }
    },
    warehouseCode: 'ywc', carrier: '中通快递', trackingNumber: 'YT123', shippingQuantity: 2,
    shippingRemark: '易碎，请核对数量', externalUserId: 'SY12345', pdfString: 'JVBERi0xLjQ=', serviceCodes: ['1933035392616419330','1933035392616419330','1933035698318266370']
  });
  assert.strictEqual(payload.ordersn, '2000014231142463');
  assert.strictEqual(payload.wareHouse, 'ywc');
  assert.strictEqual(payload.shopType, 'mercado');
  assert.strictEqual(payload.packageType, 1);
  assert.strictEqual(payload.orderItems[0].variationSku, 'CBT-5024470568');
  assert.strictEqual(payload.orderItems[0].url, 'https://http2.mlstatic.com/image.jpg');
  assert.deepStrictEqual(payload.orderItems[0].stockInfos, []);
  assert.deepStrictEqual(payload.orderItems[0].distributionProducts, []);
  assert.strictEqual(payload.orderItems[0].expressInfos[0].trackingNo, 'YT123');
  assert.strictEqual(payload.orderItems[0].expressInfos[0].sendQuantity, 2);
  assert.strictEqual(payload.orderItems[0].expressInfos[0].expressCode, 'zt');
  assert.strictEqual(payload.orderItems[0].expressInfos[0].note, '易碎，请核对数量');
  assert.strictEqual(payload.receiverInfo.zipcode, '123');
  assert.strictEqual(payload.receiverInfo.fullAddress, 'Street 1');
  assert.strictEqual(payload.erpOrdersn, 'SY12345');
  assert.strictEqual(payload.shopID, 'SY12345');
  assert.strictEqual(payload.shopId, undefined);
  assert.strictEqual(payload.erpOrderSn, 'SY12345');
  assert.strictEqual(payload.sysUserNote, 'SY12345');
  assert.strictEqual(payload.goodsType, undefined);
  assert.strictEqual(payload.note, `山月ERP SY12345；${YEEKE_SWITCH_CANCELLATION_NOTICE}`);
  assert.match(payload.note, /取消或取消中/);
  assert.match(payload.note, /立即停止处理旧单/);
  assert.strictEqual(payload.pdfString, 'JVBERi0xLjQ=');
  assert.strictEqual(payload.trackingNo, 'INTL-ML-9988');
  assert.strictEqual(payload.shippingCarrier, 'MEL Distribution');
  assert.notStrictEqual(payload.trackingNo, payload.orderItems[0].expressInfos[0].trackingNo);
  assert.deepStrictEqual(payload.selectProList, ['1933035392616419330','1933035698318266370']);
  assert.ok(payload.erpOrdersn.length <= 32);
  assert.ok(Number.isFinite(payload.shipByDate));

  const stockPayload = buildYeekeOrderPayload({
    row: { ml_order_id:'STOCK-1',items:[{ item:{ title:'Stock item',seller_custom_field:'SKU-STOCK' },quantity:2 }] },
    warehouseCode:'th',externalUserId:'SY12345',fulfillmentMode:'stock',shippingQuantity:2,
    stockAllocations:[{ sku:'SKU-STOCK',remoteProductId:'L00000004721',quantity:2 }]
  });
  assert.deepStrictEqual(stockPayload.orderItems[0].expressInfos,[]);
  assert.deepStrictEqual(stockPayload.orderItems[0].stockInfos,[{ sysCode:'L00000004721',num:2 }]);
  assert.strictEqual(stockPayload.autoRelateStock,0);

  const replacementPayload = buildYeekeOrderPayload({
    row: { ml_order_id: '200001', items: [{ item: { title: 'Item' }, quantity: 1 }] },
    displayOrderId: '200001', providerOrderNumber: '200001-R123456', warehouseCode: 'th', externalUserId: 'SY12345'
  });
  assert.strictEqual(replacementPayload.ordersn, '200001-R123456');
  assert.strictEqual(replacementPayload.erpOrdersn, 'SY12345');
  assert.strictEqual(replacementPayload.erpOrderSn, 'SY12345');
  assert.strictEqual(replacementPayload.shopID, 'SY12345');
  assert.strictEqual(replacementPayload.sysUserNote, 'SY12345');

  const packPayload = buildYeekeOrderPayload({
    rows: [
      { ml_order_id: 'child-1', pack_id: 'pack-1', country: 'MX', currency: 'USD', total_amount: 10, items: [{ item: { title: 'A' }, quantity: 1 }], raw_data: {} },
      { ml_order_id: 'child-2', pack_id: 'pack-1', country: 'MX', currency: 'USD', total_amount: 20, items: [{ item: { title: 'B' }, quantity: 2 }], raw_data: {} }
    ],
    displayOrderId: 'pack-1', warehouseCode: 'th', carrier: '顺丰', trackingNumber: 'SF1', shippingQuantity: 2, shippingRemark: '分两件发货'
  });
  assert.strictEqual(packPayload.ordersn, 'pack-1');
  assert.strictEqual(packPayload.orderItems.length, 2);
  assert.strictEqual(packPayload.totalAmount, 30);
  assert.strictEqual(packPayload.country, 'MX');
  assert.strictEqual(packPayload.orderItems[0].expressInfos[0].sendQuantity, 1);
  assert.strictEqual(packPayload.orderItems[1].expressInfos[0].sendQuantity, 1);
  assert.strictEqual(packPayload.orderItems[1].expressInfos[0].note, '分两件发货');
  assert.strictEqual(buildYeekeErpOrderNumber('SY12345', '2000014266367529'), 'SY12345');
  assert.notStrictEqual(buildYeekeErpOrderNumber('SY12345', '2000014266367529'), buildYeekeErpOrderNumber('SY54321', '2000014266367529'));
  const resubmitOrderNumber = buildYeekeResubmitOrderNumber('2000014266367529', 1722337200000);
  assert.ok(resubmitOrderNumber.startsWith('2000014266367529-R'));
  assert.ok(resubmitOrderNumber.length <= 32);
  assert.strictEqual(resubmitOrderNumber, buildYeekeResubmitOrderNumber('2000014266367529', 1722337200000));
  assert.deepStrictEqual(extractYeekeOrderRecords({ records: [{ ordersn: 'A' }] }), [{ ordersn: 'A' }]);
  assert.strictEqual(isYeekeOrderReturned({ dgStatus: '7' }), true);
  assert.strictEqual(isYeekeOrderReturned({ dgStatus: '3', returnFlag: '1' }), true);
  assert.strictEqual(isYeekeOrderReturned({ dgStatus: '8', returnFlag: '0' }), false);
  assert.strictEqual(yeekeOrderReturnReason({ messageToUser: '地址异常，仓库退回' }), '地址异常，仓库退回');
  console.log('Yeeke client tests passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
