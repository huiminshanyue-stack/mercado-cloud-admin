'use strict';

const assert=require('node:assert/strict');
const { snapshotDeclaredValue,snapshotVerifiedValue,snapshotListingValue,
  snapshotBillableWeight,dimensionSnapshotsDiffer }=require('../order-dimensions');

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

console.log('order dimension source and comparison tests passed');
