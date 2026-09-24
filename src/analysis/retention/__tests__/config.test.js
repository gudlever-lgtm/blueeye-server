'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadRetentionConfig } = require('../config');
const { validateReportRange } = require('../../../validation/probeOutageValidation');

test('the new retention windows have their documented defaults', () => {
  const c = loadRetentionConfig({});
  assert.equal(c.probeResultRetentionDays, 400);
  assert.equal(c.probeOutageRetentionDays, 400);
  assert.equal(c.speedtestRetentionDays, 365);
  assert.equal(c.transactionResultRetentionDays, 90);
  assert.equal(c.topologyChangeRetentionDays, 180);
  assert.equal(c.discoveredDeviceRetentionDays, 90);
  assert.equal(c.hostConnectionRetentionDays, 30);
  assert.equal(c.auditEventRetentionDays, 365);
  assert.equal(c.internalRollupTopN, 500);
  assert.equal(c.startupDelaySeconds, 120);
});

test('each window is env-configurable', () => {
  const c = loadRetentionConfig({
    RETENTION_PROBE_RESULT_DAYS: '31', RETENTION_AUDIT_EVENT_DAYS: '0', RETENTION_STARTUP_DELAY_SECONDS: '5',
    RETENTION_INTERNAL_ROLLUP_TOP_N: '50',
  });
  assert.equal(c.probeResultRetentionDays, 31);
  assert.equal(c.auditEventRetentionDays, 0);
  assert.equal(c.startupDelaySeconds, 5);
  assert.equal(c.internalRollupTopN, 50);
});

test('probe history outlives the widest availability/outage report the product accepts', () => {
  // The reports compute uptime from probe_results and list probe_outages over a
  // range of up to MAX_RANGE_DAYS; a shorter retention would make a yearly
  // report silently describe only its last weeks.
  const c = loadRetentionConfig({});
  const to = new Date('2026-06-01T00:00:00Z');
  const widest = new Date(to.getTime() - 366 * 864e5);
  const ok = validateReportRange({ from: widest.toISOString(), to: to.toISOString() });
  assert.ok(!ok.errors, 'a 366-day report range is accepted');
  assert.ok(c.probeResultRetentionDays >= 366);
  assert.ok(c.probeOutageRetentionDays >= 366);
});

test('the known-device memory outlives the ARP window it exists to outlast (400 days, env-configurable)', () => {
  // arp_entries forgets a MAC after RETENTION_ARP_DAYS; the new-device
  // detector's memory must remember it far longer, or a device back from a
  // month away is "new" again.
  const c = loadRetentionConfig({});
  assert.equal(c.knownDeviceRetentionDays, 400);
  assert.ok(c.knownDeviceRetentionDays > c.arpRetentionDays);
  assert.equal(loadRetentionConfig({ RETENTION_KNOWN_DEVICE_DAYS: '800' }).knownDeviceRetentionDays, 800);
});

test('transaction results outlive the longest trend the API serves (90 days)', () => {
  assert.ok(loadRetentionConfig({}).transactionResultRetentionDays >= 90);
});
