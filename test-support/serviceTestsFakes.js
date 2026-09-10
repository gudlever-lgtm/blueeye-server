'use strict';

// In-memory Service Tests module for the API specs.
//
// This builds the REAL router, validators, host policy and settings service over
// in-memory repositories. So a route spec exercises the whole request path —
// licence gate, RBAC, validation, the SSRF allowlist rules — and only the SQL is
// substituted. The SQL itself is covered separately by the storage specs.
//
//   const app = makeApp({ serviceTests: makeServiceTests() });

const { createServiceTestsApiRouter } = require('../src/serviceTests/api');
const { createServiceTestSettings } = require('../src/serviceTests/settings');
const { createQueue } = require('../src/serviceTests/scheduler/queue');
const { createSecretBox } = require('../src/lib/secretBox');
const { requireAuth, requireRole } = require('../src/auth/middleware');
const { ROLES } = require('../src/auth/roles');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// A tiny table: auto-increment ids, insertion order, shallow filtering.
function makeTable(seed = []) {
  const rows = seed.map((r, i) => ({ id: i + 1, created_at: new Date(), updated_at: new Date(), ...r }));
  let nextId = rows.length + 1;
  return {
    rows,
    insert(row) {
      const created = { id: nextId, created_at: new Date(), updated_at: new Date(), tenant_id: null, ...row };
      nextId += 1;
      rows.push(created);
      return clone(created);
    },
    find(id) { return clone(rows.find((r) => r.id === Number(id))) ?? null; },
    where(pred) { return rows.filter(pred).map(clone); },
    update(id, patch) {
      const row = rows.find((r) => r.id === Number(id));
      if (!row) return null;
      Object.assign(row, patch, { updated_at: new Date() });
      return clone(row);
    },
    remove(id) {
      const i = rows.findIndex((r) => r.id === Number(id));
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  };
}

function makeServiceTests(overrides = {}) {
  const secretBox = createSecretBox({ key: 'service-tests-fake-key' });
  const t = {
    applications: makeTable(overrides.applications || [
      { name: 'Customer Portal', base_url: 'https://customer.example.com', description: null, enabled: 1, created_by: 1 },
    ]),
    environments: makeTable(overrides.environments || [
      { application_id: 1, name: 'Production', base_url: 'https://customer.example.com', type: 'production', enabled: 1 },
    ]),
    credentials: makeTable(overrides.credentials || [
      { application_id: 1, label: 'Test user', username: 'svc-test', secret_encrypted: secretBox.encrypt('hunter2-correct-horse'), created_by: 1 },
    ]),
    allowedHosts: makeTable(overrides.allowedHosts || []),
    tests: makeTable(overrides.tests || [
      {
        application_id: 1,
        name: 'Customer Login',
        description: null,
        definition: { version: 1, name: 'Customer Login', steps: [{ type: 'open', url: '/login' }] },
        version: 1,
        credential_id: null,
        enabled: 1,
        created_by: 1,
      },
    ]),
    runs: makeTable(overrides.runs || []),
    discoveries: makeTable(overrides.discoveries || []),
    pages: makeTable([]),
    elements: makeTable([]),
    suggestions: makeTable(overrides.suggestions || []),
    schedules: makeTable(overrides.schedules || []),
  };

  const bool = (v) => !!v;

  const repositories = {
    applications: {
      async list() { return t.applications.rows.map((r) => ({ ...clone(r), enabled: bool(r.enabled) })); },
      async findById(id) { const r = t.applications.find(id); return r ? { ...r, enabled: bool(r.enabled) } : null; },
      async create(input) { return t.applications.insert({ ...input, enabled: input.enabled === false ? 0 : 1 }); },
      async update(id, patch) {
        const p = { ...patch };
        if (p.enabled !== undefined) p.enabled = p.enabled ? 1 : 0;
        return t.applications.update(id, p);
      },
      async remove(id) { return t.applications.remove(id); },
    },
    environments: {
      async list({ applicationId = null } = {}) {
        return t.environments.where((r) => applicationId === null || r.application_id === applicationId)
          .map((r) => ({ ...r, enabled: bool(r.enabled) }));
      },
      async findById(id) { const r = t.environments.find(id); return r ? { ...r, enabled: bool(r.enabled) } : null; },
      async create(input) { return t.environments.insert({ type: 'custom', ...input, enabled: input.enabled === false ? 0 : 1 }); },
      async update(id, patch) { return t.environments.update(id, patch); },
      async remove(id) { return t.environments.remove(id); },
    },
    credentials: {
      // Mirrors the real repository's asymmetry: no list/read path exposes the secret.
      async list({ applicationId = null } = {}) {
        return t.credentials.where((r) => applicationId === null || r.application_id === applicationId)
          .map(({ secret_encrypted: enc, ...rest }) => ({ ...rest, has_secret: !!enc }));
      },
      async findById(id) {
        const r = t.credentials.find(id);
        if (!r) return null;
        const { secret_encrypted: enc, ...rest } = r;
        return { ...rest, has_secret: !!enc };
      },
      async findByIdWithSecret(id) {
        const r = t.credentials.find(id);
        if (!r) return null;
        const { secret_encrypted: enc, ...rest } = r;
        let secret = null;
        if (enc) { try { secret = secretBox.decrypt(enc); } catch { secret = null; } }
        return { ...rest, has_secret: !!enc, secret };
      },
      async create(input) {
        const { secret, ...rest } = input;
        return repositories.credentials.findById(
          t.credentials.insert({ ...rest, secret_encrypted: secret ? secretBox.encrypt(secret) : null }).id
        );
      },
      async update(id, patch) {
        const p = { ...patch };
        if (p.secret !== undefined) { p.secret_encrypted = p.secret ? secretBox.encrypt(p.secret) : null; delete p.secret; }
        t.credentials.update(id, p);
        return repositories.credentials.findById(id);
      },
      async remove(id) { return t.credentials.remove(id); },
    },
    allowedHosts: {
      async listForApplication(applicationId) { return t.allowedHosts.where((r) => r.application_id === applicationId); },
      async findById(id) { return t.allowedHosts.find(id); },
      async add(input) {
        const existing = t.allowedHosts.rows.find((r) => r.application_id === input.application_id && r.value === input.value);
        if (existing) return t.allowedHosts.update(existing.id, { entry_type: input.entry_type, note: input.note ?? null });
        return t.allowedHosts.insert(input);
      },
      async addMany(applicationId, entries, createdBy = null) {
        const out = [];
        for (const e of entries || []) out.push(await repositories.allowedHosts.add({ ...e, application_id: applicationId, created_by: createdBy }));
        return out;
      },
      async remove(id) { return t.allowedHosts.remove(id); },
      async removeAllForApplication(applicationId) {
        const victims = t.allowedHosts.where((r) => r.application_id === applicationId);
        for (const v of victims) t.allowedHosts.remove(v.id);
        return victims.length;
      },
    },
    tests: {
      async list({ applicationId = null } = {}) {
        return t.tests.where((r) => applicationId === null || r.application_id === applicationId)
          .map((r) => ({ ...r, enabled: bool(r.enabled), steps: [] }));
      },
      async findById(id) {
        const r = t.tests.find(id);
        return r ? { ...r, enabled: bool(r.enabled), steps: (r.definition && r.definition.steps) || [] } : null;
      },
      async create(input) {
        const row = t.tests.insert({ version: 1, ...input, enabled: input.enabled === false ? 0 : 1 });
        return repositories.tests.findById(row.id);
      },
      async save(id, patch) {
        const row = t.tests.find(id);
        if (!row) return null;
        const p = { ...patch, version: row.version + 1 };
        delete p.updated_by;
        if (p.enabled !== undefined) p.enabled = p.enabled ? 1 : 0;
        t.tests.update(id, p);
        return repositories.tests.findById(id);
      },
      async versions(id) { return [{ id: 1, test_id: Number(id), version: 1, definition: (t.tests.find(id) || {}).definition, created_at: new Date() }]; },
      async remove(id) { return t.tests.remove(id); },
    },
    runs: {
      async findById(id) { const r = t.runs.find(id); return r ? { ...r, steps: [] } : null; },
      async list({ testId = null, status = null, limit = 50 } = {}) {
        return t.runs.where((r) => (testId === null || r.test_id === testId) && (status === null || r.status === status)).slice(0, limit);
      },
      async enqueue(input) { return t.runs.insert({ status: 'queued', trigger_source: 'manual', ...input }); },
      async claimNext(workerId) {
        const row = t.runs.rows.find((r) => r.status === 'queued');
        if (!row) return null;
        return t.runs.update(row.id, { status: 'running', claimed_by: workerId, claimed_at: new Date(), started_at: new Date() });
      },
      async complete(id, result) { return t.runs.update(id, { ...result, steps: undefined }); },
      async reapStale() { return 0; },
      async history(testId, limit = 20) {
        const rows = t.runs.where((r) => r.test_id === Number(testId) && !['queued', 'running'].includes(r.status)).slice(0, limit);
        const passed = rows.filter((r) => r.status === 'pass').length;
        const durations = rows.map((r) => r.duration_ms).filter(Number.isFinite);
        return {
          test_id: Number(testId),
          runs: rows,
          total: rows.length,
          success_rate: rows.length ? passed / rows.length : null,
          avg_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
          last_failure: rows.find((r) => r.status === 'fail' || r.status === 'error') || null,
        };
      },
      async screenshotsOlderThan() { return []; },
      async clearScreenshots() { return 0; },
    },
    discovery: {
      async findById(id) { return t.discoveries.find(id); },
      async list({ applicationId = null, limit = 20 } = {}) {
        return t.discoveries.where((r) => applicationId === null || r.application_id === applicationId).slice(0, limit);
      },
      async latestForApplication(applicationId) {
        return t.discoveries.where((r) => r.application_id === applicationId && r.status === 'complete').pop() || null;
      },
      async enqueue(input) { return t.discoveries.insert({ status: 'queued', ...input }); },
      async claimNext(workerId) {
        const row = t.discoveries.rows.find((r) => r.status === 'queued');
        if (!row) return null;
        return t.discoveries.update(row.id, { status: 'running', claimed_by: workerId, claimed_at: new Date() });
      },
      async addPage(discoveryId, page) { return t.pages.insert({ discovery_id: discoveryId, ...page }).id; },
      async addElements(discoveryId, elements) {
        for (const e of elements || []) t.elements.insert({ discovery_id: discoveryId, ...e });
        return (elements || []).length;
      },
      async pages(discoveryId) { return t.pages.where((r) => r.discovery_id === Number(discoveryId)); },
      async elements(discoveryId, { kind = null } = {}) {
        return t.elements.where((r) => r.discovery_id === Number(discoveryId) && (kind === null || r.kind === kind));
      },
      async finish(id, summary) { return t.discoveries.update(id, summary); },
      async reapStale() { return 0; },
    },
    suggestions: {
      async findById(id) { return t.suggestions.find(id); },
      async list(filters = {}) {
        return t.suggestions.where((r) => (filters.discoveryId === undefined || r.discovery_id === filters.discoveryId)
          && (filters.applicationId === undefined || r.application_id === filters.applicationId)
          && (filters.status === undefined || r.status === filters.status));
      },
      async createMany(discoveryId, applicationId, list) {
        return (list || []).map((s) => t.suggestions.insert({
          discovery_id: discoveryId, application_id: applicationId, status: 'proposed', confidence: 'medium', ...s,
        }).id);
      },
      async markAccepted(id, testId) {
        const row = t.suggestions.find(id);
        if (!row || row.status !== 'proposed') return null;
        return t.suggestions.update(id, { status: 'accepted', created_test_id: testId });
      },
      async markDismissed(id) {
        const row = t.suggestions.find(id);
        if (!row || row.status !== 'proposed') return null;
        return t.suggestions.update(id, { status: 'dismissed' });
      },
    },
    schedules: {
      async findById(id) { const r = t.schedules.find(id); return r ? { ...r, enabled: bool(r.enabled) } : null; },
      async list({ testId = null } = {}) {
        return t.schedules.where((r) => testId === null || r.test_id === testId).map((r) => ({ ...r, enabled: bool(r.enabled) }));
      },
      async findDue() { return []; },
      async create(input) { return t.schedules.insert({ timezone: 'UTC', ...input, enabled: input.enabled === false ? 0 : 1 }); },
      async update(id, patch) {
        const p = { ...patch };
        if (p.enabled !== undefined) p.enabled = p.enabled ? 1 : 0;
        return t.schedules.update(id, p);
      },
      async markRun(id, at) { return t.schedules.update(id, { last_run_at: at }); },
      async remove(id) { return t.schedules.remove(id); },
    },
  };

  // The REAL settings service over an in-memory key/value store, so the bounds
  // and the defaults behave exactly as they do in production.
  const store = {};
  const settings = createServiceTestSettings({
    repo: {
      async get(k) { return store[k] ?? null; },
      async getAll() { return { ...store }; },
      async set(k, v) { store[k] = v; return v; },
    },
    ttlMs: 0,
  });

  const queue = createQueue({
    runsRepo: repositories.runs,
    discoveryRepo: repositories.discovery,
    schedulesRepo: repositories.schedules,
    settings,
  });

  const auditEntries = [];
  const audit = { record(req, entry) { auditEntries.push(entry); return Promise.resolve(entry); } };

  const router = createServiceTestsApiRouter({
    repositories,
    settings,
    queue,
    artifacts: overrides.artifacts ?? null,
    audit,
    logger: null,
    requireAuth,
    requireRole,
    requireFeature: overrides.requireFeature ?? null,
    roles: ROLES,
  });

  return { repositories, settings, queue, audit, auditEntries, router, jobs: [], tables: t, secretBox };
}

module.exports = { makeServiceTests, makeTable };
