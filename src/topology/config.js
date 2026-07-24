'use strict';

// Topology subsystem configuration, in one place (mirrors analysis/config.js and
// retention/config.js). The service-dependency job, the LLDP change detector and
// the blast-radius service each read the same env mechanism; consolidating the
// names + defaults here keeps them discoverable instead of scattered across the
// individual job modules. Every knob keeps its original env var name.

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}

const DEFAULTS = {
  serviceDepWindowHours: 24, // rolling aggregate window
  serviceDepTopN: 50, // heaviest edges kept per host (both directions)
  serviceDepIntervalMinutes: 10, // recompute cadence
  flapWindowSeconds: 300, // topology-change revert window collapsing to 'flapping'
  blastRadiusMaxDepth: 4, // BFS depth cap for blast-radius traversal
};

function loadTopologyConfig(env = process.env) {
  return {
    serviceDepWindowHours: toInt(env.SERVICE_DEP_WINDOW_HOURS, DEFAULTS.serviceDepWindowHours),
    serviceDepTopN: toInt(env.SERVICE_DEP_TOP_N, DEFAULTS.serviceDepTopN),
    serviceDepIntervalMinutes: toInt(env.SERVICE_DEP_JOB_INTERVAL_MINUTES, DEFAULTS.serviceDepIntervalMinutes),
    flapWindowSeconds: toInt(env.TOPOLOGY_FLAP_WINDOW_SECONDS, DEFAULTS.flapWindowSeconds),
    blastRadiusMaxDepth: toInt(env.BLAST_RADIUS_MAX_DEPTH, DEFAULTS.blastRadiusMaxDepth),
  };
}

module.exports = { loadTopologyConfig, DEFAULTS };
