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

test('start() runs once shortly after boot, then on the interval (it used to wait a whole interval)', async () => {
  const runs = [];
  const s = createRetentionScheduler({
    rollup: { rollupFlows: async () => { runs.push('run'); return {}; }, rollupMetrics: async () => ({}) },
    purge: { purgeExpired: async () => ({}) },
    config,
    intervalMs: 60 * 60 * 1000, // far away: only the boot run can fire in this test
    startupDelayMs: 5,
  });
  s.start();
  await new Promise((r) => setTimeout(r, 40));
  s.stop();
  assert.deepEqual(runs, ['run']);
});

test('the boot run defaults to config.startupDelaySeconds and stop() cancels it', async () => {
  let ran = false;
  const s = createRetentionScheduler({
    rollup: { rollupFlows: async () => { ran = true; return {}; }, rollupMetrics: async () => ({}) },
    purge: { purgeExpired: async () => ({}) },
    config: { ...config, startupDelaySeconds: 0.01 },
    intervalMs: 60 * 60 * 1000,
  });
  s.start();
  s.stop(); // before the 10 ms boot delay elapses
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false);
});

test('a failing boot run is logged, never thrown out of the timer', async () => {
  const errors = [];
  const s = createRetentionScheduler({
    rollup: { rollupFlows: async () => { throw new Error('db down'); }, rollupMetrics: async () => ({}) },
    purge: { purgeExpired: async () => ({}) },
    config,
    logger: { info() {}, warn() {}, error(m) { errors.push(m); } },
    intervalMs: 60 * 60 * 1000,
    startupDelayMs: 1,
  });
  s.start();
  await new Promise((r) => setTimeout(r, 30));
  s.stop();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /db down/);
});

test('the boot timer does not hold the process open (unref)', () => {
  const realSetTimeout = global.setTimeout;
  let unrefed = false;
  global.setTimeout = (fn, ms) => { const h = realSetTimeout(fn, ms); const u = h.unref.bind(h); h.unref = () => { unrefed = true; return u(); }; return h; };
  try {
    const s = createRetentionScheduler({
      rollup: { rollupFlows: async () => ({}), rollupMetrics: async () => ({}) },
      purge: { purgeExpired: async () => ({}) },
      config, intervalMs: 60 * 60 * 1000, startupDelayMs: 50,
    });
    s.start();
    s.stop();
  } finally { global.setTimeout = realSetTimeout; }
  assert.equal(unrefed, true);
});
