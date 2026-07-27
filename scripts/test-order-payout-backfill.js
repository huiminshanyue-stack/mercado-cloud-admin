'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const payout = fs.readFileSync(path.join(root, 'order-payout.js'), 'utf8');

assert.match(server, /finance_last_attempt_at TIMESTAMPTZ/);
assert.match(server, /finance_attempt_count INTEGER NOT NULL DEFAULT 0/);
assert.match(server, /official_billing_detail_pending/);
assert.match(server, /WHEN finance_attempt_count < 3 THEN INTERVAL '2 minutes'/);
assert.match(server, /WHEN finance_attempt_count < 12 THEN INTERVAL '10 minutes'/);
assert.match(server, /ELSE INTERVAL '1 hour'/);
assert.match(server, /queuePendingOfficialPayoutBackfill\(\s*authUser,String\(authorization\.ml_user_id\),accessToken/);
assert.match(server, /billing\/integration\/group\/ML\/order\/details/);
assert.match(server, /resolveOfficialOrderPayout\(\{/);
assert.match(payout, /LOCKED_PAYOUT_EXAMPLE/);
assert.match(payout, /assertLockedPayoutInvariant/);

console.log('order payout automatic backfill tests passed');
