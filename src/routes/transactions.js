'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const {
  validateTransactionInput,
  validateAgentAssignment,
} = require('../validation/transactionValidation');

// REST API for transaction tests (/api/transactions). RBAC: admin writes,
// viewer/operator read. Agents run the tests and report results over the WS
// channel (src/ws/agentSocket.js) — not here.
//
// `pushConfig(agentId)` (optional) notifies a connected agent that its assigned
// tests changed, so it reloads. Best-effort — a missing/failing pusher never
// affects the HTTP response.
function createTransactionsRouter({ repo, pushConfig = null }) {
  const router = express.Router();

  const readRoles = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });
  const notFound = (res) => res.status(404).json({ error: 'Transaction test not found' });
  const invalid = (res, details) => res.status(400).json({ error: 'Validation failed', details });

  function notifyAgents(agentIds) {
    if (typeof pushConfig !== 'function') return;
    for (const aid of agentIds || []) {
      try { Promise.resolve(pushConfig(aid)).catch(() => {}); } catch { /* best-effort */ }
    }
  }

  // Parses an optional ?from/?to date query param → Date or null (400 on bad).
  function parseWindow(req, res) {
    const out = { from: null, to: null, ok: true };
    for (const key of ['from', 'to']) {
      const raw = req.query[key];
      if (raw === undefined || raw === '') continue;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) { res.status(400).json({ error: `Invalid ${key}` }); out.ok = false; return out; }
      out[key] = d;
    }
    return out;
  }

  // List
  router.get('/', requireAuth, readRoles, asyncHandler(async (req, res) => {
    res.json(await repo.list());
  }));

  // Create (admin)
  router.post('/', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const { value, errors } = validateTransactionInput(req.body);
    if (errors) return invalid(res, errors);
    const created = await repo.create(value);
    res.status(201).json(created);
  }));

  // Read one
  router.get('/:id', requireAuth, readRoles, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);
    res.json(test);
  }));

  // Update (admin)
  router.put('/:id', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const { value, errors } = validateTransactionInput(req.body);
    if (errors) return invalid(res, errors);
    const existing = await repo.findById(id);
    if (!existing) return notFound(res);
    const updated = await repo.update(id, value);
    notifyAgents(updated.agent_ids); // config changed → reload assigned agents
    res.json(updated);
  }));

  // Delete (admin)
  router.delete('/:id', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    // Capture assignments before the cascade removes them, so we can tell those
    // agents to drop the test.
    const affected = await repo.agentsFor(id);
    const removed = await repo.remove(id);
    if (!removed) return notFound(res);
    notifyAgents(affected);
    res.status(204).end();
  }));

  // Assign agents (admin)
  router.put('/:id/agents', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);
    const { value, errors } = validateAgentAssignment(req.body);
    if (errors) return invalid(res, errors);
    const before = await repo.agentsFor(id);
    const agentIds = await repo.setAgents(id, value.agent_ids);
    // Notify the union of previous + new assignees (added agents gain the test,
    // removed agents lose it).
    const union = new Set([...before, ...agentIds]);
    notifyAgents([...union]);
    res.json({ test_id: id, agent_ids: agentIds });
  }));

  // Results (viewer+): ?from&to&agent_id
  router.get('/:id/results', requireAuth, readRoles, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);
    const win = parseWindow(req, res);
    if (!win.ok) return undefined;
    let agentId = null;
    if (req.query.agent_id !== undefined && req.query.agent_id !== '') {
      agentId = parseId(req.query.agent_id);
      if (agentId === null) return res.status(400).json({ error: 'Invalid agent_id' });
    }
    const rows = await repo.results({ testId: id, from: win.from, to: win.to, agentId });
    return res.json({ test_id: id, results: rows });
  }));

  // Heatmap (viewer+): ?from&to&bucket → avg_latency/fail_count/sample_count per bucket per agent
  router.get('/:id/heatmap', requireAuth, readRoles, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);
    const win = parseWindow(req, res);
    if (!win.ok) return undefined;
    const bucket = ['5m', '15m', '1h'].includes(req.query.bucket) ? req.query.bucket : '5m';
    const rows = await repo.heatmap({ testId: id, from: win.from, to: win.to, bucket });
    return res.json({ test_id: id, bucket, rows });
  }));

  return router;
}

module.exports = { createTransactionsRouter };
