'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { config, validateConfig } = require('../src/config');

// A minimal valid config shape mirroring the keys validateConfig inspects.
function base(over = {}) {
  return {
    env: 'production',
    port: 3000,
    db: { host: '127.0.0.1', user: 'blueeye', database: 'blueeye' },
    auth: { weakSecret: false },
    ...over,
  };
}

test('validateConfig passes for a complete production config', () => {
  const r = validateConfig(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('the loaded config validates in the test environment', () => {
  // env is non-production here, so the weak dev secret is allowed and the
  // defaulted db/port keys are present.
  assert.equal(validateConfig(config).ok, true);
});

test('validateConfig fails closed on a weak JWT secret in production', () => {
  const r = validateConfig(base({ auth: { weakSecret: true } }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /JWT_SECRET/);
});

test('a weak secret outside production is allowed (dev default)', () => {
  const r = validateConfig(base({ env: 'development', auth: { weakSecret: true } }));
  assert.equal(r.ok, true);
});

test('validateConfig fails closed when a required core key is blank', () => {
  const r = validateConfig(base({ db: { host: '', user: 'blueeye', database: 'blueeye' } }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /DB_HOST/);
});

test('validateConfig rejects a non-positive port', () => {
  const r = validateConfig(base({ port: 0 }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /PORT/);
});

test('validateConfig aggregates every failing rule', () => {
  const r = validateConfig(base({ auth: { weakSecret: true }, db: { host: '', user: '', database: '' } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 4, `expected >=4 errors, got ${r.errors.length}`);
});
