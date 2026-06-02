'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Global search across agents/hosts/locations and — when the query looks like an
// IP or a port — which agents have recently seen that IP/port in their flows.
// Agent/location matching is done in JS over the (small) full lists; flow lookups
// hit the DB with a recent window. viewer+.
function createSearchRouter({ agentsRepo, locationsRepo, flowsRepo }) {
  const router = express.Router();

  router.get('/', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    if (q.length > 64) return res.status(400).json({ error: 'q is too long (max 64 chars)' });
    const windowH = Math.min(Math.max(Number(req.query.windowH) || 24, 1), 168);
    const since = new Date(Date.now() - windowH * 3600 * 1000);
    const until = new Date();
    const ql = q.toLowerCase();

    const agentsAll = await agentsRepo.findAll();
    const agents = agentsAll
      .filter((a) => String(a.hostname || '').toLowerCase().includes(ql) || String(a.display_name || '').toLowerCase().includes(ql))
      .slice(0, 10)
      .map((a) => ({ id: a.id, name: a.display_name || a.hostname, hostname: a.hostname, status: a.status, locationName: a.location_name || null }));

    let locations = [];
    try {
      const locs = await locationsRepo.findAll();
      locations = locs.filter((l) => String(l.name || '').toLowerCase().includes(ql)).slice(0, 10).map((l) => ({ id: l.id, name: l.name }));
    } catch { locations = []; }

    const nameById = new Map(agentsAll.map((a) => [a.id, a.display_name || a.hostname]));
    const flows = {};
    const looksIp = /[.:]/.test(q) && /^[0-9a-fA-F.:]+$/.test(q);
    const isPort = /^\d{1,5}$/.test(q) && Number(q) >= 1 && Number(q) <= 65535;

    if (looksIp && flowsRepo && typeof flowsRepo.agentIdsForIp === 'function') {
      try {
        const ids = await flowsRepo.agentIdsForIp({ ip: q, since, until });
        flows.ip = { ip: q, agents: ids.map((id) => ({ id, name: nameById.get(id) || `#${id}` })) };
      } catch { /* flows optional */ }
    }
    if (isPort && flowsRepo && typeof flowsRepo.agentIdsForPort === 'function') {
      try {
        const ids = await flowsRepo.agentIdsForPort({ port: Number(q), since, until });
        flows.port = { port: Number(q), agents: ids.map((id) => ({ id, name: nameById.get(id) || `#${id}` })) };
      } catch { /* flows optional */ }
    }

    res.json({ query: q, windowH, agents, locations, flows });
  }));

  return router;
}

module.exports = { createSearchRouter };
