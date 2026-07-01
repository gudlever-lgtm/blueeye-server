'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../src/config');

// src/config.js reads process.env once at require time; reload it fresh for
// each scenario so different env values actually take effect.
function loadConfig(envOverrides) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[CONFIG_PATH];
  const { config } = require('../src/config');
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return config;
}

test('LICENSE_GRACE_DAYS / LICENSE_VALIDATE_INTERVAL_HOURS clamp to sane caps', () => {
  const config = loadConfig({ LICENSE_GRACE_DAYS: '99999', LICENSE_VALIDATE_INTERVAL_HOURS: '99999' });
  assert.equal(config.license.graceDays, 30);
  assert.equal(config.license.intervalHours, 24);
  assert.equal(config.license.recheckHours, 24);
});

test('LICENSE_GRACE_DAYS / LICENSE_VALIDATE_INTERVAL_HOURS default when unset', () => {
  const config = loadConfig({ LICENSE_GRACE_DAYS: undefined, LICENSE_VALIDATE_INTERVAL_HOURS: undefined });
  assert.equal(config.license.graceDays, 14);
  assert.equal(config.license.intervalHours, 6);
  assert.equal(config.license.recheckHours, 6);
});

test('LICENSE_GRACE_DAYS / LICENSE_VALIDATE_INTERVAL_HOURS keep a sane operator value under the cap', () => {
  const config = loadConfig({ LICENSE_GRACE_DAYS: '3', LICENSE_VALIDATE_INTERVAL_HOURS: '1' });
  assert.equal(config.license.graceDays, 3);
  assert.equal(config.license.intervalHours, 1);
});

test('LICENSE_GRACE_DAYS below the floor clamps up to 1', () => {
  const config = loadConfig({ LICENSE_GRACE_DAYS: '0', LICENSE_VALIDATE_INTERVAL_HOURS: '0' });
  assert.equal(config.license.graceDays, 1);
  assert.equal(config.license.intervalHours, 1);
});
