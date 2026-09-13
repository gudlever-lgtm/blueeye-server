'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth } = require('../auth/middleware');
const { validatePreferences } = require('../validation/preferencesValidation');

// Current-user profile + personal UI preferences. Every authenticated user (any
// role) may read and update their own preferences — these are personal settings
// (e.g. the dashboard colour theme), not admin configuration, so no requireRole.
function createMeRouter({ usersRepo }) {
  const router = express.Router();

  router.use(requireAuth);

  // GET /me — the signed-in user's identity plus saved UI preferences.
  // `name` (migration 093) is display text and lives in the row, not the JWT —
  // an admin renaming someone must not require them to sign in again — so it is
  // read alongside the preferences. Null when the account has no name set.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const preferences = await usersRepo.getPreferences(req.user.id);
      let name = null;
      try {
        const row = await usersRepo.findById(req.user.id);
        name = (row && row.name) || null;
      } catch { /* identity must survive a name lookup that fails */ }
      res.json({
        id: req.user.id,
        email: req.user.email,
        name,
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

  return router;
}

module.exports = { createMeRouter };
