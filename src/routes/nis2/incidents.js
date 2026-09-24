'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { parseId } = require('../../validation/locationValidation');
const { validateIncidentInput, INCIDENT_ART23_FIELDS } = require('../../validation/nis2Validation');
const { computeIncidentDeadlines, withDeadlines, deadlineOverview } = require('../../nis2/deadlines');

// An event case's severity → the NIS2 register's. A draft is the operator's to
// correct; this only saves them from starting at "medium" for a CRIT outage.
const CASE_SEVERITY = { CRIT: 'high', WARN: 'medium', INFO: 'low' };

// The NIS2 draft of one event case: what the case already knows, and nothing it
// does not. Pure, so the mapping is tested without a route.
//
//   title        the case's title
//   detectedAt   the case's FIRST event — when the platform saw it, which is
//                never later than when anyone became aware, so the Art. 23
//                clock it starts can only run early, not late. Edit it if the
//                entity became aware later.
//   startedAt    the same first event; resolvedAt when the case resolved
//   affectedSystems / description: the device, its site and the case's own
//                timeline, as one factual sentence
//   nis2Relevant true — someone chose to draft a NIS2 record — while
//                notificationRequired stays false: whether it is SIGNIFICANT
//                is a legal judgement no event case can make.
function draftFromEventCase(ec) {
  const where = [ec.agentName || ec.agentHostname || ec.hostId, ec.locationName].filter(Boolean).join(' · ');
  const summary = `From BlueEyes event case #${ec.id} (${ec.severity}, ${ec.status})${where ? ` on ${where}` : ''}: `
    + `first event ${ec.firstEventAt || 'unknown'}, last event ${ec.lastEventAt || 'unknown'}`
    + `${ec.resolvedAt ? `, resolved ${ec.resolvedAt}` : ''}.`;
  return {
    title: String(ec.title || `Event case #${ec.id}`).slice(0, 255),
    severity: CASE_SEVERITY[ec.severity] || 'medium',
    status: 'open',
    detectedAt: ec.firstEventAt || null,
    startedAt: ec.firstEventAt || null,
    resolvedAt: ec.resolvedAt || null,
    affectedSystems: summary.slice(0, 2000),
    businessImpact: null,
    rootCause: null,
    actionsTaken: null,
    lessonsLearned: null,
    nis2Relevant: true,
    notificationRequired: false,
    eventCaseId: ec.id,
  };
}

// Security events, and the NIS2 reporting deadlines they carry (24h early
// warning / 72h notification / 1 month final report). The deadlines are derived
// on read rather than stored, so a change to the rules applies to history too;
// what IS stored is when each report was submitted (migration 122), which is
// what lets a stage read "submitted" instead of "overdue".
function createIncidentsRouter(ctx) {
  const router = express.Router();
  const { reader, writer, audit, fail, qstr, nis2IncidentsRepo, eventCasesRepo = null } = ctx;

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
    // The Art. 23 fields (migration 122) are kept as stored when the request
    // does not mention them, so a client written before they existed cannot
    // erase a recorded submission just by not knowing about it.
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    for (const f of INCIDENT_ART23_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, f)) value[f] = before[f] ?? value[f];
    }
    const updated = await nis2IncidentsRepo.update(id, value);
    await audit(req, 'update', 'incident', id, before, updated);
    res.json(updated);
  }));

  // POST /api/nis2/incidents/from-event-case/:caseId — draft a NIS2 incident
  // from an event case and link the two (migration 123). operator+.
  //   400 bad id · 404 no such case · 409 already drafted (the answer names the
  //   existing record, so the UI can open it) · 503 no event-case storage
  router.post('/incidents/from-event-case/:caseId', requireAuth, writer, asyncHandler(async (req, res) => {
    const caseId = parseId(req.params.caseId);
    if (caseId === null) return res.status(400).json({ error: 'Invalid event case id' });
    if (!eventCasesRepo || typeof eventCasesRepo.findById !== 'function') {
      return res.status(503).json({ error: 'Event cases are not available' });
    }
    const ec = await eventCasesRepo.findById(caseId);
    if (!ec) return res.status(404).json({ error: 'Event case not found' });
    if (typeof nis2IncidentsRepo.findByEventCase === 'function') {
      const existing = await nis2IncidentsRepo.findByEventCase(caseId);
      if (existing && existing.length) {
        return res.status(409).json({
          error: 'A NIS2 incident has already been drafted from this event case',
          incident: { id: existing[0].id, incidentId: existing[0].incidentId, title: existing[0].title },
        });
      }
    }
    const created = await nis2IncidentsRepo.create(draftFromEventCase(ec));
    await audit(req, 'create', 'incident', created.id, null, { ...created, source: `event_case:${caseId}` });
    res.status(201).json({ ...created, deadlines: computeIncidentDeadlines(created) });
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

module.exports = { createIncidentsRouter, draftFromEventCase };
