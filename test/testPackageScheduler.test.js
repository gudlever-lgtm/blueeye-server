'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestPackageScheduler } = require('../src/services/testPackageScheduler');

const quiet = { info() {}, warn() {} };

test('runs a scheduled package only once its interval has elapsed', async () => {
  let clock = 1_000_000;
  const pkg = { id: 1, name: 'p', schedule_ms: 60_000, last_run_at: null };
  const runs = [];
  const scheduler = createTestPackageScheduler({
    repo: { findEnabledScheduled: async () => [pkg] },
    runner: { run: async (p) => { runs.push({ at: clock, id: p.id }); } },
    logger: quiet,
    now: () => clock,
  });

  // First tick seeds last-run = now, so it does NOT run immediately.
  await scheduler.tick();
  assert.equal(runs.length, 0);

  // Before the interval elapses: still nothing.
  clock += 30_000;
  await scheduler.tick();
  assert.equal(runs.length, 0);

  // After the interval: it runs once.
  clock += 31_000; // total 61s since seed
  await scheduler.tick();
  assert.equal(runs.length, 1);

  // Immediately after: not due again.
  await scheduler.tick();
  assert.equal(runs.length, 1);
});

test('runs a package whose persisted last_run_at is already overdue', async () => {
  const clock = 10_000_000;
  const pkg = { id: 2, name: 'p2', schedule_ms: 60_000, last_run_at: new Date(clock - 120_000).toISOString() };
  const runs = [];
  const scheduler = createTestPackageScheduler({
    repo: { findEnabledScheduled: async () => [pkg] },
    runner: { run: async (p) => { runs.push(p.id); } },
    logger: quiet,
    now: () => clock,
  });
  await scheduler.tick();
  assert.deepEqual(runs, [2]);
});

test('tolerates a repo failure without throwing', async () => {
  const scheduler = createTestPackageScheduler({
    repo: { findEnabledScheduled: async () => { throw new Error('db down'); } },
    runner: { run: async () => { throw new Error('should not run'); } },
    logger: quiet,
    now: () => 0,
  });
  await scheduler.tick(); // must not throw
  assert.ok(true);
});
