'use strict';

// Periodically runs enabled, scheduled test packages when they fall due. A
// single interval ticks every `intervalMs`; on each tick it loads the enabled
// scheduled packages and runs those whose `schedule_ms` has elapsed since their
// last run. Last-run times are kept in memory but seeded from the package's
// persisted last_run_at, so a restart doesn't immediately re-run everything.
function createTestPackageScheduler({ repo, runner, intervalMs = 15000, logger = console, now = () => Date.now() }) {
  let timer = null;
  const lastRun = new Map(); // packageId -> epoch ms of last run

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
      if (t - last >= pkg.schedule_ms) {
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
