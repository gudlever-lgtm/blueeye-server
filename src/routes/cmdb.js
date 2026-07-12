'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateCmdbConfig, validateAssetSearch, validateAgentLink } = require('../validation/cmdbValidation');

// CMDB integration (single source of truth). Three routers:
//   - createCmdbSettingsRouter  → /api/settings/cmdb  (admin: configure + test)
//   - createCmdbAssetsRouter     → /api/cmdb/assets    (operator+: asset search)
//   - createAgentCmdbLinkRouter  → /api/agents/:id/cmdb-link (get/set/remove a link)
//
// Credentials are encrypted at rest via the shared secretBox (same helper the
// integrations + LDAP configs use) and are NEVER returned by the API. The
// ServiceNow/Nautobot connectors are reused from the integrations registry —
// their testConnection()/search() are called with a decrypted, integration-shaped
// object built from the stored config.

// Builds the { baseUrl, authType, credentials, config } shape the connectors
// expect from the stored (safe) config row + freshly-decrypted credentials.
function toIntegration(cfg, credentials) {
  return { baseUrl: cfg.base_url, authType: cfg.auth_type, credentials, config: {} };
}

// Strips the encrypted blob and exposes a boolean so the UI can render a
// write-only credentials field without ever seeing the secret.
function safeConfig(fullRow) {
  if (!fullRow) return null;
  const { credentials_encrypted, ...rest } = fullRow;
  return { ...rest, credentialsSet: Boolean(credentials_encrypted) };
}

// --- Settings (admin) ---------------------------------------------------------
// GET returns the config WITHOUT credentials; when nothing is configured yet it
// returns an empty object {} with 200 (documented convention).
function createCmdbSettingsRouter({ cmdbConfigRepo, registry, secretBox }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  router.get('/', asyncHandler(async (req, res) => {
    const full = await cmdbConfigRepo.getWithSecret();
    res.json(full ? safeConfig(full) : {});
  }));

  router.put('/', asyncHandler(async (req, res) => {
    const { value, errors } = validateCmdbConfig(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    // The auth_type must be one the chosen connector actually supports.
    const connector = registry.get(value.type);
    if (!connector) return res.status(400).json({ error: 'Validation failed', details: { type: `unknown CMDB type "${value.type}"` } });
    if (!Array.isArray(connector.authTypes) || !connector.authTypes.includes(value.authType)) {
      return res.status(400).json({ error: 'Validation failed', details: { auth_type: `auth_type must be one of: ${(connector.authTypes || []).join(', ')} for ${value.type}` } });
    }

    const patch = {
      type: value.type, baseUrl: value.baseUrl, authType: value.authType,
      enabled: value.enabled, updatedBy: (req.user && req.user.id) || null,
    };
    if (value.clearCredentials) patch.credentialsEncrypted = null;
    else if (value.credentials !== undefined) patch.credentialsEncrypted = secretBox.encryptJson(value.credentials);

    await cmdbConfigRepo.upsert(patch);
    // Re-read WITH the secret so credentialsSet reflects the stored state (upsert
    // returns the safe view, which omits the encrypted blob).
    const full = await cmdbConfigRepo.getWithSecret();
    res.json(safeConfig(full));
  }));

  // POST /test — decrypt the stored credentials and call the connector's real
  // connection test. 200 (+ stamp verified_at) on success, 401 on auth failure,
  // 500 on any other connector/network error.
  router.post('/test', asyncHandler(async (req, res) => {
    const full = await cmdbConfigRepo.getWithSecret();
    if (!full) return res.status(400).json({ error: 'No CMDB is configured to test' });

    const connector = registry.get(full.type);
    if (!connector || typeof connector.testConnection !== 'function') {
      return res.status(500).json({ error: `CMDB connector "${full.type}" cannot test connections` });
    }
    const credentials = secretBox.decryptJson(full.credentials_encrypted);
    const result = await connector.testConnection(toIntegration(full, credentials));

    if (result.ok) {
      const saved = await cmdbConfigRepo.markVerified();
      return res.json({ ok: true, status: result.status, detail: result.detail, verified_at: saved ? saved.verified_at : null });
    }
    if (result.status === 401) {
      return res.status(401).json({ ok: false, status: 401, error: 'Authentication failed', detail: result.detail });
    }
    return res.status(500).json({ ok: false, status: result.status, error: 'CMDB connection failed', detail: result.detail });
  }));

  return router;
}

// --- Asset search (operator+) -------------------------------------------------
// GET /api/cmdb/assets/search?q= — routes to the active connector's search().
function createCmdbAssetsRouter({ cmdbConfigRepo, registry, secretBox }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN));

  router.get('/search', asyncHandler(async (req, res) => {
    const { q, error } = validateAssetSearch(req.query.q);
    if (error) return res.status(400).json({ error });

    const full = await cmdbConfigRepo.getWithSecret();
    if (!full || !full.enabled) return res.status(404).json({ error: 'No CMDB is configured or enabled' });

    const connector = registry.get(full.type);
    if (!connector || typeof connector.search !== 'function') {
      return res.status(500).json({ error: `CMDB connector "${full.type}" cannot search assets` });
    }
    const credentials = secretBox.decryptJson(full.credentials_encrypted);
    const result = await connector.search(toIntegration(full, credentials), q);
    if (!result.ok) {
      return res.status(500).json({ error: 'CMDB asset search failed', status: result.status, detail: result.detail });
    }
    res.json({ assets: result.assets });
  }));

  return router;
}

// Reconciles the agent's BlueEye site with the linked asset's CMDB location.
// Match is by name so two agents at "Copenhagen DC" converge on ONE location row.
// Returns { synced, suggestion }:
//   - synced { id, name }     — the site was set (or already correct).
//   - suggestion { current, proposed } — the agent ALREADY has a (manual) site
//     that differs, so we do NOT overwrite; the caller surfaces a confirm and
//     re-links with overwrite:true to apply it.
// A site is created (name only, no coordinates) only when we actually apply.
async function reconcileLocation(locationsRepo, agentsRepo, agent, label, { overwrite = false } = {}) {
  if (!locationsRepo || !label) return { synced: null, suggestion: null };
  const current = agent.location_id ? { id: agent.location_id, name: agent.location_name || null } : null;
  let match = await locationsRepo.findByName(label);

  // Already on the right site — nothing to change.
  if (current && match && match.id === current.id) {
    return { synced: { id: current.id, name: match.name }, suggestion: null };
  }
  // A manual/existing site that differs — suggest rather than overwrite.
  if (current && !overwrite) {
    return { synced: null, suggestion: { current, proposed: { id: match ? match.id : null, name: match ? match.name : label } } };
  }
  // No current site, or the overwrite was confirmed — apply (match or create).
  if (!match) match = await locationsRepo.create({ name: label });
  await agentsRepo.setLocation(agent.id, match.id);
  return { synced: { id: match.id, name: match.name }, suggestion: null };
}

// --- Agent link (read viewer+, write operator+) -------------------------------
// Mounted at /api/agents; owns /:id/cmdb-link.
function createAgentCmdbLinkRouter({ agentCmdbLinksRepo, agentsRepo, locationsRepo = null }) {
  const router = express.Router();
  const reader = [requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN)];
  const writer = [requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN)];

  router.get('/:id/cmdb-link', ...reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const link = await agentCmdbLinksRepo.get(id);
    if (!link) return res.status(404).json({ error: 'No CMDB link for this agent' });
    res.json(link);
  }));

  router.put('/:id/cmdb-link', ...writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const { value, errors } = validateAgentLink(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const agent = await agentsRepo.findById(id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const link = await agentCmdbLinksRepo.set(id, {
      cmdbAssetId: value.cmdbAssetId, cmdbAssetName: value.cmdbAssetName,
      cmdbAssetLocation: value.cmdbAssetLocation,
      linkedBy: (req.user && req.user.id) || null,
    });
    // Reconcile the agent's BlueEye site from the asset's CMDB location. Auto-sync
    // when the agent has no site; when it already has a (manual) one that differs,
    // return a suggestion instead of overwriting (the client confirms + re-links
    // with overwrite_location:true). Best-effort: a failure never fails the link.
    let synced = null; let suggestion = null;
    try {
      ({ synced, suggestion } = await reconcileLocation(locationsRepo, agentsRepo, agent, value.cmdbAssetLocation, { overwrite: value.overwriteLocation }));
    } catch (err) {
      req.log.warn(`cmdb-link: location reconcile failed for agent ${id} (${err.message}); link saved without it`);
    }
    res.json({ ...link, synced_location: synced, location_suggestion: suggestion });
  }));

  router.delete('/:id/cmdb-link', ...writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const removed = await agentCmdbLinksRepo.remove(id);
    if (!removed) return res.status(404).json({ error: 'No CMDB link for this agent' });
    res.status(204).end();
  }));

  return router;
}

module.exports = { createCmdbSettingsRouter, createCmdbAssetsRouter, createAgentCmdbLinkRouter };
