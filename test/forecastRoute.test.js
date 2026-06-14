'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../test-support/fakes');

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const series = (n, perDay = 5) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, v: 100 + i * perDay }));

test('POST /api/forecast requires auth (401)', async () => {
  assert.equal((await request(makeApp()).post('/api/forecast').send({ points: series(6) })).status, 401);
});

test('POST /api/forecast returns a projection for a valid series', async () => {
  const res = await request(makeApp())
    .post('/api/forecast')
    .set('Authorization', authHeader('viewer'))
    .send({ points: series(8), capacity: 200, horizonDays: 10 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.direction, 'rising');
  assert.ok(res.body.explanation.length > 0);
});

test('POST /api/forecast 400s on a non-array points payload', async () => {
  const res = await request(makeApp())
    .post('/api/forecast')
    .set('Authorization', authHeader('viewer'))
    .send({ points: 'nope' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.points);
});

test('POST /api/forecast 400s when too many points are supplied', async () => {
  const huge = Array.from({ length: 5001 }, (_, i) => ({ t: T0 + i, v: i }));
  const res = await request(makeApp())
    .post('/api/forecast')
    .set('Authorization', authHeader('viewer'))
    .send({ points: huge });
  assert.equal(res.status, 400);
});
