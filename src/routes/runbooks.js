'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateRunbookInput } = require('../validation/runbookValidation');

// Runbooks admin CRUD (Fase 3): the static finding-type → recommended-action
// mapping surfaced on the incident (cluster) page. Reads are viewer+ (the incident
// page needs them); writes are admin. A linked playbook, when given, must exist.
function createRunbooksRouter({ runbooksRepo, playbooksRepo = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const admin = requireRole(ROLES.ADMIN);

  function parseId(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // Validates the linked playbook exists (when one is provided). Returns an error
  // string or null.
  async function checkLinkedPlaybook(linkedPlaybookId) {
    if (linkedPlaybookId == null) return null;
    if (!playbooksRepo || typeof playbooksRepo.findById !== 'function') return null;
    const pb = await playbooksRepo.findById(linkedPlaybookId);
    return pb ? null : 'linkedPlaybookId does not reference an existing playbook';
  }

  // GET /api/runbooks — list all. viewer+ (the incident page + admin screen read).
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    res.json({ runbooks: await runbooksRepo.list() });
  }));

  // GET /api/runbooks/playbooks — the remediation playbooks available to link a
  // runbook to (id + name + action type). Defined BEFORE /:id so it isn't parsed
  // as an id. admin (it feeds the admin editor).
  router.get('/playbooks', requireAuth, admin, asyncHandler(async (req, res) => {
    const playbooks = playbooksRepo && typeof playbooksRepo.list === 'function' ? await playbooksRepo.list() : [];
    res.json({ playbooks: playbooks.map((p) => ({ id: p.id, name: p.name, actionType: p.actionType })) });
  }));

  // GET /api/runbooks/:id. viewer+.
  router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const runbook = await runbooksRepo.findById(id);
    if (!runbook) return res.status(404).json({ error: 'Runbook not found' });
    return res.json({ runbook });
  }));

  // POST /api/runbooks — create. admin.
  router.post('/', requireAuth, admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateRunbookInput(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const linkErr = await checkLinkedPlaybook(value.linkedPlaybookId);
    if (linkErr) return res.status(400).json({ error: 'Validation failed', details: { linkedPlaybookId: linkErr } });

    const id = await runbooksRepo.create({ ...value, updatedBy: (req.user && req.user.id) || null });
    return res.status(201).json({ runbook: await runbooksRepo.findById(id) });
  }));

  // PUT /api/runbooks/:id — update. admin.
  router.put('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const { value, errors } = validateRunbookInput(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const linkErr = await checkLinkedPlaybook(value.linkedPlaybookId);
    if (linkErr) return res.status(400).json({ error: 'Validation failed', details: { linkedPlaybookId: linkErr } });

    const ok = await runbooksRepo.update(id, { ...value, updatedBy: (req.user && req.user.id) || null });
    if (!ok) return res.status(404).json({ error: 'Runbook not found' });
    return res.json({ runbook: await runbooksRepo.findById(id) });
  }));

  // DELETE /api/runbooks/:id — remove. admin.
  router.delete('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const ok = await runbooksRepo.remove(id);
    if (!ok) return res.status(404).json({ error: 'Runbook not found' });
    return res.status(204).end();
  }));

  return router;
}

module.exports = { createRunbooksRouter };
