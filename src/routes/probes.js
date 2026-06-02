'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateTimeRange } = require('../validation/resultsValidation');
const { parseId } = require('../validation/locationValidation');

// Read API for active-probe results (ping/tcp/dns/traceroute). viewer+.
function createProbesRouter({ probeResultsRepo, agentsRepo }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/probes?agentId=&from=&to=&type= — time series (oldest first).
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const { value: range, errors } = validateTimeRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const type = req.query.type ? String(req.query.type).toLowerCase() : null;
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const results = await probeResultsRepo.findByAgent({ agentId, from: range.from, to: range.to, type, limit: range.limit });
    res.json({ agentId, type, results });
  }));

  // GET /api/probes/latest?agentId= — most recent result per (type, target).
  router.get('/latest', requireAuth, reader, asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ agentId, results: await probeResultsRepo.latestByAgent(agentId) });
  }));

  return router;
}

module.exports = { createProbesRouter };
