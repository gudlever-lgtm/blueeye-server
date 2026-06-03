'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { generateEnrollmentCode } = require('../auth/tokens');
const { validateCreateCode } = require('../validation/enrollmentValidation');
const { parseId } = require('../validation/locationValidation');
const { config } = require('../config');

// Management of enrollment codes (operator/admin). Creating a code returns its
// plaintext value exactly once; the list never exposes it again.
function createEnrollmentCodesRouter({ enrollmentCodesRepo, locationsRepo }) {
  const router = express.Router();

  // POST /enrollment-codes — operator or admin.
  router.post(
    '/',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const { value, errors } = validateCreateCode(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      if (value.location_id !== null && !(await locationsRepo.findById(value.location_id))) {
        return res.status(400).json({
          error: 'Validation failed',
          details: { location_id: 'location_id does not reference an existing location' },
        });
      }

      const code = generateEnrollmentCode();
      const expiresInMinutes = value.expiresInMinutes ?? config.enrollment.defaultTtlMinutes;
      const created = await enrollmentCodesRepo.create({
        code,
        location_id: value.location_id,
        created_by: req.user.id,
        expiresInMinutes,
        maxUses: value.maxUses,
      });

      // The plaintext code is returned ONCE, here.
      res.status(201).json({
        id: created.id,
        code: created.code,
        location_id: created.location_id,
        expires_at: created.expires_at,
        created_at: created.created_at,
        max_uses: created.max_uses,
        uses_remaining: created.uses_remaining,
      });
    })
  );

  // GET /enrollment-codes — operator or admin. Lists codes with status.
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      res.json(await enrollmentCodesRepo.findAll());
    })
  );

  // DELETE /enrollment-codes/:id — admin only.
  router.delete(
    '/:id',
    requireAuth,
    requireRole(ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const removed = await enrollmentCodesRepo.remove(id);
      if (!removed) {
        return res.status(404).json({ error: 'Enrollment code not found' });
      }
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createEnrollmentCodesRouter };
