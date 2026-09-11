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
const { bucketKey, sqlFormat } = require('../src/serviceTests/stats/period');
const { createAssuranceReactor } = require('../src/serviceTests/assurance/reactor');
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

// A TLS inspector that answers from a table instead of a socket: `seen` maps
// `host:port` (or `host`) to the row a real handshake would have produced, and
// anything not listed comes back as a healthy certificate a year out. Every
// spec that touches certificates goes through here, so the suite never opens a
// connection.
function makeCertificateChecker(seen = {}) {
  return {
    async check(target) {
      const key = `${target.host}:${target.port}`;
      const scripted = seen[key] || seen[target.host] || null;
      const at = new Date();
      if (scripted) {
        return {
          host: target.host, port: target.port, url: target.url, checked_at: at,
          subject: null, issuer: null, serial_number: null, fingerprint: null, alt_names: null,
          valid_from: null, valid_to: null, days_remaining: null, error_message: null,
          status: 'ok', ...scripted,
        };
      }
      const validTo = new Date(at.getTime() + 365 * 86400000);
      return {
        host: target.host, port: target.port, url: target.url, checked_at: at,
        subject: `CN=${target.host}`, issuer: 'O=Test CA', serial_number: '01', fingerprint: 'AA:BB',
        alt_names: `DNS:${target.host}`, valid_from: at, valid_to: validTo,
        days_remaining: 365, status: 'ok', error_message: null,
      };
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
    workers: makeTable(overrides.workers || []),
    certificates: makeTable(overrides.certificates || []),
    incidents: makeTable(overrides.incidents || []),
  };

  // The format string the API passes back to the bucket shape it stands for —
// the fake groups in JS, but on the same keys as the SQL.
const BUCKET_OF_FORMAT = {
  [sqlFormat('hour')]: 'hour',
  [sqlFormat('day')]: 'day',
  [sqlFormat('month')]: 'month',
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
      async list({ testId = null, status = null, applicationId = null, limit = 50 } = {}) {
        // Mirrors the real repository's join: a run carries the names that say
        // what it was a run OF, so the Runs screen can tell two applications
        // apart. Missing rows resolve to null, exactly as the LEFT JOINs do.
        const named = (r) => {
          const test = t.tests.rows.find((x) => x.id === r.test_id) || null;
          const app = test ? t.applications.rows.find((x) => x.id === test.application_id) || null : null;
          const env = r.environment_id ? t.environments.rows.find((x) => x.id === r.environment_id) || null : null;
          return {
            ...r,
            test_name: test ? test.name : null,
            application_id: test ? test.application_id : null,
            application_name: app ? app.name : null,
            environment_name: env ? env.name : null,
            environment_url: env ? env.base_url : null,
          };
        };
        return t.runs
          .where((r) => (testId === null || r.test_id === testId) && (status === null || r.status === status))
          .map(named)
          .filter((r) => applicationId === null || r.application_id === applicationId)
          .slice(0, limit);
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
        // Newest first, like the real query's `ORDER BY created_at DESC, id DESC`
        // — the reactor reads the head of this list to count a failure streak,
        // so the order is part of the contract, not a presentation detail.
        const rows = t.runs
          .where((r) => r.test_id === Number(testId) && !['queued', 'running'].includes(r.status))
          .sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || (b.id - a.id))
          .slice(0, limit);
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
      // The history chart's aggregation, in memory. Buckets with the SAME keys
      // the real DATE_FORMAT produces (stats/period.js owns both), so the API's
      // merge of rows onto empty buckets is exercised for real.
      async stats({ from, to, sqlFormat: format, offsetMinutes = 0, testId = null, applicationId = null } = {}) {
        const bucket = BUCKET_OF_FORMAT[format] || 'day';
        const appOf = (run) => {
          const test = t.tests.find(run.test_id);
          return test ? test.application_id : null;
        };
        const rows = t.runs.rows.filter((r) => {
          if (['queued', 'running'].includes(r.status)) return false;
          const at = new Date(r.started_at || r.created_at);
          if (!(at >= new Date(from) && at < new Date(to))) return false;
          if (testId !== null && r.test_id !== Number(testId)) return false;
          if (applicationId !== null && appOf(r) !== Number(applicationId)) return false;
          return true;
        });
        const acc = new Map();
        for (const r of rows) {
          const at = new Date(r.started_at || r.created_at);
          const key = bucketKey(new Date(at.getTime() - offsetMinutes * 60000), bucket);
          const cur = acc.get(key) || { bucket: key, total: 0, pass: 0, fail: 0, warning: 0, error: 0, skipped: 0, _ms: [], max_duration_ms: null };
          cur.total += 1;
          if (cur[r.status] !== undefined) cur[r.status] += 1;
          if (Number.isFinite(r.duration_ms)) {
            cur._ms.push(r.duration_ms);
            cur.max_duration_ms = Math.max(cur.max_duration_ms ?? 0, r.duration_ms);
          }
          acc.set(key, cur);
        }
        return [...acc.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)).map((b) => ({
          ...b,
          avg_duration_ms: b._ms.length ? Math.round(b._ms.reduce((x, y) => x + y, 0) / b._ms.length) : null,
          _ms: undefined,
        }));
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
    // Certificates: keyed by (application, host, port) like the real unique key,
    // so a re-check updates the row rather than adding one.
    certificates: {
      async record(applicationId, result) {
        const port = Number(result.port) || 443;
        const existing = t.certificates.rows.find((r) => r.application_id === applicationId
          && r.host === result.host && r.port === port);
        const row = { ...result, application_id: applicationId, port };
        if (existing) return t.certificates.update(existing.id, row);
        return t.certificates.insert(row);
      },
      async findById(id) { return t.certificates.find(id); },
      async findByTarget(applicationId, host, port) {
        const p = Number(port) || 443;
        const row = t.certificates.rows.find((r) => r.application_id === applicationId && r.host === host && r.port === p);
        return row ? clone(row) : null;
      },
      async list({ applicationId = null, status = null } = {}) {
        return t.certificates
          .where((r) => (applicationId === null || r.application_id === applicationId) && (status === null || r.status === status))
          .sort((a, b) => new Date(a.valid_to || 8640000000000000) - new Date(b.valid_to || 8640000000000000));
      },
      async dueForCheck() { return t.certificates.rows.map(clone); },
      async pruneMissing(applicationId, kept = []) {
        const keep = new Set(kept.map((k) => `${k.host}:${Number(k.port) || 443}`));
        const doomed = t.certificates.rows.filter((r) => r.application_id === applicationId && !keep.has(`${r.host}:${r.port}`));
        doomed.forEach((r) => t.certificates.remove(r.id));
        return doomed.length;
      },
    },
    // Incidents: one open row per subject_key, exactly as the reactor assumes.
    incidents: {
      async findById(id) { return t.incidents.find(id); },
      async findOpen(subjectKey) {
        const row = [...t.incidents.rows].reverse().find((r) => r.subject_key === subjectKey && r.status === 'open');
        return row ? clone(row) : null;
      },
      async open(input) {
        const at = input.at || new Date();
        return t.incidents.insert({
          status: 'open', occurrences: 1, opened_at: at, last_seen_at: at,
          resolved_at: null, resolved_by: null, resolution: null,
          notified_at: null, notified_severity: null,
          ...input, evidence: input.evidence || [],
        });
      },
      async touch(id, { severity = null, summary = null, evidence = null, kind = null, at = null } = {}) {
        const row = t.incidents.rows.find((r) => r.id === Number(id));
        if (!row) return null;
        const RANKS = { INFO: 1, WARN: 2, CRIT: 3 };
        const patch = { occurrences: (row.occurrences || 1) + 1, last_seen_at: at || new Date() };
        if (severity && (RANKS[severity] || 0) > (RANKS[row.severity] || 0)) patch.severity = severity;
        if (kind) patch.kind = kind;
        if (summary !== null) patch.summary = summary;
        if (evidence !== null) patch.evidence = evidence;
        return t.incidents.update(id, patch);
      },
      async resolve(id, { resolution = 'The next check was healthy', resolvedBy = null, at = null } = {}) {
        const row = t.incidents.rows.find((r) => r.id === Number(id));
        if (!row || row.status !== 'open') return row ? clone(row) : null;
        return t.incidents.update(id, { status: 'resolved', resolved_at: at || new Date(), resolved_by: resolvedBy, resolution });
      },
      async markNotified(id, severity, at = null) {
        return t.incidents.update(id, { notified_at: at || new Date(), notified_severity: severity });
      },
      async list({ status = null, applicationId = null, subjectType = null, severity = null, limit = 100 } = {}) {
        const RANKS = { CRIT: 0, WARN: 1, INFO: 2 };
        return t.incidents
          .where((r) => (status === null || r.status === status)
            && (applicationId === null || r.application_id === applicationId)
            && (subjectType === null || r.subject_type === subjectType)
            && (severity === null || r.severity === severity))
          .sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1)
            || (RANKS[a.severity] - RANKS[b.severity]))
          .slice(0, limit);
      },
      // Mirrors the real window query: what OPENED or RESOLVED inside the
      // window, which is the Changes feed's question — not "what is wrong now".
      async listBetween({ from, to = new Date(), limit = 500 } = {}) {
        const start = from ? new Date(from).getTime() : 0;
        const end = to ? new Date(to).getTime() : Date.now();
        const inWindow = (v) => {
          const t = v ? new Date(v).getTime() : NaN;
          return Number.isFinite(t) && t >= start && t <= end;
        };
        return t.incidents
          .where((r) => inWindow(r.opened_at) || (r.resolved_at && inWindow(r.resolved_at)))
          .slice(0, limit);
      },
      // Mirrors the real GROUP BY: counted by opened_at, joined to an
      // application (an incident whose application is gone is dropped), and an
      // EMPTY selection means none rather than all.
      async countByApplication({ from, to = new Date(), severity = 'CRIT', applicationIds = null, limit = 10 } = {}) {
        if (Array.isArray(applicationIds) && !applicationIds.length) return [];
        const start = from ? new Date(from).getTime() : 0;
        const end = to ? new Date(to).getTime() : Date.now();
        const counts = new Map();
        for (const r of t.incidents.rows) {
          if (severity && r.severity !== severity) continue;
          const opened = r.opened_at ? new Date(r.opened_at).getTime() : NaN;
          if (!Number.isFinite(opened) || opened < start || opened > end) continue;
          if (Array.isArray(applicationIds) && !applicationIds.includes(r.application_id)) continue;
          const app = t.applications.rows.find((a) => a.id === r.application_id);
          if (!app) continue;
          const row = counts.get(app.id) || { application_id: app.id, application_name: app.name, incidents: 0, last_seen_at: null };
          row.incidents += 1;
          counts.set(app.id, row);
        }
        return [...counts.values()]
          .sort((a, b) => b.incidents - a.incidents || String(a.application_name).localeCompare(b.application_name))
          .slice(0, limit);
      },
      async openCounts() {
        const out = { CRIT: 0, WARN: 0, INFO: 0, total: 0 };
        for (const r of t.incidents.rows) {
          if (r.status !== 'open') continue;
          if (out[r.severity] !== undefined) out[r.severity] += 1;
          out.total += 1;
        }
        return out;
      },
      async purgeResolvedOlderThan() { return 0; },
    },
    // Worker heartbeats. Keyed by worker id like the real table's primary key,
    // so a repeated heartbeat updates rather than accumulates.
    workers: {
      async heartbeat({ workerId, hostname = null, version = null }) {
        const existing = t.workers.rows.find((r) => r.worker_id === workerId);
        const at = new Date();
        if (existing) t.workers.update(existing.id, { hostname, version, last_seen_at: at });
        else t.workers.insert({ worker_id: workerId, hostname, version, started_at: at, last_seen_at: at });
        return workerId;
      },
      async listAlive(withinMs) {
        const cutoff = Date.now() - Math.max(1000, Number(withinMs) || 60000);
        return t.workers.rows
          .filter((r) => new Date(r.last_seen_at).getTime() >= cutoff)
          .sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at));
      },
      async list() { return t.workers.rows.slice(); },
      async prune() { return 0; },
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
    workersRepo: repositories.workers,
    settings,
  });

  const auditEntries = [];
  const audit = { record(req, entry) { auditEntries.push(entry); return Promise.resolve(entry); } };

  // The REAL reactor over the in-memory repositories, with a TLS checker that
  // answers from a script instead of opening a socket — the repo rule that
  // outbound calls are mocked applies to a handshake as much as to an HTTP call.
  const notifications = [];
  const reactor = createAssuranceReactor({
    repositories,
    settings,
    certificateChecker: overrides.certificateChecker || makeCertificateChecker(overrides.certificates_seen),
    notify: overrides.notify === null ? null : (finding, group) => {
      notifications.push({ finding, group });
      return Promise.resolve({ dispatched: true });
    },
  });

  const router = createServiceTestsApiRouter({
    repositories,
    settings,
    queue,
    reactor: overrides.reactor === null ? null : reactor,
    artifacts: overrides.artifacts ?? null,
    audit,
    logger: null,
    requireAuth,
    requireRole,
    requireFeature: overrides.requireFeature ?? null,
    roles: ROLES,
  });

  return { repositories, settings, queue, reactor, notifications, audit, auditEntries, router, jobs: [], tables: t, secretBox };
}

module.exports = { makeServiceTests, makeTable, makeCertificateChecker };
