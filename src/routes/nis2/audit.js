'use strict';

const express = require('express');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../../auth/middleware');
const { ROLES } = require('../../auth/roles');
const { CATEGORIES } = require('../../nis2/constants');

// The NIS2 audit trail (admin-only), and the get-started seed that gives a new
// install a control register to react to rather than an empty screen.
function createAuditRouter(ctx) {
  const router = express.Router();
  const { writer, audit, qstr, nis2AuditRepo, nis2ControlsRepo } = ctx;

  // ---- Audit trail (admin) --------------------------------------------------

  router.get('/audit', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit, 10);
    res.json(await nis2AuditRepo.findAll({
      entityType: qstr(req.query.entityType),
      limit: Number.isFinite(limit) ? limit : 100,
    }));
  }));

  // ---- Get-started seed -----------------------------------------------------

  // Seeds a baseline control per NIS2 category (status Missing) so a fresh
  // install has something to evidence against. No-op (409) if controls already
  // exist, so it can't duplicate. operator+.
  router.post('/seed', requireAuth, writer, asyncHandler(async (req, res) => {
    const existing = await nis2ControlsRepo.findAll();
    if (existing.length > 0) return res.status(409).json({ error: 'Controls already exist — seed skipped', count: existing.length });
    const created = [];
    for (const area of CATEGORIES) {
      const control = await nis2ControlsRepo.create({
        controlName: `${area} baseline control`, nis2Area: area,
        description: `Starter control for ${area}. Replace with your real assurance activity.`,
        frequency: 'quarterly', status: 'Missing',
      });
      created.push(control);
      await audit(req, 'create', 'control', control.id, null, control);
    }
    res.status(201).json({ created: created.length, controls: created });
  }));

  return router;
}

module.exports = { createAuditRouter };
