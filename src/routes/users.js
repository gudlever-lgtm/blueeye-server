'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { hashPassword } = require('../auth/password');
const { validateUserCreate, validateUserUpdate } = require('../validation/userValidation');
const { parseId } = require('../validation/locationValidation');

// User administration. Every endpoint is admin-only — enforced once at the
// router level.
function createUsersRouter({ usersRepo }) {
  const router = express.Router();

  router.use(requireAuth, requireRole(ROLES.ADMIN));

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
    asyncHandler(async (req, res) => {
      const { value, errors } = validateUserCreate(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
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
      res.status(201).json(created);
    })
  );

  // PUT /users/:id — updates the role and, optionally, resets the password.
  router.put(
    '/:id',
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

      const patch = { role: existing.protected ? ROLES.ADMIN : value.role };
      if (value.password !== undefined) {
        patch.passwordHash = await hashPassword(value.password);
      }
      const updated = await usersRepo.update(id, patch);
      res.json(updated);
    })
  );

  // DELETE /users/:id — refuses to delete the last remaining admin.
  router.delete(
    '/:id',
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
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createUsersRouter };
