'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeProbeResultsRepo, makeIncidentsRepo, makeLocationsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');

const FROM = '2026-06-01T00:00:00Z';
const TO = '2026-06-02T00:00:00Z';
const q = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

// ---- GET /api/reports/availability ----------------------------------------

test('availability requires auth (401)', async () => {
  const res = await request(makeApp()).get(`/api/reports/availability?${q}`);
  assert.equal(res.status, 401);
});

test('availability returns uptime per agent for a valid range (viewer, 200)', async () => {
  const probeResultsRepo = makeProbeResultsRepo({
    availability: async ({ from, to }) => {
      assert.ok(from instanceof Date && to instanceof Date);
      return [{ locationId: 7, locationName: 'HQ', agentId: 9, agentName: 'h1', total: 10, up: 9, down: 1, uptimePct: 90 }];
    },
  });
  const res = await request(makeApp({ probeResultsRepo })).get(`/api/reports/availability?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agents.length, 1);
  assert.equal(res.body.agents[0].uptimePct, 90);
  assert.equal(res.body.from, new Date(FROM).toISOString());
});

test('availability rejects a missing/invalid range (400) and from>=to (400)', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/api/reports/availability').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get('/api/reports/availability?from=nope&to=also').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get(`/api/reports/availability?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`).set('Authorization', authHeader('viewer'))).status, 400);
});

test('availability with an unknown location_id filter is 404', async () => {
  const res = await request(makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) }))
    .get(`/api/reports/availability?${q}&location_id=999`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('availability surfaces a repo failure as 500', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ availability: throwingAsync('db down') });
  const res = await request(makeApp({ probeResultsRepo })).get(`/api/reports/availability?${q}`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

// ---- GET /api/reports/incidents -------------------------------------------

test('incidents lists for a valid range (viewer, 200)', async () => {
  const incidentsRepo = makeIncidentsRepo({
    list: async ({ from, to, severity, locationId }) => {
      assert.ok(from instanceof Date && to instanceof Date);
      assert.equal(severity, 'critical');
      assert.equal(locationId, null);
      return [{ id: 1, severity: 'critical', metric: 'reachability', affectedTarget: 'x', status: 'resolved', durationSeconds: 60 }];
    },
  });
  const res = await request(makeApp({ incidentsRepo })).get(`/api/reports/incidents?${q}&severity=critical`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.incidents.length, 1);
  assert.equal(res.body.incidents[0].durationSeconds, 60);
});

test('incidents rejects an invalid range (400) and an invalid severity (400)', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/api/reports/incidents?from=x&to=y').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get(`/api/reports/incidents?${q}&severity=bogus`).set('Authorization', authHeader('viewer'))).status, 400);
});

test('incidents with an unknown location_id filter is 404', async () => {
  const res = await request(makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) }))
    .get(`/api/reports/incidents?${q}&location_id=999`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ---- GET /api/reports/nis2-draft/:incident_id -----------------------------

const sampleIncident = {
  id: 42, locationId: 7, locationName: 'Aarhus HQ', agentId: 9, agentName: 'fw-01',
  metric: 'reachability', severity: 'critical',
  startedAt: '2026-06-01T08:00:00.000Z', resolvedAt: '2026-06-01T09:30:00.000Z',
  durationSeconds: 5400, affectedTarget: '1.1.1.1', status: 'resolved',
};

test('nis2-draft is operator+ (viewer 403)', async () => {
  const incidentsRepo = makeIncidentsRepo({ findById: async () => sampleIncident });
  const res = await request(makeApp({ incidentsRepo })).get('/api/reports/nis2-draft/42').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('nis2-draft returns an English CFCS draft for a known incident (operator, 200)', async () => {
  const incidentsRepo = makeIncidentsRepo({ findById: async (id) => (id === 42 ? sampleIncident : null) });
  const res = await request(makeApp({ incidentsRepo })).get('/api/reports/nis2-draft/42').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.incidentId, 42);
  assert.match(res.body.draft, /Center for Cybersikkerhed/);
  assert.match(res.body.draft, /Detection time \(UTC\): 2026-06-01T08:00:00\.000Z/);
  assert.match(res.body.draft, /Severity: CRITICAL/);
  assert.match(res.body.draft, /1\.1\.1\.1/);
  assert.match(res.body.draft, /RESOLVED/);
});

test('nis2-draft is 404 for an unknown incident and 400 for a bad id', async () => {
  const incidentsRepo = makeIncidentsRepo({ findById: async () => null });
  assert.equal((await request(makeApp({ incidentsRepo })).get('/api/reports/nis2-draft/999').set('Authorization', authHeader('operator'))).status, 404);
  assert.equal((await request(makeApp()).get('/api/reports/nis2-draft/abc').set('Authorization', authHeader('operator'))).status, 400);
});
