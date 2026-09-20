'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { forecast } = require('../analysis/forecast');
const {
  forecastInterfaces, DEFAULT_WINDOW_DAYS, MAX_ROWS,
} = require('../analysis/interfaceForecast');
const { parseId } = require('../validation/locationValidation');

const MAX_POINTS = 5000;
const MAX_HORIZON_DAYS = 3650;
const MAX_WINDOW_DAYS = 90;

// Capacity / trend forecasting API. Mounted at /api/forecast behind the user JWT.
//
// Two shapes, and the difference matters:
//
//   POST /            a series the CALLER supplies. General-purpose, works for
//                     any metric, and the only option when the data lives in
//                     the browser (a chart the user has already brushed).
//   GET  /interfaces  the server reads the series AND the ceiling itself, from
//                     stored results and the link's own negotiated speed. This
//                     is the one an operator actually uses, because it answers
//                     "which of my links runs out first" without anybody having
//                     to assemble a series or invent a capacity number.
//
// Both are viewer+ read-only computation: nothing is stored, nothing is sent.
function createForecastRouter({ resultsRepo = null, agentsRepo = null } = {}) {
  const router = express.Router();

  // POST /api/forecast { points:[{t,v}], capacity?, horizonDays? } -> forecast.
  router.post(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (!Array.isArray(body.points)) {
        return res.status(400).json({ error: 'Validation failed', details: { points: 'points must be an array of {t, v}' } });
      }
      if (body.points.length > MAX_POINTS) {
        return res.status(400).json({ error: 'Validation failed', details: { points: `too many points (max ${MAX_POINTS})` } });
      }
      const capacity = body.capacity == null ? null : Number(body.capacity);
      const horizonDays = Number.isFinite(Number(body.horizonDays)) && Number(body.horizonDays) > 0
        ? Math.min(Number(body.horizonDays), MAX_HORIZON_DAYS)
        : 30;
      res.json(forecast(body.points, { capacity: Number.isFinite(capacity) ? capacity : null, horizonDays }));
    })
  );

  // GET /api/forecast/interfaces?agentId=&days=&horizonDays=
  //
  // Every interface on one agent, projected against its own link speed, most
  // urgent first. 503 rather than a fake answer when the results store is not
  // wired — an install without it has no series to project.
  router.get(
    '/interfaces',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (!resultsRepo || !agentsRepo) {
        return res.status(503).json({ error: 'Forecasting needs the results store, which is not configured on this server' });
      }
      const agentId = parseId(req.query.agentId);
      if (agentId === null) {
        return res.status(400).json({ error: 'Validation failed', details: { agentId: 'agentId is required (positive integer)' } });
      }
      // 404 before any work: an unknown agent is not an empty forecast.
      const agent = await agentsRepo.findById(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const days = clampInt(req.query.days, DEFAULT_WINDOW_DAYS, 1, MAX_WINDOW_DAYS);
      const horizonDays = clampInt(req.query.horizonDays, 30, 1, MAX_HORIZON_DAYS);
      const from = new Date(Date.now() - days * 24 * 3600 * 1000);

      const rows = await resultsRepo.findByAgentId(agentId, { from, limit: MAX_ROWS });
      const interfaces = forecastInterfaces(rows, { horizonDays });

      res.json({
        agentId,
        windowDays: days,
        horizonDays,
        samples: rows.length,
        // The ceiling is the link's own speed, so say so rather than making the
        // reader guess what "capacity" meant.
        capacity: { metric: 'utilPct', ceiling: 100, basis: 'negotiated link speed' },
        interfaces,
      });
    })
  );

  return router;
}

// A query integer with a default and hard bounds. Anything unparseable falls
// back to the default rather than 400: these are optional refinements on a read,
// and failing the whole request over a stray ?days=soon helps nobody.
function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

module.exports = { createForecastRouter };
