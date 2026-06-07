'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIncidentService } = require('../src/incidents/incidentService');
const { makeIncidentsRepo, makeIncidentThresholdsRepo, makeProbeResultsRepo, makeAgentsRepo } = require('../test-support/fakes');

const base = Date.parse('2026-06-01T00:00:00Z');
const at = (m) => new Date(base + m * 60000);

// Builds a service whose probe repo replays the given rows (oldest-first) for the
// agent, with the agent assigned to location 7 by default.
function build(rows, opts = {}) {
  const incidentsRepo = opts.incidentsRepo || makeIncidentsRepo();
  const thresholdsRepo = opts.thresholdsRepo || makeIncidentThresholdsRepo();
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h', location_id: opts.locationId ?? 7 }) });
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => rows.slice() });
  // Fix "now" well after the rows so the lookback window covers them.
  const svc = createIncidentService({ incidentsRepo, thresholdsRepo, agentsRepo, probeResultsRepo, now: () => at(60) });
  return { svc, incidentsRepo, thresholdsRepo };
}

test('opens a critical reachability incident after debounce, started_at = first failure', async () => {
  const rows = [
    { ts: at(0), target: '1.1.1.1', ok: false },
    { ts: at(1), target: '1.1.1.1', ok: false },
    { ts: at(2), target: '1.1.1.1', ok: false },
  ];
  const { svc, incidentsRepo } = build(rows);
  const res = await svc.processAgent(9);
  assert.equal(res.opened, 1);
  assert.equal(incidentsRepo.rows.length, 1);
  const inc = incidentsRepo.rows[0];
  assert.equal(inc.metric, 'reachability');
  assert.equal(inc.severity, 'critical');
  assert.equal(inc.location_id, 7);
  assert.equal(inc.affected_target, '1.1.1.1');
  assert.equal(new Date(inc.started_at).toISOString(), at(0).toISOString());
  assert.equal(inc.resolved_at, null);
});

test('does not open before debounce_count is reached', async () => {
  const rows = [
    { ts: at(0), target: 'x', ok: false },
    { ts: at(1), target: 'x', ok: false },
  ];
  const { svc, incidentsRepo } = build(rows);
  const res = await svc.processAgent(9);
  assert.equal(res.opened, 0);
  assert.equal(incidentsRepo.rows.length, 0);
});

test('no duplicate active incident when run twice on the same ongoing failure', async () => {
  const rows = [
    { ts: at(0), target: 'x', ok: false },
    { ts: at(1), target: 'x', ok: false },
    { ts: at(2), target: 'x', ok: false },
  ];
  const { svc, incidentsRepo } = build(rows);
  await svc.processAgent(9);
  await svc.processAgent(9); // second ingest, still failing
  assert.equal(incidentsRepo.rows.length, 1);
});

test('resolves the active incident when results return under threshold', async () => {
  const incidentsRepo = makeIncidentsRepo();
  // First pass: opens.
  let rows = [
    { ts: at(0), target: 'x', ok: false },
    { ts: at(1), target: 'x', ok: false },
    { ts: at(2), target: 'x', ok: false },
  ];
  let built = build(rows, { incidentsRepo });
  await built.svc.processAgent(9);
  assert.equal(incidentsRepo.rows[0].resolved_at, null);

  // Second pass: a recovery arrives at minute 3.
  rows = rows.concat([{ ts: at(3), target: 'x', ok: true }]);
  built = build(rows, { incidentsRepo });
  const res = await built.svc.processAgent(9);
  assert.equal(res.resolved, 1);
  const inc = incidentsRepo.rows[0];
  assert.equal(new Date(inc.resolved_at).toISOString(), at(3).toISOString());
  assert.equal(inc.duration_seconds, 180); // minute 0 -> minute 3 = 180s
});

test('latency warning and reachability critical produce two distinct incidents', async () => {
  const rows = [
    // target A: sustained latency between warn(150) and crit(300) => warning
    { ts: at(0), target: 'A', ok: true, rttMs: 200 },
    { ts: at(1), target: 'A', ok: true, rttMs: 210 },
    { ts: at(2), target: 'A', ok: true, rttMs: 205 },
    // target B: unreachable => critical
    { ts: at(0), target: 'B', ok: false },
    { ts: at(1), target: 'B', ok: false },
    { ts: at(2), target: 'B', ok: false },
  ];
  const { svc, incidentsRepo } = build(rows);
  await svc.processAgent(9);
  const byMetric = Object.fromEntries(incidentsRepo.rows.map((r) => [r.metric, r]));
  assert.equal(incidentsRepo.rows.length, 2);
  assert.equal(byMetric.latency.severity, 'warning');
  assert.equal(byMetric.latency.affected_target, 'A');
  assert.equal(byMetric.reachability.severity, 'critical');
  assert.equal(byMetric.reachability.affected_target, 'B');
});

test('a location override threshold wins over the global default', async () => {
  // Override latency for location 7 so 200ms is critical (warn 50 / crit 100).
  const thresholdsRepo = makeIncidentThresholdsRepo();
  await thresholdsRepo.upsert({ location_id: 7, metric: 'latency', warning_value: 50, critical_value: 100, debounce_count: 3 });
  const rows = [
    { ts: at(0), target: 'A', ok: true, rttMs: 200 },
    { ts: at(1), target: 'A', ok: true, rttMs: 200 },
    { ts: at(2), target: 'A', ok: true, rttMs: 200 },
  ];
  const { svc, incidentsRepo } = build(rows, { thresholdsRepo });
  await svc.processAgent(9);
  assert.equal(incidentsRepo.rows.length, 1);
  assert.equal(incidentsRepo.rows[0].severity, 'critical'); // 200 >= override crit 100
});

test('escalates an active warning incident to critical within the same run', async () => {
  const incidentsRepo = makeIncidentsRepo();
  // First pass opens a latency WARNING (200ms, between warn 150 / crit 300).
  let rows = [
    { ts: at(0), target: 'A', ok: true, rttMs: 200 },
    { ts: at(1), target: 'A', ok: true, rttMs: 200 },
    { ts: at(2), target: 'A', ok: true, rttMs: 200 },
  ];
  await build(rows, { incidentsRepo }).svc.processAgent(9);
  assert.equal(incidentsRepo.rows[0].severity, 'warning');

  // Next samples cross critical (>=300) — same ongoing run, no recovery between.
  rows = rows.concat([{ ts: at(3), target: 'A', ok: true, rttMs: 350 }]);
  await build(rows, { incidentsRepo }).svc.processAgent(9);
  assert.equal(incidentsRepo.rows.length, 1); // still no duplicate
  assert.equal(incidentsRepo.rows[0].severity, 'critical'); // escalated
});

test('does not downgrade an active critical incident', async () => {
  const incidentsRepo = makeIncidentsRepo();
  let rows = [
    { ts: at(0), target: 'A', ok: true, rttMs: 350 },
    { ts: at(1), target: 'A', ok: true, rttMs: 350 },
    { ts: at(2), target: 'A', ok: true, rttMs: 350 },
  ];
  await build(rows, { incidentsRepo }).svc.processAgent(9);
  assert.equal(incidentsRepo.rows[0].severity, 'critical');
  // A later still-failing-but-only-warning sample must not downgrade it.
  rows = rows.concat([{ ts: at(3), target: 'A', ok: true, rttMs: 200 }]);
  await build(rows, { incidentsRepo }).svc.processAgent(9);
  assert.equal(incidentsRepo.rows[0].severity, 'critical');
});

test('resolves an active incident when the failing run has scrolled out of the window', async () => {
  const incidentsRepo = makeIncidentsRepo();
  // Seed an active incident whose outage predates the lookback window entirely.
  await incidentsRepo.open({
    location_id: 7, agent_id: 9, metric: 'reachability', severity: 'critical',
    started_at: at(-100), affected_target: 'gone',
  });
  // The window now only contains healthy samples for that target (no fail→pass
  // transition is replayed), so lastRecoveryAt is null — firstHealthyAt resolves it.
  const rows = [
    { ts: at(0), target: 'gone', ok: true },
    { ts: at(1), target: 'gone', ok: true },
  ];
  const res = await build(rows, { incidentsRepo }).svc.processAgent(9);
  assert.equal(res.resolved, 1);
  assert.equal(new Date(incidentsRepo.rows[0].resolved_at).toISOString(), at(0).toISOString());
});

test('unknown agent is a no-op', async () => {
  const incidentsRepo = makeIncidentsRepo();
  const thresholdsRepo = makeIncidentThresholdsRepo();
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const probeResultsRepo = makeProbeResultsRepo();
  const svc = createIncidentService({ incidentsRepo, thresholdsRepo, agentsRepo, probeResultsRepo });
  const res = await svc.processAgent(123);
  assert.deepEqual(res, { opened: 0, resolved: 0 });
});
