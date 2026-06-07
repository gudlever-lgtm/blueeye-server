'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');

// Caps a client-supplied limit to a sane range (default 100, max 500).
function clampLimit(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) return 100;
  return Math.min(n, 500);
}

// The server-initiated agent-action audit trail (upgrade/delete). admin only.
//   GET /audit?user=<id>&limit=<n>  — by actor, or the whole trail when no user.
// Per-agent history is at GET /agents/:id/audit.
function createAuditRouter({ auditRepo }) {
  const router = express.Router();

  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!auditRepo) return res.status(503).json({ error: 'Audit log not available' });
      const limit = clampLimit(req.query.limit);
      if (req.query.user !== undefined && req.query.user !== '') {
        const userId = parseId(req.query.user);
        if (userId === null) return res.status(400).json({ error: 'Invalid user id' });
        return res.json(await auditRepo.findByActor(userId, { limit }));
      }
      res.json(await auditRepo.findAll({ limit }));
    })
  );

  return router;
}

module.exports = { createAuditRouter };
