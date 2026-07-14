'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// config.js reads process.env once at require time, so each case sets the env
// and re-requires the module with a fresh cache. Clearing just config.js is
// enough — its dependencies are pure and can stay cached.
const CONFIG_PATH = require.resolve('../src/config');

function loadConfigWith(jwtSecret) {
  const prev = process.env.JWT_SECRET;
  if (jwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = jwtSecret;
  delete require.cache[CONFIG_PATH];
  try {
    return require('../src/config').config;
  } finally {
    if (prev === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prev;
    delete require.cache[CONFIG_PATH];
  }
}

test('the .env.example placeholder is flagged weak despite being >= 32 chars', () => {
  const cfg = loadConfigWith('change-me-to-a-long-random-string'); // 33 chars
  assert.equal(cfg.auth.weakSecret, true);
});

test('any "change me" placeholder family value is flagged weak', () => {
  for (const s of ['changeme-but-still-a-long-value-here', 'CHANGE_ME_please_1234567890_abcdef', 'change me change me change me 1234']) {
    assert.equal(loadConfigWith(s).auth.weakSecret, true, `expected weak: ${s}`);
  }
});

test('the built-in dev default is weak', () => {
  assert.equal(loadConfigWith('dev-insecure-secret-change-me').auth.weakSecret, true);
  assert.equal(loadConfigWith(undefined).auth.weakSecret, true); // unset -> dev default
});

test('a short secret is weak', () => {
  assert.equal(loadConfigWith('too-short').auth.weakSecret, true);
});

test('a strong, unique secret is accepted', () => {
  const strong = 'S6mF1p' + path.sep.repeat(0) + 'q9Zr7X2vK4nB8wL0tY3cH5jD1gU6eA2sPqWkR'; // 40+ random-looking chars, no placeholder text
  assert.equal(loadConfigWith(strong).auth.weakSecret, false);
});
