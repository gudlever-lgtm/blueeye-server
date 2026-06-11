'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../test-support/fakes');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');
const { FEATURE_CATALOG, ROADMAP_FEATURE_KEYS } = require('../src/license/plans');

// ---- feature matrix carries availability status ----------------------------

test('GET /license/matrix marks each feature available|roadmap', async () => {
  const res = await request(makeApp()).get('/license/matrix').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const byKey = Object.fromEntries(res.body.features.map((f) => [f.key, f.status]));
  assert.equal(byKey.sso_oidc, 'roadmap');
  assert.equal(byKey.sso_saml, 'roadmap');
  assert.equal(byKey.ha_deployment, 'roadmap');
  assert.equal(byKey.msp_multitenant, 'roadmap');
  assert.equal(byKey.dashboard_advanced, 'roadmap');
  // The finished ones are available.
  assert.equal(byKey.audit_log, 'available');
  assert.equal(byKey.api_access, 'available');
  assert.equal(byKey.reports_compliance, 'available');
  assert.equal(byKey.sso_ldap, 'available');
  assert.equal(byKey.security_pack, 'available');
});

test('catalogue exposes exactly the five roadmap keys', () => {
  assert.deepEqual(
    [...ROADMAP_FEATURE_KEYS].sort(),
    ['dashboard_advanced', 'ha_deployment', 'msp_multitenant', 'sso_oidc', 'sso_saml'].sort()
  );
  // Every catalogue entry has a known status.
  for (const meta of Object.values(FEATURE_CATALOG)) {
    assert.ok(meta.status === 'available' || meta.status === 'roadmap');
  }
});

// ---- RBAC gating on user administration ------------------------------------
// Reads stay open (admin); the mutations are the gated "manage users/roles".

test('creating a user is gated by rbac (403 when not licensed)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'rbac' });
  const res = await request(makeApp({ featureGate })).post('/users')
    .set('Authorization', authHeader('admin')).send({ email: 'x@example.com', password: 'sup3rsecret!', role: 'viewer' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'feature_not_available');
  assert.equal(res.body.feature, 'rbac');
});

test('listing users stays readable for an admin without rbac', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'rbac' });
  const res = await request(makeApp({ featureGate })).get('/users').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200); // read is admin-only but not licence-gated
});

test('creating a user works when rbac is licensed (default)', async () => {
  const res = await request(makeApp()).post('/users')
    .set('Authorization', authHeader('admin')).send({ email: 'new2@example.com', password: 'sup3rsecret!', role: 'viewer' });
  assert.equal(res.status, 201);
});

// ---- Compliance report pack gating (NIS2 exports) --------------------------

test('NIS2 report export is gated by reports_compliance (403)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'reports_compliance' });
  const res = await request(makeApp({ featureGate })).get('/api/nis2/export/risks.csv').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'feature_not_available');
});

test('NIS2 report export works when reports_compliance is licensed (default)', async () => {
  const res = await request(makeApp()).get('/api/nis2/export/risks.csv').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
});

test('NIS2 register reads stay open regardless of reports_compliance', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'reports_compliance' });
  const res = await request(makeApp({ featureGate })).get('/api/nis2/risks').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200); // the register itself is part of the module, not the gated "pack"
});

// ---- per-channel alert licensing (dispatcher unit) -------------------------

test('dispatcher skips a channel that is not licensed', async () => {
  const sent = [];
  const channel = (name) => ({ send: async () => { sent.push(name); return { ok: true }; } });
  const dispatcher = createDispatcher({
    config: { enabled: true, cooldownMs: 0, channels: { email: { enabled: true, minSeverity: 'INFO' }, webhook: { enabled: true, minSeverity: 'INFO' } } },
    channels: { email: channel('email'), webhook: channel('webhook') },
    licensed: () => true,
    channelLicensed: (name) => name === 'email', // webhook not licensed
  });
  const out = await dispatcher.dispatch({ hostId: 'h', metric: 'm', kind: 'K', severity: 'CRIT' }, null);
  assert.deepEqual(sent, ['email']);
  const webhook = out.results.find((r) => r.channel === 'webhook');
  assert.equal(webhook.skipped, true);
  assert.match(webhook.detail, /not licensed/);
});
