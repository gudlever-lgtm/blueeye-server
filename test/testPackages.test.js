'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeTestPackagesRepo,
  makeTestPackageRunner,
  authHeader,
} = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');

const validBody = {
  name: 'Daily reachability',
  schedule_ms: 0,
  targets: { mode: 'all' },
  items: [{ type: 'probe', probe: { type: 'ping', host: '1.1.1.1', count: 3 } }],
};

test('GET /api/test-packages lists packages (viewer+)', async () => {
  const repo = makeTestPackagesRepo({ findAll: async () => [{ id: 1, name: 'p', items: [], targets: { mode: 'all' } }] });
  const res = await request(makeApp({ testPackagesRepo: repo })).get('/api/test-packages').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'p');
});

test('GET /api/test-packages without a token returns 401', async () => {
  const res = await request(makeApp()).get('/api/test-packages');
  assert.equal(res.status, 401);
});

test('POST /api/test-packages creates a package (operator) -> 201', async () => {
  let created;
  const repo = makeTestPackagesRepo({ create: async (p) => { created = p; return { id: 5, ...p }; } });
  const res = await request(makeApp({ testPackagesRepo: repo }))
    .post('/api/test-packages')
    .set('Authorization', operator())
    .send(validBody);
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 5);
  assert.equal(created.name, 'Daily reachability');
  assert.equal(created.items[0].probe.host, '1.1.1.1');
  assert.equal(created.created_by, 1); // from the test JWT
});

test('POST /api/test-packages validates the body -> 400', async () => {
  const res = await request(makeApp())
    .post('/api/test-packages')
    .set('Authorization', operator())
    .send({ name: '', targets: { mode: 'all' }, items: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('POST /api/test-packages is forbidden for a viewer (403)', async () => {
  const res = await request(makeApp()).post('/api/test-packages').set('Authorization', viewer()).send(validBody);
  assert.equal(res.status, 403);
});

test('PUT /api/test-packages/:id updates an existing package', async () => {
  const repo = makeTestPackagesRepo({ findById: async () => ({ id: 3 }), update: async (id, p) => ({ id, ...p }) });
  const res = await request(makeApp({ testPackagesRepo: repo }))
    .put('/api/test-packages/3')
    .set('Authorization', operator())
    .send({ ...validBody, name: 'Renamed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed');
});

test('PUT /api/test-packages/:id returns 404 for an unknown package', async () => {
  const repo = makeTestPackagesRepo({ findById: async () => null });
  const res = await request(makeApp({ testPackagesRepo: repo }))
    .put('/api/test-packages/999')
    .set('Authorization', operator())
    .send(validBody);
  assert.equal(res.status, 404);
});

test('DELETE /api/test-packages/:id removes a package (operator) -> 204', async () => {
  const repo = makeTestPackagesRepo({ remove: async () => true });
  const res = await request(makeApp({ testPackagesRepo: repo })).delete('/api/test-packages/3').set('Authorization', operator());
  assert.equal(res.status, 204);
});

test('POST /api/test-packages/:id/run triggers the runner -> 202 with summary', async () => {
  let ran;
  const repo = makeTestPackagesRepo({ findById: async () => ({ id: 8, name: 'p', items: [], targets: { mode: 'all' } }) });
  const runner = makeTestPackageRunner({ run: async (pkg) => { ran = pkg; return { at: 'now', targeted: 2, reached: 2, delivered: 4, items: 2 }; } });
  const res = await request(makeApp({ testPackagesRepo: repo, testPackageRunner: runner }))
    .post('/api/test-packages/8/run')
    .set('Authorization', operator());
  assert.equal(res.status, 202);
  assert.equal(res.body.delivered, 4);
  assert.equal(ran.id, 8);
});

test('POST /api/test-packages/:id/run returns 404 for an unknown package', async () => {
  const repo = makeTestPackagesRepo({ findById: async () => null });
  const res = await request(makeApp({ testPackagesRepo: repo })).post('/api/test-packages/999/run').set('Authorization', operator());
  assert.equal(res.status, 404);
});

test('POST /api/test-packages/:id/run is forbidden for a viewer (403)', async () => {
  const res = await request(makeApp()).post('/api/test-packages/8/run').set('Authorization', viewer());
  assert.equal(res.status, 403);
});
