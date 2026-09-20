'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4'; // keep hashing fast under test

// Can the fail-closed SSO guard lock an administrator out of their own server?
//
// `ssoOrLdapActive()` in src/routes/users.js was changed to fail CLOSED: a
// provider check that throws is now read as "SSO might be on" and local user
// creation is refused, where it used to be read as "no SSO here" and allowed.
// That is the right call for the bypass it prevents, and it is also exactly the
// shape of change that strands people: the directory breaks, and the tool you
// would use to get back in is the tool that just locked itself.
//
// It does not stand people up, and the reason is structural rather than lucky —
// the guard sits on three endpoints that all require an ALREADY AUTHENTICATED
// admin, and sign-in does not consult it. These tests pin that, so the day
// somebody wires the same guard into the login path it fails here first.
//
// The four properties, each with a test below:
//
//   1. sign-in never consults the guard. A directory that is down, throwing or
//      misconfigured still falls back to local password auth.
//   2. the guard's own endpoints answer 403/200, never 500 — a refusal an admin
//      can read beats a stack trace.
//   3. an admin keeps a way to create an account while the guard is closed
//      (POST /users), so "locked out" never becomes true.
//   4. an install with no SSO wired cannot reach the closed path at all.
//
// See docs/auth-lockout.md for the operator-facing version of this.

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

// A local admin who can still sign in with a password.
async function localAdminRepo(over = {}) {
  const password_hash = await hashPassword('correct-horse-battery');
  return makeUsersRepo({
    findByEmailWithHash: async (email) =>
      email === 'root@acme.dk'
        ? { id: 1, email: 'root@acme.dk', role: 'admin', password_hash, must_change_password: false }
        : null,
    findByEmail: async () => null,
    ...over,
  });
}

// The realistic outage: the directory host is unreachable. `isEnabled()` reads
// the STORED config (a DB row), so it answers fine; `authenticate()` is the call
// that goes over the network and fails.
const directoryDown = () =>
  makeLdapAuth({
    isEnabled: async () => true,
    authenticate: async () => { throw new Error('ECONNREFUSED ldap://dc01.acme.local:636'); },
  });

// The worse outage: the check itself cannot be answered at all. This is the one
// that trips the fail-closed branch.
const checkThrows = () =>
  makeLdapAuth({ isEnabled: async () => { throw new Error('directory config unreadable'); } });

// ===========================================================================
// 1. Sign-in never consults the guard
// ===========================================================================

test('a local admin can still sign in while the directory is unreachable', async () => {
  const usersRepo = await localAdminRepo();
  const res = await request(makeApp({ usersRepo, ldapAuth: directoryDown() }))
    .post('/auth/login')
    .send({ email: 'root@acme.dk', password: 'correct-horse-battery' });

  assert.equal(res.status, 200, 'an LDAP outage must never block local sign-in');
  assert.ok(res.body.token, 'a JWT is still issued');
  assert.equal(res.body.user.role, 'admin');
  // Fell through to local auth rather than reporting an LDAP success.
  assert.notEqual(res.body.auth, 'ldap');
});

test('a local admin can still sign in when the LDAP enabled-check itself throws', async () => {
  const usersRepo = await localAdminRepo();
  const res = await request(makeApp({ usersRepo, ldapAuth: checkThrows() }))
    .post('/auth/login')
    .send({ email: 'root@acme.dk', password: 'correct-horse-battery' });

  assert.equal(res.status, 200, 'the fail-closed guard must not reach the login path');
  assert.ok(res.body.token);
});

test('a local admin can still sign in when the OIDC enabled-check throws', async () => {
  const usersRepo = await localAdminRepo();
  const oidcAuth = makeOidcAuth({ isEnabled: () => { throw new Error('issuer unreachable'); } });
  const res = await request(makeApp({ usersRepo, oidcAuth }))
    .post('/auth/login')
    .send({ email: 'root@acme.dk', password: 'correct-horse-battery' });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('a wrong password during a directory outage is still 401, not 500', async () => {
  const usersRepo = await localAdminRepo();
  const res = await request(makeApp({ usersRepo, ldapAuth: directoryDown() }))
    .post('/auth/login')
    .send({ email: 'root@acme.dk', password: 'not-the-password' });

  assert.equal(res.status, 401, 'a broken directory must not turn a bad password into a server error');
  assert.equal(res.body.error, 'Invalid credentials');
});

// ===========================================================================
// 2. The guard refuses readably — never a 500
// ===========================================================================

test('the closed guard answers 403 with an actionable reason, not 500', async () => {
  const usersRepo = makeUsersRepo({ findByEmail: async () => null });
  const res = await request(makeApp({ usersRepo, userMailer: makeUserMailer(), ldapAuth: checkThrows() }))
    .post('/users/local')
    .set('Authorization', admin())
    .send({ email: 'new@acme.dk', role: 'viewer' });

  assert.equal(res.status, 403);
  assert.notEqual(res.status, 500, 'an unanswerable check is a refusal, not a crash');
  // The admin is told which method and what to do about it.
  assert.match(res.body.error, /could not determine whether LDAP\/AD sign-in is active/);
  assert.match(res.body.error, /Fix the LDAP\/AD configuration, or disable it/);
});

test('local-availability stays readable (200) so the UI can explain itself', async () => {
  const res = await request(makeApp({ userMailer: makeUserMailer(), ldapAuth: checkThrows() }))
    .get('/users/local-availability')
    .set('Authorization', admin());

  assert.equal(res.status, 200, 'the screen that explains the block must not itself 500');
  assert.equal(res.body.available, false);
  assert.equal(res.body.ssoIndeterminate, true);
  assert.equal(res.body.ssoMethod, 'LDAP/AD');
});

test('resend-temp-password on a missing user is 404 once the guard is open', async () => {
  // No SSO wired, so the guard is open and the route reaches its own lookup —
  // proving the 403 above is the guard talking and not a swallowed 404.
  const usersRepo = makeUsersRepo({ findById: async () => null });
  const res = await request(makeApp({ usersRepo, userMailer: makeUserMailer() }))
    .post('/users/9999/resend-temp-password')
    .set('Authorization', admin())
    .send({});

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'User not found');
});

// ===========================================================================
// 3. The way back in: POST /users is not behind the guard
// ===========================================================================
//
// This is the escape hatch that makes the fail-closed guard safe, and it is
// deliberate rather than an oversight in the guard. The two creation routes are
// not the same thing:
//
//   POST /users        an admin types a password and hands it over out of band.
//                      No mail server needed. NOT gated — this is the recovery
//                      path, and the one an operator uses when the directory is
//                      down.
//   POST /users/local  the server generates a one-time password and EMAILS it.
//                      Gated, because it is the self-service flow that would
//                      quietly grow local accounts behind a live directory.
//
// If somebody ever puts the SSO guard on POST /users too, the lockout becomes
// real: directory down, guard closed, no way to make an account. This test is
// what should stop them.

test('an admin can still create a user while the guard is closed (the way back in)', async () => {
  let created = null;
  const usersRepo = makeUsersRepo({
    findByEmail: async () => null,
    create: async (input) => { created = input; return { id: 9, email: input.email, role: input.role }; },
  });

  const res = await request(makeApp({ usersRepo, ldapAuth: checkThrows() }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'breakglass@acme.dk', name: 'Break Glass', role: 'admin', password: 'Str0ng-Passw0rd!x' });

  assert.equal(res.status, 201, 'the fail-closed guard must leave an admin a way to create an account');
  assert.equal(created.email, 'breakglass@acme.dk');
  assert.ok(created.passwordHash.startsWith('$2'), 'stored as a hash, never plaintext');
});

test('the recovery account can then sign in', async () => {
  // End to end: the account made above is a normal local user, so the login
  // path accepts it with the directory still broken.
  const password_hash = await hashPassword('Str0ng-Passw0rd!x');
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => ({ id: 9, email: 'breakglass@acme.dk', role: 'admin', password_hash, must_change_password: false }),
  });

  const res = await request(makeApp({ usersRepo, ldapAuth: checkThrows() }))
    .post('/auth/login')
    .send({ email: 'breakglass@acme.dk', password: 'Str0ng-Passw0rd!x' });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'admin');
});

// ===========================================================================
// 4. An install with no SSO cannot reach the closed path
// ===========================================================================

test('an install with no SSO wired is untouched by the change', async () => {
  // A null provider is skipped without being called, so nothing can throw and
  // the indeterminate branch is unreachable. The majority of installs are here.
  const res = await request(makeApp({ userMailer: makeUserMailer(), ldapAuth: null, oidcAuth: null, samlAuth: null }))
    .get('/users/local-availability')
    .set('Authorization', admin());

  assert.equal(res.status, 200);
  assert.equal(res.body.ssoActive, false);
  assert.equal(res.body.ssoIndeterminate, false);
  assert.equal(res.body.available, true, 'local creation stays available with no directory in play');
});
