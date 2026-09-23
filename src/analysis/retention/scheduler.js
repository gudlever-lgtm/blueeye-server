'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const silentLogger = { info() {}, warn() {}, error() {} };

// Runs rollup + purge periodically (default daily), behind the retention flag.
// A re-entrancy guard prevents overlapping runs; the rollup itself is idempotent
// (it deletes the raw rows it aggregates), so a repeated run double-counts nothing.
//
// FIRST RUN AT BOOT. start() also schedules one run `startupDelayMs` after boot
// (default config.startupDelaySeconds, 120 s), then the interval as before. With
// only the interval, a server restarted more often than every intervalHours —
// one deploy a day is enough — never ran retention at all, and every table it
// looks after grew without bound. The delay keeps the first run out of the boot
// itself and out of the reconnect storm of the fleet. Both timers are unref'd
// (they never hold the process open) and a failure is logged by runOnce and
// never escapes the timer.
function createRetentionScheduler({ rollup, purge, config, logger = silentLogger, now = () => new Date(), intervalMs, startupDelayMs }) {
  let timer = null;
  let bootTimer = null;
  let running = false;
  const everyMs = intervalMs || (config.intervalHours || 24) * 60 * 60 * 1000;
  const firstMs = Number.isFinite(startupDelayMs) && startupDelayMs >= 0
    ? startupDelayMs
    : Math.max(0, Number.isFinite(config.startupDelaySeconds) ? config.startupDelaySeconds : 120) * 1000;

  async function runOnce() {
    if (!config.enabled) return null; // honour a runtime disable (Settings → Retention)
    if (running) { logger.warn('retention: previous run still in progress — skipping'); return null; }
    running = true;
    try {
      const beforeTs = new Date(now().getTime() - config.rawRetentionDays * DAY_MS);
      const flows = await rollup.rollupFlows(beforeTs);
      const metrics = await rollup.rollupMetrics(beforeTs);
      const purged = await purge.purgeExpired();
      logger.info('retention: run complete');
      return { flows, metrics, purged };
    } catch (err) {
      logger.error(`retention: run failed (${err.message})`);
      return { error: err.message };
    } finally {
      running = false;
    }
  }

  // runOnce already catches and logs its own failures; the .catch is the belt
  // to that brace, so nothing thrown inside a timer can become an unhandled
  // rejection.
  const tick = () => {
    Promise.resolve()
      .then(() => runOnce())
      .catch((err) => logger.error(`retention: scheduled run failed (${err && err.message})`));
  };

  function start() {
    if (!config.enabled) { logger.info('retention: disabled (RETENTION_ENABLED=false)'); return; }
    if (timer) return;
    bootTimer = setTimeout(() => { bootTimer = null; tick(); }, firstMs);
    if (bootTimer.unref) bootTimer.unref();
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { runOnce, start, stop };
}

module.exports = { createRetentionScheduler };
