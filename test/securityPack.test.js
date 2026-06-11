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
  makeSettingsService,
  makeFeatureGate,
  authHeader,
} = require('../test-support/fakes');
const { hashPassword } = require('../src/auth/password');

const admin = () => authHeader('admin');

// Builds a settingsService pre-seeded with a security-pack config override.
function securitySettings(security) {
  return makeSettingsService({ initial: { security } });
}

// ---- 1. Password policy (422) ----------------------------------------------
test('POST /users rejects a policy-violating password with 422', async () => {
  const settingsService = securitySettings({ passwordPolicy: { enabled: true, minLength: 12, requireUppercase: true, requireDigit: true } });
  const res = await request(makeApp({ settingsService }))
    .post('/users')
    .set('Authorization', admin())
    // Passes base validation (>= 8 chars) but fails policy (no uppercase/digit).
    .send({ email: 'new@blueeye.local', password: 'lowercaseonly', role: 'viewer' });
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, 'password_policy');
  assert.ok(Array.isArray(res.body.violations) && res.body.violations.length > 0);
});

test('POST /users accepts a compliant password', async () => {
  const settingsService = securitySettings({ passwordPolicy: { enabled: true, minLength: 12, requireUppercase: true, requireDigit: true } });
  const res = await request(makeApp({ settingsService }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'new@blueeye.local', password: 'Sup3rSecretPass', role: 'viewer' });
  assert.equal(res.status, 201);
});

test('password policy is a no-op without the security_pack licence', async () => {
  const settingsService = securitySettings({ passwordPolicy: { enabled: true, minLength: 20 } });
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'security_pack' });
  const res = await request(makeApp({ settingsService, featureGate }))
    .post('/users')
    .set('Authorization', admin())
    .send({ email: 'new@blueeye.local', password: 'short8chr', role: 'viewer' });
  assert.equal(res.status, 201); // policy not enforced ⇒ base validation only
});

test('PUT /users/:id reuse of a recent password is rejected with 422', async () => {
  const oldHash = await hashPassword('OldPassw0rdValue');
  const usersRepo = makeUsersRepo({
    findById: async () => ({ id: 2, email: 'u@blueeye.local', role: 'viewer', protected: false }),
    recentPasswordHashes: async () => [oldHash],
  });
  const settingsService = securitySettings({ passwordPolicy: { enabled: true, minLength: 8, historyCount: 5, requireUppercase: false, requireDigit: false } });
  const res = await request(makeApp({ usersRepo, settingsService }))
    .put('/users/2')
    .set('Authorization', admin())
    .send({ role: 'viewer', password: 'OldPassw0rdValue' });
  assert.equal(res.status, 422);
  assert.ok(res.body.violations.some((v) => v.code === 'reuse'));
});

// ---- self-service password change (PUT /me/password) -----------------------
test('PUT /me/password requires the correct current password', async () => {
  const usersRepo = makeUsersRepo({
    findByIdWithHash: async () => ({ id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('RightCurrent1'), role: 'admin' }),
  });
  const res = await request(makeApp({ usersRepo }))
    .put('/me/password')
    .set('Authorization', admin())
    .send({ currentPassword: 'WrongCurrent', newPassword: 'BrandNewPass123' });
  assert.equal(res.status, 401);
});

test('PUT /me/password enforces the policy then changes the password', async () => {
  let changed = false;
  const usersRepo = makeUsersRepo({
    findByIdWithHash: async () => ({ id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('RightCurrent1'), role: 'admin' }),
    recentPasswordHashes: async () => [],
    changePassword: async () => { changed = true; return { id: 1 }; },
  });
  const settingsService = securitySettings({ passwordPolicy: { enabled: true, minLength: 12, requireUppercase: true, requireDigit: true } });
  const app = makeApp({ usersRepo, settingsService });

  const weak = await request(app).put('/me/password').set('Authorization', admin())
    .send({ currentPassword: 'RightCurrent1', newPassword: 'short' });
  assert.equal(weak.status, 422);
  assert.equal(changed, false);

  const ok = await request(app).put('/me/password').set('Authorization', admin())
    .send({ currentPassword: 'RightCurrent1', newPassword: 'AnotherGood9Pass' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(changed, true);
});

// ---- 2. Brute-force lockout (429) ------------------------------------------
test('repeated failed logins lock the account with 429 + Retry-After', async () => {
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => ({ id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('CorrectHorse1'), role: 'admin' }),
  });
  const settingsService = securitySettings({ lockout: { enabled: true, maxAttempts: 2, baseBackoffSeconds: 60 } });
  const app = makeApp({ usersRepo, settingsService });

  // maxAttempts=2 ⇒ failures 1,2,3 are 401; the 3rd trips the lock, so #4 is 429.
  for (let i = 0; i < 3; i += 1) {
    const r = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'nope' });
    assert.equal(r.status, 401);
  }
  const locked = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'nope' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.body.retryAfter) > 0);
  assert.ok(locked.headers['retry-after']);

  // Even the CORRECT password is refused while locked (distinguishable in audit).
  const stillLocked = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'CorrectHorse1' });
  assert.equal(stillLocked.status, 429);
});

test('lockout is inert when disabled', async () => {
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => ({ id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('CorrectHorse1'), role: 'admin' }),
  });
  const app = makeApp({ usersRepo }); // default config: lockout disabled
  for (let i = 0; i < 6; i += 1) {
    const r = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'nope' });
    assert.equal(r.status, 401);
  }
});

// ---- 3. IP allowlist (403) -------------------------------------------------
test('login from a non-allowlisted IP is refused with 403', async () => {
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => ({ id: 1, email: 'admin@blueeye.local', password_hash: await hashPassword('CorrectHorse1'), role: 'admin' }),
  });
  const settingsService = securitySettings({ ipAllowlist: { enabled: true, global: ['203.0.113.0/24'] } });
  const app = makeApp({ usersRepo, settingsService });

  const denied = await request(app).post('/auth/login')
    .set('X-Forwarded-For', '198.51.100.7')
    .send({ email: 'admin@blueeye.local', password: 'CorrectHorse1' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.reason, 'ip_not_allowlisted');

  const allowed = await request(app).post('/auth/login')
    .set('X-Forwarded-For', '203.0.113.42')
    .send({ email: 'admin@blueeye.local', password: 'CorrectHorse1' });
  assert.equal(allowed.status, 200);
  assert.ok(allowed.body.token);
});

// ---- 4. Tamper-evident audit log -------------------------------------------
test('GET /api/audit-log/verify reports an intact chain (admin only, gated)', async () => {
  const app = makeApp();
  const ok = await request(app).get('/api/audit-log/verify').set('Authorization', admin());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);

  const viewer = await request(app).get('/api/audit-log/verify').set('Authorization', authHeader('viewer'));
  assert.equal(viewer.status, 403);
});

test('GET /api/audit-log/verify is licence-gated (audit_log)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'audit_log' });
  const res = await request(makeApp({ featureGate })).get('/api/audit-log/verify').set('Authorization', admin());
  assert.equal(res.status, 403);
  assert.equal(res.body.feature, 'audit_log');
});

// ---- security settings API --------------------------------------------------
test('GET /api/settings/security returns config + licensed flag', async () => {
  const res = await request(makeApp()).get('/api/settings/security').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.licensed, true);
  assert.equal(res.body.security.passwordPolicy.enabled, false); // off by default
});

test('PUT /api/settings/security persists a valid patch', async () => {
  const app = makeApp();
  const res = await request(app).put('/api/settings/security').set('Authorization', admin())
    .send({ passwordPolicy: { enabled: true, minLength: 16 }, ipAllowlist: { enabled: true, global: ['10.0.0.0/8'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.security.passwordPolicy.minLength, 16);
  assert.deepEqual(res.body.security.ipAllowlist.global, ['10.0.0.0/8']);
});

test('PUT /api/settings/security rejects an invalid CIDR with 400', async () => {
  const res = await request(makeApp()).put('/api/settings/security').set('Authorization', admin())
    .send({ ipAllowlist: { enabled: true, global: ['not-a-cidr'] } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('PUT /api/settings/security is 403 without the security_pack licence', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'security_pack' });
  const res = await request(makeApp({ featureGate })).put('/api/settings/security').set('Authorization', admin())
    .send({ passwordPolicy: { enabled: true } });
  assert.equal(res.status, 403);
  assert.equal(res.body.feature, 'security_pack');
});
