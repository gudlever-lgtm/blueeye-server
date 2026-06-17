'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const admin = () => authHeader('admin');

// Minimal Nominatim-like search response.
const SEARCH_HIT = { lat: '51.5074', lon: '-0.1278', display_name: 'London, United Kingdom' };
// Minimal Nominatim-like reverse response.
const REVERSE_HIT = { display_name: 'London, United Kingdom', lat: '51.5074', lon: '-0.1278' };

// ---- /api/geocode/search ---------------------------------------------------

test('GET /api/geocode/search requires auth (401 without token)', async () => {
  const res = await request(makeApp()).get('/api/geocode/search?q=London');
  assert.equal(res.status, 401);
});

test('GET /api/geocode/search 400 on missing q', async () => {
  const res = await request(makeApp()).get('/api/geocode/search').set('Authorization', viewer());
  assert.equal(res.status, 400);
  assert.ok(res.body.details && res.body.details.q);
});

test('GET /api/geocode/search 400 on q exceeding 200 chars', async () => {
  const q = 'a'.repeat(201);
  const res = await request(makeApp()).get(`/api/geocode/search?q=${q}`).set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('GET /api/geocode/search 503 when no geocodeUrl configured', async () => {
  const { makeSettingsService } = require('../test-support/fakes');
  const ss = makeSettingsService({ initial: { map: { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', attribution: 'test', maxZoom: 19, geocodeUrl: '' } } });
  const app = makeApp({ settingsService: ss });
  const res = await request(app).get('/api/geocode/search?q=London').set('Authorization', viewer());
  assert.equal(res.status, 503);
  assert.ok(res.body.error);
});

test('GET /api/geocode/search proxies to geocoder and returns results', async () => {
  const geocodeFetch = async () => ({ ok: true, status: 200, json: async () => [SEARCH_HIT] });
  const app = makeApp({ geocodeFetch });
  const res = await request(app).get('/api/geocode/search?q=London').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body[0].display_name, 'London, United Kingdom');
});

test('GET /api/geocode/search returns empty array on geocoder non-ok', async () => {
  const geocodeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const app = makeApp({ geocodeFetch });
  const res = await request(app).get('/api/geocode/search?q=London').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /api/geocode/search 502 when geocoder is unreachable', async () => {
  const geocodeFetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const app = makeApp({ geocodeFetch });
  const res = await request(app).get('/api/geocode/search?q=London').set('Authorization', viewer());
  assert.equal(res.status, 502);
});

test('GET /api/geocode/search accessible to viewer role', async () => {
  const geocodeFetch = async () => ({ ok: true, status: 200, json: async () => [] });
  const app = makeApp({ geocodeFetch });
  const res = await request(app).get('/api/geocode/search?q=test').set('Authorization', viewer());
  assert.equal(res.status, 200);
});

// ---- /api/geocode/reverse --------------------------------------------------

test('GET /api/geocode/reverse requires auth (401 without token)', async () => {
  const res = await request(makeApp()).get('/api/geocode/reverse?lat=51.5&lon=-0.1');
  assert.equal(res.status, 401);
});

test('GET /api/geocode/reverse 400 on missing lat', async () => {
  const res = await request(makeApp()).get('/api/geocode/reverse?lon=-0.1').set('Authorization', viewer());
  assert.equal(res.status, 400);
  assert.ok(res.body.details && res.body.details.lat);
});

test('GET /api/geocode/reverse 400 on missing lon', async () => {
  const res = await request(makeApp()).get('/api/geocode/reverse?lat=51.5').set('Authorization', viewer());
  assert.equal(res.status, 400);
  assert.ok(res.body.details && res.body.details.lon);
});

test('GET /api/geocode/reverse 400 on out-of-range lat', async () => {
  const res = await request(makeApp()).get('/api/geocode/reverse?lat=91&lon=0').set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('GET /api/geocode/reverse 400 on out-of-range lon', async () => {
  const res = await request(makeApp()).get('/api/geocode/reverse?lat=0&lon=181').set('Authorization', viewer());
  assert.equal(res.status, 400);
});

test('GET /api/geocode/reverse 503 when no geocodeUrl configured', async () => {
  const { makeSettingsService } = require('../test-support/fakes');
  const ss = makeSettingsService({ initial: { map: { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', attribution: 'test', maxZoom: 19, geocodeUrl: '' } } });
  const app = makeApp({ settingsService: ss });
  const res = await request(app).get('/api/geocode/reverse?lat=51.5&lon=-0.1').set('Authorization', viewer());
  assert.equal(res.status, 503);
});

test('GET /api/geocode/reverse proxies to geocoder and returns result', async () => {
  const geocodeFetch = async () => ({ ok: true, status: 200, json: async () => REVERSE_HIT });
  const app = makeApp({ geocodeFetch });
  const res = await request(app).get('/api/geocode/reverse?lat=51.5074&lon=-0.1278').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.display_name, 'London, United Kingdom');
});

test('GET /api/geocode/reverse 502 when geocoder is unreachable', async () => {
  const geocodeFetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const app = makeApp({ geocodeFetch });
  const res = await request(app).get('/api/geocode/reverse?lat=51.5&lon=-0.1').set('Authorization', viewer());
  assert.equal(res.status, 502);
});
