'use strict';

// The server half of the active DHCP test (blueeye-agent src/probes/dhcp.js):
// what may be dispatched, what is stored, and what the analysis makes of it —
// "no DHCP server answered" and "more than one did".

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentTokensRepo, makeAgentsRepo, makeProbeResultsRepo, makeAgentCommander, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { validateProbeSpec, validateProbeResults, PROBE_TYPES, MAX_DHCP_OFFERS } = require('../src/validation/probeValidation');
const { toRow, fromRow, COLUMNS, DIAGNOSTIC_TYPES } = require('../src/repositories/probeResultsRepository');
const { evaluateProbeFindings } = require('../src/analysis/probeFindings');
const { describeDhcp } = require('../src/analysis/probeFailure');
const { Severity } = require('../src/analysis/constants');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const withAgent = (overrides = {}) => makeApp({ agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h1' }) }), ...overrides });

const OFFER_A = { serverId: '192.168.1.1', offeredIp: '192.168.1.100', leaseSec: 86400, router: '192.168.1.1', dns: ['192.168.1.1', '9.9.9.9'], subnetMask: '255.255.255.0', relay: null };
const OFFER_B = { serverId: '192.168.1.66', offeredIp: '192.168.1.201', leaseSec: 600, router: '192.168.1.66', dns: ['192.168.1.66'], subnetMask: '255.255.255.0', relay: null };
// What agent 0.40 sends (src/probes/dhcp.js), verbatim in shape.
const agentResult = (over = {}) => ({
  ts: new Date().toISOString(), type: 'dhcp', target: 'eth0', ok: true, attempts: 1, success: 1,
  rttMs: 4.2, minMs: 4.2, maxMs: 6.1, jitterMs: null, lossPct: 0,
  iface: 'eth0', timeoutMs: 3000, offers: [OFFER_A], serverCount: 1, ...over,
});

// ---------------------------------------------------------------- the spec
test('a dhcp probe takes no host — only an optional interface and a bounded timeout', () => {
  assert.ok(PROBE_TYPES.includes('dhcp'));
  assert.deepEqual(validateProbeSpec({ type: 'dhcp' }).value, { type: 'dhcp' });
  assert.deepEqual(validateProbeSpec({ type: 'dhcp', iface: 'eth0', timeout_ms: 5000 }).value, { type: 'dhcp', iface: 'eth0', timeoutMs: 5000 });
  assert.equal(validateProbeSpec({ type: 'dhcp', iface: 'Ethernet 2' }).value.iface, 'Ethernet 2', 'a Windows adapter name');
  for (const iface of ['-rf', 'eth0;reboot', 'a'.repeat(80), '$(id)']) {
    assert.ok(validateProbeSpec({ type: 'dhcp', iface }).errors, iface);
  }
  for (const ms of [999, 10001, 'abc', 1500.5]) {
    assert.ok(validateProbeSpec({ type: 'dhcp', timeout_ms: ms }).errors, String(ms));
  }
});

// ---------------------------------------------------------------- the result
test('the dhcp block is copied field by field; addresses must be IPv4; serverCount is recomputed', () => {
  const { value } = validateProbeResults({
    results: [agentResult({
      offers: [
        { ...OFFER_A, invented: 'x' },
        { ...OFFER_B, router: 'not-an-ip', dns: ['192.168.1.66', 'junk', '::1'], leaseSec: -5 },
      ],
      serverCount: 1, // the agent's claim; the list says two
    })],
  });
  const d = value.results[0].dhcp;
  assert.equal(d.iface, 'eth0');
  assert.equal(d.timeoutMs, 3000);
  assert.equal(d.serverCount, 2, 'recomputed from the offers that survived');
  assert.equal(d.offers[0].invented, undefined);
  assert.equal(d.offers[1].router, null);
  assert.deepEqual(d.offers[1].dns, ['192.168.1.66']);
  assert.equal(d.offers[1].leaseSec, null);
  assert.equal(value.results[0].tls, null);
});

test('a dhcp test that could not RUN stores no block — silence and "could not listen" stay apart', () => {
  const { value } = validateProbeResults({
    results: [{ type: 'dhcp', target: 'eth0', ok: false, lossPct: 100, error: 'dhcp probe needs root or CAP_NET_BIND_SERVICE (port 68)' }],
  });
  assert.equal(value.results[0].dhcp, null);
  assert.equal(value.results[0].execError, 'dhcp probe needs root or CAP_NET_BIND_SERVICE (port 68)');
  const silent = validateProbeResults({ results: [agentResult({ ok: false, offers: [], serverCount: 0, rttMs: null })] });
  assert.deepEqual(silent.value.results[0].dhcp.offers, []);
  assert.equal(silent.value.results[0].dhcp.serverCount, 0);
});

test('offers are bounded, and serverCount must be a sane integer', () => {
  const many = Array.from({ length: MAX_DHCP_OFFERS + 1 }, (_, i) => ({ ...OFFER_A, serverId: `10.0.0.${i + 1}` }));
  assert.ok(validateProbeResults({ results: [agentResult({ offers: many })] }).errors);
  assert.ok(validateProbeResults({ results: [agentResult({ offers: 'x' })] }).errors);
  assert.ok(validateProbeResults({ results: [agentResult({ serverCount: 'two' })] }).errors);
  assert.ok(validateProbeResults({ results: [agentResult({ serverCount: -1 })] }).errors);
  // Another probe type cannot smuggle a dhcp block in.
  const ping = validateProbeResults({ results: [{ type: 'ping', target: '1.1.1.1', ok: true, offers: [OFFER_A] }] });
  assert.equal(ping.value.results[0].dhcp, null);
});

test('the repository writes and reads the dhcp column (migration 132)', () => {
  const { value } = validateProbeResults({ results: [agentResult({ offers: [OFFER_A, OFFER_B], serverCount: 2 })] });
  const row = toRow(9, value.results[0]);
  const rec = Object.fromEntries(COLUMNS.map((c, i) => [c, row[i]]));
  assert.deepEqual(JSON.parse(rec.dhcp), value.results[0].dhcp);
  const back = fromRow({ ...rec, id: 1, ts: new Date() });
  assert.equal(back.dhcp.serverCount, 2);
  assert.equal(fromRow({ ...rec, dhcp: null, id: 2, ts: new Date() }).dhcp, null);
  // A broadcast test of the segment is not an outage of the agent running it.
  assert.ok(DIAGNOSTIC_TYPES.includes('dhcp'));
});

// ---------------------------------------------------------------- the routes
test('POST /agents/:id/probe dispatches a dhcp test (202), refuses a bad interface (400), viewer 403, unknown agent 404', async () => {
  let sent;
  const agentCommander = makeAgentCommander({ sendCommand: (id, cmd) => { sent = cmd; return 1; } });
  const ok = await request(withAgent({ agentCommander })).post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ type: 'dhcp', iface: 'eth1' });
  assert.equal(ok.status, 202);
  assert.deepEqual(sent, { name: 'run-probe', probe: { type: 'dhcp', iface: 'eth1' } });
  const bad = await request(withAgent({ agentCommander })).post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ type: 'dhcp', iface: '-rf' });
  assert.equal(bad.status, 400);
  const viewer = await request(withAgent({ agentCommander })).post('/agents/9/probe').set('Authorization', authHeader('viewer')).send({ type: 'dhcp' });
  assert.equal(viewer.status, 403);
  const none = await request(makeApp()).post('/agents/9/probe').set('Authorization', authHeader('operator')).send({ type: 'dhcp' });
  assert.equal(none.status, 404);
  const anon = await request(withAgent({ agentCommander })).post('/agents/9/probe').send({ type: 'dhcp' });
  assert.equal(anon.status, 401);
});

test('POST /agents/probe-results stores a dhcp result (201), refuses a malformed one (400), 500 when storage fails', async () => {
  let captured;
  const probeResultsRepo = makeProbeResultsRepo({ createMany: async (agentId, results) => { captured = results; return results.length; } });
  const res = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [agentResult({ offers: [OFFER_A, OFFER_B], serverCount: 2 })] });
  assert.equal(res.status, 201);
  assert.equal(captured[0].dhcp.serverCount, 2);
  assert.equal(captured[0].dhcp.offers[1].serverId, '192.168.1.66');

  const bad = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [agentResult({ offers: { not: 'a list' } })] });
  assert.equal(bad.status, 400);

  const broken = await request(makeApp({ agentTokensRepo: agentToken(), probeResultsRepo: makeProbeResultsRepo({ createMany: throwingAsync() }) }))
    .post('/agents/probe-results').set('Authorization', 'Bearer t')
    .send({ results: [agentResult()] });
  assert.equal(broken.status, 500);
});

// ---------------------------------------------------------------- the findings
const at = new Date('2026-09-24T10:00:00Z');
const row = (over = {}, minsAgo = 0) => {
  const r = validateProbeResults({ results: [agentResult(over)] }).value.results[0];
  return { ...r, ts: new Date(at.getTime() - minsAgo * 60000).toISOString() };
};
const findingsFor = (rows) => evaluateProbeFindings(7, rows, { now: () => at });

test('no offer → a reachability finding naming the interface and the window; two silent runs in a row → CRIT', () => {
  const silent = { ok: false, offers: [], serverCount: 0, rttMs: null, lossPct: 100 };
  const one = findingsFor([row(silent, 0), row({}, 5)]).filter((f) => f.metric === 'probe.dhcp.no_offer');
  assert.equal(one.length, 1);
  assert.equal(one[0].severity, Severity.WARN);
  assert.match(one[0].explanation, /No DHCP server answered on eth0 within 3 s/);
  assert.equal(one[0].evidence[0].metric, 'reachability');
  assert.equal(one[0].evidence[0].target, 'eth0');

  const two = findingsFor([row(silent, 0), row(silent, 5), row({}, 10)]).filter((f) => f.metric === 'probe.dhcp.no_offer');
  assert.equal(two[0].severity, Severity.CRIT);
  assert.match(two[0].explanation, /2 tests in a row heard nothing/);
});

test('more than one server → a WARN naming every server and what it offered', () => {
  const f = findingsFor([row({ offers: [OFFER_A, OFFER_B], serverCount: 2 })]).filter((x) => x.metric === 'probe.dhcp.rogue');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, Severity.WARN);
  assert.equal(f[0].observed, 2);
  assert.match(f[0].explanation, /^2 DHCP servers answered on eth0: 192\.168\.1\.1, 192\.168\.1\.66 — a rogue or misconfigured DHCP server/);
  assert.match(f[0].explanation, /192\.168\.1\.66 \(offers 192\.168\.1\.201\/255\.255\.255\.0, router 192\.168\.1\.66/);
  assert.deepEqual(f[0].evidence[0].serverIds, ['192.168.1.1', '192.168.1.66']);
});

test('a healthy answer, a test that could not run, and the dhcp row itself never become a generic reachability finding', () => {
  assert.deepEqual(findingsFor([row()]), []);
  const notRun = validateProbeResults({ results: [{ type: 'dhcp', target: 'eth0', ok: false, lossPct: 100, error: 'dhcp probe needs root or CAP_NET_BIND_SERVICE (port 68)' }] }).value.results[0];
  const found = findingsFor([{ ...notRun, ts: at.toISOString() }]);
  assert.deepEqual(found, [], 'not measured is not "nobody answered", and not "target eth0 is down" either');
  // A silent DHCP test next to healthy pings: the ping verdict is untouched.
  const rows = [row({ ok: false, offers: [], serverCount: 0, rttMs: null, lossPct: 100 }), { type: 'ping', target: '10.0.0.1', ok: true, rttMs: 1, lossPct: 0, jitterMs: 0, ts: at.toISOString() }];
  assert.ok(findingsFor(rows).every((f) => f.metric.startsWith('probe.dhcp.')));
});

test('describeDhcp says nothing for a single server', () => {
  assert.equal(describeDhcp(row()), null);
  assert.equal(describeDhcp({ type: 'ping' }), null);
  assert.equal(describeDhcp(row({ offers: [OFFER_A, OFFER_B], serverCount: 2 })).kind, 'multiple_servers');
});
