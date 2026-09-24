'use strict';

// Baseline security hardening (migration 041) — the three controls its header
// declares, which until now had a table and a column and no code:
//
//   1. password history   — no reuse of the last N passwords (every set path)
//   2. password max age    — opt-in; a local session with an old password is
//                            held to the change screen (403 password_expired)
//   3. role IP allowlist   — at sign-in and on every authenticated request,
//                            against req.ip (the app's trust-proxy decision)
//
// Unit specs for the pure pieces first, then the HTTP surface end to end over
// makeApp().

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const {
  makeApp, makeUsersRepo, makeSettingsService, makePasswordHistoryRepo, makeAuditLogRepo,
  makeApiTokensRepo, makeLdapAuth, makeOidcAuth, makeSsoLoginAuditRepo, authHeader,
} = require('../test-support/fakes');
const { hashPassword, verifyPassword } = require('../src/auth/password');
const { issueToken } = require('../src/auth/jwt');
const { generateApiToken } = require('../src/lib/apiToken');
const sp = require('../src/auth/securityPolicy');
const { createPasswordHistory } = require('../src/auth/passwordHistory');
const { createPasswordHistoryRepository } = require('../src/repositories/passwordHistoryRepository');
const { upgradeClientIp, upgradeAllowed } = require('../src/auth/securityGate');
const { createAuditLogger } = require('../src/services/complianceLogger');

const DAY = 24 * 60 * 60 * 1000;
const OLD_PW = 'Old-Password-2024!';
const NEW_PW = 'Brand-New-Pw-2026!';

// ============================================================ securityPolicy

test('normalizeIp: IPv4, IPv6, IPv4-mapped, zone ids and junk', () => {
  assert.deepEqual(sp.normalizeIp('10.0.0.1'), { address: '10.0.0.1', family: 'ipv4' });
  assert.deepEqual(sp.normalizeIp('::ffff:10.0.0.1'), { address: '10.0.0.1', family: 'ipv4' });
  assert.deepEqual(sp.normalizeIp('[2001:DB8::1]'), { address: '2001:db8::1', family: 'ipv6' });
  assert.deepEqual(sp.normalizeIp('fe80::1%eth0'), { address: 'fe80::1', family: 'ipv6' });
  for (const bad of [null, undefined, '', 'host.example', '10.0.0', 42, '10.0.0.256']) {
    assert.equal(sp.normalizeIp(bad), null, String(bad));
  }
});

test('parseAllowEntry: addresses are single hosts, prefixes are bounded per family', () => {
  assert.equal(sp.parseAllowEntry('10.1.2.3').cidr, '10.1.2.3/32');
  assert.equal(sp.parseAllowEntry(' 10.0.0.0/8 ').cidr, '10.0.0.0/8');
  assert.equal(sp.parseAllowEntry('2001:db8::/32').cidr, '2001:db8::/32');
  assert.equal(sp.parseAllowEntry('10.0.0.0/33'), null);
  assert.equal(sp.parseAllowEntry('2001:db8::/129'), null);
  assert.equal(sp.parseAllowEntry('10.0.0.0/x'), null);
  assert.equal(sp.parseAllowEntry('example.com/24'), null);
  assert.equal(sp.parseAllowEntry('x'.repeat(100)), null);
});

test('ipInList: v4, v6 and the IPv4-mapped form a dual-stack socket reports', () => {
  assert.equal(sp.ipInList('10.9.8.7', ['10.0.0.0/8']), true);
  assert.equal(sp.ipInList('::ffff:10.9.8.7', ['10.0.0.0/8']), true);
  assert.equal(sp.ipInList('11.0.0.1', ['10.0.0.0/8']), false);
  assert.equal(sp.ipInList('2001:db8:1::5', ['2001:db8::/32']), true);
  assert.equal(sp.ipInList('2001:db9::5', ['2001:db8::/32']), false);
  assert.equal(sp.ipInList('10.0.0.1', ['2001:db8::/32']), false, 'an IPv4 client is not inside an IPv6 range');
  assert.equal(sp.ipInList(null, ['0.0.0.0/0']), false, 'an unreadable address is inside nothing');
  assert.equal(sp.ipInList('10.0.0.1', []), false);
});

test('normalizeSecurity: defaults, and garbage from storage never throws or widens', () => {
  assert.deepEqual(sp.normalizeSecurity(null), {
    passwordHistory: 5, passwordMaxAgeDays: 0, ipAllowlist: { admin: [], operator: [], viewer: [] },
  });
  const eff = sp.normalizeSecurity({
    passwordHistory: 999, passwordMaxAgeDays: -1,
    ipAllowlist: { admin: ['10.0.0.0/8', 'nope', '10.0.0.0/8'], viewer: 'x', bogus: ['1.2.3.4'] },
  });
  assert.equal(eff.passwordHistory, 5);
  assert.equal(eff.passwordMaxAgeDays, 0);
  assert.deepEqual(eff.ipAllowlist, { admin: ['10.0.0.0/8'], operator: [], viewer: [] });
});

test('validateSecurity: bounds, unknown roles, invalid CIDRs; blanks are skipped', () => {
  assert.equal(sp.validateSecurity({}).errors, null);
  let r = sp.validateSecurity({ passwordHistory: 25, passwordMaxAgeDays: 'abc' });
  assert.ok(r.errors.passwordHistory);
  assert.ok(r.errors.passwordMaxAgeDays);
  r = sp.validateSecurity({ ipAllowlist: [] });
  assert.ok(r.errors.ipAllowlist);
  r = sp.validateSecurity({ ipAllowlist: { root: [] } });
  assert.ok(r.errors['ipAllowlist.root']);
  r = sp.validateSecurity({ ipAllowlist: { admin: ['10.0.0.0/8', '300.1.1.1'] } });
  assert.match(r.errors['ipAllowlist.admin'], /300\.1\.1\.1/);
  r = sp.validateSecurity({ ipAllowlist: { admin: ['10.0.0.0/8', '  ', '10.0.0.0/8'], viewer: null } });
  assert.equal(r.errors, null);
  assert.deepEqual(r.value.ipAllowlist, { admin: ['10.0.0.0/8'], viewer: [] });
  r = sp.validateSecurity({ ipAllowlist: { admin: Array.from({ length: 101 }, (_, i) => `10.0.0.${i % 250}`) } });
  assert.ok(r.errors['ipAllowlist.admin']);
});

test('isPasswordExpired / passwordSetAt: off at 0, created_at stands in for a never-changed password', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const set = new Date(now - 91 * DAY);
  assert.equal(sp.isPasswordExpired(set, 0, now), false, '0 = off');
  assert.equal(sp.isPasswordExpired(set, 90, now), true);
  assert.equal(sp.isPasswordExpired(set, 92, now), false);
  assert.equal(sp.isPasswordExpired(null, 90, now), false, 'unknown is never expired');
  assert.equal(sp.passwordSetAt({ password_changed_at: null, created_at: set.toISOString() }).getTime(), set.getTime());
  assert.equal(sp.passwordSetAt({ password_changed_at: '2026-01-01T00:00:00Z', created_at: set }).toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(sp.passwordSetAt({}), null);
});

test('createSecurityPolicy: caches, invalidates, keeps the last-known policy through a read failure', async () => {
  let reads = 0;
  let fail = false;
  let stored = { ipAllowlist: { viewer: ['10.0.0.0/8'] } };
  let t = 0;
  const policy = sp.createSecurityPolicy({
    load: async () => { reads += 1; if (fail) throw new Error('db down'); return stored; },
    ttlMs: 1000, now: () => t,
  });
  assert.deepEqual(policy.checkIp('viewer', '10.1.1.1'), { allowed: true, restricted: false }, 'defaults before the first read');
  await policy.get();
  await policy.get();
  assert.equal(reads, 1, 'served from the cache inside the TTL');
  assert.equal(policy.checkIp('viewer', '10.1.1.1').allowed, true);
  assert.equal(policy.checkIp('viewer', '192.168.1.1').allowed, false);
  assert.equal(policy.checkIp('viewer', 'garbage').reason, 'unknown-address');
  assert.equal(policy.checkIp('admin', '192.168.1.1').allowed, true, 'a role with no list is unrestricted');

  fail = true;
  t = 5000;
  await policy.get();
  assert.equal(policy.checkIp('viewer', '192.168.1.1').allowed, false, 'a failed read must not drop the allowlist');

  fail = false;
  stored = {};
  policy.invalidate();
  await policy.get();
  assert.equal(policy.checkIp('viewer', '192.168.1.1').allowed, true);
});

test('createSecurityPolicy: a failed FIRST read falls back to the defaults (no restriction)', async () => {
  const policy = sp.createSecurityPolicy({ load: async () => { throw new Error('boom'); } });
  const eff = await policy.get();
  assert.equal(eff.passwordHistory, 5);
  assert.equal(policy.checkIp('admin', '1.2.3.4').allowed, true);
});

// ============================================================ passwordHistory

function historyWith(depth, repo = makePasswordHistoryRepo()) {
  const securityPolicy = { get: async () => sp.normalizeSecurity({ passwordHistory: depth }) };
  return { repo, history: createPasswordHistory({ passwordHistoryRepo: repo, securityPolicy }) };
}

test('passwordHistory: refuses the current hash and the remembered ones, allows a new password', async () => {
  const { repo, history } = historyWith(3);
  const h1 = await hashPassword('Pw-One-000001!');
  const h2 = await hashPassword('Pw-Two-000002!');
  await history.remember(9, h1);
  await history.remember(9, h2);
  assert.equal(repo.rows.length, 2);
  assert.deepEqual(await history.checkReuse(9, 'Pw-One-000001!'), { ok: false, depth: 3 });
  const cur = await hashPassword('Current-Pw-99!');
  assert.equal((await history.checkReuse(9, 'Current-Pw-99!', { currentHash: cur })).ok, false, 'the current password counts even with no history');
  assert.equal((await history.checkReuse(9, 'Fresh-Pw-77777!', { currentHash: cur })).ok, true);
  assert.equal((await history.checkReuse(10, 'Pw-One-000001!')).ok, true, 'another user\'s history is not this user\'s');
});

test('passwordHistory: remember prunes to N, and N = 0 disables the check and forgets', async () => {
  const { repo, history } = historyWith(2);
  for (const pw of ['A-password-001!', 'B-password-002!', 'C-password-003!']) {
    await history.remember(4, await hashPassword(pw));
  }
  assert.equal(repo.rows.filter((r) => r.user_id === 4).length, 2, 'pruned to the policy depth');
  assert.equal((await history.checkReuse(4, 'A-password-001!')).ok, true, 'the oldest fell out of the window');
  assert.equal((await history.checkReuse(4, 'C-password-003!')).ok, false);

  const off = historyWith(0, repo).history;
  assert.equal((await off.checkReuse(4, 'C-password-003!')).ok, true, '0 disables the check');
  await off.remember(4, await hashPassword('D-password-004!'));
  assert.equal(repo.rows.filter((r) => r.user_id === 4).length, 0, 'switching it off keeps no hashes around');
});

test('passwordHistory: a failing repository never fails the change that already happened', async () => {
  const repo = makePasswordHistoryRepo({ record: async () => { throw new Error('db down'); } });
  const { history } = historyWith(5, repo);
  await history.remember(1, 'h'); // must not throw
});

test('passwordHistoryRepository: the statements and parameters it issues', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^SELECT password_hash/.test(sql)) return [[{ password_hash: 'h2' }, { password_hash: 'h1' }]];
      if (/^SELECT id FROM password_history/.test(sql)) return [[{ id: 40 }]];
      return [{ affectedRows: 3 }];
    },
  };
  const repo = createPasswordHistoryRepository({ pool });
  assert.deepEqual(await repo.recentHashes(7, 5), ['h2', 'h1']);
  assert.match(queries[0].sql, /WHERE user_id = \? ORDER BY id DESC LIMIT \?/);
  assert.deepEqual(queries[0].params, [7, 5]);
  assert.deepEqual(await repo.recentHashes(7, 0), [], 'no query for a zero limit');
  assert.equal(queries.length, 1);

  await repo.record(7, '$2a$hash');
  assert.deepEqual(queries[1].params, [7, '$2a$hash']);

  assert.equal(await repo.prune(7, 5), 3);
  assert.deepEqual(queries[2].params, [7, 4], 'OFFSET keep-1 finds the oldest row worth keeping');
  assert.match(queries[3].sql, /DELETE FROM password_history WHERE user_id = \? AND id < \?/);
  assert.deepEqual(queries[3].params, [7, 40]);

  assert.equal(await repo.prune(7, 0), 3);
  assert.match(queries[4].sql, /^DELETE FROM password_history WHERE user_id = \?$/);
});

// ============================================================ helpers for the API

// A settings service with a stored `security` policy.
const settingsWith = (security) => makeSettingsService({ initial: security ? { security } : {} });

// A local user row as findByEmailWithHash returns it.
async function localUser({ id = 5, email = 'op@acme.dk', role = 'operator', pw = OLD_PW, changedDaysAgo = 1, createdDaysAgo = 400 } = {}) {
  return {
    id, email, role,
    password_hash: await hashPassword(pw),
    password_changed_at: changedDaysAgo === null ? null : new Date(Date.now() - changedDaysAgo * DAY),
    created_at: new Date(Date.now() - createdDaysAgo * DAY),
    must_change_password: false,
  };
}

// A token as the local sign-in mints it (carries pwdAt).
const localToken = (role, { id = 5, email = 'op@acme.dk', setDaysAgo = 1 } = {}) =>
  `Bearer ${issueToken({ id, email, role, passwordSetAt: new Date(Date.now() - setDaysAgo * DAY) })}`;

// ============================================================ 1. password history (HTTP)

test('POST /auth/change-password refuses a recent password with 400 password_reused and a translation key', async () => {
  const user = await localUser();
  const passwordHistoryRepo = makePasswordHistoryRepo({
    initial: [{ id: 1, user_id: 5, password_hash: await hashPassword(NEW_PW) }],
  });
  let cleared = false;
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user, clearTempPassword: async () => { cleared = true; return {}; } });
  const res = await request(makeApp({ usersRepo, passwordHistoryRepo }))
    .post('/auth/change-password').set('Authorization', localToken('operator'))
    .send({ currentPassword: OLD_PW, newPassword: NEW_PW });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'password_reused');
  assert.equal(res.body.messageKey, 'auth.pw.reused');
  assert.deepEqual(res.body.messageParams, { n: 5 });
  assert.ok(res.body.details.newPassword);
  assert.equal(cleared, false, 'nothing was changed');
});

test('POST /auth/change-password records the new hash, prunes, and mints a token carrying the new set time', async () => {
  const user = await localUser();
  const passwordHistoryRepo = makePasswordHistoryRepo();
  let stored = null;
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user, clearTempPassword: async (id, h) => { stored = h; return {}; } });
  const app = makeApp({ usersRepo, passwordHistoryRepo, settingsService: settingsWith({ passwordHistory: 2 }) });
  const res = await request(app).post('/auth/change-password').set('Authorization', localToken('operator'))
    .send({ currentPassword: OLD_PW, newPassword: NEW_PW });
  assert.equal(res.status, 200);
  assert.equal(passwordHistoryRepo.rows.length, 1);
  assert.equal(passwordHistoryRepo.rows[0].password_hash, stored);
  assert.ok(await verifyPassword(NEW_PW, passwordHistoryRepo.rows[0].password_hash));
  const claims = jwt.decode(res.body.token);
  assert.ok(Math.abs(claims.pwdAt * 1000 - Date.now()) < 5000, 'pwdAt is "now"');
});

test('POST /auth/change-password: history 0 = off (only the no-op change is still refused)', async () => {
  const user = await localUser();
  const passwordHistoryRepo = makePasswordHistoryRepo({ initial: [{ id: 1, user_id: 5, password_hash: await hashPassword(NEW_PW) }] });
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user });
  const app = makeApp({ usersRepo, passwordHistoryRepo, settingsService: settingsWith({ passwordHistory: 0 }) });
  const ok = await request(app).post('/auth/change-password').set('Authorization', localToken('operator'))
    .send({ currentPassword: OLD_PW, newPassword: NEW_PW });
  assert.equal(ok.status, 200);
  const same = await request(app).post('/auth/change-password').set('Authorization', localToken('operator'))
    .send({ currentPassword: OLD_PW, newPassword: OLD_PW });
  assert.equal(same.status, 422);
});

test('PUT /users/:id (admin reset) obeys the history and records the new hash; POST /users records too', async () => {
  const target = await localUser({ id: 8, email: 'v@acme.dk', role: 'viewer' });
  const passwordHistoryRepo = makePasswordHistoryRepo();
  const usersRepo = makeUsersRepo({
    findById: async (id) => (id === 8 ? { id: 8, email: 'v@acme.dk', role: 'viewer', protected: false } : null),
    findByEmailWithHash: async () => target,
    update: async (id, patch) => ({ id, email: 'v@acme.dk', role: patch.role }),
    create: async (u) => ({ id: 11, email: u.email, role: u.role }),
  });
  const app = makeApp({ usersRepo, passwordHistoryRepo });

  // The user's CURRENT password is refused as a "reset".
  const reuse = await request(app).put('/users/8').set('Authorization', authHeader('admin'))
    .send({ role: 'viewer', password: OLD_PW });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, 'password_reused');
  assert.ok(reuse.body.details.password, 'the error belongs to the password field');

  const ok = await request(app).put('/users/8').set('Authorization', authHeader('admin'))
    .send({ role: 'viewer', password: NEW_PW });
  assert.equal(ok.status, 200);
  assert.deepEqual(passwordHistoryRepo.rows.map((r) => r.user_id), [8]);

  const created = await request(app).post('/users').set('Authorization', authHeader('admin'))
    .send({ email: 'new@acme.dk', password: 'Created-Pw-2026!', role: 'viewer' });
  assert.equal(created.status, 201);
  assert.deepEqual(passwordHistoryRepo.rows.map((r) => r.user_id), [8, 11]);

  // 404 / 400 contracts of the reset path are unchanged.
  assert.equal((await request(app).put('/users/99').set('Authorization', authHeader('admin')).send({ role: 'viewer', password: NEW_PW })).status, 404);
  assert.equal((await request(app).put('/users/abc').set('Authorization', authHeader('admin')).send({ role: 'viewer' })).status, 400);
});

test('an LDAP sign-in is never recorded in the history and its token carries no pwdAt', async () => {
  const passwordHistoryRepo = makePasswordHistoryRepo();
  const ldapAuth = makeLdapAuth({
    isEnabled: async () => true,
    authenticate: async () => ({ enabled: true, ok: true, email: 'dir@acme.dk', role: 'viewer', matched: 1 }),
  });
  const usersRepo = makeUsersRepo({ findByEmail: async () => ({ id: 21, email: 'dir@acme.dk', role: 'viewer' }) });
  const res = await request(makeApp({ ldapAuth, usersRepo, passwordHistoryRepo, settingsService: settingsWith({ passwordMaxAgeDays: 1 }) }))
    .post('/auth/login').send({ email: 'dir', password: 'whatever-the-directory-says' });
  assert.equal(res.status, 200);
  assert.equal(res.body.auth, 'ldap');
  assert.equal(passwordHistoryRepo.rows.length, 0);
  assert.equal(jwt.decode(res.body.token).pwdAt, undefined);
  assert.equal(res.body.passwordExpired, undefined);
});

// ============================================================ 2. password max age (HTTP)

test('max age: an old local password signs in flagged passwordExpired and is held to the change screen', async () => {
  const user = await localUser({ changedDaysAgo: 100 });
  let current = user;
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => current,
    clearTempPassword: async () => ({}),
  });
  const audit = makeAuditLogRepo();
  const app = makeApp({ usersRepo, auditLogRepo: audit, auditLogger: createAuditLogger({ auditLogRepo: audit }), settingsService: settingsWith({ passwordMaxAgeDays: 90 }) });

  const login = await request(app).post('/auth/login').send({ email: user.email, password: OLD_PW });
  assert.equal(login.status, 200);
  assert.equal(login.body.passwordExpired, true);
  assert.ok(audit.rows.some((r) => r.action === 'login_success' && /password_expired/.test(r.detail)));
  const bearer = `Bearer ${login.body.token}`;

  const blocked = await request(app).get('/agents').set('Authorization', bearer);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'password_expired');
  assert.equal(blocked.body.messageKey, 'auth.fc.expiredLead');
  assert.equal((await request(app).get('/me').set('Authorization', bearer)).status, 200, '/me stays reachable');

  const changed = await request(app).post('/auth/change-password').set('Authorization', bearer)
    .send({ currentPassword: OLD_PW, newPassword: NEW_PW });
  assert.equal(changed.status, 200, 'the change endpoint stays reachable');
  assert.equal((await request(app).get('/agents').set('Authorization', `Bearer ${changed.body.token}`)).status, 200);
});

test('max age: a never-changed password falls back to created_at; 0 (the default) never expires', async () => {
  const legacy = await localUser({ changedDaysAgo: null, createdDaysAgo: 400 });
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => legacy });
  const on = await request(makeApp({ usersRepo, settingsService: settingsWith({ passwordMaxAgeDays: 365 }) }))
    .post('/auth/login').send({ email: legacy.email, password: OLD_PW });
  assert.equal(on.body.passwordExpired, true);
  const off = await request(makeApp({ usersRepo })).post('/auth/login').send({ email: legacy.email, password: OLD_PW });
  assert.equal(off.status, 200);
  assert.equal(off.body.passwordExpired, undefined);
  assert.equal((await request(makeApp({ usersRepo })).get('/agents').set('Authorization', `Bearer ${off.body.token}`)).status, 200);
});

test('max age never applies to SSO/LDAP sessions (no pwdAt) or API tokens', async () => {
  const settingsService = settingsWith({ passwordMaxAgeDays: 1 });
  // An SSO/LDAP-minted token — issued without passwordSetAt.
  assert.equal((await request(makeApp({ settingsService })).get('/agents').set('Authorization', authHeader('operator'))).status, 200);
  // A local token with an old password IS held.
  assert.equal((await request(makeApp({ settingsService })).get('/agents').set('Authorization', localToken('operator', { setDaysAgo: 3 }))).status, 403);
  // An API token.
  const apiTokensRepo = makeApiTokensRepo();
  const { token, hash, prefix } = generateApiToken();
  await apiTokensRepo.create({ name: 'ci', tokenHash: hash, tokenPrefix: prefix, role: 'operator' });
  const res = await request(makeApp({ settingsService, apiTokensRepo })).get('/agents').set('X-API-Key', token);
  assert.equal(res.status, 200);
});

// ============================================================ 3. IP allowlist (HTTP)

test('GET/PUT /api/settings/security: 401 anonymous, 403 non-admin, 400 invalid, 200 valid', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/api/settings/security')).status, 401);
  assert.equal((await request(app).get('/api/settings/security').set('Authorization', authHeader('operator'))).status, 403);
  assert.equal((await request(app).put('/api/settings/security').set('Authorization', authHeader('viewer')).send({})).status, 403);

  const get = await request(app).get('/api/settings/security').set('Authorization', authHeader('admin'));
  assert.equal(get.status, 200);
  assert.equal(get.body.passwordHistory, 5);
  assert.equal(get.body.passwordMaxAgeDays, 0);
  assert.deepEqual(get.body.ipAllowlist, { admin: [], operator: [], viewer: [] });
  assert.match(get.body.yourIp, /127\.0\.0\.1/);
  assert.equal(get.body.limits.passwordHistoryMax, 24);

  const bad = await request(app).put('/api/settings/security').set('Authorization', authHeader('admin'))
    .send({ passwordHistory: 99, ipAllowlist: { viewer: ['not-an-ip'] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Validation failed');
  assert.ok(bad.body.details.passwordHistory);
  assert.ok(bad.body.details['ipAllowlist.viewer']);

  const ok = await request(app).put('/api/settings/security').set('Authorization', authHeader('admin'))
    .send({ passwordHistory: 3, passwordMaxAgeDays: 180, ipAllowlist: { viewer: ['10.0.0.0/8'] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.passwordHistory, 3);
  assert.deepEqual(ok.body.ipAllowlist.viewer, ['10.0.0.0/8']);
  // A partial patch keeps the rest.
  const partial = await request(app).put('/api/settings/security').set('Authorization', authHeader('admin')).send({ passwordHistory: 4 });
  assert.equal(partial.body.passwordMaxAgeDays, 180);
  assert.deepEqual(partial.body.ipAllowlist.viewer, ['10.0.0.0/8']);
});

test('PUT /api/settings/security: 500 when the store fails, through the shared error handler', async () => {
  const settingsService = settingsWith();
  settingsService.setSecurity = async () => { throw new Error('ER_LOCK_DEADLOCK secret sql detail'); };
  const res = await request(makeApp({ settingsService })).put('/api/settings/security')
    .set('Authorization', authHeader('admin')).send({ passwordHistory: 3 });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

test('lock-out guard: an admin allowlist that excludes the saving admin is refused (409) and nothing is saved', async () => {
  const audit = makeAuditLogRepo();
  const settingsService = settingsWith();
  const app = makeApp({ settingsService, auditLogRepo: audit, auditLogger: createAuditLogger({ auditLogRepo: audit }) });
  const res = await request(app).put('/api/settings/security').set('Authorization', authHeader('admin'))
    .send({ ipAllowlist: { admin: ['10.20.0.0/16'] } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'allowlist_excludes_you');
  assert.equal(res.body.messageKey, 'set.sec.err.selfLockout');
  assert.match(res.body.message, /127\.0\.0\.1/);
  assert.deepEqual((await settingsService.getSecurity()).ipAllowlist.admin, []);
  assert.ok(audit.rows.some((r) => r.action === 'security_settings_update' && r.outcome === 'denied'));

  // Including the admin's own address is fine, and is audited.
  const ok = await request(app).put('/api/settings/security').set('Authorization', authHeader('admin'))
    .send({ ipAllowlist: { admin: ['10.20.0.0/16', '127.0.0.0/8'] } });
  assert.equal(ok.status, 200);
  assert.ok(audit.rows.some((r) => r.action === 'security_settings_update' && r.outcome === 'success'));
  // Restricting OTHER roles away from the admin's address is not a self lock-out.
  const other = await request(app).put('/api/settings/security').set('Authorization', authHeader('admin'))
    .send({ ipAllowlist: { viewer: ['10.20.0.0/16'] } });
  assert.equal(other.status, 200);
});

test('the saved allowlist applies at once to the next request (no restart, no TTL wait)', async () => {
  const app = makeApp();
  assert.equal((await request(app).get('/agents').set('Authorization', authHeader('viewer'))).status, 200);
  await request(app).put('/api/settings/security').set('Authorization', authHeader('admin'))
    .send({ ipAllowlist: { viewer: ['10.0.0.0/8'] } });
  assert.equal((await request(app).get('/agents').set('Authorization', authHeader('viewer'))).status, 403);
});

test('IP allowlist at sign-in: a role outside its list gets 403 ip_not_allowed and a denied audit row', async () => {
  const user = await localUser({ role: 'viewer' });
  const audit = makeAuditLogRepo();
  const usersRepo = makeUsersRepo({ findByEmailWithHash: async () => user });
  const app = makeApp({
    usersRepo, auditLogRepo: audit, auditLogger: createAuditLogger({ auditLogRepo: audit }),
    settingsService: settingsWith({ ipAllowlist: { viewer: ['10.0.0.0/8'] } }),
  });
  const res = await request(app).post('/auth/login').send({ email: user.email, password: OLD_PW });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'ip_not_allowed');
  assert.equal(res.body.token, undefined, 'no token is minted');
  const row = audit.rows.find((r) => r.action === 'login_ip_denied');
  assert.ok(row);
  assert.equal(row.outcome, 'denied');
  assert.match(row.detail, /auth=local; not-in-allowlist/);

  // A wrong password from the same address is still the ordinary 401 — the
  // allowlist is only consulted once the credential is known good.
  assert.equal((await request(app).post('/auth/login').send({ email: user.email, password: 'Wrong-Password-1!' })).status, 401);
});

test('IP allowlist on requests: blocked with 403, audited once per window, other roles unaffected', async () => {
  const audit = makeAuditLogRepo();
  const app = makeApp({
    auditLogRepo: audit, auditLogger: createAuditLogger({ auditLogRepo: audit }),
    settingsService: settingsWith({ ipAllowlist: { operator: ['192.0.2.0/24'], admin: ['127.0.0.1'] } }),
  });
  const r1 = await request(app).get('/agents').set('Authorization', authHeader('operator'));
  const r2 = await request(app).get('/locations').set('Authorization', authHeader('operator'));
  assert.equal(r1.status, 403);
  assert.equal(r1.body.error, 'ip_not_allowed');
  assert.equal(r2.status, 403);
  assert.equal(audit.rows.filter((r) => r.action === 'ip_denied').length, 1, 'a flood is one audit row, not one per request');
  assert.equal((await request(app).get('/agents').set('Authorization', authHeader('viewer'))).status, 200, 'viewer has no list');
  assert.equal((await request(app).get('/agents').set('Authorization', authHeader('admin'))).status, 200, 'admin is inside its list');
  // Anonymous requests are not the gate's business — the routers answer 401.
  assert.equal((await request(app).get('/agents')).status, 401);
  // The sign-in screen's public read is never blocked.
  assert.equal((await request(app).get('/auth/sso').set('Authorization', authHeader('operator'))).status, 200);
});

test('IP allowlist applies to API tokens by their role', async () => {
  const apiTokensRepo = makeApiTokensRepo();
  const { token, hash, prefix } = generateApiToken();
  await apiTokensRepo.create({ name: 'ci', tokenHash: hash, tokenPrefix: prefix, role: 'operator' });
  const app = makeApp({ apiTokensRepo, settingsService: settingsWith({ ipAllowlist: { operator: ['192.0.2.0/24'] } }) });
  const res = await request(app).get('/agents').set('X-API-Key', token);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'ip_not_allowed');
});

test('X-Forwarded-For is ignored unless TRUST_PROXY is on — and then only the proxy-appended hop counts', async () => {
  const settingsService = settingsWith({ ipAllowlist: { viewer: ['10.0.0.0/8'] } });
  // Direct exposure: a client cannot talk its way in with a header.
  const spoof = await request(makeApp({ settingsService })).get('/agents')
    .set('Authorization', authHeader('viewer')).set('X-Forwarded-For', '10.1.1.1');
  assert.equal(spoof.status, 403);

  const prev = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = 'true';
  try {
    const app = makeApp({ settingsService: settingsWith({ ipAllowlist: { viewer: ['10.0.0.0/8'] } }) });
    // One trusted hop: the address the proxy appended (the last one) is the client.
    const viaProxy = await request(app).get('/agents').set('Authorization', authHeader('viewer')).set('X-Forwarded-For', '203.0.113.9, 10.1.1.1');
    assert.equal(viaProxy.status, 200);
    const forgedFirst = await request(app).get('/agents').set('Authorization', authHeader('viewer')).set('X-Forwarded-For', '10.1.1.1, 203.0.113.9');
    assert.equal(forgedFirst.status, 403, 'a forged leftmost hop is not the client');
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
  }
});

test('OIDC callback: an IdP-approved user outside the role allowlist is redirected with ip-not-allowed', async () => {
  const oidcAuth = makeOidcAuth({
    isEnabled: () => true,
    createLoginRequest: async () => ({ url: 'https://idp.example/auth', state: 'st8', nonce: 'nce', codeVerifier: 'ver' }),
    handleCallback: async () => ({ ok: true, email: 'alice@acme.dk', role: 'operator', subject: 'sub-1', matched: 1 }),
  });
  const usersRepo = makeUsersRepo({ findByEmail: async () => ({ id: 7, email: 'alice@acme.dk', role: 'operator' }) });
  const ssoAudit = makeSsoLoginAuditRepo();
  const app = makeApp({ oidcAuth, usersRepo, ssoLoginAuditRepo: ssoAudit, settingsService: settingsWith({ ipAllowlist: { operator: ['192.0.2.0/24'] } }) });
  const login = await request(app).get('/auth/oidc/login');
  const cookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('blueeye_oidc_tx=')).split(';')[0];
  const cb = await request(app).get('/auth/oidc/callback?code=abc&state=st8').set('Cookie', cookie);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.location, /sso_error=ip-not-allowed/);
  assert.doesNotMatch(cb.headers.location, /sso_token/);
  assert.equal(ssoAudit.rows[0].reason, 'ip-not-allowed');
});

// ============================================================ WebSocket upgrade helpers

test('upgradeClientIp mirrors trust proxy: socket peer by default, last XFF hop when trusted', () => {
  const req = { socket: { remoteAddress: '::ffff:192.0.2.1' }, headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.7' } };
  assert.equal(upgradeClientIp(req, false), '::ffff:192.0.2.1');
  assert.equal(upgradeClientIp(req, true), '198.51.100.7');
  assert.equal(upgradeClientIp({ socket: { remoteAddress: '192.0.2.1' }, headers: {} }, true), '192.0.2.1');
});

test('upgradeAllowed: the dashboard socket obeys the allowlist and the max age', () => {
  const policy = sp.createSecurityPolicy({ load: async () => null });
  policy.set({ passwordMaxAgeDays: 30, ipAllowlist: { viewer: ['10.0.0.0/8'] } });
  assert.equal(upgradeAllowed(policy, { role: 'viewer' }, '10.1.1.1'), true);
  assert.equal(upgradeAllowed(policy, { role: 'viewer' }, '192.0.2.1'), false);
  assert.equal(upgradeAllowed(policy, { role: 'admin', pwdAt: Math.floor((Date.now() - 31 * DAY) / 1000) }, '192.0.2.1'), false);
  assert.equal(upgradeAllowed(policy, { role: 'admin', pwdAt: Math.floor((Date.now() - 2 * DAY) / 1000) }, '192.0.2.1'), true);
  assert.equal(upgradeAllowed(null, { role: 'viewer' }, '192.0.2.1'), true, 'no policy wired = no restriction');
});
