'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatDeviceLabel, deviceFallback } = require('../deviceLabel');

test('formatDeviceLabel names the agent and the site it stands at', () => {
  assert.equal(
    formatDeviceLabel({ hostId: '1', agentName: 'core-sw', locationName: 'Copenhagen HQ' }),
    'core-sw (Copenhagen HQ)'
  );
});

test('formatDeviceLabel degrades one part at a time', () => {
  // No site set (never mandatory) — the name still places the event.
  assert.equal(formatDeviceLabel({ hostId: '1', agentName: 'core-sw' }), 'core-sw');
  // Agent deleted — the site is still worth stating.
  assert.equal(formatDeviceLabel({ hostId: '1', locationName: 'Aarhus' }), 'device 1 (Aarhus)');
  // Neither — the bare id, the old behaviour.
  assert.equal(formatDeviceLabel({ hostId: '1' }), 'device 1');
});

test('formatDeviceLabel does not invent a device when there is no host', () => {
  assert.equal(formatDeviceLabel({}), 'unknown device');
  assert.equal(formatDeviceLabel({ hostId: '' }), 'unknown device');
  assert.equal(deviceFallback(null), 'unknown device');
});
