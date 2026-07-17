'use strict';

// Leader-only background sweep for post-remediation verification (Fase 3). Every
// tick it completes any verification run whose settle window has elapsed. Exposes
// { runOnce, start, stop } so it slots into server.js's backgroundJobs array like
// the cross-agent cluster / incident auto-resolve jobs.
//
// Best-effort: the service swallows its own errors; this wrapper additionally
// guards so a throw can never crash the scheduler.

const silentLogger = { info() {}, warn() {}, error() {} };

function createVerificationJob({ service, intervalMs = 60 * 1000, logger = silentLogger } = {}) {
  let timer = null;

  async function runOnce() {
    try {
      return (await service.runDue()) || null;
    } catch (err) {
      logger.warn(`verification-job: sweep failed (${err.message})`);
      return null;
    }
  }

  function start() {
    if (timer) return;
    runOnce().catch((err) => logger.error(`verification-job: initial run failed: ${err.message}`));
    timer = setInterval(() => {
      runOnce().catch((err) => logger.error(`verification-job: run failed: ${err.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { runOnce, start, stop };
}

module.exports = { createVerificationJob };
