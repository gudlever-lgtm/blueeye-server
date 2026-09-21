'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// "I have seen these and I accept them", for many findings at once.
//
// POST /api/findings/:id/ack acknowledges ONE. That is fine for a handful and
// useless at the scale this reaches: a real fleet reported 184 668 findings,
// 184 632 of them unacknowledged. A backlog nobody can clear is a backlog
// everybody stops reading, and then the one finding that mattered is in there
// too.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFindingStore, authHeader } = require('../test-support/fakes');

const finding = (over = {}) => ({
  hostId: '9', metric: 'probe.latency', severity: 'WARN', kind: 'ANOMALY',
  createdAt: new Date(), acked: false, ...over,
});

async function seeded() {
  const findingStore = makeFindingStore();
  await findingStore.save(finding({ id: 'a', severity: 'CRIT' }));
  await findingStore.save(finding({ id: 'b', severity: 'WARN' }));
  await findingStore.save(finding({ id: 'c', severity: 'WARN', hostId: '11' }));
  await findingStore.save(finding({ id: 'd', severity: 'CRIT' }));
  // Acknowledged the ordinary way, not born that way: save() deliberately
  // forces acked=false, because a finding nobody has seen yet is not accepted.
  await findingStore.ack('d');
  return findingStore;
}

const post = (app, body, role = 'operator', qs = '') => request(app)
  .post(`/api/findings/ack${qs}`).set('Authorization', authHeader(role)).send(body);

test('a selection of ids is accepted in one request', async () => {
  const findingStore = await seeded();
  const app = makeApp({ findingStore });

  const res = await post(app, { ids: ['a', 'b'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.acked, 2);
  assert.equal(res.body.requested, 2);
  assert.equal(findingStore.rows.find((f) => f.id === 'a').acked, true);
  assert.equal(findingStore.rows.find((f) => f.id === 'c').acked, false, 'only what was selected');
});

test('an already-accepted finding is not counted again', async () => {
  // "Accepted 40 000" has to mean forty thousand MOVED, not forty thousand
  // matched — otherwise the number tells you nothing about what you just did.
  const findingStore = await seeded();
  const app = makeApp({ findingStore });

  const res = await post(app, { ids: ['a', 'd'] });
  assert.equal(res.body.acked, 1, 'd was already accepted');
  assert.equal(res.body.requested, 2);
});

test('accept-everything-I-am-looking-at follows the SAME filters as the list', async () => {
  // The whole point: the operator accepts what is on their screen. If this
  // scoped any wider than the list does, it would retire findings they never
  // saw — which is the one thing a bulk action must not do.
  const findingStore = await seeded();
  const app = makeApp({ findingStore });

  const res = await post(app, { all: true }, 'operator', '?severity=WARN');
  assert.equal(res.status, 200);
  assert.equal(res.body.acked, 2, 'both WARNs, and neither CRIT');
  assert.equal(findingStore.rows.find((f) => f.id === 'a').acked, false, 'the CRIT is untouched');
});

test('`all` must be explicit — an empty body never retires the history', async () => {
  const app = makeApp({ findingStore: await seeded() });

  assert.equal((await post(app, {})).status, 400);
  assert.equal((await post(app, { ids: [] })).status, 400);
  assert.equal((await post(app, { all: true, ids: ['a'] })).status, 400, 'one shape or the other, not both');
  assert.equal((await post(app, { ids: [123] })).status, 400, 'finding ids are strings');
  assert.equal((await post(app, { ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`) })).status, 400);
});

test('accepting is operator+, and a viewer cannot', async () => {
  const app = makeApp({ findingStore: await seeded() });
  assert.equal((await post(app, { ids: ['a'] }, 'viewer')).status, 403);
  assert.equal((await request(app).post('/api/findings/ack').send({ ids: ['a'] })).status, 401);
  assert.equal((await post(app, { ids: ['a'] }, 'admin')).status, 200);
});

test('a bad filter is a 400, not a silent accept-everything', async () => {
  // The dangerous failure: a filter the server does not understand, ignored,
  // turning "accept these WARNs" into "accept all 184 668".
  const app = makeApp({ findingStore: await seeded() });
  const res = await post(app, { all: true }, 'operator', '?severity=NOPE');
  assert.equal(res.status, 400);
});

test('a store failure is a 500, not a cheerful zero', async () => {
  const findingStore = makeFindingStore({ ackMany: async () => { throw new Error('db down'); } });
  const app = makeApp({ findingStore });
  const res = await post(app, { ids: ['a'] });
  assert.equal(res.status, 500);
});
