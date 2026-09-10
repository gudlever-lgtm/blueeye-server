'use strict';

const express = require('express');
const { asyncHandler, invalid, notFound, makeLoader, auditor, userId, parseId } = require('./helpers');
const { validateDiscoveryRequest } = require('../validation');
const { validateDefinition } = require('../engine/validate');

// Discovery and the suggestions it produces.
//
// OPERATOR+: a crawl is a real action against a customer's system — bounded and
// read-only, but still traffic someone will see in their logs.
function createDiscoveryRouter({ repositories, settings, queue, audit, requireRole, roles }) {
  const router = express.Router();
  const { discovery, applications, environments } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(discovery, 'Discovery');
  const record = auditor(audit);

  router.get('/', read, asyncHandler(async (req, res) => {
    let applicationId = null;
    if (req.query.application_id !== undefined) {
      applicationId = parseId(req.query.application_id);
      if (applicationId === null) return res.status(400).json({ error: 'Invalid application_id' });
    }
    return res.json(await discovery.list({ applicationId, limit: parseId(req.query.limit) || 20 }));
  }));

  // Start a crawl. Queued like a run — Playwright never runs in a request.
  router.post('/', write, asyncHandler(async (req, res) => {
    const { value, errors } = validateDiscoveryRequest(req.body);
    if (errors) return invalid(res, errors);

    const app = await applications.findById(value.application_id);
    if (!app) return invalid(res, { application_id: 'that application does not exist' });

    let scopeUrl = app.base_url;
    if (value.environment_id) {
      const env = await environments.findById(value.environment_id);
      if (!env || env.application_id !== app.id) {
        return invalid(res, { environment_id: 'that environment does not belong to this application' });
      }
      scopeUrl = env.base_url;
    }

    // Per-run budgets may only TIGHTEN the configured ones. An operator cannot
    // widen a crawl past what an admin set in Settings.
    const configured = await settings.get('discovery');
    const budgets = { ...configured };
    for (const [key, val] of Object.entries(value.budgets || {})) {
      if (configured[key] !== undefined) budgets[key] = Math.min(configured[key], val);
    }

    const job = await discovery.enqueue({
      application_id: app.id,
      environment_id: value.environment_id ?? null,
      scope_url: scopeUrl,
      budgets,
      requested_by: userId(req),
    });
    record(req, 'discovery_start', app.id, `discovery=${job.id} scope=${scopeUrl}`);

    const worker = queue ? await queue.workerStatus().catch(() => null) : null;
    return res.status(202).json({ discovery_id: job.id, status: job.status, budgets, worker });
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const job = await load(req, res);
    if (!job) return undefined;
    return res.json({
      ...job,
      pages: await discovery.pages(job.id),
      elements: await discovery.elements(job.id),
      suggestions: await repositories.suggestions.list({ discoveryId: job.id }),
    });
  }));

  return router;
}

// ------------------------------------------------------------- suggestions
createDiscoveryRouter.suggestions = function createSuggestionsRouter({ repositories, settings, audit, requireRole, roles }) {
  const router = express.Router();
  const { suggestions, tests, discovery } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(suggestions, 'Suggestion');
  const record = auditor(audit);

  router.get('/', read, asyncHandler(async (req, res) => {
    const filters = {};
    for (const [param, key] of [['discovery_id', 'discoveryId'], ['application_id', 'applicationId']]) {
      if (req.query[param] === undefined) continue;
      const id = parseId(req.query[param]);
      if (id === null) return res.status(400).json({ error: `Invalid ${param}` });
      filters[key] = id;
    }
    if (req.query.status !== undefined && req.query.status !== '') {
      if (!['proposed', 'accepted', 'dismissed'].includes(String(req.query.status))) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      filters.status = String(req.query.status);
    }
    return res.json(await suggestions.list(filters));
  }));

  // Accepting a suggestion creates a real test from its proposed steps. The
  // steps go through the SAME validator a hand-built test does — a heuristic
  // does not get to write something the designer could not.
  router.post('/:id/accept', write, asyncHandler(async (req, res) => {
    const suggestion = await load(req, res);
    if (!suggestion) return undefined;
    if (suggestion.status !== 'proposed') {
      return res.status(409).json({ error: 'That suggestion has already been handled', status: suggestion.status });
    }

    const runner = await settings.get('runner');
    const name = (req.body && typeof req.body.name === 'string' && req.body.name.trim())
      ? req.body.name.trim().slice(0, 255)
      : suggestion.name;
    const definition = { version: 1, name, steps: suggestion.proposed_steps };
    const { value, errors } = validateDefinition(definition, { maxSteps: runner.maxStepsPerTest });
    if (errors) return invalid(res, errors);

    const created = await tests.create({
      application_id: suggestion.application_id,
      name,
      description: suggestion.description,
      definition: value,
      credential_id: (req.body && parseId(req.body.credential_id)) || null,
      created_by: userId(req),
    });
    const updated = await suggestions.markAccepted(suggestion.id, created.id);
    record(req, 'suggestion_accept', suggestion.id, `test=${created.id} name=${name}`);
    return res.status(201).json({ suggestion: updated, test: created });
  }));

  router.post('/:id/dismiss', write, asyncHandler(async (req, res) => {
    const suggestion = await load(req, res);
    if (!suggestion) return undefined;
    const updated = await suggestions.markDismissed(suggestion.id);
    if (!updated) return res.status(409).json({ error: 'That suggestion has already been handled', status: suggestion.status });
    record(req, 'suggestion_dismiss', suggestion.id, suggestion.name);
    return res.json(updated);
  }));

  // Accept several at once — the "Create selected tests" button in spec §13.
  router.post('/accept-many', write, asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
    if (!ids || !ids.length) return invalid(res, { ids: 'select at least one suggestion' });
    if (ids.length > 50) return invalid(res, { ids: 'at most 50 at a time' });

    const runner = await settings.get('runner');
    const created = [];
    const failed = [];
    for (const rawId of ids) {
      const id = parseId(rawId);
      if (id === null) { failed.push({ id: rawId, error: 'invalid id' }); continue; }
      // eslint-disable-next-line no-await-in-loop
      const suggestion = await suggestions.findById(id);
      if (!suggestion || suggestion.status !== 'proposed') { failed.push({ id, error: 'not available' }); continue; }
      const definition = { version: 1, name: suggestion.name, steps: suggestion.proposed_steps };
      const { value, errors } = validateDefinition(definition, { maxSteps: runner.maxStepsPerTest });
      if (errors) { failed.push({ id, error: 'the proposed steps are not valid', details: errors }); continue; }
      // eslint-disable-next-line no-await-in-loop
      const test = await tests.create({
        application_id: suggestion.application_id,
        name: suggestion.name,
        description: suggestion.description,
        definition: value,
        created_by: userId(req),
      });
      // eslint-disable-next-line no-await-in-loop
      await suggestions.markAccepted(suggestion.id, test.id);
      created.push({ suggestion_id: suggestion.id, test });
    }
    record(req, 'suggestion_accept_many', created.length, `created=${created.length} failed=${failed.length}`);
    return res.status(created.length ? 201 : 400).json({ created, failed });
  }));

  return router;
};

module.exports = { createDiscoveryRouter };
