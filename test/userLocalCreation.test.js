'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4'; // keep hashing fast under test

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeUsersRepo,
  makeUserMailer,
  makeLdapAuth,
  makeOidcAuth,
  authHeader,
} = require('../test-support/fakes');
const { hashPassword } = require('../src/auth/password');

const admin = () => authHeader('admin');

// ------------------------------------------------------ POST /users/local (201)
test('POST /users/local creates a user, issues a temp password and emails it', async () => {
  let createdWith = null;
  const usersRepo = makeUsersRepo({
    findByEmail: async () => null,
    create: async (input) => { createdWith = input; return { id: 7, email: input.email, role: input.role, must_change_password: true }; },
  });
  const userMailer = makeUserMailer();

  const res = await request(makeApp({ usersRepo, userMailer }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'New@Acme.dk', name: 'Ada Lovelace', role: 'operator' });

  assert.equal(res.status, 201);
  assert.equal(res.body.email, 'new@acme.dk');
  assert.equal(res.body.role, 'operator');
  // The one-time password is never returned by the API.
  assert.equal(res.body.password, undefined);
  assert.equal(res.body.tempPassword, undefined);
  // Persisted as a forced-change user with an expiry + issuing admin.
  assert.equal(createdWith.mustChangePassword, true);
  assert.ok(createdWith.tempPasswordExpiresAt instanceof Date);
  assert.equal(createdWith.tempPasswordCreatedBy, 1);
  // A hash — never the plaintext — is stored.
  assert.ok(createdWith.passwordHash && createdWith.passwordHash.startsWith('$2'));
  // The email carried the plaintext password + recipient.
  assert.equal(userMailer.sent.length, 1);
  assert.equal(userMailer.sent[0].to, 'new@acme.dk');
  assert.equal(userMailer.sent[0].name, 'Ada Lovelace');
  assert.ok(userMailer.sent[0].tempPassword.length >= 16);
});

// --------------------------------------------------- 403 when SSO/LDAP active
test('POST /users/local returns 403 when LDAP is enabled', async () => {
  const usersRepo = makeUsersRepo({ findByEmail: async () => null });
  const ldapAuth = makeLdapAuth({ isEnabled: async () => true });

  const res = await request(makeApp({ usersRepo, ldapAuth }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'x@acme.dk', role: 'viewer' });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /SSO\/LDAP/);
});

test('POST /users/local returns 403 when OIDC SSO is enabled', async () => {
  const oidcAuth = makeOidcAuth({ isEnabled: () => true });
  const res = await request(makeApp({ oidcAuth }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'x@acme.dk', role: 'viewer' });

  assert.equal(res.status, 403);
});

// ------------------------------------------------------ validation + conflicts
test('POST /users/local returns 400 for invalid input', async () => {
  const res = await request(makeApp())
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'not-an-email', role: 'wizard' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('POST /users/local returns 409 when the email is already in use', async () => {
  const usersRepo = makeUsersRepo({ findByEmail: async () => ({ id: 2, email: 'dupe@acme.dk', role: 'viewer' }) });
  const res = await request(makeApp({ usersRepo }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'dupe@acme.dk', role: 'viewer' });
  assert.equal(res.status, 409);
});

// -------------------------------------- 500 + rollback when the email fails
test('POST /users/local rolls the user back and 500s when the email fails', async () => {
  let removed = null;
  const usersRepo = makeUsersRepo({
    findByEmail: async () => null,
    create: async (input) => ({ id: 9, email: input.email, role: input.role }),
    remove: async (id) => { removed = id; return true; },
  });
  const userMailer = makeUserMailer({ sendTempPassword: async () => { throw new Error('smtp down'); } });

  const res = await request(makeApp({ usersRepo, userMailer }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'fail@acme.dk', role: 'viewer' });

  assert.equal(res.status, 500);
  assert.match(res.body.error, /not created/);
  // The half-created user was removed.
  assert.equal(removed, 9);
});

test('POST /users/local returns 503 when no mailer is wired', async () => {
  // A mailer object without sendTempPassword stands in for "email not configured".
  const res = await request(makeApp({ userMailer: {} }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'x@acme.dk', role: 'viewer' });
  assert.equal(res.status, 503);
});

// -------------------------------------- POST /users/:id/resend-temp-password
test('POST /users/:id/resend-temp-password re-issues and emails a new password', async () => {
  let setWith = null;
  const usersRepo = makeUsersRepo({
    findById: async (id) => ({ id, email: 'u@acme.dk', role: 'viewer', must_change_password: true }),
    setTempPassword: async (id, patch) => { setWith = { id, patch }; return { id }; },
  });
  const userMailer = makeUserMailer();

  const res = await request(makeApp({ usersRepo, userMailer }))
    .post('/users/3/resend-temp-password')
    .set('Authorization', admin())
    .send({});

  assert.equal(res.status, 200);
  assert.equal(setWith.id, 3);
  assert.ok(setWith.patch.passwordHash.startsWith('$2'));
  assert.ok(setWith.patch.expiresAt instanceof Date);
  assert.equal(userMailer.sent.length, 1);
  assert.equal(userMailer.sent[0].to, 'u@acme.dk');
});

test('POST /users/:id/resend-temp-password returns 404 for an unknown user', async () => {
  const usersRepo = makeUsersRepo({ findById: async () => null });
  const res = await request(makeApp({ usersRepo }))
    .post('/users/999/resend-temp-password')
    .set('Authorization', admin())
    .send({});
  assert.equal(res.status, 404);
});

test('POST /users/:id/resend-temp-password returns 403 when SSO/LDAP is active', async () => {
  const ldapAuth = makeLdapAuth({ isEnabled: async () => true });
  const res = await request(makeApp({ ldapAuth }))
    .post('/users/3/resend-temp-password')
    .set('Authorization', admin())
    .send({});
  assert.equal(res.status, 403);
});

// --------------------------------------------- the guard must fail CLOSED
//
// ssoOrLdapActive() is what stops a customer on SSO from having local
// password accounts created behind their directory. It used to swallow an
// error from any provider check and answer "no SSO here", which re-enabled the
// bypass precisely on the install where something was already broken — and
// said nothing anywhere. These pin the closed behaviour.

test('a provider whose isEnabled() throws refuses local creation instead of allowing it', async () => {
  const usersRepo = makeUsersRepo({ findByEmail: async () => null });
  const ldapAuth = makeLdapAuth({ isEnabled: async () => { throw new Error('directory unreachable'); } });

  const res = await request(makeApp({ usersRepo, userMailer: makeUserMailer(), ldapAuth }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'sneaky@acme.dk', name: 'Ada', role: 'admin' });

  assert.equal(res.status, 403, 'an unanswerable SSO check must never open local creation');
  assert.match(res.body.error, /could not determine whether LDAP\/AD sign-in is active/);
  // And it says what to do about it rather than just refusing.
  assert.match(res.body.error, /Fix the LDAP\/AD configuration/);
});

test('resend-temp-password is closed by the same indeterminate check', async () => {
  const usersRepo = makeUsersRepo({ findById: async () => ({ id: 3, email: 'a@b.dk', role: 'viewer' }) });
  const oidcAuth = makeOidcAuth({ isEnabled: () => { throw new Error('discovery failed'); } });

  const res = await request(makeApp({ usersRepo, userMailer: makeUserMailer(), oidcAuth }))
    .post('/users/3/resend-temp-password')
    .set('Authorization', admin());

  assert.equal(res.status, 403);
  assert.match(res.body.error, /could not determine whether OIDC sign-in is active/);
});

test('/users/local-availability reports WHICH method blocks it, and when it could not tell', async () => {
  const usersRepo = makeUsersRepo();

  const broken = await request(makeApp({ usersRepo, userMailer: makeUserMailer(), ldapAuth: makeLdapAuth({ isEnabled: async () => { throw new Error('boom'); } }) }))
    .get('/users/local-availability').set('Authorization', admin());
  assert.equal(broken.status, 200);
  assert.equal(broken.body.available, false);
  assert.equal(broken.body.ssoActive, true);
  assert.equal(broken.body.ssoMethod, 'LDAP/AD');
  assert.equal(broken.body.ssoIndeterminate, true, 'the UI must be able to tell "blocked" from "unknown"');

  const live = await request(makeApp({ usersRepo, userMailer: makeUserMailer(), ldapAuth: makeLdapAuth({ isEnabled: async () => true }) }))
    .get('/users/local-availability').set('Authorization', admin());
  assert.equal(live.body.ssoActive, true);
  assert.equal(live.body.ssoMethod, 'LDAP/AD');
  assert.equal(live.body.ssoIndeterminate, false, 'a genuine "SSO is on" is not indeterminate');

  const none = await request(makeApp({ usersRepo, userMailer: makeUserMailer() }))
    .get('/users/local-availability').set('Authorization', admin());
  assert.equal(none.body.ssoActive, false);
  assert.equal(none.body.available, true, 'an install with no SSO wired is unaffected');
});
