'use strict';

const assert=require('node:assert/strict');
const { normalizeOfficialTrackingNumber,trackingLookupProvider,buildExternalTrackingUrl }=require('../order-logistics');

assert.equal(normalizeOfficialTrackingNumber('  J4I\u200bJWABM BHC\ufeffTNQN5VFTUV\ufffd '),'J4IJWABMBHCTNQN5VFTUV');
assert.equal(trackingLookupProvider('MEL Distribution'),'17track');
assert.equal(trackingLookupProvider('CainiaoExpress'),'cainiao');
assert.equal(trackingLookupProvider('Cainiao Express'),'cainiao');
assert.equal(buildExternalTrackingUrl('MEL Distribution','310927815768'),
  'https://www.17track.net/zh-cn?nums=310927815768');
assert.equal(buildExternalTrackingUrl('CainiaoExpress','J4IJWABMBHCTNQN5VFTUV'),
  'https://global.cainiao.com/newDetail.htm?mailNoList=J4IJWABMBHCTNQN5VFTUV');
assert.equal(buildExternalTrackingUrl('J&T Slow','310927815768'),'');

console.log('order logistics routing and tracking-number normalization tests passed');
