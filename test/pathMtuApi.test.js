'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// HTTP surface for the path_mtu probe: who may start one, what a bad spec
// answers, what a missing agent answers, and what a broken database answers.
// The gate suites already sweep these shapes across every route; this pins the
// MTU-specific ones, which a generic sweep cannot know about (min_size against
// max_size, the jumbo ceiling, the stored verdict).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentTokensRepo, makeAgentsRepo, makeProbeResultsRepo, makeAgentCommander,
  makeAuditLogRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { toRow, COLUMNS } = require('../src/repositories/probeResultsRepository');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const withAgent = (overrides = {}) => makeApp({
  agentsRepo: makeAgentsRepo({ findById: async (id) => (id === 9 ? { id, hostname: 'h1' } : null) }),
  ...overrides,
});
const SPEC = { type: 'path_mtu', host: '10.20.30.40' };

const RESULT = {
  type: 'path_mtu',
  target: '10.20.30.40',
  ok: true,
  ip_version: 4,
  path_mtu: 1420,
  blackhole_detected: true,
  icmp_frag_needed_seen: false,
  mtu_drop_at_hop: 5,
  hops: [
    { hop: 4, ip: '192.0.2.1', max_mtu: 1500, status: 'ok' },
    { hop: 5, ip: '198.51.100.7', max_mtu: 1420, status: 'blackhole' },
  ],
  mss_supported: true,
  mss_observed: 1460,
  recommended_mss: 1380,
  duration_ms: 8421,
};

// ------------------------------------------------------------------ 403 RBAC
test('403: a viewer may not start a path-MTU test; operator and admin may', async () => {
  const commander = makeAgentCommander({ sendCommand: () => 1 });
  const viewer = await request(withAgent({ agentCommander: commander }))
    .post('/agents/9/probe').set('Authorization', authHeader('viewer')).send(SPEC);
  assert.equal(viewer.status, 403);

  for (const role of ['operator', 'admin']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(withAgent({ agentCommander: commander }))
      .post('/agents/9/probe').set('Authorization', authHeader(role)).send(SPEC);
    assert.equal(res.status, 202, role);
  }
});

test('403: a viewer may READ path-MTU results', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ latestByAgent: async () => [{ id: 1, type: 'path_mtu', target: '10.20.30.40', ok: true }] });
  const res = await request(withAgent({ probeResultsRepo }))
    .get('/api/probes/latest?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].type, 'path_mtu');
});

test('401: no token at all, on both the trigger and the read', async () => {
  assert.equal((await request(withAgent()).post('/agents/9/probe').send(SPEC)).status, 401);
  assert.equal((await request(withAgent()).get('/api/probes?agentId=9')).status, 401);
});

// -------------------------------------------------------------------- 404
test('404: an unknown agent id, on the trigger and on every read', async () => {
  const trigger = await request(withAgent()).post('/agents/4242/probe')
    .set('Authorization', authHeader('operator')).send(SPEC);
  assert.equal(trigger.status, 404);

  for (const path of ['/api/probes?agentId=4242', '/api/probes/latest?agentId=4242',
    '/api/probes/path?agentId=4242', '/api/probes/path/timeseries?agentId=4242']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(withAgent()).get(path).set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 404, path);
    assert.equal(res.body.error, 'Agent not found', path);
  }
});

test('404: an unknown test-package id', async () => {
  const res = await request(withAgent()).get('/api/test-packages/4242').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
});

test('404: an unknown probe result is an empty series, never a 200 with someone else\'s data', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => [] });
  const res = await request(withAgent({ probeResultsRepo }))
    .get('/api/probes?agentId=9&type=path_mtu').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, []);
});

// -------------------------------------------------------------------- 400
test('400: an invalid target', async () => {
  for (const host of ['', '-rf', 'a b', 'x'.repeat(300), ';id', '$(id)']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(withAgent()).post('/agents/9/probe')
      .set('Authorization', authHeader('operator')).send({ type: 'path_mtu', host });
    assert.equal(res.status, 400, JSON.stringify(host));
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(res.body.details.host, JSON.stringify(host));
  }
});

test('400: min_size greater than max_size', async () => {
  const res = await request(withAgent()).post('/agents/9/probe')
    .set('Authorization', authHeader('operator')).send({ ...SPEC, min_size: 1500, max_size: 1400 });
  assert.equal(res.status, 400);
  assert.match(res.body.details.min_size, /not be greater than max_size/);
});

test('400: max_size above the 9216 jumbo ceiling', async () => {
  for (const max of [9217, 65535, 1e9]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(withAgent()).post('/agents/9/probe')
      .set('Authorization', authHeader('operator')).send({ ...SPEC, max_size: max });
    assert.equal(res.status, 400, String(max));
    assert.match(res.body.details.max_size, /9216/);
  }
  const ok = await request(withAgent({ agentCommander: makeAgentCommander({ sendCommand: () => 1 }) }))
    .post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ ...SPEC, max_size: 9216 });
  assert.equal(ok.status, 202, '9216 itself is a legal jumbo frame');
});

test('400: the remaining parameter bounds', async () => {
  const bad = [
    [{ ip_version: 5 }, 'ip_version'],
    [{ min_size: 100 }, 'min_size'],
    [{ min_size: 'abc' }, 'min_size'],
    [{ max_size: 1.5 }, 'max_size'],
    [{ probes_per_size: 0 }, 'probes_per_size'],
    [{ probes_per_size: 99 }, 'probes_per_size'],
    [{ timeout_ms: 10 }, 'timeout_ms'],
    [{ timeout_ms: 999999 }, 'timeout_ms'],
    [{ tcp_port: 0 }, 'tcp_port'],
    [{ tcp_port: 70000 }, 'tcp_port'],
  ];
  for (const [patch, field] of bad) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(withAgent()).post('/agents/9/probe')
      .set('Authorization', authHeader('operator')).send({ ...SPEC, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.ok(res.body.details[field], `${JSON.stringify(patch)} → ${JSON.stringify(res.body.details)}`);
  }
});

test('400: an empty, non-object or garbage body is never a 500', async () => {
  for (const body of [{}, [], 'str', '42', 'null']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(withAgent()).post('/agents/9/probe')
      .set('Authorization', authHeader('operator')).send(body);
    assert.ok(res.status === 400, `${JSON.stringify(body)} → ${res.status}`);
    assert.ok(res.status < 500);
  }
});

// -------------------------------------------------------------------- 500
test('500: a database failure is JSON with no stack trace, and gives up its detail in production', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: throwingAsync('probe_results is on fire at 10.0.0.5:3306') });
  const app = withAgent({ probeResultsRepo });
  const get = () => request(app).get('/api/probes?agentId=9&type=path_mtu').set('Authorization', authHeader('viewer'));

  const dev = await get();
  assert.equal(dev.status, 500);
  assert.match(dev.headers['content-type'], /application\/json/);
  assert.doesNotMatch(dev.text, /at .*\.js:\d+/, 'a stack trace reached the client');

  // Production is where it matters: the operator gets a generic body, and the
  // host and port of the database stay on the server.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const prod = await get();
    assert.equal(prod.status, 500);
    assert.deepEqual(prod.body, { error: 'Internal Server Error' });
    assert.ok(!prod.text.includes('10.0.0.5'), 'infrastructure detail leaked');
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('500: a database failure on ingest is generic JSON in production, and never a crash', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ createMany: throwingAsync('INSERT blew up') });
  const app = makeApp({ agentTokensRepo: agentToken(), probeResultsRepo });
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await request(app).post('/agents/probe-results').set('Authorization', 'Bearer t').send({ results: [RESULT] });
    assert.equal(res.status, 500);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(res.body, { error: 'Internal Server Error' });
    assert.doesNotMatch(res.text, /INSERT blew up/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('500 is not how an invalid agent result is handled — that is a 400', async () => {
  const invalid = [
    { type: 'path_mtu' }, // no target
    { type: 'path_mtu', target: 'x'.repeat(300), ok: true },
    { type: 'path_mtu', target: 'x', ok: true, ts: 'not-a-date' },
    { type: 'path_mtu', target: 'x', ok: true, hops: 'not-an-array' },
    { type: 'path_mtu', target: 'x', ok: true, hops: new Array(65).fill({ hop: 1 }) },
  ];
  for (const r of invalid) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(makeApp({ agentTokensRepo: agentToken() }))
      .post('/agents/probe-results').set('Authorization', 'Bearer t').send({ results: [r] });
    assert.equal(res.status, 400, JSON.stringify(r));
    assert.equal(res.body.error, 'Validation failed');
  }
});

test('a garbage verdict from the agent is dropped, not stored and not a 500', async () => {
  let stored;
  const probeResultsRepo = makeProbeResultsRepo({ createMany: async (_a, rows) => { stored = rows; return rows.length; } });
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({
      results: [{
        ...RESULT,
        path_mtu: 999999,
        mss_observed: -5,
        mtu_drop_at_hop: 'five',
        hops: [{ hop: 1, ip: '192.0.2.1', max_mtu: 999999, status: 'made-up' }],
      }],
    });
  assert.equal(res.status, 201);
  assert.equal(stored[0].mtu.pathMtu, null, 'a size no network could carry is not stored');
  assert.equal(stored[0].mtu.mssObserved, null);
  assert.equal(stored[0].mtu.mtuDropAtHop, null);
  assert.equal(stored[0].mtu.recommendedMss, null, 'no path MTU means no recommendation');
  assert.equal(stored[0].hops[0].status, null, 'an unrecognised hop status is dropped');
  assert.equal(stored[0].hops[0].maxMtu, null);
});

// ---------------------------------------------------------------- the round trip
test('a path-MTU result survives ingest, storage and read-back intact', async () => {
  let stored;
  const probeResultsRepo = makeProbeResultsRepo({ createMany: async (_a, rows) => { stored = rows; return rows.length; } });
  const post = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t').send({ results: [RESULT] });
  assert.equal(post.status, 201);

  const m = stored[0].mtu;
  assert.equal(m.pathMtu, 1420);
  assert.equal(m.blackholeDetected, true);
  assert.equal(m.icmpFragNeededSeen, false);
  assert.equal(m.mtuDropAtHop, 5);
  assert.equal(m.mssObserved, 1460);
  assert.equal(m.recommendedMss, 1380, 'recomputed from the stored path MTU, not taken on trust');
  assert.equal(m.durationMs, 8421);
  assert.deepEqual(stored[0].hops.map((h) => [h.hop, h.maxMtu, h.status]),
    [[4, 1500, 'ok'], [5, 1420, 'blackhole']]);

  // And it lands in the row the repository actually writes. Located by NAME:
  // a position is only correct until the next column is added, and `sizes`
  // (migration 097) is the one that proved it.
  const row = toRow(9, stored[0]);
  assert.equal(JSON.parse(row[COLUMNS.indexOf('mtu')]).pathMtu, 1420);
});

test('the agent cannot overrule the recommended MSS', async () => {
  let stored;
  const probeResultsRepo = makeProbeResultsRepo({ createMany: async (_a, rows) => { stored = rows; return rows.length; } });
  await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ ...RESULT, recommended_mss: 1 }] });
  assert.equal(stored[0].mtu.recommendedMss, 1380);

  let v6;
  const repo6 = makeProbeResultsRepo({ createMany: async (_a, rows) => { v6 = rows; return rows.length; } });
  await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo: repo6 }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ ...RESULT, ip_version: 6, path_mtu: 1400, recommended_mss: 9 }] });
  assert.equal(v6[0].mtu.recommendedMss, 1340, 'IPv6 subtracts 60, not 40');
});

test('only path_mtu rows carry an MTU verdict', async () => {
  let stored;
  const probeResultsRepo = makeProbeResultsRepo({ createMany: async (_a, rows) => { stored = rows; return rows.length; } });
  await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'ping', target: '1.1.1.1', ok: true, rttMs: 12, path_mtu: 1420, blackhole_detected: true }] });
  assert.equal(stored[0].mtu, null, 'a ping row must not acquire an MTU verdict from stray fields');
});

// ------------------------------------------------------------------- audit
test('starting a path-MTU test is written to the hash-chained audit log', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const res = await request(withAgent({ auditLogRepo, agentCommander: makeAgentCommander({ sendCommand: () => 1 }) }))
    .post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ ...SPEC, tcp_port: 25 });
  assert.equal(res.status, 202);
  const row = auditLogRepo.rows.find((x) => x.action === 'probe_start');
  assert.ok(row, `no probe_start row: ${JSON.stringify(auditLogRepo.rows.map((x) => x.action))}`);
  assert.equal(row.category, 'agent');
  assert.equal(row.outcome, 'success');
  assert.equal(row.actorRole, 'operator');
  assert.equal(row.target, 'agent:9');
  // The spec is recorded, so the trail says what was ASKED FOR, not merely that
  // something was.
  const detail = JSON.parse(row.detail);
  assert.equal(detail.type, 'path_mtu');
  assert.equal(detail.target, '10.20.30.40');
});

test('the audit trail stays a verifiable chain, and a refused probe writes nothing to it', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const app = withAgent({ auditLogRepo, agentCommander: makeAgentCommander({ sendCommand: () => 1 }) });
  // A viewer (403) and a bad spec (400) are not test starts.
  await request(app).post('/agents/9/probe').set('Authorization', authHeader('viewer')).send(SPEC);
  await request(app).post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ ...SPEC, max_size: 99999 });
  assert.equal(auditLogRepo.rows.filter((x) => x.action === 'probe_start').length, 0);

  await request(app).post('/agents/9/probe').set('Authorization', authHeader('operator')).send(SPEC);
  assert.equal(auditLogRepo.rows.filter((x) => x.action === 'probe_start').length, 1);
  assert.deepEqual(await auditLogRepo.verifyChain(), { ok: true, checked: 1, brokenAt: null });
});

test('an audit failure never costs the operator the probe', async () => {
  const auditLogRepo = makeAuditLogRepo({ record: throwingAsync('audit_log is unreachable') });
  const res = await request(withAgent({ auditLogRepo, agentCommander: makeAgentCommander({ sendCommand: () => 1 }) }))
    .post('/agents/9/probe').set('Authorization', authHeader('operator')).send(SPEC);
  assert.equal(res.status, 202);
});

// ------------------------------------------------------------------- delivery
test('409 when the agent is not connected — the probe is never silently dropped', async () => {
  const res = await request(withAgent({ agentCommander: makeAgentCommander({ sendCommand: () => 0 }) }))
    .post('/agents/9/probe').set('Authorization', authHeader('operator')).send(SPEC);
  assert.equal(res.status, 409);
  assert.equal(res.body.delivered, 0);
});

test('the command the agent receives carries the validated spec, defaults filled in', async () => {
  let sent;
  const agentCommander = makeAgentCommander({ sendCommand: (id, cmd) => { sent = { id, cmd }; return 1; } });
  await request(withAgent({ agentCommander })).post('/agents/9/probe')
    .set('Authorization', authHeader('operator')).send({ ...SPEC, per_hop: true, tcp_port: 25 });
  assert.equal(sent.cmd.name, 'run-probe');
  assert.deepEqual(sent.cmd.probe, {
    type: 'path_mtu', host: '10.20.30.40', ip_version: 4, min_size: 576, max_size: 1500, per_hop: true, tcp_port: 25,
  });
});
