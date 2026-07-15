'use strict';

// Leader-only background sweep for cross-agent incident clusters. Every tick it
// (1) runs a detection pass (group findings from >=2 agents in the window into
// clusters, deduped) and (2) resolves clusters that have gone inactive. Exposes
// { runOnce, start, stop } so it slots into server.js's backgroundJobs array like
// the retention / transaction-baseline / incident-auto-resolve jobs.
//
// Detection lives in a sweep (not the ingest hot path) so it stays off the
// per-report critical path and still catches findings from every source (traffic
// AND probe pipelines). The window is minutes-wide, so a ~60s sweep is timely.
//
// Best-effort: the service swallows its own errors; this wrapper additionally
// guards so a throw can never crash the scheduler.

const silentLogger = { info() {}, warn() {}, error() {} };

function createCrossAgentClusterJob({
  service,
  intervalMs = 60 * 1000,
  now = () => Date.now(),
  logger = silentLogger,
} = {}) {
  let timer = null;

  async function runOnce() {
    let summary = { created: 0, updated: 0 };
    try {
      summary = (await service.detectAndPersist()) || summary;
    } catch (err) {
      logger.warn(`cross-agent-cluster: detection pass failed (${err.message})`);
    }
    try {
      await service.resolveStale();
    } catch (err) {
      logger.warn(`cross-agent-cluster: resolution pass failed (${err.message})`);
    }
    return summary;
  }

  function start() {
    if (timer) return;
    runOnce().catch((err) => logger.error(`cross-agent-cluster: initial run failed: ${err.message}`));
    timer = setInterval(() => {
      runOnce().catch((err) => logger.error(`cross-agent-cluster: run failed: ${err.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // `now` is accepted for symmetry with the other jobs (and future use); the
  // service owns the clock for detection/resolution.
  void now;

  return { runOnce, start, stop };
}

module.exports = { createCrossAgentClusterJob };
