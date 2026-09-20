'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { parseId } = require('../../validation/locationValidation');
const { validateIncidentInput } = require('../../validation/nis2Validation');
const { computeIncidentDeadlines, withDeadlines, deadlineOverview } = require('../../nis2/deadlines');

// Security events, and the NIS2 reporting deadlines they carry (24h early
// warning / 72h notification / 1 month final report). The deadlines are derived
// on read rather than stored, so a change to the rules applies to history too.
function createIncidentsRouter(ctx) {
  const router = express.Router();
  const { reader, writer, audit, fail, qstr, nis2IncidentsRepo } = ctx;

  // ---- Incidents ------------------------------------------------------------

  router.get('/incidents', requireAuth, reader, asyncHandler(async (req, res) => {
    let nis2Relevant = null;
    if (req.query.nis2Relevant === 'true') nis2Relevant = true;
    else if (req.query.nis2Relevant === 'false') nis2Relevant = false;
    const incidents = await nis2IncidentsRepo.findAll({
      status: qstr(req.query.status),
      severity: qstr(req.query.severity),
      nis2Relevant,
    });
    // Attach the computed NIS2 Art.23 reporting deadlines (additive field).
    res.json(withDeadlines(incidents));
  }));

  // NIS2 Art.23 reporting-deadline overview — incidents that carry a reporting
  // duty, most-urgent first (overdue → due-soon → upcoming) + counts. Drives a
  // compliance "deadlines" panel so 24h/72h/1-month duties are tracked, not just
  // described. viewer+.
  router.get('/deadlines', requireAuth, reader, asyncHandler(async (req, res) => {
    const incidents = await nis2IncidentsRepo.findAll({ nis2Relevant: null });
    res.json(deadlineOverview(incidents));
  }));

  router.get('/incidents/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const incident = await nis2IncidentsRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    res.json({ ...incident, deadlines: computeIncidentDeadlines(incident) });
  }));

  router.post('/incidents', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateIncidentInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2IncidentsRepo.create(value);
    await audit(req, 'create', 'incident', created.id, null, created);
    res.status(201).json(created);
  }));

  router.put('/incidents/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2IncidentsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Incident not found' });
    const { value, errors } = validateIncidentInput(req.body);
    if (errors) return fail(res, errors);
    const updated = await nis2IncidentsRepo.update(id, value);
    await audit(req, 'update', 'incident', id, before, updated);
    res.json(updated);
  }));

  router.delete('/incidents/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2IncidentsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Incident not found' });
    await nis2IncidentsRepo.remove(id);
    await audit(req, 'delete', 'incident', id, before, null);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createIncidentsRouter };
