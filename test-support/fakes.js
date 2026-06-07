'use strict';

// Safety net: make sure a JWT secret exists before the app/config is loaded,
// in case a test file forgets to set one. Individual test files still set
// these at their very top to be explicit.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';

const { createApp } = require('../src/app');
const { issueToken } = require('../src/auth/jwt');
const { createSettingsService } = require('../src/services/settings');
const { createSecretBox } = require('../src/lib/secretBox');
const { createConnectorRegistry } = require('../src/integrations/connectors');
const { createPlanService } = require('../src/license/planService');
const { createUsageService } = require('../src/services/usageService');

// ---- Repositories ---------------------------------------------------------

// A fake locations repository. Each method has a sensible default and can be
// overridden per test — e.g. point one at `throwingAsync()` to drive a 500.
function makeLocationsRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    create:
      overrides.create ||
      (async (input) => ({
        id: 1,
        ...input,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    update: overrides.update || (async () => null),
    remove: overrides.remove || (async () => false),
  };
}

// A fake users repository.
function makeUsersRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findByEmail: overrides.findByEmail || (async () => null),
    findByEmailWithHash: overrides.findByEmailWithHash || (async () => null),
    create:
      overrides.create ||
      (async (input) => ({
        id: 1,
        email: input.email,
        role: input.role,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    update: overrides.update || (async () => null),
    remove: overrides.remove || (async () => false),
    countByRole: overrides.countByRole || (async () => 1),
    getPreferences: overrides.getPreferences || (async () => ({})),
    updatePreferences: overrides.updatePreferences || (async (id, patch) => ({ ...patch })),
  };
}

// A fake agents repository.
function makeAgentsRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findForGeo: overrides.findForGeo || (async () => []),
    updateManaged:
      overrides.updateManaged || (async (id, patch) => ({ id, ...patch })),
    setCapabilities:
      overrides.setCapabilities || (async (id, capabilities) => ({ id, capabilities })),
    remove: overrides.remove || (async () => false),
    setStatus: overrides.setStatus || (async () => {}),
    touchLastSeen: overrides.touchLastSeen || (async () => {}),
  };
}

// A fake agent-tokens repository.
function makeAgentTokensRepo(overrides = {}) {
  return {
    findActiveByHash: overrides.findActiveByHash || (async () => null),
    touchLastUsed: overrides.touchLastUsed || (async () => {}),
  };
}

// A fake results repository.
function makeResultsRepo(overrides = {}) {
  return {
    createMany: overrides.createMany || (async () => 0),
    findByAgentId: overrides.findByAgentId || (async () => []),
    latestByLocation: overrides.latestByLocation || (async () => []),
    latestPerAgent: overrides.latestPerAgent || (async () => []),
    rangeByLocation: overrides.rangeByLocation || (async () => []),
  };
}

// A fake probe-results repository (records inserted rows; benign empty reads).
function makeProbeResultsRepo(overrides = {}) {
  const rows = [];
  return {
    rows,
    createMany: overrides.createMany || (async (agentId, results) => { for (const r of results) rows.push({ agentId, ...r }); return results.length; }),
    findByAgent: overrides.findByAgent || (async () => []),
    latestByAgent: overrides.latestByAgent || (async () => []),
    fleetHealth: overrides.fleetHealth || (async () => []),
    availability: overrides.availability || (async () => []),
  };
}

// A fake incidents repository (in-memory, stateful) — supports the derivation
// service (findActive/open/resolve) AND the report routes (list/findById). Rows
// are kept snake_case internally; list/findById return the camelCase API shape.
function makeIncidentsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
  const mapOut = (r) => ({
    id: r.id,
    locationId: r.location_id ?? null,
    locationName: r.location_name ?? null,
    agentId: r.agent_id,
    agentName: r.agent_name ?? null,
    metric: r.metric,
    severity: r.severity,
    startedAt: iso(r.started_at),
    resolvedAt: iso(r.resolved_at),
    durationSeconds: r.duration_seconds ?? null,
    affectedTarget: r.affected_target,
    status: r.resolved_at == null ? 'active' : 'resolved',
    createdAt: iso(r.created_at || r.started_at),
  });
  return {
    rows,
    findActive: overrides.findActive || (async (agentId, metric, target) => {
      const r = rows.find((x) => x.agent_id === agentId && x.metric === metric && x.affected_target === target && x.resolved_at == null);
      return r ? { id: r.id, startedAt: iso(r.started_at), severity: r.severity } : null;
    }),
    open: overrides.open || (async (inc) => {
      const id = (seq += 1);
      rows.push({ id, location_id: null, resolved_at: null, duration_seconds: null, created_at: new Date(), ...inc });
      return id;
    }),
    resolve: overrides.resolve || (async (id, resolvedAt) => {
      const r = rows.find((x) => x.id === id && x.resolved_at == null);
      if (!r) return false;
      r.resolved_at = resolvedAt;
      r.duration_seconds = Math.max(0, Math.round((new Date(resolvedAt).getTime() - new Date(r.started_at).getTime()) / 1000));
      return true;
    }),
    updateSeverity: overrides.updateSeverity || (async (id, severity) => {
      const r = rows.find((x) => x.id === id && x.resolved_at == null);
      if (!r) return false;
      r.severity = severity;
      return true;
    }),
    findById: overrides.findById || (async (id) => { const r = rows.find((x) => x.id === id); return r ? mapOut(r) : null; }),
    list: overrides.list || (async () => rows.map(mapOut)),
  };
}

// A fake incident-thresholds repository (in-memory) seeded with the same global
// defaults as migration 023, so the derivation service behaves as in production.
function makeIncidentThresholdsRepo(overrides = {}) {
  const rows = overrides.rows || [
    { id: 1, location_id: null, metric: 'reachability', warning_value: null, critical_value: null, debounce_count: 3 },
    { id: 2, location_id: null, metric: 'latency', warning_value: 150, critical_value: 300, debounce_count: 3 },
    { id: 3, location_id: null, metric: 'packet_loss', warning_value: 2, critical_value: 5, debounce_count: 3 },
  ];
  let seq = rows.length;
  return {
    rows,
    getEffective: overrides.getEffective || (async (locationId, metric) => {
      const loc = rows.find((r) => r.location_id === locationId && r.metric === metric);
      if (loc) return loc;
      return rows.find((r) => r.location_id == null && r.metric === metric) || null;
    }),
    listGlobal: overrides.listGlobal || (async () => rows.filter((r) => r.location_id == null)),
    listByLocation: overrides.listByLocation || (async (id) => rows.filter((r) => r.location_id === id)),
    findById: overrides.findById || (async (id) => rows.find((r) => r.id === id) || null),
    upsert: overrides.upsert || (async ({ location_id = null, metric, warning_value = null, critical_value = null, debounce_count = 3 }) => {
      let r = rows.find((x) => x.location_id === location_id && x.metric === metric);
      if (r) { Object.assign(r, { warning_value, critical_value, debounce_count }); return r; }
      r = { id: (seq += 1), location_id, metric, warning_value, critical_value, debounce_count };
      rows.push(r);
      return r;
    }),
  };
}

// A fake incident-derivation service (records calls; derives nothing by default).
function makeIncidentService(overrides = {}) {
  const calls = [];
  return {
    calls,
    processAgent: overrides.processAgent || (async (agentId) => { calls.push({ agentId }); return { opened: 0, resolved: 0 }; }),
  };
}

// A fake enrollment-codes repository.
function makeEnrollmentCodesRepo(overrides = {}) {
  return {
    create:
      overrides.create ||
      (async ({ code, location_id, created_by, maxUses = 1 }) => ({
        id: 1,
        code,
        location_id: location_id ?? null,
        created_by,
        expires_at: '2026-01-01T01:00:00.000Z',
        used_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        max_uses: maxUses,
        uses_remaining: maxUses,
      })),
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findByCode: overrides.findByCode || (async () => null),
    remove: overrides.remove || (async () => false),
  };
}

// A fake enrollment store (the atomic claim-and-enroll operation). The default
// honours bulk codes statefully so route-level N/N+1 tests work: seed remaining
// uses via overrides.remaining (default 1).
function makeEnrollmentStore(overrides = {}) {
  let remaining = overrides.remaining ?? 1;
  let nextId = 1;
  return {
    claimAndEnroll:
      overrides.claimAndEnroll ||
      (async () => {
        if (remaining <= 0) return { status: 'used' };
        remaining -= 1;
        return { status: 'ok', agentId: nextId++ };
      }),
  };
}

// A fake artifact store (one published linux-amd64 binary by default). Pass
// overrides to simulate an empty store or a throwing get() for 500 paths.
function makeArtifactStore(overrides = {}) {
  const entries = overrides.entries || {
    'linux-amd64': { platform: 'linux-amd64', filename: 'blueeye-agent-linux-amd64', path: '/dev/null', size: 3, sha256: 'a'.repeat(64), contentType: 'application/octet-stream' },
  };
  return {
    reload: overrides.reload || (() => {}),
    list: overrides.list || (() => Object.values(entries).map(({ path: _p, ...rest }) => rest)),
    get: overrides.get || ((p) => entries[String(p || '')] || null),
    has: overrides.has || ((p) => Boolean(entries[String(p || '')])),
    checksums: overrides.checksums || (() => { const o = {}; for (const k of Object.keys(entries)) o[k] = entries[k].sha256; return o; }),
    get size() { return Object.keys(entries).length; },
  };
}

// A fake agent-source store (one published source bundle by default). Pass
// { present: false } to simulate a server with no source configured, or a
// throwing meta()/buffer() to drive a 500.
function makeSourceStore(overrides = {}) {
  const has = overrides.present !== false;
  const sha = overrides.sha256 || 'c'.repeat(64);
  const buf = overrides.buf || Buffer.from('fake-agent-source-tarball');
  return {
    reload: overrides.reload || (() => {}),
    available: overrides.available || (() => has),
    buffer: overrides.buffer || (() => (has ? buf : null)),
    meta: overrides.meta || (() => (has ? { filename: 'blueeye-agent-source.tgz', contentType: 'application/gzip', size: buf.length, sha256: sha } : null)),
    uninstallScript: overrides.uninstallScript || (() => (has ? '#!/bin/sh\n# fake uninstall\n' : null)),
    sourceVersion: overrides.sourceVersion || (() => (has ? '0.1.0' : null)),
    get sha256() { return has ? sha : null; },
    get size() { return has ? buf.length : 0; },
  };
}

// A fake signed-release store. Records add() calls so a test can assert what was
// stored after a verified upload. latest()/get() default to "no releases".
function makeReleaseStore(overrides = {}) {
  const added = [];
  return {
    added,
    add: overrides.add || ((r) => { const meta = { ...r, createdAt: new Date().toISOString() }; added.push(meta); return meta; }),
    has: overrides.has || ((v) => added.some((r) => r.version === v)),
    list: overrides.list || (() => added.slice()),
    latest: overrides.latest || (() => (added.length ? added[added.length - 1] : null)),
    get: overrides.get || ((v) => added.find((r) => r.version === v) || null),
    reload: overrides.reload || (() => {}),
  };
}

// A fake agent-action audit repo (in-memory). Records 'requested' rows and lets
// complete() flip them terminal, so route tests can assert what was audited.
function makeAuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, state: 'requested', requested_at: new Date().toISOString(), completed_at: null, result_detail: null, ...r }); return id; }),
    complete: overrides.complete || (async (id, { state, resultDetail = null }) => {
      const row = rows.find((x) => x.id === id && x.state === 'requested');
      if (!row) return false;
      row.state = state; row.result_detail = resultDetail; row.completed_at = new Date().toISOString();
      return true;
    }),
    findByAgent: overrides.findByAgent || (async (agentId) => rows.filter((x) => x.agentId === agentId).slice().reverse()),
    findByActor: overrides.findByActor || (async (userId) => rows.filter((x) => x.actorUserId === userId).slice().reverse()),
    findAll: overrides.findAll || (async () => rows.slice().reverse()),
  };
}

// A fake db with a ping() used by GET /health.
function makeDb(overrides = {}) {
  return {
    pool: overrides.pool || {},
    ping: overrides.ping || (async () => {}),
    close: overrides.close || (async () => {}),
  };
}

// A fake agent commander (push commands to agents over the WS). Defaults to
// "delivered to 1 connection"; sendCommandAndWait resolves with a benign ack.
function makeAgentCommander(overrides = {}) {
  return {
    sendCommand: overrides.sendCommand || (() => 1),
    sendCommandAndWait:
      overrides.sendCommandAndWait ||
      (async () => ({
        delivered: 1,
        acked: true,
        reply: { agentVersion: '0.1.0', sources: ['proc'], managed: 'systemd', accepted: true, runtime: 'systemd' },
      })),
  };
}

// A fake system-info service (storage/disk + database size).
function makeSystemInfo(overrides = {}) {
  return {
    getStorage:
      overrides.getStorage ||
      (async () => ({
        at: '2026-01-01T00:00:00.000Z',
        disk: { path: '/data', available: true, totalBytes: 100, usedBytes: 40, freeBytes: 60, usedPercent: 40 },
        database: { name: 'blueeye', totalBytes: 10, dataBytes: 8, indexBytes: 2, tableCount: 3, tables: [] },
        ingest: { minutes: 3, rows: 5, bytes: 1024, bytesPerDay: Math.round((1024 / 3) * 1440) },
      })),
    getIngest: overrides.getIngest || (async () => ({ minutes: 3, rows: 5, bytes: 1024, bytesPerDay: Math.round((1024 / 3) * 1440) })),
    getDisk: overrides.getDisk || (async () => ({ path: '/data', available: true })),
    getDatabase: overrides.getDatabase || (async () => ({ name: 'blueeye', totalBytes: 0, tables: [] })),
  };
}

// A fake license manager (defaults to a healthy, generous license).
function makeLicenseManager(overrides = {}) {
  const status = () => ({ status: 'valid', licensed: true, maxAgents: 1000, plan: overrides.plan || '', validUntil: overrides.validUntil || null, serverId: 'test-server' });
  return {
    isLicensed: overrides.isLicensed || (() => true),
    getMaxAgents: overrides.getMaxAgents || (() => 1000),
    getPlan: overrides.getPlan || (() => overrides.plan || ''),
    canAcceptNewConnection: overrides.canAcceptNewConnection || (() => true),
    getStatus: overrides.getStatus || status,
    getFeatures: overrides.getFeatures || (() => ({ analysis: true, assistant: true, alerting: true, geo: true })),
    validateOnce: overrides.validateOnce || (async () => (overrides.getStatus || status)()),
  };
}

// A fake feature gate. Allow-all by default so module tests are unaffected; pass
// { features: { geo: false, ... } } (or a custom isFeatureEnabled) to simulate a
// license that doesn't include a feature.
function makeFeatureGate(overrides = {}) {
  const enabled = overrides.features || { analysis: true, assistant: true, alerting: true, geo: true };
  return {
    isFeatureEnabled: overrides.isFeatureEnabled || ((f) => enabled[f] === true),
    summary: overrides.summary || (() => ({ analysis: !!enabled.analysis, assistant: !!enabled.assistant, alerting: !!enabled.alerting, geo: !!enabled.geo })),
  };
}

// A fake analysis finding store (in-memory). Mirrors FindingStore's surface.
function makeFindingStore(overrides = {}) {
  const rows = [];
  return {
    rows,
    save: overrides.save || (async (f) => { const saved = { ...f, id: f.id || `f${rows.length + 1}`, acked: false }; rows.push(saved); return saved; }),
    list: overrides.list || (async (hostId, since) => rows.filter((f) => (!hostId || f.hostId === hostId) && (!since || new Date(f.createdAt || 0) >= new Date(since)))),
    get: overrides.get || (async (id) => rows.find((f) => f.id === id) || null),
    ack: overrides.ack || (async (id) => { const f = rows.find((x) => x.id === id); if (!f) return false; f.acked = true; return true; }),
    setCorrelations: overrides.setCorrelations || (async (id, ids) => { const f = rows.find((x) => x.id === id); if (!f) return false; f.correlatedWith = Array.isArray(ids) ? ids : []; return true; }),
  };
}

// A fake analysis pipeline (records calls; produces nothing by default).
function makeAnalysisPipeline(overrides = {}) {
  const calls = [];
  return {
    calls,
    processResults: overrides.processResults || (async (hostId, payloads) => { calls.push({ hostId, payloads }); return []; }),
  };
}

// A fake probe-analysis pipeline (records calls; produces nothing by default).
function makeProbePipeline(overrides = {}) {
  const calls = [];
  return {
    calls,
    processAgent: overrides.processAgent || (async (agentId) => { calls.push({ agentId }); return []; }),
  };
}

// A fake flows repository (records inserted rows; benign empty reads).
function makeFlowsRepo(overrides = {}) {
  const rows = [];
  return {
    rows,
    insertMany: overrides.insertMany || (async (records) => { for (const r of records) rows.push(r); return records.length; }),
    aggregateExternalDestinations: overrides.aggregateExternalDestinations || (async () => []),
    destinationExists: overrides.destinationExists || (async () => false),
    agentIdsForDestination: overrides.agentIdsForDestination || (async () => []),
    selectFlows: overrides.selectFlows || (async () => ({ byAsn: [], byDirection: [], byProto: [], series: [], totals: { bytes: 0, flowCount: 0, records: 0 } })),
    exploreFlows: overrides.exploreFlows || (async () => ({ topTalkers: [], byPort: [], byProto: [], series: [], scans: [], totals: { bytes: 0, packets: 0, flowCount: 0, records: 0 } })),
    agentIdsForIp: overrides.agentIdsForIp || (async () => []),
    agentIdsForPort: overrides.agentIdsForPort || (async () => []),
    asnSeries: overrides.asnSeries || (async () => []),
  };
}

// A fake flow pipeline (records calls; stores nothing by default).
function makeFlowPipeline(overrides = {}) {
  const calls = [];
  return {
    calls,
    processResults: overrides.processResults || (async (agentId, payloads) => { calls.push({ agentId, payloads }); return 0; }),
  };
}

// A fake alerting dispatcher (records dispatch calls; knows three channels).
function makeDispatcher(overrides = {}) {
  const calls = [];
  return {
    calls,
    dispatch: overrides.dispatch || (async (finding, group) => { calls.push({ finding, group }); return { dispatched: true, results: [] }; }),
    describe: overrides.describe || (() => ({ enabled: false, cooldownMs: 0, channels: {} })),
    channelNames: overrides.channelNames || (() => ['email', 'webhook', 'syslog']),
    test: overrides.test || (async (channel) => ({ channel, ok: true, detail: 'test' })),
  };
}

// A real settings service backed by an in-memory store, so PUT validation and
// the effective-map overlay behave exactly as in production.
function makeSettingsService(overrides = {}) {
  const store = new Map(overrides.initial ? Object.entries(overrides.initial) : []);
  const settingsRepo = {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v); return v; },
  };
  const config = { geo: { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', tileAttribution: 'test', tileMaxZoom: 19, geocodeUrl: 'https://nominatim.example' } };
  return createSettingsService({ settingsRepo, config });
}

// A fake AI assistant. Disabled by default (explain rejects with FeatureDisabled)
// so the endpoint answers 403 unless a test opts in with its own explain.
function makeAssistant(overrides = {}) {
  const disabled = () => { const e = new Error('The AI assistant is disabled'); e.name = 'FeatureDisabled'; throw e; };
  return {
    isEnabled: overrides.isEnabled || (() => Boolean(overrides.explain || overrides.summarizeLocation || overrides.explainDiagnostic)),
    explain: overrides.explain || (async () => disabled()),
    explainDiagnostic: overrides.explainDiagnostic || (async () => disabled()),
    summarizeLocation: overrides.summarizeLocation || (async () => disabled()),
  };
}

// A fake test-packages repository (in-memory list; benign defaults).
function makeTestPackagesRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findEnabledScheduled: overrides.findEnabledScheduled || (async () => []),
    create: overrides.create || (async (p) => ({ id: 1, last_run_at: null, last_run_summary: null, ...p })),
    update: overrides.update || (async (id, p) => ({ id, ...p })),
    remove: overrides.remove || (async () => false),
    setLastRun: overrides.setLastRun || (async () => {}),
  };
}

// A fake speed-test results repository (records inserts; benign empty reads).
function makeSpeedtestResultsRepo(overrides = {}) {
  const rows = [];
  return {
    rows,
    create: overrides.create || (async (agentId, r) => { rows.push({ agentId, ...r }); return rows.length; }),
    findByAgent: overrides.findByAgent || (async () => []),
    latestPerAgent: overrides.latestPerAgent || (async () => []),
  };
}

// A fake test-package runner; defaults to a benign run summary.
function makeTestPackageRunner(overrides = {}) {
  return {
    run: overrides.run || (async () => ({ at: '2026-01-01T00:00:00.000Z', targeted: 0, reached: 0, delivered: 0, items: 0 })),
    resolveTargetIds: overrides.resolveTargetIds || (() => []),
  };
}

// A real secret box with a fixed test key, so route encryption + dispatcher
// decryption round-trip exactly as in production.
function makeSecretBox(overrides = {}) {
  return createSecretBox({ key: overrides.key || 'test-secret-box-key-do-not-use-in-prod' });
}

// A real connector registry with an injected fetch (default: a benign 200), so
// the integrations route exercises the actual per-type config validation.
function makeConnectorRegistry(overrides = {}) {
  const fetchImpl = overrides.fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) }));
  return createConnectorRegistry({ fetchImpl });
}

// A fake integrations repository (stateful, in-memory). Mirrors the real safe-row
// vs. with-secret split so the CRUD route behaves end-to-end.
function makeIntegrationsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const safe = (r) => (r ? {
    id: r.id, type: r.type, name: r.name, base_url: r.base_url, auth_type: r.auth_type,
    enabled: r.enabled, config_json: r.config_json, created_at: r.created_at, updated_at: r.updated_at,
  } : null);
  return {
    rows,
    findAll: overrides.findAll || (async () => rows.map(safe)),
    findEnabled: overrides.findEnabled || (async () => rows.filter((r) => r.enabled).map(safe)),
    findById: overrides.findById || (async (id) => safe(rows.find((r) => r.id === id)) || null),
    findByIdWithSecret: overrides.findByIdWithSecret || (async (id) => { const r = rows.find((x) => x.id === id); return r ? { ...r } : null; }),
    findEnabledWithSecret: overrides.findEnabledWithSecret || (async () => rows.filter((r) => r.enabled).map((r) => ({ ...r }))),
    findByName: overrides.findByName || (async (name) => safe(rows.find((r) => r.name === name)) || null),
    create: overrides.create || (async (input) => {
      const id = (seq += 1);
      const row = {
        id, type: input.type, name: input.name, base_url: input.baseUrl, auth_type: input.authType,
        credentials_encrypted: input.credentialsEncrypted ?? null, enabled: input.enabled !== false,
        config_json: input.config || {}, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      };
      rows.push(row);
      return safe(row);
    }),
    update: overrides.update || (async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.baseUrl !== undefined) row.base_url = patch.baseUrl;
      if (patch.authType !== undefined) row.auth_type = patch.authType;
      if (patch.enabled !== undefined) row.enabled = patch.enabled;
      if (patch.config !== undefined) row.config_json = patch.config;
      if (patch.credentialsEncrypted !== undefined) row.credentials_encrypted = patch.credentialsEncrypted;
      return safe(row);
    }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((r) => r.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake integration-audit repository (in-memory). Records dispatcher fires.
function makeIntegrationAuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, created_at: new Date().toISOString(), ...r }); return id; }),
    findByIntegration: overrides.findByIntegration || (async (iid) => rows.filter((r) => r.integrationId === iid).slice().reverse()),
    findAll: overrides.findAll || (async () => rows.slice().reverse()),
  };
}

// A fake integrations dispatcher (records emits; benign test-fire). emitFinding /
// emitAgentEvent push synchronously so route tests can assert the wiring even
// though the routes fire-and-forget.
function makeIntegrationsDispatcher(overrides = {}) {
  const calls = [];
  return {
    calls,
    emit: overrides.emit || (async (event) => { calls.push(event); return { dispatched: 0, results: [] }; }),
    emitFinding: overrides.emitFinding || (async (finding) => { calls.push({ kind: 'finding', finding }); return { dispatched: 0, results: [] }; }),
    emitAgentEvent: overrides.emitAgentEvent || (async (kind, agent) => { calls.push({ kind: `agent.${kind}`, agent }); return { dispatched: 0, results: [] }; }),
    testFire: overrides.testFire || (async () => ({ ok: true, status: 201, detail: 'created (201)' })),
  };
}

// A fake LDAP config repository (stateful, in-memory). Mirrors the safe vs.
// with-secret split + the upsert merge semantics of the real repo.
function makeLdapConfigRepo(overrides = {}) {
  let row = overrides.row || null; // a full (with-secret) row or null
  const safe = (r) => (r ? {
    id: r.id, host: r.host, port: r.port, use_tls: r.use_tls, bind_dn: r.bind_dn, base_dn: r.base_dn,
    user_filter: r.user_filter, group_filter: r.group_filter, enabled: r.enabled,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  } : null);
  return {
    get: overrides.get || (async () => safe(row)),
    getWithSecret: overrides.getWithSecret || (async () => (row ? { ...row, ...safe(row) } : null)),
    upsert: overrides.upsert || (async (patch) => {
      const prev = row || { id: 1, bind_pw_encrypted: null };
      row = {
        id: prev.id || 1,
        host: patch.host !== undefined ? patch.host : prev.host,
        port: patch.port !== undefined ? patch.port : (prev.port ?? 389),
        use_tls: patch.useTls !== undefined ? !!patch.useTls : !!prev.use_tls,
        bind_dn: patch.bindDn !== undefined ? patch.bindDn : (prev.bind_dn ?? null),
        bind_pw_encrypted: patch.bindPwEncrypted !== undefined ? patch.bindPwEncrypted : (prev.bind_pw_encrypted ?? null),
        base_dn: patch.baseDn !== undefined ? patch.baseDn : prev.base_dn,
        user_filter: patch.userFilter !== undefined ? patch.userFilter : (prev.user_filter ?? '(sAMAccountName={{username}})'),
        group_filter: patch.groupFilter !== undefined ? patch.groupFilter : (prev.group_filter ?? null),
        enabled: patch.enabled !== undefined ? !!patch.enabled : !!prev.enabled,
      };
      return safe(row);
    }),
  };
}

// A fake LDAP role-map repository (stateful, in-memory).
function makeLdapRoleMapRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    findAll: overrides.findAll || (async () => rows.slice()),
    findById: overrides.findById || (async (id) => rows.find((r) => r.id === id) || null),
    findByGroup: overrides.findByGroup || (async (dn) => rows.find((r) => r.ldap_group_dn === dn) || null),
    create: overrides.create || (async ({ groupDn, role }) => { const r = { id: (seq += 1), ldap_group_dn: groupDn, blueeye_role: role, created_at: '2026-01-01T00:00:00.000Z' }; rows.push(r); return r; }),
    update: overrides.update || (async (id, { groupDn, role }) => { const r = rows.find((x) => x.id === id); if (!r) return null; if (groupDn !== undefined) r.ldap_group_dn = groupDn; if (role !== undefined) r.blueeye_role = role; return r; }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((r) => r.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake LDAP login-audit repository (in-memory).
function makeLdapLoginAuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, created_at: new Date().toISOString(), ...r }); return id; }),
    findAll: overrides.findAll || (async () => rows.slice().reverse()),
  };
}

// A fake LDAP auth service. DISABLED by default so existing local-login tests are
// unaffected; opt in via overrides (isEnabled/authenticate).
function makeLdapAuth(overrides = {}) {
  return {
    isEnabled: overrides.isEnabled || (async () => false),
    authenticate: overrides.authenticate || (async () => ({ enabled: false })),
    testConnection: overrides.testConnection || (async () => ({ ok: true, detail: 'bound' })),
    resolveRole: overrides.resolveRole || (async () => ({ role: null, matched: 0 })),
  };
}

// ---- App + auth helpers ---------------------------------------------------

// Builds an app wired with fakes; pass overrides to swap any dependency.
function makeApp(overrides = {}) {
  // Resolve the deps the plan/usage services build on, so the (real) services
  // can wrap them. Default plan resolution lands on the internal 'licensed'
  // plan → unlimited limits, so existing tests are unaffected; pass `plan:` to
  // makeLicenseManager (or your own planService/usageService) to exercise limits.
  const agentsRepo = overrides.agentsRepo || makeAgentsRepo();
  const testPackagesRepo = overrides.testPackagesRepo || makeTestPackagesRepo();
  const licenseManager = overrides.licenseManager || makeLicenseManager();
  const planService = overrides.planService || createPlanService({ licenseManager });
  const usageService =
    overrides.usageService || createUsageService({ agentsRepo, testPackagesRepo, planService, licenseManager });
  return createApp({
    db: overrides.db || makeDb(),
    locationsRepo: overrides.locationsRepo || makeLocationsRepo(),
    usersRepo: overrides.usersRepo || makeUsersRepo(),
    agentsRepo,
    enrollmentCodesRepo: overrides.enrollmentCodesRepo || makeEnrollmentCodesRepo(),
    enrollmentStore: overrides.enrollmentStore || makeEnrollmentStore(),
    agentTokensRepo: overrides.agentTokensRepo || makeAgentTokensRepo(),
    resultsRepo: overrides.resultsRepo || makeResultsRepo(),
    probeResultsRepo: overrides.probeResultsRepo || makeProbeResultsRepo(),
    incidentsRepo: overrides.incidentsRepo || makeIncidentsRepo(),
    thresholdsRepo: overrides.thresholdsRepo || makeIncidentThresholdsRepo(),
    incidentService: overrides.incidentService || makeIncidentService(),
    licenseManager,
    planService,
    usageService,
    agentCommander: overrides.agentCommander || makeAgentCommander(),
    systemInfo: overrides.systemInfo || makeSystemInfo(),
    findingStore: overrides.findingStore || makeFindingStore(),
    analysisPipeline: overrides.analysisPipeline || makeAnalysisPipeline(),
    probePipeline: overrides.probePipeline || makeProbePipeline(),
    flowPipeline: overrides.flowPipeline || makeFlowPipeline(),
    flowsRepo: overrides.flowsRepo || makeFlowsRepo(),
    geoTileConfig: overrides.geoTileConfig || { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', tileAttribution: 'test', tileMaxZoom: 19 },
    assistant: overrides.assistant || makeAssistant(),
    dispatcher: overrides.dispatcher || makeDispatcher(),
    featureGate: overrides.featureGate || makeFeatureGate(),
    settingsService: overrides.settingsService || makeSettingsService(),
    analysisConfig: overrides.analysisConfig || { analysisEnabled: true, assistantEnabled: false, critSigma: 4, warnSigma: 3, baselineDays: 7, minSamples: 200 },
    retentionConfig: overrides.retentionConfig || { enabled: true, rawRetentionDays: 7, rollupRetentionDays: 90, findingRetentionDays: 365, rollupIntervalMinutes: 60 },
    artifactStore: overrides.artifactStore || makeArtifactStore(),
    agentSourceStore: overrides.agentSourceStore || makeSourceStore(),
    testPackagesRepo,
    testPackageRunner: overrides.testPackageRunner || makeTestPackageRunner(),
    speedtestResultsRepo: overrides.speedtestResultsRepo || makeSpeedtestResultsRepo(),
    releaseStore: overrides.releaseStore || makeReleaseStore(),
    releasePublicKey: overrides.releasePublicKey || '',
    releaseKeyService: overrides.releaseKeyService || makeReleaseKeyService(),
    auditRepo: overrides.auditRepo || makeAuditRepo(),
    integrationsRepo: overrides.integrationsRepo || makeIntegrationsRepo(),
    integrationAuditRepo: overrides.integrationAuditRepo || makeIntegrationAuditRepo(),
    integrationsDispatcher: overrides.integrationsDispatcher || makeIntegrationsDispatcher(),
    connectorRegistry: overrides.connectorRegistry || makeConnectorRegistry(),
    secretBox: overrides.secretBox || makeSecretBox(),
    ldapConfigRepo: overrides.ldapConfigRepo || makeLdapConfigRepo(),
    ldapRoleMapRepo: overrides.ldapRoleMapRepo || makeLdapRoleMapRepo(),
    ldapLoginAuditRepo: overrides.ldapLoginAuditRepo || makeLdapLoginAuditRepo(),
    ldapAuth: overrides.ldapAuth || makeLdapAuth(),
    ldapAuthEnabledFlag: overrides.ldapAuthEnabledFlag || false,
    enrollConfig: overrides.enrollConfig || { publicUrl: '', certFingerprint: '' },
    notifyDashboard: overrides.notifyDashboard || (() => 0),
  });
}

// Fake agent-release signing key service. Configured by default so existing tests
// (which onboard agents / read settings) aren't gated; pass { configured: false } to
// exercise the "no key" gate, or override individual methods.
function makeReleaseKeyService(overrides = {}) {
  const configured = overrides.configured !== undefined ? overrides.configured : true;
  const okStatus = { configured: true, source: 'managed', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 1, fingerprint: 'f'.repeat(64), canSign: true };
  const noStatus = { configured: false, source: null, createdAt: null, createdBy: null, fingerprint: null, canSign: false };
  return {
    load: overrides.load || (async () => {}),
    getPublicKey: overrides.getPublicKey || (() => (configured ? '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----' : '')),
    isConfigured: overrides.isConfigured || (() => configured),
    canSign: overrides.canSign || (() => configured),
    status: overrides.status || (() => (configured ? okStatus : noStatus)),
    generate: overrides.generate || (async () => okStatus),
    remove: overrides.remove || (async () => noStatus),
    sign: overrides.sign || (() => 'ZmFrZS1zaWc='),
  };
}

// Mints a real JWT for the given role (signed with the test secret).
function tokenFor(role, overrides = {}) {
  return issueToken({
    id: overrides.id ?? 1,
    email: overrides.email ?? `${role}@blueeye.local`,
    role,
  });
}

// Convenience: the value for an `Authorization` header.
function authHeader(role, overrides) {
  return `Bearer ${tokenFor(role, overrides)}`;
}

// Helper producing an async function that always rejects — to exercise the
// 500 / error-handler paths.
const throwingAsync = (message = 'simulated database failure') => async () => {
  throw new Error(message);
};

module.exports = {
  makeLocationsRepo,
  makeUsersRepo,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeResultsRepo,
  makeProbeResultsRepo,
  makeIncidentsRepo,
  makeIncidentThresholdsRepo,
  makeIncidentService,
  makeEnrollmentCodesRepo,
  makeEnrollmentStore,
  makeArtifactStore,
  makeSourceStore,
  makeReleaseStore,
  makeReleaseKeyService,
  makeAuditRepo,
  makeTestPackagesRepo,
  makeTestPackageRunner,
  makeSpeedtestResultsRepo,
  makeLicenseManager,
  makeAgentCommander,
  makeSystemInfo,
  makeFindingStore,
  makeAnalysisPipeline,
  makeProbePipeline,
  makeFlowsRepo,
  makeFlowPipeline,
  makeAssistant,
  makeDispatcher,
  makeFeatureGate,
  makeSettingsService,
  makeSecretBox,
  makeConnectorRegistry,
  makeIntegrationsRepo,
  makeIntegrationAuditRepo,
  makeIntegrationsDispatcher,
  makeLdapConfigRepo,
  makeLdapRoleMapRepo,
  makeLdapLoginAuditRepo,
  makeLdapAuth,
  makeDb,
  makeApp,
  tokenFor,
  authHeader,
  throwingAsync,
};
