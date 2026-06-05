'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// AI assistant API (opt-in; staff, user-JWT). Mounted at /api/assistant. The
// endpoint always exists when an assistant is wired, but answers 403 while the
// feature is disabled — so the UI can tell "off" apart from "missing".
function createAssistantRouter({ assistant, featureGate }) {
  const router = express.Router();

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
        if (err && err.name === 'FeatureDisabled') {
          return res.status(403).json({ error: err.message });
        }
        if (err && err.name === 'InvalidQuestion') {
          return res.status(400).json({ error: 'Validation failed', details: { question: 'question is required' } });
        }
        throw err; // AssistantMisconfigured / AssistantUpstreamError / unknown -> 500
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
        if (err && err.name === 'FeatureDisabled') {
          return res.status(403).json({ error: err.message });
        }
        if (err && err.name === 'LocationNotFound') {
          return res.status(404).json({ error: 'Location not found' });
        }
        throw err; // AssistantMisconfigured / AssistantUpstreamError / unknown -> 500
      }
    })
  );

  return router;
}

module.exports = { createAssistantRouter };
