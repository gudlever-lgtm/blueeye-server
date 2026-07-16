'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { buildTopology } = require('../analysis/topology');

const DEFAULT_WINDOW_MIN = 60;
const MAX_WINDOW_MIN = 7 * 24 * 60;

// Flow-derived dependency / topology map. Mounted at /api/topology behind the
// user JWT. Builds a who-talks-to-whom graph from the ingested 5-tuple flows
// (whole fleet, or one agent via ?agentId=), over a ?minutes window. viewer+.
function createTopologyRouter({ flowsRepo = null, agentsRepo = null, locationsRepo = null, centroids = null, lldpNeighborsRepo = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

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
