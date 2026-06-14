'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, authHeader,
  makeIntegrationsRepo, makeIntegrationsDispatcher,
  makeSamlAuth, makeLdapConfigRepo, makeLdapAuth, makeAssistant,
} = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');

test('GET /api/diagnostics/targets returns the grouped catalogue (admin)', async () => {
  const res = await request(makeApp()).get('/api/diagnostics/targets').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.groups));
  assert.ok(Array.isArray(res.body.targets));
  const ids = res.body.targets.map((t) => t.id);
  for (const id of ['alert:email', 'alert:webhook', 'alert:syslog', 'ldap', 'oidc', 'saml', 'assistant', 'map', 'license']) {
    assert.ok(ids.includes(id), `missing target ${id}`);
  }
  // Every target carries a posture + an explainable security check list.
  for (const t of res.body.targets) {
    assert.ok(['ok', 'info', 'warn', 'bad'].includes(t.posture));
    assert.ok(Array.isArray(t.security));
  }
  assert.equal(res.body.summary.total, res.body.targets.length);
});

test('GET /api/diagnostics/targets lists configured ITSM/IPAM receivers', async () => {
  const integrationsRepo = makeIntegrationsRepo({
    findAll: async () => [{ id: 7, type: 'servicenow', name: 'SN prod', base_url: 'http://sn.example', auth_type: 'none', enabled: true }],
  });
  const res = await request(makeApp({ integrationsRepo })).get('/api/diagnostics/targets').set('Authorization', admin());
  assert.equal(res.status, 200);
  const sn = res.body.targets.find((t) => t.id === 'integration:7');
  assert.ok(sn, 'integration target present');
  assert.equal(sn.category, 'itsm');
  // Plaintext HTTP + no auth on an ITSM target → flagged bad by the posture screen.
  assert.equal(sn.posture, 'bad');
});

test('targets/run require auth and admin role', async () => {
  assert.equal((await request(makeApp()).get('/api/diagnostics/targets')).status, 401);
  assert.equal((await request(makeApp()).get('/api/diagnostics/targets').set('Authorization', viewer())).status, 403);
  assert.equal((await request(makeApp()).post('/api/diagnostics/run').set('Authorization', viewer()).send({})).status, 403);
});

test('POST /api/diagnostics/run with no body screens everything', async () => {
  const res = await request(makeApp()).post('/api/diagnostics/run').set('Authorization', admin()).send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.ran >= 9);
  assert.equal(res.body.summary.total, res.body.ran);
  for (const t of res.body.targets) assert.ok(t.result && ['ok', 'info', 'warn', 'bad'].includes(t.result.severity));
});

test('POST /api/diagnostics/run can target a single channel and reports the live result', async () => {
  const res = await request(makeApp()).post('/api/diagnostics/run').set('Authorization', admin()).send({ targets: ['alert:email'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.ran, 1);
  const t = res.body.targets[0];
  assert.equal(t.id, 'alert:email');
  assert.equal(t.result.ran, true);
  assert.equal(t.result.ok, true); // fake alerting dispatcher.test → ok
});

test('POST /api/diagnostics/run fires the integration test for an ITSM target', async () => {
  const integrationsRepo = makeIntegrationsRepo({
    findAll: async () => [{ id: 3, type: 'nautobot', name: 'NB', base_url: 'https://nb.example', auth_type: 'token', enabled: true }],
  });
  const calls = [];
  const integrationsDispatcher = makeIntegrationsDispatcher({
    testFire: async (id, actor) => { calls.push({ id, actor }); return { ok: true, status: 200, detail: 'ok' }; },
  });
  const res = await request(makeApp({ integrationsRepo, integrationsDispatcher }))
    .post('/api/diagnostics/run').set('Authorization', admin()).send({ targets: ['integration:3'] });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 3);
  assert.equal(calls[0].actor.role, 'admin'); // the acting admin is passed through for the audit trail
  assert.equal(res.body.targets[0].result.ok, true);
});

test('run merges posture with connectivity: a reachable-but-insecure target is still flagged', async () => {
  // SAML IdP over plaintext HTTP — reachable (fake fetch 200) but posture bad.
  const samlAuth = makeSamlAuth({
    status: () => ({ configured: true, enabled: true, entryPoint: 'http://idp.example/sso', idpCertSet: true }),
  });
  const res = await request(makeApp({ samlAuth })).post('/api/diagnostics/run').set('Authorization', admin()).send({ targets: ['saml'] });
  assert.equal(res.status, 200);
  const t = res.body.targets[0];
  assert.equal(t.result.ran, true);
  assert.equal(t.result.ok, true); // reachable
  assert.equal(t.result.severity, 'bad'); // …but plaintext → overall bad
});

test('run reports an unreachable endpoint when the probe fails', async () => {
  const samlAuth = makeSamlAuth({
    status: () => ({ configured: true, enabled: true, entryPoint: 'https://idp.example/sso', idpCertSet: true }),
  });
  const diagnosticsFetch = async () => { throw new Error('ECONNREFUSED'); };
  const res = await request(makeApp({ samlAuth, diagnosticsFetch }))
    .post('/api/diagnostics/run').set('Authorization', admin()).send({ targets: ['saml'] });
  assert.equal(res.status, 200);
  const t = res.body.targets[0];
  assert.equal(t.result.ok, false);
  assert.equal(t.result.severity, 'bad');
});

test('run executes the LDAP connectivity test when a directory is configured', async () => {
  const ldapConfigRepo = makeLdapConfigRepo({ row: { id: 1, host: 'dir.example', port: 636, use_tls: true, base_dn: 'dc=x', enabled: true } });
  const ldapAuth = makeLdapAuth({ testConnection: async () => ({ ok: true, detail: 'bound to ldaps://dir.example:636' }) });
  const res = await request(makeApp({ ldapConfigRepo, ldapAuth }))
    .post('/api/diagnostics/run').set('Authorization', admin()).send({ targets: ['ldap'] });
  assert.equal(res.status, 200);
  const t = res.body.targets[0];
  assert.equal(t.result.ran, true);
  assert.equal(t.result.ok, true);
  assert.equal(t.result.severity, 'ok');
});

test('the assistant is only runnable once configured/enabled (no probe for an off feature)', async () => {
  // Default fake assistant: disabled + no API key → screened, but NOT runnable,
  // so a full run never emits outbound traffic to the provider.
  const off = await request(makeApp()).get('/api/diagnostics/targets').set('Authorization', admin());
  const a1 = off.body.targets.find((t) => t.id === 'assistant');
  assert.equal(a1.runnable, false);

  // With an API key configured → runnable.
  const assistant = makeAssistant({ status: () => ({ enabled: false, configured: true, baseUrl: 'https://api.mistral.ai/v1/x', model: 'm' }) });
  const on = await request(makeApp({ assistant })).get('/api/diagnostics/targets').set('Authorization', admin());
  const a2 = on.body.targets.find((t) => t.id === 'assistant');
  assert.equal(a2.runnable, true);
});

test('POST /api/diagnostics/run validates the targets payload', async () => {
  const notArray = await request(makeApp()).post('/api/diagnostics/run').set('Authorization', admin()).send({ targets: 'alert:email' });
  assert.equal(notArray.status, 400);

  const noMatch = await request(makeApp()).post('/api/diagnostics/run').set('Authorization', admin()).send({ targets: ['does-not-exist'] });
  assert.equal(noMatch.status, 400);
});

test('the screening never leaks a secret-looking field', async () => {
  const res = await request(makeApp()).post('/api/diagnostics/run').set('Authorization', admin()).send({});
  const body = JSON.stringify(res.body).toLowerCase();
  assert.ok(!body.includes('password'));
  assert.ok(!body.includes('credentials_encrypted'));
  assert.ok(!body.includes('apikey'));
});
