'use strict';

// Validates the app-layer join pattern that replaces cross-store SQL JOINs
// after the MySQL → TimescaleDB split. No real TSDB connection needed: the
// TSDB repositories are replaced by in-memory fakes, mirroring the shape that
// the real resultsRepository TSDB variant will expose.
//
// Pattern under test:
//   1. Fetch agent metadata (id, hostname, locationId) from MySQL (fake).
//   2. Fetch latest telemetry rows from TSDB (fake, simulating last() aggregate).
//   3. Join in JS on agent_id → enriched rows with static + time-series fields.
//
// Edge cases: agent with no telemetry (must appear with null telemetry fields),
// TSDB unavailable (must surface as a 503/500, not a silent empty response).

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── helpers that mirror the future app-layer join logic ─────────────────────

// Joins agent metadata (static/MySQL) with latest telemetry rows (TSDB).
// In the real implementation this lives in the service that powers the
// fleet-health dashboard panel.
function joinLatestPerAgent(agents, telemetryRows) {
  const byAgentId = new Map(telemetryRows.map((r) => [r.agentId, r]));
  return agents.map((a) => {
    const t = byAgentId.get(a.id) ?? null;
    return {
      agentId: a.id,
      hostname: a.hostname,
      locationId: a.locationId,
      payload: t ? t.payload : null,
      lastTs: t ? t.lastTs : null,
    };
  });
}

// Fake TSDB repo simulating the `last(payload, ts)` aggregate result.
function makeTsdbResultsRepo(overrides = {}) {
  return {
    // Returns [{ agentId, payload, lastTs }] — one row per agent, latest sample.
    latestPerAgent: overrides.latestPerAgent || (async () => []),
  };
}

// Fake MySQL agents repo.
function makeMysqlAgentsRepo(rows = []) {
  return {
    findAll: async () => rows,
  };
}

// ── tests ───────────────────────────────────────────────────────────────

test('join: agents with telemetry are enriched correctly', async () => {
  const agents = [
    { id: 1, hostname: 'sw-01', locationId: 7 },
    { id: 2, hostname: 'sw-02', locationId: 7 },
  ];
  const telemetry = [
    { agentId: 1, payload: { rxBytesPerSec: 1000 }, lastTs: '2026-07-02T10:00:00Z' },
    { agentId: 2, payload: { rxBytesPerSec: 2000 }, lastTs: '2026-07-02T10:00:05Z' },
  ];
  const result = joinLatestPerAgent(agents, telemetry);
  assert.equal(result.length, 2);
  assert.equal(result[0].hostname, 'sw-01');
  assert.equal(result[0].payload.rxBytesPerSec, 1000);
  assert.equal(result[1].hostname, 'sw-02');
  assert.equal(result[1].payload.rxBytesPerSec, 2000);
});

test('join: agent with no telemetry entry appears with null payload and lastTs', async () => {
  const agents = [
    { id: 1, hostname: 'sw-01', locationId: 7 },
    { id: 2, hostname: 'new-agent', locationId: 7 },
  ];
  const telemetry = [
    { agentId: 1, payload: { rxBytesPerSec: 500 }, lastTs: '2026-07-02T10:00:00Z' },
  ];
  const result = joinLatestPerAgent(agents, telemetry);
  const noData = result.find((r) => r.agentId === 2);
  assert.ok(noData, 'Agent with no telemetry must still appear in the result');
  assert.equal(noData.payload, null);
  assert.equal(noData.lastTs, null);
  assert.equal(noData.hostname, 'new-agent');
});

test('join: empty agent list produces empty result', async () => {
  const result = joinLatestPerAgent([], [{ agentId: 99, payload: {}, lastTs: 'x' }]);
  assert.deepEqual(result, []);
});

test('join: extra telemetry rows for unknown agents are silently ignored', async () => {
  const agents = [{ id: 1, hostname: 'sw-01', locationId: 7 }];
  const telemetry = [
    { agentId: 1, payload: { rxBytesPerSec: 100 }, lastTs: '2026-07-02T10:00:00Z' },
    { agentId: 99, payload: { rxBytesPerSec: 999 }, lastTs: '2026-07-02T10:00:00Z' },
  ];
  const result = joinLatestPerAgent(agents, telemetry);
  assert.equal(result.length, 1);
  assert.equal(result[0].agentId, 1);
});

test('TSDB unavailable: latestPerAgent throws → caller surfaces the error', async () => {
  const tsdbRepo = makeTsdbResultsRepo({
    latestPerAgent: async () => { throw new Error('TSDB connection refused'); },
  });
  const agentsRepo = makeMysqlAgentsRepo([{ id: 1, hostname: 'sw-01', locationId: 7 }]);

  await assert.rejects(
    async () => {
      const agents = await agentsRepo.findAll();
      const telemetry = await tsdbRepo.latestPerAgent({ since: '5 minutes' });
      return joinLatestPerAgent(agents, telemetry);
    },
    /TSDB connection refused/,
  );
});

test('TSDB returns empty (no data written yet): all agents appear with null telemetry', async () => {
  const tsdbRepo = makeTsdbResultsRepo({ latestPerAgent: async () => [] });
  const agents = [
    { id: 1, hostname: 'sw-01', locationId: 7 },
    { id: 2, hostname: 'sw-02', locationId: 8 },
  ];
  const agentsRepo = makeMysqlAgentsRepo(agents);

  const allAgents = await agentsRepo.findAll();
  const telemetry = await tsdbRepo.latestPerAgent({ since: '5 minutes' });
  const result = joinLatestPerAgent(allAgents, telemetry);

  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.payload === null), 'All rows must have null payload when TSDB is empty');
});

// Latency note (not a unit test — requires real TimescaleDB):
// The latestPerAgent query against TimescaleDB uses:
//
//   SELECT agent_id, last(payload, ts) AS payload, last(ts, ts) AS last_ts
//   FROM results
//   WHERE ts >= now() - interval '5 minutes'
//   GROUP BY agent_id;
//
// With the hypertable partitioned on `ts` (chunk_time_interval = 1h), this
// query hits at most 1 chunk for a 5-minute window, regardless of fleet size.
// Benchmark target: < 50 ms for 2600 agents on commodity hardware.
// Run manually: node bench/latestPerAgent.bench.js (created when TSDB is wired).
