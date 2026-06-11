'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { createOidcAuth } = require('../src/auth/oidc');
const { makeOidcRoleMapRepo, makeFeatureGate } = require('../test-support/fakes');

const ISSUER = 'https://idp.example/realms/blueeye';
const CLIENT_ID = 'blueeye';
const NONCE = 'test-nonce';

const baseConfig = {
  authEnabled: true,
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'shh',
  redirectUri: 'https://app.acme.dk/auth/oidc/callback',
  scopes: 'openid email profile',
  roleClaim: 'groups',
};

// A signing keypair + its public JWK (JWK import is native to Node crypto, so no
// PEM-conversion library is needed).
function makeKeys(kid = 'kid-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = kid; jwk.alg = 'RS256'; jwk.use = 'sig';
  return { privateKey, jwk, kid };
}

function signIdToken(privateKey, { sub = 'user-1', email = 'Alice@Acme.dk', groups = [], nonce = NONCE, kid = 'kid-1', aud = CLIENT_ID, iss = ISSUER } = {}) {
  return jwt.sign({ email, groups, nonce }, privateKey, {
    algorithm: 'RS256', keyid: kid, subject: sub, audience: aud, issuer: iss, expiresIn: '5m',
  });
}

// An injected fetch serving discovery + JWKS + token. Pass a per-test idToken.
function makeFetch({ jwk, idToken, tokenOk = true }) {
  return async (url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return { ok: true, status: 200, json: async () => ({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      }) };
    }
    if (url.endsWith('/certs')) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    if (url.endsWith('/token')) return { ok: tokenOk, status: tokenOk ? 200 : 401, json: async () => (tokenOk ? { id_token: idToken, token_type: 'Bearer' } : { error: 'invalid_grant' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function authWith({ jwk, privateKey, idToken, tokenOk = true, roleMap = [], featureGate = null, config = baseConfig }) {
  const oidcRoleMapRepo = makeOidcRoleMapRepo();
  return {
    oidc: createOidcAuth({ config, oidcRoleMapRepo, fetchImpl: makeFetch({ jwk, idToken, tokenOk }), featureGate }),
    oidcRoleMapRepo,
    seed: async () => { for (const m of roleMap) await oidcRoleMapRepo.create(m); },
  };
}

test('createLoginRequest builds a PKCE authorization URL with state + nonce', async () => {
  const { jwk } = makeKeys();
  const { oidc } = authWith({ jwk });
  const req = await oidc.createLoginRequest();
  const u = new URL(req.url);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('code_challenge'));
  assert.equal(u.searchParams.get('state'), req.state);
  assert.equal(u.searchParams.get('nonce'), req.nonce);
  assert.ok(req.codeVerifier && req.codeVerifier.length >= 40);
});

test('handleCallback: happy path verifies the id_token and maps the claim to a role', async () => {
  const { jwk, privateKey } = makeKeys();
  const idToken = signIdToken(privateKey, { groups: ['be-admins', 'devs'] });
  const { oidc, seed } = authWith({ jwk, idToken, roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, true);
  assert.equal(res.role, 'admin');
  assert.equal(res.email, 'alice@acme.dk'); // lower-cased
  assert.equal(res.subject, 'user-1');
  assert.equal(res.matched, 1);
});

test('claim→role mapping: the HIGHEST matching role wins', async () => {
  const { jwk, privateKey } = makeKeys();
  const idToken = signIdToken(privateKey, { groups: ['be-viewers', 'be-admins'] });
  const { oidc, seed } = authWith({ jwk, idToken, roleMap: [
    { claimValue: 'be-viewers', role: 'viewer' },
    { claimValue: 'be-admins', role: 'admin' },
  ] });
  await seed();
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, true);
  assert.equal(res.role, 'admin');
  assert.equal(res.matched, 2);
});

test('handleCallback: no mapped group -> no-role (access denied)', async () => {
  const { jwk, privateKey } = makeKeys();
  const idToken = signIdToken(privateKey, { groups: ['unknown-group'] });
  const { oidc, seed } = authWith({ jwk, idToken, roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-role');
});

test('handleCallback: a nonce mismatch is rejected as an invalid token', async () => {
  const { jwk, privateKey } = makeKeys();
  const idToken = signIdToken(privateKey, { groups: ['be-admins'], nonce: 'WRONG' });
  const { oidc, seed } = authWith({ jwk, idToken, roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-token');
});

test('handleCallback: a forged id_token (wrong signing key) is rejected', async () => {
  const real = makeKeys('kid-1');
  const attacker = makeKeys('kid-1'); // same kid, different key
  // The token is signed by the attacker but JWKS only has the real public key.
  const idToken = signIdToken(attacker.privateKey, { groups: ['be-admins'] });
  const { oidc, seed } = authWith({ jwk: real.jwk, idToken, roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-token');
});

test('handleCallback: a wrong audience is rejected', async () => {
  const { jwk, privateKey } = makeKeys();
  const idToken = signIdToken(privateKey, { groups: ['be-admins'], aud: 'some-other-client' });
  const { oidc, seed } = authWith({ jwk, idToken, roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-token');
});

test('handleCallback: a failed token exchange -> token-failed', async () => {
  const { jwk } = makeKeys();
  const { oidc } = authWith({ jwk, idToken: 'unused', tokenOk: false });
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'token-failed');
});

test('isEnabled is false (and handleCallback is disabled) when the licence lacks sso_oidc', async () => {
  const { jwk, privateKey } = makeKeys();
  const idToken = signIdToken(privateKey, { groups: ['be-admins'] });
  const gate = makeFeatureGate({ isFeatureEnabled: () => false });
  const { oidc, seed } = authWith({ jwk, idToken, roleMap: [{ claimValue: 'be-admins', role: 'admin' }], featureGate: gate });
  await seed();
  assert.equal(oidc.isEnabled(), false);
  const res = await oidc.handleCallback({ code: 'abc', codeVerifier: 'v', nonce: NONCE });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'disabled');
});

test('isEnabled is false when issuer/client/redirect are not configured', async () => {
  const oidc = createOidcAuth({ config: { authEnabled: true, issuer: '', clientId: '', redirectUri: '' }, oidcRoleMapRepo: makeOidcRoleMapRepo() });
  assert.equal(oidc.isConfigured(), false);
  assert.equal(oidc.isEnabled(), false);
});
