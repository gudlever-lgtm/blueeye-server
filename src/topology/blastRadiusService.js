'use strict';

const { buildTopologyGraph } = require('./graph');
const { computeBlastRadius, DEFAULT_MAX_DEPTH } = require('./blastRadius');
const { loadTopologyConfig } = require('./config');

// Builds the unified topology graph from the persisted edges and computes the
// blast radius for a node. Shared by the event enrichment (best-effort) and
// the dedicated /api/topology/blast-radius endpoint (surfaces DB errors as 500).
//
// The graph is built on demand from the two bounded `listAll` reads — the same
// inputs GET /api/topology/graph already uses. maxDepth is env-configurable
// (BLAST_RADIUS_MAX_DEPTH, default 4).

function readMaxDepth(env = process.env) {
  return loadTopologyConfig(env).blastRadiusMaxDepth || DEFAULT_MAX_DEPTH;
}

function createBlastRadiusService({
  lldpNeighborsRepo = null, serviceDependenciesRepo = null, agentsRepo = null,
  // The polled switches, their own LLDP and the port MACs that resolve it.
  // Without these the graph is agents only — and blast radius, which is built
  // on this graph, cannot answer "what does this switch cut off" because the
  // switch is not in it.
  snmpDevicesRepo = null, snmpNeighborsRepo = null, deviceInterfacesRepo = null,
  maxDepth = readMaxDepth(),
}) {
  // Each source is optional and answers [] when it is not wired, so a build
  // that has no SNMP inventory gets exactly the graph it got before.
  const readOr = (repo, method, args) => (repo && typeof repo[method] === 'function'
    ? repo[method](args) : Promise.resolve([]));

  async function graph() {
    const [l2, serviceDeps, agents, devices, deviceNeighbours, deviceMacs] = await Promise.all([
      readOr(lldpNeighborsRepo, 'listAll', {}),
      readOr(serviceDependenciesRepo, 'listAll', {}),
      agentsRepo && typeof agentsRepo.findAll === 'function' ? agentsRepo.findAll() : Promise.resolve([]),
      readOr(snmpDevicesRepo, 'list', {}),
      readOr(snmpNeighborsRepo, 'listAll', {}),
      readOr(deviceInterfacesRepo, 'listMacs', {}),
    ]);
    return buildTopologyGraph({ l2, serviceDeps, agents, devices, deviceNeighbours, deviceMacs });
  }

  // Compute blast radius for a node. Throws if a repo throws (DB unavailable).
  async function compute(nodeId, { depth = maxDepth } = {}) {
    const g = await graph();
    return computeBlastRadius(g, nodeId, { maxDepth: depth });
  }

  return { compute, graph, maxDepth };
}

module.exports = { createBlastRadiusService, readMaxDepth };
