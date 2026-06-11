'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createSamlAuth } = require('../src/auth/saml');
const { makeApp, makeSamlAuth, makeSsoRoleMapRepo, makeSsoLoginAuditRepo, makeUsersRepo, makeFeatureGate, authHeader } = require('../test-support/fakes');
const { TEST_CERT, buildSignedResponse } = require('../test-support/samlTestkit');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');
const unlicensed = () => makeFeatureGate({ isFeatureEnabled: () => false });

const samlConfig = {
  authEnabled: true, entryPoint: 'https://idp.example/sso', spEntityId: 'blueeye-sp',
  audience: 'blueeye-sp', idpEntityId: 'https://idp.example', idpCert: TEST_CERT,
  callbackUrl: 'https://app.acme.dk/auth/saml/callback', roleAttribute: 'groups',
};

function cookieValue(res, name) {
  for (const c of (res.headers['set-cookie'] || [])) if (c.startsWith(`${name}=`)) return c.split(';')[0];
  return null;
}

// ---- AuthN / AuthZ + gate -------------------------------------------------

test('GET /api/saml/config without a token -> 401; as viewer -> 403', async () => {
  assert.equal((await request(makeApp()).get('/api/saml/config')).status, 401);
  assert.equal((await request(makeApp()).get('/api/saml/config').set('Authorization', viewer())).status, 403);
});

test('role-map mutations are 403 (reason:license) when the licence lacks sso_saml', async () => {
  const app = makeApp({ featureGate: unlicensed() });
  const post = await request(app).post('/api/saml/role-map').set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'admin' });
  assert.equal(post.status, 403);
  assert.equal(post.body.feature, 'sso_saml');
  assert.equal(post.body.reason, 'license');
  assert.equal((await request(app).get('/api/saml/role-map').set('Authorization', admin())).status, 200);
});

test('POST/GET/PUT/DELETE /api/saml/role-map round-trips; duplicate -> 409', async () => {
  const samlRoleMapRepo = makeSsoRoleMapRepo();
  const app = makeApp({ samlRoleMapRepo });
  const created = await request(app).post('/api/saml/role-map').set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'admin' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await request(app).post('/api/saml/role-map').set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'viewer' })).status, 409);
  const upd = await request(app).put(`/api/saml/role-map/${id}`).set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'operator' });
  assert.equal(upd.body.blueeye_role, 'operator');
  assert.equal((await request(app).delete(`/api/saml/role-map/${id}`).set('Authorization', admin())).status, 204);
});

// ---- Public SSO discovery + login -----------------------------------------

test('GET /auth/sso reports SAML availability', async () => {
  const samlAuth = makeSamlAuth({ isEnabled: () => true });
  const res = await request(makeApp({ samlAuth })).get('/auth/sso');
  assert.equal(res.body.saml.enabled, true);
  assert.equal(res.body.saml.loginUrl, '/auth/saml/login');
});

test('GET /auth/saml/login redirects to the IdP with a SAMLRequest', async () => {
  const samlAuth = createSamlAuth({ config: samlConfig, samlRoleMapRepo: makeSsoRoleMapRepo() });
  const res = await request(makeApp({ samlAuth })).get('/auth/saml/login');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /SAMLRequest=/);
  assert.ok(cookieValue(res, 'blueeye_saml_tx'));
});

test('GET /auth/saml/login redirects with an error when SAML is disabled', async () => {
  const res = await request(makeApp()).get('/auth/saml/login');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /sso_error=saml-disabled/);
});

test('GET /auth/saml/metadata returns SP metadata XML', async () => {
  const samlAuth = createSamlAuth({ config: samlConfig, samlRoleMapRepo: makeSsoRoleMapRepo() });
  const res = await request(makeApp({ samlAuth })).get('/auth/saml/metadata');
  assert.equal(res.status, 200);
  assert.match(res.text, /EntityDescriptor/);
  assert.match(res.text, /blueeye-sp/);
});

// ---- ACS (assertion consumer) ---------------------------------------------

test('POST /auth/saml/callback verifies a signed assertion, provisions a user + redirects with a token', async () => {
  const samlRoleMapRepo = makeSsoRoleMapRepo();
  await samlRoleMapRepo.create({ claimValue: 'be-admins', role: 'operator' });
  const samlAuth = createSamlAuth({ config: samlConfig, samlRoleMapRepo });
  const usersRepo = makeUsersRepo({ findByEmail: async () => null, create: async (u) => ({ id: 9, email: u.email, role: u.role }) });
  const audit = makeSsoLoginAuditRepo();
  const app = makeApp({ samlAuth, samlRoleMapRepo, usersRepo, ssoLoginAuditRepo: audit });

  const saml64 = buildSignedResponse({ email: 'alice@acme.dk', groups: ['be-admins'] });
  const res = await request(app).post('/auth/saml/callback').type('form').send({ SAMLResponse: saml64 });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /sso_token=/);
  assert.match(res.headers.location, /role=operator/);
  assert.equal(audit.rows[0].ok, true);
  assert.equal(audit.rows[0].provider, 'saml');
});

test('POST /auth/saml/callback redirects with an error on a forged assertion', async () => {
  const samlRoleMapRepo = makeSsoRoleMapRepo();
  await samlRoleMapRepo.create({ claimValue: 'be-admins', role: 'admin' });
  const samlAuth = createSamlAuth({ config: samlConfig, samlRoleMapRepo });
  const app = makeApp({ samlAuth, samlRoleMapRepo });
  const forged = buildSignedResponse({ email: 'alice@acme.dk', groups: ['be-admins'], tamper: (xml) => xml.replace('alice@acme.dk', 'evil@evil.dk') });
  const res = await request(app).post('/auth/saml/callback').type('form').send({ SAMLResponse: forged });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /sso_error=bad-signature/);
});
