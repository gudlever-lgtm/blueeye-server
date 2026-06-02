'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const silentLogger = { info() {}, warn() {}, error() {} };

// Runs rollup + purge periodically (default daily), behind the retention flag.
// A re-entrancy guard prevents overlapping runs; the rollup itself is idempotent
// (it deletes the raw rows it aggregates), so a repeated run double-counts nothing.
function createRetentionScheduler({ rollup, purge, config, logger = silentLogger, now = () => new Date(), intervalMs }) {
  let timer = null;
  let running = false;
  const everyMs = intervalMs || (config.intervalHours || 24) * 60 * 60 * 1000;

  async function runOnce() {
    if (!config.enabled) return null; // honour a runtime disable (Indstillinger → Retention)
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

  function start() {
    if (!config.enabled) { logger.info('retention: disabled (RETENTION_ENABLED=false)'); return; }
    if (timer) return;
    timer = setInterval(() => { runOnce(); }, everyMs);
    if (timer.unref) timer.unref();
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { runOnce, start, stop };
}

module.exports = { createRetentionScheduler };
