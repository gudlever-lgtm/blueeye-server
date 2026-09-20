'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { parseId } = require('../../validation/locationValidation');
const { validateRiskInput } = require('../../validation/nis2Validation');

// The risk register. Reads are viewer+, mutations operator+, every change
// recorded in the NIS2 audit trail.
function createRisksRouter(ctx) {
  const router = express.Router();
  const { reader, writer, audit, fail, qstr, nis2RisksRepo } = ctx;

  // ---- Risk register --------------------------------------------------------

  router.get('/risks', requireAuth, reader, asyncHandler(async (req, res) => {
    res.json(await nis2RisksRepo.findAll({
      status: qstr(req.query.status),
      category: qstr(req.query.category),
    }));
  }));

  router.get('/risks/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const risk = await nis2RisksRepo.findById(id);
    if (!risk) return res.status(404).json({ error: 'Risk not found' });
    res.json(risk);
  }));

  router.post('/risks', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateRiskInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2RisksRepo.create(value);
    await audit(req, 'create', 'risk', created.id, null, created);
    res.status(201).json(created);
  }));

  router.put('/risks/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2RisksRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Risk not found' });
    const { value, errors } = validateRiskInput(req.body);
    if (errors) return fail(res, errors);
    const updated = await nis2RisksRepo.update(id, value);
    await audit(req, 'update', 'risk', id, before, updated);
    res.json(updated);
  }));

  router.delete('/risks/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2RisksRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Risk not found' });
    await nis2RisksRepo.remove(id);
    await audit(req, 'delete', 'risk', id, before, null);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createRisksRouter };
