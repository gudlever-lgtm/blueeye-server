'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4'; // keep JIT-provision hashing fast under test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeOidcAuth, makeOidcRoleMapRepo, makeSsoLoginAuditRepo, makeUsersRepo, makeFeatureGate, authHeader } = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');
const unlicensed = () => makeFeatureGate({ isFeatureEnabled: () => false });

// Pulls the value of a Set-Cookie entry by name out of a supertest response.
function cookieValue(res, name) {
  const set = res.headers['set-cookie'] || [];
  for (const c of set) { if (c.startsWith(`${name}=`)) return c.split(';')[0]; }
  return null;
}

// ---- AuthN / AuthZ --------------------------------------------------------

test('GET /api/oidc/config without a token -> 401; as viewer -> 403', async () => {
  assert.equal((await request(makeApp()).get('/api/oidc/config')).status, 401);
  assert.equal((await request(makeApp()).get('/api/oidc/config').set('Authorization', viewer())).status, 403);
});

test('GET /api/oidc/config returns the (non-secret) status to an admin', async () => {
  const oidcAuth = makeOidcAuth({ status: () => ({ authEnabledFlag: true, licensed: true, configured: true, enabled: true, issuer: 'https://idp.example', clientId: 'be', redirectUri: 'https://app/cb', scopes: 'openid', roleClaim: 'groups', clientSecretSet: true }) });
  const res = await request(makeApp({ oidcAuth })).get('/api/oidc/config').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.issuer, 'https://idp.example');
  assert.ok(!('clientSecret' in res.body)); // never leak the secret itself
});

// ---- Licence gate (sso_oidc) ----------------------------------------------

test('role-map mutations + test are 403 (reason:license) when the licence lacks sso_oidc', async () => {
  const app = makeApp({ featureGate: unlicensed() });
  const post = await request(app).post('/api/oidc/role-map').set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'admin' });
  assert.equal(post.status, 403);
  assert.equal(post.body.feature, 'sso_oidc');
  assert.equal(post.body.reason, 'license');
  assert.equal((await request(app).post('/api/oidc/test').set('Authorization', admin()).send({})).status, 403);
  // Reads remain available so an admin can still inspect state.
  assert.equal((await request(app).get('/api/oidc/role-map').set('Authorization', admin())).status, 200);
  assert.equal((await request(app).get('/api/oidc/config').set('Authorization', admin())).status, 200);
});

// ---- Role-map CRUD --------------------------------------------------------

test('POST/GET/PUT/DELETE /api/oidc/role-map round-trips; duplicate -> 409', async () => {
  const oidcRoleMapRepo = makeOidcRoleMapRepo();
  const app = makeApp({ oidcRoleMapRepo });
  const created = await request(app).post('/api/oidc/role-map').set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'admin' });
  assert.equal(created.status, 201);
  assert.equal(created.body.claim_value, 'be-admins');
  const id = created.body.id;

  const dup = await request(app).post('/api/oidc/role-map').set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'viewer' });
  assert.equal(dup.status, 409);

  const list = await request(app).get('/api/oidc/role-map').set('Authorization', admin());
  assert.equal(list.body.length, 1);

  const upd = await request(app).put(`/api/oidc/role-map/${id}`).set('Authorization', admin()).send({ claimValue: 'be-admins', role: 'operator' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.blueeye_role, 'operator');

  assert.equal((await request(app).delete(`/api/oidc/role-map/${id}`).set('Authorization', admin())).status, 204);
});

test('POST /api/oidc/role-map validates input (400)', async () => {
  const res = await request(makeApp()).post('/api/oidc/role-map').set('Authorization', admin()).send({ claimValue: '', role: 'superuser' });
  assert.equal(res.status, 400);
});

// ---- Public SSO discovery -------------------------------------------------

test('GET /auth/sso reports OIDC availability for the login screen', async () => {
  const off = await request(makeApp()).get('/auth/sso');
  assert.equal(off.status, 200);
  assert.equal(off.body.oidc.enabled, false);

  const oidcAuth = makeOidcAuth({ isEnabled: () => true });
  const on = await request(makeApp({ oidcAuth })).get('/auth/sso');
  assert.equal(on.body.oidc.enabled, true);
  assert.equal(on.body.oidc.loginUrl, '/auth/oidc/login');
});

// ---- Browser login + callback flow ----------------------------------------

test('GET /auth/oidc/login redirects to the IdP and sets the tx cookie', async () => {
  const oidcAuth = makeOidcAuth({ isEnabled: () => true, createLoginRequest: async () => ({ url: 'https://idp.example/auth?x=1', state: 'st8', nonce: 'nce', codeVerifier: 'ver' }) });
  const res = await request(makeApp({ oidcAuth })).get('/auth/oidc/login');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://idp.example/auth?x=1');
  assert.ok(cookieValue(res, 'blueeye_oidc_tx'));
});

test('GET /auth/oidc/login redirects with an error when OIDC is disabled', async () => {
  const res = await request(makeApp()).get('/auth/oidc/login');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /sso_error=oidc-disabled/);
});

test('GET /auth/oidc/callback completes login: provisions a user + redirects with a token', async () => {
  const oidcAuth = makeOidcAuth({
    isEnabled: () => true,
    createLoginRequest: async () => ({ url: 'https://idp.example/auth', state: 'st8', nonce: 'nce', codeVerifier: 'ver' }),
    handleCallback: async () => ({ ok: true, email: 'alice@acme.dk', role: 'operator', subject: 'sub-1', matched: 1 }),
  });
  const usersRepo = makeUsersRepo({ findByEmail: async () => null, create: async (u) => ({ id: 7, email: u.email, role: u.role }) });
  const audit = makeSsoLoginAuditRepo();
  const app = makeApp({ oidcAuth, usersRepo, ssoLoginAuditRepo: audit });

  // Start the flow to obtain a valid signed tx cookie + the matching state.
  const login = await request(app).get('/auth/oidc/login');
  const txCookie = cookieValue(login, 'blueeye_oidc_tx');

  const cb = await request(app).get('/auth/oidc/callback?code=abc&state=st8').set('Cookie', txCookie);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_token=/);
  assert.match(cb.headers.location, /role=operator/);
  assert.equal(audit.rows[0].ok, true);
  assert.equal(audit.rows[0].provider, 'oidc');
});

test('GET /auth/oidc/callback rejects a state mismatch (CSRF guard)', async () => {
  const oidcAuth = makeOidcAuth({ isEnabled: () => true, createLoginRequest: async () => ({ url: 'https://idp.example/auth', state: 'st8', nonce: 'nce', codeVerifier: 'ver' }) });
  const app = makeApp({ oidcAuth });
  const login = await request(app).get('/auth/oidc/login');
  const txCookie = cookieValue(login, 'blueeye_oidc_tx');
  const cb = await request(app).get('/auth/oidc/callback?code=abc&state=WRONG').set('Cookie', txCookie);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_error=invalid-state/);
});

test('GET /auth/oidc/callback without the tx cookie is rejected', async () => {
  const oidcAuth = makeOidcAuth({ isEnabled: () => true });
  const cb = await request(makeApp({ oidcAuth })).get('/auth/oidc/callback?code=abc&state=st8');
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_error=invalid-state/);
});
