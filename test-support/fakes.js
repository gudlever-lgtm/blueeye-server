'use strict';

// Safety net: make sure a JWT secret exists before the app/config is loaded,
// in case a test file forgets to set one. Individual test files still set
// these at their very top to be explicit.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';

const { createApp } = require('../src/app');
const { issueToken } = require('../src/auth/jwt');
const { createSettingsService } = require('../src/services/settings');

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
  };
}

// A fake enrollment-codes repository.
function makeEnrollmentCodesRepo(overrides = {}) {
  return {
    create:
      overrides.create ||
      (async ({ code, location_id, created_by }) => ({
        id: 1,
        code,
        location_id: location_id ?? null,
        created_by,
        expires_at: '2026-01-01T01:00:00.000Z',
        used_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      })),
    findAll: overrides.findAll || (async () => []),
    remove: overrides.remove || (async () => false),
  };
}

// A fake enrollment store (the atomic claim-and-enroll operation).
function makeEnrollmentStore(overrides = {}) {
  return {
    claimAndEnroll:
      overrides.claimAndEnroll || (async () => ({ status: 'ok', agentId: 1 })),
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
// "delivered to 1 connection".
function makeAgentCommander(overrides = {}) {
  return {
    sendCommand: overrides.sendCommand || (() => 1),
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
  const status = () => ({ status: 'valid', licensed: true, maxAgents: 1000, serverId: 'test-server' });
  return {
    isLicensed: overrides.isLicensed || (() => true),
    getMaxAgents: overrides.getMaxAgents || (() => 1000),
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
  return {
    isEnabled: overrides.isEnabled || (() => Boolean(overrides.explain)),
    explain:
      overrides.explain ||
      (async () => {
        const e = new Error('AI-assistenten er slået fra');
        e.name = 'FeatureDisabled';
        throw e;
      }),
  };
}

// ---- App + auth helpers ---------------------------------------------------

// Builds an app wired with fakes; pass overrides to swap any dependency.
function makeApp(overrides = {}) {
  return createApp({
    db: overrides.db || makeDb(),
    locationsRepo: overrides.locationsRepo || makeLocationsRepo(),
    usersRepo: overrides.usersRepo || makeUsersRepo(),
    agentsRepo: overrides.agentsRepo || makeAgentsRepo(),
    enrollmentCodesRepo: overrides.enrollmentCodesRepo || makeEnrollmentCodesRepo(),
    enrollmentStore: overrides.enrollmentStore || makeEnrollmentStore(),
    agentTokensRepo: overrides.agentTokensRepo || makeAgentTokensRepo(),
    resultsRepo: overrides.resultsRepo || makeResultsRepo(),
    probeResultsRepo: overrides.probeResultsRepo || makeProbeResultsRepo(),
    licenseManager: overrides.licenseManager || makeLicenseManager(),
    agentCommander: overrides.agentCommander || makeAgentCommander(),
    systemInfo: overrides.systemInfo || makeSystemInfo(),
    findingStore: overrides.findingStore || makeFindingStore(),
    analysisPipeline: overrides.analysisPipeline || makeAnalysisPipeline(),
    flowPipeline: overrides.flowPipeline || makeFlowPipeline(),
    flowsRepo: overrides.flowsRepo || makeFlowsRepo(),
    geoTileConfig: overrides.geoTileConfig || { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', tileAttribution: 'test', tileMaxZoom: 19 },
    assistant: overrides.assistant || makeAssistant(),
    dispatcher: overrides.dispatcher || makeDispatcher(),
    featureGate: overrides.featureGate || makeFeatureGate(),
    settingsService: overrides.settingsService || makeSettingsService(),
    analysisConfig: overrides.analysisConfig || { analysisEnabled: true, assistantEnabled: false, critSigma: 4, warnSigma: 3, baselineDays: 7, minSamples: 200 },
    retentionConfig: overrides.retentionConfig || { enabled: true, rawRetentionDays: 7, rollupRetentionDays: 90, findingRetentionDays: 365, rollupIntervalMinutes: 60 },
  });
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
  makeEnrollmentCodesRepo,
  makeEnrollmentStore,
  makeLicenseManager,
  makeAgentCommander,
  makeSystemInfo,
  makeFindingStore,
  makeAnalysisPipeline,
  makeFlowsRepo,
  makeFlowPipeline,
  makeAssistant,
  makeDispatcher,
  makeFeatureGate,
  makeSettingsService,
  makeDb,
  makeApp,
  tokenFor,
  authHeader,
  throwingAsync,
};
