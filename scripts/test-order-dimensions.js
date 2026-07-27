'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { snapshotDeclaredValue,snapshotVerifiedValue,snapshotListingValue,
  snapshotBillableWeight,dimensionSnapshotsDiffer,normalizeBillableWeight,
  normalizeDimensionSnapshotWeights }=require('../order-dimensions');

const declared={ length:20,width:12,height:15,weight:734,dimensionUnit:'cm',weightUnit:'g' };
const verified={ length:12,width:15,height:20,weight:606,dimensionUnit:'cm',weightUnit:'g' };
const listing={ length:20,width:12,height:15,weight:734,dimensionUnit:'cm',weightUnit:'g' };
const original={ available:true,orderRecorded:declared,package:{ dimensions:verified },items:[{ orderDimensions:declared,listingDimensions:listing }] };
const latest={ available:true,package:{ dimensions:verified },items:[{ listingDimensions:listing,billableWeight:{ weight:734,weightUnit:'g' } }] };

assert.deepEqual(snapshotDeclaredValue(original),declared);
assert.deepEqual(snapshotVerifiedValue(latest),verified);
assert.deepEqual(snapshotListingValue(latest),listing);
assert.deepEqual(snapshotBillableWeight(latest),{ weight:734,weightUnit:'g' });
assert.deepEqual(snapshotListingValue({ items:[{ billableWeight:{ weight:223,weightUnit:'g' } }] }),
  { weight:223,weightUnit:'g' },'美客多仅返回计费重量时，平台返回值不能显示为未返回');
assert.equal(dimensionSnapshotsDiffer(original,latest),true);
assert.equal(dimensionSnapshotsDiffer(original,{ package:{ dimensions:{ ...declared,length:12,width:15,height:20 } } }),false,
  '长宽高顺序变化但三边与重量相同，不应误判为平台修改');
assert.equal(dimensionSnapshotsDiffer(original,{ items:[{ listingDimensions:listing }] }),false,
  '商品当前刊登值不能冒充订单包裹核验值');

const corrected=normalizeBillableWeight({ weight:490,weightUnit:'kg',source:'shipping_options.cost.billable_weight' },[
  { weight:458,weightUnit:'g' }
]);
assert.deepEqual({ weight:corrected.weight,weightUnit:corrected.weightUnit,unitScaleCorrected:corrected.unitScaleCorrected },
  { weight:490,weightUnit:'g',unitScaleCorrected:true },
  '同一订单中与 458g 参考值吻合的千倍单位异常应校正为 490g');
assert.equal(normalizeBillableWeight({ weight:490,weightUnit:'kg' },[{ weight:458,weightUnit:'kg' }]).weight,490,
  '真实大件货物的千克数值不得误改');
const cached=normalizeDimensionSnapshotWeights({
  available:true,
  verifiedPackage:{ weight:458,weightUnit:'g' },
  billableWeight:{ weight:490000,weightUnit:'g' },
  platformReturned:{ weight:490000,weightUnit:'g',platformWeightOnly:true },
  items:[{ billableWeight:{ weight:490000,weightUnit:'g' } }]
});
assert.equal(cached.billableWeight.weight,490);
assert.equal(cached.platformReturned.weight,490);
assert.equal(cached.items[0].billableWeight.weight,490);

const serverSource=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const itemDimensionsSource=serverSource.match(/function itemDimensions\(item\) \{[\s\S]*?\n\}/)?.[0] || '';
const snapshotSource=serverSource.match(/function buildOrderDimensionSnapshot\(shipments, items\) \{[\s\S]*?\n\}/)?.[0] || '';
assert.ok(!itemDimensionsSource.includes('itemRecords'),
  'itemDimensions must not access the order-level itemRecords collection');
assert.ok(snapshotSource.includes('const currentListing = itemRecords.find') &&
  snapshotSource.includes('const billableWeight = itemRecords.find'),
  'order dimension snapshot must derive current listing and billable weight after itemRecords is built');

console.log('order dimension source and comparison tests passed');
