'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requireFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateLdapConfig, validateRoleMap } = require('../validation/ldapValidation');

// LDAP/AD configuration API. Admin-only. Mounted at /api/ldap behind the user
// JWT. The bind password is encrypted (secret box) before it touches the DB and
// is NEVER returned. The login flow itself lives in src/routes/auth.js.
//
// Licence-gated: the feature lives in the Enterprise plan (FEATURE key
// `sso_ldap`). Reads stay open (admin can always inspect the current state), but
// every mutation and the connectivity test require the entitlement, mirroring how
// the alerting/assistant config endpoints gate their writes.
function createLdapRouter({ ldapConfigRepo, ldapRoleMapRepo, ldapLoginAuditRepo = null, ldapAuth = null, secretBox, featureGate = null, authEnabledFlag = false }) {
  const router = express.Router();

  router.use(requireAuth, requireRole(ROLES.ADMIN));

  // Whether the licence covers LDAP/AD. No gate injected ⇒ entitled (keeps tests
  // and plan-less installs working).
  const isLicensed = () => !featureGate || featureGate.isFeatureEnabled('sso_ldap') === true;
  // Applied to every mutating route + the test endpoint. requireFeature returns
  // the standard 403 { error, feature, reason:'license' } when not entitled.
  const gate = featureGate ? requireFeature(featureGate, 'sso_ldap') : (req, res, next) => next();

  // GET /api/ldap/config — the stored config (safe; no bind password) plus the
  // hard env gate and licence flag, so the UI can show "enabled in env?" vs
  // "enabled in config?" vs "included in licence?". `bindPasswordSet` lets the UI
  // render a write-only password field without ever exposing the secret.
  router.get('/config', asyncHandler(async (req, res) => {
    const full = await ldapConfigRepo.getWithSecret();
    let config = null;
    let bindPasswordSet = false;
    if (full) {
      const { bind_pw_encrypted: bindPw, ...safe } = full;
      config = safe;
      bindPasswordSet = Boolean(bindPw);
    }
    res.json({ authEnabledFlag: Boolean(authEnabledFlag), licensed: isLicensed(), config, bindPasswordSet });
  }));

  // PUT /api/ldap/config — upsert the single config row.
  router.put('/config', gate, asyncHandler(async (req, res) => {
    const { value, errors } = validateLdapConfig(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const patch = {
      host: value.host, port: value.port, useTls: value.useTls, bindDn: value.bindDn,
      baseDn: value.baseDn, userFilter: value.userFilter, groupFilter: value.groupFilter, enabled: value.enabled,
    };
    if (value.clearBindPassword) patch.bindPwEncrypted = null;
    else if (value.bindPassword !== undefined) patch.bindPwEncrypted = secretBox.encrypt(value.bindPassword);

    const saved = await ldapConfigRepo.upsert(patch);
    res.json({ authEnabledFlag: Boolean(authEnabledFlag), licensed: isLicensed(), config: saved });
  }));

  // GET /api/ldap/role-map — the group -> role table.
  router.get('/role-map', asyncHandler(async (req, res) => {
    res.json(await ldapRoleMapRepo.findAll());
  }));

  // POST /api/ldap/role-map { groupDn, role } — 409 on a duplicate group.
  router.post('/role-map', gate, asyncHandler(async (req, res) => {
    const { value, errors } = validateRoleMap(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    if (await ldapRoleMapRepo.findByGroup(value.groupDn)) {
      return res.status(409).json({ error: 'Group already mapped' });
    }
    const created = await ldapRoleMapRepo.create(value);
    res.status(201).json(created);
  }));

  // PUT /api/ldap/role-map/:id.
  router.put('/role-map/:id', gate, asyncHandler(async (req, res) => {
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
  router.delete('/role-map/:id', gate, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const removed = await ldapRoleMapRepo.remove(id);
    if (!removed) return res.status(404).json({ error: 'Role mapping not found' });
    res.status(204).end();
  }));

  // GET /api/ldap/login-audit — the most recent directory sign-in attempts, so an
  // admin can confirm logins are flowing + see which role each grant resolved to.
  // Read-only and never carries a password. `limit` is clamped to 1..500.
  router.get('/login-audit', asyncHandler(async (req, res) => {
    if (!ldapLoginAuditRepo || typeof ldapLoginAuditRepo.findAll !== 'function') return res.json([]);
    const raw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    res.json(await ldapLoginAuditRepo.findAll({ limit }));
  }));

  // POST /api/ldap/test — bind with the service account to verify connectivity.
  router.post('/test', gate, asyncHandler(async (req, res) => {
    if (!ldapAuth || typeof ldapAuth.testConnection !== 'function') {
      return res.status(503).json({ error: 'LDAP auth not available' });
    }
    res.json(await ldapAuth.testConnection());
  }));

  return router;
}

module.exports = { createLdapRouter };
