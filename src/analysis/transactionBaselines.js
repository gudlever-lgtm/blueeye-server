'use strict';

// Hourly baseline job for transaction tests: for each assigned (test, agent),
// recompute a robust baseline (median + MAD) per step over the last N days of ok
// results and upsert it into transaction_baselines. Reuses median()/mad() from
// the analysis module — no duplicated statistics. step 0 = whole-test latency;
// steps 1..N = per-step timings.
//
// Exposes { start, stop } so it can be handed to the HA coordinator as a
// leader-only singleton job (like retention), plus runOnce() for tests.

const { median, mad } = require('./baselines');

const silentLogger = { info() {}, warn() {}, error() {} };
const HOUR_MS = 3600 * 1000;

function pushInto(map, key, value) {
  let arr = map.get(key);
  if (!arr) { arr = []; map.set(key, arr); }
  arr.push(value);
}

function createTransactionBaselineJob({
  repo,
  windowDays = 7,
  intervalMs = HOUR_MS,
  logger = silentLogger,
  now = () => Date.now(),
} = {}) {
  let timer = null;

  async function runOnce() {
    let pairs;
    try {
      pairs = await repo.assignedPairs();
    } catch (err) {
      logger.warn(`transaction-baselines: could not list pairs (${err.message})`);
      return 0;
    }
    const since = new Date(now() - windowDays * 86400000);
    let updated = 0;
    for (const { test_id, agent_id } of pairs) {
      let rows;
      try {
        rows = await repo.okResultsSince({ testId: test_id, agentId: agent_id, since });
      } catch (err) {
        logger.warn(`transaction-baselines: load failed for test ${test_id}/agent ${agent_id} (${err.message})`);
        continue;
      }
      if (!rows.length) continue;
      const stepVals = new Map(); // step -> [values]
      for (const r of rows) {
        if (r.latency_ms != null) pushInto(stepVals, 0, r.latency_ms);
        if (Array.isArray(r.step_timings)) r.step_timings.forEach((v, i) => { if (v != null) pushInto(stepVals, i + 1, v); });
      }
      for (const [step, vals] of stepVals) {
        const med = median(vals);
        const spread = mad(vals, med);
        try {
          await repo.upsertBaseline({
            test_id, agent_id, step,
            median_ms: Math.round(med),
            mad_ms: Math.round(spread),
            sample_count: vals.length,
          });
          updated += 1;
        } catch (err) {
          logger.warn(`transaction-baselines: upsert failed (test ${test_id}/agent ${agent_id}/step ${step}): ${err.message}`);
        }
      }
    }
    if (updated) logger.info(`transaction-baselines: recomputed ${updated} (test,agent,step) baselines.`);
    return updated;
  }

  function start() {
    if (timer) return;
    // Run shortly after becoming leader, then hourly. unref so it never holds the
    // process open.
    runOnce().catch((err) => logger.error(`transaction-baselines: initial run failed: ${err.message}`));
    timer = setInterval(() => {
      runOnce().catch((err) => logger.error(`transaction-baselines: run failed: ${err.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { runOnce, start, stop };
}

module.exports = { createTransactionBaselineJob };
