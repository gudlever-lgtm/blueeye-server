'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeTransactionsRepo, makeAgentCommander, authHeader, throwingAsync } = require('../test-support/fakes');

const TCP_TEST = { name: 'DB reachability', type: 'tcp', target: 'db.internal', config: { port: 5432 } };

// A repo with one test assigned to agent 7.
async function seeded(overrides = {}) {
  const repo = makeTransactionsRepo(overrides);
  const created = await repo.create({ ...TCP_TEST, capture: 'on_fault' });
  await repo.setAgents(created.id, [7]);
  return { repo, id: created.id };
}

function commanderReplying(reply) {
  return makeAgentCommander({ sendCommandAndWait: async () => reply });
}

const OK_REPLY = {
  delivered: 1,
  acked: true,
  reply: {
    transaction: {
      ok: true,
      result: {
        test_id: 1, time: '2026-01-01T00:00:00.000Z', status: 'ok', latency_ms: 4200,
        step_phases: [{ dns: 12, tcp: 31, tls: 78, ttfb: 4050, transfer: 29 }],
      },
    },
  },
};

// ---------------------------------------------------------------- run now

test('POST /:id/run is 401 unauthenticated', async () => {
  const { repo, id } = await seeded();
  assert.equal((await request(makeApp({ transactionsRepo: repo })).post(`/api/transactions/${id}/run`).send({ agent_id: 7 })).status, 401);
});

test('POST /:id/run is 403 for a viewer — running a test generates traffic', async () => {
  const { repo, id } = await seeded();
  const res = await request(makeApp({ transactionsRepo: repo }))
    .post(`/api/transactions/${id}/run`).set('Authorization', authHeader('viewer')).send({ agent_id: 7 });
  assert.equal(res.status, 403);
});

test('POST /:id/run is allowed for an operator — the capture can only hold this run\'s own traffic', async () => {
  const { repo, id } = await seeded();
  const app = makeApp({ transactionsRepo: repo, agentCommander: commanderReplying(OK_REPLY) });
  const res = await request(app).post(`/api/transactions/${id}/run`).set('Authorization', authHeader('operator')).send({ agent_id: 7, capture: true });
  assert.equal(res.status, 200);
});

test('POST /:id/run is 404 for a test that does not exist', async () => {
  const { repo } = await seeded();
  const res = await request(makeApp({ transactionsRepo: repo, agentCommander: commanderReplying(OK_REPLY) }))
    .post('/api/transactions/9999/run').set('Authorization', authHeader('admin')).send({ agent_id: 7 });
  assert.equal(res.status, 404);
});

test('POST /:id/run is 400 for a bad id, a missing agent, or a non-boolean capture', async () => {
  const { repo, id } = await seeded();
  const app = makeApp({ transactionsRepo: repo, agentCommander: commanderReplying(OK_REPLY) });
  const post = (path, body) => request(app).post(path).set('Authorization', authHeader('admin')).send(body);
  assert.equal((await post('/api/transactions/not-an-id/run', { agent_id: 7 })).status, 400);
  assert.equal((await post(`/api/transactions/${id}/run`, {})).status, 400);
  assert.equal((await post(`/api/transactions/${id}/run`, { agent_id: 0 })).status, 400);
  assert.equal((await post(`/api/transactions/${id}/run`, { agent_id: 7, capture: 'yes' })).status, 400);
});

test('POST /:id/run is 400 when that agent does not run this test', async () => {
  const { repo, id } = await seeded();
  const res = await request(makeApp({ transactionsRepo: repo, agentCommander: commanderReplying(OK_REPLY) }))
    .post(`/api/transactions/${id}/run`).set('Authorization', authHeader('admin')).send({ agent_id: 99 });
  assert.equal(res.status, 400);
  assert.match(res.body.details.agent_id, /not assigned/);
});

test('POST /:id/run is 409 when the agent is not connected, 504 when it never answers', async () => {
  const { repo, id } = await seeded();
  const offline = makeApp({ transactionsRepo: repo, agentCommander: commanderReplying({ delivered: 0, acked: false, reply: null }) });
  assert.equal((await request(offline).post(`/api/transactions/${id}/run`).set('Authorization', authHeader('admin')).send({ agent_id: 7 })).status, 409);

  const silent = makeApp({ transactionsRepo: repo, agentCommander: commanderReplying({ delivered: 1, acked: false, reply: null, timedOut: true }) });
  assert.equal((await request(silent).post(`/api/transactions/${id}/run`).set('Authorization', authHeader('admin')).send({ agent_id: 7 })).status, 504);
});

test('POST /:id/run relays the agent\'s own refusal rather than inventing one', async () => {
  const { repo, id } = await seeded();
  const refusing = commanderReplying({ delivered: 1, acked: true, reply: { transaction: { ok: false, error: 'this agent is not assigned that test' } } });
  const res = await request(makeApp({ transactionsRepo: repo, agentCommander: refusing }))
    .post(`/api/transactions/${id}/run`).set('Authorization', authHeader('admin')).send({ agent_id: 7 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /not assigned that test/);
});

test('POST /:id/run answers with the phase verdict, not just the number', async () => {
  const { repo, id } = await seeded();
  const res = await request(makeApp({ transactionsRepo: repo, agentCommander: commanderReplying(OK_REPLY) }))
    .post(`/api/transactions/${id}/run`).set('Authorization', authHeader('admin')).send({ agent_id: 7, capture: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.phases.verdict, 'application');
  assert.match(res.body.phases.explanation, /waiting for the server/);
  assert.equal(res.body.totals.tcp, 31);
});

test('POST /:id/run is 502 when asking the agent throws, not a 500 stack', async () => {
  const { repo, id } = await seeded();
  const broken = makeAgentCommander({ sendCommandAndWait: async () => { throw new Error('socket exploded'); } });
  const res = await request(makeApp({ transactionsRepo: repo, agentCommander: broken }))
    .post(`/api/transactions/${id}/run`).set('Authorization', authHeader('admin')).send({ agent_id: 7 });
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res.body).includes('socket exploded'), 'the internal error text does not leak');
});

test('POST /:id/run is 500 when the repository itself fails', async () => {
  const repo = makeTransactionsRepo({ findById: throwingAsync('db down') });
  const res = await request(makeApp({ transactionsRepo: repo, agentCommander: commanderReplying(OK_REPLY) }))
    .post('/api/transactions/1/run').set('Authorization', authHeader('admin')).send({ agent_id: 7 });
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------- captures

async function withCapture() {
  const { repo, id } = await seeded();
  await repo.insertCapture({
    test_id: id, agent_id: 7, time: new Date('2026-01-01T00:00:00.000Z'),
    reason: 'status:timeout', iface: 'eth0', filter: '(host 10.0.0.2 and tcp port 443)', snaplen: 96,
    truncated: false,
    packets: [{ t: 0, src: '10.0.0.1', dst: '10.0.0.2', sport: 51234, dport: 443, flags: 'S', proto: 6 }],
    analysis: { pattern: 'blackhole', explanation: 'Nothing came back at all.' },
  });
  return { repo, id };
}

test('GET /:id/captures is 401 unauthenticated and 200 for a viewer', async () => {
  const { repo, id } = await withCapture();
  const app = makeApp({ transactionsRepo: repo });
  assert.equal((await request(app).get(`/api/transactions/${id}/captures`)).status, 401);
  const res = await request(app).get(`/api/transactions/${id}/captures`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.captures.length, 1);
  assert.equal(res.body.captures[0].pattern, 'blackhole');
});

test('GET /:id/captures returns summaries WITHOUT the packets', async () => {
  const { repo, id } = await withCapture();
  const res = await request(makeApp({ transactionsRepo: repo })).get(`/api/transactions/${id}/captures`).set('Authorization', authHeader('viewer'));
  assert.equal(res.body.captures[0].packets, undefined, 'a list must not carry the largest column in the schema');
  assert.equal(res.body.captures[0].packet_count, 1);
});

test('GET /:id/captures is 404 for an unknown test and 400 for a bad agent_id', async () => {
  const { repo, id } = await withCapture();
  const app = makeApp({ transactionsRepo: repo });
  assert.equal((await request(app).get('/api/transactions/9999/captures').set('Authorization', authHeader('viewer'))).status, 404);
  assert.equal((await request(app).get(`/api/transactions/${id}/captures?agent_id=abc`).set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(app).get(`/api/transactions/${id}/captures?from=nonsense`).set('Authorization', authHeader('viewer'))).status, 400);
});

test('GET /:id/captures/one returns the packets, and 404 when there is none', async () => {
  const { repo, id } = await withCapture();
  const app = makeApp({ transactionsRepo: repo });
  const res = await request(app)
    .get(`/api/transactions/${id}/captures/one?agent_id=7&time=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.packets.length, 1);
  assert.equal(res.body.filter, '(host 10.0.0.2 and tcp port 443)', 'the scope is readable after the fact, not merely asserted');

  const missing = await request(app)
    .get(`/api/transactions/${id}/captures/one?agent_id=7&time=${encodeURIComponent('2020-01-01T00:00:00.000Z')}`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(missing.status, 404);
});

test('GET /:id/captures/one is 400 without a usable agent_id or time', async () => {
  const { repo, id } = await withCapture();
  const app = makeApp({ transactionsRepo: repo });
  const get = (q) => request(app).get(`/api/transactions/${id}/captures/one${q}`).set('Authorization', authHeader('viewer'));
  assert.equal((await get('')).status, 400);
  assert.equal((await get('?agent_id=7')).status, 400);
  assert.equal((await get('?agent_id=7&time=nonsense')).status, 400);
  assert.equal((await get('?agent_id=abc&time=2026-01-01T00:00:00.000Z')).status, 400);
});

test('GET /:id/captures is 500 when the repository fails', async () => {
  const repo = makeTransactionsRepo({ captures: throwingAsync('db down') });
  const created = await repo.create(TCP_TEST);
  const res = await request(makeApp({ transactionsRepo: repo })).get(`/api/transactions/${created.id}/captures`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('GET /:id/results marks which rows have a capture, without fetching any', async () => {
  const { repo, id } = await withCapture();
  await repo.insertResults([
    { test_id: id, agent_id: 7, time: new Date('2026-01-01T00:00:00.000Z'), status: 'timeout', latency_ms: 15000, step_phases: [{ dns: 5, tcp: 30, tls: null, ttfb: null, transfer: null }], step_failed: 0 },
    { test_id: id, agent_id: 7, time: new Date('2026-01-01T00:01:00.000Z'), status: 'ok', latency_ms: 50, step_phases: [{ dns: 5, tcp: 30, tls: null, ttfb: 10, transfer: 5 }] },
  ]);
  const res = await request(makeApp({ transactionsRepo: repo })).get(`/api/transactions/${id}/results`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const failed = res.body.results.find((r) => r.status === 'timeout');
  const passed = res.body.results.find((r) => r.status === 'ok');
  assert.equal(failed.has_capture, true);
  assert.equal(passed.has_capture, false);
  // The handshake completed, so this is not a network fault — and for a tcp
  // test there is no application exchange to blame either.
  assert.equal(failed.phase_verdict.verdict, 'mixed');
  assert.match(failed.phase_verdict.explanation, /carried packets both ways/);
});

// ---------------------------------------------------------------- capture mode

test('capture mode round-trips through create and update, and a typo is refused', async () => {
  const repo = makeTransactionsRepo();
  const app = makeApp({ transactionsRepo: repo });
  const created = await request(app).post('/api/transactions').set('Authorization', authHeader('admin')).send({ ...TCP_TEST, capture: 'on_fault' });
  assert.equal(created.status, 201);
  assert.equal(created.body.capture, 'on_fault');

  const off = await request(app).post('/api/transactions').set('Authorization', authHeader('admin')).send(TCP_TEST);
  assert.equal(off.body.capture, 'off', 'capture is off unless somebody asked for it');

  const typo = await request(app).post('/api/transactions').set('Authorization', authHeader('admin')).send({ ...TCP_TEST, capture: 'on-fault' });
  assert.equal(typo.status, 400, 'a typo must not silently disable collection');

  const updated = await request(app).put(`/api/transactions/${created.body.id}`).set('Authorization', authHeader('admin')).send({ ...TCP_TEST, capture: 'always' });
  assert.equal(updated.body.capture, 'always');
});
