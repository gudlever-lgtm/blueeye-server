'use strict';

// Acknowledging a Fleet verdict (migration 138): "somebody is on this".
//
// The two things worth pinning are the ones a reader relies on: an
// acknowledgement never changes the verdict (a CRIT row stays CRIT, and the
// summary counts stay honest), and a verdict that MOVES re-opens the row —
// the acknowledgement covers the verdict it was made for and no other.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeProbeResultsRepo, makeAgentHealthAcksRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { healthSignature, applyAck, isAckable } = require('../src/health/healthAck');

const NOW = Date.parse('2026-06-02T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// Rows that produce a `bad` verdict: heavy loss on one reachable target.
function lossRows(agentId, lossPct = 40) {
  return [30, 31, 29].map((rttMs, i) => ({
    agentId, ts: ago(1000 + i * 60000), type: 'ping', target: '8.8.8.8',
    ok: true, rttMs, lossPct, jitterMs: 2,
  }));
}

function appWith({ agentId = 9, lossPct = 40, healthAcksRepo } = {}) {
  const agentsRepo = makeAgentsRepo({
    findAll: async () => [{ id: agentId, hostname: 'a9', status: 'online' }],
    findById: async (id) => (Number(id) === agentId ? { id: agentId, hostname: 'a9', status: 'online' } : null),
  });
  const probeResultsRepo = makeProbeResultsRepo({
    fleetHealth: async () => lossRows(agentId, lossPct),
    findByAgent: async () => lossRows(agentId, lossPct).slice().reverse(), // oldest-first
  });
  return makeApp({ agentsRepo, probeResultsRepo, healthAcksRepo });
}

// ---- the signature --------------------------------------------------------

test('healthSignature covers the status and the reason, not the live numbers', () => {
  const a = { status: 'bad', reason: 'Heavy loss to 8.8.8.8', evidence: [{ metric: 'loss', lossPct: 40 }] };
  const b = { status: 'bad', reason: 'Heavy loss to 8.8.8.8', evidence: [{ metric: 'loss', lossPct: 55 }] };
  assert.equal(healthSignature(a), healthSignature(b)); // the evidence moved, the verdict did not
  assert.notEqual(healthSignature(a), healthSignature({ status: 'warn', reason: a.reason }));
  assert.notEqual(healthSignature(a), healthSignature({ status: 'bad', reason: 'A link is discarding frames' }));
});

test('only a verdict worth clearing is ackable', () => {
  for (const s of ['warn', 'bad', 'down', 'stale']) assert.equal(isAckable(s), true, s);
  // `ok` needs no acknowledgement, and `unknown` is the agent nobody has heard
  // from — acknowledging it would hide exactly the row that matters.
  for (const s of ['ok', 'unknown', '', null]) assert.equal(isAckable(s), false, String(s));
});

test('applyAck annotates a matching verdict and ignores one made for another', () => {
  const health = { status: 'bad', reason: 'Heavy loss' };
  const ack = { signature: healthSignature(health), status: 'bad', ackedAt: '2026-06-02T11:00:00.000Z', ackedEmail: 'ops@x' };
  const marked = applyAck(health, ack);
  assert.equal(marked.status, 'bad');          // the verdict is untouched
  assert.equal(marked.ack.by, 'ops@x');
  // The verdict moved: the acknowledgement no longer applies.
  assert.equal(applyAck({ status: 'down', reason: 'Every target unreachable' }, ack).ack, undefined);
  assert.equal(applyAck(health, null), health);
});

// ---- the routes -----------------------------------------------------------

test('POST /api/fleet/health/:id/ack marks the verdict without changing it (201)', async () => {
  const app = appWith();
  const res = await request(app).post('/api/fleet/health/9/ack')
    .set('Authorization', authHeader('operator')).send({ note: 'ISP ticket 4412' });
  assert.equal(res.status, 201);
  assert.equal(res.body.health.status, 'bad');       // still CRIT
  assert.equal(res.body.health.ack.note, 'ISP ticket 4412');
  assert.equal(res.body.health.ack.by, 'operator@blueeye.local');

  const rollup = await request(app).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(rollup.status, 200);
  const a9 = rollup.body.agents.find((a) => a.agentId === 9);
  assert.equal(a9.health.status, 'bad');             // the badge does not go green
  assert.ok(a9.health.ack);
  assert.equal(rollup.body.summary.bad, 1);          // …and the counts stay honest
  assert.equal(rollup.body.summary.acknowledged, 1);

  const one = await request(app).get('/api/fleet/agent/9').set('Authorization', authHeader('viewer'));
  assert.equal(one.status, 200);
  assert.ok(one.body.health.ack);
});

test('a verdict that changes re-opens the row', async () => {
  const healthAcksRepo = makeAgentHealthAcksRepo();
  const ack = await request(appWith({ healthAcksRepo, lossPct: 40 }))
    .post('/api/fleet/health/9/ack').set('Authorization', authHeader('operator')).send({});
  assert.equal(ack.status, 201);

  // Same agent, same acknowledgement row — but now every target is unreachable,
  // which is a different verdict with a different reason.
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 9, hostname: 'a9', status: 'online' }] });
  const probeResultsRepo = makeProbeResultsRepo({
    fleetHealth: async () => [{ agentId: 9, ts: ago(1000), type: 'ping', target: '8.8.8.8', ok: false, rttMs: 0, lossPct: 100 }],
  });
  const res = await request(makeApp({ agentsRepo, probeResultsRepo, healthAcksRepo }))
    .get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  const a9 = res.body.agents.find((a) => a.agentId === 9);
  assert.equal(a9.health.status, 'down');
  assert.equal(a9.health.ack, undefined);
  assert.equal(res.body.summary.acknowledged, 0);
});

test('acknowledging a healthy agent is 409, not a silent no-op', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id: Number(id), hostname: 'h', status: 'online' }) });
  const probeResultsRepo = makeProbeResultsRepo({
    // Fresh timestamps: the route computes against the real clock, and a
    // healthy verdict older than the staleness window would read `stale` —
    // which IS ackable, and would test the opposite of what this asserts.
    findByAgent: async () => [10, 11, 9, 10].map((rttMs, i) => ({ ts: new Date(Date.now() - 1000 - i * 60000).toISOString(), type: 'ping', target: '1.1.1.1', ok: true, rttMs, lossPct: 0, jitterMs: 2 })),
  });
  const res = await request(makeApp({ agentsRepo, probeResultsRepo }))
    .post('/api/fleet/health/9/ack').set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Nothing to acknowledge/);
});

test('DELETE removes it (204), and says so when there is nothing to remove (404)', async () => {
  const app = appWith();
  const first = await request(app).delete('/api/fleet/health/9/ack').set('Authorization', authHeader('operator'));
  assert.equal(first.status, 404);
  await request(app).post('/api/fleet/health/9/ack').set('Authorization', authHeader('operator')).send({});
  const gone = await request(app).delete('/api/fleet/health/9/ack').set('Authorization', authHeader('operator'));
  assert.equal(gone.status, 204);
  const rollup = await request(app).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(rollup.body.agents.find((a) => a.agentId === 9).health.ack, undefined);
});

// ---- the edges ------------------------------------------------------------

test('the routes validate the id and the note, and a viewer cannot acknowledge', async () => {
  const app = appWith();
  const bad = await request(app).post('/api/fleet/health/abc/ack').set('Authorization', authHeader('operator')).send({});
  assert.equal(bad.status, 400);
  const missing = await request(app).post('/api/fleet/health/424242/ack').set('Authorization', authHeader('operator')).send({});
  assert.equal(missing.status, 404);
  const longNote = await request(app).post('/api/fleet/health/9/ack')
    .set('Authorization', authHeader('operator')).send({ note: 'x'.repeat(256) });
  assert.equal(longNote.status, 400);
  const viewer = await request(app).post('/api/fleet/health/9/ack').set('Authorization', authHeader('viewer')).send({});
  assert.equal(viewer.status, 403);
  const anon = await request(app).post('/api/fleet/health/9/ack').send({});
  assert.equal(anon.status, 401);
});

test('a failed acknowledgement read degrades the rollup instead of 500ing it', async () => {
  const healthAcksRepo = makeAgentHealthAcksRepo({ findAll: throwingAsync('acks table is gone') });
  const res = await request(appWith({ healthAcksRepo })).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const a9 = res.body.agents.find((a) => a.agentId === 9);
  assert.equal(a9.health.status, 'bad');
  assert.equal(a9.health.ack, undefined);
});

test('without the acknowledgements repository the routes say so (503), and the rollup still works', async () => {
  const app = appWith({ healthAcksRepo: null });
  const rollup = await request(app).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(rollup.status, 200);
  const res = await request(app).post('/api/fleet/health/9/ack').set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 503);
});
