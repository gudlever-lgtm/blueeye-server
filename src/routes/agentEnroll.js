'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { generateAgentToken, hashToken } = require('../auth/tokens');
const { validateEnroll } = require('../validation/enrollmentValidation');
const { noopRateLimiter } = require('../middleware/rateLimit');

// Best source IP for the enrolling host: the first X-Forwarded-For hop when
// present (proxied installs), else the socket peer. Bounded for the audit row.
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim().slice(0, 64);
  return (req.ip || (req.socket && req.socket.remoteAddress) || '').slice(0, 64) || null;
}

// Agent self-enrollment. This endpoint is intentionally UNAUTHENTICATED — the
// agent has no token yet; the one-time enrollment code is its credential.
// `notifyDashboard` (optional) pushes a live "agent enrolled" event to the UI so
// the enrollment screen flips to "connected" within seconds. `rateLimit`
// throttles code-guessing (defaults to a no-op so tests stay unthrottled).
function createAgentEnrollRouter({ enrollmentStore, notifyDashboard, integrationTrigger = null, auditEventsRepo = null, rateLimit = noopRateLimiter }) {
  const router = express.Router();

  // POST /agents/enroll { code, hostname, platform, arch }
  router.post(
    '/enroll',
    rateLimit,
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
          // Outbound integrations: sync the new agent to IPAM (e.g. Nautobot).
          // Fire-and-forget so a slow/failing target never blocks enrollment.
          if (integrationTrigger && typeof integrationTrigger.emitAgentEvent === 'function') {
            try {
              integrationTrigger.emitAgentEvent('enroll', { id: outcome.agentId, hostname: value.hostname }).catch(() => {});
            } catch { /* never fail enrollment over an integration */ }
          }
          // Audit it — a new agent joining the fleet is a security-relevant event.
          // Discrete row (each enrollment is distinct), best-effort so a recording
          // failure never fails the enrollment itself.
          try {
            if (auditEventsRepo && typeof auditEventsRepo.record === 'function') {
              auditEventsRepo.record({
                actorType: 'agent', actorId: outcome.agentId, actorLabel: value.hostname,
                action: 'agent.enrolled', targetType: 'agent', targetId: outcome.agentId, targetLabel: value.hostname,
                ip: clientIp(req), detail: { platform: value.platform, arch: value.arch },
              }).catch(() => { /* audit is best-effort */ });
            }
          } catch { /* never fail enrollment over an audit write */ }
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
