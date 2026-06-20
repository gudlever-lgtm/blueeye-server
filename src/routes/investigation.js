'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Lokationsdrevet investigation-API. Monteret på /api/investigation.
// RBAC:
//   POST /run            — operator+
//   POST /from-incident  — operator+
//   GET  /               — viewer+
//   GET  /:id            — viewer+
function createInvestigationRouter({
  investigationsRepo,
  locator,
  assistant = null,
  incidentsRepo = null,
  nis2IncidentsRepo = null,
}) {
  const router = express.Router();

  // Validate a locationRef body field; returns { ok, locationRef } or { ok: false, error }.
  function parseLocationRef(body) {
    const lr = body && body.locationRef;
    if (!lr || typeof lr !== 'object') {
      return { ok: false, error: 'locationRef is required and must be an object' };
    }
    if (!lr.type || !['agent', 'interface', 'subnet', 'site'].includes(lr.type)) {
      return { ok: false, error: 'locationRef.type must be one of: agent, interface, subnet, site' };
    }
    if (typeof lr.value !== 'string' || lr.value.trim() === '') {
      return { ok: false, error: 'locationRef.value must be a non-empty string' };
    }
    return { ok: true, locationRef: { type: lr.type, value: lr.value.trim() } };
  }

  // Optionally enrich the result with a Mistral narrative; fails silently.
  async function maybeAddNarrative(result) {
    if (!assistant || typeof assistant.narrateInvestigation !== 'function') return result;
    if (!assistant.isEnabled()) return result;
    try {
      const narrative = await assistant.narrateInvestigation(result);
      return { ...result, narrative };
    } catch {
      return result;
    }
  }

  // Optionally generate a NIS2 incident draft via a second, independent Mistral
  // call and persist it via the existing nis2IncidentsRepo. Never auto-submits:
  // notificationRequired is always false, status always 'open'.
  // Returns { nis2Draft: <created incident> } on success,
  // { nis2DraftError: <message> } on failure, or {} when the feature is off.
  async function maybeCreateNis2Draft(result) {
    if (!assistant || typeof assistant.generateNis2Draft !== 'function') return {};
    if (!assistant.isEnabled()) return {};
    if (!nis2IncidentsRepo) return {};
    try {
      const draft = await assistant.generateNis2Draft(result);
      if (!draft.title) return {};
      const created = await nis2IncidentsRepo.create({
        title: `[AI-udkast] ${draft.title}`,
        severity: draft.severity || 'medium',
        detectedAt: draft.detectedAt || null,
        affectedSystems: draft.affectedSystems || null,
        businessImpact: draft.description || null,
        rootCause: 'Automatisk genereret af AI (BlueEye-fejlfinding) — kræver menneskelig gennemgang inden indsendelse.',
        nis2Relevant: false,         // human must assess
        notificationRequired: false, // NEVER auto-submitted via this path
        status: 'open',
      });
      return { nis2Draft: created };
    } catch (err) {
      return { nis2DraftError: err.message || 'NIS2-udkast kunne ikke oprettes' };
    }
  }

  // POST /api/investigation/run — run a new investigation.
  router.post(
    '/run',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { ok, locationRef, error } = parseLocationRef(req.body);
      if (!ok) return res.status(400).json({ error: 'Validation failed', details: error });

      let windowMinutes = 30;
      if (req.body.windowMinutes !== undefined) {
        const n = Number(req.body.windowMinutes);
        if (!Number.isFinite(n) || n < 1 || n > 1440) {
          return res.status(400).json({ error: 'Validation failed', details: 'windowMinutes must be between 1 and 1440' });
        }
        windowMinutes = n;
      }

      let result;
      try {
        result = await locator.runInvestigation({ locationRef, windowMinutes });
      } catch (err) {
        return res.status(500).json({ error: 'Investigation failed', details: err.message });
      }

      result = await maybeAddNarrative(result);

      // Independent NIS2 draft generation — failure never suppresses Output 1.
      const nis2 = await maybeCreateNis2Draft(result);

      try {
        await investigationsRepo.save(result);
      } catch {
        // Persistence failure must not suppress the result.
      }

      res.json({ ...result, ...nis2 });
    })
  );

  // POST /api/investigation/from-incident — look up a local incident, resolve
  // its agent/location, run an investigation, and optionally write back via
  // ServiceNow (skipped silently when not configured).
  router.post(
    '/from-incident',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const incidentId = req.body && req.body.incidentId;
      if (!incidentId) {
        return res.status(400).json({ error: 'Validation failed', details: 'incidentId is required' });
      }

      if (!incidentsRepo || typeof incidentsRepo.findById !== 'function') {
        return res.status(503).json({ error: 'Incidents repository not available' });
      }

      const incident = await incidentsRepo.findById(String(incidentId));
      if (!incident) {
        return res.status(404).json({ error: 'Incident not found', incidentId });
      }

      // Derive locationRef from the incident: prefer locationId (site), else agentId (agent).
      let locationRef;
      if (incident.locationId != null) {
        locationRef = { type: 'site', value: String(incident.locationId) };
      } else if (incident.agentId != null) {
        locationRef = { type: 'agent', value: String(incident.agentId) };
      } else {
        return res.status(422).json({ error: 'Incident has no resolvable location (no agentId or locationId)' });
      }

      let result;
      try {
        result = await locator.runInvestigation({ locationRef, windowMinutes: 30 });
      } catch (err) {
        return res.status(500).json({ error: 'Investigation failed', details: err.message });
      }

      result = await maybeAddNarrative(result);

      const nis2 = await maybeCreateNis2Draft(result);

      try {
        await investigationsRepo.save(result);
      } catch {
        // Persistence failure must not suppress the result.
      }

      res.json({ incidentId, investigation: { ...result, ...nis2 } });
    })
  );

  // GET /api/investigation — list recent investigations (paginated).
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      let limit = 50;
      let offset = 0;
      if (req.query.limit !== undefined) {
        const n = Number.parseInt(req.query.limit, 10);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'Validation failed', details: 'limit must be a positive integer' });
        }
        limit = Math.min(n, 500);
      }
      if (req.query.offset !== undefined) {
        const n = Number.parseInt(req.query.offset, 10);
        if (!Number.isInteger(n) || n < 0) {
          return res.status(400).json({ error: 'Validation failed', details: 'offset must be a non-negative integer' });
        }
        offset = n;
      }
      const results = await investigationsRepo.list({ limit, offset });
      res.json(results);
    })
  );

  // GET /api/investigation/:id — fetch a specific investigation result.
  router.get(
    '/:id',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id || '');
      const result = await investigationsRepo.findById(id);
      if (!result) return res.status(404).json({ error: 'Investigation not found', id });
      res.json(result);
    })
  );

  return router;
}

module.exports = { createInvestigationRouter };
