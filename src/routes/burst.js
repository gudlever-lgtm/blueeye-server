'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateBurstRequest, validateBurstQuery } = require('../validation/burstValidation');

// Burst mode: measure one target once a second for up to two minutes.
//
// RBAC. Reading is viewer+ — a finished burst is a measurement, the same class
// as a probe result. STARTING one is operator+: it makes an agent emit traffic
// at a rate nothing else here does, and that is an operator's call. It is not
// admin, because the person standing in front of the fault at 02:00 is usually
// not an admin, and a tool they cannot reach is a tool that does not exist.
function createBurstRouter({ burstRunsRepo, burstService, agentsRepo, logger = null }) {
  const router = express.Router();
  const viewer = [requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN)];
  const operator = [requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN)];

  router.get('/', ...viewer, asyncHandler(async (req, res) => {
    const errors = {};
    const filter = validateBurstQuery(req.query, errors);
    if (!filter) return res.status(400).json({ error: 'Validation failed', details: errors });

    if (filter.agentId != null) {
      const agent = await agentsRepo.findById(filter.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
    }
    const runs = await burstRunsRepo.list(filter);
    res.json({ runs, hasMore: runs.length === filter.limit });
  }));

  // One run, WITH its samples — the only read that carries them. A list of
  // twenty runs would otherwise be an order of magnitude larger for data
  // nobody plots until they open one.
  router.get('/:id', ...viewer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const run = await burstRunsRepo.findById(id, { withSamples: true });
    if (!run) return res.status(404).json({ error: 'Burst run not found' });
    res.json({ run });
  }));

  router.post('/', ...operator, asyncHandler(async (req, res) => {
    const { value, errors } = validateBurstRequest(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const agent = await agentsRepo.findById(value.agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!burstService) return res.status(503).json({ error: 'Burst mode is not configured' });

    const out = await burstService.start({ ...value, createdBy: req.user && req.user.id });
    if (out.error === 'no_channel') return res.status(503).json({ error: 'No agent channel is configured' });
    if (out.error === 'not_connected') {
      // 409, and the run id, so the screen can show the recorded failure
      // rather than a dispatch that vanished.
      return res.status(409).json({ error: 'The agent is not connected', runId: out.runId });
    }

    // 202: the agent does the measuring, so the samples arrive over the
    // WebSocket and the verdict lands a minute or two later. Answering 200
    // would claim a finished measurement that has not started.
    res.status(202).json({ run: out.run });
  }));

  // Stop early. The technician watching the chart saw what they needed;
  // finishing the remaining ninety seconds serves nobody.
  router.post('/:id/stop', ...operator, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const run = await burstRunsRepo.findById(id);
    if (!run) return res.status(404).json({ error: 'Burst run not found' });
    if (run.status !== 'running') {
      return res.status(409).json({ error: 'That burst has already finished', status: run.status });
    }
    if (!burstService) return res.status(503).json({ error: 'Burst mode is not configured' });

    const sent = burstService.stop(run.agentId);
    if (!sent) return res.status(409).json({ error: 'The agent is not connected' });
    // 202 again: the agent stops at its next tick and reports the partial run.
    res.status(202).json({ ok: true, runId: id });
  }));

  return router;
}

module.exports = { createBurstRouter };
