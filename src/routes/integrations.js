'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateIntegrationCreate, validateIntegrationUpdate } = require('../validation/integrationValidation');
const { ITSM_PRESETS } = require('../integrations/presets');

const KNOWN_EVENTS = ['incident', 'anomaly', 'agent.enroll', 'agent.delete'];

// Validates the generic config.events override (which events this integration
// reacts to). Returns { events } or { error } (a message).
function validateEvents(events) {
  if (events === undefined) return { events: undefined };
  if (!Array.isArray(events)) return { error: 'config.events must be an array' };
  for (const e of events) {
    if (!KNOWN_EVENTS.includes(e)) return { error: `config.events must be a subset of: ${KNOWN_EVENTS.join(', ')}` };
  }
  return { events: [...new Set(events)] };
}

// Outbound API integrations (ITSM/IPAM connectors). Admin-only CRUD + manual
// test-fire. Mounted at /api/integrations behind the user JWT. Credentials are
// encrypted (secret box) before they ever touch the DB and are NEVER returned.
function createIntegrationsRouter({ integrationsRepo, integrationAuditRepo = null, dispatcher = null, registry, secretBox }) {
  const router = express.Router();

  // Every endpoint is admin-only — enforced once at the router level.
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  const clampLimit = (v) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n <= 0) return 100;
    return Math.min(n, 500);
  };

  // Runs the connector-specific checks (known type, supported auth, valid config)
  // shared by create + update. Returns { config } on success or { status, body }
  // describing the error response.
  function checkConnector(type, authType, config) {
    const connector = registry.get(type);
    if (!connector) {
      return { status: 400, body: { error: 'Validation failed', details: { type: `unknown integration type "${type}"` } } };
    }
    if (authType !== undefined && Array.isArray(connector.authTypes) && !connector.authTypes.includes(authType)) {
      return { status: 400, body: { error: 'Validation failed', details: { authType: `authType must be one of: ${connector.authTypes.join(', ')} for ${type}` } } };
    }
    const cfg = config && typeof config === 'object' ? config : {};
    const ev = validateEvents(cfg.events);
    if (ev.error) return { status: 400, body: { error: 'Validation failed', details: { config: ev.error } } };
    const cc = connector.validateConfig(cfg);
    if (cc.errors) return { status: 400, body: { error: 'Validation failed', details: cc.errors } };
    // Merge: keep generic keys (events), overlay the connector's normalised keys.
    const merged = { ...cfg, ...cc.value };
    if (ev.events !== undefined) merged.events = ev.events;
    return { config: merged };
  }

  // GET /api/integrations/meta — connector catalogue (types + supported auth +
  // default events). Declared before /:id so "meta" isn't parsed as an id.
  router.get('/meta', (req, res) => {
    const catOf = typeof registry.categoryOf === 'function' ? registry.categoryOf : () => 'any';
    const types = registry.types().map((type) => {
      const c = registry.get(type);
      // custom = the config-driven "bring your own" connector; category tags each
      // type as ITSM ticketing vs CMDB/IPAM inventory (Nautobot) vs generic.
      return { type, authTypes: c.authTypes || [], defaultEvents: c.defaultEvents || [], category: catOf(type), custom: type === 'custom' };
    });
    // Named templates for the dropdown (built-ins + Jira / TOPdesk / GLPI custom
    // presets). Filtered to types the registry actually has.
    const presets = ITSM_PRESETS.filter((p) => registry.has(p.type));
    res.json({ types, events: KNOWN_EVENTS, presets });
  });

  // GET /api/integrations — list (safe; no credentials).
  router.get('/', asyncHandler(async (req, res) => {
    res.json(await integrationsRepo.findAll());
  }));

  // GET /api/integrations/:id — one (safe).
  router.get('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const row = await integrationsRepo.findById(id);
    if (!row) return res.status(404).json({ error: 'Integration not found' });
    res.json(row);
  }));

  // GET /api/integrations/:id/audit — recent fire history for one integration.
  router.get('/:id/audit', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    if (!integrationAuditRepo) return res.status(503).json({ error: 'Audit log not available' });
    const existing = await integrationsRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Integration not found' });
    res.json(await integrationAuditRepo.findByIntegration(id, { limit: clampLimit(req.query.limit) }));
  }));

  // POST /api/integrations — create.
  router.post('/', asyncHandler(async (req, res) => {
    const { value, errors } = validateIntegrationCreate(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const check = checkConnector(value.type, value.authType, value.config);
    if (check.status) return res.status(check.status).json(check.body);

    if (await integrationsRepo.findByName(value.name)) {
      return res.status(409).json({ error: 'Integration name already in use' });
    }

    const creds = value.credentials || {};
    const credentialsEncrypted = Object.keys(creds).length ? secretBox.encryptJson(creds) : null;
    const created = await integrationsRepo.create({
      type: value.type, name: value.name, baseUrl: value.baseUrl, authType: value.authType,
      credentialsEncrypted, enabled: value.enabled, config: check.config,
    });
    res.status(201).json(created);
  }));

  // PUT /api/integrations/:id — update (type is immutable).
  router.put('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const { value, errors } = validateIntegrationUpdate(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const existing = await integrationsRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Integration not found' });

    const patch = {};
    if (value.name !== undefined) patch.name = value.name;
    if (value.baseUrl !== undefined) patch.baseUrl = value.baseUrl;
    if (value.enabled !== undefined) patch.enabled = value.enabled;

    // Re-validate config/auth against the (immutable) connector type when either
    // changes, so an edit can't leave an unsupported authType or invalid config.
    if (value.authType !== undefined || value.config !== undefined) {
      const authType = value.authType !== undefined ? value.authType : existing.auth_type;
      const config = value.config !== undefined ? value.config : existing.config_json;
      const check = checkConnector(existing.type, authType, config);
      if (check.status) return res.status(check.status).json(check.body);
      if (value.authType !== undefined) patch.authType = value.authType;
      if (value.config !== undefined) patch.config = check.config;
    }

    if (patch.name && patch.name !== existing.name) {
      const dup = await integrationsRepo.findByName(patch.name);
      if (dup && dup.id !== id) return res.status(409).json({ error: 'Integration name already in use' });
    }

    if (value.clearCredentials) {
      patch.credentialsEncrypted = null;
    } else if (value.credentials && Object.keys(value.credentials).length) {
      patch.credentialsEncrypted = secretBox.encryptJson(value.credentials);
    }

    const updated = await integrationsRepo.update(id, patch);
    res.json(updated);
  }));

  // DELETE /api/integrations/:id.
  router.delete('/:id', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const removed = await integrationsRepo.remove(id);
    if (!removed) return res.status(404).json({ error: 'Integration not found' });
    res.status(204).end();
  }));

  // POST /api/integrations/:id/test — manual test-fire. Returns the ACTUAL HTTP
  // status from the target. 404 for an unknown integration.
  router.post('/:id/test', asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    if (!dispatcher || typeof dispatcher.testFire !== 'function') {
      return res.status(503).json({ error: 'Integration dispatcher not available' });
    }
    const result = await dispatcher.testFire(id, req.user);
    if (result === null) return res.status(404).json({ error: 'Integration not found' });
    res.json({ id, result });
  }));

  return router;
}

module.exports = { createIntegrationsRouter };
