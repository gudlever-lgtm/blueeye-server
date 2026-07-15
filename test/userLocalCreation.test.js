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
