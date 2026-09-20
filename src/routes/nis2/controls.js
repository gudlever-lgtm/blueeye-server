'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { parseId } = require('../../validation/locationValidation');
const { validateControlInput } = require('../../validation/nis2Validation');

// The control register — the measures claimed against the risks, with their
// evidence state. Same RBAC + audit shape as the risk register.
function createControlsRouter(ctx) {
  const router = express.Router();
  const { reader, writer, audit, fail, qstr, nis2ControlsRepo } = ctx;

  // ---- Controls -------------------------------------------------------------

  router.get('/controls', requireAuth, reader, asyncHandler(async (req, res) => {
    if (req.query.withoutEvidence === 'true') {
      return res.json(await nis2ControlsRepo.findWithoutEvidence());
    }
    res.json(await nis2ControlsRepo.findAll({
      status: qstr(req.query.status),
      area: qstr(req.query.area),
    }));
  }));

  router.get('/controls/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const control = await nis2ControlsRepo.findById(id);
    if (!control) return res.status(404).json({ error: 'Control not found' });
    res.json(control);
  }));

  router.post('/controls', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateControlInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2ControlsRepo.create(value);
    await audit(req, 'create', 'control', created.id, null, created);
    res.status(201).json(created);
  }));

  router.put('/controls/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2ControlsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Control not found' });
    const { value, errors } = validateControlInput(req.body);
    if (errors) return fail(res, errors);
    const updated = await nis2ControlsRepo.update(id, value);
    await audit(req, 'update', 'control', id, before, updated);
    res.json(updated);
  }));

  router.delete('/controls/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2ControlsRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Control not found' });
    await nis2ControlsRepo.remove(id);
    await audit(req, 'delete', 'control', id, before, null);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createControlsRouter };
