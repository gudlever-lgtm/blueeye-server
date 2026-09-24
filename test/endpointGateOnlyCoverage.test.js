'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Happy path + auth for the endpoints the fejlscenarie audit
// (docs/audit/fejlscenarie-audit.md §5.2) found reached ONLY by the gate
// sweeps. A sweep proves a route answers 401 without a token and never 500s on
// a bad id; it cannot say whether the route does its job. These do.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAuditLogRepo, makeFeatureGate, makeNis2ControlsRepo, makeNis2IncidentsRepo,
  makeNis2ReportsRepo, makeNis2EvidenceRepo, makeNis2AuditRepo, makeSsoLoginAuditRepo,
  authHeader,
} = require('../test-support/fakes');

const call = (app, method, path, role, body) => {
  let req = request(app)[method](path);
  if (role) req = req.set('Authorization', authHeader(role));
  return body === undefined ? req : req.send(body);
};

const validControl = {
  controlName: 'Quarterly access review', nis2Area: 'Access Control', owner: 'IT',
  frequency: 'quarterly', status: 'OK', evidenceFile: 'https://docs.example/acl-review.pdf',
};

// --------------------------------------------------------- audit-log verify
test('GET /api/audit-log/verify: admin gets the chain verdict; auth, role and licence are enforced', async () => {
  const auditLogRepo = makeAuditLogRepo({ verifyChain: async ({ limit } = {}) => ({ ok: false, checked: 12, brokenAt: 7, limit }) });
  const app = makeApp({ auditLogRepo });
  const res = await call(app, 'get', '/api/audit-log/verify?limit=50', 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false, 'a broken chain is reported, not smoothed over');
  assert.equal(res.body.brokenAt, 7);
  assert.equal(res.body.limit, '50', 'the limit is handed to the repository');

  assert.equal((await call(app, 'get', '/api/audit-log/verify')).status, 401);
  assert.equal((await call(app, 'get', '/api/audit-log/verify', 'operator')).status, 403);
  const unlicensed = makeApp({ auditLogRepo, featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'audit_log' }) });
  const gated = await call(unlicensed, 'get', '/api/audit-log/verify', 'admin');
  assert.equal(gated.status, 403);
  assert.equal(gated.body.error, 'feature_not_available');
});

test('GET /api/audit-log/verify: a repository without chain verification is 503, not a fake "intact"', async () => {
  const auditLogRepo = { ...makeAuditLogRepo(), verifyChain: undefined };
  const res = await call(makeApp({ auditLogRepo }), 'get', '/api/audit-log/verify', 'admin');
  assert.equal(res.status, 503);
});

// ------------------------------------------------------------ NIS2 controls
test('GET/PUT/DELETE /api/nis2/controls/:id: read, update (audited), delete, then 404', async () => {
  const nis2ControlsRepo = makeNis2ControlsRepo();
  const nis2AuditRepo = makeNis2AuditRepo();
  const app = makeApp({ nis2ControlsRepo, nis2AuditRepo });
  const created = (await call(app, 'post', '/api/nis2/controls', 'operator', validControl)).body;

  const got = await call(app, 'get', `/api/nis2/controls/${created.id}`, 'viewer');
  assert.equal(got.status, 200);
  assert.equal(got.body.controlName, validControl.controlName);

  // Writes are operator+; a viewer is refused and nothing changes.
  assert.equal((await call(app, 'put', `/api/nis2/controls/${created.id}`, 'viewer', { ...validControl, status: 'Missing' })).status, 403);
  assert.equal((await call(app, 'delete', `/api/nis2/controls/${created.id}`, 'viewer')).status, 403);
  assert.equal((await call(app, 'get', `/api/nis2/controls/${created.id}`)).status, 401);

  const bad = await call(app, 'put', `/api/nis2/controls/${created.id}`, 'operator', { ...validControl, nis2Area: 'Nope' });
  assert.equal(bad.status, 400);

  const put = await call(app, 'put', `/api/nis2/controls/${created.id}`, 'operator', { ...validControl, status: 'Missing', evidenceFile: '' });
  assert.equal(put.status, 200);
  assert.equal(put.body.status, 'Missing');
  assert.equal(put.body.hasEvidence, false);
  const upd = nis2AuditRepo.rows.find((r) => r.entityType === 'control' && r.action === 'update');
  assert.ok(upd, 'the update is in the NIS2 audit trail');
  assert.equal(upd.oldValue.status, 'OK');

  assert.equal((await call(app, 'delete', `/api/nis2/controls/${created.id}`, 'operator')).status, 204);
  assert.equal((await call(app, 'get', `/api/nis2/controls/${created.id}`, 'viewer')).status, 404);
  assert.equal((await call(app, 'delete', `/api/nis2/controls/${created.id}`, 'operator')).status, 404);
  assert.ok(nis2AuditRepo.rows.some((r) => r.entityType === 'control' && r.action === 'delete'));
});

// ------------------------------------------------------------ NIS2 evidence
test('DELETE /api/nis2/evidence/:id: operator deletes (204, audited), viewer is 403, a second delete is 404', async () => {
  const nis2EvidenceRepo = makeNis2EvidenceRepo();
  const nis2AuditRepo = makeNis2AuditRepo();
  const app = makeApp({ nis2EvidenceRepo, nis2AuditRepo });
  const created = await call(app, 'post', '/api/nis2/evidence', 'operator', { title: 'Pen-test report', fileUrl: 'https://docs.example/pt.pdf' });
  assert.equal(created.status, 201);
  const id = created.body.id;

  assert.equal((await call(app, 'delete', `/api/nis2/evidence/${id}`)).status, 401);
  assert.equal((await call(app, 'delete', `/api/nis2/evidence/${id}`, 'viewer')).status, 403);
  assert.equal(nis2EvidenceRepo.rows.length, 1, 'a refused delete removes nothing');
  assert.equal((await call(app, 'delete', `/api/nis2/evidence/${id}`, 'operator')).status, 204);
  assert.equal(nis2EvidenceRepo.rows.length, 0);
  assert.ok(nis2AuditRepo.rows.some((r) => r.entityType === 'evidence' && r.action === 'delete'));
  assert.equal((await call(app, 'delete', `/api/nis2/evidence/${id}`, 'operator')).status, 404);
});

// ------------------------------------------------------------- NIS2 reports
test('GET/DELETE /api/nis2/reports/:id: read the stored report, delete it (operator), then 404', async () => {
  const nis2ReportsRepo = makeNis2ReportsRepo();
  const app = makeApp({ nis2ReportsRepo });
  const rep = (await call(app, 'post', '/api/nis2/reports', 'operator', { reportType: 'readiness' })).body;

  const got = await call(app, 'get', `/api/nis2/reports/${rep.id}`, 'viewer');
  assert.equal(got.status, 200);
  assert.equal(got.body.reportType, 'readiness');
  assert.equal(got.body.status, 'draft');
  assert.equal((await call(app, 'get', `/api/nis2/reports/${rep.id}`)).status, 401);

  assert.equal((await call(app, 'delete', `/api/nis2/reports/${rep.id}`, 'viewer')).status, 403);
  assert.equal((await call(app, 'delete', `/api/nis2/reports/${rep.id}`, 'operator')).status, 204);
  assert.equal((await call(app, 'get', `/api/nis2/reports/${rep.id}`, 'viewer')).status, 404);
  assert.equal((await call(app, 'delete', `/api/nis2/reports/${rep.id}`, 'operator')).status, 404);
});

// -------------------------------------------------------------- NIS2 exports
test('GET /api/nis2/export/{controls,incidents}.csv: a header row and the stored rows', async () => {
  const nis2ControlsRepo = makeNis2ControlsRepo();
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await nis2ControlsRepo.create(validControl);
  await nis2IncidentsRepo.create({ title: 'Phishing wave', severity: 'high', status: 'investigating', nis2Relevant: true });
  const app = makeApp({ nis2ControlsRepo, nis2IncidentsRepo });

  const controls = await call(app, 'get', '/api/nis2/export/controls.csv', 'viewer');
  assert.equal(controls.status, 200);
  assert.match(controls.headers['content-type'], /text\/csv/);
  assert.match(controls.headers['content-disposition'], /nis2-controls\.csv/);
  assert.match(controls.text, /^id,controlName,nis2Area/);
  assert.match(controls.text, /Quarterly access review/);

  const incidents = await call(app, 'get', '/api/nis2/export/incidents.csv', 'viewer');
  assert.equal(incidents.status, 200);
  assert.match(incidents.headers['content-disposition'], /nis2-incidents\.csv/);
  assert.match(incidents.text, /^id,incidentId,title/);
  assert.match(incidents.text, /Phishing wave/);
});

test('GET /api/nis2/export/{readiness,control,incident}.html: print-ready documents, localised', async () => {
  const nis2ControlsRepo = makeNis2ControlsRepo();
  await nis2ControlsRepo.create(validControl);
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await nis2IncidentsRepo.create({ title: 'Phishing wave', severity: 'high', status: 'investigating', nis2Relevant: true });
  const app = makeApp({ nis2ControlsRepo, nis2IncidentsRepo });

  for (const [doc, needle] of [['readiness', null], ['control', 'Quarterly access review'], ['incident', 'Phishing wave']]) {
    const res = await call(app, 'get', `/api/nis2/export/${doc}.html?org=Acme`, 'viewer');
    assert.equal(res.status, 200, doc);
    assert.match(res.headers['content-type'], /text\/html/, doc);
    assert.match(res.text, /<!DOCTYPE html>/i, doc);
    assert.match(res.text, /Acme/, `${doc} names the organisation`);
    if (needle) assert.ok(res.text.includes(needle), `${doc} lists the stored row`);
    const da = await call(app, 'get', `/api/nis2/export/${doc}.html?locale=da`, 'viewer');
    assert.equal(da.status, 200, `${doc} da`);
    assert.match(da.text, /<html lang="da/, `${doc} renders in Danish on request`);
  }
});

test('NIS2 exports: 401 without a token, 403 when the compliance pack is not licensed', async () => {
  const paths = ['controls.csv', 'incidents.csv', 'readiness.html', 'control.html', 'incident.html'].map((p) => `/api/nis2/export/${p}`);
  const app = makeApp();
  const unlicensed = makeApp({ featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'reports_compliance' }) });
  for (const p of paths) {
    assert.equal((await call(app, 'get', p)).status, 401, p);
    const res = await call(unlicensed, 'get', p, 'admin');
    assert.equal(res.status, 403, p);
    assert.equal(res.body.error, 'feature_not_available', p);
  }
});

// ----------------------------------------------------------------- NIS2 meta
test('GET /api/nis2/meta: the category vocabulary for every reader, 401 without a token', async () => {
  const app = makeApp();
  const res = await call(app, 'get', '/api/nis2/meta', 'viewer');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.categories));
  assert.ok(res.body.categories.includes('Access Control'));
  assert.equal((await call(app, 'get', '/api/nis2/meta')).status, 401);
});

// ------------------------------------------------------- SSO login audits
test('GET /api/{oidc,saml}/login-audit: admin-only, each provider sees only its own attempts', async () => {
  const ssoLoginAuditRepo = makeSsoLoginAuditRepo();
  await ssoLoginAuditRepo.record({ provider: 'oidc', email: 'a@example.org', outcome: 'success' });
  await ssoLoginAuditRepo.record({ provider: 'saml', email: 'b@example.org', outcome: 'failure' });
  await ssoLoginAuditRepo.record({ provider: 'ldap', email: 'c@example.org', outcome: 'success' });
  const app = makeApp({ ssoLoginAuditRepo });
  for (const [p, email] of [['oidc', 'a@example.org'], ['saml', 'b@example.org']]) {
    const res = await call(app, 'get', `/api/${p}/login-audit?limit=5000`, 'admin');
    assert.equal(res.status, 200, p);
    assert.deepEqual(res.body.map((r) => r.email), [email], `${p} sees only its own rows`);
    assert.equal((await call(app, 'get', `/api/${p}/login-audit`)).status, 401, p);
    for (const role of ['viewer', 'operator']) {
      assert.equal((await call(app, 'get', `/api/${p}/login-audit`, role)).status, 403, `${p} ${role}`);
    }
  }
});

test('GET /api/{oidc,saml}/login-audit: the limit is clamped to 1..500 before it reaches the repository', async () => {
  const seen = [];
  const ssoLoginAuditRepo = { record: async () => 1, findAll: async (q) => { seen.push(q); return []; } };
  const app = makeApp({ ssoLoginAuditRepo });
  for (const limit of ['5000', '0', 'abc']) {
    assert.equal((await call(app, 'get', `/api/oidc/login-audit?limit=${limit}`, 'admin')).status, 200);
  }
  assert.deepEqual(seen.map((q) => q.limit), [500, 1, 100]);
  assert.ok(seen.every((q) => q.provider === 'oidc'));
});

// ------------------------------------------------------------ settings/geoip
test('PUT /api/settings/geoip: admin stores the override and gets the effective status back; 400 on a bad path', async () => {
  const app = makeApp();
  const res = await call(app, 'put', '/api/settings/geoip', 'admin', { dbPath: '/data/geoip.csv', autoUpdate: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.geoip.dbPath, '/data/geoip.csv');
  assert.equal(res.body.geoip.source, 'settings');
  assert.equal(res.body.geoip.autoUpdate, true);
  assert.equal(res.body.geoip.ranges, 0, 'an unloadable path reports zero ranges rather than failing silently');

  const bad = await call(app, 'put', '/api/settings/geoip', 'admin', { dbPath: 'x'.repeat(1025) });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.dbPath);
  const badCity = await call(app, 'put', '/api/settings/geoip', 'admin', { cityDbPath: 'x'.repeat(1025) });
  assert.equal(badCity.status, 400);
  assert.ok(badCity.body.details.cityDbPath);

  assert.equal((await call(app, 'put', '/api/settings/geoip', 'operator', { autoUpdate: false })).status, 403);
  assert.equal((await call(app, 'put', '/api/settings/geoip', null, { autoUpdate: false })).status, 401);
});

test('POST/GET /api/settings/geoip/update: 503/unavailable without an updater; with one, 202 + the job status', async () => {
  const none = makeApp();
  assert.equal((await call(none, 'post', '/api/settings/geoip/update', 'admin', {})).status, 503);
  const idle = await call(none, 'get', '/api/settings/geoip/update', 'viewer');
  assert.equal(idle.status, 200);
  assert.deepEqual(idle.body, { update: { state: 'unavailable' } });

  const triggered = [];
  const geoipUpdater = {
    trigger: (opts) => { triggered.push(opts); return { state: 'running', startedAt: '2026-09-01T00:00:00.000Z' }; },
    status: () => ({ state: 'ok', month: '2026-09', ranges: 1234 }),
  };
  const app = makeApp({ geoipUpdater });
  const full = await call(app, 'post', '/api/settings/geoip/update', 'admin', {});
  assert.equal(full.status, 202);
  assert.equal(full.body.update.state, 'running');
  const countryOnly = await call(app, 'post', '/api/settings/geoip/update', 'admin', { countryOnly: true });
  assert.equal(countryOnly.status, 202);
  assert.deepEqual(triggered, [{ includeAsn: true }, { includeAsn: false }]);
  // includeCity overrides the Settings toggle for one run; anything but a boolean is ignored.
  await call(app, 'post', '/api/settings/geoip/update', 'admin', { includeCity: false });
  await call(app, 'post', '/api/settings/geoip/update', 'admin', { includeCity: 'yes' });
  assert.deepEqual(triggered.slice(2), [{ includeAsn: true, includeCity: false }, { includeAsn: true }]);
  triggered.length = 2;

  const st = await call(app, 'get', '/api/settings/geoip/update', 'viewer');
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.update, { state: 'ok', month: '2026-09', ranges: 1234 });

  // Triggering a download is admin-only; reading its status is viewer+.
  assert.equal((await call(app, 'post', '/api/settings/geoip/update', 'operator', {})).status, 403);
  assert.equal(triggered.length, 2, 'a refused trigger starts nothing');
  assert.equal((await call(app, 'get', '/api/settings/geoip/update')).status, 401);
});

// ------------------------------------------------- flow-baseline recompute
test('POST /api/topology/flow-baselines/recompute: operator runs the job; 503 without one; viewer 403', async () => {
  assert.equal((await call(makeApp(), 'post', '/api/topology/flow-baselines/recompute', 'operator', {})).status, 503);

  let runs = 0;
  const flowPairBaselineJob = { run: async () => { runs += 1; return { pairs: 42, durationMs: 7 }; } };
  const app = makeApp({ flowPairBaselineJob });
  const res = await call(app, 'post', '/api/topology/flow-baselines/recompute', 'operator', {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, pairs: 42, durationMs: 7 });
  assert.equal(runs, 1);

  assert.equal((await call(app, 'post', '/api/topology/flow-baselines/recompute', 'viewer', {})).status, 403);
  assert.equal((await call(app, 'post', '/api/topology/flow-baselines/recompute', null, {})).status, 401);
  assert.equal(runs, 1, 'a refused request runs nothing');
});
