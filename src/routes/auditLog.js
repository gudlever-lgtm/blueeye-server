'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');

// The unified audit log (license feature `audit_log`, Professional+). admin only,
// and gated end-to-end: when the plan does not include `audit_log` the routes
// return the documented 403 upgrade contract.
//   GET /api/audit-log?category=&user=&limit=  — newest-first, filterable.
//   GET /api/audit-log/categories               — distinct categories for the filter.
function createAuditLogRouter({ auditLogRepo, featureGate, planService }) {
  const router = express.Router();
  const gate = requirePlanFeature({ featureGate, planService }, 'audit_log');

  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.ADMIN),
    gate,
    asyncHandler(async (req, res) => {
      if (!auditLogRepo) return res.status(503).json({ error: 'Audit log not available' });
      let actorUserId = null;
      if (req.query.user !== undefined && req.query.user !== '') {
        actorUserId = parseId(req.query.user);
        if (actorUserId === null) return res.status(400).json({ error: 'Invalid user id' });
      }
      const category = req.query.category ? String(req.query.category) : null;
      const rows = await auditLogRepo.list({ category, actorUserId, limit: req.query.limit });
      res.json(rows);
    })
  );

  router.get(
    '/categories',
    requireAuth,
    requireRole(ROLES.ADMIN),
    gate,
    asyncHandler(async (req, res) => {
      if (!auditLogRepo) return res.status(503).json({ error: 'Audit log not available' });
      res.json(await auditLogRepo.categories());
    })
  );

  return router;
}

module.exports = { createAuditLogRouter };
