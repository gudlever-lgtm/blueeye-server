'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateThresholdInput } = require('../validation/probeOutageValidation');
const { METRICS } = require('../probeOutages/detection');

// Event-threshold read/write/delete. Reading is viewer+, writing is admin only.
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

  // The ?metric= a DELETE names. Returns the metric or null when it is not one.
  const metricOf = (raw) => (typeof raw === 'string' && METRICS.includes(raw) ? raw : null);

  // DELETE /api/thresholds?metric= — remove a global default. admin. Without a
  // global default (and no location override) the metric is not evaluated, so
  // no probe outage opens for it — the caller is told so in the 200 body.
  // 400 unknown metric, 404 no such row.
  router.delete('/', requireAuth, writer, asyncHandler(async (req, res) => {
    const metric = metricOf(req.query.metric);
    if (!metric) return res.status(400).json({ error: 'Validation failed', details: { metric: `metric must be one of: ${METRICS.join(', ')}` } });
    if (typeof thresholdsRepo.remove !== 'function') return res.status(503).json({ error: 'Threshold removal not available' });
    const removed = await thresholdsRepo.remove({ location_id: null, metric });
    if (!removed) return res.status(404).json({ error: 'Threshold not found' });
    res.json({ removed: { scope: 'global', metric } });
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

  // DELETE /api/thresholds/:location_id?metric= — remove a location override;
  // the location falls back to the global default. admin. 400 invalid, 404
  // unknown location or no override for that metric.
  router.delete('/:location_id', requireAuth, writer, asyncHandler(async (req, res) => {
    const locationId = parseId(req.params.location_id);
    if (locationId === null) return res.status(400).json({ error: 'location_id must be a positive integer' });
    // The location first: a missing id is a 404 whatever else is wrong.
    const location = await locationsRepo.findById(locationId);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    const metric = metricOf(req.query.metric);
    if (!metric) return res.status(400).json({ error: 'Validation failed', details: { metric: `metric must be one of: ${METRICS.join(', ')}` } });
    if (typeof thresholdsRepo.remove !== 'function') return res.status(503).json({ error: 'Threshold removal not available' });
    const removed = await thresholdsRepo.remove({ location_id: locationId, metric });
    if (!removed) return res.status(404).json({ error: 'Threshold not found' });
    res.json({ removed: { scope: 'location', locationId, metric } });
  }));

  return router;
}

module.exports = { createThresholdsRouter };
