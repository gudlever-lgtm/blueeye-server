'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { buildTopology } = require('../analysis/topology');
const { buildTopologyGraph } = require('../topology/graph');

const DEFAULT_WINDOW_MIN = 60;
const MAX_WINDOW_MIN = 7 * 24 * 60;
const DEFAULT_TOP_N = 50;

// Flow-derived dependency / topology map. Mounted at /api/topology behind the
// user JWT. Builds a who-talks-to-whom graph from the ingested 5-tuple flows
// (whole fleet, or one agent via ?agentId=), over a ?minutes window. viewer+.
function createTopologyRouter({ flowsRepo = null, agentsRepo = null, locationsRepo = null, centroids = null, lldpNeighborsRepo = null, serviceDependenciesRepo = null, serviceDependencyJob = null, blastRadiusService = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/topology/blast-radius/:node — impact analysis for a failing node:
  // directly_isolated[] (L2) + dependency_affected[] (service_dep), each with a
  // justifying path. operator+ (a diagnostic compute). 404 unknown node, 400
  // invalid, 500 when the topology store is unavailable.
  if (blastRadiusService) {
    router.get('/blast-radius/:node', requireAuth, writer, asyncHandler(async (req, res) => {
      const nodeId = parseId(req.params.node);
      if (nodeId === null) return res.status(400).json({ error: 'node must be a positive integer' });
      if (agentsRepo && typeof agentsRepo.findById === 'function' && !(await agentsRepo.findById(nodeId))) {
        return res.status(404).json({ error: 'Node not found' });
      }
      let depth;
      if (req.query.depth !== undefined && req.query.depth !== '') {
        depth = Number(req.query.depth);
        if (!Number.isInteger(depth) || depth < 1 || depth > 32) return res.status(400).json({ error: 'depth must be 1..32' });
      }
      const result = await blastRadiusService.compute(nodeId, depth ? { depth } : {});
      res.json(result);
    }));
  }

  // GET /api/topology/neighbors — persisted LLDP adjacencies (Fase 4). viewer+.
  // Filter by ?target=<agentId> (both directions), paginate with limit/offset.
  if (lldpNeighborsRepo) {
    router.get('/neighbors', requireAuth, reader, asyncHandler(async (req, res) => {
      let targetAgentId = null;
      if (req.query.target !== undefined && req.query.target !== '') {
        targetAgentId = parseId(req.query.target);
        if (targetAgentId === null) return res.status(400).json({ error: 'Invalid target' });
        if (agentsRepo && typeof agentsRepo.findById === 'function' && !(await agentsRepo.findById(targetAgentId))) {
          return res.status(404).json({ error: 'Agent not found' });
        }
      }
      const limRaw = req.query.limit;
      const offRaw = req.query.offset;
      const limit = limRaw === undefined || limRaw === '' ? 50 : Number(limRaw);
      const offset = offRaw === undefined || offRaw === '' ? 0 : Number(offRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({ error: 'limit must be 1..500' });
      if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'offset must be >= 0' });

      const filter = { targetAgentId };
      const [neighbors, total] = await Promise.all([
        lldpNeighborsRepo.list({ ...filter, limit, offset }),
        typeof lldpNeighborsRepo.count === 'function' ? lldpNeighborsRepo.count(filter) : Promise.resolve(null),
      ]);
      res.json({ neighbors, page: { limit, offset, total } });
    }));
  }

  // ---- Service dependency graph (edge type 'service_dep', migration 066) ----
  if (serviceDependenciesRepo) {
    // GET /api/topology/dependencies — the aggregated TCP service-dependency
    // edges. ?host=<agentId> returns that host's Top-N edges (both directions
    // unless ?direction=in|out); no host = the heaviest edges fleet-wide.
    // viewer+. 404 when the host is unknown.
    router.get('/dependencies', requireAuth, reader, asyncHandler(async (req, res) => {
      const direction = ['in', 'out', 'both'].includes(req.query.direction) ? req.query.direction : 'both';
      const limRaw = req.query.limit;
      const limit = limRaw === undefined || limRaw === '' ? DEFAULT_TOP_N : Number(limRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return res.status(400).json({ error: 'limit must be 1..1000' });

      let hostId = null;
      if (req.query.host !== undefined && req.query.host !== '') {
        hostId = parseId(req.query.host);
        if (hostId === null) return res.status(400).json({ error: 'Invalid host' });
        if (agentsRepo && typeof agentsRepo.findById === 'function' && !(await agentsRepo.findById(hostId))) {
          return res.status(404).json({ error: 'Host not found' });
        }
      }

      if (hostId === null) {
        const edges = await serviceDependenciesRepo.listAll({ limit });
        return res.json({ host: null, direction, edges });
      }
      const [edges, total] = await Promise.all([
        serviceDependenciesRepo.listForHost({ hostId, direction, limit }),
        typeof serviceDependenciesRepo.countForHost === 'function'
          ? serviceDependenciesRepo.countForHost({ hostId, direction })
          : Promise.resolve(null),
      ]);
      return res.json({ host: hostId, direction, edges, page: { limit, total } });
    }));

    // POST /api/topology/dependencies/recompute — force a recompute now
    // (normally a scheduled job). operator+ (this is the write path). 403 for
    // viewers, 503 when no job is wired.
    router.post('/dependencies/recompute', requireAuth, writer, asyncHandler(async (req, res) => {
      if (!serviceDependencyJob || typeof serviceDependencyJob.run !== 'function') {
        return res.status(503).json({ error: 'Service dependency job not available' });
      }
      const result = await serviceDependencyJob.run();
      return res.json({ ok: true, ...(result || {}) });
    }));
  }

  // GET /api/topology/graph — the UNIFIED graph carrying both edge types:
  // 'l2_link' (LLDP adjacencies) + 'service_dep' (TCP dependencies). viewer+.
  if (lldpNeighborsRepo || serviceDependenciesRepo) {
    router.get('/graph', requireAuth, reader, asyncHandler(async (req, res) => {
      const [l2, serviceDeps, agents] = await Promise.all([
        lldpNeighborsRepo && typeof lldpNeighborsRepo.listAll === 'function' ? lldpNeighborsRepo.listAll({}) : Promise.resolve([]),
        serviceDependenciesRepo && typeof serviceDependenciesRepo.listAll === 'function' ? serviceDependenciesRepo.listAll({}) : Promise.resolve([]),
        agentsRepo && typeof agentsRepo.findAll === 'function' ? agentsRepo.findAll() : Promise.resolve([]),
      ]);
      res.json(buildTopologyGraph({ l2, serviceDeps, agents }));
    }));
  }

  if (!flowsRepo) return router;

  router.get(
    '/',
    requireAuth,
    reader,
    asyncHandler(async (req, res) => {
      const mins = Number(req.query.minutes);
      const windowMin = Number.isFinite(mins) && mins > 0 ? Math.min(mins, MAX_WINDOW_MIN) : DEFAULT_WINDOW_MIN;
      const to = new Date();
      const from = new Date(to.getTime() - windowMin * 60 * 1000);

      let agentId = null;
      if (req.query.agentId !== undefined && req.query.agentId !== '') {
        agentId = parseId(req.query.agentId);
        if (agentId === null) return res.status(400).json({ error: 'Invalid agentId' });
        if (agentsRepo && typeof agentsRepo.findById === 'function' && !(await agentsRepo.findById(agentId))) {
          return res.status(404).json({ error: 'Agent not found' });
        }
      }

      let locationId = null;
      if (req.query.locationId !== undefined && req.query.locationId !== '') {
        locationId = parseId(req.query.locationId);
        if (locationId === null) return res.status(400).json({ error: 'Invalid locationId' });
        if (locationsRepo && typeof locationsRepo.findById === 'function' && !(await locationsRepo.findById(locationId))) {
          return res.status(404).json({ error: 'Location not found' });
        }
      }

      const rows = await flowsRepo.topologyEdges({ agentId, locationId, from, to });
      res.json({
        from: from.toISOString(),
        to: to.toISOString(),
        agentId,
        locationId,
        ...buildTopology(rows, { centroids }),
      });
    })
  );

  return router;
}

module.exports = { createTopologyRouter };
