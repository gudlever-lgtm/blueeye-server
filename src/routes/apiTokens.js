'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requirePlanFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateApiTokenCreate } = require('../validation/apiTokenValidation');
const { generateApiToken } = require('../lib/apiToken');

// API-token administration (license feature `api_access`, Professional+). admin
// only, gated end-to-end (403 upgrade contract when the plan lacks api_access).
// The plaintext token is returned exactly once, on creation.
function createApiTokensRouter({ apiTokensRepo, featureGate, planService, auditLogger = null }) {
  const router = express.Router();
  const gate = requirePlanFeature({ featureGate, planService }, 'api_access');

  router.use(requireAuth, requireRole(ROLES.ADMIN), gate);

  // GET /api/api-tokens — all tokens (metadata only; never the secret/hash).
  router.get('/', asyncHandler(async (req, res) => {
    if (!apiTokensRepo) return res.status(503).json({ error: 'API tokens not available' });
    res.json(await apiTokensRepo.findAll());
  }));

  // POST /api/api-tokens { name, role?, expiresAt? } — mints a token and returns
  // it ONCE in `token`. After this response the plaintext is unrecoverable.
  router.post('/', asyncHandler(async (req, res) => {
    if (!apiTokensRepo) return res.status(503).json({ error: 'API tokens not available' });
    const { value, errors } = validateApiTokenCreate(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const { token, hash, prefix } = generateApiToken();
    const row = await apiTokensRepo.create({
      name: value.name,
      tokenHash: hash,
      tokenPrefix: prefix,
      role: value.role,
      createdByUserId: req.user && req.user.id,
      expiresAt: value.expiresAt,
    });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'api_token', action: 'api_token_create', target: value.name,
        detail: `role=${value.role}${value.expiresAt ? `, expires ${value.expiresAt.toISOString()}` : ''}`,
      });
    }
    // `token` is included only on this create response.
    res.status(201).json({ ...row, token });
  }));

  // DELETE /api/api-tokens/:id — revoke (soft). 404 if unknown.
  router.delete('/:id', asyncHandler(async (req, res) => {
    if (!apiTokensRepo) return res.status(503).json({ error: 'API tokens not available' });
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const existing = await apiTokensRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'API token not found' });
    const ok = await apiTokensRepo.revoke(id);
    if (auditLogger && ok) {
      await auditLogger.record(req, { category: 'api_token', action: 'api_token_revoke', target: existing.name });
    }
    res.status(204).end();
  }));

  return router;
}

module.exports = { createApiTokensRouter };
