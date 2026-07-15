'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { hashPassword, checkPasswordPolicy } = require('../auth/password');
const { generateTempPassword } = require('../auth/tempPassword');
const {
  validateUserCreate,
  validateUserUpdate,
  validateLocalUserCreate,
} = require('../validation/userValidation');
const { parseId } = require('../validation/locationValidation');
const { config } = require('../config');

// User administration. Every endpoint is admin-only; the *mutations* (creating,
// editing roles, deleting users) are additionally licence-gated behind `rbac`
// (Role-based access control, Professional+) — managing multiple users/roles is
// the sellable RBAC capability. Reading the list stays open (admin) so a lower
// plan still sees its accounts and an honest upgrade prompt instead of an error.
// The seeded super-admin always exists, so a server without `rbac` can still log
// in. featureGate/planService are optional (a server without the plan layer
// keeps user management open).
function createUsersRouter({
  usersRepo,
  featureGate = null,
  planService = null,
  auditLogger = null,
  // One-time-password local user creation. `userMailer` sends the password by
  // email; the three auth services let us detect whether SSO/LDAP is active (in
  // which case local creation is refused). `publicUrl` seeds the login link.
  userMailer = null,
  ldapAuth = null,
  oidcAuth = null,
  samlAuth = null,
  publicUrl = '',
}) {
  const router = express.Router();

  router.use(requireAuth, requireRole(ROLES.ADMIN));
  const rbacGate = requirePlanFeature({ featureGate, planService }, 'rbac');

  // True when any federated sign-in method (LDAP/AD, OIDC or SAML) is live for
  // this install. Local user creation is only offered when NONE is — customers
  // on SSO manage their users in the directory, so a local account with a
  // password would be a bypass. Each check is defensive (never throws).
  async function ssoOrLdapActive() {
    try { if (ldapAuth && typeof ldapAuth.isEnabled === 'function' && (await ldapAuth.isEnabled())) return true; } catch { /* ignore */ }
    try { if (oidcAuth && typeof oidcAuth.isEnabled === 'function' && oidcAuth.isEnabled()) return true; } catch { /* ignore */ }
    try { if (samlAuth && typeof samlAuth.isEnabled === 'function' && samlAuth.isEnabled()) return true; } catch { /* ignore */ }
    return false;
  }

  function loginUrlFor(req) {
    if (publicUrl) return publicUrl;
    const host = req.get('host');
    return host ? `${req.protocol}://${host}` : '';
  }

  function tempExpiryFromNow() {
    const hours = (config.auth && config.auth.tempPasswordTtlHours) || 48;
    return new Date(Date.now() + hours * 60 * 60 * 1000);
  }

  // GET /users
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await usersRepo.findAll());
    })
  );

  // POST /users — creates a user, hashing the supplied password.
  router.post(
    '/',
    rbacGate,
    asyncHandler(async (req, res) => {
      const { value, errors } = validateUserCreate(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      // Baseline password policy (always enforced) → 422, distinct from the 400
      // type/shape error above.
      const policy = checkPasswordPolicy(value.password);
      if (!policy.ok) {
        return res.status(422).json({ error: 'Password policy not met', details: policy.errors });
      }
      if (await usersRepo.findByEmail(value.email)) {
        return res.status(409).json({ error: 'Email already in use' });
      }
      const passwordHash = await hashPassword(value.password);
      const created = await usersRepo.create({
        email: value.email,
        passwordHash,
        role: value.role,
      });
      if (auditLogger) await auditLogger.record(req, { category: 'user', action: 'user_create', target: value.email, detail: `role=${value.role}` });
      res.status(201).json(created);
    })
  );

  // GET /users/local-availability — tells the admin UI whether local user
  // creation is offered (i.e. no SSO/LDAP is active). Single source of truth for
  // the same guard the mutating endpoints enforce, so the button can be hidden.
  router.get(
    '/local-availability',
    asyncHandler(async (req, res) => {
      const ssoActive = await ssoOrLdapActive();
      const mailerReady = Boolean(userMailer && typeof userMailer.sendTempPassword === 'function');
      res.json({ available: !ssoActive && mailerReady, ssoActive, mailerReady });
    })
  );

  // POST /users/local — create a local user who receives a cryptographically
  // random one-time password by email and must change it on first login. This is
  // the flow for customers WITHOUT SSO/LDAP. Refused (403) while any federated
  // sign-in method is active, both here and hidden in the UI. If the email cannot
  // be sent the just-created user is rolled back so nobody is left half-created.
  router.post(
    '/local',
    rbacGate,
    asyncHandler(async (req, res) => {
      if (await ssoOrLdapActive()) {
        if (auditLogger) await auditLogger.record(req, { category: 'user', action: 'user_create_local', outcome: 'denied', detail: 'SSO/LDAP active' });
        return res.status(403).json({ error: 'Local user creation is disabled while SSO/LDAP is active' });
      }
      if (!userMailer || typeof userMailer.sendTempPassword !== 'function') {
        return res.status(503).json({ error: 'Email is not configured; cannot send the one-time password' });
      }

      const { value, errors } = validateLocalUserCreate(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      if (await usersRepo.findByEmail(value.email)) {
        return res.status(409).json({ error: 'Email already in use' });
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      const expiresAt = tempExpiryFromNow();

      const created = await usersRepo.create({
        email: value.email,
        passwordHash,
        role: value.role,
        mustChangePassword: true,
        tempPasswordExpiresAt: expiresAt,
        tempPasswordCreatedBy: req.user.id,
      });

      // Send the password. On ANY failure, roll the user back and return 500 so
      // the plaintext password never lingers for an account nobody can reach.
      try {
        await userMailer.sendTempPassword({
          to: value.email,
          name: value.name,
          tempPassword,
          loginUrl: loginUrlFor(req),
          expiresAt,
        });
      } catch (err) {
        try { await usersRepo.remove(created.id); } catch { /* best-effort rollback */ }
        return res.status(500).json({ error: 'Failed to send the one-time password email; user was not created' });
      }

      if (auditLogger) await auditLogger.record(req, { category: 'user', action: 'user_create_local', target: value.email, detail: `role=${value.role}, temp-password issued` });
      // Never echo the password back in the API response — it lives only in the email.
      return res.status(201).json(created);
    })
  );

  // POST /users/:id/resend-temp-password — regenerate + re-send a one-time
  // password (e.g. the previous one expired unused). Same SSO/LDAP guard as
  // creation. The new password revokes any outstanding session for the user.
  router.post(
    '/:id/resend-temp-password',
    rbacGate,
    asyncHandler(async (req, res) => {
      if (await ssoOrLdapActive()) {
        return res.status(403).json({ error: 'Local user creation is disabled while SSO/LDAP is active' });
      }
      if (!userMailer || typeof userMailer.sendTempPassword !== 'function') {
        return res.status(503).json({ error: 'Email is not configured; cannot send the one-time password' });
      }
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const existing = await usersRepo.findById(id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      const expiresAt = tempExpiryFromNow();
      await usersRepo.setTempPassword(id, { passwordHash, expiresAt, createdBy: req.user.id });

      try {
        await userMailer.sendTempPassword({
          to: existing.email,
          tempPassword,
          loginUrl: loginUrlFor(req),
          expiresAt,
        });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to send the one-time password email; please retry' });
      }

      if (auditLogger) await auditLogger.record(req, { category: 'user', action: 'user_temp_password_resend', target: existing.email, detail: 'temp-password re-issued' });
      return res.json({ id, email: existing.email, temp_password_expires_at: expiresAt.toISOString() });
    })
  );

  // PUT /users/:id — updates the role and, optionally, the email and password.
  router.put(
    '/:id',
    rbacGate,
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const { value, errors } = validateUserUpdate(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      // Enforce the baseline password policy on any password change → 422.
      if (value.password !== undefined) {
        const policy = checkPasswordPolicy(value.password);
        if (!policy.ok) {
          return res.status(422).json({ error: 'Password policy not met', details: policy.errors });
        }
      }
      const existing = await usersRepo.findById(id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      // A protected (super-admin) user cannot be demoted — only a password
      // reset is allowed. It stays admin regardless of the requested role.
      if (existing.protected && value.role !== ROLES.ADMIN) {
        return res.status(409).json({ error: 'Cannot change the role of a protected super-admin' });
      }

      // Don't let the last admin be demoted out of the admin role.
      if (existing.role === ROLES.ADMIN && value.role !== ROLES.ADMIN) {
        const admins = await usersRepo.countByRole(ROLES.ADMIN);
        if (admins <= 1) {
          return res.status(409).json({ error: 'Cannot demote the last admin user' });
        }
      }

      const patch = { role: existing.protected ? ROLES.ADMIN : value.role };

      // Optional email change — must remain unique across users. Skipped when
      // unchanged so a no-op resubmit never trips the uniqueness check.
      if (value.email !== undefined && value.email !== existing.email) {
        const owner = await usersRepo.findByEmail(value.email);
        if (owner && owner.id !== id) {
          return res.status(409).json({ error: 'Email already in use' });
        }
        patch.email = value.email;
      }

      if (value.password !== undefined) {
        patch.passwordHash = await hashPassword(value.password);
      }
      const updated = await usersRepo.update(id, patch);
      if (auditLogger) await auditLogger.record(req, { category: 'user', action: 'user_update', target: existing.email, detail: `role=${patch.role}${patch.email ? `, email=${patch.email}` : ''}${patch.passwordHash ? ', password reset' : ''}` });
      res.json(updated);
    })
  );

  // DELETE /users/:id — refuses to delete the last remaining admin.
  router.delete(
    '/:id',
    rbacGate,
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const existing = await usersRepo.findById(id);
      if (!existing) {
        return res.status(404).json({ error: 'User not found' });
      }

      // A protected (super-admin) user can never be deleted.
      if (existing.protected) {
        return res.status(409).json({ error: 'Cannot delete a protected super-admin' });
      }

      if (existing.role === ROLES.ADMIN) {
        const admins = await usersRepo.countByRole(ROLES.ADMIN);
        if (admins <= 1) {
          return res.status(409).json({ error: 'Cannot delete the last admin user' });
        }
      }

      await usersRepo.remove(id);
      if (auditLogger) await auditLogger.record(req, { category: 'user', action: 'user_delete', target: existing.email });
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createUsersRouter };
