'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// AI assistant API (opt-in; staff, user-JWT). Mounted at /api/assistant. The
// endpoint always exists when an assistant is wired, but answers 403 while the
// feature is disabled — so the UI can tell "off" apart from "missing".
function createAssistantRouter({ assistant, featureGate, logger = null }) {
  const router = express.Router();

  // WHAT WENT WRONG, AND WHOSE PROBLEM IT IS. Every assistant route used to
  // rethrow anything that was not FeatureDisabled, so a provider that is
  // unreachable, a key that was never set and a genuine bug in this server all
  // reached the operator as the same thing:
  //
  //   POST /api/assistant/findings-summary  500  {"error":"Internal Server Error"}
  //
  // In production the error handler strips the message too, so the one sentence
  // that says what to do — "no API key is configured (set one in Settings -> AI
  // assistant)" — was thrown away on the way out. Neither of those is an
  // internal error of this server, and each has a different fix:
  //
  //   AssistantMisconfigured  409  this server is not set up to ask anything
  //   AssistantUpstreamError  502  the provider did not answer, or answered badly
  //   anything else           500  ours, and the error handler logs it
  //
  // Both messages are written for an operator and name no secret — the key is
  // never in them, only whether one is set.
  function assistantFailure(err, req, res) {
    const name = err && err.name;
    if (name === 'FeatureDisabled') return res.status(403).json({ error: err.message });
    if (name === 'AssistantMisconfigured' || name === 'AssistantUpstreamError') {
      const status = name === 'AssistantMisconfigured' ? 409 : 502;
      // The system log gets it either way: a failure the operator was shown and
      // cannot find in the log afterwards is a failure they cannot chase.
      const log = req.log || logger;
      if (log && typeof log.warn === 'function') {
        log.warn(`assistant: ${req.method} ${req.originalUrl} failed — ${err.message}`);
      }
      return res.status(status).json({
        error: err.message,
        code: name === 'AssistantMisconfigured' ? 'ASSISTANT_NOT_CONFIGURED' : 'ASSISTANT_UPSTREAM',
      });
    }
    throw err; // ours -> 500, logged by the error handler
  }

  // POST /api/assistant/explain  { question, hostId? } — ask about a host
  // (viewer+). 400 empty question, 403 feature disabled, 500 on provider error.
  router.post(
    '/explain',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      // License gate first — distinct from "switched off in config" below.
      if (featureGate && !featureGate.isFeatureEnabled('assistant')) {
        return res.status(403).json({ error: 'This feature is not included in your license', feature: 'assistant', reason: 'license' });
      }
      const body = req.body || {};
      const question = typeof body.question === 'string' ? body.question : '';
      const hostId = body.hostId != null && body.hostId !== '' ? String(body.hostId) : undefined;

      if (question.trim() === '') {
        return res.status(400).json({ error: 'Validation failed', details: { question: 'question is required' } });
      }

      try {
        const result = await assistant.explain(question, hostId);
        return res.json(result);
      } catch (err) {
        if (err && err.name === 'InvalidQuestion') {
          return res.status(400).json({ error: 'Validation failed', details: { question: 'question is required' } });
        }
        return assistantFailure(err, req, res);
      }
    })
  );

  // POST /api/assistant/diagnose-explain { diagnostic, hostId? } — plain-language
  // explanation of a flow-pipeline diagnostic snapshot (from /agents/:id/diagnose),
  // viewer+. 400 missing diagnostic, 403 feature disabled / not licensed, 500 on
  // provider error. The snapshot is re-sanitised in the assistant (bounded context).
  router.post(
    '/diagnose-explain',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (featureGate && !featureGate.isFeatureEnabled('assistant')) {
        return res.status(403).json({ error: 'This feature is not included in your license', feature: 'assistant', reason: 'license' });
      }
      if (typeof assistant.explainDiagnostic !== 'function') {
        return res.status(404).json({ error: 'Diagnostic explanation is not available' });
      }
      const body = req.body || {};
      const diagnostic = body.diagnostic;
      if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
        return res.status(400).json({ error: 'Validation failed', details: { diagnostic: 'a diagnostic snapshot is required' } });
      }
      const hostId = body.hostId != null && body.hostId !== '' ? String(body.hostId) : undefined;

      try {
        const result = await assistant.explainDiagnostic(diagnostic, hostId);
        return res.json(result);
      } catch (err) {
        if (err && err.name === 'InvalidQuestion') {
          return res.status(400).json({ error: 'Validation failed', details: { diagnostic: 'a diagnostic snapshot is required' } });
        }
        return assistantFailure(err, req, res);
      }
    })
  );

  // POST /api/assistant/location-summary { locationId } — a brief, plain-language
  // "what's going on at this location?" status (viewer+). 400 missing id, 403
  // feature disabled, 404 unknown location, 500 on provider error.
  router.post(
    '/location-summary',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (featureGate && !featureGate.isFeatureEnabled('assistant')) {
        return res.status(403).json({ error: 'This feature is not included in your license', feature: 'assistant', reason: 'license' });
      }
      if (typeof assistant.summarizeLocation !== 'function') {
        return res.status(404).json({ error: 'Location summary is not available' });
      }
      const body = req.body || {};
      const raw = body.locationId;
      const locationId = Number.parseInt(raw, 10);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        return res.status(400).json({ error: 'Validation failed', details: { locationId: 'locationId (positive integer) is required' } });
      }

      try {
        const result = await assistant.summarizeLocation(locationId);
        return res.json(result);
      } catch (err) {
        if (err && err.name === 'LocationNotFound') {
          return res.status(404).json({ error: 'Location not found' });
        }
        return assistantFailure(err, req, res);
      }
    })
  );

  // POST /api/assistant/findings-summary — "what is going on?" across whatever
  // the Analysis screen is currently showing.
  //
  // The filters come from the QUERY STRING, the same ones the list and the
  // summary use, so the answer describes the page being looked at rather than a
  // different one.
  router.post(
    '/findings-summary',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      if (featureGate && !featureGate.isFeatureEnabled('assistant')) {
        return res.status(403).json({ error: 'This feature is not included in your license', feature: 'assistant', reason: 'license' });
      }
      if (typeof assistant.summarizeFindings !== 'function') {
        return res.status(404).json({ error: 'Finding summaries are not available' });
      }

      const q = req.query || {};
      const filters = {};
      if (q.hostId) filters.hostId = String(q.hostId);
      if (q.metric) filters.metric = String(q.metric);
      if (q.severity) {
        const sev = String(q.severity).toUpperCase();
        if (!['INFO', 'WARN', 'CRIT'].includes(sev)) {
          return res.status(400).json({ error: 'Validation failed', details: { severity: 'severity must be INFO, WARN or CRIT' } });
        }
        filters.severity = sev;
      }

      try {
        return res.json(await assistant.summarizeFindings(filters));
      } catch (err) {
        return assistantFailure(err, req, res);
      }
    })
  );

  return router;
}

module.exports = { createAssistantRouter };
