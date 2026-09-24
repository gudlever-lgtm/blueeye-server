'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProbeOutageService } = require('../src/probeOutages/probeOutageService');
const { makeProbeOutagesRepo, makeProbeThresholdsRepo, makeProbeResultsRepo, makeAgentsRepo } = require('../test-support/fakes');

const base = Date.parse('2026-06-01T00:00:00Z');
const at = (m) => new Date(base + m * 60000);

// Builds a service whose probe repo replays the given rows (oldest-first) for the
// agent, with the agent assigned to location 7 by default.
function build(rows, opts = {}) {
  const probeOutagesRepo = opts.probeOutagesRepo || makeProbeOutagesRepo();
  const thresholdsRepo = opts.thresholdsRepo || makeProbeThresholdsRepo();
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h', location_id: opts.locationId ?? 7 }) });
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => rows.slice() });
  // Fix "now" well after the rows so the lookback window covers them.
  const svc = createProbeOutageService({ probeOutagesRepo, thresholdsRepo, agentsRepo, probeResultsRepo, now: () => at(60) });
  return { svc, probeOutagesRepo, thresholdsRepo };
}

test('opens a critical reachability outage after debounce, started_at = first failure', async () => {
  const rows = [
    { ts: at(0), target: '1.1.1.1', ok: false },
    { ts: at(1), target: '1.1.1.1', ok: false },
    { ts: at(2), target: '1.1.1.1', ok: false },
  ];
  const { svc, probeOutagesRepo } = build(rows);
  const res = await svc.processAgent(9);
  assert.equal(res.opened, 1);
  assert.equal(probeOutagesRepo.rows.length, 1);
  const inc = probeOutagesRepo.rows[0];
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
  const { svc, probeOutagesRepo } = build(rows);
  const res = await svc.processAgent(9);
  assert.equal(res.opened, 0);
  assert.equal(probeOutagesRepo.rows.length, 0);
});

test('no duplicate active outage when run twice on the same ongoing failure', async () => {
  const rows = [
    { ts: at(0), target: 'x', ok: false },
    { ts: at(1), target: 'x', ok: false },
    { ts: at(2), target: 'x', ok: false },
  ];
  const { svc, probeOutagesRepo } = build(rows);
  await svc.processAgent(9);
  await svc.processAgent(9); // second ingest, still failing
  assert.equal(probeOutagesRepo.rows.length, 1);
});

test('resolves the active outage when results return under threshold', async () => {
  const probeOutagesRepo = makeProbeOutagesRepo();
  // First pass: opens.
  let rows = [
    { ts: at(0), target: 'x', ok: false },
    { ts: at(1), target: 'x', ok: false },
    { ts: at(2), target: 'x', ok: false },
  ];
  let built = build(rows, { probeOutagesRepo });
  await built.svc.processAgent(9);
  assert.equal(probeOutagesRepo.rows[0].resolved_at, null);

  // Second pass: a recovery arrives at minute 3.
  rows = rows.concat([{ ts: at(3), target: 'x', ok: true }]);
  built = build(rows, { probeOutagesRepo });
  const res = await built.svc.processAgent(9);
  assert.equal(res.resolved, 1);
  const inc = probeOutagesRepo.rows[0];
  assert.equal(new Date(inc.resolved_at).toISOString(), at(3).toISOString());
  assert.equal(inc.duration_seconds, 180); // minute 0 -> minute 3 = 180s
});

test('latency warning and reachability critical produce two distinct outages', async () => {
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
  const { svc, probeOutagesRepo } = build(rows);
  await svc.processAgent(9);
  const byMetric = Object.fromEntries(probeOutagesRepo.rows.map((r) => [r.metric, r]));
  assert.equal(probeOutagesRepo.rows.length, 2);
  assert.equal(byMetric.latency.severity, 'warning');
  assert.equal(byMetric.latency.affected_target, 'A');
  assert.equal(byMetric.reachability.severity, 'critical');
  assert.equal(byMetric.reachability.affected_target, 'B');
});

test('a location override threshold wins over the global default', async () => {
  // Override latency for location 7 so 200ms is critical (warn 50 / crit 100).
  const thresholdsRepo = makeProbeThresholdsRepo();
  await thresholdsRepo.upsert({ location_id: 7, metric: 'latency', warning_value: 50, critical_value: 100, debounce_count: 3 });
  const rows = [
    { ts: at(0), target: 'A', ok: true, rttMs: 200 },
    { ts: at(1), target: 'A', ok: true, rttMs: 200 },
    { ts: at(2), target: 'A', ok: true, rttMs: 200 },
  ];
  const { svc, probeOutagesRepo } = build(rows, { thresholdsRepo });
  await svc.processAgent(9);
  assert.equal(probeOutagesRepo.rows.length, 1);
  assert.equal(probeOutagesRepo.rows[0].severity, 'critical'); // 200 >= override crit 100
});

test('escalates an active warning outage to critical within the same run', async () => {
  const probeOutagesRepo = makeProbeOutagesRepo();
  // First pass opens a latency WARNING (200ms, between warn 150 / crit 300).
  let rows = [
    { ts: at(0), target: 'A', ok: true, rttMs: 200 },
    { ts: at(1), target: 'A', ok: true, rttMs: 200 },
    { ts: at(2), target: 'A', ok: true, rttMs: 200 },
  ];
  await build(rows, { probeOutagesRepo }).svc.processAgent(9);
  assert.equal(probeOutagesRepo.rows[0].severity, 'warning');

  // Next samples cross critical (>=300) — same ongoing run, no recovery between.
  rows = rows.concat([{ ts: at(3), target: 'A', ok: true, rttMs: 350 }]);
  await build(rows, { probeOutagesRepo }).svc.processAgent(9);
  assert.equal(probeOutagesRepo.rows.length, 1); // still no duplicate
  assert.equal(probeOutagesRepo.rows[0].severity, 'critical'); // escalated
});

test('does not downgrade an active critical outage', async () => {
  const probeOutagesRepo = makeProbeOutagesRepo();
  let rows = [
    { ts: at(0), target: 'A', ok: true, rttMs: 350 },
    { ts: at(1), target: 'A', ok: true, rttMs: 350 },
    { ts: at(2), target: 'A', ok: true, rttMs: 350 },
  ];
  await build(rows, { probeOutagesRepo }).svc.processAgent(9);
  assert.equal(probeOutagesRepo.rows[0].severity, 'critical');
  // A later still-failing-but-only-warning sample must not downgrade it.
  rows = rows.concat([{ ts: at(3), target: 'A', ok: true, rttMs: 200 }]);
  await build(rows, { probeOutagesRepo }).svc.processAgent(9);
  assert.equal(probeOutagesRepo.rows[0].severity, 'critical');
});

test('resolves an active outage when the failing run has scrolled out of the window', async () => {
  const probeOutagesRepo = makeProbeOutagesRepo();
  // Seed an active outage whose outage predates the lookback window entirely.
  await probeOutagesRepo.open({
    location_id: 7, agent_id: 9, metric: 'reachability', severity: 'critical',
    started_at: at(-100), affected_target: 'gone',
  });
  // The window now only contains healthy samples for that target (no fail→pass
  // transition is replayed), so lastRecoveryAt is null — firstHealthyAt resolves it.
  const rows = [
    { ts: at(0), target: 'gone', ok: true },
    { ts: at(1), target: 'gone', ok: true },
  ];
  const res = await build(rows, { probeOutagesRepo }).svc.processAgent(9);
  assert.equal(res.resolved, 1);
  assert.equal(new Date(probeOutagesRepo.rows[0].resolved_at).toISOString(), at(0).toISOString());
});

test('unknown agent is a no-op', async () => {
  const probeOutagesRepo = makeProbeOutagesRepo();
  const thresholdsRepo = makeProbeThresholdsRepo();
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const probeResultsRepo = makeProbeResultsRepo();
  const svc = createProbeOutageService({ probeOutagesRepo, thresholdsRepo, agentsRepo, probeResultsRepo });
  const res = await svc.processAgent(123);
  assert.deepEqual(res, { opened: 0, resolved: 0 });
});

// ---- notifying (audit §8: outages were recorded and never dispatched) --------

const { createDeviceFindingSink } = require('../src/devices/findingSink');
const { createEventCaseService } = require('../src/eventCases/eventCaseService');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');
const { loadAlertingConfig } = require('../src/analysis/alerting/config');
const { makeFindingStore, makeEventCasesRepo, makeEventNotesRepo } = require('../test-support/fakes');

// The real notification path over fakes: sink → store/event case → dispatcher
// (automatic alerting with a configured syslog channel) → a recording channel.
function buildNotifying({ env = { ALERT_SYSLOG_ENABLED: 'true', SYSLOG_HOST: 'log.example.eu' }, silenced = false } = {}) {
  let rows = [];
  const probeOutagesRepo = makeProbeOutagesRepo();
  const findingStore = makeFindingStore();
  const eventCasesRepo = makeEventCasesRepo();
  const eventNotesRepo = makeEventNotesRepo();
  const sent = [];
  const config = loadAlertingConfig(env);
  const dispatcher = createDispatcher({ config, channels: { syslog: { send: async (f) => { sent.push(f); return { ok: true }; } } } });
  if (silenced) dispatcher.setSilencer(async () => ({ id: 'mw-1' }));
  const clock = { now: at(3) };
  const findingSink = createDeviceFindingSink({
    findingStore,
    eventCaseService: createEventCaseService({ eventCasesRepo, findingStore, now: () => clock.now }),
    dispatcher,
    alertingEnabled: () => config.enabled,
  });
  const svc = createProbeOutageService({
    probeOutagesRepo,
    thresholdsRepo: makeProbeThresholdsRepo(),
    agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h', location_id: 7 }) }),
    probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => rows.slice() }),
    findingSink, findingStore, dispatcher, eventNotesRepo,
    now: () => clock.now,
  });
  return { svc, probeOutagesRepo, findingStore, eventCasesRepo, eventNotesRepo, sent, clock, setRows: (r) => { rows = r; } };
}
const failing = [0, 1, 2].map((m) => ({ ts: at(m), target: 'erp.example.com', ok: false }));

test('an outage OPENING raises a finding (threshold + duration) in an event case, and alerts', async () => {
  const n = buildNotifying();
  n.setRows(failing);
  await n.svc.processAgent(9);
  assert.equal(n.findingStore.rows.length, 1);
  const f = n.findingStore.rows[0];
  assert.equal(f.metric, 'probe_outage.reachability');
  assert.equal(f.severity, 'CRIT');
  assert.equal(f.kind, 'THRESHOLD');
  assert.match(f.explanation, /reachability to erp\.example\.com/);
  assert.match(f.explanation, /threshold \(3 failed probes in a row\)/);
  assert.match(f.explanation, /3 min so far/);
  assert.equal(f.evidence[0].outageId, n.probeOutagesRepo.rows[0].id);
  assert.equal(f.evidence[0].threshold.debounce, 3);
  assert.equal(n.eventCasesRepo.rows.length, 1);
  assert.equal(f.eventCaseId, n.eventCasesRepo.rows[0].id);
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].metric, 'probe_outage.reachability');
  // Still failing on the next ingest: no second open, no second alert.
  await n.svc.processAgent(9);
  assert.equal(n.findingStore.rows.length, 1);
  assert.equal(n.sent.length, 1);
});

test('an outage CLOSING dispatches one recovery alert with the duration and notes it on the event case', async () => {
  const n = buildNotifying();
  n.setRows(failing);
  await n.svc.processAgent(9);
  n.setRows([...failing, { ts: at(20), target: 'erp.example.com', ok: true }]);
  n.clock.now = at(21);
  const res = await n.svc.processAgent(9);
  assert.equal(res.resolved, 1);
  assert.equal(n.sent.length, 2);
  const rec = n.sent[1];
  assert.equal(rec.kind, 'RECOVERED');
  assert.equal(rec.severity, 'CRIT'); // the outage's own, so it reaches the same channels
  assert.match(rec.explanation, /recovered at .* after 20 min \(critical; threshold 3 failed probes in a row\)/);
  assert.equal(rec.eventCaseId, n.eventCasesRepo.rows[0].id);
  const notes = await n.eventNotesRepo.listForEvent({ eventCaseId: rec.eventCaseId });
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Probe outage resolved/);
  assert.equal(notes[0].authorRole, 'system');
  // The recovery is not stored as a new fault.
  assert.equal(n.findingStore.rows.length, 1);
});

test('an escalation warning → critical raises again, at the new severity', async () => {
  const n = buildNotifying();
  const lat = (m, rttMs) => ({ ts: at(m), target: 'erp.example.com', ok: true, rttMs });
  n.setRows([lat(0, 200), lat(1, 200), lat(2, 200)]); // warning ≥150
  await n.svc.processAgent(9);
  n.setRows([lat(0, 200), lat(1, 200), lat(2, 200), lat(3, 400)]); // critical ≥300
  await n.svc.processAgent(9);
  const outageFindings = n.findingStore.rows.filter((f) => f.metric === 'probe_outage.latency');
  assert.deepEqual(outageFindings.map((f) => f.severity), ['WARN', 'CRIT']);
  assert.match(outageFindings[1].explanation, /escalated to critical/);
  assert.match(outageFindings[0].explanation, /warning ≥ 150 ms, critical ≥ 300 ms, 3 results in a row/);
});

test('alerting switched off: the outage is still a finding in an event case, nothing is sent (open or close)', async () => {
  const n = buildNotifying({ env: { ALERTING_ENABLED: 'false', ALERT_SYSLOG_ENABLED: 'true', SYSLOG_HOST: 'log.example.eu' } });
  n.setRows(failing);
  await n.svc.processAgent(9);
  n.setRows([...failing, { ts: at(20), target: 'erp.example.com', ok: true }]);
  await n.svc.processAgent(9);
  assert.equal(n.findingStore.rows.length, 1);
  assert.equal(n.eventCasesRepo.rows.length, 1);
  assert.equal(n.sent.length, 0);
});

test('a maintenance window silences both the opening and the recovery alert', async () => {
  const n = buildNotifying({ silenced: true });
  n.setRows(failing);
  await n.svc.processAgent(9);
  n.setRows([...failing, { ts: at(20), target: 'erp.example.com', ok: true }]);
  await n.svc.processAgent(9);
  assert.equal(n.findingStore.rows.length, 1, 'the finding is still recorded');
  assert.equal(n.sent.length, 0);
});

test('without a sink the service records outages exactly as before (no notification wired)', async () => {
  const { svc, probeOutagesRepo } = build(failing);
  const res = await svc.processAgent(9);
  assert.equal(res.opened, 1);
  assert.equal(probeOutagesRepo.rows.length, 1);
});

// ---- review round 2: diagnostics, one fault → one alert ----------------------

test('diagnostic probes (dhcp/tls/rdns/path_mtu) never open an outage, even when failing', async () => {
  const n = buildNotifying();
  const diag = [];
  for (const [type, target] of [['dhcp', 'eth0'], ['tls', 'erp.example.com:443'], ['rdns', '10.0.0.5'], ['path_mtu', 'erp.example.com']]) {
    for (const m of [0, 1, 2, 3]) diag.push({ ts: at(m), type, target, ok: false, lossPct: 100, rttMs: 900 });
  }
  n.setRows(diag);
  const res = await n.svc.processAgent(9);
  assert.equal(res.opened, 0);
  assert.equal(n.probeOutagesRepo.rows.length, 0);
  assert.equal(n.findingStore.rows.length, 0);
  assert.equal(n.sent.length, 0);
  // A real probe to the same host alongside still counts.
  n.setRows([...diag, ...[0, 1, 2].map((m) => ({ ts: at(m), type: 'ping', target: 'erp.example.com', ok: false }))]);
  assert.equal((await n.svc.processAgent(9)).opened, 1);
  assert.equal(n.probeOutagesRepo.rows[0].affected_target, 'erp.example.com');
});

test('an unreachable target opens ONE reachability outage, not a packet_loss outage on top', async () => {
  const n = buildNotifying();
  n.setRows([0, 1, 2].map((m) => ({ ts: at(m), type: 'ping', target: 'erp.example.com', ok: false, lossPct: 100 })));
  const res = await n.svc.processAgent(9);
  assert.equal(res.opened, 1);
  assert.deepEqual(n.probeOutagesRepo.rows.map((r) => r.metric), ['reachability']);
  assert.deepEqual(n.findingStore.rows.map((f) => f.metric), ['probe_outage.reachability']);
  assert.equal(n.sent.length, 1);
  // Lossy but reachable: packet_loss still opens on its own.
  const lossy = buildNotifying();
  lossy.setRows([0, 1, 2].map((m) => ({ ts: at(m), type: 'ping', target: 'erp.example.com', ok: true, lossPct: 40 })));
  await lossy.svc.processAgent(9);
  assert.deepEqual(lossy.probeOutagesRepo.rows.map((r) => r.metric), ['packet_loss']);
  assert.equal(lossy.sent.length, 1);
});

test('the probe pipeline already raised this agent + target: the outage finding is stored + event-cased but not alerted again; recovery still alerts', async () => {
  const n = buildNotifying();
  // What probePipeline stores for the same fault a minute earlier.
  await n.findingStore.save({
    id: 'p1', hostId: '9', metric: 'probe.reachability', severity: 'CRIT', kind: 'THRESHOLD',
    explanation: '1/1 probe target(s) not responding', evidence: [{ metric: 'reachability', target: 'erp.example.com' }],
    createdAt: at(2),
  });
  n.setRows(failing);
  await n.svc.processAgent(9);
  const outageFinding = n.findingStore.rows.find((f) => f.metric === 'probe_outage.reachability');
  assert.ok(outageFinding, 'the outage finding is still stored');
  assert.equal(outageFinding.eventCaseId, n.eventCasesRepo.rows[0].id, 'and grouped into an event case');
  assert.equal(n.sent.length, 0, 'no second alert for the same fault');
  // A pipeline finding on ANOTHER target does not suppress this one.
  const other = buildNotifying();
  await other.findingStore.save({
    id: 'p2', hostId: '9', metric: 'probe.reachability', severity: 'CRIT', kind: 'THRESHOLD',
    explanation: 'x', evidence: [{ metric: 'reachability', target: 'mail.example.com' }], createdAt: at(2),
  });
  other.setRows(failing);
  await other.svc.processAgent(9);
  assert.equal(other.sent.length, 1);
  // Nor does one older than the refire cooldown.
  const old = buildNotifying();
  old.clock.now = at(40);
  await old.findingStore.save({
    id: 'p3', hostId: '9', metric: 'probe.reachability', severity: 'CRIT', kind: 'THRESHOLD',
    explanation: 'x', evidence: [{ metric: 'reachability', target: 'erp.example.com' }], createdAt: at(2),
  });
  old.setRows(failing);
  await old.svc.processAgent(9);
  assert.equal(old.sent.length, 1);
  // The recovery alert on close is still sent.
  n.setRows([...failing, { ts: at(20), target: 'erp.example.com', ok: true }]);
  n.clock.now = at(21);
  await n.svc.processAgent(9);
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].kind, 'RECOVERED');
});
