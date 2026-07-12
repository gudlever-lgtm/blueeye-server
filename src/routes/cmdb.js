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

// Resolves a CMDB asset location label to a BlueEye location id, creating the
// site (name only, no coordinates) when none matches by name. Returns the linked
// { id, name } or null when there is nothing to sync. Match is by name so two
// agents at "Copenhagen DC" converge on ONE location row.
async function syncLocation(locationsRepo, agentsRepo, agentId, label) {
  if (!locationsRepo || !label) return null;
  let loc = await locationsRepo.findByName(label);
  if (!loc) loc = await locationsRepo.create({ name: label });
  await agentsRepo.setLocation(agentId, loc.id);
  return { id: loc.id, name: loc.name };
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
    // Sync the agent's BlueEye site from the asset's CMDB location (match by name,
    // create if absent). Best-effort: a location failure must not fail the link.
    let syncedLocation = null;
    try {
      syncedLocation = await syncLocation(locationsRepo, agentsRepo, id, value.cmdbAssetLocation);
    } catch (err) {
      req.log.warn(`cmdb-link: location sync failed for agent ${id} (${err.message}); link saved without it`);
    }
    res.json({ ...link, synced_location: syncedLocation });
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
