'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// "A repository throws" for one representative endpoint of every router the
// fejlscenarie audit (docs/audit/fejlscenarie-audit.md §5.2) found without a
// 500 assertion. The contract is the gate's (test/gate/security.test.js): in
// production a failure is `{ error: 'Internal Server Error' }` and NOTHING of
// the underlying error — no SQL, no host, no port — reaches the response.
//
// Two routers are best-effort by design (the Overview panel and the setup
// checklist): a failing source drops a widget or a row instead of the page.
// For those the contract pinned here is "200, degraded, and still no detail".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeApiTokensRepo, makeAuditLogRepo, makeResultsRepo,
  makeSettingsService, makeSsoRoleMapRepo, makeReportSchedulesRepo, makeSeverityRulesRepo,
  makeSpeedtestResultsRepo, makeProbeThresholdsRepo, makeProbeOutagesRepo, makeEventCasesRepo,
  makeFindingStore, makeSnmpDevicesRepo, makeLocationsRepo, makeIntegrationsRepo, makeOidcAuth,
  makeReleaseStore, makeNis2ControlsRepo, makeNis2IncidentsRepo, makeNis2ReportsRepo,
  makeNis2EvidenceRepo, makeNis2RisksRepo, FAKE_RELEASE_KEYPAIR, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { canonicalize } = require('../src/lib/canonicalize');
const { createSettingsService } = require('../src/services/settings');

// What a real mysql2 failure looks like: the statement, the host and the port.
const SECRET = 'SELECT * FROM t failed: ECONNREFUSED 10.0.0.5:3306';
const LEAKS = ['SELECT', 'ECONNREFUSED', '10.0.0.5', '3306'];
const boom = throwingAsync(SECRET);
const boomSync = () => { throw new Error(SECRET); };

function send(app, method, path, role, body, contentType) {
  let req = request(app)[method](path).set('Authorization', authHeader(role));
  if (contentType) req = req.set('Content-Type', contentType);
  return body === undefined ? req : req.send(body);
}

// Asserts the production 500 contract. NODE_ENV only changes what the error
// handler writes, so it is flipped around the request, as the gate does.
async function expectGeneric500(app, method, path, role = 'admin', body, contentType) {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await send(app, method, path, role, body, contentType);
    assert.equal(res.status, 500, `${method.toUpperCase()} ${path} → ${res.status} ${res.text}`);
    assert.deepEqual(res.body, { error: 'Internal Server Error' }, `${path} leaks detail`);
    for (const s of LEAKS) assert.ok(!res.text.includes(s), `${path} leaks "${s}"`);
    return res;
  } finally {
    process.env.NODE_ENV = prev;
  }
}

function assertNoLeak(res, path) {
  for (const s of LEAKS) assert.ok(!res.text.includes(s), `${path} leaks "${s}"`);
}

// ------------------------------------------------------------ agents/releases
test('POST /agents/releases: a release store that cannot write is a generic 500', async () => {
  const tarball = Buffer.from('fake-gzip-agent-bytes');
  const manifest = { version: '9.9.9', sha256: crypto.createHash('sha256').update(tarball).digest('hex'), size: tarball.length };
  const signature = crypto.sign(null, Buffer.from(canonicalize(manifest)), FAKE_RELEASE_KEYPAIR.privateKey).toString('base64');
  const app = makeApp({ releaseStore: makeReleaseStore({ add: boomSync }) });
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await request(app).post('/agents/releases').set('Authorization', authHeader('admin'))
      .set('Content-Type', 'application/octet-stream')
      .set('X-Release-Version', manifest.version)
      .set('X-Release-Signature', signature)
      .set('X-Release-Manifest', Buffer.from(JSON.stringify(manifest)).toString('base64'))
      .send(tarball);
    assert.equal(res.status, 500, res.text);
    assert.deepEqual(res.body, { error: 'Internal Server Error' });
    assertNoLeak(res, '/agents/releases');
  } finally {
    process.env.NODE_ENV = prev;
  }
});

// ---------------------------------------------------------- simple read paths
test('api tokens, audit-log verify, oidc/saml role maps, report schedules, severity rules, thresholds: generic 500', async () => {
  const cases = [
    [{ apiTokensRepo: makeApiTokensRepo({ findAll: boom }) }, 'get', '/api/api-tokens'],
    [{ auditLogRepo: makeAuditLogRepo({ verifyChain: boom }) }, 'get', '/api/audit-log/verify'],
    [{ oidcRoleMapRepo: makeSsoRoleMapRepo({ findAll: boom }) }, 'get', '/api/oidc/role-map'],
    [{ samlRoleMapRepo: makeSsoRoleMapRepo({ findAll: boom }) }, 'get', '/api/saml/role-map'],
    [{ reportSchedulesRepo: makeReportSchedulesRepo({ findAll: boom }) }, 'get', '/api/report-schedules'],
    [{ severityRulesRepo: { ...makeSeverityRulesRepo(), list: boom } }, 'get', '/api/severity-rules'],
    [{ thresholdsRepo: makeProbeThresholdsRepo({ listGlobal: boom }) }, 'get', '/api/thresholds'],
  ];
  for (const [deps, method, path] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await expectGeneric500(makeApp(deps), method, path);
  }
});

test('oidc/saml login-audit: a failing audit repository is a generic 500', async () => {
  const ssoLoginAuditRepo = { record: async () => 1, findAll: boom };
  for (const p of ['oidc', 'saml']) {
    // eslint-disable-next-line no-await-in-loop
    await expectGeneric500(makeApp({ ssoLoginAuditRepo }), 'get', `/api/${p}/login-audit`);
  }
});

// ------------------------------------------------------------ connection test
test('POST /api/connection-test/run: an agent lookup that fails is a generic 500 (nothing dispatched)', async () => {
  const sent = [];
  const agentCommander = { sendCommand: (id, c) => { sent.push(c); return 1; }, isConnected: () => true };
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findById: boom }), agentCommander });
  await expectGeneric500(app, 'post', '/api/connection-test/run', 'operator', { agentId: 1, host: 'example.org', checks: ['ping'] });
  assert.deepEqual(sent, []);
});

// --------------------------------------------------------------- forecast
test('GET /api/forecast/interfaces: a results store that fails is a generic 500', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 1, hostname: 'be-1' }) }),
    resultsRepo: makeResultsRepo({ findByAgentId: boom }),
  });
  await expectGeneric500(app, 'get', '/api/forecast/interfaces?agentId=1', 'viewer');
});

// ------------------------------------------------------- map / geocode / settings
test('map config, geocoder and settings: a settings store that fails is a generic 500', async () => {
  const failing = { ...makeSettingsService(), getMap: boom, getAnalysis: boom };
  const app = makeApp({ settingsService: failing });
  await expectGeneric500(app, 'get', '/api/map/config', 'viewer');
  await expectGeneric500(app, 'get', '/api/geocode/search?q=Aarhus', 'viewer');
  await expectGeneric500(app, 'get', '/api/settings');
});

test('PUT /api/settings/geoip: a settings write that fails is a generic 500 (not the 400 path)', async () => {
  const settingsService = createSettingsService({
    settingsRepo: { get: async () => null, set: boom },
    config: { geo: { tileUrl: '', tileAttribution: '', tileMaxZoom: 19, geocodeUrl: '' } },
  });
  await expectGeneric500(makeApp({ settingsService }), 'put', '/api/settings/geoip', 'admin', { autoUpdate: true });
});

test('geocoder unreachable is 502 and does not echo the fetch error', async () => {
  const app = makeApp({ geocodeFetch: boom });
  const res = await send(app, 'get', '/api/geocode/search?q=Aarhus', 'viewer');
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'Geocoder unreachable' });
});

// ---------------------------------------------------------------- license
test('GET /license/usage: a usage count that fails is a generic 500', async () => {
  const usageService = { getUsage: boom, assertWithinLimit: async () => ({ ok: true }) };
  await expectGeneric500(makeApp({ usageService }), 'get', '/license/usage', 'viewer');
});

// ------------------------------------------------------------------- logs
test('GET /api/logs: a log ring that throws is a generic 500', async () => {
  const logRing = { list: boomSync, record: () => {}, size: 0, capacity: 100 };
  await expectGeneric500(makeApp({ logRing }), 'get', '/api/logs');
});

// -------------------------------------------------------------- speedtest
test('GET /api/speedtest: a results read that fails is a generic 500', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 1 }) }),
    speedtestResultsRepo: makeSpeedtestResultsRepo({ findByAgent: boom }),
  });
  await expectGeneric500(app, 'get', '/api/speedtest?agentId=1', 'viewer');
});

// ------------------------------------------------------------ diagnostics
test('diagnostics: a failing config source degrades the catalogue; a failing auth service is a generic 500', async () => {
  // Best-effort: an unreadable integrations table drops those rows only.
  const degraded = await send(makeApp({ integrationsRepo: makeIntegrationsRepo({ findAll: boom }) }), 'get', '/api/diagnostics/targets', 'admin');
  assert.equal(degraded.status, 200);
  assert.ok(degraded.body.targets.every((t) => !String(t.id).startsWith('integration:')));
  assertNoLeak(degraded, '/api/diagnostics/targets');
  // …but a service read outside the best-effort wrapper fails the request cleanly.
  await expectGeneric500(makeApp({ oidcAuth: makeOidcAuth({ status: boomSync }) }), 'get', '/api/diagnostics/targets');
});

// ---------------------------------------------------- best-effort by design
test('GET /api/dashboard/advanced: failing sources drop their widgets (200), never a 500 or a leak', async () => {
  const app = makeApp({
    probeOutagesRepo: makeProbeOutagesRepo({ list: boom }),
    eventCasesRepo: makeEventCasesRepo({ list: boom }),
    findingStore: makeFindingStore({ list: boom }),
  });
  const res = await send(app, 'get', '/api/dashboard/advanced', 'viewer');
  assert.equal(res.status, 200, res.text);
  assertNoLeak(res, '/api/dashboard/advanced');
});

test('GET /api/setup/checklist: failing sources make rows unknown (200), never a 500 or a leak', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: boom }),
    snmpDevicesRepo: makeSnmpDevicesRepo({ list: boom }),
    locationsRepo: makeLocationsRepo({ findAll: boom }),
  });
  const res = await send(app, 'get', '/api/setup/checklist', 'admin');
  assert.equal(res.status, 200, res.text);
  assertNoLeak(res, '/api/setup/checklist');
});

// ------------------------------------------------------------------- NIS2
test('NIS2 controls, incidents, reports, evidence and the dashboard: generic 500 on a failing register', async () => {
  const incidents = makeNis2IncidentsRepo({ update: boom });
  const created = await incidents.create({ title: 'x', severity: 'low', status: 'open' });
  const cases = [
    [{ nis2ControlsRepo: makeNis2ControlsRepo({ findById: boom }) }, 'get', '/api/nis2/controls/1', 'viewer'],
    [{ nis2ControlsRepo: makeNis2ControlsRepo({ findAll: boom }) }, 'get', '/api/nis2/export/controls.csv', 'viewer'],
    [{ nis2IncidentsRepo: incidents }, 'put', `/api/nis2/incidents/${created.id}`, 'operator',
      { title: 'Phishing wave', severity: 'high', status: 'investigating' }],
    [{ nis2IncidentsRepo: makeNis2IncidentsRepo({ findAll: boom }) }, 'get', '/api/nis2/export/incidents.csv', 'viewer'],
    [{ nis2ReportsRepo: makeNis2ReportsRepo({ findAll: boom }) }, 'get', '/api/nis2/reports', 'viewer'],
    [{ nis2ReportsRepo: makeNis2ReportsRepo({ findById: boom }) }, 'post', '/api/nis2/reports/1/approve', 'admin', {}],
    [{ nis2EvidenceRepo: makeNis2EvidenceRepo({ findAll: boom }) }, 'get', '/api/nis2/evidence', 'viewer'],
    [{ nis2EvidenceRepo: makeNis2EvidenceRepo({ findById: boom }) }, 'delete', '/api/nis2/evidence/1', 'operator'],
    // meta.js: the readiness dashboard reads all three registers.
    [{ nis2RisksRepo: makeNis2RisksRepo({ findAll: boom }) }, 'get', '/api/nis2/dashboard', 'viewer'],
    [{ nis2RisksRepo: makeNis2RisksRepo({ findAll: boom }) }, 'get', '/api/nis2/export/readiness.html', 'viewer'],
  ];
  for (const [deps, method, path, role, body] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await expectGeneric500(makeApp(deps), method, path, role, body);
  }
});
