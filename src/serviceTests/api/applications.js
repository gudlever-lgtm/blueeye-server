'use strict';

const express = require('express');
const { asyncHandler, invalid, notFound, invalidId, makeLoader, auditor, userId, parseId } = require('./helpers');
const {
  validateApplication, validateEnvironment, validateCredential,
  validateAllowedHost, validateAllowlistImport,
} = require('../validation');
const { validateEntry } = require('../security/hostPolicy');
const { validateImport, toCsvExport } = require('../security/allowlistIo');

// Applications, their environments, their credentials, and the host allowlist.
//
// RBAC: everyone with an account reads; ADMIN owns everything here. An
// application's base URL and its allowlist together decide what the browser may
// reach, and its credentials are what it authenticates with — none of that is an
// operator-level change.

function createApplicationsRouter({ repositories, settings, audit, requireRole, roles }) {
  const router = express.Router();
  const { applications, environments, credentials, allowedHosts, tests, discovery } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const admin = requireRole(roles.ADMIN);
  const loadApp = makeLoader(applications, 'Application');
  const record = auditor(audit);

  // ---------------------------------------------------------------- CRUD
  router.get('/', read, asyncHandler(async (req, res) => {
    const list = await applications.list();
    // Each row carries the counts the list screen shows, so the UI needs one call.
    const enriched = await Promise.all(list.map(async (app) => ({
      ...app,
      environment_count: (await environments.list({ applicationId: app.id })).length,
      test_count: (await tests.list({ applicationId: app.id })).length,
      last_discovery: await discovery.latestForApplication(app.id),
    })));
    res.json(enriched);
  }));

  router.post('/', admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateApplication(req.body);
    if (errors) return invalid(res, errors);
    const created = await applications.create({ ...value, created_by: userId(req) });
    record(req, 'application_create', created.id, `name=${created.name} base_url=${created.base_url}`);
    return res.status(201).json(created);
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    return res.json({
      ...app,
      environments: await environments.list({ applicationId: app.id }),
      credentials: await credentials.list({ applicationId: app.id }),
      allowed_hosts: await allowedHosts.listForApplication(app.id),
      last_discovery: await discovery.latestForApplication(app.id),
    });
  }));

  router.put('/:id', admin, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    const { value, errors } = validateApplication(req.body, { partial: true });
    if (errors) return invalid(res, errors);
    const updated = await applications.update(app.id, value);
    record(req, 'application_update', app.id, Object.keys(value).join(','));
    return res.json(updated);
  }));

  router.delete('/:id', admin, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    await applications.remove(app.id);
    record(req, 'application_delete', app.id, `name=${app.name}`);
    return res.status(204).end();
  }));

  // ------------------------------------------------------- allowed hosts
  // The SSRF escape hatch. Admin-only, audited per entry, and every write goes
  // through hostPolicy.validateEntry — the deny-list and the DB-backed caps are
  // enforced here, not in the repository.
  router.get('/:id/allowed-hosts', read, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    return res.json(await allowedHosts.listForApplication(app.id));
  }));

  router.post('/:id/allowed-hosts', admin, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    const { value, errors } = validateAllowedHost(req.body);
    if (errors) return invalid(res, errors);

    const allowlistSettings = await settings.get('allowlist');
    const existing = await allowedHosts.listForApplication(app.id);
    const verdict = validateEntry(value.value, value.entry_type, { settings: allowlistSettings, existing });
    if (verdict.errors) return invalid(res, verdict.errors);

    const entry = await allowedHosts.add({
      application_id: app.id, ...verdict.value, note: value.note ?? null, created_by: userId(req),
    });
    record(req, 'allowlist_add', app.id, `${entry.entry_type}=${entry.value}`);
    return res.status(201).json(entry);
  }));

  router.delete('/:id/allowed-hosts/:entryId', admin, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    const entryId = parseId(req.params.entryId);
    if (entryId === null) return invalidId(res);
    const entry = await allowedHosts.findById(entryId);
    if (!entry || entry.application_id !== app.id) return notFound(res, 'Allowed host not found');
    await allowedHosts.remove(entryId);
    record(req, 'allowlist_remove', app.id, `${entry.entry_type}=${entry.value}`);
    return res.status(204).end();
  }));

  // Bulk import. Every row is validated before anything is written: a
  // half-applied allowlist is a security control in an unknown state.
  // ?dry_run=1 reports what would change without writing.
  router.post('/:id/allowed-hosts/import', admin, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    const { value, errors } = validateAllowlistImport(req.body);
    if (errors) return invalid(res, errors);

    const allowlistSettings = await settings.get('allowlist');
    const existing = value.replace ? [] : await allowedHosts.listForApplication(app.id);
    const parsed = validateImport(value.text, { settings: allowlistSettings, existing });
    if (parsed.errors) return invalid(res, parsed.errors);

    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    if (dryRun) return res.json({ dry_run: true, ...parsed.value });

    if (value.replace) await allowedHosts.removeAllForApplication(app.id);
    const written = await allowedHosts.addMany(app.id, parsed.value.entries, userId(req));
    record(req, 'allowlist_import', app.id, `entries=${written.length} replace=${!!value.replace}`);
    return res.json({ dry_run: false, ...parsed.value, entries: written });
  }));

  router.get('/:id/allowed-hosts/export.csv', admin, asyncHandler(async (req, res) => {
    const app = await loadApp(req, res);
    if (!app) return undefined;
    const entries = await allowedHosts.listForApplication(app.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="allowed-hosts-${app.id}.csv"`);
    return res.send(toCsvExport(entries));
  }));

  return router;
}

// ------------------------------------------------------------- environments
createApplicationsRouter.environments = function createEnvironmentsRouter({ repositories, audit, requireRole, roles }) {
  const router = express.Router();
  const { environments, applications } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const admin = requireRole(roles.ADMIN);
  const load = makeLoader(environments, 'Environment');
  const record = auditor(audit);

  router.get('/', read, asyncHandler(async (req, res) => {
    const applicationId = req.query.application_id !== undefined ? parseId(req.query.application_id) : null;
    if (req.query.application_id !== undefined && applicationId === null) {
      return res.status(400).json({ error: 'Invalid application_id' });
    }
    return res.json(await environments.list({ applicationId }));
  }));

  router.post('/', admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateEnvironment(req.body);
    if (errors) return invalid(res, errors);
    if (!(await applications.findById(value.application_id))) {
      return invalid(res, { application_id: 'that application does not exist' });
    }
    const created = await environments.create(value);
    record(req, 'environment_create', created.id, `app=${value.application_id} name=${created.name}`);
    return res.status(201).json(created);
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const env = await load(req, res);
    return env ? res.json(env) : undefined;
  }));

  router.put('/:id', admin, asyncHandler(async (req, res) => {
    const env = await load(req, res);
    if (!env) return undefined;
    const { value, errors } = validateEnvironment(req.body, { partial: true });
    if (errors) return invalid(res, errors);
    const updated = await environments.update(env.id, value);
    record(req, 'environment_update', env.id, Object.keys(value).join(','));
    return res.json(updated);
  }));

  router.delete('/:id', admin, asyncHandler(async (req, res) => {
    const env = await load(req, res);
    if (!env) return undefined;
    await environments.remove(env.id);
    record(req, 'environment_delete', env.id, `name=${env.name}`);
    return res.status(204).end();
  }));

  return router;
};

// -------------------------------------------------------------- credentials
// Admin only, including READS: the list reveals which systems have stored logins
// and under which usernames. The secret itself never appears in any response —
// the repository has no read path that returns it.
createApplicationsRouter.credentials = function createCredentialsRouter({ repositories, audit, requireRole, roles }) {
  const router = express.Router();
  const { credentials, applications } = repositories;
  const admin = requireRole(roles.ADMIN);
  const load = makeLoader(credentials, 'Credential');
  const record = auditor(audit);

  router.get('/', admin, asyncHandler(async (req, res) => {
    const applicationId = req.query.application_id !== undefined ? parseId(req.query.application_id) : null;
    if (req.query.application_id !== undefined && applicationId === null) {
      return res.status(400).json({ error: 'Invalid application_id' });
    }
    return res.json(await credentials.list({ applicationId }));
  }));

  router.post('/', admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateCredential(req.body);
    if (errors) return invalid(res, errors);
    if (!(await applications.findById(value.application_id))) {
      return invalid(res, { application_id: 'that application does not exist' });
    }
    const created = await credentials.create({ ...value, created_by: userId(req) });
    // The detail names the label, never the username's password or the secret.
    record(req, 'credential_create', created.id, `app=${value.application_id} label=${created.label}`);
    return res.status(201).json(created);
  }));

  router.get('/:id', admin, asyncHandler(async (req, res) => {
    const cred = await load(req, res);
    return cred ? res.json(cred) : undefined;
  }));

  router.put('/:id', admin, asyncHandler(async (req, res) => {
    const cred = await load(req, res);
    if (!cred) return undefined;
    const { value, errors } = validateCredential(req.body, { partial: true });
    if (errors) return invalid(res, errors);
    const updated = await credentials.update(cred.id, value);
    record(req, 'credential_update', cred.id, `fields=${Object.keys(value).filter((k) => k !== 'secret').join(',')}${value.secret !== undefined ? ' secret=changed' : ''}`);
    return res.json(updated);
  }));

  router.delete('/:id', admin, asyncHandler(async (req, res) => {
    const cred = await load(req, res);
    if (!cred) return undefined;
    await credentials.remove(cred.id);
    record(req, 'credential_delete', cred.id, `label=${cred.label}`);
    return res.status(204).end();
  }));

  return router;
};

module.exports = { createApplicationsRouter };
