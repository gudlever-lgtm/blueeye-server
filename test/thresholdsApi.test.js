'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeProbeThresholdsRepo, makeLocationsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');

const withLocation = (overrides = {}) => makeApp({ locationsRepo: makeLocationsRepo({ findById: async (id) => ({ id, name: 'HQ' }) }), ...overrides });

// ---- GET /api/thresholds (global) -----------------------------------------

test('GET /api/thresholds returns the global defaults (viewer, 200)', async () => {
  const res = await request(makeApp()).get('/api/thresholds').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, 'global');
  const metrics = res.body.thresholds.map((t) => t.metric).sort();
  assert.deepEqual(metrics, ['latency', 'packet_loss', 'reachability']);
});

test('GET /api/thresholds requires auth (401)', async () => {
  assert.equal((await request(makeApp()).get('/api/thresholds')).status, 401);
});

// ---- PUT /api/thresholds (global) -----------------------------------------

test('PUT /api/thresholds upserts a global threshold (admin, 200)', async () => {
  const thresholdsRepo = makeProbeThresholdsRepo();
  const res = await request(makeApp({ thresholdsRepo })).put('/api/thresholds')
    .set('Authorization', authHeader('admin'))
    .send({ metric: 'latency', warning_value: 100, critical_value: 250, debounce_count: 5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.threshold.warning_value, 100);
  assert.equal(res.body.threshold.debounce_count, 5);
  assert.equal(res.body.threshold.location_id, null);
});

test('PUT /api/thresholds is admin-only (403 viewer + operator)', async () => {
  for (const role of ['viewer', 'operator']) {
    const res = await request(makeApp()).put('/api/thresholds').set('Authorization', authHeader(role)).send({ metric: 'latency', warning_value: 1, critical_value: 2 });
    assert.equal(res.status, 403, role);
  }
});

test('PUT /api/thresholds rejects an invalid metric and crit<warn (400)', async () => {
  const app = makeApp();
  assert.equal((await request(app).put('/api/thresholds').set('Authorization', authHeader('admin')).send({ metric: 'bogus' })).status, 400);
  assert.equal((await request(app).put('/api/thresholds').set('Authorization', authHeader('admin')).send({ metric: 'latency', warning_value: 300, critical_value: 100 })).status, 400);
});

// ---- GET /api/thresholds/:location_id (effective) -------------------------

test('GET /api/thresholds/:location_id returns the effective per-metric thresholds (viewer, 200)', async () => {
  const res = await request(withLocation()).get('/api/thresholds/7').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.locationId, 7);
  assert.equal(res.body.thresholds.length, 3);
  // All fall back to global when no override exists.
  assert.ok(res.body.thresholds.every((t) => t.source === 'global'));
});

test('GET /api/thresholds/:location_id is 404 for an unknown location and 400 for a bad id', async () => {
  assert.equal((await request(makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) })).get('/api/thresholds/999').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(makeApp()).get('/api/thresholds/abc').set('Authorization', authHeader('viewer'))).status, 400);
});

// ---- PUT /api/thresholds/:location_id (override) --------------------------

test('PUT /api/thresholds/:location_id upserts a location override (admin, 200)', async () => {
  const thresholdsRepo = makeProbeThresholdsRepo();
  const res = await request(withLocation({ thresholdsRepo })).put('/api/thresholds/7')
    .set('Authorization', authHeader('admin'))
    .send({ metric: 'packet_loss', warning_value: 1, critical_value: 3, debounce_count: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.threshold.location_id, 7);
  assert.equal(res.body.threshold.metric, 'packet_loss');
  // And it now wins over the global default for that location.
  const eff = await thresholdsRepo.getEffective(7, 'packet_loss');
  assert.equal(eff.warning_value, 1);
});

test('PUT /api/thresholds/:location_id is admin-only (403 viewer) and 404 unknown location', async () => {
  assert.equal((await request(withLocation()).put('/api/thresholds/7').set('Authorization', authHeader('viewer')).send({ metric: 'latency', warning_value: 1, critical_value: 2 })).status, 403);
  const unknown = makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) });
  assert.equal((await request(unknown).put('/api/thresholds/999').set('Authorization', authHeader('admin')).send({ metric: 'latency', warning_value: 1, critical_value: 2 })).status, 404);
});

// ---- DELETE /api/thresholds[/:location_id]?metric= -------------------------
// The settings panel removes a threshold: a location override falls back to
// the global default, and a global default removed means the metric is not
// evaluated at all (no probe outage opens for it).

test('DELETE /api/thresholds?metric= removes a global default (admin, 200) and 404s the second time', async () => {
  const thresholdsRepo = makeProbeThresholdsRepo();
  const app = makeApp({ thresholdsRepo });
  const res = await request(app).delete('/api/thresholds?metric=latency').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.removed, { scope: 'global', metric: 'latency' });
  assert.ok(!thresholdsRepo.rows.some((r) => r.location_id == null && r.metric === 'latency'));
  const again = await request(app).delete('/api/thresholds?metric=latency').set('Authorization', authHeader('admin'));
  assert.equal(again.status, 404);
});

test('DELETE /api/thresholds validates the metric (400) and is admin-only (401/403)', async () => {
  const app = makeApp();
  assert.equal((await request(app).delete('/api/thresholds?metric=cpu').set('Authorization', authHeader('admin'))).status, 400);
  assert.equal((await request(app).delete('/api/thresholds').set('Authorization', authHeader('admin'))).status, 400);
  assert.equal((await request(app).delete('/api/thresholds?metric=latency')).status, 401);
  for (const role of ['viewer', 'operator']) {
    assert.equal((await request(app).delete('/api/thresholds?metric=latency').set('Authorization', authHeader(role))).status, 403, role);
  }
});

test('DELETE /api/thresholds/:location_id?metric= removes only the override; the global default stays', async () => {
  const thresholdsRepo = makeProbeThresholdsRepo();
  thresholdsRepo.rows.push({ id: 50, location_id: 7, metric: 'latency', warning_value: 10, critical_value: 20, debounce_count: 2 });
  const app = withLocation({ thresholdsRepo });
  const res = await request(app).delete('/api/thresholds/7?metric=latency').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.removed, { scope: 'location', locationId: 7, metric: 'latency' });
  assert.ok(thresholdsRepo.rows.some((r) => r.location_id == null && r.metric === 'latency'), 'global default kept');
  // Nothing left to remove for that location.
  assert.equal((await request(app).delete('/api/thresholds/7?metric=latency').set('Authorization', authHeader('admin'))).status, 404);
});

test('DELETE /api/thresholds/:location_id: 400 bad id / metric, 404 unknown location, 403 viewer, 500 on DB failure', async () => {
  const app = withLocation();
  assert.equal((await request(app).delete('/api/thresholds/abc?metric=latency').set('Authorization', authHeader('admin'))).status, 400);
  assert.equal((await request(app).delete('/api/thresholds/7?metric=nope').set('Authorization', authHeader('admin'))).status, 400);
  assert.equal((await request(app).delete('/api/thresholds/7?metric=latency').set('Authorization', authHeader('viewer'))).status, 403);
  const unknown = makeApp({ locationsRepo: makeLocationsRepo({ findById: async () => null }) });
  assert.equal((await request(unknown).delete('/api/thresholds/999?metric=latency').set('Authorization', authHeader('admin'))).status, 404);
  const broken = withLocation({ thresholdsRepo: makeProbeThresholdsRepo({ remove: throwingAsync() }) });
  const res = await request(broken).delete('/api/thresholds/7?metric=latency').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 500);
});
