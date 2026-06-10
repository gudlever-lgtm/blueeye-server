'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeProbeResultsRepo, makeIncidentsRepo, makeFeatureGate, authHeader } = require('../test-support/fakes');

const FROM = '2026-06-01T00:00:00Z';
const TO = '2026-06-02T00:00:00Z';
const q = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

const availRepo = () => makeProbeResultsRepo({
  availability: async () => [{ locationId: 7, locationName: 'HQ', agentId: 9, agentName: 'edge-1', total: 10, up: 9, down: 1, uptimePct: 90 }],
});
const incRepo = () => makeIncidentsRepo({
  list: async () => [{ id: 3, location_id: 7, location_name: 'HQ', agent_id: 9, agent_name: 'edge-1', metric: 'probe.reachability', severity: 'critical', started_at: FROM, resolved_at: null, duration_seconds: null, affected_target: '8.8.8.8' }],
});

// ---- CSV (reports_csv) -----------------------------------------------------

test('availability.csv returns CSV for viewer (reports_csv)', async () => {
  const res = await request(makeApp({ probeResultsRepo: availRepo() }))
    .get(`/api/reports/availability.csv?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.text, /location_name,agent_name,uptime_pct/);
  assert.match(res.text, /HQ,edge-1,90/);
});

test('incidents.csv returns CSV for viewer (reports_csv)', async () => {
  const res = await request(makeApp({ incidentsRepo: incRepo() }))
    .get(`/api/reports/incidents.csv?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.match(res.text, /probe.reachability/);
  assert.match(res.text, /\(ongoing\)/); // unresolved incident rendered
});

test('CSV export is gated by reports_csv (403)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'reports_csv' });
  const res = await request(makeApp({ featureGate, probeResultsRepo: availRepo() }))
    .get(`/api/reports/availability.csv?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'feature_not_available');
});

// ---- PDF / print-ready HTML (reports_pdf) ----------------------------------

test('availability.html returns print-ready HTML (reports_pdf)', async () => {
  const res = await request(makeApp({ probeResultsRepo: availRepo() }))
    .get(`/api/reports/availability.html?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<table>/);
  assert.match(res.text, /Availability \/ SLA report/);
  assert.match(res.text, /edge-1/);
});

test('HTML export is gated by reports_pdf (403)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'reports_pdf' });
  const res = await request(makeApp({ featureGate, incidentsRepo: incRepo() }))
    .get(`/api/reports/incidents.html?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
  assert.equal(res.body.feature, 'reports_pdf');
});

test('HTML export escapes report data (no markup injection)', async () => {
  const incidentsRepo = makeIncidentsRepo({
    list: async () => [{ id: 1, location_name: '<script>x</script>', agent_name: 'a', metric: 'm', severity: 'warning', started_at: FROM, resolved_at: TO, duration_seconds: 5, affected_target: 't' }],
  });
  const res = await request(makeApp({ incidentsRepo }))
    .get(`/api/reports/incidents.html?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /<script>x<\/script>/);
  assert.match(res.text, /&lt;script&gt;/);
});

// JSON read endpoints stay ungated (Basic reports).
test('availability JSON read is not gated by reports_csv/pdf', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'reports_csv' && f !== 'reports_pdf' });
  const res = await request(makeApp({ featureGate, probeResultsRepo: availRepo() }))
    .get(`/api/reports/availability?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
});
