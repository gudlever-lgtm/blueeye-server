'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAlertChannels } = require('../channelRegistry');
const { loadAlertingConfig } = require('../config');

test('createAlertChannels builds the email/webhook/syslog plugins from config', () => {
  const channels = createAlertChannels({ alertingConfig: loadAlertingConfig({}) });
  assert.deepEqual(Object.keys(channels).sort(), ['email', 'syslog', 'webhook']);
  for (const name of ['email', 'webhook', 'syslog']) {
    assert.equal(channels[name].name, name, `${name} plugin self-identifies`);
    assert.equal(typeof channels[name].send, 'function', `${name} implements send()`);
  }
});

test('every plugin send() honours the shared { ok } result contract', async () => {
  // Unconfigured channels must fail cleanly (ok:false) rather than throw — and
  // never hit the network/SMTP — so the interface is uniform across plugins.
  const channels = createAlertChannels({ alertingConfig: loadAlertingConfig({}) });
  for (const name of ['email', 'webhook', 'syslog']) {
    const r = await channels[name].send({ hostId: '9', metric: 'cpu', severity: 'INFO' }, null);
    assert.equal(typeof r.ok, 'boolean', `${name} returns a boolean ok`);
    assert.equal(r.ok, false, `${name} is unconfigured here, so reports ok:false`);
  }
});
