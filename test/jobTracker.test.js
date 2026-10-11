'use strict';

process.env.NODE_ENV = 'test';

// src/system/jobTracker.js — what the background jobs are actually doing.
//
// A singleton job runs on a timer inside its own closure, so nothing outside it
// sees a tick. Every job already takes a `logger` and already reports a failed
// tick through it, so the tracker hands each one a logger of its own. That is
// the hook; the alternative was a change to twelve jobs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createJobTracker } = require('../src/system/jobTracker');

const collector = () => {
  const out = { info: [], warn: [], error: [] };
  return {
    out,
    logger: {
      info: (...a) => out.info.push(a.join(' ')),
      warn: (...a) => out.warn.push(a.join(' ')),
      error: (...a) => out.error.push(a.join(' ')),
    },
  };
};

test('a failed tick is remembered, and still reaches the real logger', () => {
  const { out, logger } = collector();
  const tracker = createJobTracker({ logger, now: () => new Date('2026-10-11T09:00:00.000Z') });

  const jobLog = tracker.loggerFor('retention');
  jobLog.error('retention: run failed: table is locked');

  // The log is not a side channel — it is still the log.
  assert.deepEqual(out.error, ['retention: run failed: table is locked']);

  const [job] = tracker.snapshot();
  assert.equal(job.name, 'retention');
  assert.match(job.lastError, /table is locked/);
  assert.equal(job.lastErrorAt, '2026-10-11T09:00:00.000Z');
  assert.equal(job.errors, 1);
});

test('a warn is forwarded but NOT counted as a failure', () => {
  // These jobs warn about a row they skipped, which is the job working.
  // Counting it would make the screen cry wolf until nobody reads it.
  const { out, logger } = collector();
  const tracker = createJobTracker({ logger });
  const jobLog = tracker.loggerFor('flow-pair-baselines');
  jobLog.warn('flow-pair-baselines: load failed for one pair — skipping');
  jobLog.info('flow-pair-baselines: 42 pairs updated');

  assert.equal(out.warn.length, 1);
  assert.equal(out.info.length, 1);
  const [job] = tracker.snapshot();
  assert.equal(job.errors, 0);
  assert.equal(job.lastError, null);
});

test('a job that did not START is distinguished from one whose tick failed', () => {
  // They need different answers: a job that never started is not running at
  // all, whatever its ticks would have said.
  const tracker = createJobTracker({ logger: collector().logger });
  tracker.markStarted('reports', new Error('cron expression is nonsense'));
  tracker.loggerFor('retention').error('retention: run failed');
  tracker.markStarted('retention');

  const byName = Object.fromEntries(tracker.snapshot().map((j) => [j.name, j]));
  assert.match(byName.reports.startError, /nonsense/);
  assert.equal(byName.reports.startedAt, null);
  assert.equal(byName.retention.startError, null);
  assert.ok(byName.retention.startedAt);
  assert.match(byName.retention.lastError, /run failed/);
});

test('counting is per job, and a restart clears the board', () => {
  const tracker = createJobTracker({ logger: collector().logger });
  tracker.loggerFor('a').error('one');
  tracker.loggerFor('a').error('two');
  tracker.loggerFor('b').error('three');

  const byName = Object.fromEntries(tracker.snapshot().map((j) => [j.name, j]));
  assert.equal(byName.a.errors, 2);
  assert.equal(byName.a.lastError, 'two', 'the LAST error is the one worth showing');
  assert.equal(byName.b.errors, 1);

  // startBackgroundJobs resets: errors from a previous boot are not this boot's.
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), []);
});

test('an Error object is recorded by its message, not as [object Object]', () => {
  const tracker = createJobTracker({ logger: collector().logger });
  tracker.loggerFor('x').error(new Error('connection refused'));
  assert.match(tracker.snapshot()[0].lastError, /connection refused/);
});

test('the snapshot is a copy — a caller cannot edit the tracker', () => {
  const tracker = createJobTracker({ logger: collector().logger });
  tracker.loggerFor('x').error('boom');
  const snap = tracker.snapshot();
  snap[0].lastError = 'all fine actually';
  assert.equal(tracker.snapshot()[0].lastError, 'boom');
});

test('a tracker with no logger at all does not throw', () => {
  // A job must not die because the thing watching it is missing.
  const tracker = createJobTracker({ logger: null });
  assert.doesNotThrow(() => tracker.loggerFor('x').error('boom'));
  assert.equal(tracker.snapshot()[0].errors, 1);
});
