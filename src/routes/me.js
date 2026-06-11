'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth } = require('../auth/middleware');
const { validatePreferences } = require('../validation/preferencesValidation');
const { verifyPassword, hashPassword } = require('../auth/password');

// Current-user profile + personal UI preferences. Every authenticated user (any
// role) may read and update their own preferences — these are personal settings
// (e.g. the dashboard colour theme), not admin configuration, so no requireRole.
function createMeRouter({ usersRepo, securityService = null, auditLogger = null }) {
  const router = express.Router();

  router.use(requireAuth);

  // GET /me — the signed-in user's identity plus saved UI preferences.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const preferences = await usersRepo.getPreferences(req.user.id);
      res.json({
        id: req.user.id,
        email: req.user.email,
        role: req.user.role,
        preferences: preferences || {},
      });
    })
  );

  // PUT /me/preferences — merge-update the signed-in user's UI preferences.
  router.put(
    '/preferences',
    asyncHandler(async (req, res) => {
      const { value, errors } = validatePreferences(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const preferences = await usersRepo.updatePreferences(req.user.id, value);
      return res.json({ preferences });
    })
  );

  // PUT /me/password — self-service password change. Requires the current
  // password, then enforces the security-pack policy (complexity + reuse-of-the
  // last-N) and archives history via changePassword. 401 if the current password
  // is wrong; 422 on a policy violation (distinct from 400 for malformed input).
  router.put(
    '/password',
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'currentPassword and newPassword are required' });
      }
      if (!usersRepo.findByIdWithHash || !usersRepo.changePassword) {
        return res.status(503).json({ error: 'Password change is not available' });
      }
      const user = await usersRepo.findByIdWithHash(req.user.id);
      if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
        if (auditLogger) await auditLogger.record(req, { category: 'auth', action: 'password_change', outcome: 'failure', target: req.user.email, detail: 'wrong current password' });
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      if (securityService) {
        const result = await securityService.evaluateNewPassword({ userId: req.user.id, plain: newPassword });
        if (!result.ok) {
          return res.status(422).json({ error: 'Password does not meet the policy', reason: 'password_policy', violations: result.violations });
        }
      }
      await usersRepo.changePassword(req.user.id, await hashPassword(newPassword));
      if (auditLogger) await auditLogger.record(req, { category: 'auth', action: 'password_change', outcome: 'success', target: req.user.email, detail: 'self-service' });
      return res.json({ ok: true });
    })
  );

  return router;
}

module.exports = { createMeRouter };
