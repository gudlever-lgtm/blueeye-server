'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateAgentManagedInput } = require('../validation/agentValidation');
const { validateTimeRange } = require('../validation/resultsValidation');
const { validateProbeSpec } = require('../validation/probeValidation');
const { parseId } = require('../validation/locationValidation');

// Aggregates the byPort / byProtocol / topTalkers entries across a set of
// NetFlow measurements, optionally filtered to one port and/or protocol.
// `series` is the matched bytes per measurement (oldest first) and is only
// populated when a port or protocol filter is active. Pure; exported for tests.
function aggregateFlows(rows, { port = null, protocol = null } = {}) {
  const byPort = new Map();
  const byProtocol = new Map();
  const byTalker = new Map();
  const series = [];

  const bump = (map, key, e) => {
    const cur = map.get(key) || { bytes: 0, packets: 0, flows: 0 };
    cur.bytes += Number(e.bytes) || 0;
    cur.packets += Number(e.packets) || 0;
    cur.flows += Number(e.flows) || 0;
    map.set(key, cur);
  };

  for (const row of rows) {
    const t = row.payload && row.payload.traffic;
    if (!t || (!t.byPort && !t.byProtocol && !t.topTalkers)) continue;
    let matchBytes = 0;
    for (const e of t.byPort || []) {
      if (port !== null && e.port !== port) continue;
      bump(byPort, e.port, e);
      if (port !== null) matchBytes += Number(e.bytes) || 0;
    }
    for (const e of t.byProtocol || []) {
      if (protocol && String(e.protocol).toLowerCase() !== protocol) continue;
      bump(byProtocol, e.protocol, e);
      if (protocol && port === null) matchBytes += Number(e.bytes) || 0;
    }
    for (const e of t.topTalkers || []) bump(byTalker, e.pair, e);
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    if (port !== null || protocol) series.push({ at, bytes: matchBytes });
  }

  const sortMap = (map, key) =>
    Array.from(map.entries())
      .map(([k, v]) => ({ [key]: k, ...v }))
      .sort((a, b) => b.bytes - a.bytes);

  return {
    byPort: sortMap(byPort, 'port'),
    byProtocol: sortMap(byProtocol, 'protocol'),
    topTalkers: sortMap(byTalker, 'pair').slice(0, 50),
    series: series.reverse(), // oldest first
  };
}

// Agents router with role-based access control:
//   - viewer+        may read         (GET)
//   - operator/admin may edit metadata (PUT — server-managed fields only)
//   - admin          may delete       (DELETE)
//
// Agents are created via enrollment (prompt 4) — there is intentionally no
// manual POST /agents here.
function createAgentsRouter({ agentsRepo, locationsRepo, resultsRepo, agentCommander }) {
  const router = express.Router();

  // Response helpers for the error shapes repeated across this router.
  const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });
  const notFound = (res) => res.status(404).json({ error: 'Agent not found' });
  const validationError = (res, details) => res.status(400).json({ error: 'Validation failed', details });

  // POST /agents/:id/run-test — push a "run test" command to a connected agent
  // over the live WebSocket. operator/admin. Returns 202 with how many
  // connections received it, 409 if the agent isn't currently connected.
  router.post(
    '/:id/run-test',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);

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

  // POST /agents/:id/probe — push an active probe (ping/tcp/dns/traceroute) to a
  // connected agent. operator/admin. The agent runs it and reports back via
  // POST /agents/probe-results. 409 if the agent isn't connected.
  router.post(
    '/:id/probe',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value: probe, errors } = validateProbeSpec(req.body);
      if (errors) return validationError(res, errors);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      const delivered = agentCommander ? agentCommander.sendCommand(id, { name: 'run-probe', probe }) : 0;
      if (delivered === 0) {
        return res.status(409).json({ error: 'Agent not connected', delivered: 0 });
      }
      res.status(202).json({ delivered, agentId: id, probe });
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
      if (id === null) return invalidId(res);
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res);
      res.json(agent);
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

  // DELETE /agents/:id — admin only.
  router.delete(
    '/:id',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const removed = await agentsRepo.remove(id);
      if (!removed) return notFound(res);
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createAgentsRouter, aggregateFlows };
