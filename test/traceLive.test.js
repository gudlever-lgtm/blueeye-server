'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// A traceroute that draws while it runs: the agent streams each hop over its
// WebSocket, the server relays it to the dashboard with geo, and tells the
// dashboard the moment the finished run lands — so a trace that outlives any
// poll window still shows up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentTokensRepo, makeAgentsRepo, makeProbeResultsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { describeLiveHop } = require('../src/analysis/pathGraph');
const { traceHopPayload } = require('../src/ws/agentSocket');

const geoProvider = { lookup: (ip) => (ip === '151.101.1.67' ? { country: 'US', asn: 54113, asnName: 'FASTLY' } : null) };
const centroids = new Map([['US', { lat: 39, lng: -98 }]]);

// ---- describeLiveHop -------------------------------------------------------

test('a public hop is geolocated at its country centroid', () => {
  const n = describeLiveHop({ hop: 9, ip: '151.101.1.67', rttMs: 98.4, lossPct: 0, jitterMs: 1 }, { geoProvider, centroids });
  assert.equal(n.hop, 9);
  assert.equal(n.country, 'US');
  assert.equal(n.asn, 54113);
  assert.equal(n.lat, 39);
  assert.equal(n.severity, 'ok');
});

test('a private hop is never geolocated', () => {
  const n = describeLiveHop({ hop: 1, ip: '192.168.1.1', rttMs: 1 }, { geoProvider: { lookup: () => { throw new Error('must not be asked'); } }, centroids });
  assert.equal(n.private, true);
  assert.equal(n.lat, null);
  assert.equal(n.country, null);
});

test('a silent hop is unresponsive with 100% loss, not an error', () => {
  const n = describeLiveHop({ hop: 4, ip: null, rttMs: null });
  assert.equal(n.unresponsive, true);
  assert.equal(n.lossPct, 100);
  assert.equal(n.label, '* * *');
});

test('a hop number out of range or a malformed hop is dropped', () => {
  assert.equal(describeLiveHop({ hop: 0 }), null);
  assert.equal(describeLiveHop({ hop: 65 }), null);
  assert.equal(describeLiveHop({ hop: 'x' }), null);
  assert.equal(describeLiveHop(null), null);
});

test('non-numeric measurements do not reach the browser', () => {
  const n = describeLiveHop({ hop: 2, ip: '<script>'.repeat(20), rttMs: 'fast', jitterMs: -3 });
  assert.equal(n.ip, null, 'an over-long address is dropped');
  assert.equal(n.rttMs, null);
  assert.equal(n.jitterMs, null);
});

// ---- traceHopPayload (the agent frame -> dashboard frame) -----------------

test('a valid trace_hop frame becomes a dashboard payload', () => {
  const p = traceHopPayload(9, { type: 'trace_hop', probeType: 'traceroute', target: 'us.cnn.com', hop: { hop: 3, ip: '10.0.0.1', rttMs: 4 } });
  assert.equal(p.agentId, 9);
  assert.equal(p.target, 'us.cnn.com');
  assert.equal(p.probeType, 'traceroute');
  assert.equal(p.node.hop, 3);
});

test('a trace_hop frame with a bad type, target or hop is dropped', () => {
  const hop = { hop: 1, ip: '10.0.0.1', rttMs: 1 };
  assert.equal(traceHopPayload(9, { probeType: 'ping', target: 'x', hop }), null);
  assert.equal(traceHopPayload(9, { probeType: 'traceroute', target: '', hop }), null);
  assert.equal(traceHopPayload(9, { probeType: 'traceroute', target: 'x'.repeat(256), hop }), null);
  assert.equal(traceHopPayload(9, { probeType: 'traceroute', target: 'x', hop: 'nope' }), null);
  assert.equal(traceHopPayload(9, { probeType: 'traceroute', target: 'x', hop: { hop: 99 } }), null);
});

test('a describer that throws drops the frame instead of breaking the socket', () => {
  const p = traceHopPayload(9, { probeType: 'traceroute', target: 'x', hop: { hop: 1 } }, () => { throw new Error('geo db gone'); });
  assert.equal(p, null);
});

// ---- POST /agents/probe-results tells the dashboard a trace landed ---------

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

test('a stored traceroute result is announced to the dashboard; a ping is not', async () => {
  const frames = [];
  const app = makeApp({
    agentTokensRepo: agentToken(),
    probeResultsRepo: makeProbeResultsRepo({ createMany: async (_id, rows) => rows.length }),
    notifyDashboard: (m) => { frames.push(m); return 1; },
  });
  const res = await request(app).post('/agents/probe-results').set('Authorization', 'Bearer t').send({ results: [
    { type: 'traceroute', target: 'us.cnn.com', ok: true, hops: [{ hop: 1, ip: '10.0.0.1', rttMs: 1 }] },
    { type: 'ping', target: '1.1.1.1', ok: true, rttMs: 3 },
  ] });
  assert.equal(res.status, 201);
  const announced = frames.filter((f) => f.type === 'probe-result');
  assert.equal(announced.length, 1);
  assert.deepEqual(announced[0].payload, { agentId: 9, type: 'traceroute', target: 'us.cnn.com', ok: true });
});

test('a failing dashboard notify does not fail the ingest', async () => {
  const app = makeApp({
    agentTokensRepo: agentToken(),
    probeResultsRepo: makeProbeResultsRepo({ createMany: async (_id, rows) => rows.length }),
    notifyDashboard: () => { throw new Error('socket hub down'); },
  });
  const res = await request(app).post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'traceroute', target: 'x.dk', ok: true, hops: [] }] });
  assert.equal(res.status, 201);
});

test('POST /agents/probe-results is 500 when the store fails', async () => {
  const app = makeApp({ agentTokensRepo: agentToken(), probeResultsRepo: makeProbeResultsRepo({ createMany: throwingAsync() }) });
  const res = await request(app).post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [{ type: 'traceroute', target: 'x.dk', ok: true, hops: [] }] });
  assert.equal(res.status, 500);
});

// ---- GET /api/probes/path carries the origin even before any run ---------

test('an empty path still carries the agent origin, so live hops can anchor', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h1', display_name: 'oslo-edge-01', location_lat: 59.9, location_lng: 10.7 }) });
  const res = await request(makeApp({ agentsRepo, probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => [] }) }))
    .get('/api/probes/path?agentId=9&target=us.cnn.com').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.nodes, []);
  assert.deepEqual(res.body.origin, { lat: 59.9, lng: 10.7, source: 'site', label: 'oslo-edge-01' });
});

test('GET /api/probes/path is 404 for an unknown agent and 500 when the store fails', async () => {
  const missing = await request(makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) }))
    .get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(missing.status, 404);
  const broken = await request(makeApp({
    agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h1' }) }),
    probeResultsRepo: makeProbeResultsRepo({ findByAgent: throwingAsync() }),
  })).get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(broken.status, 500);
});
