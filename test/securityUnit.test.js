'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePassword, isExpired, normalizePolicy } = require('../src/security/passwordPolicy');
const { backoffSeconds, lockState, normalizeLockout } = require('../src/security/lockout');
const { ipInCidr, isAllowed, parseCidr } = require('../src/security/ipAllowlist');
const { entryHashFor, canonicalFields } = require('../src/repositories/auditLogRepository');

// ---- password policy --------------------------------------------------------
test('password policy flags each missing class with a stable code', () => {
  const policy = { enabled: true, minLength: 12, requireUppercase: true, requireLowercase: true, requireDigit: true, requireSymbol: true };
  const codes = evaluatePassword('short', policy).violations.map((v) => v.code).sort();
  assert.deepEqual(codes, ['digit', 'min_length', 'symbol', 'uppercase']);
});

test('password policy passes a compliant password', () => {
  const policy = { enabled: true, minLength: 12, requireUppercase: true, requireLowercase: true, requireDigit: true, requireSymbol: true };
  const res = evaluatePassword('Sup3rSecret!!', policy);
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

test('normalizePolicy clamps minLength into [8,72]', () => {
  assert.equal(normalizePolicy({ minLength: 2 }).minLength, 8);
  assert.equal(normalizePolicy({ minLength: 999 }).minLength, 72);
});

test('isExpired honours maxAgeDays only when enabled', () => {
  const old = new Date(Date.now() - 100 * 24 * 3600 * 1000);
  assert.equal(isExpired(old, { enabled: true, maxAgeDays: 90 }), true);
  assert.equal(isExpired(old, { enabled: true, maxAgeDays: 0 }), false); // 0 disables
  assert.equal(isExpired(old, { enabled: false, maxAgeDays: 90 }), false);
  assert.equal(isExpired(null, { enabled: true, maxAgeDays: 90 }), false); // unknown
});

// ---- lockout backoff --------------------------------------------------------
test('backoff is zero up to maxAttempts then doubles, capped', () => {
  const pol = { maxAttempts: 3, baseBackoffSeconds: 60, maxBackoffSeconds: 600 };
  assert.equal(backoffSeconds(3, pol), 0); // not yet over
  assert.equal(backoffSeconds(4, pol), 60); // first lockout
  assert.equal(backoffSeconds(5, pol), 120);
  assert.equal(backoffSeconds(6, pol), 240);
  assert.equal(backoffSeconds(99, pol), 600); // capped
});

test('lockState reports remaining seconds and clears once past', () => {
  const future = new Date(Date.now() + 30 * 1000);
  const past = new Date(Date.now() - 5 * 1000);
  assert.equal(lockState(future).locked, true);
  assert.ok(lockState(future).retryAfterSeconds > 0);
  assert.equal(lockState(past).locked, false);
  assert.equal(lockState(null).locked, false);
});

test('normalizeLockout clamps maxAttempts to >= 1', () => {
  assert.equal(normalizeLockout({ maxAttempts: 0 }).maxAttempts, 1);
});

// ---- IP allowlist -----------------------------------------------------------
test('ipInCidr matches IPv4 and IPv6 ranges', () => {
  assert.equal(ipInCidr('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(ipInCidr('11.1.2.3', '10.0.0.0/8'), false);
  assert.equal(ipInCidr('192.168.1.5', '192.168.1.5'), true); // bare = /32
  assert.equal(ipInCidr('2001:db8::1', '2001:db8::/32'), true);
  assert.equal(ipInCidr('2001:dead::1', '2001:db8::/32'), false);
  assert.equal(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8'), true); // mapped v4
});

test('parseCidr rejects malformed input', () => {
  assert.equal(parseCidr('not-an-ip'), null);
  assert.equal(parseCidr('10.0.0.0/33'), null);
  assert.equal(parseCidr(''), null);
});

test('isAllowed: disabled or empty list never restricts', () => {
  assert.deepEqual(isAllowed('1.2.3.4', 'admin', { enabled: false }), { allowed: true, restricted: false });
  assert.deepEqual(isAllowed('1.2.3.4', 'admin', { enabled: true, global: [], roles: {} }), { allowed: true, restricted: false });
});

test('isAllowed: global UNION role list decides', () => {
  const rules = { enabled: true, global: ['10.0.0.0/8'], roles: { admin: ['192.168.0.0/16'] } };
  assert.equal(isAllowed('10.5.5.5', 'viewer', rules).allowed, true); // global
  assert.equal(isAllowed('192.168.1.1', 'admin', rules).allowed, true); // role
  assert.equal(isAllowed('192.168.1.1', 'viewer', rules).allowed, false); // role list not theirs
  assert.equal(isAllowed('8.8.8.8', 'admin', rules).allowed, false);
});

// ---- audit hash chain helpers ----------------------------------------------
test('entryHashFor is deterministic and chains on prev_hash', () => {
  const row = { category: 'auth', action: 'login_success', outcome: 'success', actor_email: 'a@b.c' };
  const h1 = entryHashFor('', row);
  const h2 = entryHashFor('', row);
  assert.equal(h1, h2); // deterministic
  assert.notEqual(entryHashFor('deadbeef', row), h1); // prev_hash changes it
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('canonicalFields ignores created_at / id and sorts keys', () => {
  const a = canonicalFields({ id: 1, created_at: 'x', action: 'b', category: 'a' });
  const b = canonicalFields({ id: 99, created_at: 'y', category: 'a', action: 'b' });
  assert.equal(a, b);
});
