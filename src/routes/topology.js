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
function createTopologyRouter({ flowsRepo, agentsRepo = null }) {
  const router = express.Router();

  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
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

      const rows = await flowsRepo.topologyEdges({ agentId, from, to });
      res.json({
        from: from.toISOString(),
        to: to.toISOString(),
        agentId,
        ...buildTopology(rows),
      });
    })
  );

  return router;
}

module.exports = { createTopologyRouter };
