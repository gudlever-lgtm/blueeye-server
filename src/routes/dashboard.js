'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { buildAdvancedDashboard } = require('../dashboard/advancedDashboard');

// "Open issues" rollup for the Overview page (license feature
// `dashboard_advanced`, Professional+): the active events and recent
// analysis findings, composed from data the server already holds. viewer+,
// gated end-to-end: below Professional the route returns the documented 403
// upgrade contract ({ success:false, error:'feature_not_available', feature,
// message }) and the Overview simply renders without the panels.
//
//   GET /api/dashboard/advanced — the aggregated widget payload.
function createDashboardRouter({
  probeOutagesRepo = null,
  eventCasesRepo = null,
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
      // Events + findings are best-effort dimensions — a read failure just
      // drops that widget rather than sinking the panel.
      const [probeOutages, findings, eventCases] = await Promise.all([
        probeOutagesRepo && probeOutagesRepo.list ? probeOutagesRepo.list().catch((err) => { req.log.warn(`dashboard: probe-outages read failed (${err.message}); dropping widget`); return []; }) : Promise.resolve([]),
        findingStore && findingStore.list ? findingStore.list().catch((err) => { req.log.warn(`dashboard: findings read failed (${err.message}); dropping widget`); return []; }) : Promise.resolve([]),
        eventCasesRepo && eventCasesRepo.list ? eventCasesRepo.list({ limit: 200 }).catch((err) => { req.log.warn(`dashboard: event-cases read failed (${err.message}); dropping widget`); return []; }) : Promise.resolve([]),
      ]);
      res.json(buildAdvancedDashboard({ probeOutages, findings, eventCases, now }));
    })
  );

  return router;
}

module.exports = { createDashboardRouter };
