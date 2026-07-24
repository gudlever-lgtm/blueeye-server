'use strict';

const { buildTopologyGraph } = require('./graph');
const { computeBlastRadius, DEFAULT_MAX_DEPTH } = require('./blastRadius');

// Builds the unified topology graph from the persisted edges and computes the
// blast radius for a node. Shared by the incident enrichment (best-effort) and
// the dedicated /api/topology/blast-radius endpoint (surfaces DB errors as 500).
//
// The graph is built on demand from the two bounded `listAll` reads — the same
// inputs GET /api/topology/graph already uses. maxDepth is env-configurable
// (BLAST_RADIUS_MAX_DEPTH, default 4).

function readMaxDepth(env = process.env) {
  const n = Number(env.BLAST_RADIUS_MAX_DEPTH);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_DEPTH;
}

function createBlastRadiusService({ lldpNeighborsRepo = null, serviceDependenciesRepo = null, agentsRepo = null, maxDepth = readMaxDepth() }) {
  async function graph() {
    const [l2, serviceDeps, agents] = await Promise.all([
      lldpNeighborsRepo && typeof lldpNeighborsRepo.listAll === 'function' ? lldpNeighborsRepo.listAll({}) : Promise.resolve([]),
      serviceDependenciesRepo && typeof serviceDependenciesRepo.listAll === 'function' ? serviceDependenciesRepo.listAll({}) : Promise.resolve([]),
      agentsRepo && typeof agentsRepo.findAll === 'function' ? agentsRepo.findAll() : Promise.resolve([]),
    ]);
    return buildTopologyGraph({ l2, serviceDeps, agents });
  }

  // Compute blast radius for a node. Throws if a repo throws (DB unavailable).
  async function compute(nodeId, { depth = maxDepth } = {}) {
    const g = await graph();
    return computeBlastRadius(g, nodeId, { maxDepth: depth });
  }

  return { compute, graph, maxDepth };
}

module.exports = { createBlastRadiusService, readMaxDepth };
