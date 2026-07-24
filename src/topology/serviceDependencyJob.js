'use strict';

const { buildHostResolver } = require('./hostResolver');
const { aggregateServiceDependencies, DEFAULT_TOP_N } = require('./serviceDependencyAggregator');

// Scheduled recompute of the service-dependency edges — OFF the ingest hot path
// (a leader-only singleton in server.js `backgroundJobs`, same as the LLDP graph
// refresh). Each run:
//   1. builds the IP→host resolver from the current agent inventory,
//   2. reads TCP flow aggregates over the rolling window (default 24h),
//   3. aggregates to host↔host edges (Top-N per source host, unknown endpoints
//      dropped),
//   4. upserts the edges and ages out any not seen within the window.
//
// Best-effort: a run failure is logged and never throws out of the interval.

function toInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function readConfig(env = process.env) {
  return {
    windowHours: toInt(env.SERVICE_DEP_WINDOW_HOURS, 24),
    topN: toInt(env.SERVICE_DEP_TOP_N, DEFAULT_TOP_N),
    intervalMinutes: toInt(env.SERVICE_DEP_JOB_INTERVAL_MINUTES, 10),
  };
}

function createServiceDependencyJob({
  serviceDependenciesRepo,
  flowsRepo,
  agentsRepo,
  config = readConfig(),
  logger = null,
  now = () => new Date(),
}) {
  let timer = null;
  let running = false;

  async function run() {
    if (running) return null; // re-entrancy guard
    running = true;
    try {
      const to = now();
      const from = new Date(to.getTime() - config.windowHours * 60 * 60 * 1000);
      const agents = await agentsRepo.findAll();
      const resolver = buildHostResolver(agents);
      const flowRows = await flowsRepo.tcpServiceFlows({ from, to });
      const { edges, stats } = aggregateServiceDependencies(flowRows, resolver, { topN: config.topN });
      await serviceDependenciesRepo.upsertMany(edges);
      const aged = await serviceDependenciesRepo.ageOut(from);
      if (logger && typeof logger.info === 'function') {
        logger.info(
          `service-dep: ${stats.edges} edges from ${stats.input} tcp flow groups ` +
          `(resolver ips=${resolver.size}, dropped unknown=${stats.droppedUnknown}, self=${stats.droppedSelf}, ` +
          `truncated=${stats.truncated}, aged-out=${aged})`,
        );
      }
      return { stats, aged };
    } catch (err) {
      if (logger && typeof logger.warn === 'function') logger.warn(`service-dep: run failed (${err && err.message})`);
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    run().catch(() => {});
    timer = setInterval(() => run().catch(() => {}), config.intervalMinutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, run };
}

module.exports = { createServiceDependencyJob, readConfig };
