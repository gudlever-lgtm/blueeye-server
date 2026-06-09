'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentTokensRepo, makeAgentsRepo, makeProbeResultsRepo, makeAgentCommander, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { validateProbeSpec, validateProbeResults } = require('../src/validation/probeValidation');
const { toRow } = require('../src/repositories/probeResultsRepository');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const withAgent = (overrides = {}) => makeApp({ agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h1' }) }), ...overrides });

// ---- ingest: POST /agents/probe-results (agent token) ---------------------

test('POST /agents/probe-results without a token is 401', async () => {
  const res = await request(makeApp()).post('/agents/probe-results').send({ results: [{ type: 'ping', target: 'x', ok: true }] });
  assert.equal(res.status, 401);
});

test('POST /agents/probe-results stores results (201)', async () => {
  let captured;
  const probeResultsRepo = makeProbeResultsRepo({ createMany: async (agentId, results) => { captured = { agentId, results }; return results.length; } });
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'ping', target: '1.1.1.1', ok: true, rttMs: 12.3, lossPct: 0 }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.inserted, 1);
  assert.equal(captured.agentId, 9);
  assert.equal(captured.results[0].type, 'ping');
});

test('POST /agents/probe-results rejects an invalid type (400)', async () => {
  const res = await request(makeApp({ agentTokensRepo: agentToken() }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'bogus', target: 'x' }] });
  assert.equal(res.status, 400);
});

// ---- trigger: POST /agents/:id/probe (operator) ---------------------------

test('POST /agents/:id/probe delivers a run-probe command (202)', async () => {
  let sent;
  const agentCommander = makeAgentCommander({ sendCommand: (id, cmd) => { sent = { id, cmd }; return 1; } });
  const res = await request(withAgent({ agentCommander }))
    .post('/agents/9/probe').set('Authorization', authHeader('operator'))
    .send({ type: 'tcp', host: 'example.com', port: 443 });
  assert.equal(res.status, 202);
  assert.equal(sent.cmd.name, 'run-probe');
  assert.equal(sent.cmd.probe.type, 'tcp');
  assert.equal(sent.cmd.probe.port, 443);
});

test('POST /agents/:id/probe is 409 when the agent is not connected', async () => {
  const agentCommander = makeAgentCommander({ sendCommand: () => 0 });
  const res = await request(withAgent({ agentCommander }))
    .post('/agents/9/probe').set('Authorization', authHeader('operator'))
    .send({ type: 'ping', host: '1.1.1.1' });
  assert.equal(res.status, 409);
});

test('POST /agents/:id/probe validates the spec (400) and is operator+ (403 viewer)', async () => {
  // tcp without a port.
  const bad = await request(withAgent()).post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ type: 'tcp', host: 'x' });
  assert.equal(bad.status, 400);
  const forbidden = await request(withAgent()).post('/agents/9/probe').set('Authorization', authHeader('viewer')).send({ type: 'ping', host: 'x' });
  assert.equal(forbidden.status, 403);
});

test('POST /agents/:id/probe is 404 for an unknown agent', async () => {
  const res = await request(makeApp()).post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ type: 'ping', host: '1.1.1.1' });
  assert.equal(res.status, 404);
});

// ---- query: GET /api/probes ------------------------------------------------

test('GET /api/probes returns the agent time series (200)', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async ({ agentId }) => [{ id: 1, agentId, type: 'ping', target: '1.1.1.1', ok: true, rttMs: 10 }] });
  const res = await request(withAgent({ probeResultsRepo })).get('/api/probes?agentId=9&type=ping').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].type, 'ping');
});

test('GET /api/probes requires agentId (400) and a real agent (404)', async () => {
  assert.equal((await request(withAgent()).get('/api/probes').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(makeApp()).get('/api/probes?agentId=9').set('Authorization', authHeader('viewer'))).status, 404);
});

test('GET /api/probes/latest returns the latest per target (200)', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ latestByAgent: async () => [{ id: 2, type: 'tcp', target: 'x:443', ok: true }] });
  const res = await request(withAgent({ probeResultsRepo })).get('/api/probes/latest?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].target, 'x:443');
});

test('GET /api/probes surfaces a repo failure as 500', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: throwingAsync('db down') });
  const res = await request(withAgent({ probeResultsRepo })).get('/api/probes?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

// ---- path graph: GET /api/probes/path -------------------------------------

const tracerouteRun = (ts, target = 'example.com') => ({
  id: 1, type: 'traceroute', target, ts,
  hops: [
    { hop: 1, ip: '10.0.0.1', sent: 3, recv: 3, lossPct: 0, rttMs: 1, jitterMs: 0.2 },
    { hop: 2, ip: '93.184.216.34', sent: 3, recv: 3, lossPct: 0, rttMs: 12, jitterMs: 1 },
  ],
});

test('GET /api/probes/path aggregates traceroutes into a hop graph (200) and enriches geo', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => [tracerouteRun('2026-06-09T10:00:00Z')] });
  const geoProvider = { lookup: (ip) => (ip === '93.184.216.34' ? { country: 'DE', asn: 64500, asnName: 'Example' } : null) };
  const centroids = { get: (c) => (c === 'DE' ? { lat: 51, lng: 10 } : null) };
  const res = await request(withAgent({ probeResultsRepo, geoProvider, centroids }))
    .get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.target, 'example.com');
  assert.equal(res.body.nodes.length, 3); // source + 2 hops
  assert.equal(res.body.nodes[0].kind, 'source');
  const dest = res.body.nodes[res.body.nodes.length - 1];
  assert.equal(dest.kind, 'dest');
  assert.equal(dest.country, 'DE');
  assert.equal(dest.asn, 64500);
  assert.equal(res.body.links.length, 2);
});

test('GET /api/probes/path requires agentId (400) and a real agent (404)', async () => {
  assert.equal((await request(withAgent()).get('/api/probes/path').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await request(makeApp()).get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'))).status, 404);
});

test('GET /api/probes/path returns an empty graph when there are no traceroutes', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => [] });
  const res = await request(withAgent({ probeResultsRepo })).get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.nodes, []);
  assert.equal(res.body.samples, 0);
});

// ---- validation + repo units ----------------------------------------------

test('validateProbeSpec requires a port for tcp and rejects flag-like hosts', () => {
  assert.ok(validateProbeSpec({ type: 'tcp', host: 'x' }).errors);
  assert.ok(validateProbeSpec({ type: 'ping', host: '-rf' }).errors); // option-injection guard
  assert.deepEqual(validateProbeSpec({ type: 'ping', host: '1.1.1.1' }).value, { type: 'ping', host: '1.1.1.1' });
});

test('validateProbeSpec rejects a present-but-invalid count/maxHops (no silent drop)', () => {
  assert.ok(validateProbeSpec({ type: 'ping', host: '1.1.1.1', count: 200 }).errors);
  assert.ok(validateProbeSpec({ type: 'ping', host: '1.1.1.1', count: 'abc' }).errors);
  assert.ok(validateProbeSpec({ type: 'traceroute', host: '1.1.1.1', maxHops: 99 }).errors);
  assert.equal(validateProbeSpec({ type: 'ping', host: '1.1.1.1', count: 5 }).value.count, 5);
});

test('findByAgent selects the most-recent N (DESC) and returns them oldest-first', async () => {
  const { createProbeResultsRepository } = require('../src/repositories/probeResultsRepository');
  let capturedSql;
  const pool = {
    async query(sql) {
      capturedSql = sql;
      // pool returns DESC (newest first); repo should reverse to ascending.
      return [[
        { id: 3, agent_id: 9, ts: new Date('2026-06-02T00:03:00Z'), type: 'ping', target: 'x', ok: 1 },
        { id: 2, agent_id: 9, ts: new Date('2026-06-02T00:02:00Z'), type: 'ping', target: 'x', ok: 1 },
        { id: 1, agent_id: 9, ts: new Date('2026-06-02T00:01:00Z'), type: 'ping', target: 'x', ok: 1 },
      ]];
    },
  };
  const repo = createProbeResultsRepository({ pool });
  const rows = await repo.findByAgent({ agentId: 9, type: 'ping', limit: 3 });
  assert.match(capturedSql, /ORDER BY ts DESC LIMIT/);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]); // reversed to ascending
});

test('validateProbeResults caps and normalises rows', () => {
  const { value, errors } = validateProbeResults({ results: [{ type: 'PING', target: '1.1.1.1', ok: true, rttMs: '12.5', hops: [{ hop: 1, ip: '10.0.0.1', rttMs: 1 }] }] });
  assert.equal(errors, undefined);
  assert.equal(value.results[0].type, 'ping');
  assert.equal(value.results[0].rttMs, 12.5);
  assert.equal(value.results[0].hops[0].ip, '10.0.0.1');
});

test('validateProbeResults carries MTR-style per-hop loss/jitter/sent/recv', () => {
  const { value, errors } = validateProbeResults({ results: [{ type: 'traceroute', target: 'x', ok: true,
    hops: [{ hop: 2, ip: '203.0.113.9', sent: 3, recv: 2, lossPct: 33.3, rttMs: 12, minMs: 10, maxMs: 14, jitterMs: 2 }] }] });
  assert.equal(errors, undefined);
  const h = value.results[0].hops[0];
  assert.equal(h.sent, 3);
  assert.equal(h.recv, 2);
  assert.equal(h.lossPct, 33.3);
  assert.equal(h.jitterMs, 2);
});

test('validateProbeSpec accepts a traceroute queries count and rejects out-of-range', () => {
  assert.equal(validateProbeSpec({ type: 'traceroute', host: '1.1.1.1', queries: 5 }).value.queries, 5);
  assert.ok(validateProbeSpec({ type: 'traceroute', host: '1.1.1.1', queries: 99 }).errors);
  assert.ok(validateProbeSpec({ type: 'traceroute', host: '1.1.1.1', queries: 'x' }).errors);
});

test('toRow serialises hops to JSON and maps fields positionally', () => {
  const row = toRow(9, { ts: new Date('2026-06-01T00:00:00Z'), type: 'traceroute', target: 'x', ok: true, rttMs: 5, hops: [{ hop: 1 }] });
  assert.equal(row[0], 9);
  assert.equal(row[2], 'traceroute');
  assert.equal(row[4], 1); // ok -> 1
  assert.equal(row[10], null); // status (not an http probe)
  assert.equal(row[11], null); // cert_expiry_days
  assert.equal(typeof row[12], 'string'); // hops JSON
});

test('toRow carries http status + cert expiry through to the row', () => {
  const row = toRow(9, { ts: new Date('2026-06-01T00:00:00Z'), type: 'http', target: 'https://x/', ok: true, rttMs: 5, status: 200, certExpiryDays: 30 });
  assert.equal(row[2], 'http');
  assert.equal(row[10], 200); // status
  assert.equal(row[11], 30); // cert_expiry_days
});

test('validateProbeSpec accepts an http URL target', () => {
  const { value, errors } = validateProbeSpec({ type: 'http', target: 'https://example.com/health' });
  assert.equal(errors, undefined);
  assert.equal(value.type, 'http');
  assert.equal(value.host, 'https://example.com/health');
});

test('validateProbeSpec defaults a bare http host to https and rejects bad input', () => {
  assert.equal(validateProbeSpec({ type: 'http', target: 'example.com' }).value.host, 'https://example.com/');
  assert.ok(validateProbeSpec({ type: 'http', target: 'ftp://example.com' }).errors); // wrong scheme
  assert.ok(validateProbeSpec({ type: 'http' }).errors); // missing target
});

test('validateProbeResults accepts http status + certExpiryDays', () => {
  const { value, errors } = validateProbeResults({ results: [{ type: 'http', target: 'https://x/', ok: true, status: 200, certExpiryDays: 30 }] });
  assert.equal(errors, undefined);
  assert.equal(value.results[0].status, 200);
  assert.equal(value.results[0].certExpiryDays, 30);
});
