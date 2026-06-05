'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');

// ---- GET /api/settings (admin overview) -----------------------------------
test('GET /api/settings returns the effective configuration for an admin', async () => {
  const res = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.ok(res.body.license && typeof res.body.license === 'object');
  assert.ok(res.body.analysis && 'critSigma' in res.body.analysis);
  assert.ok(res.body.alerting);
  assert.ok(res.body.retention);
  assert.ok(res.body.map.tileUrl.includes('{z}'));
  // No secrets leaked.
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('api_key'));
});

test('GET /api/settings is admin-only (viewer 403, no token 401)', async () => {
  assert.equal((await request(makeApp()).get('/api/settings').set('Authorization', viewer())).status, 403);
  assert.equal((await request(makeApp()).get('/api/settings')).status, 401);
});

// ---- PUT /api/settings/map -------------------------------------------------
test('PUT /api/settings/map updates the tile source and /api/map/config reflects it', async () => {
  const app = makeApp(); // one app instance so the in-memory store persists across requests
  const put = await request(app).put('/api/settings/map').set('Authorization', admin())
    .send({ tileUrl: 'https://eu.tiles.local/{z}/{x}/{y}.png', maxZoom: 17 });
  assert.equal(put.status, 200);
  assert.equal(put.body.map.tileUrl, 'https://eu.tiles.local/{z}/{x}/{y}.png');
  assert.equal(put.body.map.maxZoom, 17);

  const cfg = await request(app).get('/api/map/config').set('Authorization', viewer());
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.tileUrl, 'https://eu.tiles.local/{z}/{x}/{y}.png');
  assert.equal(cfg.body.maxZoom, 17);
});

test('PUT /api/settings/map rejects an invalid tile URL with 400 + details', async () => {
  const res = await request(makeApp()).put('/api/settings/map').set('Authorization', admin())
    .send({ tileUrl: 'http://no-placeholders.example/' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details && res.body.details.tileUrl);
});

test('PUT /api/settings/map is admin-only (viewer 403)', async () => {
  const res = await request(makeApp()).put('/api/settings/map').set('Authorization', viewer()).send({ maxZoom: 10 });
  assert.equal(res.status, 403);
});

// ---- GET /api/map/config (ungated, viewer+) -------------------------------
test('GET /api/map/config is available to viewers and includes the geocoder URL', async () => {
  const res = await request(makeApp()).get('/api/map/config').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(res.body.tileUrl.includes('{z}'));
  assert.ok(typeof res.body.geocodeUrl === 'string');
});

test('GET /api/map/config without a token returns 401', async () => {
  assert.equal((await request(makeApp()).get('/api/map/config')).status, 401);
});

// ---- PUT /api/settings/throughput (speed-test health thresholds) -----------
test('PUT /api/settings/throughput saves thresholds and GET reflects them (admin)', async () => {
  const app = makeApp();
  const put = await request(app).put('/api/settings/throughput').set('Authorization', admin()).send({ enabled: true, downBadMbps: 50, downWarnMbps: 100 });
  assert.equal(put.status, 200);
  assert.equal(put.body.throughput.enabled, true);
  assert.equal(put.body.throughput.downBadMbps, 50);
  const get = await request(app).get('/api/settings').set('Authorization', admin());
  assert.equal(get.body.throughput.enabled, true);
  assert.equal(get.body.throughput.downBadMbps, 50);
});

test('PUT /api/settings/throughput rejects a negative threshold (400)', async () => {
  const res = await request(makeApp()).put('/api/settings/throughput').set('Authorization', admin()).send({ downBadMbps: -5 });
  assert.equal(res.status, 400);
});

test('PUT /api/settings/throughput is admin-only (viewer 403)', async () => {
  const res = await request(makeApp()).put('/api/settings/throughput').set('Authorization', viewer()).send({ enabled: true });
  assert.equal(res.status, 403);
});

test('GET /api/settings includes throughput defaults (disabled)', async () => {
  const res = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.ok(res.body.throughput && res.body.throughput.enabled === false);
});
