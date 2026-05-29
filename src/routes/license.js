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

  return router;
}

module.exports = { createLicenseRouter };
