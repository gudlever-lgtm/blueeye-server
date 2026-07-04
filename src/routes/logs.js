'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Operational log view — the in-memory ring buffer of the server's diagnostic
// stream (the same lines it writes to stdout/stderr), plus client-reported
// action failures, merged. Admin-only to read: operational logs can carry
// internal detail (hostnames, error messages, request ids). This is distinct
// from the durable AUDIT trail (/api/audit) which records "who did what".
function createLogsRouter({ logRing }) {
  const router = express.Router();

  // Read recent buffered records. Filters: level (minimum), since (ISO), q (text).
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { level, since, q } = req.query;
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
      res.json({
        entries: logRing.list({ level, since, q, limit }),
        size: logRing.size,
        capacity: logRing.capacity,
      });
    })
  );

  // Fold a client-side event (typically a failed dashboard action) into the same
  // stream so the merged view shows browser failures alongside server ones. Any
  // authenticated user may report; the payload is size-capped and only ever used
  // as display text — never trusted or executed.
  router.post(
    '/client',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { id, level, msg, meta } = req.body || {};
      if (!msg || typeof msg !== 'string') return res.status(400).json({ error: 'msg required' });
      const lvl = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'error';
      logRing.record({
        id: id ? `c${String(id).slice(0, 80)}` : undefined,
        level: lvl,
        msg: msg.slice(0, 500),
        source: 'client',
        meta: {
          ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}),
          user: req.user ? req.user.email : null,
        },
      });
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createLogsRouter };
