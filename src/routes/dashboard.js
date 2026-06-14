'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { buildAdvancedDashboard } = require('../dashboard/advancedDashboard');

// Health window for the per-agent verdicts on the dashboard — same default the
// fleet overview uses, so the two views agree.
const WINDOW_MS = 6 * 3600 * 1000;

// Advanced dashboard (license feature `dashboard_advanced`, Professional+):
// drill-down widget panels — fleet health roll-up, an "attention" list, open
// incidents and analysis findings — composed from data the server already
// holds. viewer+, gated end-to-end: below Professional the route returns the
// documented 403 upgrade contract ({ success:false, error:'feature_not_available',
// feature, message }).
//
//   GET /api/dashboard/advanced — the aggregated widget payload.
function createDashboardRouter({
  agentsRepo,
  probeResultsRepo,
  incidentsRepo = null,
  findingStore = null,
  featureGate,
  planService,
}) {
  const router = express.Router();
  const gate = requirePlanFeature({ featureGate, planService }, 'dashboard_advanced');

  router.get(
    '/advanced',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    gate,
    asyncHandler(async (req, res) => {
      const now = Date.now();
      // Incidents + findings are best-effort dimensions — a read failure just
      // drops that widget rather than sinking the dashboard.
      const [agents, probeRows, incidents, findings] = await Promise.all([
        agentsRepo.findAll(),
        probeResultsRepo.fleetHealth({ windowMs: WINDOW_MS }),
        incidentsRepo && incidentsRepo.list ? incidentsRepo.list().catch((err) => { req.log.warn(`dashboard: incidents read failed (${err.message}); dropping widget`); return []; }) : Promise.resolve([]),
        findingStore && findingStore.list ? findingStore.list().catch((err) => { req.log.warn(`dashboard: findings read failed (${err.message}); dropping widget`); return []; }) : Promise.resolve([]),
      ]);
      const probeRowsByAgentId = {};
      for (const r of probeRows || []) {
        if (!probeRowsByAgentId[r.agentId]) probeRowsByAgentId[r.agentId] = [];
        probeRowsByAgentId[r.agentId].push(r);
      }
      res.json(buildAdvancedDashboard({ agents, probeRowsByAgentId, incidents, findings, now }));
    })
  );

  return router;
}

module.exports = { createDashboardRouter };
