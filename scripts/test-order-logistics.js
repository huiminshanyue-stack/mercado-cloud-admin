'use strict';

const assert=require('node:assert/strict');
const zlib=require('node:zlib');
const { normalizeOfficialTrackingNumber,trackingLookupProvider,buildExternalTrackingUrl,
  collectTrackingNumberCandidates,isMelPublicTrackingNumber,chooseOfficialTrackingNumber,
  extractMelTrackingNumberFromPdf,publicOfficialTrackingNumber }=require('../order-logistics');

assert.equal(normalizeOfficialTrackingNumber('  J4I\u200bJWABM BHC\ufeffTNQN5VFTUV\ufffd '),'J4IJWABMBHCTNQN5VFTUV');
assert.equal(trackingLookupProvider('MEL Distribution'),'17track');
assert.equal(trackingLookupProvider('CainiaoExpress'),'cainiao');
assert.equal(trackingLookupProvider('Cainiao Express'),'cainiao');
assert.equal(buildExternalTrackingUrl('MEL Distribution','310927815768'),
  'https://www.17track.net/zh-cn?nums=310927815768');
assert.equal(buildExternalTrackingUrl('CainiaoExpress','J4IJWABMBHCTNQN5VFTUV'),
  'https://global.cainiao.com/newDetail.htm?mailNoList=J4IJWABMBHCTNQN5VFTUV');
assert.equal(buildExternalTrackingUrl('J&T Slow','310927815768'),'');
assert.deepEqual(collectTrackingNumberCandidates({ tracking_number:'INTERNALLETTERS',nested:{ mail_no:'310920988843' } }),
  ['INTERNALLETTERS','310920988843']);
assert.deepEqual(collectTrackingNumberCandidates({ tracking_id:'OPAQUE',nested:{ external_tracking_number:'310920988844' } }),
  ['OPAQUE','310920988844']);
assert.equal(isMelPublicTrackingNumber('310920988843'),true);
assert.equal(isMelPublicTrackingNumber('IQIUSGVLMZHHWMHCNNO'),false);
assert.equal(publicOfficialTrackingNumber('MEL Distribution','IQIUSGVLMZHHWMHCNNO'),'');
assert.equal(publicOfficialTrackingNumber('MEL Distribution','310920988843'),'310920988843');
assert.equal(publicOfficialTrackingNumber('CainiaoExpress','LP00827753088971'),'LP00827753088971');
assert.equal(chooseOfficialTrackingNumber('MEL Distribution',['IQIUSGVLMZHHWMHCNNO','310920988843']),
  '310920988843');
assert.equal(chooseOfficialTrackingNumber('CainiaoExpress',['LP00827753088971','310920988843']),
  'LP00827753088971');
const labelText='Seller 3360150593 Pack ID 2000014158272717 barcode 310920988843';
const fakePdf=Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj<</Filter/FlateDecode>>stream\n','latin1'),
  zlib.deflateSync(Buffer.from(labelText,'latin1')),Buffer.from('\nendstream\nendobj\n%%EOF','latin1')]);
assert.equal(extractMelTrackingNumberFromPdf(fakePdf,['2000014158272717']),'310920988843');

console.log('order logistics routing and tracking-number normalization tests passed');
