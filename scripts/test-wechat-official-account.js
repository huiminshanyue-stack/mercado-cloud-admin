'use strict';

const assert=require('node:assert/strict');
const crypto=require('crypto');
const {
  DEFAULT_OFFICIAL_APP_ID,EVENT_TYPES,OFFICIAL_TEMPLATE_PRESETS,sha1Signature,parseWeChatXml,decryptWeChatMessage,
  preferenceColumn,retryDelaySeconds,renderTemplateData
}=require('../wechat-official-account');

assert.equal(DEFAULT_OFFICIAL_APP_ID,'wx1758849125581a06');
assert.deepEqual(EVENT_TYPES,['new_order','cancelled','deadline','refund','shipped','buyer_inquiry','after_sales','binding_success']);
assert.equal(sha1Signature(['token','123','nonce']),sha1Signature(['nonce','token','123']));
assert.equal(preferenceColumn('buyer_inquiry'),'buyer_inquiry_enabled');
assert.equal(preferenceColumn('shipped'),'shipped_enabled');
assert.equal(preferenceColumn('binding_success'),'binding_success_enabled');
assert.equal(retryDelaySeconds(1),15);
assert.equal(retryDelaySeconds(8),14400);
assert.equal(OFFICIAL_TEMPLATE_PRESETS.deadline.title,'订单物流异常通知');
assert.equal(OFFICIAL_TEMPLATE_PRESETS.buyer_inquiry.dataMapping.phrase5.source,'notificationStatus');
assert.equal(OFFICIAL_TEMPLATE_PRESETS.binding_success.pagePath,'pages/home/index');

const xml=`<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[o_user]]></FromUserName>
  <CreateTime>1720000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event>
  <EventKey><![CDATA[qrscene_bind_1]]></EventKey></xml>`;
const parsed=parseWeChatXml(xml);
assert.equal(parsed.FromUserName,'o_user');
assert.equal(parsed.Event,'subscribe');
assert.equal(parsed.EventKey,'qrscene_bind_1');

function pkcs7(buffer) {
  const padding=32-(buffer.length%32 || 32);
  const size=padding===0 ? 32 : padding;
  return Buffer.concat([buffer,Buffer.alloc(size,size)]);
}
function encryptMessage(message,key,appId) {
  const xmlBuffer=Buffer.from(message),length=Buffer.alloc(4);
  length.writeUInt32BE(xmlBuffer.length);
  const plain=pkcs7(Buffer.concat([Buffer.alloc(16,7),length,xmlBuffer,Buffer.from(appId)]));
  const cipher=crypto.createCipheriv('aes-256-cbc',key,key.subarray(0,16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain),cipher.final()]).toString('base64');
}
const aesKey=crypto.randomBytes(32),encodingKey=aesKey.toString('base64').replace(/=$/,'');
const encrypted=encryptMessage(xml,aesKey,DEFAULT_OFFICIAL_APP_ID);
assert.equal(decryptWeChatMessage(encrypted,encodingKey,DEFAULT_OFFICIAL_APP_ID),xml);
assert.throws(()=>decryptWeChatMessage(encrypted,encodingKey,'wrong-app'));

const template=renderTemplateData({
  thing1:{ source:'title',maxLength:8,color:'#409EFF' },
  character_string2:'orderNumber',
  thing3:'订单 {{orderNumber}} · {{storeName}}'
},{ title:'收到一个新的订单提醒',orderNumber:'2000012345678',storeName:'巴西主店' });
assert.equal(template.thing1.value,'收到一个新的订单');
assert.equal(template.thing1.color,'#409EFF');
assert.equal(template.character_string2.value,'2000012345678');
assert.equal(template.thing3.value,'订单 2000012345678 · 巴西主店');

console.log('wechat official account signature, XML, AES and template tests passed');
