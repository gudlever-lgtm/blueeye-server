'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');

// High-availability status + admin API (license feature `ha_deployment`,
// Enterprise+). The whole router is gated end-to-end (403 upgrade contract when
// the plan lacks ha_deployment) AND requires an authenticated user.
//
//   GET  /api/ha/status  — this node's role (leader/follower) + cluster config
//   GET  /api/ha/nodes   — live cluster topology (one row per active replica)
//   POST /api/ha/step-down (admin) — leader voluntarily releases the lock so a
//                          follower takes over (zero-downtime maintenance)
//
// `haCoordinator` is injected; it abstracts the leader lock + node registry so
// this router needs no DB knowledge.
function createHaRouter({ haCoordinator, featureGate, planService }) {
  const router = express.Router();
  const gate = requirePlanFeature({ featureGate, planService }, 'ha_deployment');

  // Authenticated + licence-gated for every route. Reads are viewer+; the
  // step-down action additionally requires admin.
  router.use(requireAuth, gate);

  router.get('/status', requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    if (!haCoordinator) return res.status(503).json({ error: 'HA not available' });
    res.json(haCoordinator.getStatus());
  }));

  router.get('/nodes', requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    if (!haCoordinator) return res.status(503).json({ error: 'HA not available' });
    res.json({ nodes: await haCoordinator.listNodes() });
  }));

  router.post('/step-down', requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    if (!haCoordinator) return res.status(503).json({ error: 'HA not available' });
    const result = await haCoordinator.stepDown();
    if (!result.ok) {
      // 409: the request is well-formed but this node can't step down right now
      // (HA disabled, or this node isn't the leader).
      return res.status(409).json({ error: 'cannot_step_down', reason: result.reason });
    }
    res.json({ ok: true, status: haCoordinator.getStatus() });
  }));

  return router;
}

module.exports = { createHaRouter };
