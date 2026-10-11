'use strict';

// What the background jobs are actually DOING, for GET /system/self.
//
// The problem this solves, and the reason it is shaped the way it is: a
// singleton job runs on a timer inside its own closure. Nothing outside it sees
// a tick. The only trace a failed tick left was one line in a log nobody reads
// after boot, while the feature it drives — retention, the report scheduler,
// the baseline recompute — simply stopped happening.
//
// Tracking that properly looked like it needed a change to every job. It does
// not: every job already takes a `logger` and already reports a failed tick
// through it, with the same `runOnce().catch((err) => logger.error(…))` shape.
// So the tracker hands each job a logger of its own that forwards everything to
// the real one and remembers what went past. Twelve jobs, no change to any of
// them.
//
// WHAT IT CAN AND CANNOT SAY, precisely — because the self-health screen refuses
// to claim more than it knows:
//   * a job that FAILED a tick is seen, with when and with the message;
//   * a job that started is seen;
//   * a job that is ticking along quietly is NOT distinguishable from one whose
//     timer died, because success is silent. The signal says "started, no
//     errors", never "running".
// Making success visible means each job reporting a tick, which is the change
// to every job that this avoids. It is worth doing; it is not worth pretending
// to have done.

function createJobTracker({ logger = console, now = () => new Date() } = {}) {
  const jobs = new Map();

  function entry(name) {
    if (!jobs.has(name)) {
      jobs.set(name, {
        name,
        startedAt: null,
        startError: null,
        lastError: null,
        lastErrorAt: null,
        errors: 0,
      });
    }
    return jobs.get(name);
  }

  // A logger for one job: everything goes through to the real one, and an
  // `error` is also remembered. `warn` is deliberately NOT counted — these jobs
  // warn about a row they skipped, which is the job working, and counting it
  // would make the screen cry wolf until nobody reads it.
  function loggerFor(name) {
    const self = entry(name);
    const forward = (level) => (...args) => {
      if (logger && typeof logger[level] === 'function') logger[level](...args);
    };
    return {
      info: forward('info'),
      warn: forward('warn'),
      debug: forward('debug'),
      error: (...args) => {
        self.errors += 1;
        self.lastError = args.map((a) => (a && a.message) || String(a)).join(' ').slice(0, 500);
        self.lastErrorAt = now().toISOString();
        forward('error')(...args);
      },
    };
  }

  // Called by startBackgroundJobs: did this job's start() throw? A job that did
  // not start is not running, whatever its ticks would have said.
  function markStarted(name, err = null) {
    const self = entry(name);
    if (err) {
      self.startError = (err && err.message) || String(err);
      self.startedAt = null;
    } else {
      self.startError = null;
      self.startedAt = now().toISOString();
    }
  }

  function reset() { jobs.clear(); }

  function snapshot() {
    return [...jobs.values()].map((j) => ({ ...j }));
  }

  return { loggerFor, markStarted, snapshot, reset };
}

module.exports = { createJobTracker };
