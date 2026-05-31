'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateAgentManagedInput } = require('../validation/agentValidation');
const { parseId } = require('../validation/locationValidation');

// Agents router with role-based access control:
//   - viewer+        may read         (GET)
//   - operator/admin may edit metadata (PUT — server-managed fields only)
//   - admin          may delete       (DELETE)
//
// Agents are created via enrollment (prompt 4) — there is intentionally no
// manual POST /agents here.
function createAgentsRouter({ agentsRepo, locationsRepo, resultsRepo, agentCommander }) {
  const router = express.Router();

  // POST /agents/:id/run-test — push a "run test" command to a connected agent
  // over the live WebSocket. operator/admin. Returns 202 with how many
  // connections received it, 409 if the agent isn't currently connected.
  router.post(
    '/:id/run-test',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const agent = await agentsRepo.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const command = { name: 'run-test' };
      if (Number.isInteger(body.intervalMs)) command.intervalMs = body.intervalMs;

      const delivered = agentCommander ? agentCommander.sendCommand(id, command) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      res.status(202).json({ delivered, agentId: id });
    })
  );

  // GET /agents — list, with the joined location name.
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await agentsRepo.findAll());
    })
  );

  // GET /agents/:id
  router.get(
    '/:id',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const agent = await agentsRepo.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.json(agent);
    })
  );

  // GET /agents/:id/results — results reported by the agent. viewer+ (user RBAC).
  router.get(
    '/:id/results',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const agent = await agentsRepo.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.json(await resultsRepo.findByAgentId(id));
    })
  );

  // PUT /agents/:id — updates ONLY the server-managed fields
  // (display_name, location_id, notes, meta). operator or admin.
  router.put(
    '/:id',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      const { value, errors } = validateAgentManagedInput(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }

      const existing = await agentsRepo.findById(id);
      if (!existing) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Reject a location_id that doesn't reference an existing location, so
      // the client gets a 400 rather than a foreign-key 500.
      if (value.location_id !== null && !(await locationsRepo.findById(value.location_id))) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { location_id: 'location_id does not reference an existing location' },
        });
      }

      const updated = await agentsRepo.updateManaged(id, value);
      res.json(updated);
    })
  );

  // DELETE /agents/:id — admin only.
  router.delete(
    '/:id',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const removed = await agentsRepo.remove(id);
      if (!removed) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createAgentsRouter };
