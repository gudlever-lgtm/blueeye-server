'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// Alerting API. Mounted at /api/alerting behind the user JWT.
function createAlertingRouter({ dispatcher }) {
  const router = express.Router();

  // GET /api/alerting/config — active channels + rules, without secrets (viewer+).
  router.get(
    '/config',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    (req, res) => res.json(dispatcher.describe())
  );

  // POST /api/alerting/test { channel } — send a test finding to one channel
  // (operator+). 404 for an unknown channel; 400 if channel is missing.
  router.post(
    '/test',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const channel = req.body && req.body.channel;
      if (!channel || typeof channel !== 'string') {
        return res.status(400).json({ error: 'Validation failed', details: { channel: 'channel is required' } });
      }
      if (!dispatcher.channelNames().includes(channel)) {
        return res.status(404).json({ error: 'Unknown channel' });
      }
      const result = await dispatcher.test(channel);
      res.json({ channel, result });
    })
  );

  return router;
}

module.exports = { createAlertingRouter };
