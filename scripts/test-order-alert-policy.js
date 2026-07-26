'use strict';

const assert = require('node:assert/strict');
const {
  isFulfillmentFinished,
  isWithinOrderAlertWindow,
  shouldCreateNewOrderAlert,
  shouldCreateCancellationAlert,
  shouldCreateShippedAlert
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
  handlingDeadline: '2026-07-28T09:55:00Z',
  now
}), false);
assert.equal(shouldCreateNewOrderAlert({
  existed: false,
  orderStatus: 'paid',
  shipmentStatus: 'ready_to_ship',
  dateCreated: '2026-06-19T00:21:50Z',
  handlingDeadline: '2026-06-22T00:21:50Z',
  now
}), false);
assert.equal(shouldCreateNewOrderAlert({
  existed: false,
  orderStatus: 'paid',
  shipmentStatus: 'ready_to_ship',
  dateCreated: '2026-07-22T09:55:00Z',
  handlingDeadline: '2026-07-25T09:55:00Z',
  now
}), true);
assert.equal(shouldCreateNewOrderAlert({
  existed: true,
  orderStatus: 'paid',
  shipmentStatus: 'ready_to_ship',
  dateCreated: '2026-07-25T09:55:00Z',
  handlingDeadline: '2026-07-28T09:55:00Z',
  now
}), false);

assert.equal(isWithinOrderAlertWindow({
  dateCreated: '2026-07-21T10:00:00Z',
  handlingDeadline: '2026-07-24T10:00:00Z',
  now: Date.parse('2026-07-25T09:59:59Z')
}), true);
assert.equal(isWithinOrderAlertWindow({
  dateCreated: '2026-07-21T10:00:00Z',
  handlingDeadline: '2026-07-24T10:00:00Z',
  now: Date.parse('2026-07-25T10:00:01Z')
}), false);
assert.equal(shouldCreateCancellationAlert({
  existed: false,
  previousStatus: '',
  orderStatus: 'cancelled',
  shipmentStatus: 'cancelled',
  dateCreated: '2026-06-17T01:18:51Z',
  handlingDeadline: '2026-06-20T01:18:51Z',
  now
}), false);
assert.equal(shouldCreateCancellationAlert({
  existed: true,
  previousStatus: 'paid',
  orderStatus: 'cancelled',
  shipmentStatus: 'cancelled',
  dateCreated: '2026-07-22T09:55:00Z',
  handlingDeadline: '2026-07-25T09:55:00Z',
  now
}), true);

assert.equal(shouldCreateShippedAlert({
  existed:true,previousShipmentStatus:'ready_to_ship',orderStatus:'paid',shipmentStatus:'shipped'
}),true);
assert.equal(shouldCreateShippedAlert({
  existed:true,previousShipmentStatus:'shipped',orderStatus:'paid',shipmentStatus:'shipped'
}),false);
assert.equal(shouldCreateShippedAlert({
  existed:false,previousShipmentStatus:'',orderStatus:'paid',shipmentStatus:'shipped'
}),false);
assert.equal(shouldCreateShippedAlert({
  existed:true,previousShipmentStatus:'ready_to_ship',orderStatus:'cancelled',shipmentStatus:'shipped'
}),false);

console.log('order alert policy regression tests passed');
