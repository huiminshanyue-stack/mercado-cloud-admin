'use strict';

const assert=require('node:assert/strict');
const {
  SUPPORTED_TOPICS,
  normalizeMercadoLibreNotification,
  resourceId,
  retryDelaySeconds
}=require('../mercadolibre-webhook');

assert.deepEqual([...SUPPORTED_TOPICS],['orders_v2','shipments','messages','claims']);
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
assert.equal(event.resourceId,'123456789');
assert.equal(event.userId,'3361645256');
assert.equal(event.applicationId,'7654321');
assert.equal(event.eventKey,normalizeMercadoLibreNotification({ ...payload,attempts:5 },'7654321').eventKey);
assert.equal(normalizeMercadoLibreNotification({ ...payload,application_id:999 },'7654321'),null);
assert.equal(normalizeMercadoLibreNotification({ ...payload,application_id:'' },'7654321'),null);
assert.equal(normalizeMercadoLibreNotification({ ...payload,topic:'unsupported' },'7654321'),null);
assert.equal(normalizeMercadoLibreNotification({ ...payload,resource:'' },'7654321'),null);

assert.equal(retryDelaySeconds(1),15);
assert.equal(retryDelaySeconds(2),60);
assert.equal(retryDelaySeconds(8),14400);
assert.equal(retryDelaySeconds(99),14400);

console.log('mercadolibre webhook normalization and retry tests passed');
