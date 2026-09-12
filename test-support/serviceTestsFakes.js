'use strict';

// In-memory Service Tests module for the API specs.
//
// This builds the REAL router, validators, host policy and settings service over
// in-memory repositories. So a route spec exercises the whole request path —
// licence gate, RBAC, validation, the SSRF allowlist rules — and only the SQL is
// substituted. The SQL itself is covered separately by the storage specs.
//
//   const app = makeApp({ serviceTests: makeServiceTests() });

const crypto = require('crypto');
const { createServiceTestsApiRouter } = require('../src/serviceTests/api');
const { createRecordingsCaptureRouter } = require('../src/serviceTests/api/recordings');
const { createRecorderSource } = require('../src/serviceTests/recording/bookmarklet');
const { createServiceTestSettings } = require('../src/serviceTests/settings');
const { createQueue } = require('../src/serviceTests/scheduler/queue');
const { bucketKey, sqlFormat } = require('../src/serviceTests/stats/period');
const { createAssuranceReactor } = require('../src/serviceTests/assurance/reactor');
const { createAiAnalysis } = require('../src/serviceTests/ai/analyse');
const { ACTIVE: INCIDENT_ACTIVE, canTransition: incidentCanTransition } = require('../src/serviceTests/incidents/lifecycle');
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
    incidentEvents: makeTable(overrides.incidentEvents || []),
    observations: makeTable(overrides.observations || []),
    aiAnalyses: makeTable(overrides.aiAnalyses || []),
    baselines: makeTable(overrides.baselines || []),
    recordings: makeTable(overrides.recordings || []),
    journeys: makeTable(overrides.journeys || []),
    journeySteps: makeTable(overrides.journeySteps || []),
    healing: makeTable(overrides.healing || []),
  };

  // A LEFT JOIN, in JS: a test whose application row is gone still lists.
  const appNameOf = (id) => { const a = t.applications.find(id); return a ? a.name : null; };

  // A journey step with its test and that test's newest run — the shape the
  // health rollup reads. Newest = highest id, exactly as the SQL does it.
  function shapeJourneyStep(s) {
    const test = t.tests.find(s.test_id);
    const runs = t.runs.where((r) => r.test_id === Number(s.test_id));
    const run = runs.length ? runs.reduce((a, b) => (b.id > a.id ? b : a)) : null;
    return {
      id: s.id, journey_id: s.journey_id, test_id: s.test_id, position: s.position,
      label: s.label, required: bool(s.required),
      test: test ? { id: test.id, name: test.name, enabled: bool(test.enabled) } : null,
      run: run ? {
        id: run.id, status: run.status, duration_ms: run.duration_ms ?? null,
        failure_kind: run.failure_kind ?? null, error_message: run.error_message ?? null,
        started_at: run.started_at ?? null, ended_at: run.ended_at ?? null,
      } : null,
    };
  }

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
      // The SQL repository joins the application in and orders by it, because a
      // test name is only unique within its application. The fake does the same
      // in JS so a route spec sees the shape the browser will get.
      async list({ applicationId = null } = {}) {
        return t.tests.where((r) => applicationId === null || r.application_id === applicationId)
          .map((r) => ({ ...r, enabled: bool(r.enabled), steps: [], application_name: appNameOf(r.application_id) }))
          .sort((a, b) => String(a.application_name || '').localeCompare(String(b.application_name || ''))
            || String(a.name || '').localeCompare(String(b.name || '')));
      },
      async findById(id) {
        const r = t.tests.find(id);
        return r ? {
          ...r, enabled: bool(r.enabled), application_name: appNameOf(r.application_id),
          steps: (r.definition && r.definition.steps) || [],
        } : null;
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
      // The real repository returns the run's STEP ROWS. The fake used to hand
      // back an empty list, which quietly made every reader that depends on
      // them — evidence, the service map — look correct while testing nothing.
      async findById(id) {
        const r = t.runs.find(id);
        return r ? { ...r, steps: Array.isArray(r.steps) ? r.steps : [] } : null;
      },
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
      // The durations a baseline is built from: this test's own recent PASSING
      // runs, with the run being judged excluded from the history it is judged
      // against.
      async baselineSamples(testId, { limit = 50, excludeRunId = null } = {}) {
        const rows = t.runs.where((r) => r.test_id === Number(testId) && r.status === 'pass'
          && (!excludeRunId || r.id !== Number(excludeRunId)))
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
        return {
          runs: rows.map((r) => ({ id: r.id, duration_ms: r.duration_ms ?? null })),
          steps: rows.map((r) => (Array.isArray(r.steps) ? r.steps : [])),
        };
      },
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
      // Mirrors the real repository's shaping. `authenticated` arrives from
      // MySQL as 0/1 and is published as a boolean, and the worker writes it as
      // 0/1 — a fake that stored the raw value would let a caller that treats
      // `authenticated` as a boolean pass here and be wrong in production.
      shape(row) {
        if (!row) return null;
        return {
          detected_login: null,
          login_test_id: null,
          credential_id: null,
          session_lost_at_page: null,
          auth_note: null,
          ...row,
          authenticated: row.authenticated === 1 || row.authenticated === true,
          authenticated_page_count: row.authenticated_page_count ?? 0,
        };
      },
      async findById(id) { return repositories.discovery.shape(t.discoveries.find(id)); },
      async list({ applicationId = null, limit = 20 } = {}) {
        return t.discoveries.where((r) => applicationId === null || r.application_id === applicationId)
          .slice(0, limit).map(repositories.discovery.shape);
      },
      async latestForApplication(applicationId) {
        const row = t.discoveries.where((r) => r.application_id === applicationId && r.status === 'complete').pop();
        return repositories.discovery.shape(row) || null;
      },
      // The login form the last COMPLETED discovery found — what lets a
      // rediscover sign in with nothing but a stored credential.
      async lastDetectedLogin(applicationId) {
        const row = t.discoveries.where((r) => Number(r.application_id) === Number(applicationId)
          && r.status === 'complete' && r.detected_login).pop();
        return row ? row.detected_login : null;
      },
      async enqueue(input) { return repositories.discovery.shape(t.discoveries.insert({ status: 'queued', ...input })); },
      async claimNext(workerId) {
        const row = t.discoveries.rows.find((r) => r.status === 'queued');
        if (!row) return null;
        return repositories.discovery.shape(t.discoveries.update(row.id, { status: 'running', claimed_by: workerId, claimed_at: new Date() }));
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
      async finish(id, summary) { return repositories.discovery.shape(t.discoveries.update(id, summary)); },
      async reapStale() { return 0; },
    },
    // The typed facts a run produced. Shaped like the real repository: an
    // unknown layer or outcome lands on a valid one rather than being stored as
    // written, because both columns are ENUMs and one typo must not cost the
    // other fifty-nine observations of the run.
    observations: {
      async recordMany(context, list) {
        const ctx = (context && typeof context === 'object') ? context : {};
        const rows = (Array.isArray(list) ? list : []).filter((o) => o && typeof o === 'object');
        const LAYERS = ['browser', 'page', 'api', 'application', 'server', 'network', 'infrastructure', 'assurance'];
        for (const o of rows) {
          t.observations.insert({
            run_id: ctx.run_id ?? null,
            test_id: ctx.test_id ?? null,
            journey_id: ctx.journey_id ?? null,
            application_id: ctx.application_id ?? null,
            environment_id: ctx.environment_id ?? null,
            layer: LAYERS.includes(o.layer) ? o.layer : 'application',
            kind: String(o.kind || 'unknown').slice(0, 64),
            subject: o.subject ?? null,
            outcome: ['ok', 'bad', 'unknown'].includes(o.outcome) ? o.outcome : 'unknown',
            value: o.value ?? null,
            unit: o.unit ?? null,
            summary: o.summary ?? null,
            detail: o.detail ?? null,
            observed_at: o.observed_at instanceof Date ? o.observed_at : new Date(),
          });
        }
        return rows.length;
      },
      async forRun(runId) {
        return t.observations.where((r) => r.run_id === Number(runId))
          .sort((a, b) => (new Date(a.observed_at) - new Date(b.observed_at)) || (a.id - b.id));
      },
      async list({ applicationId = null, testId = null, layer = null, outcome = null, since = null, limit = 500 } = {}) {
        return t.observations
          .where((r) => (applicationId === null || r.application_id === Number(applicationId))
            && (testId === null || r.test_id === Number(testId))
            && (layer === null || r.layer === layer)
            && (outcome === null || r.outcome === outcome)
            && (since === null || new Date(r.observed_at) >= new Date(since)))
          .sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at))
          .slice(0, Math.min(2000, limit));
      },
      async purgeOlderThan(days) {
        const window = Number(days) > 0 ? Number(days) : 30;
        const cutoff = new Date(Date.now() - window * 86400000);
        const doomed = t.observations.where((r) => new Date(r.observed_at) < cutoff);
        for (const row of doomed) t.observations.remove(row.id);
        return doomed.length;
      },
    },
    // What a provider answered, with the exact context it was given. Every read
    // carries `is_suggestion` whether or not anybody asked, like the real one:
    // a reader who has to remember an answer is a suggestion is one who forgets.
    aiAnalyses: {
      async record(input) {
        const row = (input && typeof input === 'object') ? input : {};
        return repositories.aiAnalyses.shape(t.aiAnalyses.insert({
          incident_id: row.incident_id ?? null,
          application_id: row.application_id ?? null,
          kind: row.kind || 'unknown',
          answer: String(row.answer ?? ''),
          model: row.model ?? null,
          context: row.context ?? null,
          duration_ms: row.duration_ms ?? null,
          requested_by: row.requested_by ?? null,
          created_at: row.created_at instanceof Date ? row.created_at : new Date(),
        }));
      },
      shape(row) { return row ? { ...row, is_suggestion: true, source: 'ai' } : null; },
      async findById(id) { return repositories.aiAnalyses.shape(t.aiAnalyses.find(id)); },
      async forIncident(incidentId, { limit = 10 } = {}) {
        return t.aiAnalyses.where((r) => r.incident_id === Number(incidentId))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)
          .slice(0, limit)
          .map(repositories.aiAnalyses.shape);
      },
      async purgeOlderThan(days) {
        const window = Number(days) > 0 ? Number(days) : 180;
        const cutoff = new Date(Date.now() - window * 86400000);
        const doomed = t.aiAnalyses.where((r) => new Date(r.created_at) < cutoff);
        for (const row of doomed) t.aiAnalyses.remove(row.id);
        return doomed.length;
      },
    },
    suggestions: {
      async findById(id) { const r = t.suggestions.find(id); return r ? { kind: 'test', proposed_journey: null, created_journey_id: null, ...r } : null; },
      async list(filters = {}) {
        // Journeys first, like the SQL: what the service IS reads before the
        // individual checks that prove it.
        return t.suggestions.where((r) => (filters.discoveryId === undefined || r.discovery_id === filters.discoveryId)
          && (filters.applicationId === undefined || r.application_id === filters.applicationId)
          && (filters.status === undefined || r.status === filters.status)
          && (filters.kind === undefined || filters.kind === null || (r.kind || 'test') === filters.kind))
          .map((r) => ({ kind: 'test', proposed_journey: null, created_journey_id: null, ...r }))
          .sort((a, b) => (a.kind === b.kind ? a.id - b.id : (a.kind === 'journey' ? -1 : 1)));
      },
      async createMany(discoveryId, applicationId, list) {
        return (list || []).map((s) => t.suggestions.insert({
          discovery_id: discoveryId, application_id: applicationId, status: 'proposed', confidence: 'medium',
          kind: 'test', proposed_journey: null, created_test_id: null, created_journey_id: null, ...s,
        }).id);
      },
      async markAccepted(id, testId, journeyId = null) {
        const row = t.suggestions.find(id);
        if (!row || row.status !== 'proposed') return null;
        return t.suggestions.update(id, { status: 'accepted', created_test_id: testId, created_journey_id: journeyId });
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
    // Self-healing proposals. Nothing here can change a test — the same
    // guarantee the SQL repository makes, for the same reason: a proposal is a
    // row somebody acts on, never a change that happened on its own.
    // Visual regression baselines (V2 §8). Mirrors the SQL repository's one
    // guarantee that a test could get wrong: accepting REPLACES whatever was
    // there for that (test, step, environment) rather than adding a second row.
    // Two baselines for one step would mean the comparison picks one
    // arbitrarily, and which it picked would decide the answer.
    baselines: {
      // Shaped like the SQL repository, not like the row. `enabled` is a
      // boolean there and a TINYINT here; a fake that hands back 0 where the
      // real one hands back false lets a test pass against a lie.
      shape(row) {
        if (!row) return null;
        return {
          ...row,
          enabled: row.enabled === 1 || row.enabled === true,
          ignore_regions: row.ignore_regions || [],
          tolerance: row.tolerance ?? null,
          threshold_pct: row.threshold_pct === null || row.threshold_pct === undefined
            ? null : Number(row.threshold_pct),
        };
      },
      async findById(id) { return this.shape(t.baselines.find(id)); },
      async listForTest(testId, { enabledOnly = false } = {}) {
        return t.baselines
          .where((b) => b.test_id === Number(testId) && (!enabledOnly || b.enabled !== 0))
          .sort((a, b) => a.step_index - b.step_index)
          .map((b) => this.shape(b));
      },
      async forRun(testId, environmentId) {
        const rows = t.baselines.where((b) => b.test_id === Number(testId) && b.enabled !== 0
          && (b.environment_id === null || b.environment_id === undefined
            || Number(b.environment_id) === Number(environmentId)));
        const byStep = new Map();
        // An environment-specific baseline wins over the environment-less one.
        for (const row of rows.sort((a, b) => (a.environment_id === null ? 1 : 0) - (b.environment_id === null ? 1 : 0))) {
          if (!byStep.has(row.step_index)) byStep.set(row.step_index, this.shape(row));
        }
        return [...byStep.values()];
      },
      async accept(input) {
        const existing = t.baselines.rows.find((b) => b.test_id === Number(input.test_id)
          && b.step_index === Number(input.step_index)
          && (b.environment_id ?? null) === (input.environment_id ?? null));
        const row = {
          ...input,
          test_id: Number(input.test_id),
          step_index: Number(input.step_index),
          environment_id: input.environment_id ?? null,
          ignore_regions: input.ignore_regions || [],
          tolerance: input.tolerance ?? null,
          threshold_pct: input.threshold_pct ?? null,
          enabled: 1,
          accepted_at: new Date(),
        };
        return this.shape(existing ? t.baselines.update(existing.id, row) : t.baselines.insert(row));
      },
      async save(id, patch) {
        const row = t.baselines.find(id);
        if (!row) return null;
        const next = { ...patch };
        if (next.enabled !== undefined) next.enabled = next.enabled ? 1 : 0;
        return this.shape(t.baselines.update(id, next));
      },
      async remove(id) { return t.baselines.remove(id); },
    },
    healing: {
      async findById(id) {
        const r = t.healing.find(id);
        if (!r) return null;
        const test = t.tests.find(r.test_id);
        return {
          ...r,
          test_name: test ? test.name : null,
          application_id: test ? test.application_id : null,
          application_name: test ? appNameOf(test.application_id) : null,
        };
      },
      async propose(input) {
        const stepPath = input.step_path == null ? null : String(input.step_path);
        if (!input.test_id || !stepPath) return null;
        const proposed = JSON.stringify(input.proposed_target || null);
        const open = t.healing.rows.find((r) => r.test_id === Number(input.test_id)
          && r.step_path === stepPath && r.status === 'proposed'
          && JSON.stringify(r.proposed_target || null) === proposed);
        if (open) {
          t.healing.update(open.id, {
            run_id: input.run_id ?? null, reason: input.reason ?? null,
            confidence: input.confidence || 'low', score: input.score ?? null,
          });
          return repositories.healing.findById(open.id);
        }
        const row = t.healing.insert({
          test_id: Number(input.test_id), run_id: input.run_id ?? null, step_path: stepPath,
          step_type: input.step_type ?? null, original_target: input.original_target || null,
          proposed_target: input.proposed_target || null, confidence: input.confidence || 'low',
          reason: input.reason ?? null, score: input.score ?? null,
          status: 'proposed', applied_by: null, decided_at: null,
        });
        return repositories.healing.findById(row.id);
      },
      async list({ testId = null, status = null } = {}) {
        const ORDER = { proposed: 0, accepted: 1, rejected: 2, stale: 3 };
        const rows = t.healing.where((r) => (!testId || r.test_id === Number(testId))
          && (!status || r.status === status));
        const out = [];
        for (const r of rows) out.push(await repositories.healing.findById(r.id));
        return out.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (b.id - a.id));
      },
      async decide(id, status, userId = null) {
        const row = t.healing.find(id);
        if (!row || row.status !== 'proposed') return null;
        t.healing.update(id, { status, applied_by: userId, decided_at: new Date() });
        return repositories.healing.findById(id);
      },
      async markOthersStale(testId, stepPath, keepId) {
        const others = t.healing.rows.filter((r) => r.test_id === Number(testId)
          && r.step_path === String(stepPath) && r.status === 'proposed' && r.id !== Number(keepId));
        for (const r of others) t.healing.update(r.id, { status: 'stale' });
        return others.length;
      },
      async openCounts() {
        const out = new Map();
        for (const r of t.healing.rows) {
          if (r.status !== 'proposed') continue;
          out.set(r.test_id, (out.get(r.test_id) || 0) + 1);
        }
        return out;
      },
    },

    // User journeys. The awkward part the SQL does — each step's LATEST run —
    // is done here the same way: newest id wins, and a test that has never run
    // yields null rather than a default, because the health rollup treats
    // "never found out" as different from "failed".
    journeys: {
      async findById(id) {
        const j = t.journeys.find(id);
        return j ? { ...j, enabled: bool(j.enabled), application_name: appNameOf(j.application_id) } : null;
      },
      async list({ applicationId = null, criticality = null, enabledOnly = false } = {}) {
        const ORDER = { critical: 0, high: 1, normal: 2, low: 3 };
        return t.journeys.where((j) => (!applicationId || j.application_id === applicationId)
          && (!criticality || j.criticality === criticality)
          && (!enabledOnly || j.enabled))
          .map((j) => ({ ...j, enabled: bool(j.enabled), application_name: appNameOf(j.application_id) }))
          .sort((a, b) => (ORDER[a.criticality] ?? 9) - (ORDER[b.criticality] ?? 9)
            || String(a.name || '').localeCompare(String(b.name || '')));
      },
      async create(input) {
        const row = t.journeys.insert({
          criticality: 'normal', description: null, expected_duration_ms: null,
          environment_id: null, updated_by: null, ...input,
          enabled: input.enabled === false ? 0 : 1,
        });
        return repositories.journeys.findById(row.id);
      },
      async save(id, patch) {
        if (!t.journeys.find(id)) return null;
        const p = { ...patch };
        if (p.enabled !== undefined) p.enabled = p.enabled ? 1 : 0;
        t.journeys.update(id, p);
        return repositories.journeys.findById(id);
      },
      async remove(id) { return t.journeys.remove(id); },
      async stepsFor(journeyId) {
        return t.journeySteps.where((s) => s.journey_id === Number(journeyId))
          .sort((a, b) => a.position - b.position)
          .map(shapeJourneyStep);
      },
      async stepsForMany(ids) {
        const out = new Map((ids || []).map((id) => [Number(id), []]));
        for (const s of t.journeySteps.rows.slice().sort((a, b) => a.position - b.position)) {
          if (!out.has(s.journey_id)) continue;
          out.get(s.journey_id).push(shapeJourneyStep(clone(s)));
        }
        return out;
      },
      async setSteps(journeyId, steps) {
        for (const s of t.journeySteps.where((r) => r.journey_id === Number(journeyId))) t.journeySteps.remove(s.id);
        (steps || []).forEach((step, i) => t.journeySteps.insert({
          journey_id: Number(journeyId), test_id: step.test_id, position: i,
          label: step.label ?? null, required: step.required === false ? 0 : 1,
        }));
        return repositories.journeys.stepsFor(journeyId);
      },
      async journeysForTest(testId) {
        const ids = new Set(t.journeySteps.where((s) => s.test_id === Number(testId)).map((s) => s.journey_id));
        return t.journeys.where((j) => ids.has(j.id))
          .map((j) => ({ ...j, enabled: bool(j.enabled), application_name: appNameOf(j.application_id) }));
      },
      async testIdsInJourneys() {
        return [...new Set(t.journeySteps.rows.map((s) => s.test_id))];
      },
    },

    // Recording sessions. `start` mints a token and stores only its SHA-256,
    // exactly as the SQL repository does — so a spec that tries to read the
    // token back out of the table fails here for the same reason it fails in
    // production.
    recordings: {
      async findById(id) {
        const r = t.recordings.find(id);
        return r ? { ...r, application_name: appNameOf(r.application_id) } : null;
      },
      async start({ applicationId, name, baseUrl = null, createdBy = null, ttlMs = 3600000 }) {
        const token = crypto.randomBytes(24).toString('base64url');
        const row = t.recordings.insert({
          application_id: applicationId, name: String(name || 'Recorded test').slice(0, 255),
          status: 'recording', token_hash: crypto.createHash('sha256').update(token).digest('hex'),
          events: [], event_count: 0, base_url: baseUrl, created_test_id: null, created_by: createdBy,
          expires_at: new Date(Date.now() + ttlMs), last_event_at: null,
        });
        return { recording: { ...row, application_name: appNameOf(applicationId) }, token };
      },
      async findByToken(token) {
        if (!token) return null;
        const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const row = t.recordings.rows.find((r) => r.token_hash === hash
          && r.status === 'recording' && new Date(r.expires_at).getTime() > Date.now());
        return row ? { ...clone(row), application_name: appNameOf(row.application_id) } : null;
      },
      async appendEvents(id, events, { maxEvents = 2000 } = {}) {
        const row = t.recordings.rows.find((r) => r.id === Number(id));
        if (!row || row.status !== 'recording') return row ? clone(row) : null;
        const merged = [...(row.events || []), ...(Array.isArray(events) ? events : [])].slice(-maxEvents);
        return t.recordings.update(id, { events: merged, event_count: merged.length, last_event_at: new Date() });
      },
      async stop(id) {
        const row = t.recordings.rows.find((r) => r.id === Number(id));
        if (!row) return null;
        if (row.status !== 'recording') return clone(row);
        return t.recordings.update(id, { status: 'stopped' });
      },
      async accept(id, testId) {
        const row = t.recordings.rows.find((r) => r.id === Number(id));
        if (!row) return null;
        return t.recordings.update(id, { status: 'accepted', created_test_id: testId, events: [] });
      },
      async list({ applicationId = null, status = null } = {}) {
        return t.recordings.where((r) => (!applicationId || r.application_id === applicationId)
          && (!status || r.status === status))
          .map((r) => ({ ...r, application_name: appNameOf(r.application_id) }));
      },
      async remove(id) { return t.recordings.remove(id); },
      async purgeExpired() {
        const gone = t.recordings.rows.filter((r) => r.status === 'recording' && new Date(r.expires_at).getTime() < Date.now());
        for (const r of gone) t.recordings.remove(r.id);
        return gone.length;
      },
    },
    incidents: {
      async findById(id) { return t.incidents.find(id); },
      // The ACTIVE set, like the real repository. This said `status === 'open'`,
      // which was the same thing until migration 090 added investigating and
      // identified — after which an incident somebody had picked up would have
      // had a SECOND one opened beside it for the same problem, and no spec
      // written against this fake could have seen it.
      async findOpen(subjectKey) {
        const row = [...t.incidents.rows].reverse()
          .find((r) => r.subject_key === subjectKey && INCIDENT_ACTIVE.includes(r.status));
        return row ? clone(row) : null;
      },
      async open(input) {
        const at = input.at || new Date();
        return t.incidents.insert({
          status: 'open', occurrences: 1, opened_at: at, last_seen_at: at,
          resolved_at: null, resolved_by: null, resolution: null,
          acknowledged_at: null, acknowledged_by: null,
          correlated_layer: null, confidence: null,
          impact: null, impact_reason: null, affected_journeys: [],
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
        // Guarded on the ACTIVE set, like the real one: an incident under
        // investigation is still resolvable, and a closed one is not reopened by
        // a passing check.
        if (!row || !INCIDENT_ACTIVE.includes(row.status)) return row ? clone(row) : null;
        return t.incidents.update(id, { status: 'resolved', resolved_at: at || new Date(), resolved_by: resolvedBy, resolution });
      },
      // The lifecycle states migration 090 added. Guarded by the same pure
      // module the real repository uses, so the two cannot drift on the rules.
      async transition(id, to, { by = null, at = null, note = null } = {}) {
        const row = t.incidents.rows.find((r) => r.id === Number(id));
        if (!row) return { ok: false, reason: 'that incident no longer exists', incident: null };
        if (row.status === to) return { ok: true, reason: null, incident: clone(row), unchanged: true };
        const allowed = incidentCanTransition(row.status, to);
        if (!allowed || !allowed.ok) return { ok: false, reason: (allowed && allowed.reason) || 'not allowed', incident: clone(row) };
        const when = at || new Date();
        const patch = { status: to };
        if (to === 'resolved') {
          patch.resolved_at = when;
          patch.resolved_by = by;
          if (note !== null) patch.resolution = note;
        }
        if (to === 'investigating' && !row.acknowledged_at) {
          patch.acknowledged_at = when;
          patch.acknowledged_by = by;
        }
        return { ok: true, reason: null, incident: t.incidents.update(id, patch) };
      },
      async recordAssessment(id, { correlatedLayer = null, confidence = null, impact = null,
        impactReason = null, affectedJourneys = null, likelyCause = null } = {}) {
        const patch = {};
        if (correlatedLayer !== null) patch.correlated_layer = correlatedLayer;
        if (confidence !== null) patch.confidence = Math.max(0, Math.min(100, Math.round(Number(confidence) || 0)));
        if (impact !== null) patch.impact = impact;
        if (impactReason !== null) patch.impact_reason = impactReason;
        if (affectedJourneys !== null) patch.affected_journeys = affectedJourneys;
        if (likelyCause !== null) patch.likely_cause = likelyCause;
        if (!Object.keys(patch).length) return t.incidents.find(id);
        return t.incidents.update(id, patch);
      },
      async addEvents(incidentId, events) {
        const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
        for (const e of list) {
          t.incidentEvents.insert({
            incident_id: Number(incidentId),
            kind: e.kind || 'note',
            summary: e.summary || '',
            detail: e.detail || null,
            source: ['run', 'sweep', 'correlation', 'rule', 'person', 'notification'].includes(e.source) ? e.source : 'run',
            actor_id: e.actor_id ?? e.actorId ?? null,
            occurred_at: e.occurred_at instanceof Date ? e.occurred_at : (e.at instanceof Date ? e.at : new Date()),
          });
        }
        return list.length;
      },
      async addEvent(incidentId, event) { return repositories.incidents.addEvents(incidentId, [event]); },
      async timeline(incidentId, { limit = 500 } = {}) {
        return t.incidentEvents
          .where((r) => r.incident_id === Number(incidentId))
          .sort((a, b) => (new Date(a.occurred_at) - new Date(b.occurred_at)) || (a.id - b.id))
          .slice(0, limit);
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
      // Mirrors the real time-series query: one entry per (bucket, application).
      // The bucket key is derived the same way the period helper cuts them, so
      // the fake and the real SQL agree about where a day starts.
      async seriesByApplication({ from, to = new Date(), bucket = 'day', offsetMinutes = 0, severity = 'CRIT', applicationIds = null } = {}) {
        if (Array.isArray(applicationIds) && !applicationIds.length) return [];
        const { bucketKey } = require('../src/serviceTests/stats/period');
        const start = from ? new Date(from).getTime() : 0;
        const end = to ? new Date(to).getTime() : Date.now();
        const out = new Map();
        for (const r of t.incidents.rows) {
          if (severity && r.severity !== severity) continue;
          const opened = r.opened_at ? new Date(r.opened_at).getTime() : NaN;
          if (!Number.isFinite(opened) || opened < start || opened >= end) continue;
          if (Array.isArray(applicationIds) && !applicationIds.includes(r.application_id)) continue;
          const app = t.applications.rows.find((a) => a.id === r.application_id);
          if (!app) continue;
          const key0 = bucketKey(new Date(opened - (Number(offsetMinutes) || 0) * 60000), bucket);
          const key = `${key0}|${app.id}`;
          const row = out.get(key)
            || { bucket: key0, application_id: app.id, application_name: app.name, incidents: 0 };
          row.incidents += 1;
          out.set(key, row);
        }
        return [...out.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
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
    // The AI layer, built over whatever provider the spec supplies. With none —
    // which is the default, and the state of most real deployments — it reports
    // itself unavailable and every route still answers 200.
    aiAnalysis: createAiAnalysis({
      ai: overrides.ai ?? null,
      store: repositories.aiAnalyses,
      now: () => new Date(),
    }),
    artifacts: overrides.artifacts ?? null,
    audit,
    logger: null,
    requireAuth,
    requireRole,
    requireFeature: overrides.requireFeature ?? null,
    roles: ROLES,
    // The real recorder, so a spec sees the bookmarklet the browser gets.
    recorderSource: createRecorderSource({ path: require('path').join(__dirname, '..', 'public', 'recorder.js') }),
  });

  // The ingest half, wired the same way the real module wires it: no session
  // middleware, the capture token as the only authority.
  const captureRouter = createRecordingsCaptureRouter({ repositories, logger: null });

  return {
    repositories, settings, queue, reactor, notifications, audit, auditEntries,
    router, captureRouter, jobs: [], tables: t, secretBox,
  };
}

module.exports = { makeServiceTests, makeTable, makeCertificateChecker };
