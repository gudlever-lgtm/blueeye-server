'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Analysis findings API (staff, user-JWT). Reuses the existing auth middleware.
// Mounted at /api/findings.
function createFindingsRouter({ findingStore }) {
  const router = express.Router();

  // GET /api/findings?hostId=&since= — list findings (viewer+).
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const hostId = req.query.hostId ? String(req.query.hostId) : undefined;
      let since;
      if (req.query.since) {
        const d = new Date(req.query.since);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ error: 'Validation failed', details: { since: 'since must be a valid date' } });
        }
        since = d;
      }
      res.json(await findingStore.list(hostId, since));
    })
  );

  // POST /api/findings/:id/ack — acknowledge a finding (operator/admin).
  // 404 when the id is unknown; the server's error handler covers 500.
  router.post(
    '/:id/ack',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      // finding ids are UUIDs, so don't use the numeric parseId here.
      const id = String(req.params.id || '');
      const ok = await findingStore.ack(id);
      if (!ok) {
        return res.status(404).json({ error: 'Finding not found' });
      }
      res.json({ id, acked: true });
    })
  );

  return router;
}

module.exports = { createFindingsRouter };
