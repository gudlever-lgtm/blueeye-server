'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSamlAuth } = require('../src/auth/saml');
const { makeSsoRoleMapRepo, makeFeatureGate } = require('../test-support/fakes');
const { TEST_CERT, buildSignedResponse, makeAttackerKey } = require('../test-support/samlTestkit');

const baseConfig = {
  authEnabled: true,
  entryPoint: 'https://idp.example/sso',
  spEntityId: 'blueeye-sp',
  audience: 'blueeye-sp',
  idpEntityId: 'https://idp.example',
  idpCert: TEST_CERT,
  callbackUrl: 'https://app.acme.dk/auth/saml/callback',
  roleAttribute: 'groups',
};

function authWith({ roleMap = [], featureGate = null, config = baseConfig } = {}) {
  const samlRoleMapRepo = makeSsoRoleMapRepo();
  return {
    saml: createSamlAuth({ config, samlRoleMapRepo, featureGate }),
    samlRoleMapRepo,
    seed: async () => { for (const m of roleMap) await samlRoleMapRepo.create(m); },
  };
}

test('buildLoginRequest produces a redirect URL with a DEFLATE\'d SAMLRequest', async () => {
  const { saml } = authWith();
  const req = await saml.buildLoginRequest();
  const u = new URL(req.url);
  assert.ok(u.searchParams.get('SAMLRequest'));
  assert.ok(req.requestId.startsWith('_'));
});

test('handleResponse: happy path verifies the signed assertion and maps a role', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const saml64 = buildSignedResponse({ email: 'Alice@Acme.dk', groups: ['be-admins', 'devs'] });
  const res = await saml.handleResponse(saml64);
  assert.equal(res.ok, true);
  assert.equal(res.role, 'admin');
  assert.equal(res.email, 'alice@acme.dk'); // lower-cased
  assert.equal(res.matched, 1);
});

test('REPLAY: the same signed assertion cannot be consumed twice', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const saml64 = buildSignedResponse({ email: 'alice@acme.dk', groups: ['be-admins'] });
  const first = await saml.handleResponse(saml64);
  assert.equal(first.ok, true);
  // An attacker captures the SAMLResponse and re-POSTs it to the ACS.
  const second = await saml.handleResponse(saml64);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'replayed');
});

test('REPLAY: two DISTINCT assertions both succeed (cache does not block real logins)', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const a = await saml.handleResponse(buildSignedResponse({ assertionId: '_login-a', groups: ['be-admins'] }));
  const b = await saml.handleResponse(buildSignedResponse({ assertionId: '_login-b', groups: ['be-admins'] }));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test('attribute→role mapping: the HIGHEST matching role wins', async () => {
  const { saml, seed } = authWith({ roleMap: [
    { claimValue: 'be-viewers', role: 'viewer' },
    { claimValue: 'be-admins', role: 'admin' },
  ] });
  await seed();
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['be-viewers', 'be-admins'] }));
  assert.equal(res.ok, true);
  assert.equal(res.role, 'admin');
  assert.equal(res.matched, 2);
});

test('handleResponse: no mapped attribute -> no-role (access denied)', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['nobody'] }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-role');
});

test('FORGED: a tampered assertion (digest mismatch) is rejected', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }, { claimValue: 'evil', role: 'admin' }] });
  await seed();
  // Flip the NameID AFTER signing — the digest no longer matches.
  const forged = buildSignedResponse({ email: 'alice@acme.dk', groups: ['be-admins'], tamper: (xml) => xml.replace('alice@acme.dk', 'attacker@evil.dk') });
  const res = await saml.handleResponse(forged);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-signature');
});

test('FORGED: an assertion signed by the wrong key is rejected', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const forged = buildSignedResponse({ groups: ['be-admins'], signKey: makeAttackerKey() });
  const res = await saml.handleResponse(forged);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-signature');
});

test('an expired assertion (Conditions NotOnOrAfter in the past) is rejected', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['be-admins'], notOnOrAfter: past, scdNotOnOrAfter: past }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'expired');
});

test('an audience mismatch is rejected', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['be-admins'], audience: 'some-other-sp' }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'audience');
});

test('an issuer mismatch is rejected', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['be-admins'], issuer: 'https://evil-idp.example' }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'issuer-mismatch');
});

test('a signed assertion that omits AudienceRestriction is rejected (no audience bypass)', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  // Validly signed, Conditions present, but NO <AudienceRestriction> naming us.
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['be-admins'], audience: null }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'audience');
});

test('a signed assertion with no Issuer is rejected when an IdP entityID is configured', async () => {
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }] });
  await seed();
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['be-admins'], issuer: null }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'issuer-mismatch');
});

test('an unsigned response is rejected (no signature)', async () => {
  const { saml } = authWith();
  const unsigned = Buffer.from('<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Issuer>https://idp.example</saml:Issuer></saml:Assertion></samlp:Response>', 'utf8').toString('base64');
  const res = await saml.handleResponse(unsigned);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-signature');
});

test('isEnabled is false (and handleResponse disabled) when the licence lacks sso_saml', async () => {
  const gate = makeFeatureGate({ isFeatureEnabled: () => false });
  const { saml, seed } = authWith({ roleMap: [{ claimValue: 'be-admins', role: 'admin' }], featureGate: gate });
  await seed();
  assert.equal(saml.isEnabled(), false);
  const res = await saml.handleResponse(buildSignedResponse({ groups: ['be-admins'] }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'disabled');
});

test('isEnabled is false when entryPoint/cert/SP entityID are not configured', async () => {
  const saml = createSamlAuth({ config: { authEnabled: true, entryPoint: '', spEntityId: '', idpCert: '' }, samlRoleMapRepo: makeSsoRoleMapRepo() });
  assert.equal(saml.isConfigured(), false);
  assert.equal(saml.isEnabled(), false);
});
