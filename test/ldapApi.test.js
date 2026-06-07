'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeSecretBox, makeLdapConfigRepo, makeLdapRoleMapRepo, makeLdapAuth, authHeader, throwingAsync } = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');

const CFG = { host: 'ad.acme.dk', port: 636, useTls: true, bindDn: 'cn=svc,dc=x', baseDn: 'dc=x', userFilter: '(sAMAccountName={{username}})', enabled: true };

// ---- AuthN / AuthZ --------------------------------------------------------

test('GET /api/ldap/config without a token -> 401; as viewer -> 403', async () => {
  assert.equal((await request(makeApp()).get('/api/ldap/config')).status, 401);
  assert.equal((await request(makeApp()).get('/api/ldap/config').set('Authorization', viewer())).status, 403);
});

// ---- Config ---------------------------------------------------------------

test('GET /api/ldap/config returns the env flag + null config initially', async () => {
  const res = await request(makeApp({ ldapAuthEnabledFlag: true })).get('/api/ldap/config').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.authEnabledFlag, true);
  assert.equal(res.body.config, null);
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

// ---- 500 ------------------------------------------------------------------

test('a repository failure surfaces as 500', async () => {
  const ldapRoleMapRepo = makeLdapRoleMapRepo({ findAll: throwingAsync() });
  const res = await request(makeApp({ ldapRoleMapRepo })).get('/api/ldap/role-map').set('Authorization', admin());
  assert.equal(res.status, 500);
});
