'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Read-only view of the local license state (staff, viewer+). The signed proof
// itself is never exposed as a token — this only reports status.
function createLicenseRouter({ licenseManager, featureGate, planService, usageService, auditLogger = null }) {
  const router = express.Router();

  router.get(
    '/status',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!licenseManager) {
        return res.status(503).json({ error: 'License manager not available' });
      }
      res.json(licenseManager.getStatus());
    })
  );

  // GET /license/features — which modules the license entitles the customer to,
  // so the UI can hide/grey-out modules they aren't licensed for (viewer+).
  router.get(
    '/features',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    (req, res) => {
      res.json(featureGate ? featureGate.summary() : { analysis: false, assistant: false, alerting: false, geo: false });
    }
  );

  // GET /license/plan — the active package (Pilot/Starter/Professional/
  // Professional): name, support level, limits and the packaged feature flags.
  // Powers the admin "License overview" panel (viewer+).
  router.get(
    '/plan',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    (req, res) => {
      if (!planService) return res.status(503).json({ error: 'Plan service not available' });
      res.json(planService.summary());
    }
  );

  // GET /license/usage — current usage against plan limits (agents / active test
  // paths / history) for the admin "Usage overview" panel (viewer+).
  router.get(
    '/usage',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!usageService) return res.status(503).json({ error: 'Usage service not available' });
      res.json(await usageService.getUsage());
    })
  );

  // GET /license/matrix — the full plan × feature grid + the active plan, so the
  // UI can render the feature matrix and upgrade hints (viewer+).
  router.get(
    '/matrix',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    (req, res) => {
      if (!planService) return res.status(503).json({ error: 'Plan service not available' });
      res.json(planService.featureMatrix());
    }
  );

  // POST /license/refresh — force an immediate re-validation against the license
  // server (operator/admin), e.g. right after the licence was renewed there, so
  // staff don't have to wait for the periodic 6-hour check. Returns the fresh
  // status. Never throws out — validateOnce() handles its own errors.
  router.post(
    '/refresh',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!licenseManager) {
        return res.status(503).json({ error: 'License manager not available' });
      }
      const status = await licenseManager.validateOnce();
      if (auditLogger) await auditLogger.record(req, { category: 'license', action: 'license_revalidate', detail: `status=${status && status.status}` });
      res.json(status);
    })
  );

  return router;
}

module.exports = { createLicenseRouter };
