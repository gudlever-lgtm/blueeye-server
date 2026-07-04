'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeDb } = require('../test-support/fakes');

test('GET /health reports tsdb:up when the telemetry store is enabled and healthy', async () => {
  const app = makeApp({
    db: makeDb({ ping: async () => {} }),
    tsdb: { ping: async () => {} },
  });

  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', db: 'up', tsdb: 'up' });
});

test('GET /health returns 503 tsdb:down when the telemetry store is unreachable', async () => {
  const app = makeApp({
    db: makeDb({ ping: async () => {} }),
    tsdb: {
      ping: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
    },
  });

  const res = await request(app).get('/health');

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { status: 'error', db: 'up', tsdb: 'down' });
});

test('GET /health omits tsdb entirely when the telemetry store is disabled', async () => {
  const app = makeApp({ db: makeDb({ ping: async () => {} }) }); // tsdb null

  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', db: 'up' });
  assert.equal(res.body.tsdb, undefined);
});

test('GET /health returns 503 (db down) without touching tsdb', async () => {
  let tsdbPinged = false;
  const app = makeApp({
    db: makeDb({ ping: async () => { throw new Error('mysql down'); } }),
    tsdb: { ping: async () => { tsdbPinged = true; } },
  });

  const res = await request(app).get('/health');

  assert.equal(res.status, 503);
  assert.equal(res.body.db, 'down');
  assert.equal(tsdbPinged, false); // MySQL checked first; short-circuits
});
