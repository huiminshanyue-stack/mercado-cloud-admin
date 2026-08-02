const assert = require('assert');
const { hasStockAllocations,resolveFulfillmentModeRequest } = require('../fulfillment-mode-policy');

assert.deepStrictEqual(resolveFulfillmentModeRequest({}),{
  fulfillmentMode:'express',stockModeConfirmed:false,stockByOrder:{}
});
assert.deepStrictEqual(resolveFulfillmentModeRequest({ fulfillmentMode:'express',stockModeConfirmed:false }),{
  fulfillmentMode:'express',stockModeConfirmed:false,stockByOrder:{}
});
assert.throws(() => resolveFulfillmentModeRequest({ fulfillmentMode:'stock' }),/必须由用户/);
assert.throws(() => resolveFulfillmentModeRequest({ fulfillmentMode:'invalid' }),/发货方式无效/);
assert.throws(() => resolveFulfillmentModeRequest({
  fulfillmentMode:'express',stockByOrder:{ ORDER1:[{ remoteProductId:'P1',quantity:1 }] }
}),/不能携带库存商品/);

const confirmedStock = resolveFulfillmentModeRequest({
  fulfillmentMode:'stock',stockModeConfirmed:true,
  stockByOrder:{ ORDER1:[{ remoteProductId:'P1',quantity:1 }] }
});
assert.strictEqual(confirmedStock.fulfillmentMode,'stock');
assert.strictEqual(confirmedStock.stockModeConfirmed,true);
assert.strictEqual(confirmedStock.stockByOrder.ORDER1[0].remoteProductId,'P1');
assert.strictEqual(hasStockAllocations(confirmedStock.stockByOrder),true);
assert.strictEqual(hasStockAllocations({ ORDER1:[] }),false);

console.log('Fulfillment mode policy tests passed');
