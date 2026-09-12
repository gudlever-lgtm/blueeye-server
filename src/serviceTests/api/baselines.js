'use strict';

const express = require('express');
const { asyncHandler, invalid, notFound, auditor, userId, parseId } = require('./helpers');
const { normalizeRegions } = require('../visual/compare');

// Visual regression baselines (V2 §8).
//
//   GET    /baselines?test_id=      viewer   what is being watched
//   POST   /baselines               OPERATOR accept a run's screenshot as the baseline
//   PUT    /baselines/:id           OPERATOR ignore regions, tuning, on/off
//   DELETE /baselines/:id           OPERATOR stop watching this step
//   GET    /baselines/:id/image     viewer   the baseline picture
//
// Accepting is deliberately an ACT, not something that happens on first sight. A
// baseline captured automatically would be a picture of whatever the page looked
// like that day — including broken — and every later comparison would be against
// that. Somebody has to say "yes, this is what it should look like", and the row
// records who and when.
function createBaselinesRouter({ repositories, artifacts, audit, requireRole, roles }) {
  const router = express.Router();
  const { baselines, tests, runs, environments } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const record = auditor(audit);

  // The whole feature needs somewhere to read and write pictures. Without an
  // artifact store the routes answer "not available on this server" rather than
  // a confusing validation error about a file that was never going to be there.
  const noStore = (res) => notFound(res, 'Visual baselines are not available on this server');

  const load = async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) { invalid(res, { id: 'that baseline does not look valid' }); return null; }
    const row = await baselines.findById(id);
    if (!row) { notFound(res, 'Baseline not found'); return null; }
    return row;
  };

  router.get('/', read, asyncHandler(async (req, res) => {
    const testId = parseId(req.query.test_id);
    if (testId === null) return invalid(res, { test_id: 'a test is required' });
    if (!(await tests.findById(testId))) return notFound(res, 'Test not found');
    return res.json(await baselines.listForTest(testId));
  }));

  // Accept a run's screenshot as what this step should look like.
  //
  // The image comes from a RUN, never from an upload: a baseline has to be
  // something this test actually produced against this service, or it is a
  // picture of nothing in particular.
  router.post('/', write, asyncHandler(async (req, res) => {
    if (!artifacts) return noStore(res);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const runId = parseId(body.run_id);
    const stepIndex = Number(body.step_index);
    if (runId === null) return invalid(res, { run_id: 'a run is required' });
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      return invalid(res, { step_index: 'which step is this a picture of?' });
    }

    const run = await runs.findById(runId);
    if (!run) return notFound(res, 'Run not found');
    const step = (run.steps || []).find((s) => Number(s.position) === stepIndex);
    if (!step) return invalid(res, { step_index: 'that run has no such step' });

    // The picture must exist. Accepting a baseline that points at nothing would
    // leave a step "watched" while every comparison answers "uncomparable".
    const source = (run.visual || []).find((v) => Number(v.step_index) === stepIndex);
    const path = (source && source.image_path) || (stepIndex === run.failed_step ? run.screenshot_path : null);
    if (!path) {
      return invalid(res, { step_index: 'that run kept no picture of this step' });
    }

    let image;
    try { image = await artifacts.readScreenshot(path); } catch {
      return invalid(res, { run_id: 'that run\'s screenshot is no longer on disk' });
    }

    const environmentId = body.environment_id === undefined
      ? (run.environment_id ?? null) : parseId(body.environment_id);
    if (body.environment_id !== undefined && body.environment_id !== null && environmentId === null) {
      return invalid(res, { environment_id: 'that environment does not look valid' });
    }
    if (environmentId !== null) {
      const env = await environments.findById(environmentId);
      if (!env || env.application_id !== run.application_id) {
        return invalid(res, { environment_id: 'that environment does not belong to this application' });
      }
    }

    const stored = await artifacts.saveBaseline(run.test_id, image, { stepIndex, environmentId });
    const saved = await baselines.accept({
      test_id: run.test_id,
      step_index: stepIndex,
      step_label: step.label || null,
      environment_id: environmentId,
      image_path: stored,
      width: (source && source.size && source.size.width) || null,
      height: (source && source.size && source.size.height) || null,
      accepted_by: userId(req),
      source_run_id: run.id,
    });
    record(req, 'baseline_accept', saved.id, `test=${run.test_id} step=${stepIndex}`);
    return res.status(201).json(saved);
  }));

  // Ignore regions, tuning and the on/off switch.
  //
  // NOT the image. Replacing what the page should look like is accepting a new
  // baseline, which records who did it and when; letting an edit swap the
  // picture would lose that.
  router.put('/:id', write, asyncHandler(async (req, res) => {
    const existing = await load(req, res);
    if (!existing) return undefined;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const patch = {};

    if (body.ignore_regions !== undefined) {
      if (body.ignore_regions !== null && !Array.isArray(body.ignore_regions)) {
        return invalid(res, { ignore_regions: 'ignore regions must be a list of rectangles' });
      }
      // Normalised against the baseline's own size, so a rectangle drawn off the
      // page collapses and is dropped rather than silently excluding a corner
      // nobody selected.
      patch.ignore_regions = normalizeRegions(body.ignore_regions || [], existing.width || 100000, existing.height || 100000)
        .map((r) => ({ x: r.x1, y: r.y1, width: r.x2 - r.x1, height: r.y2 - r.y1, label: r.label }));
      if ((body.ignore_regions || []).length && !patch.ignore_regions.length) {
        return invalid(res, { ignore_regions: 'none of those rectangles are on the page' });
      }
    }
    if (body.tolerance !== undefined) {
      const n = Number(body.tolerance);
      if (body.tolerance !== null && (!Number.isInteger(n) || n < 0 || n > 255)) {
        return invalid(res, { tolerance: 'tolerance must be between 0 and 255' });
      }
      patch.tolerance = body.tolerance === null ? null : n;
    }
    if (body.threshold_pct !== undefined) {
      const n = Number(body.threshold_pct);
      if (body.threshold_pct !== null && (!Number.isFinite(n) || n < 0 || n > 100)) {
        return invalid(res, { threshold_pct: 'the threshold must be a percentage between 0 and 100' });
      }
      patch.threshold_pct = body.threshold_pct === null ? null : n;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return invalid(res, { enabled: 'enabled must be true or false' });
      patch.enabled = body.enabled;
    }

    const saved = await baselines.save(existing.id, patch);
    if (!saved) return notFound(res, 'Baseline not found');
    record(req, 'baseline_update', existing.id, Object.keys(patch).join(','));
    return res.json(saved);
  }));

  router.delete('/:id', write, asyncHandler(async (req, res) => {
    const existing = await load(req, res);
    if (!existing) return undefined;
    await baselines.remove(existing.id);
    // The image on disk is left where it is. A baseline row is cheap to delete
    // and an unlinked file is swept with the rest; deleting the picture here
    // would make an accidental delete unrecoverable.
    record(req, 'baseline_delete', existing.id, `test=${existing.test_id} step=${existing.step_index}`);
    return res.status(204).end();
  }));

  router.get('/:id/image', read, asyncHandler(async (req, res) => {
    const existing = await load(req, res);
    if (!existing) return undefined;
    if (!artifacts) return noStore(res);
    let image;
    try { image = await artifacts.readScreenshot(existing.image_path); } catch {
      return notFound(res, 'That baseline image is no longer on disk');
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(image);
  }));

  return router;
}

module.exports = { createBaselinesRouter };
