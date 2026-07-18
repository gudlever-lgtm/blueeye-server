'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeProbeResultsRepo, makeResultsRepo, makeSpeedtestResultsRepo, makeSettingsService, authHeader, throwingAsync } = require('../test-support/fakes');
const { computeAgentHealth, computeFleet, mergeHealth, mergeConnection, robustStats } = require('../src/health/probeHealth');
const { interfaceHealthSummary } = require('../src/health/interfaceHealth');

// A traffic payload with a single interface, overridable per test.
function trafficWithIface(over = {}) {
  return { elapsedSec: 5, interfaces: [{ iface: 'eth0', rxBytesPerSec: 0, txBytesPerSec: 0, ...over }] };
}

const NOW = Date.parse('2026-06-02T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// Builds rows (newest-first) for one (type,target): the first rtt is the latest.
function samples(target, rtts, { ok = true, lossPct = 0, jitterMs = 2, type = 'ping', ageMs = 1000 } = {}) {
  return rtts.map((rttMs, i) => ({ ts: ago(ageMs + i * 60000), type, target, ok, rttMs, lossPct, jitterMs }));
}

// ---- robust statistics -----------------------------------------------------

test('robustStats returns median + MAD and ignores non-finite values', () => {
  const s = robustStats([8, 9, 9, 10, 10, 11, 11, 12, null, NaN]);
  assert.equal(s.n, 8);
  assert.equal(s.median, 10);
  assert.equal(s.mad, 1); // |x-10| medians to 1
});

// ---- per-agent verdicts ----------------------------------------------------

test('computeAgentHealth is "unknown" with no data', () => {
  const h = computeAgentHealth([], { now: NOW });
  assert.equal(h.status, 'unknown');
  assert.equal(h.metrics.targets, 0);
});

test('computeAgentHealth is "ok" for reachable, low-loss, stable targets', () => {
  const h = computeAgentHealth(samples('1.1.1.1', [10, 11, 9, 10]), { now: NOW });
  assert.equal(h.status, 'ok');
  assert.equal(h.metrics.reachable, 1);
  assert.equal(h.metrics.lossPct, 0);
});

test('computeAgentHealth flags elevated latency vs the target\'s own baseline (warn)', () => {
  // baseline ~10 ms (MAD 1), latest 16 ms ⇒ robust z ≈ 4 ⇒ warn.
  const h = computeAgentHealth(samples('gw', [16, 11, 9, 10, 12, 8, 11, 9, 10]), { now: NOW });
  assert.equal(h.status, 'warn');
  assert.ok(h.evidence.some((e) => e.metric === 'latency'));
  assert.ok(h.metrics.latencyZ >= 3 && h.metrics.latencyZ < 6);
});

test('computeAgentHealth is "bad" on heavy packet loss', () => {
  const h = computeAgentHealth(samples('8.8.8.8', [20, 21, 19], { lossPct: 25 }), { now: NOW });
  assert.equal(h.status, 'bad');
  assert.equal(h.evidence[0].metric, 'loss');
  assert.equal(h.metrics.lossPct, 25);
});

test('computeAgentHealth is "down" when every target is unreachable', () => {
  const rows = [...samples('a', [0], { ok: false }), ...samples('b', [0], { ok: false, type: 'tcp' })];
  const h = computeAgentHealth(rows, { now: NOW });
  assert.equal(h.status, 'down');
  assert.equal(h.metrics.unreachable, 2);
});

test('computeAgentHealth downgrades a healthy-but-old verdict to "stale"', () => {
  const h = computeAgentHealth(samples('1.1.1.1', [10, 10, 10], { ageMs: 20 * 60 * 1000 }), { now: NOW });
  assert.equal(h.status, 'stale');
});

// ---- fleet rollup ----------------------------------------------------------

test('computeFleet sorts worst-first and counts a summary', () => {
  const agents = [
    { id: 1, hostname: 'ok-host', status: 'online' },
    { id: 2, hostname: 'down-host', status: 'online' },
    { id: 3, hostname: 'loss-host', status: 'online' },
  ];
  const byAgent = {
    1: samples('1.1.1.1', [10, 10, 10]),
    2: samples('x', [0], { ok: false }),
    3: samples('8.8.8.8', [20, 20], { lossPct: 30 }),
  };
  const { agents: fleet, summary } = computeFleet(agents, byAgent, { now: NOW });
  assert.deepEqual(fleet.map((a) => a.health.status), ['down', 'bad', 'ok']);
  assert.equal(summary.total, 3);
  assert.equal(summary.down, 1);
  assert.equal(summary.bad, 1);
  assert.equal(summary.ok, 1);
});

test('computeFleet surfaces each agent location (id + name) for per-location scoping', () => {
  const agents = [
    { id: 1, hostname: 'hq', status: 'online', location_id: 4, location_name: 'Copenhagen HQ' },
    { id: 2, hostname: 'unassigned', status: 'online' },
  ];
  const { agents: fleet } = computeFleet(agents, {}, { now: NOW });
  const a1 = fleet.find((a) => a.agentId === 1);
  assert.equal(a1.locationId, 4);
  assert.equal(a1.locationName, 'Copenhagen HQ');
  const a2 = fleet.find((a) => a.agentId === 2);
  assert.equal(a2.locationId, null); // null-safe when an agent has no location
  assert.equal(a2.locationName, null);
});

// ---- interface folding -----------------------------------------------------

test('interfaceHealthSummary reduces to the worst interface (null when no data)', () => {
  assert.equal(interfaceHealthSummary({ interfaces: [] }), null);
  assert.equal(interfaceHealthSummary(null), null);
  const bad = interfaceHealthSummary(trafficWithIface({ rxErrors: 5 }));
  assert.equal(bad.status, 'bad');
  assert.equal(bad.worst.iface, 'eth0');
  assert.equal(interfaceHealthSummary(trafficWithIface({ rxDrop: 5 })).status, 'warn');
  assert.equal(interfaceHealthSummary(trafficWithIface({ operStatus: 'down' })).status, 'down');
});

test('a down virtual/idle interface does not escalate the agent verdict (was CRITICAL on docker0)', () => {
  const probeOk = computeAgentHealth(samples('1.1.1.1', [10, 10, 10]), { now: NOW });
  // An agent whose only "down" interface is the idle docker0 bridge.
  const summary = interfaceHealthSummary({ elapsedSec: 5, interfaces: [
    { iface: 'docker0', operStatus: 'down', rxBytesPerSec: 0, txBytesPerSec: 0 },
    { iface: 'eth0', operStatus: 'up', rxBytesPerSec: 0, txBytesPerSec: 0 },
  ] });
  assert.equal(summary.status, 'ok'); // worst interface is ok — docker0 idle doesn't count
  const merged = mergeHealth(probeOk, summary);
  assert.equal(merged.status, 'ok'); // agent stays HEALTHY, not CRITICAL
});

test('mergeHealth folds the interface signal into the probe verdict', () => {
  const probeOk = computeAgentHealth(samples('1.1.1.1', [10, 10, 10]), { now: NOW });
  const probeUnknown = computeAgentHealth([], { now: NOW });
  const probeLoss = computeAgentHealth(samples('8.8.8.8', [20, 20], { lossPct: 30 }), { now: NOW });
  const ifaceBad = interfaceHealthSummary(trafficWithIface({ rxErrors: 5 }));
  const ifaceWarn = interfaceHealthSummary(trafficWithIface({ rxDrop: 5 }));
  const ifaceOk = interfaceHealthSummary(trafficWithIface({}));

  // ok probe + bad interface ⇒ bad, and the interface is the headline.
  const a = mergeHealth(probeOk, ifaceBad);
  assert.equal(a.status, 'bad');
  assert.equal(a.evidence[0].metric, 'interface');
  assert.equal(a.metrics.ifaceStatus, 'bad');

  // no probes at all but interface warns ⇒ warn (not 'unknown').
  assert.equal(mergeHealth(probeUnknown, ifaceWarn).status, 'warn');

  // a worse probe signal stays the headline; the interface is kept as evidence.
  const c = mergeHealth(probeLoss, ifaceOk);
  assert.equal(c.status, 'bad');
  assert.equal(c.evidence[0].metric, 'loss');

  // no interface data ⇒ the probe verdict is returned unchanged.
  assert.equal(mergeHealth(probeOk, null), probeOk);
});

test('mergeHealth: a healthy interface never manufactures a HEALTHY verdict from no probe data', () => {
  // Regression: an agent with no probe rows but a (possibly stale) OK interface
  // reading used to read HEALTHY ("Interfaces healthy."), masking that we can't
  // actually vouch for reachability/loss/latency.
  const probeUnknown = computeAgentHealth([], { now: NOW });
  const ifaceOk = interfaceHealthSummary(trafficWithIface({}));
  const merged = mergeHealth(probeUnknown, ifaceOk);
  assert.equal(merged.status, 'unknown'); // NOT 'ok'
  assert.notEqual(merged.reason, 'Interfaces healthy.'); // not the health headline
  assert.equal(merged.metrics.ifaceStatus, 'ok'); // still surfaced as evidence

  // A healthy probe verdict with a healthy interface stays HEALTHY.
  const probeOk = computeAgentHealth(samples('1.1.1.1', [10, 10, 10]), { now: NOW });
  assert.equal(mergeHealth(probeOk, ifaceOk).status, 'ok');
});

// ---- connection folding ----------------------------------------------------

test('mergeConnection: a disconnected agent never reads HEALTHY', () => {
  const probeOk = computeAgentHealth(samples('1.1.1.1', [10, 10, 10]), { now: NOW });
  const offline = mergeConnection(probeOk, true);
  assert.equal(offline.status, 'stale');
  assert.match(offline.reason, /disconnected/i);
  assert.equal(offline.evidence[0].metric, 'connection');
  assert.equal(offline.metrics.online, false);

  // online (or unknown) ⇒ verdict unchanged.
  assert.equal(mergeConnection(probeOk, false), probeOk);
});

test('mergeConnection: a real problem stays the headline when disconnected', () => {
  const probeLoss = computeAgentHealth(samples('8.8.8.8', [20, 20], { lossPct: 30 }), { now: NOW });
  const offline = mergeConnection(probeLoss, true);
  assert.equal(offline.status, 'bad'); // loss is worse than the disconnection floor
  assert.equal(offline.evidence[0].metric, 'loss'); // loss still leads
  assert.ok(offline.evidence.some((e) => e.metric === 'connection')); // disconnect kept as evidence
});

test('computeFleet folds a disconnected agent so a fresh-but-offline agent is not HEALTHY', () => {
  const agents = [
    { id: 1, hostname: 'online-ok', status: 'online' },
    { id: 2, hostname: 'offline-ok', status: 'offline' },
  ];
  const byAgent = {
    1: samples('1.1.1.1', [10, 10, 10]),
    2: samples('1.1.1.1', [10, 10, 10]),
  };
  const { agents: fleet } = computeFleet(agents, byAgent, { now: NOW });
  assert.equal(fleet.find((a) => a.agentId === 1).health.status, 'ok');
  assert.equal(fleet.find((a) => a.agentId === 2).health.status, 'stale'); // offline ⇒ not HEALTHY
});

test('GET /api/fleet/agent/:id downgrades an offline agent from HEALTHY', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h', status: 'offline' }) });
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => samples('1.1.1.1', [10, 10, 10]).reverse() });
  const res = await request(makeApp({ agentsRepo, probeResultsRepo })).get('/api/fleet/agent/9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.health.status, 'stale');
  assert.match(res.body.health.reason, /disconnected/i);
});

// ---- route: GET /api/fleet/health -----------------------------------------

test('GET /api/fleet/health returns a worst-first rollup (200)', async () => {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 9, hostname: 'a9', status: 'online' }, { id: 10, hostname: 'a10', status: 'online' }] });
  const probeResultsRepo = makeProbeResultsRepo({ fleetHealth: async () => samples('8.8.8.8', [30, 31], { lossPct: 40 }).map((r) => ({ ...r, agentId: 9 })) });
  const res = await request(makeApp({ agentsRepo, probeResultsRepo })).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.total, 2);
  const a9 = res.body.agents.find((a) => a.agentId === 9);
  assert.equal(a9.health.status, 'bad');
  const a10 = res.body.agents.find((a) => a.agentId === 10);
  assert.equal(a10.health.status, 'unknown'); // no probe rows
});

test('GET /api/fleet/health folds interface health in — no probes + iface errors ⇒ bad', async () => {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 5, hostname: 'a5', status: 'online' }] });
  const resultsRepo = makeResultsRepo({ latestPerAgent: async () => [{ agent_id: 5, payload: { traffic: trafficWithIface({ rxErrors: 5 }) }, created_at: new Date(NOW) }] });
  const res = await request(makeApp({ agentsRepo, resultsRepo })).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const a5 = res.body.agents.find((a) => a.agentId === 5);
  assert.equal(a5.health.status, 'bad'); // would be 'unknown' without the interface fold
  assert.equal(a5.health.metrics.ifaceStatus, 'bad');
});

test('GET /api/fleet/health attaches per-agent data-quality (netflow drops ⇒ flagged)', async () => {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 7, hostname: 'a7', status: 'online', capabilities: { agentVersion: '0.2.0' } }] });
  const resultsRepo = makeResultsRepo({ latestPerAgent: async () => [{ agent_id: 7, created_at: new Date(), payload: { finishedAt: new Date().toISOString(), traffic: { source: 'netflow', packets: 90, droppedPackets: 10 } } }] });
  const res = await request(makeApp({ agentsRepo, resultsRepo })).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const a7 = res.body.agents.find((a) => a.agentId === 7);
  assert.equal(a7.quality.status, 'bad'); // 10% drop
  assert.equal(a7.quality.version, '0.2.0');
});

test('GET /api/fleet/agent/:id includes a data-quality verdict', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h', capabilities: { agentVersion: '0.2.0' } }) });
  const resultsRepo = makeResultsRepo({ findByAgentId: async () => [{ created_at: new Date(), payload: { finishedAt: new Date().toISOString(), traffic: { source: 'proc', interfaces: [] } } }] });
  const res = await request(makeApp({ agentsRepo, resultsRepo })).get('/api/fleet/agent/9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.quality.version, '0.2.0');
  assert.equal(res.body.quality.status, 'ok');
});

test('GET /api/fleet/health folds throughput when enabled and flags a slow agent', async () => {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 8, hostname: 'a8', status: 'online' }] });
  const speedtestResultsRepo = makeSpeedtestResultsRepo({ latestPerAgent: async () => [{ agent_id: 8, ts: new Date(NOW), ok: 1, down_mbps: 10, up_mbps: 5 }] });
  const settingsService = makeSettingsService({ initial: { throughput: { enabled: true, downBadMbps: 50, downWarnMbps: 100 } } });
  const res = await request(makeApp({ agentsRepo, speedtestResultsRepo, settingsService })).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const a8 = res.body.agents.find((a) => a.agentId === 8);
  assert.equal(a8.health.status, 'bad'); // 10 Mbps < downBad 50
  assert.equal(a8.health.metrics.throughputStatus, 'bad');
  assert.equal(a8.throughput.downMbps, 10);
});

test('GET /api/fleet/health surfaces throughput but does not flag when thresholds are off', async () => {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [{ id: 8, hostname: 'a8', status: 'online' }] });
  const speedtestResultsRepo = makeSpeedtestResultsRepo({ latestPerAgent: async () => [{ agent_id: 8, ts: new Date(NOW), ok: 1, down_mbps: 10, up_mbps: 5 }] });
  const res = await request(makeApp({ agentsRepo, speedtestResultsRepo })).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  const a8 = res.body.agents.find((a) => a.agentId === 8);
  assert.equal(a8.throughput.downMbps, 10); // shown
  assert.equal(a8.health.status, 'unknown'); // not flagged (throughput disabled by default)
});

test('GET /api/fleet/agent/:id includes throughput and folds it when enabled', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h' }) });
  const speedtestResultsRepo = makeSpeedtestResultsRepo({ findByAgent: async () => [{ ts: new Date(NOW), ok: 1, down_mbps: 5, up_mbps: 1 }] });
  const settingsService = makeSettingsService({ initial: { throughput: { enabled: true, downBadMbps: 50 } } });
  const res = await request(makeApp({ agentsRepo, speedtestResultsRepo, settingsService })).get('/api/fleet/agent/9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.throughput.downMbps, 5);
  assert.equal(res.body.health.status, 'bad');
});

// A mixed fleet: 1 critical (heavy loss ⇒ bad), 1 warning (elevated latency),
// 1 healthy, 1 offline-with-no-probes (⇒ unknown). Reused by the severity tests.
function mixedFleet() {
  const agentsRepo = makeAgentsRepo({ findAll: async () => [
    { id: 1, hostname: 'a1', status: 'online' },
    { id: 3, hostname: 'a3', status: 'online' },
    { id: 4, hostname: 'a4', status: 'online' },
    { id: 5, hostname: 'a5', status: 'offline' },
  ] });
  const rows = [
    ...samples('8.8.8.8', [30, 31], { lossPct: 40 }).map((r) => ({ ...r, agentId: 1 })),   // bad
    ...samples('gw', [16, 11, 9, 10, 12, 8, 11, 9, 10]).map((r) => ({ ...r, agentId: 3 })), // warn
    ...samples('1.1.1.1', [10, 10, 10]).map((r) => ({ ...r, agentId: 4 })),                 // ok
    // agent 5: no probe rows ⇒ unknown; its offline status feeds summary.offline.
  ];
  const probeResultsRepo = makeProbeResultsRepo({ fleetHealth: async () => rows });
  return { agentsRepo, probeResultsRepo };
}

test('GET /api/fleet/health summary carries per-status counts + an offline count', async () => {
  const res = await request(makeApp(mixedFleet())).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.total, 4);
  assert.equal(res.body.summary.bad, 1);       // loss-driven — clock-independent
  assert.equal(res.body.summary.warn, 1);      // latency-z-driven — clock-independent
  assert.equal(res.body.summary.offline, 1);   // agent 5 is offline (connection state)
  assert.equal(res.body.agents.length, 4);     // unfiltered ⇒ whole fleet
});

test('GET /api/fleet/health?severity=CRIT narrows agents to bad/down, keeps a full summary', async () => {
  const res = await request(makeApp(mixedFleet())).get('/api/fleet/health?severity=CRIT').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agents.map((a) => a.agentId).sort(), [1]);
  assert.ok(res.body.agents.every((a) => a.health.status === 'bad' || a.health.status === 'down'));
  assert.equal(res.body.summary.total, 4); // summary stays whole-fleet so the cards stay honest
});

test('GET /api/fleet/health?severity=CRIT,WARN combines statuses (OR within severity)', async () => {
  const res = await request(makeApp(mixedFleet())).get('/api/fleet/health?severity=CRIT,WARN').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agents.map((a) => a.agentId).sort(), [1, 3]);
});

test('GET /api/fleet/health tolerates an invalid severity (200 + whole fleet, not 400/500)', async () => {
  for (const q of ['?severity=BOGUS', '?severity=', '?severity=crit;drop', '?severity=,,']) {
    const res = await request(makeApp(mixedFleet())).get(`/api/fleet/health${q}`).set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 200, `expected 200 for ${q}`);
    assert.equal(res.body.agents.length, 4, `expected the whole fleet for ${q}`);
  }
});

test('GET /api/fleet/health requires auth (401) and surfaces a repo failure (500)', async () => {
  assert.equal((await request(makeApp()).get('/api/fleet/health')).status, 401);
  const probeResultsRepo = makeProbeResultsRepo({ fleetHealth: throwingAsync('db down') });
  const res = await request(makeApp({ probeResultsRepo })).get('/api/fleet/health').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('GET /api/fleet/agent/:id returns one agent verdict (200) and validates id (400/404)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h9', display_name: 'H9' }) });
  // findByAgent is oldest-first; the route reverses to newest-first for the verdict.
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => samples('8.8.8.8', [20, 21], { lossPct: 30 }).reverse() });
  const ok = await request(makeApp({ agentsRepo, probeResultsRepo })).get('/api/fleet/agent/9').set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.agentId, 9);
  assert.equal(ok.body.health.status, 'bad');

  const bad = await request(makeApp({ agentsRepo })).get('/api/fleet/agent/abc').set('Authorization', authHeader('viewer'));
  assert.equal(bad.status, 400);
  const missing = await request(makeApp()).get('/api/fleet/agent/9').set('Authorization', authHeader('viewer'));
  assert.equal(missing.status, 404);
});

test('probeResultsRepository.fleetHealth selects a recent window, newest-first, capped', async () => {
  const { createProbeResultsRepository } = require('../src/repositories/probeResultsRepository');
  let captured;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return [[{ agent_id: 9, ts: new Date('2026-06-02T11:59:00Z'), type: 'ping', target: 'x', ok: 1, rtt_ms: 12, jitter_ms: 1, loss_pct: 0 }]];
    },
  };
  const repo = createProbeResultsRepository({ pool });
  const rows = await repo.fleetHealth({ windowMs: 3600000, limit: 100 });
  assert.match(captured.sql, /WHERE ts >= \? ORDER BY ts DESC LIMIT \?/);
  assert.ok(captured.params[0] instanceof Date);
  assert.equal(captured.params[1], 100);
  assert.deepEqual(rows[0], { agentId: 9, ts: '2026-06-02T11:59:00.000Z', type: 'ping', target: 'x', ok: true, rttMs: 12, jitterMs: 1, lossPct: 0 });
});

test('GET /api/fleet/health passes a windowMin through to the repo', async () => {
  let captured;
  const probeResultsRepo = makeProbeResultsRepo({ fleetHealth: async (opts) => { captured = opts; return []; } });
  const res = await request(makeApp({ probeResultsRepo })).get('/api/fleet/health?windowMin=30').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.windowMin, 30);
  assert.equal(captured.windowMs, 30 * 60 * 1000);
});
