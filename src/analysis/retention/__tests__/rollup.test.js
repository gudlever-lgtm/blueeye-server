'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRollup } = require('../rollup');

// A fake retention repo that actually stores/deletes, so idempotency is real.
function fakeRepo(init = {}) {
  const state = {
    rawFlows: (init.rawFlows || []).slice(),
    rawResults: (init.rawResults || []).slice(),
    flowRollups: [],
    metricRollups: [],
  };
  return {
    state,
    getRawExternalFlowsBatch: async (beforeTs, afterId, limit) =>
      state.rawFlows
        .filter((r) => r.country && r.ts < beforeTs && r.id > afterId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit),
    insertFlowRollups: async (rows) => { for (const r of rows) state.flowRollups.push(r); return rows.length; },
    deleteRawFlowsBefore: async (beforeTs) => {
      const before = state.rawFlows.length;
      state.rawFlows = state.rawFlows.filter((r) => !(r.ts < beforeTs));
      return before - state.rawFlows.length;
    },
    getRawResultsBatch: async (beforeTs, afterId, limit) =>
      state.rawResults
        .filter((r) => r.created_at < beforeTs && r.id > afterId)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit),
    insertMetricRollups: async (rows) => { for (const r of rows) state.metricRollups.push(r); return rows.length; },
    deleteRawResultsBefore: async (beforeTs) => {
      const before = state.rawResults.length;
      state.rawResults = state.rawResults.filter((r) => !(r.created_at < beforeTs));
      return before - state.rawResults.length;
    },
  };
}

const BUCKET = new Date('2026-01-01T00:00:00Z');
const BEFORE = new Date('2026-02-01T00:00:00Z');
const cfg = { rollupIntervalMinutes: 60, batchSize: 100 };

function flow(id, bytes, over = {}) {
  return { id, agent_id: 9, ts: new Date('2026-01-01T00:30:00Z'), direction: 'out', country: 'US', asn: 15169, asn_name: 'GOOGLE', bytes, packets: 1, flows: 1, ...over };
}

test('rollupFlows aggregates a bucket and deletes the raw rows it covered', async () => {
  const repo = fakeRepo({ rawFlows: [flow(1, 100), flow(2, 200), flow(3, 300)] });
  const rollup = createRollup({ repo, config: cfg });
  const res = await rollup.rollupFlows(BEFORE);
  assert.equal(res.buckets, 1);
  assert.equal(res.rawDeleted, 3);
  assert.equal(repo.state.rawFlows.length, 0);
  const r = repo.state.flowRollups[0];
  // columns: [bucket, agent_id, direction, country, asn, asn_name, bytes, packets, flow_count, min, max, median]
  assert.equal(r[6], 600); // bytes summed
  assert.equal(r[9], 100); // min
  assert.equal(r[10], 300); // max
  assert.equal(r[11], 200); // median
});

test('a repeated rollupFlows run does not double-count (idempotent)', async () => {
  const repo = fakeRepo({ rawFlows: [flow(1, 100), flow(2, 200)] });
  const rollup = createRollup({ repo, config: cfg });
  await rollup.rollupFlows(BEFORE);
  const second = await rollup.rollupFlows(BEFORE);
  assert.equal(second.buckets, 0); // nothing left to aggregate
  assert.equal(repo.state.flowRollups.length, 1); // still just the first bucket
  assert.equal(repo.state.flowRollups[0][6], 300);
});

test('only flows older than beforeTs are rolled up', async () => {
  const recent = flow(3, 999, { ts: new Date('2026-02-15T00:00:00Z') }); // after the cutoff -> within retention
  const repo = fakeRepo({ rawFlows: [flow(1, 100), recent] });
  const rollup = createRollup({ repo, config: cfg });
  await rollup.rollupFlows(BEFORE);
  assert.equal(repo.state.rawFlows.length, 1); // the recent one stays
  assert.equal(repo.state.rawFlows[0].id, 3);
});

test('rollupMetrics extracts metrics from payloads and discards raw results', async () => {
  const payload = { system: { cpuPercent: 50, memUsedPercent: 60, loadavg: [1.5, 1, 1], uptimeSec: 100 }, traffic: { totals: { rxBytesPerSec: 10, txBytesPerSec: 20 } } };
  const repo = fakeRepo({ rawResults: [
    { id: 1, agent_id: 9, payload, created_at: new Date('2026-01-01T00:10:00Z') },
    { id: 2, agent_id: 9, payload: { system: { cpuPercent: 70 } }, created_at: new Date('2026-01-01T00:20:00Z') },
  ] });
  const rollup = createRollup({ repo, config: cfg });
  const res = await rollup.rollupMetrics(BEFORE);
  assert.ok(res.buckets >= 1);
  assert.equal(repo.state.rawResults.length, 0);
  // cpu had two samples (50, 70) in the same hourly bucket.
  const cpu = repo.state.metricRollups.find((r) => r[2] === 'cpu');
  assert.equal(cpu[3], 2); // samples
  assert.equal(cpu[4], 50); // min
  assert.equal(cpu[5], 70); // max
});
