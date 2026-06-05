'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateTestPackageInput } = require('../validation/testPackageValidation');

// Test packages: viewer+ may read; operator/admin may create/edit/delete and
// trigger a run. A run pushes the package's items to the resolved, connected
// agents (the runner) — agents execute and report back as usual.
function createTestPackagesRouter({ repo, runner }) {
  const router = express.Router();

  const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });
  const notFound = (res) => res.status(404).json({ error: 'Test package not found' });
  const validationError = (res, details) => res.status(400).json({ error: 'Validation failed', details });

  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await repo.findAll());
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const pkg = await repo.findById(id);
      if (!pkg) return notFound(res);
      res.json(pkg);
    })
  );

  router.post(
    '/',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { value, errors } = validateTestPackageInput(req.body);
      if (errors) return validationError(res, errors);
      const created = await repo.create({ ...value, created_by: req.user ? req.user.id : null });
      res.status(201).json(created);
    })
  );

  router.put(
    '/:id',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const { value, errors } = validateTestPackageInput(req.body);
      if (errors) return validationError(res, errors);
      const existing = await repo.findById(id);
      if (!existing) return notFound(res);
      res.json(await repo.update(id, value));
    })
  );

  router.delete(
    '/:id',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const removed = await repo.remove(id);
      if (!removed) return notFound(res);
      res.status(204).end();
    })
  );

  // Run now: push the package to its connected targets immediately.
  router.post(
    '/:id/run',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return invalidId(res);
      const pkg = await repo.findById(id);
      if (!pkg) return notFound(res);
      if (!runner || typeof runner.run !== 'function') {
        return res.status(503).json({ error: 'Test runner not available' });
      }
      const summary = await runner.run(pkg);
      res.status(202).json(summary);
    })
  );

  return router;
}

module.exports = { createTestPackagesRouter };
