'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateReportRange, validateSeverityFilter } = require('../validation/incidentValidation');
const { nis2Draft } = require('../incidents/nis2');

// Reporting endpoints over derived incidents + probe availability. All under the
// existing user-JWT auth: availability + incident listing are viewer+, the NIS2
// draft (a regulator-facing document) is operator+.
function createReportsRouter({ probeResultsRepo, incidentsRepo, locationsRepo }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  // Parses an optional ?location_id= filter. Returns { value } (number|null) or
  // { error } when it is present but not a positive integer.
  function parseLocationFilter(raw) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const id = parseId(raw);
    if (id === null) return { error: 'location_id must be a positive integer' };
    return { value: id };
  }

  // GET /api/reports/availability?from=&to=&location_id= — uptime % per
  // location/agent over the period, from probe reachability. viewer+.
  router.get('/availability', requireAuth, reader, asyncHandler(async (req, res) => {
    const { value: range, errors } = validateReportRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const loc = parseLocationFilter(req.query.location_id);
    if (loc.error) return res.status(400).json({ error: 'Validation failed', details: { location_id: loc.error } });
    if (loc.value != null && locationsRepo) {
      const location = await locationsRepo.findById(loc.value);
      if (!location) return res.status(404).json({ error: 'Location not found' });
    }
    const agents = await probeResultsRepo.availability({ from: range.from, to: range.to, locationId: loc.value });
    res.json({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      locationId: loc.value,
      agents,
    });
  }));

  // GET /api/reports/incidents?from=&to=&severity=&location_id= — incidents
  // overlapping the period with timestamps + duration. viewer+.
  router.get('/incidents', requireAuth, reader, asyncHandler(async (req, res) => {
    const { value: range, errors } = validateReportRange(req.query);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const sev = validateSeverityFilter(req.query.severity);
    if (sev.errors) return res.status(400).json({ error: 'Validation failed', details: sev.errors });
    const loc = parseLocationFilter(req.query.location_id);
    if (loc.error) return res.status(400).json({ error: 'Validation failed', details: { location_id: loc.error } });
    if (loc.value != null && locationsRepo) {
      const location = await locationsRepo.findById(loc.value);
      if (!location) return res.status(404).json({ error: 'Location not found' });
    }
    const incidents = await incidentsRepo.list({
      from: range.from, to: range.to, severity: sev.value, locationId: loc.value,
    });
    res.json({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      severity: sev.value,
      locationId: loc.value,
      incidents,
    });
  }));

  // GET /api/reports/nis2-draft/:incident_id — one incident as an English CFCS
  // notification draft. operator+ (regulator-facing document).
  router.get('/nis2-draft/:incident_id', requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const id = parseId(req.params.incident_id);
    if (id === null) return res.status(400).json({ error: 'incident_id must be a positive integer' });
    const incident = await incidentsRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json({ incidentId: incident.id, incident, draft: nis2Draft(incident) });
  }));

  return router;
}

module.exports = { createReportsRouter };
