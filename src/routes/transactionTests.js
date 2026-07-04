'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');

// Validation helpers
function validateTestInput(body) {
  const errors = {};
  if (!body || typeof body.name !== 'string' || !body.name.trim()) errors.name = 'required';
  if (body.type && body.type !== 'http') errors.type = 'must be "http"';
  if (body.steps !== undefined && !Array.isArray(body.steps)) errors.steps = 'must be an array';
  if (body.agents !== undefined) {
    if (!Array.isArray(body.agents) || body.agents.length === 0) errors.agents = 'must be non-empty array';
  }
  if (body.secrets !== undefined && (typeof body.secrets !== 'object' || Array.isArray(body.secrets))) {
    errors.secrets = 'must be an object';
  }
  if (Object.keys(errors).length) return { errors };

  const steps = (body.steps || []).map((s, i) => {
    if (!s || typeof s !== 'object') return null;
    return {
      name: String(s.name || `Step ${i + 1}`),
      method: String(s.method || 'GET').toUpperCase(),
      url: String(s.url || ''),
      headers: (s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) ? s.headers : {},
      body: s.body !== undefined ? String(s.body) : undefined,
      expect_status: s.expect_status ? Number(s.expect_status) : undefined,
      expect_keyword: s.expect_keyword ? String(s.expect_keyword) : undefined,
      extract: Array.isArray(s.extract) ? s.extract.map((e) => ({ name: String(e.name || ''), regex: String(e.regex || '') })) : [],
    };
  }).filter(Boolean);

  return {
    value: {
      name: body.name.trim(),
      type: body.type || 'http',
      steps,
      secrets: body.secrets || {},
      agents: body.agents || ['all'],
      enabled: body.enabled !== false,
    },
  };
}

function createTransactionTestsRouter({ repo, agentAuth }) {
  const router = express.Router();

  const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });
  const notFound = (res) => res.status(404).json({ error: 'Transaction test not found' });
  const validationError = (res, errors) => res.status(400).json({ error: 'Validation failed', details: errors });

  // List all tests (secrets stripped)
  router.get('/', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await repo.findAll());
    })
  );

  // Matrix: agents × tests latest status
  router.get('/matrix', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const [tests, latest, medians] = await Promise.all([
        repo.findAll(),
        repo.latestPerTestAgent(),
        repo.medianDurationsPerTestAgent(),
      ]);

      const medianMap = {};
      for (const m of medians) {
        medianMap[`${m.test_id}_${m.agent_id}`] = m;
      }

      const cells = {};
      const agentIds = new Set();
      for (const r of latest) {
        agentIds.add(r.agent_id);
        const key = `${r.test_id}_${r.agent_id}`;
        const med = medianMap[key];
        let deviation = null;
        if (med && med.avg_ms && r.duration_ms) {
          deviation = (r.duration_ms - med.avg_ms) / med.avg_ms;
        }
        cells[key] = {
          status: r.status,
          duration_ms: r.duration_ms,
          ran_at: r.ran_at,
          deviation,
          error_detail: r.error_detail,
        };
      }

      res.json({ tests, agent_ids: [...agentIds], cells });
    })
  );

  // Heatmap: time-buckets × agents for one test
  router.get('/heatmap', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const testId = parseId(req.query.test_id);
      if (testId === null) return res.status(400).json({ error: 'Invalid test_id' });
      const test = await repo.findById(testId);
      if (!test) return notFound(res);
      const bucket = ['5m', '15m', '1h'].includes(req.query.bucket) ? req.query.bucket : '5m';
      const hours = Number(req.query.hours) || 24;
      const rows = await repo.heatmapBuckets({ test_id: testId, bucket, hours });
      res.json({ test_id: testId, bucket, hours, rows });
    })
  );

  // Single test (secrets stripped)
  router.get('/:id', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const test = await repo.findById(id);
      if (!test) return notFound(res);
      res.json(test);
    })
  );

  // Create (admin only)
  router.post('/', requireAuth, requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { value, errors } = validateTestInput(req.body);
      if (errors) return validationError(res, errors);
      const created = await repo.create(value);
      res.status(201).json(created);
    })
  );

  // Update (admin only)
  router.put('/:id', requireAuth, requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value, errors } = validateTestInput(req.body);
      if (errors) return validationError(res, errors);
      const existing = await repo.findById(id);
      if (!existing) return notFound(res);
      const updated = await repo.update(id, value);
      res.json(updated);
    })
  );

  // Delete (admin only)
  router.delete('/:id', requireAuth, requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const removed = await repo.remove(id);
      if (!removed) return notFound(res);
      res.status(204).end();
    })
  );

  // Trend: per-step per-day medians for one test
  router.get('/:id/trend', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const test = await repo.findById(id);
      if (!test) return notFound(res);
      const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
      const rows = await repo.stepTrend({ test_id: id, days });
      res.json({ test_id: id, days, rows });
    })
  );

  // Recent results + diagnosis for one test
  router.get('/:id/results', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const test = await repo.findById(id);
      if (!test) return notFound(res);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const results = await repo.findResults({ test_id: id, limit });
      res.json({ test_id: id, results });
    })
  );

  // Ingest result from an agent (agent-token auth)
  router.post('/:id/results', agentAuth,
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const test = await repo.findById(id);
      if (!test) return notFound(res);
      const { status, duration_ms, steps, error_detail, ran_at } = req.body || {};
      if (!status) return res.status(400).json({ error: 'status required' });
      await repo.saveResult({
        test_id: id,
        agent_id: req.agent ? req.agent.id : (req.body.agent_id || 0),
        ran_at: ran_at || new Date(),
        status: String(status),
        duration_ms: duration_ms != null ? Number(duration_ms) : null,
        steps: Array.isArray(steps) ? steps : null,
        error_detail: error_detail || null,
      });
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createTransactionTestsRouter };
