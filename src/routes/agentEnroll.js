'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { generateAgentToken, hashToken } = require('../auth/tokens');
const { validateEnroll } = require('../validation/enrollmentValidation');

// Agent self-enrollment. This endpoint is intentionally UNAUTHENTICATED — the
// agent has no token yet; the one-time enrollment code is its credential.
// `notifyDashboard` (optional) pushes a live "agent enrolled" event to the UI so
// the enrollment screen flips to "connected" within seconds.
function createAgentEnrollRouter({ enrollmentStore, notifyDashboard }) {
  const router = express.Router();

  // POST /agents/enroll { code, hostname, platform, arch }
  router.post(
    '/enroll',
    asyncHandler(async (req, res) => {
      const { value, errors } = validateEnroll(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }

      // Generate the opaque token here; only its hash is persisted.
      const token = generateAgentToken();
      const outcome = await enrollmentStore.claimAndEnroll({
        code: value.code,
        hostname: value.hostname,
        platform: value.platform,
        arch: value.arch,
        tokenHash: hashToken(token),
      });

      switch (outcome.status) {
        case 'invalid':
          return res.status(401).json({ error: 'Invalid enrollment code' });
        case 'used':
          return res.status(410).json({ error: 'Enrollment code already used' });
        case 'expired':
          return res.status(410).json({ error: 'Enrollment code has expired' });
        case 'ok':
          // Live feedback for the operator watching the enrollment screen.
          if (typeof notifyDashboard === 'function') {
            try {
              notifyDashboard({
                type: 'agent-enrolled',
                payload: { agentId: outcome.agentId, hostname: value.hostname, platform: value.platform, arch: value.arch },
              });
            } catch { /* best-effort; never fail enrollment over a broadcast */ }
          }
          // The plaintext token is returned ONCE, here.
          return res.status(201).json({ agentId: outcome.agentId, token });
        default:
          throw new Error(`Unexpected enrollment outcome: ${outcome.status}`);
      }
    })
  );

  return router;
}

module.exports = { createAgentEnrollRouter };
