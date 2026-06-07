'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateLdapConfig, validateRoleMap } = require('../validation/ldapValidation');

// LDAP/AD configuration API. Admin-only. Mounted at /api/ldap behind the user
// JWT. The bind password is encrypted (secret box) before it touches the DB and
// is NEVER returned. The login flow itself lives in src/routes/auth.js.
function createLdapRouter({ ldapConfigRepo, ldapRoleMapRepo, ldapAuth = null, secretBox, authEnabledFlag = false }) {
  const router = express.Router();

  router.use(requireAuth, requireRole(ROLES.ADMIN));

  // GET /api/ldap/config — the stored config (safe; no bind password) plus the
  // hard env gate, so the UI can show "enabled in env?" vs "enabled in config?".
  router.get('/config', asyncHandler(async (req, res) => {
    const config = await ldapConfigRepo.get();
    res.json({ authEnabledFlag: Boolean(authEnabledFlag), config: config || null });
  }));

  // PUT /api/ldap/config — upsert the single config row.
  router.put('/config', asyncHandler(async (req, res) => {
    const { value, errors } = validateLdapConfig(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const patch = {
      host: value.host, port: value.port, useTls: value.useTls, bindDn: value.bindDn,
      baseDn: value.baseDn, userFilter: value.userFilter, groupFilter: value.groupFilter, enabled: value.enabled,
    };
    if (value.clearBindPassword) patch.bindPwEncrypted = null;
    else if (value.bindPassword !== undefined) patch.bindPwEncrypted = secretBox.encrypt(value.bindPassword);

    const saved = await ldapConfigRepo.upsert(patch);
    res.json({ authEnabledFlag: Boolean(authEnabledFlag), config: saved });
  }));

  // GET /api/ldap/role-map — the group -> role table.
  router.get('/role-map', asyncHandler(async (req, res) => {
    res.json(await ldapRoleMapRepo.findAll());
  }));

  // POST /api/ldap/role-map { groupDn, role } — 409 on a duplicate group.
  router.post('/role-map', asyncHandler(async (req, res) => {
    const { value, errors } = validateRoleMap(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    if (await ldapRoleMapRepo.findByGroup(value.groupDn)) {
      return res.status(409).json({ error: 'Group already mapped' });
    }
    const created = await ldapRoleMapRepo.create(value);
    res.status(201).json(created);
  }));

  // PUT /api/ldap/role-map/:id.
  router.put('/role-map/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const { value, errors } = validateRoleMap(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const existing = await ldapRoleMapRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Role mapping not found' });
    const dup = await ldapRoleMapRepo.findByGroup(value.groupDn);
    if (dup && dup.id !== id) return res.status(409).json({ error: 'Group already mapped' });
    res.json(await ldapRoleMapRepo.update(id, value));
  }));

  // DELETE /api/ldap/role-map/:id.
  router.delete('/role-map/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const removed = await ldapRoleMapRepo.remove(id);
    if (!removed) return res.status(404).json({ error: 'Role mapping not found' });
    res.status(204).end();
  }));

  // POST /api/ldap/test — bind with the service account to verify connectivity.
  router.post('/test', asyncHandler(async (req, res) => {
    if (!ldapAuth || typeof ldapAuth.testConnection !== 'function') {
      return res.status(503).json({ error: 'LDAP auth not available' });
    }
    res.json(await ldapAuth.testConnection());
  }));

  return router;
}

module.exports = { createLdapRouter };
