'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../test-support/fakes');
const { buildAdvancedDashboard } = require('../src/dashboard/advancedDashboard');

// ---- access control + gating ----------------------------------------------

test('advanced dashboard requires auth (401)', async () => {
  assert.equal((await request(makeApp()).get('/api/dashboard/advanced')).status, 401);
});

test('advanced dashboard is gated by dashboard_advanced (403 feature_not_available)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'dashboard_advanced' });
  const res = await request(makeApp({ featureGate }))
    .get('/api/dashboard/advanced')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error, 'feature_not_available');
  assert.equal(res.body.feature, 'dashboard_advanced');
  assert.ok(typeof res.body.message === 'string' && res.body.message.length);
});

test('GET /api/dashboard/advanced returns the widget payload for a viewer (200)', async () => {
  const res = await request(makeApp())
    .get('/api/dashboard/advanced')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.ok(res.body.widgets, 'has widgets');
  const w = res.body.widgets;
  assert.ok(w.probeOutages && Array.isArray(w.probeOutages.recent));
  assert.ok(w.findings && Array.isArray(w.findings.recent));
  // Fleet health + the "needs attention" list moved to the Overview (served by
  // /api/fleet/health); the rollup is purely the events/findings supplement.
  assert.equal(w.fleet, undefined);
  assert.equal(w.attention, undefined);
});

test('advanced dashboard reflects seeded events and findings (200)', async () => {
  const probeOutagesRepo = {
    list: async () => [
      { id: 1, agentId: 7, agentName: 'edge-1', locationName: 'HQ', metric: 'latency', severity: 'critical', status: 'active', startedAt: '2026-06-11T10:00:00.000Z' },
      { id: 2, agentId: 8, agentName: 'edge-2', locationName: 'DC', metric: 'reachability', severity: 'critical', status: 'resolved', startedAt: '2026-06-10T10:00:00.000Z' },
    ],
  };
  const findingStore = {
    list: async () => [
      { id: 'f1', hostId: 'host-a', metric: 'throughput', severity: 'CRIT', kind: 'spike', explanation: 'big drop', createdAt: '2026-06-11T09:00:00.000Z', acked: false },
      { id: 'f2', hostId: 'host-b', metric: 'latency', severity: 'WARN', kind: 'drift', explanation: 'slow', createdAt: '2026-06-11T08:00:00.000Z', acked: true },
    ],
  };
  const res = await request(makeApp({ probeOutagesRepo, findingStore }))
    .get('/api/dashboard/advanced')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.widgets.probeOutages.active, 1); // resolved excluded
  assert.equal(res.body.widgets.probeOutages.recent[0].id, 1);
  assert.equal(res.body.widgets.findings.open, 1); // acked excluded
  assert.equal(res.body.widgets.findings.recent[0].id, 'f1');
});

// ---- pure builder ----------------------------------------------------------

test('buildAdvancedDashboard: empty inputs produce zeroed widgets', () => {
  const out = buildAdvancedDashboard({});
  assert.equal(out.widgets.probeOutages.active, 0);
  assert.deepEqual(out.widgets.probeOutages.recent, []);
  assert.equal(out.widgets.findings.open, 0);
  assert.deepEqual(out.widgets.findings.recent, []);
  assert.ok(out.generatedAt);
});

test('buildAdvancedDashboard: active probe outages are filtered, sorted newest-first and capped', () => {
  const probeOutages = [
    { id: 1, agentId: 1, metric: 'latency', severity: 'warning', status: 'active', startedAt: '2026-06-01T00:00:00.000Z' },
    { id: 2, agentId: 2, metric: 'latency', severity: 'critical', status: 'resolved', startedAt: '2026-06-02T00:00:00.000Z' },
    { id: 3, agentId: 3, metric: 'loss', severity: 'critical', status: 'active', startedAt: '2026-06-03T00:00:00.000Z' },
  ];
  const out = buildAdvancedDashboard({ probeOutages });
  assert.equal(out.widgets.probeOutages.active, 2);
  assert.deepEqual(out.widgets.probeOutages.recent.map((i) => i.id), [3, 1]); // newest first
});

test('buildAdvancedDashboard: only unacknowledged findings are surfaced', () => {
  const findings = [
    { id: 'a', hostId: 'h', metric: 'm', severity: 'CRIT', createdAt: '2026-06-02T00:00:00.000Z', acked: false },
    { id: 'b', hostId: 'h', metric: 'm', severity: 'WARN', createdAt: '2026-06-03T00:00:00.000Z', acked: true },
  ];
  const out = buildAdvancedDashboard({ findings });
  assert.equal(out.widgets.findings.open, 1);
  assert.equal(out.widgets.findings.recent[0].id, 'a');
});

test('buildAdvancedDashboard: only open|investigating event_cases are surfaced, newest activity first', () => {
  const eventCases = [
    { id: 1, deviceId: '9', title: 'A', severity: 'CRIT', status: 'open', lastEventAt: '2026-06-01T00:00:00.000Z' },
    { id: 2, deviceId: '9', title: 'B', severity: 'WARN', status: 'resolved', lastEventAt: '2026-06-05T00:00:00.000Z' },
    { id: 3, deviceId: '7', title: 'C', severity: 'WARN', status: 'investigating', lastEventAt: '2026-06-03T00:00:00.000Z' },
    { id: 4, deviceId: '5', title: 'D', severity: 'INFO', status: 'closed', lastEventAt: '2026-06-04T00:00:00.000Z' },
  ];
  const out = buildAdvancedDashboard({ eventCases });
  assert.equal(out.widgets.eventCases.open, 2); // resolved + closed excluded
  assert.deepEqual(out.widgets.eventCases.recent.map((c) => c.id), [3, 1]); // newest activity first
});

test('buildAdvancedDashboard: event_cases rows carry the device and where it stands', () => {
  const eventCases = [
    { id: 1, hostId: '9', agentName: 'core-sw', locationName: 'Copenhagen HQ', title: 'A', severity: 'CRIT', status: 'open', lastEventAt: '2026-06-01T00:00:00.000Z' },
  ];
  const [row] = buildAdvancedDashboard({ eventCases }).widgets.eventCases.recent;
  assert.equal(row.deviceId, '9'); // read from the repository's `hostId`
  assert.equal(row.agentName, 'core-sw');
  assert.equal(row.locationName, 'Copenhagen HQ');
});

test('advanced dashboard exposes the eventCases widget over HTTP (200)', async () => {
  const eventCasesRepo = { list: async () => [
    { id: 1, deviceId: '9', title: 'CPU on 9', severity: 'CRIT', status: 'investigating', lastEventAt: '2026-06-11T10:00:00.000Z' },
  ] };
  const res = await request(makeApp({ eventCasesRepo }))
    .get('/api/dashboard/advanced')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.widgets.eventCases.open, 1);
  assert.equal(res.body.widgets.eventCases.recent[0].id, 1);
});
