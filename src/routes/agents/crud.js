'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../../auth/middleware');
const { ROLES } = require('../../auth/roles');
const { parseId } = require('../../validation/locationValidation');
const { validateAgentPosition, validateAgentManagedInput, MAX_INTERVAL_MS } = require('../../validation/agentValidation');
const { validateTimeRange } = require('../../validation/resultsValidation');
const { aggregateFlows } = require('./flows');

// The agent RECORD: list, read, edit its server-managed fields, delete it, and
// read what it has reported (audit rows, results, flows).
//
// RBAC: viewer+ reads, operator/admin edits metadata, admin deletes. Agents are
// created by ENROLLMENT, so there is deliberately no POST here.
function createAgentCrudRouter(ctx) {
  const router = express.Router();
  const {
    agentsRepo, locationsRepo, resultsRepo, auditRepo, agentCommander,
    auditLogger, integrationTrigger, logger,
    invalidId, notFound, validationError, recordRequested, markFailed,
  } = ctx;

  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const agents = await agentsRepo.findAll();
      const getStatus = agentCommander && typeof agentCommander.getSflowStatus === 'function'
        ? agentCommander.getSflowStatus
        : () => null;
      // Only attach hsflowd when the agent has actually reported a status, so
      // the response shape is unchanged for the common (non-sflow) case.
      res.json(agents.map((a) => {
        const hs = getStatus(a.id);
        return hs ? { ...a, hsflowd: hs } : a;
      }));
    })
  );

  // GET /agents/:id
  router.get(
    '/:id',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      res.json(agent);
    })
  );

  // GET /agents/:id/audit — the upgrade/delete action trail for one agent
  // (requested -> completed/failed), newest first. admin only.
  router.get(
    '/:id/audit',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      if (!auditRepo || typeof auditRepo.findByAgent !== 'function') {
        return res.status(503).json({ error: 'Audit log not available' });
      }
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      res.json(await auditRepo.findByAgent(id, { limit: 100 }));
    })
  );

  // GET /agents/:id/results — results reported by the agent. viewer+ (user RBAC).
  // Optional time range: ?from=&to=&limit= (ISO dates; newest first).
  router.get(
    '/:id/results',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value: range, errors } = validateTimeRange(req.query);
      if (errors) return validationError(res, errors);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      res.json(await resultsRepo.findByAgentId(id, range));
    })
  );

  // GET /agents/:id/flows?port=&protocol=&from=&to= — search NetFlow data the
  // agent reported (only present when its source is 'netflow'). Aggregates the
  // byPort / byProtocol entries across the matching measurements in the range,
  // optionally filtered by a specific port and/or protocol. viewer+.
  router.get(
    '/:id/flows',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value: range, errors } = validateTimeRange(req.query);
      if (errors) return validationError(res, errors);
      // Optional filters.
      let port = null;
      if (req.query.port !== undefined && req.query.port !== '') {
        if (!/^\d+$/.test(String(req.query.port))) {
          return validationError(res, { port: 'port must be an integer' });
        }
        port = Number(req.query.port);
      }
      const protocol = req.query.protocol ? String(req.query.protocol).toLowerCase() : null;

      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

      const rows = await resultsRepo.findByAgentId(id, range);
      res.json({
        agentId: id,
        filter: { port, protocol },
        from: range.from ? range.from.toISOString() : null,
        to: range.to ? range.to.toISOString() : null,
        measurements: rows.length,
        ...aggregateFlows(rows, { port, protocol }),
      });
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
      if (id === null) return invalidId(res);

      const { value, errors } = validateAgentManagedInput(req.body);
      if (errors) return validationError(res, errors);

      const existing = await agentsRepo.findById(id);
      if (!existing) return notFound(res);

      // Reject a location_id that doesn't reference an existing location, so
      // the client gets a 400 rather than a foreign-key 500.
      if (value.location_id !== null && !(await locationsRepo.findById(value.location_id))) {
        return validationError(res, { location_id: 'location_id does not reference an existing location' });
      }

      const updated = await agentsRepo.updateManaged(id, value);
      res.json(updated);
    })
  );

  // PUT /agents/:id/position { latitude, longitude } | { coordinates: "lat, lng" }
  // — the agent's OWN map position, for an agent whose site is not where it
  // runs (a cloud data centre, a VPN exit). Both null = use the site's again.
  // The traceroute map measures every hop from it. operator or admin.
  router.put(
    '/:id/position',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value, errors } = validateAgentPosition(req.body);
      if (errors) return validationError(res, errors);
      if (!(await agentsRepo.findById(id))) return notFound(res);
      const updated = await agentsRepo.setPosition(id, value.latitude, value.longitude);
      if (!updated) return notFound(res);
      res.json(updated);
    })
  );

  // DELETE /agents/:id — admin only. Force-removes the server-side record without
  // coordinating with the agent (use POST /:id/delete for graceful removal).
  router.delete(
    '/:id',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      // Snapshot the agent before removal so the audit + integration event carry
      // hostname/location (they survive after the row is gone).
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      // Audit 'requested' before the irreversible delete so the record exists even
      // if the remove query fails. Completed immediately (synchronous operation).
      const auditId = await recordRequested('force-delete', agent, req);
      const removed = await agentsRepo.remove(id);
      if (!removed) {
        await markFailed(auditId, 'row already gone');
        return notFound(res);
      }
      if (auditId && auditRepo && typeof auditRepo.complete === 'function') {
        try { await auditRepo.complete(auditId, { state: 'completed', resultDetail: 'force-removed' }); } catch (err) { logger.warn(`agents: audit complete(force-delete) for ${id} failed (${err.message})`); }
      }
      // Outbound integrations: notify IPAM the agent is gone. Fire-and-forget; an
      // integration NEVER blocks or fails the delete (deletion is one-way and
      // gated by the connector's own allow-delete flag).
      if (integrationTrigger && typeof integrationTrigger.emitAgentEvent === 'function') {
        try { integrationTrigger.emitAgentEvent('delete', agent).catch(() => {}); } catch { /* best-effort */ }
      }
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createAgentCrudRouter };
