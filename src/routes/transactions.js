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
const { explainPhases, totalPhases } = require('../analysis/transactionPhases');

// REST API for transaction tests (/api/transactions). RBAC: admin writes,
// viewer/operator read. Agents run the tests and report results over the WS
// channel (src/ws/agentSocket.js). Secrets are write-only — never returned.
//
// `pushConfig(agentId)` (optional) notifies a connected agent its assigned tests
// changed. Best-effort — never affects the HTTP response.
// `runNow(agentId, { testId, capture })` asks one agent to run one test
// immediately over its WebSocket and resolves with the agent's reply. Optional:
// without it the run-now endpoints answer 503 rather than pretending.
function createTransactionsRouter({ repo, pushConfig = null, runNow = null, logger = null }) {
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
    const created = await repo.create({ ...value, created_by: req.user ? req.user.id : null });
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
    const existing = await repo.findById(id);
    if (!existing) return notFound(res);
    // When the body omits `secrets`, secret references are validated against the
    // already-stored secret names.
    const { value, errors } = validateTransactionInput(req.body, { existingSecretNames: existing.secret_names || [] });
    if (errors) return invalid(res, errors);
    const updated = await repo.update(id, value);
    notifyAgents(updated.agent_ids);
    res.json(updated);
  }));

  // Delete (admin)
  router.delete('/:id', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
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
    notifyAgents([...new Set([...before, ...agentIds])]);
    res.json({ test_id: id, agent_ids: agentIds });
  }));

  // Run one test NOW on one agent (operator+), and answer with what came back.
  //
  // WHY THIS EXISTS. Tests run on their own interval, and the moment somebody
  // reports a fault is the moment nobody wants to wait out an interval. This is
  // "a customer is on the phone about this system — test it while I watch".
  //
  // `capture: true` keeps the packet headers of the traffic THIS run generates,
  // whatever the test's own mode says: somebody asked for this specific run, and
  // it is the one run where the wire-level answer is wanted whether or not it
  // failed. It is operator+ rather than admin because the capture can only ever
  // contain traffic the agent itself is about to send (the filter is derived
  // from the test, not typed) — configuring `always` on a test stays admin.
  router.post('/:id/run', requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const agentId = parseId(body.agent_id);
    if (agentId === null) return invalid(res, { agent_id: 'agent_id is required (a positive integer)' });
    const assigned = await repo.agentsFor(id);
    // Not 403: from the caller's side this agent does not run this test, which
    // is a fact about the pair rather than a permission they could be granted.
    if (!assigned.includes(agentId)) return invalid(res, { agent_id: 'that agent is not assigned to this test' });
    if (body.capture !== undefined && typeof body.capture !== 'boolean') return invalid(res, { capture: 'capture must be a boolean' });
    if (typeof runNow !== 'function') return res.status(503).json({ error: 'On-demand runs are not configured' });

    let reply;
    try {
      reply = await runNow(agentId, { testId: id, capture: body.capture === true });
    } catch (err) {
      if (logger) logger.error(`transaction run-now failed for test ${id} on agent ${agentId}:`, err);
      return res.status(502).json({ error: 'The agent could not be asked to run this test' });
    }
    if (!reply || !reply.delivered) return res.status(409).json({ error: 'That agent is not connected' });
    if (!reply.acked) return res.status(504).json({ error: 'The agent did not answer in time; the run may still be in progress' });

    const out = (reply.reply && reply.reply.transaction) || {};
    if (!out.ok) return res.status(409).json({ error: out.error || 'The agent refused to run that test' });
    // The result is also on its way through the normal ingest path, so this
    // response is the echo, not the record. Returning it means the screen can
    // show the answer without polling for the row to land.
    const result = out.result || null;
    return res.json({
      test_id: id,
      agent_id: agentId,
      result,
      phases: result ? explainPhases(result) : null,
      totals: result ? totalPhases(result) : null,
    });
  }));

  // Captures for a test (viewer+): ?from&to&agent_id. Summaries only — the
  // packet list is a separate read, because it is by far the largest thing
  // stored here and a list has no use for it.
  router.get('/:id/captures', requireAuth, readRoles, asyncHandler(async (req, res) => {
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
    return res.json({ test_id: id, captures: await repo.captures({ testId: id, agentId, from: win.from, to: win.to }) });
  }));

  // One capture, WITH its packets (viewer+): ?agent_id&time — the same natural
  // key the result row carries.
  router.get('/:id/captures/one', requireAuth, readRoles, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);
    const agentId = parseId(req.query.agent_id);
    if (agentId === null) return res.status(400).json({ error: 'Invalid agent_id' });
    const time = req.query.time ? new Date(req.query.time) : null;
    if (!time || Number.isNaN(time.getTime())) return res.status(400).json({ error: 'Invalid time' });
    const capture = await repo.findCapture({ testId: id, agentId, time });
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    return res.json(capture);
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
    const results = await repo.results({ testId: id, from: win.from, to: win.to, agentId });
    // The network-or-application verdict is derived on read rather than stored:
    // unlike a capture's verdict it is a pure function of columns that are right
    // here in the row, so there is nothing to go stale and nothing to migrate
    // when the rule improves.
    //
    // `has_capture` says which rows have packets behind them, so a list can show
    // the marker without fetching any of them.
    const withCapture = typeof repo.captureKeysFor === 'function'
      ? await repo.captureKeysFor(id, results.map((r) => r.time))
      : new Set();
    return res.json({
      test_id: id,
      results: results.map((r) => ({
        ...r,
        phase_verdict: r.step_phases ? explainPhases(r) : null,
        has_capture: withCapture.has(`${r.agent_id}|${r.time}`),
      })),
    });
  }));

  // Heatmap (viewer+): ?from&to&bucket
  router.get('/:id/heatmap', requireAuth, readRoles, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);
    const win = parseWindow(req, res);
    if (!win.ok) return undefined;
    const bucket = ['5m', '15m', '1h'].includes(req.query.bucket) ? req.query.bucket : '5m';
    return res.json({ test_id: id, bucket, rows: await repo.heatmap({ testId: id, from: win.from, to: win.to, bucket }) });
  }));

  // Trend (viewer+): ?agent_id&days=7 — median per day per step.
  router.get('/:id/trend', requireAuth, readRoles, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await repo.findById(id);
    if (!test) return notFound(res);
    const agentId = parseId(req.query.agent_id);
    if (agentId === null) return res.status(400).json({ error: 'agent_id is required' });
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    return res.json({ test_id: id, agent_id: agentId, days, rows: await repo.trend({ testId: id, agentId, days }) });
  }));

  return router;
}

module.exports = { createTransactionsRouter };
