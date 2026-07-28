'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// API tests for the read-only baseline context endpoint (Fase 4).
//
//   GET /api/baselines/flow-pair?host=&limit=   viewer+
//
// The endpoint exists so the shared UI component can annotate a number with
// "220% above normal for a Tuesday at 14:00" without every view fetching the
// comparison its own way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeFlowPairBaselinesRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const agentsRepo = () => makeAgentsRepo({ findById: async (id) => (Number(id) === 7 ? { id: 7, hostname: 'sw-core' } : null) });

const get = (app, qs, role = 'viewer') =>
  request(app).get(`/api/baselines/flow-pair${qs}`).set('Authorization', authHeader(role));

async function seeded() {
  const repo = makeFlowPairBaselinesRepo();
  await repo.upsertBaselines([
    { srcHostId: 7, dstHostId: 9, dstPort: 443, dow: 2, hour: 14, medianBytes: 1000, madBytes: 100, sampleCount: 40, observationCount: 500 },
    { srcHostId: 7, dstHostId: 9, dstPort: 443, dow: 2, hour: 15, medianBytes: 1200, madBytes: 120, sampleCount: 40, observationCount: 500 },
  ]);
  return repo;
}

// ------------------------------------------------------------------ auth/RBAC
test('GET /api/baselines/flow-pair returns 401 without a token', async () => {
  const app = makeApp({ agentsRepo: agentsRepo() });
  assert.equal((await request(app).get('/api/baselines/flow-pair?host=7')).status, 401);
});

test('viewer may read baseline context', async () => {
  // Deliberate: this is the same class of traffic-volume metadata a viewer
  // already reads in the Flows explorer, with a comparison attached. The
  // operator+ /api/topology/flow-baselines diagnostic route is left alone.
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: await seeded() });
  for (const role of ['viewer', 'operator', 'admin']) {
    assert.equal((await get(app, '?host=7', role)).status, 200, `${role} should be allowed`);
  }
});

// ------------------------------------------------------------------------ 400
test('GET /api/baselines/flow-pair returns 400 without a valid host', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: await seeded() });
  for (const qs of ['', '?host=', '?host=0', '?host=-1', '?host=abc', '?host=1.5']) {
    assert.equal((await get(app, qs)).status, 400, `${qs} should be rejected`);
  }
});

test('GET /api/baselines/flow-pair returns 400 for an out-of-range limit', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: await seeded() });
  for (const l of ['0', '-1', '5001', 'abc']) {
    assert.equal((await get(app, `?host=7&limit=${l}`)).status, 400, `limit=${l} should be rejected`);
  }
  assert.equal((await get(app, '?host=7&limit=10')).status, 200);
});

// ------------------------------------------------------------------------ 404
test('GET /api/baselines/flow-pair returns 404 for an unknown host', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: await seeded() });
  const res = await get(app, '?host=999');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Host not found');
});

// ------------------------------------------------------------------------ 200
test('GET /api/baselines/flow-pair returns the slots with their age fields', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: await seeded() });
  const res = await get(app, '?host=7');

  assert.equal(res.status, 200);
  assert.equal(res.body.host, 7);
  assert.equal(res.body.baselines.length, 2);

  const slot = res.body.baselines.find((b) => b.hour === 14);
  assert.equal(slot.dow, 2);
  assert.equal(slot.medianBytes, 1000);
  // The age fields are what let the UI hedge a thin baseline on hover — a
  // baseline from three days is not the same claim as one from three months.
  assert.equal(slot.observationCount, 500);
  assert.ok('updatedAt' in slot);
});

test('a host with no baselines is 200 with building:true, not 404', async () => {
  // A fresh install has no baselines for ~14 days: history builds FORWARD
  // because raw flows cannot be backfilled. "No baseline yet" is a normal state
  // the UI renders as "no secondary line", not an error.
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: makeFlowPairBaselinesRepo() });
  const res = await get(app, '?host=7');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.baselines, []);
  assert.equal(res.body.building, true, 'the UI must be able to say WHY there is no context');
});

test('building is false once baselines exist', async () => {
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: await seeded() });
  assert.equal((await get(app, '?host=7')).body.building, false);
});

// ------------------------------------------------------------------------ 500
test('GET /api/baselines/flow-pair returns 500 (clean) when the repo throws', async () => {
  const flowPairBaselinesRepo = makeFlowPairBaselinesRepo({ listForHost: throwingAsync() });
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo });
  const res = await get(app, '?host=7');

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/at Object|at async|\.js:\d+:\d+/.test(JSON.stringify(res.body)), 'must not leak a stack trace');
});

// ------------------------------------------------------------------------ 503
test('GET /api/baselines/flow-pair returns 503 when the repo is not wired', async () => {
  // A deployment without migration 068 has no baselines at all; 503 says "this
  // capability is absent", which is different from "this host has none yet".
  const app = makeApp({ agentsRepo: agentsRepo(), flowPairBaselinesRepo: null });
  assert.equal((await get(app, '?host=7')).status, 503);
});
