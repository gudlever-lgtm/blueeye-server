'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeHopLocationsRepo, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');

const CPH = { ip: '193.162.153.0', prefixLen: 24, lat: 55.6761, lng: 12.5683, city: 'Copenhagen', country: 'DK' };

test('GET /api/geo/hops lists the corrections (viewer may read)', async () => {
  const repo = makeHopLocationsRepo();
  await repo.upsert({ ...CPH, source: 'manual' });
  const res = await request(makeApp({ hopLocationsRepo: repo })).get('/api/geo/hops').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.corrections.length, 1);
  assert.equal(res.body.corrections[0].city, 'Copenhagen');
});

test('hop corrections require auth (401 without a token)', async () => {
  assert.equal((await request(makeApp()).get('/api/geo/hops')).status, 401);
  assert.equal((await request(makeApp()).put('/api/geo/hops').send(CPH)).status, 401);
  assert.equal((await request(makeApp()).delete('/api/geo/hops?ip=1.2.3.4')).status, 401);
});

test('a viewer may not write a correction (403)', async () => {
  const res = await request(makeApp()).put('/api/geo/hops').set('Authorization', viewer()).send(CPH);
  assert.equal(res.status, 403);
});

test('PUT /api/geo/hops writes it and reloads the live index', async () => {
  const repo = makeHopLocationsRepo();
  const app = makeApp({ hopLocationsRepo: repo });
  const res = await request(app).put('/api/geo/hops').set('Authorization', operator())
    .send({ ip: '193.162.153.77/24', lat: 55.6761, lng: 12.5683, city: 'Copenhagen', country: 'dk', note: 'measured' });
  assert.equal(res.status, 200);
  // Stored at the network boundary, as one row rather than two for one block.
  assert.equal(res.body.correction.ip, '193.162.153.0');
  assert.equal(res.body.correction.prefixLen, 24);
  assert.equal(res.body.correction.country, 'DK');
  assert.equal(res.body.correction.source, 'manual');
  // And it is the live answer straight away, not after a restart.
  const list = await request(app).get('/api/geo/hops').set('Authorization', viewer());
  assert.equal(list.body.active.size, 1);
});

test('PUT /api/geo/hops refuses a private address, a missing position and a /0', async () => {
  const app = makeApp();
  const bad = async (body) => (await request(app).put('/api/geo/hops').set('Authorization', operator()).send(body)).status;
  assert.equal(await bad({ ip: '10.0.0.1', lat: 1, lng: 2 }), 400);
  assert.equal(await bad({ ip: '1.2.3.4' }), 400);
  assert.equal(await bad({ ip: '1.2.3.4/0', lat: 1, lng: 2 }), 400);
  assert.equal(await bad({ ip: '1.2.3.4', lat: 1, lng: 2, country: 'Denmark' }), 400);
  assert.equal(await bad({}), 400);
  const res = await request(app).put('/api/geo/hops').set('Authorization', operator()).send({});
  assert.equal(res.body.error, 'Validation failed');
  assert.ok(res.body.details.ip);
});

test('DELETE /api/geo/hops removes it, and 404s when there is nothing to remove', async () => {
  const repo = makeHopLocationsRepo();
  await repo.upsert({ ...CPH, source: 'manual' });
  const app = makeApp({ hopLocationsRepo: repo });
  const ok = await request(app).delete('/api/geo/hops?ip=193.162.153.0&prefixLen=24').set('Authorization', operator());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.removed, 1);
  const gone = await request(app).delete('/api/geo/hops?ip=193.162.153.0&prefixLen=24').set('Authorization', operator());
  assert.equal(gone.status, 404);
  const bad = await request(app).delete('/api/geo/hops?ip=10.0.0.1').set('Authorization', operator());
  assert.equal(bad.status, 400);
});

test('a failing repository answers 500 with the error contract, never a stack', async () => {
  const boom = async () => { throw new Error('db down'); };
  const app = makeApp({ hopLocationsRepo: makeHopLocationsRepo({ all: boom, upsert: boom, remove: boom }) });
  const list = await request(app).get('/api/geo/hops').set('Authorization', viewer());
  assert.equal(list.status, 500);
  // 'Internal Server Error' off the error-handler contract, never a stack.
  assert.equal(list.body.error, 'Internal Server Error');
  assert.ok(!JSON.stringify(list.body).includes('at Object'));
  assert.equal((await request(app).put('/api/geo/hops').set('Authorization', operator()).send(CPH)).status, 500);
  assert.equal((await request(app).delete('/api/geo/hops?ip=193.162.153.0&prefixLen=24').set('Authorization', operator())).status, 500);
});
