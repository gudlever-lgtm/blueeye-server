'use strict';

const express = require('express');
const { asyncHandler, invalid, auditor, userId } = require('./helpers');
const { validateSettingsPatch } = require('../validation');

// The module's settings — discovery budgets, allowlist caps, runner timeouts,
// artefact retention. Every one of them is stored in the database, so this
// router is how they are changed; there is no env var to edit and no redeploy
// (docs/service-assurance.md §6, §7).
//
// Reads are viewer+ (the limits explain why a crawl stopped where it did);
// writes are ADMIN, because these ARE the security controls.
function createSettingsRouter({ settings, audit, requireRole, roles }) {
  const router = express.Router();
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const admin = requireRole(roles.ADMIN);
  const record = auditor(audit);

  router.get('/', read, asyncHandler(async (req, res) => {
    res.json({ settings: await settings.getAll(), defaults: settings.defaults() });
  }));

  router.get('/:section', read, asyncHandler(async (req, res) => {
    const section = await settings.get(req.params.section);
    if (!section) return res.status(404).json({ error: 'Unknown settings section' });
    return res.json(section);
  }));

  router.put('/:section', admin, asyncHandler(async (req, res) => {
    const { value: patch, errors: patchErrors } = validateSettingsPatch(req.body);
    if (patchErrors) return invalid(res, patchErrors);
    const { value, errors } = await settings.set(req.params.section, patch, userId(req));
    if (errors) {
      // An unknown section is a 404, not a validation failure — the caller asked
      // for something that does not exist rather than sending something wrong.
      if (errors.section) return res.status(404).json({ error: 'Unknown settings section' });
      return invalid(res, errors);
    }
    record(req, 'settings_update', req.params.section, Object.keys(patch).join(','));
    return res.json(value);
  }));

  router.post('/:section/reset', admin, asyncHandler(async (req, res) => {
    const { value, errors } = await settings.reset(req.params.section, userId(req));
    if (errors) return res.status(404).json({ error: 'Unknown settings section' });
    record(req, 'settings_reset', req.params.section, '');
    return res.json(value);
  }));

  return router;
}

module.exports = { createSettingsRouter };
