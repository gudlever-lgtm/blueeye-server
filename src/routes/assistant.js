'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// AI assistant API (opt-in; staff, user-JWT). Mounted at /api/assistant. The
// endpoint always exists when an assistant is wired, but answers 403 while the
// feature is disabled — so the UI can tell "off" apart from "missing".
function createAssistantRouter({ assistant }) {
  const router = express.Router();

  // POST /api/assistant/explain  { question, hostId? } — ask about a host
  // (viewer+). 400 empty question, 403 feature disabled, 500 on provider error.
  router.post(
    '/explain',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
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

  return router;
}

module.exports = { createAssistantRouter };
