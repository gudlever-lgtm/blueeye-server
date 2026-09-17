'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The calendar cases below are wall-clock assertions, so the zone is pinned
// before the first Date is constructed.
process.env.TZ = 'Europe/Copenhagen';

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

test('runs a package with a schedule_spec when its next slot passes', async () => {
  // 2026-03-10 07:00 local; the package repeats daily at 08:00.
  const day = (h, m = 0) => new Date(2026, 2, 10, h, m, 0, 0).getTime();
  let clock = day(7);
  const pkg = { id: 1, name: 'connection test', schedule_ms: 0, schedule_spec: { period: 'daily', every: 1, at: '08:00' }, last_run_at: null };
  const runs = [];
  const scheduler = createTestPackageScheduler({
    repo: { findEnabledScheduled: async () => [pkg] },
    runner: { run: async () => { runs.push(clock); } },
    logger: quiet,
    now: () => clock,
  });

  await scheduler.tick();               // seeds last-run = 07:00
  assert.equal(runs.length, 0);
  clock = day(7, 59);
  await scheduler.tick();
  assert.equal(runs.length, 0, 'not due a minute early');
  clock = day(8, 0);
  await scheduler.tick();
  assert.equal(runs.length, 1, 'due at 08:00');
  clock = day(12);
  await scheduler.tick();
  assert.equal(runs.length, 1, 'once a day means once');
});

test('a schedule_spec that no longer validates is never due (it is not due constantly)', async () => {
  let clock = Date.now();
  const pkg = { id: 1, name: 'broken', schedule_ms: 0, schedule_spec: { period: 'fortnightly' }, last_run_at: null };
  const runs = [];
  const scheduler = createTestPackageScheduler({
    repo: { findEnabledScheduled: async () => [pkg] },
    runner: { run: async () => { runs.push(clock); } },
    logger: quiet,
    now: () => clock,
  });
  await scheduler.tick();
  clock += 365 * 24 * 60 * 60 * 1000;
  await scheduler.tick();
  assert.equal(runs.length, 0);
});
