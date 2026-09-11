'use strict';

const express = require('express');
const { asyncHandler, invalid, notFound, makeLoader, auditor, userId, parseId } = require('./helpers');
const { validateTest, validateRunRequest } = require('../validation');
const { requiresCredential } = require('../engine/validate');
const { catalogue } = require('../engine/dsl');

// Tests: the definitions themselves, plus the button that queues a run.
//
// RBAC: viewer reads, OPERATOR builds and runs. Building a test is day-to-day
// work for the people who watch the service; owning the application, its
// credentials and its allowlist is not.
function createTestsRouter({ repositories, settings, queue, audit, requireRole, roles }) {
  const router = express.Router();
  const { tests, applications, credentials, environments, runs, journeys } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(tests, 'Test');
  const record = auditor(audit);

  // The step catalogue the designer renders its form controls from. Static, but
  // served rather than duplicated in the browser, so the DSL has ONE definition.
  router.get('/step-types', read, (req, res) => res.json({ categories: catalogue() }));

  router.get('/', read, asyncHandler(async (req, res) => {
    const applicationId = req.query.application_id !== undefined ? parseId(req.query.application_id) : null;
    if (req.query.application_id !== undefined && applicationId === null) {
      return res.status(400).json({ error: 'Invalid application_id' });
    }
    const list = await tests.list({ applicationId });
    // The history strip the list screen shows beside each test.
    const enriched = await Promise.all(list.map(async (t) => ({
      ...t,
      step_count: (t.definition && t.definition.steps ? t.definition.steps.length : 0),
      history: await runs.history(t.id, 10),
    })));
    return res.json(enriched);
  }));

  router.post('/', write, asyncHandler(async (req, res) => {
    const runner = await settings.get('runner');
    const { value, errors } = validateTest(req.body, { maxSteps: runner.maxStepsPerTest });
    if (errors) return invalid(res, errors);
    if (!(await applications.findById(value.application_id))) {
      return invalid(res, { application_id: 'that application does not exist' });
    }
    const credentialError = await checkCredential(value);
    if (credentialError) return invalid(res, credentialError);

    const created = await tests.create({ ...value, created_by: userId(req) });
    record(req, 'test_create', created.id, `app=${value.application_id} name=${created.name}`);
    return res.status(201).json(created);
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const test = await load(req, res);
    if (!test) return undefined;
    return res.json({
      ...test,
      history: await runs.history(test.id, 20),
      // Which journeys depend on this test. A test whose purpose is invisible is
      // a test nobody dares delete — and one somebody deletes without knowing
      // they have just stopped watching a customer login.
      journeys: journeys ? await journeys.journeysForTest(test.id) : [],
    });
  }));

  router.put('/:id', write, asyncHandler(async (req, res) => {
    const test = await load(req, res);
    if (!test) return undefined;
    const runner = await settings.get('runner');
    const { value, errors } = validateTest(req.body, { partial: true, maxSteps: runner.maxStepsPerTest });
    if (errors) return invalid(res, errors);
    const credentialError = await checkCredential({ ...test, ...value });
    if (credentialError) return invalid(res, credentialError);

    const saved = await tests.save(test.id, { ...value, updated_by: userId(req) });
    if (!saved) return notFound(res, 'Test not found');
    record(req, 'test_update', test.id, `version=${saved.version}`);
    return res.json(saved);
  }));

  router.delete('/:id', write, asyncHandler(async (req, res) => {
    const test = await load(req, res);
    if (!test) return undefined;
    await tests.remove(test.id);
    record(req, 'test_delete', test.id, `name=${test.name}`);
    return res.status(204).end();
  }));

  router.get('/:id/versions', read, asyncHandler(async (req, res) => {
    const test = await load(req, res);
    if (!test) return undefined;
    return res.json(await tests.versions(test.id));
  }));

  router.get('/:id/history', read, asyncHandler(async (req, res) => {
    const test = await load(req, res);
    if (!test) return undefined;
    const limit = parseId(req.query.limit) || 20;
    return res.json(await runs.history(test.id, limit));
  }));

  // Queue a run. Returns 202 — the browser work happens on the worker, and the
  // API must not hold a request open for the length of a Playwright session.
  router.post('/:id/run', write, asyncHandler(async (req, res) => {
    const test = await load(req, res);
    if (!test) return undefined;
    const { value, errors } = validateRunRequest(req.body);
    if (errors) return invalid(res, errors);

    if (value.environment_id) {
      const env = await environments.findById(value.environment_id);
      if (!env || env.application_id !== test.application_id) {
        return invalid(res, { environment_id: 'that environment does not belong to this application' });
      }
    }

    const run = await runs.enqueue({
      test_id: test.id,
      environment_id: value.environment_id ?? null,
      test_version: test.version,
      trigger_source: 'manual',
      requested_by: userId(req),
    });
    record(req, 'test_run', test.id, `run=${run.id}`);

    // Tell the caller whether anything is actually going to pick this up, so a
    // queued run with no worker reads as a configuration problem rather than a
    // hang.
    const worker = queue ? await queue.workerStatus().catch(() => null) : null;
    return res.status(202).json({ run_id: run.id, status: run.status, worker });
  }));

  // A test that uses {{credential.*}} or a `login` step needs a credential, and
  // that credential must belong to the same application. Catching it at save
  // time beats catching it at 03:00 in a scheduled run.
  async function checkCredential(test) {
    if (!test.definition || !requiresCredential(test.definition)) return null;
    if (!test.credential_id) {
      return { credential_id: 'this test signs in, so it needs a login selected' };
    }
    const cred = await credentials.findById(test.credential_id);
    if (!cred) return { credential_id: 'that login does not exist' };
    if (test.application_id && cred.application_id !== test.application_id) {
      return { credential_id: 'that login belongs to a different application' };
    }
    if (!cred.has_secret) return { credential_id: 'that login has no password stored' };
    return null;
  }

  return router;
}

module.exports = { createTestsRouter };
