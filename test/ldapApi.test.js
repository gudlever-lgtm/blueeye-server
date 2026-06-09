'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeSecretBox, makeLdapConfigRepo, makeLdapRoleMapRepo, makeLdapLoginAuditRepo, makeLdapAuth, makeFeatureGate, authHeader, throwingAsync } = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');

// A feature gate with the LDAP/AD entitlement (sso_ldap) switched off.
const unlicensed = () => makeFeatureGate({ isFeatureEnabled: () => false });

const CFG = { host: 'ad.acme.dk', port: 636, useTls: true, bindDn: 'cn=svc,dc=x', baseDn: 'dc=x', userFilter: '(sAMAccountName={{username}})', enabled: true };

// ---- AuthN / AuthZ --------------------------------------------------------

test('GET /api/ldap/config without a token -> 401; as viewer -> 403', async () => {
  assert.equal((await request(makeApp()).get('/api/ldap/config')).status, 401);
  assert.equal((await request(makeApp()).get('/api/ldap/config').set('Authorization', viewer())).status, 403);
});

// ---- Config ---------------------------------------------------------------

test('GET /api/ldap/config returns the env flag + licence flag + null config initially', async () => {
  const res = await request(makeApp({ ldapAuthEnabledFlag: true })).get('/api/ldap/config').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.authEnabledFlag, true);
  assert.equal(res.body.licensed, true); // default fake gate grants sso_ldap
  assert.equal(res.body.config, null);
  assert.equal(res.body.bindPasswordSet, false);
});

test('GET /api/ldap/config reports bindPasswordSet without leaking the secret', async () => {
  const secretBox = makeSecretBox();
  const ldapConfigRepo = makeLdapConfigRepo();
  const app = makeApp({ secretBox, ldapConfigRepo });
  await request(app).put('/api/ldap/config').set('Authorization', admin()).send({ ...CFG, bindPassword: 's3cret' });
  const res = await request(app).get('/api/ldap/config').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.bindPasswordSet, true);
  assert.equal(res.body.config.bind_pw_encrypted, undefined);
  assert.ok(!JSON.stringify(res.body).includes('s3cret'));
});

// ---- Licence gate (sso_ldap) ----------------------------------------------

test('GET /api/ldap/config still readable when unlicensed, but reports licensed:false', async () => {
  const res = await request(makeApp({ featureGate: unlicensed() })).get('/api/ldap/config').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.licensed, false);
});

test('mutations + test are refused (403, reason:license) when the licence lacks LDAP/AD', async () => {
  const app = makeApp({ featureGate: unlicensed() });
  const put = await request(app).put('/api/ldap/config').set('Authorization', admin()).send(CFG);
  assert.equal(put.status, 403);
  assert.equal(put.body.feature, 'sso_ldap');
  assert.equal(put.body.reason, 'license');
  assert.equal((await request(app).post('/api/ldap/role-map').set('Authorization', admin()).send({ groupDn: 'cn=a,dc=x', role: 'admin' })).status, 403);
  assert.equal((await request(app).post('/api/ldap/test').set('Authorization', admin()).send({})).status, 403);
  // Reads remain available so the admin can still inspect state.
  assert.equal((await request(app).get('/api/ldap/role-map').set('Authorization', admin())).status, 200);
});

test('PUT /api/ldap/config saves; the bind password is encrypted at rest and never returned', async () => {
  const secretBox = makeSecretBox();
  const ldapConfigRepo = makeLdapConfigRepo();
  const app = makeApp({ secretBox, ldapConfigRepo });
  const res = await request(app).put('/api/ldap/config').set('Authorization', admin()).send({ ...CFG, bindPassword: 's3cret' });
  assert.equal(res.status, 200);
  assert.equal(res.body.config.host, 'ad.acme.dk');
  assert.ok(!JSON.stringify(res.body).includes('s3cret'));
  assert.equal(res.body.config.bind_pw_encrypted, undefined);
  // Stored encrypted + decryptable internally.
  const stored = await ldapConfigRepo.getWithSecret();
  assert.ok(stored.bind_pw_encrypted.startsWith('v1.gcm.'));
  assert.equal(secretBox.decrypt(stored.bind_pw_encrypted), 's3cret');
});

test('PUT /api/ldap/config defaults the port to 636 for LDAPS, 389 for plaintext', async () => {
  const app = makeApp();
  // useTls defaults true + no port -> LDAPS standard port 636 (not 389).
  const tls = await request(app).put('/api/ldap/config').set('Authorization', admin())
    .send({ host: 'ad.acme.dk', baseDn: 'dc=x' });
  assert.equal(tls.status, 200);
  assert.equal(tls.body.config.port, 636);
  // Plaintext on localhost + no port -> 389.
  const plain = await request(app).put('/api/ldap/config').set('Authorization', admin())
    .send({ host: 'localhost', baseDn: 'dc=x', useTls: false });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.config.port, 389);
});

test('PUT /api/ldap/config with missing host/baseDn -> 400', async () => {
  const res = await request(makeApp()).put('/api/ldap/config').set('Authorization', admin()).send({ port: 636 });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.host);
  assert.ok(res.body.details.baseDn);
});

test('PUT /api/ldap/config rejects plaintext bind to a non-local host -> 400', async () => {
  const res = await request(makeApp()).put('/api/ldap/config').set('Authorization', admin()).send({ ...CFG, useTls: false });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.useTls);
});

test('PUT /api/ldap/config userFilter must contain {{username}}', async () => {
  const res = await request(makeApp()).put('/api/ldap/config').set('Authorization', admin()).send({ ...CFG, userFilter: '(uid=fixed)' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.userFilter);
});

test('PUT /api/ldap/config clearBindPassword wipes the stored secret', async () => {
  const ldapConfigRepo = makeLdapConfigRepo();
  const app = makeApp({ ldapConfigRepo });
  await request(app).put('/api/ldap/config').set('Authorization', admin()).send({ ...CFG, bindPassword: 'x' });
  assert.ok((await ldapConfigRepo.getWithSecret()).bind_pw_encrypted);
  await request(app).put('/api/ldap/config').set('Authorization', admin()).send({ ...CFG, clearBindPassword: true });
  assert.equal((await ldapConfigRepo.getWithSecret()).bind_pw_encrypted, null);
});

// ---- Role map -------------------------------------------------------------

test('role-map CRUD: create/list/update/delete + duplicate 409 + 404 + 400', async () => {
  const app = makeApp();
  const created = await request(app).post('/api/ldap/role-map').set('Authorization', admin()).send({ groupDn: 'cn=admins,dc=x', role: 'admin' });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const list = await request(app).get('/api/ldap/role-map').set('Authorization', admin());
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);

  // duplicate group
  assert.equal((await request(app).post('/api/ldap/role-map').set('Authorization', admin()).send({ groupDn: 'cn=admins,dc=x', role: 'viewer' })).status, 409);
  // invalid role
  assert.equal((await request(app).post('/api/ldap/role-map').set('Authorization', admin()).send({ groupDn: 'cn=z,dc=x', role: 'superuser' })).status, 400);

  // update + 404 + bad id
  assert.equal((await request(app).put(`/api/ldap/role-map/${id}`).set('Authorization', admin()).send({ groupDn: 'cn=admins,dc=x', role: 'operator' })).status, 200);
  assert.equal((await request(app).put('/api/ldap/role-map/999').set('Authorization', admin()).send({ groupDn: 'cn=q,dc=x', role: 'viewer' })).status, 404);
  assert.equal((await request(app).put('/api/ldap/role-map/abc').set('Authorization', admin()).send({ groupDn: 'cn=q,dc=x', role: 'viewer' })).status, 400);

  // delete + 404
  assert.equal((await request(app).delete(`/api/ldap/role-map/${id}`).set('Authorization', admin())).status, 204);
  assert.equal((await request(app).delete(`/api/ldap/role-map/${id}`).set('Authorization', admin())).status, 404);
});

// ---- Test connection ------------------------------------------------------

test('POST /api/ldap/test returns the connectivity result', async () => {
  const ldapAuth = makeLdapAuth({ testConnection: async () => ({ ok: false, detail: 'bind failed' }) });
  const res = await request(makeApp({ ldapAuth })).post('/api/ldap/test').set('Authorization', admin()).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.detail, /bind failed/);
});

// ---- Login audit ----------------------------------------------------------

test('GET /api/ldap/login-audit returns recent attempts (newest first), admin-only', async () => {
  const ldapLoginAuditRepo = makeLdapLoginAuditRepo();
  await ldapLoginAuditRepo.record({ username: 'alice', ok: true, reason: 'ok', grantedRole: 'admin', groupsMatched: 2, sourceIp: '10.0.0.1' });
  await ldapLoginAuditRepo.record({ username: 'mallory', ok: false, reason: 'no-role', grantedRole: null, groupsMatched: 0, sourceIp: '10.0.0.2' });
  const app = makeApp({ ldapLoginAuditRepo });

  assert.equal((await request(app).get('/api/ldap/login-audit')).status, 401);
  assert.equal((await request(app).get('/api/ldap/login-audit').set('Authorization', viewer())).status, 403);

  const res = await request(app).get('/api/ldap/login-audit').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].username, 'mallory'); // newest first
  assert.equal(res.body[1].granted_role || res.body[1].grantedRole, 'admin');
});

// ---- 500 ------------------------------------------------------------------

test('a repository failure surfaces as 500', async () => {
  const ldapRoleMapRepo = makeLdapRoleMapRepo({ findAll: throwingAsync() });
  const res = await request(makeApp({ ldapRoleMapRepo })).get('/api/ldap/role-map').set('Authorization', admin());
  assert.equal(res.status, 500);
});
