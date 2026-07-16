'use strict';

const { buildLldpGraph } = require('./lldpGraph');

// Cached LLDP graph service (Fase 4). Clustering runs on a hot path and the
// correlator's topology lookups are SYNCHRONOUS, so the graph is built ahead of
// time and cached: `ensureFresh()` (async) rebuilds it at most once per TTL —
// ageing out stale rows first — and `relation()` (sync) answers from the cache.
//
// This mirrors the site-lookup pattern in crossAgentClusterService: the sweep
// awaits ensureFresh() once, then hands the correlator a sync resolver.
//
//   const svc = createLldpGraphService({ lldpNeighborsRepo });
//   await svc.ensureFresh();
//   svc.relation('3', '4');   // { relation:'adjacent', ... }

const silentLogger = { info() {}, warn() {}, error() {} };
const DEFAULT_REFRESH_MS = 60 * 1000;          // rebuild at most once a minute
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // age out rows unseen for 24h (configurable)

function createLldpGraphService({
  lldpNeighborsRepo,
  refreshMs = DEFAULT_REFRESH_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxHops = 2,
  now = () => Date.now(),
  logger = silentLogger,
} = {}) {
  let graph = buildLldpGraph([]); // empty until first load — degrades to "unknown"
  let lastLoaded = 0;
  let loading = null;

  async function refresh() {
    if (!lldpNeighborsRepo || typeof lldpNeighborsRepo.listAll !== 'function') return;
    // Age out stale rows first, so the graph only reflects live adjacencies.
    if (typeof lldpNeighborsRepo.ageOut === 'function') {
      try { await lldpNeighborsRepo.ageOut(new Date(now() - maxAgeMs)); }
      catch (err) { logger.warn(`lldp: age-out failed (${err.message})`); }
    }
    try {
      const rows = await lldpNeighborsRepo.listAll({ since: new Date(now() - maxAgeMs) });
      graph = buildLldpGraph(rows);
      lastLoaded = now();
    } catch (err) {
      logger.warn(`lldp: graph refresh failed (${err.message})`);
    }
  }

  // Rebuild only when the cache is older than the TTL. Concurrent callers share
  // one in-flight refresh.
  async function ensureFresh() {
    if (now() - lastLoaded < refreshMs && lastLoaded !== 0) return;
    if (!loading) loading = refresh().finally(() => { loading = null; });
    await loading;
  }

  // Sync adjacency query from the cached graph (hot-path safe).
  function relation(a, b, opts) {
    return graph.relation(a, b, { maxHops, ...(opts || {}) });
  }

  return { refresh, ensureFresh, relation, get lastLoaded() { return lastLoaded; } };
}

module.exports = { createLldpGraphService, DEFAULT_MAX_AGE_MS };
