'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateTempPassword, TEMP_PASSWORD_LENGTH } = require('../src/auth/tempPassword');
const { checkPasswordPolicy } = require('../src/auth/password');

test('generateTempPassword is long enough and never shorter than 16', () => {
  assert.ok(generateTempPassword().length >= 16);
  assert.equal(generateTempPassword().length, TEMP_PASSWORD_LENGTH);
  // A requested length below the floor is clamped up to 16.
  assert.equal(generateTempPassword(4).length, 16);
  assert.equal(generateTempPassword(32).length, 32);
});

test('generateTempPassword always satisfies the baseline password policy', () => {
  for (let i = 0; i < 200; i += 1) {
    const pw = generateTempPassword();
    const res = checkPasswordPolicy(pw);
    assert.ok(res.ok, `expected policy pass for "${pw}" — ${JSON.stringify(res.errors)}`);
  }
});

test('generateTempPassword is unpredictable (no repeats across many draws)', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(generateTempPassword());
  // 500 random 20-char passwords should all be distinct.
  assert.equal(seen.size, 500);
});
