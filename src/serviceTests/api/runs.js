'use strict';

const express = require('express');
const { asyncHandler, notFound, makeLoader, parseId } = require('./helpers');

// Runs and their results. Read-only over HTTP: a run is created by POSTing to a
// test (or by the scheduler), and only the worker writes an outcome.
function createRunsRouter({ repositories, queue, artifacts, requireRole, roles, logger }) {
  const router = express.Router();
  const { runs } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(runs, 'Run');

  const STATUSES = ['queued', 'running', 'pass', 'fail', 'warning', 'skipped', 'error'];

  router.get('/', read, asyncHandler(async (req, res) => {
    let testId = null;
    if (req.query.test_id !== undefined) {
      testId = parseId(req.query.test_id);
      if (testId === null) return res.status(400).json({ error: 'Invalid test_id' });
    }
    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status);
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    }
    const limit = req.query.limit !== undefined ? parseId(req.query.limit) : null;
    return res.json(await runs.list({ testId, status, limit: limit || 50 }));
  }));

  // Whether a worker is processing the queue — the UI shows "no worker
  // connected" instead of leaving a queued run unexplained.
  router.get('/worker-status', read, asyncHandler(async (req, res) => {
    if (!queue) return res.json({ connected: false, workers: [], worker_count: 0, queued: 0, last_seen_at: null, last_claim_at: null });
    return res.json(await queue.workerStatus());
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const run = await load(req, res);
    return run ? res.json(run) : undefined;
  }));

  // The failure screenshot. Streamed from the artefact store rather than the
  // database, and refused when the stored path escapes the root.
  router.get('/:id/screenshot', read, asyncHandler(async (req, res) => {
    const run = await load(req, res);
    if (!run) return undefined;
    if (!run.screenshot_path) return notFound(res, 'No screenshot for this run');
    if (!artifacts) return notFound(res, 'Screenshots are not stored on this server');
    let buffer;
    try {
      buffer = await artifacts.readScreenshot(run.screenshot_path);
    } catch (err) {
      if (logger && logger.warn) logger.warn(`service-tests: screenshot read failed for run ${run.id} (${err.message})`);
      return notFound(res, 'The screenshot is no longer stored');
    }
    const type = run.screenshot_path.endsWith('.png') ? 'image/png'
      : (run.screenshot_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(buffer);
  }));

  return router;
}

module.exports = { createRunsRouter };
