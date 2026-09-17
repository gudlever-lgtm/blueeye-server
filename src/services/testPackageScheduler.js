'use strict';

// Periodically runs enabled, scheduled test packages when they fall due. A
// single interval ticks every `intervalMs`; on each tick it loads the enabled
// scheduled packages and runs those that are due. Last-run times are kept in
// memory but seeded from the package's persisted last_run_at, so a restart
// doesn't immediately re-run everything.
//
// Two kinds of schedule, one tick:
//   * schedule_ms  — an interval since the last run ("every 5 minutes").
//   * schedule_spec — a calendar recurrence ("daily at 08:00", "Mondays"),
//     answered by src/schedule/recurrence.js. A spec that no longer validates
//     is never due rather than due constantly: a package nobody can parse must
//     not turn into a command storm against a customer's agents.
const { nextRunAt } = require('../schedule/recurrence');

function createTestPackageScheduler({ repo, runner, intervalMs = 15000, logger = console, now = () => Date.now() }) {
  let timer = null;
  const lastRun = new Map(); // packageId -> epoch ms of last run

  // Is this package due at `t`, given when it last ran?
  function isDue(pkg, last, t) {
    if (pkg.schedule_spec) {
      const due = nextRunAt(pkg.schedule_spec, last);
      return due !== null && t >= due;
    }
    return pkg.schedule_ms > 0 && t - last >= pkg.schedule_ms;
  }

  async function tick() {
    let packages;
    try {
      packages = await repo.findEnabledScheduled();
    } catch (err) {
      logger.warn(`test-package scheduler: could not load packages (${err.message})`);
      return;
    }
    const t = now();
    for (const pkg of packages) {
      let last = lastRun.get(pkg.id);
      if (last === undefined) {
        last = pkg.last_run_at ? new Date(pkg.last_run_at).getTime() : t;
        lastRun.set(pkg.id, last);
      }
      if (isDue(pkg, last, t)) {
        lastRun.set(pkg.id, t);
        try { await runner.run(pkg); }
        catch (err) { logger.warn(`test-package "${pkg.name}" scheduled run failed: ${err.message}`); }
      }
    }
    // Forget packages that are no longer enabled/scheduled.
    const live = new Set(packages.map((p) => p.id));
    for (const id of [...lastRun.keys()]) if (!live.has(id)) lastRun.delete(id);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((err) => logger.warn(`test-package scheduler tick: ${err.message}`)); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    tick, // exposed for tests
  };
}

module.exports = { createTestPackageScheduler };
