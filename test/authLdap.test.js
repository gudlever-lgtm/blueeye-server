'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4'; // keep JIT-provision hashing fast under test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeUsersRepo, makeLdapAuth, makeLdapLoginAuditRepo } = require('../test-support/fakes');
const { hashPassword } = require('../src/auth/password');

const enabledLdap = (over) => makeLdapAuth({ isEnabled: async () => true, ...over });

test('LDAP success JIT-provisions a local user and issues the same JWT', async () => {
  const created = [];
  const usersRepo = makeUsersRepo({
    findByEmail: async () => null,
    create: async (u) => { const row = { id: 42, email: u.email, role: u.role }; created.push(u); return row; },
  });
  const audit = makeLdapLoginAuditRepo();
  const ldapAuth = enabledLdap({ authenticate: async () => ({ enabled: true, ok: true, role: 'operator', email: 'alice@x', dn: 'cn=alice,dc=x', matched: 1 }) });
  const app = makeApp({ usersRepo, ldapAuth, ldapLoginAuditRepo: audit });

  const res = await request(app).post('/auth/login').send({ email: 'alice', password: 'pw' });
  assert.equal(res.status, 200);
  assert.equal(res.body.auth, 'ldap');
  assert.equal(res.body.user.role, 'operator');
  assert.equal(res.body.user.id, 42);
  assert.equal(created.length, 1); // provisioned
  // audited as a success
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].ok, true);
  assert.equal(audit.rows[0].reason, 'ok');
  assert.equal(audit.rows[0].grantedRole, 'operator');
});

test('LDAP success on an existing user realigns the role (AD is source of truth)', async () => {
  let updated = null;
  const usersRepo = makeUsersRepo({
    findByEmail: async () => ({ id: 5, email: 'alice@x', role: 'viewer', protected: false }),
    update: async (id, patch) => { updated = { id, patch }; return { id, ...patch }; },
  });
  const ldapAuth = enabledLdap({ authenticate: async () => ({ enabled: true, ok: true, role: 'admin', email: 'alice@x', matched: 1 }) });
  const res = await request(makeApp({ usersRepo, ldapAuth })).post('/auth/login').send({ email: 'alice', password: 'pw' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
  assert.equal(updated.patch.role, 'admin');
});

test('LDAP never demotes a protected super-admin', async () => {
  let updated = null;
  const usersRepo = makeUsersRepo({
    findByEmail: async () => ({ id: 1, email: 'root@x', role: 'admin', protected: true }),
    update: async (id, patch) => { updated = { id, patch }; return { id, ...patch }; },
  });
  const ldapAuth = enabledLdap({ authenticate: async () => ({ enabled: true, ok: true, role: 'viewer', email: 'root@x', matched: 1 }) });
  const res = await request(makeApp({ usersRepo, ldapAuth })).post('/auth/login').send({ email: 'root', password: 'pw' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin'); // stays admin
  assert.equal(updated, null); // not touched
});

test('LDAP failure falls back to local JWT auth', async () => {
  const user = { id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('localpw'), role: 'admin' };
  const audit = makeLdapLoginAuditRepo();
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user });
  const ldapAuth = enabledLdap({ authenticate: async () => ({ enabled: true, ok: false, reason: 'bind-failed', matched: 0 }) });
  const app = makeApp({ usersRepo, ldapAuth, ldapLoginAuditRepo: audit });

  const res = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'localpw' });
  assert.equal(res.status, 200);
  assert.equal(res.body.auth, undefined); // local path, not 'ldap'
  assert.equal(res.body.user.role, 'admin');
  // the failed LDAP attempt was still audited
  assert.equal(audit.rows[0].ok, false);
  assert.equal(audit.rows[0].reason, 'bind-failed');
});

test('LDAP failure + wrong local password -> 401', async () => {
  const user = { id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('localpw'), role: 'admin' };
  const ldapAuth = enabledLdap({ authenticate: async () => ({ enabled: true, ok: false, reason: 'no-role', matched: 0 }) });
  const res = await request(makeApp({ usersRepo: makeUsersRepo({ findByEmailWithHash: async () => user }), ldapAuth }))
    .post('/auth/login').send({ email: 'admin@blueeye.local', password: 'WRONG' });
  assert.equal(res.status, 401);
});

test('LDAP disabled -> local login behaves exactly as before (no audit)', async () => {
  const user = { id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('localpw'), role: 'admin' };
  const audit = makeLdapLoginAuditRepo();
  const app = makeApp({ usersRepo: makeUsersRepo({ findByEmailWithHash: async () => user }), ldapLoginAuditRepo: audit });
  const res = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'localpw' });
  assert.equal(res.status, 200);
  assert.equal(audit.rows.length, 0); // LDAP not consulted
});

test('LDAP enabled but missing fields still 400', async () => {
  const ldapAuth = enabledLdap({ authenticate: async () => ({ enabled: true, ok: true, role: 'admin', email: 'a@x' }) });
  const res = await request(makeApp({ ldapAuth })).post('/auth/login').send({ email: 'alice' });
  assert.equal(res.status, 400);
});
