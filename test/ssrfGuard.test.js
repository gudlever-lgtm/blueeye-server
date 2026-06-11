'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isBlockedHost, baseUrlBlockedReason } = require('../src/integrations/ssrfGuard');

test('blocks loopback, private, link-local and localhost', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', 'fd12::3']) {
    assert.equal(isBlockedHost(h), true, `${h} should be blocked`);
  }
});

test('allows public hosts and addresses', () => {
  for (const h of ['nautobot.acme.dk', 'acme.service-now.com', '8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) {
    assert.equal(isBlockedHost(h), false, `${h} should be allowed`);
  }
});

test('baseUrlBlockedReason flags internal URLs and accepts public ones', () => {
  assert.ok(baseUrlBlockedReason('http://169.254.169.254/latest/meta-data/'));
  assert.ok(baseUrlBlockedReason('https://127.0.0.1:8080/x'));
  assert.ok(baseUrlBlockedReason('https://localhost/x'));
  assert.equal(baseUrlBlockedReason('https://nb.acme.dk/api'), null);
  assert.ok(baseUrlBlockedReason('not a url'));
});
