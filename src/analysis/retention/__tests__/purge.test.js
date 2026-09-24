'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPurge } = require('../purge');

const NOW = new Date('2026-06-01T00:00:00Z');
const config = { rollupRetentionDays: 90, findingRetentionDays: 365 };

// Fake repo whose finding purge enforces the real rule: only acked + old rows.
function fakeRepo(findings) {
  const state = { findings: findings.slice(), flowRollupCut: null, metricRollupCut: null };
  return {
    state,
    purgeFlowRollupsBefore: async (ts) => { state.flowRollupCut = ts; return 5; },
    purgeMetricRollupsBefore: async (ts) => { state.metricRollupCut = ts; return 3; },
    purgeAckedFindingsBefore: async (ts) => {
      const before = state.findings.length;
      state.findings = state.findings.filter((f) => !(f.acked === 1 && new Date(f.created_at) < ts));
      return before - state.findings.length;
    },
  };
}

test('purgeExpired removes expired rollups using the right cutoffs', async () => {
  const repo = fakeRepo([]);
  const purge = createPurge({ repo, config, now: () => NOW });
  const res = await purge.purgeExpired();
  assert.equal(res.flowRollups, 5);
  assert.equal(res.metricRollups, 3);
  // rollup cutoff = now - 90d
  assert.equal(repo.state.flowRollupCut.toISOString(), new Date(NOW.getTime() - 90 * 864e5).toISOString());
});

test('purgeExpired removes config snapshots older than configSnapshotRetentionDays', async () => {
  let cut = null;
  const repo = {
    purgeFlowRollupsBefore: async () => 0,
    purgeMetricRollupsBefore: async () => 0,
    purgeAckedFindingsBefore: async () => 0,
    purgeConfigSnapshotsBefore: async (ts) => { cut = ts; return 4; },
  };
  const purge = createPurge({ repo, config: { ...config, configSnapshotRetentionDays: 180 }, now: () => NOW });
  const res = await purge.purgeExpired();
  assert.equal(res.configSnapshots, 4);
  assert.equal(cut.toISOString(), new Date(NOW.getTime() - 180 * 864e5).toISOString());
});

test('config-snapshot purge is skipped when the repo/config lacks the dimension', async () => {
  // The original fakeRepo has no purgeConfigSnapshotsBefore and config has no
  // configSnapshotRetentionDays — purgeExpired must not throw.
  const purge = createPurge({ repo: fakeRepo([]), config, now: () => NOW });
  const res = await purge.purgeExpired();
  assert.equal(res.configSnapshots, 0);
});

test('burst runs are purged on their own, longer window', async () => {
  // A burst is a measurement somebody chose to take, not a stream, so it is
  // kept longer than the telemetry around it and gets its own cutoff.
  let cut = null;
  const repo = {
    purgeFlowRollupsBefore: async () => 0,
    purgeMetricRollupsBefore: async () => 0,
    purgeAckedFindingsBefore: async () => 0,
    purgeBurstRunsBefore: async (ts) => { cut = ts; return 2; },
  };
  const purge = createPurge({ repo, config: { ...config, burstRunRetentionDays: 90 }, now: () => NOW });
  const res = await purge.purgeExpired();
  assert.equal(res.burstRuns, 2);
  assert.equal(cut.toISOString(), new Date(NOW.getTime() - 90 * 864e5).toISOString());
});

test('the burst purge is skipped when the repo/config lacks the dimension', async () => {
  const purge = createPurge({ repo: fakeRepo([]), config, now: () => NOW });
  assert.equal((await purge.purgeExpired()).burstRuns, 0);
});

test('purge deletes old ACKED findings but NEVER an unacknowledged CRIT', async () => {
  const old = new Date('2024-01-01T00:00:00Z'); // way past findingRetentionDays
  const repo = fakeRepo([
    { id: 'a', acked: 1, severity: 'WARN', created_at: old }, // old + acked -> deleted
    { id: 'b', acked: 0, severity: 'CRIT', created_at: old }, // old + UNACKED CRIT -> kept
    { id: 'c', acked: 0, severity: 'INFO', created_at: old }, // old + unacked -> kept
    { id: 'd', acked: 1, severity: 'CRIT', created_at: NOW }, // recent acked -> kept
  ]);
  const purge = createPurge({ repo, config, now: () => NOW });
  const res = await purge.purgeExpired();
  assert.equal(res.findings, 1);
  const ids = repo.state.findings.map((f) => f.id).sort();
  assert.deepEqual(ids, ['b', 'c', 'd']);
  assert.ok(repo.state.findings.some((f) => f.id === 'b'), 'unacked CRIT must survive purge');
});

test('the tables that used to grow forever are purged, each on its own window', async () => {
  const cuts = {};
  const record = (name, n) => async (ts) => { cuts[name] = ts; return n; };
  const repo = {
    purgeFlowRollupsBefore: async () => 0,
    purgeMetricRollupsBefore: async () => 0,
    purgeAckedFindingsBefore: async () => 0,
    purgeInternalFlowRollupsBefore: record('internal', 11),
    purgeProbeResultsBefore: record('probe', 1),
    purgeResolvedProbeOutagesBefore: record('outage', 2),
    purgeSpeedtestResultsBefore: record('speed', 3),
    purgeTransactionResultsBefore: record('tx', 4),
    purgeTopologyChangesBefore: record('topo', 5),
    purgeStaleDiscoveredDevicesBefore: record('disc', 6),
    purgeHostConnectionsBefore: record('conn', 7),
    purgeKnownDevicesBefore: record('known', 9),
    purgeAuditEventsBefore: record('audit', 8),
  };
  const days = {
    probeResultRetentionDays: 400, probeOutageRetentionDays: 401, speedtestRetentionDays: 365,
    transactionResultRetentionDays: 90, topologyChangeRetentionDays: 180, discoveredDeviceRetentionDays: 91,
    hostConnectionRetentionDays: 30, knownDeviceRetentionDays: 400, auditEventRetentionDays: 366,
  };
  const res = await createPurge({ repo, config: { ...config, ...days }, now: () => NOW }).purgeExpired();
  assert.deepEqual(
    [res.internalFlowRollups, res.probeResults, res.probeOutages, res.speedtestResults, res.transactionResults,
      res.topologyChanges, res.discoveredDevices, res.hostConnections, res.knownDevices, res.auditEvents],
    [11, 1, 2, 3, 4, 5, 6, 7, 9, 8],
  );
  const ago = (d) => new Date(NOW.getTime() - d * 864e5).toISOString();
  assert.equal(cuts.internal.toISOString(), ago(90)); // shares the rollup window
  assert.equal(cuts.probe.toISOString(), ago(400));
  assert.equal(cuts.outage.toISOString(), ago(401));
  assert.equal(cuts.speed.toISOString(), ago(365));
  assert.equal(cuts.tx.toISOString(), ago(90));
  assert.equal(cuts.topo.toISOString(), ago(180));
  assert.equal(cuts.disc.toISOString(), ago(91));
  assert.equal(cuts.conn.toISOString(), ago(30));
  assert.equal(cuts.known.toISOString(), ago(400));
  assert.equal(cuts.audit.toISOString(), ago(366));
});

test('a window of 0 keeps that table (e.g. RETENTION_AUDIT_EVENT_DAYS=0 keeps audit_events forever)', async () => {
  let called = false;
  const repo = { ...fakeRepo([]), purgeAuditEventsBefore: async () => { called = true; return 1; } };
  const res = await createPurge({ repo, config: { ...config, auditEventRetentionDays: 0 }, now: () => NOW }).purgeExpired();
  assert.equal(called, false);
  assert.equal(res.auditEvents, 0);
});

test('the new dimensions are skipped when the repo lacks them (older wiring)', async () => {
  const res = await createPurge({ repo: fakeRepo([]), config: { ...config, probeResultRetentionDays: 30 }, now: () => NOW }).purgeExpired();
  assert.equal(res.probeResults, 0);
  assert.equal(res.internalFlowRollups, 0);
});
