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
