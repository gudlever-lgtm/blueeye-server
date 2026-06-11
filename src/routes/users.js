'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { hashPassword } = require('../auth/password');
const { validateUserCreate, validateUserUpdate } = require('../validation/userValidation');
const { parseId } = require('../validation/locationValidation');

// User administration. Every endpoint is admin-only; the *mutations* (creating,
// editing roles, deleting users) are additionally licence-gated behind `rbac`
// (Role-based access control, Professional+) — managing multiple users/roles is
// the sellable RBAC capability. Reading the list stays open (admin) so a lower
// plan still sees its accounts and an honest upgrade prompt instead of an error.
// The seeded super-admin always exists, so a server without `rbac` can still log
// in. featureGate/planService are optional (a server without the plan layer
// keeps user management open).
function createUsersRouter({ usersRepo, featureGate = null, planService = null, auditLogger = null, securityService = null }) {
  const router = express.Router();

  router.use(requireAuth, requireRole(ROLES.ADMIN));
  const rbacGate = requirePlanFeature({ featureGate, planService }, 'rbac');

  // Runs the security-pack password policy (complexity + reuse-of-last-N) over a
  // candidate. Writes the 422 response and returns false on violation; returns
  // true (and does nothing) when the policy is disabled/unlicensed. `userId` is
  // null at creation (no history to check yet).
  async function enforcePasswordPolicy(req, res, plain, userId = null) {
    if (!securityService) return true;
    const result = await securityService.evaluateNewPassword({ userId, plain });
    if (!result.ok) {
      res.status(422).json({ error: 'Password does not meet the policy', reason: 'password_policy', violations: result.violations });
      return false;
    }
    return true;
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
      if (await usersRepo.findByEmail(value.email)) {
        return res.status(409).json({ error: 'Email already in use' });
      }
      if (!(await enforcePasswordPolicy(req, res, value.password, null))) return;
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

      // Enforce the password policy before any mutation (422 on violation).
      if (value.password !== undefined && !(await enforcePasswordPolicy(req, res, value.password, id))) return;

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

      let updated = await usersRepo.update(id, patch);
      // Password reset goes through changePassword so the old hash is archived to
      // history (reuse-of-last-N) and password_changed_at is stamped (max-age).
      if (value.password !== undefined) {
        updated = await usersRepo.changePassword(id, await hashPassword(value.password));
      }
      if (auditLogger) await auditLogger.record(req, { category: 'user', action: 'user_update', target: existing.email, detail: `role=${patch.role}${patch.email ? `, email=${patch.email}` : ''}${value.password !== undefined ? ', password reset' : ''}` });
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
