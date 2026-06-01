'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRetentionScheduler } = require('../scheduler');

const config = { enabled: true, rawRetentionDays: 7, intervalHours: 24 };

test('runOnce runs rollup (flows + metrics) then purge, with the right beforeTs', async () => {
  const calls = [];
  const now = () => new Date('2026-06-08T00:00:00Z');
  const rollup = {
    rollupFlows: async (before) => { calls.push(['flows', before]); return { buckets: 1 }; },
    rollupMetrics: async (before) => { calls.push(['metrics', before]); return { buckets: 1 }; },
  };
  const purge = { purgeExpired: async () => { calls.push(['purge']); return {}; } };
  const s = createRetentionScheduler({ rollup, purge, config, now });
  const res = await s.runOnce();
  assert.deepEqual(calls.map((c) => c[0]), ['flows', 'metrics', 'purge']);
  // beforeTs = now - rawRetentionDays(7d) = 2026-06-01
  assert.equal(calls[0][1].toISOString(), '2026-06-01T00:00:00.000Z');
  assert.ok(res.flows && res.purged);
});

test('overlapping runs are skipped (re-entrancy guard)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const rollup = { rollupFlows: async () => { await gate; return {}; }, rollupMetrics: async () => ({}) };
  const purge = { purgeExpired: async () => ({}) };
  const s = createRetentionScheduler({ rollup, purge, config });

  const first = s.runOnce(); // starts, blocks on the gate
  const second = await s.runOnce(); // should be skipped while the first runs
  assert.equal(second, null);
  release();
  await first;
  // After the first finishes, a new run is allowed again.
  assert.notEqual(await s.runOnce(), null);
});

test('start() does nothing when retention is disabled', () => {
  let scheduled = false;
  const s = createRetentionScheduler({
    rollup: { rollupFlows: async () => { scheduled = true; }, rollupMetrics: async () => {} },
    purge: { purgeExpired: async () => {} },
    config: { ...config, enabled: false },
    intervalMs: 1,
  });
  s.start();
  s.stop();
  assert.equal(scheduled, false);
});
