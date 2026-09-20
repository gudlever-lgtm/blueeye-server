'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth } = require('../../auth/middleware');
const { parseId } = require('../../validation/locationValidation');
const { validateEvidenceInput } = require('../../validation/nis2Validation');

// Evidence REFERENCES — what proves a control, and where that proof lives.
// BlueEyes stores the pointer and its metadata, never the artefact itself.
function createEvidenceRouter(ctx) {
  const router = express.Router();
  const { reader, writer, audit, fail, qstr, nis2EvidenceRepo } = ctx;

  // ---- Evidence -------------------------------------------------------------

  router.get('/evidence', requireAuth, reader, asyncHandler(async (req, res) => {
    // A present-but-invalid entityId must be a 400, not a silently widened
    // "no filter" result set (the convention every :id route here follows).
    let entityId = null;
    if (req.query.entityId !== undefined) {
      entityId = parseId(req.query.entityId);
      if (entityId === null) return res.status(400).json({ error: 'Invalid entityId' });
    }
    res.json(await nis2EvidenceRepo.findAll({
      entityType: qstr(req.query.entityType),
      entityId,
    }));
  }));

  router.post('/evidence', requireAuth, writer, asyncHandler(async (req, res) => {
    const { value, errors } = validateEvidenceInput(req.body);
    if (errors) return fail(res, errors);
    const created = await nis2EvidenceRepo.create({
      ...value, uploadedBy: req.user && req.user.id, uploadedByEmail: req.user && req.user.email,
    });
    await audit(req, 'create', 'evidence', created.id, null, created);
    res.status(201).json(created);
  }));

  router.delete('/evidence/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const before = await nis2EvidenceRepo.findById(id);
    if (!before) return res.status(404).json({ error: 'Evidence not found' });
    await nis2EvidenceRepo.remove(id);
    await audit(req, 'delete', 'evidence', id, before, null);
    res.status(204).end();
  }));

  return router;
}

module.exports = { createEvidenceRouter };
