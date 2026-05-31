'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Read-only view of the local license state (staff, viewer+). The signed proof
// itself is never exposed as a token — this only reports status.
function createLicenseRouter({ licenseManager }) {
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
      res.json(status);
    })
  );

  return router;
}

module.exports = { createLicenseRouter };
