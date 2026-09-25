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

// ---- Run on a chosen set of agents ----------------------------------------
//
// The reverse direction: pick the test, pick who runs it. The override applies
// to THIS run only — a package aimed at the whole fleet must still be aimed at
// the whole fleet afterwards, or "run it here once" quietly becomes an edit.

test('POST /api/test-packages/:id/run passes agentIds to the runner as a one-off override', async () => {
  let seen = null;
  const repo = makeTestPackagesRepo({ findById: async () => ({ id: 3, name: 'p', items: [], targets: { mode: 'all' } }) });
  const runner = makeTestPackageRunner({
    run: async (pkg, opts) => { seen = { pkg, opts }; return { targeted: 2, reached: 2, delivered: 2, items: 1, adhoc: true }; },
  });
  const res = await request(makeApp({ testPackagesRepo: repo, testPackageRunner: runner }))
    .post('/api/test-packages/3/run')
    .set('Authorization', operator())
    .send({ agentIds: [4, 9] });
  assert.equal(res.status, 202);
  assert.equal(res.body.adhoc, true);
  assert.deepEqual(seen.opts.agentIds, [4, 9]);
  // The package's own targets are untouched — the override never writes back.
  assert.deepEqual(seen.pkg.targets, { mode: 'all' });
});

test('POST /api/test-packages/:id/run with no body still uses the package\'s own targets', async () => {
  let seen = 'unset';
  const repo = makeTestPackagesRepo({ findById: async () => ({ id: 3, name: 'p', items: [], targets: { mode: 'all' } }) });
  const runner = makeTestPackageRunner({ run: async (pkg, opts) => { seen = opts; return { targeted: 0, reached: 0, delivered: 0, items: 0 }; } });
  const res = await request(makeApp({ testPackagesRepo: repo, testPackageRunner: runner }))
    .post('/api/test-packages/3/run').set('Authorization', operator());
  assert.equal(res.status, 202);
  assert.deepEqual(seen, {});
});

test('POST /api/test-packages/:id/run rejects a malformed agentIds with 400', async () => {
  const repo = makeTestPackagesRepo({ findById: async () => ({ id: 3, name: 'p', items: [], targets: { mode: 'all' } }) });
  const app = makeApp({ testPackagesRepo: repo });
  for (const body of [{ agentIds: [] }, { agentIds: 'all' }, { agentIds: [0] }, { agentIds: [1.5] }, { agentIds: ['4'] }]) {
    const res = await request(app).post('/api/test-packages/3/run').set('Authorization', operator()).send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.details.agentIds, JSON.stringify(body));
  }
});

test('POST /api/test-packages/:id/run validates the body BEFORE it looks the package up', async () => {
  // A 400 that costs a database read is a 400 an unauthenticated flood can use.
  let reads = 0;
  const repo = makeTestPackagesRepo({ findById: async () => { reads += 1; return null; } });
  const res = await request(makeApp({ testPackagesRepo: repo }))
    .post('/api/test-packages/3/run').set('Authorization', operator()).send({ agentIds: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(reads, 0);
});
