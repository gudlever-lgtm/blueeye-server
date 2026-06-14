'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { forecast } = require('../analysis/forecast');

const MAX_POINTS = 5000;

// Capacity / trend forecasting API. Mounted at /api/forecast behind the user JWT.
// The dashboard already holds time series for its charts (throughput, link
// utilisation, disk usage); it POSTs one here to get a robust, explainable
// projection + "days until capacity". viewer+ (read-only computation).
function createForecastRouter() {
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
        ? Math.min(Number(body.horizonDays), 3650)
        : 30;
      res.json(forecast(body.points, { capacity: Number.isFinite(capacity) ? capacity : null, horizonDays }));
    })
  );

  return router;
}

module.exports = { createForecastRouter };
