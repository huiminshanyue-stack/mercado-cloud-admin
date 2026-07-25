'use strict';

const assert = require('node:assert/strict');
const {
  isFulfillmentFinished,
  shouldCreateNewOrderAlert
} = require('../order-alert-policy');

const now = Date.parse('2026-07-25T10:00:00Z');

assert.equal(isFulfillmentFinished({ orderStatus: 'paid', shipmentStatus: 'delivered' }), true);
assert.equal(isFulfillmentFinished({ orderStatus: 'paid', shipmentStatus: 'shipped' }), true);
assert.equal(isFulfillmentFinished({ orderStatus: 'cancelled', shipmentStatus: 'pending' }), true);
assert.equal(isFulfillmentFinished({ orderStatus: 'paid', shipmentStatus: 'ready_to_ship' }), false);

assert.equal(shouldCreateNewOrderAlert({
  existed: false,
  orderStatus: 'paid',
  shipmentStatus: 'delivered',
  dateCreated: '2026-07-25T09:55:00Z',
  now
}), false);
assert.equal(shouldCreateNewOrderAlert({
  existed: false,
  orderStatus: 'paid',
  shipmentStatus: 'ready_to_ship',
  dateCreated: '2026-06-19T00:21:50Z',
  now
}), false);
assert.equal(shouldCreateNewOrderAlert({
  existed: false,
  orderStatus: 'paid',
  shipmentStatus: 'ready_to_ship',
  dateCreated: '2026-07-25T09:55:00Z',
  now
}), true);
assert.equal(shouldCreateNewOrderAlert({
  existed: true,
  orderStatus: 'paid',
  shipmentStatus: 'ready_to_ship',
  dateCreated: '2026-07-25T09:55:00Z',
  now
}), false);

console.log('order alert policy regression tests passed');
