const assert = require('assert');
const {
  SHOPEEX_LOGISTICS_CATALOG_SIZE,
  findShopeexLogisticsByCode,
  findShopeexLogisticsByName,
  resolveShopeexLogisticsCode,
  listShopeexLogisticsCatalog
} = require('../shopeex-logistics');

assert.strictEqual(SHOPEEX_LOGISTICS_CATALOG_SIZE,1182);
assert.strictEqual(listShopeexLogisticsCatalog().length,1182);
for (const [name,code] of Object.entries({
  '顺丰速运':'541','中通快递':'371','圆通速递':'285','申通快递':'435','韵达快递':'222',
  '极兔速递':'862','京东物流':'440','EMS':'372','邮政快递包裹':'141','邮政标准快递':'517',
  '德邦快递':'1014','安能物流':'433','跨越速运':'274','丹鸟（菜鸟速递）':'994'
})) {
  assert.strictEqual(findShopeexLogisticsByName(name)?.code,code,`${name} must map to ${code}`);
  assert.strictEqual(findShopeexLogisticsByCode(code)?.name,name,`${code} must map to ${name}`);
}
assert.strictEqual(resolveShopeexLogisticsCode('邮政EMS'),'372');
assert.strictEqual(resolveShopeexLogisticsCode('菜鸟物流'),'994');
assert.strictEqual(resolveShopeexLogisticsCode('顺丰速运','future-code'),'future-code','an explicit future code must be preserved');
assert.strictEqual(findShopeexLogisticsByName('盛丰物流'),null,'ambiguous duplicate names must not be guessed');

console.log('Shopeex logistics catalog tests passed');
