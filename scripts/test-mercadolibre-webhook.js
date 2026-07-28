'use strict';

const assert=require('node:assert/strict');
const {
  SUPPORTED_TOPICS,
  TOPIC_ALIASES,
  CALLBACK_ACK_DEADLINE_MS,
  normalizeMercadoLibreNotification,
  rejectionReason,
  resourceId,
  retryDelaySeconds
}=require('../mercadolibre-webhook');

assert.equal(TOPIC_ALIASES.marketplace_orders,'orders_v2');
assert.equal(SUPPORTED_TOPICS.has('marketplace_claims'),true);
assert.equal(CALLBACK_ACK_DEADLINE_MS,350);
assert.equal(resourceId('/orders/123456789?caller.id=1'),'123456789');
assert.equal(resourceId('/post-purchase/v1/claims/987654321'),'987654321');

const payload={
  _id:'notification-1',
  topic:'orders_v2',
  resource:'/orders/123456789',
  user_id:3361645256,
  application_id:7654321,
  attempts:1,
  sent:'2026-07-25T02:00:00.000Z'
};
const event=normalizeMercadoLibreNotification(payload,'7654321');
assert.equal(event.topic,'orders_v2');
assert.equal(event.officialTopic,'orders_v2');
assert.equal(event.resourceId,'123456789');
assert.equal(event.userId,'3361645256');
assert.equal(event.applicationId,'7654321');
assert.equal(event.eventKey,normalizeMercadoLibreNotification({ ...payload,attempts:5 },'7654321').eventKey);
const questionEvent=normalizeMercadoLibreNotification({ ...payload,_id:'question-1',topic:'questions',resource:'/questions/99887766' },'7654321');
assert.equal(questionEvent.topic,'questions');
assert.equal(questionEvent.resourceId,'99887766');
const globalOrderEvent=normalizeMercadoLibreNotification({ ...payload,_id:'marketplace-order-1',topic:'marketplace_orders',resource:'/marketplace/orders/123456789' },'7654321');
assert.equal(globalOrderEvent.topic,'orders_v2');
assert.equal(globalOrderEvent.officialTopic,'marketplace_orders');
assert.equal(globalOrderEvent.resourceId,'123456789');
const globalClaimEvent=normalizeMercadoLibreNotification({ ...payload,_id:'marketplace-claim-1',topic:'marketplace_claims',resource:'/marketplace/v2/claims/99887766' },'7654321');
assert.equal(globalClaimEvent.topic,'claims');
assert.equal(normalizeMercadoLibreNotification({ ...payload,application_id:999 },'7654321'),null);
assert.equal(normalizeMercadoLibreNotification({ ...payload,application_id:'' },'7654321'),null);
assert.equal(normalizeMercadoLibreNotification({ ...payload,topic:'unsupported' },'7654321'),null);
assert.equal(normalizeMercadoLibreNotification({ ...payload,resource:'' },'7654321'),null);
assert.equal(rejectionReason({ ...payload,application_id:999 },'7654321'),'application_id_mismatch');
assert.equal(rejectionReason({ ...payload,topic:'items' },'7654321'),'unsupported_topic:items');
assert.equal(rejectionReason({ ...payload,resource:'' },'7654321'),'missing_resource');

assert.equal(retryDelaySeconds(1),15);
assert.equal(retryDelaySeconds(2),60);
assert.equal(retryDelaySeconds(8),14400);
assert.equal(retryDelaySeconds(99),14400);

console.log('mercadolibre webhook normalization and retry tests passed');
