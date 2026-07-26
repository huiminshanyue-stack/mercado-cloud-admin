const assert = require('assert');
const { normalizeOrderItems,translateColorName } = require('../order-items');

const officialItems = [
  {
    quantity: 1,
    item: {
      id: 'MLM2930891871', seller_sku: '723665712-PINK', variation_id: 'pink-variation',
      variation_attributes: [{ id: 'COLOR', name: 'Color', value_name: 'Rosa' }]
    }
  },
  {
    quantity: 1,
    item: {
      id: 'MLM2930891871', seller_sku: '723665712-BLACK', variation_id: 'black-variation',
      variation_attributes: [{ id: 'COLOR', name: 'Color', value_name: 'Black' }]
    }
  }
];

const normalized = normalizeOrderItems(officialItems);
assert.strictEqual(normalized.length, 2, 'must preserve every official order line');
assert.deepStrictEqual(normalized.map(item => item.quantity), [1, 1]);
assert.deepStrictEqual(normalized.map(item => item.item.seller_sku), ['723665712-PINK', '723665712-BLACK']);
assert.deepStrictEqual(normalized.map(item => item.item.colorNameZh), ['粉色', '黑色']);
assert.deepStrictEqual(normalized.map(item => item.item.colorOriginal), ['Rosa', 'Black']);
assert.strictEqual(translateColorName('Azul marino'), '藏青色');
assert.strictEqual(translateColorName('Rosa / Negro'), '粉色 / 黑色');

const fallback = normalizeOrderItems([{ quantity: 2,item:{ id:'MLC1',variation_id:88 } }], new Map([['MLC1',{
  variations:[{ id:88,attribute_combinations:[{ id:'COLOR',value_name:'Rojo' }] }]
}]]));
assert.strictEqual(fallback[0].item.colorNameZh, '红色');
assert.strictEqual(fallback[0].quantity, 2);

console.log('order item normalization tests passed');
