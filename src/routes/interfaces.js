'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { computeInterfaceHealth } = require('../health/interfaceHealth');

// Interface health for one agent, derived from its most recent measurement.
// viewer+. (No new storage — reads the latest row from `results`.)
function createInterfacesRouter({ resultsRepo, agentsRepo }) {
  const router = express.Router();
  router.get('/', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const rows = await resultsRepo.findByAgentId(agentId, { limit: 1 });
    const latest = rows && rows[0];
    const traffic = latest && latest.payload && latest.payload.traffic;
    res.json({
      agentId,
      ts: latest ? (latest.created_at instanceof Date ? latest.created_at.toISOString() : latest.created_at) : null,
      source: (traffic && traffic.source) || 'proc',
      interfaces: computeInterfaceHealth(traffic),
    });
  }));
  return router;
}

module.exports = { createInterfacesRouter, computeInterfaceHealth };
