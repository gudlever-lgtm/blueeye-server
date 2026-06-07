'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateThresholdInput } = require('../validation/incidentValidation');
const { METRICS } = require('../incidents/detection');

// Incident-threshold read/write. Reading is viewer+, writing is admin only.
// /api/thresholds operates on the GLOBAL defaults (location_id IS NULL);
// /api/thresholds/:location_id operates on a single location's overrides.
function createThresholdsRouter({ thresholdsRepo, locationsRepo }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.ADMIN);

  // GET /api/thresholds — the global defaults. viewer+.
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    res.json({ scope: 'global', thresholds: await thresholdsRepo.listGlobal() });
  }));

  // PUT /api/thresholds — upsert a global default for one metric. admin.
  router.put('/', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateThresholdInput(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const threshold = await thresholdsRepo.upsert({ location_id: null, ...value });
    res.json({ threshold });
  }));

  // GET /api/thresholds/:location_id — the EFFECTIVE threshold per metric for a
  // location (its override if any, else the global default). viewer+.
  router.get('/:location_id', requireAuth, reader, asyncHandler(async (req, res) => {
    const locationId = parseId(req.params.location_id);
    if (locationId === null) return res.status(400).json({ error: 'location_id must be a positive integer' });
    const location = await locationsRepo.findById(locationId);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    const thresholds = [];
    for (const metric of METRICS) {
      const t = await thresholdsRepo.getEffective(locationId, metric);
      if (t) thresholds.push({ ...t, source: t.location_id == null ? 'global' : 'location' });
    }
    res.json({ locationId, thresholds });
  }));

  // PUT /api/thresholds/:location_id — upsert a location override for one metric. admin.
  router.put('/:location_id', requireAuth, writer, asyncHandler(async (req, res) => {
    const locationId = parseId(req.params.location_id);
    if (locationId === null) return res.status(400).json({ error: 'location_id must be a positive integer' });
    const location = await locationsRepo.findById(locationId);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    const { value, errors } = validateThresholdInput(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const threshold = await thresholdsRepo.upsert({ location_id: locationId, ...value });
    res.json({ threshold });
  }));

  return router;
}

module.exports = { createThresholdsRouter };
