'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsService } = require('../src/services/settings');

function memRepo(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); return v; } };
}

// getTsdb is read-only status derived from the boot-time (env) config — the pg
// pool is built once at boot, so there is deliberately no setTsdb. See
// src/services/settings.js.

test('getTsdb reports "not configured" when TSDB is disabled', () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: { tsdb: { enabled: false } } });
  const t = svc.getTsdb();
  assert.equal(t.enabled, false);
  assert.equal(t.source, 'env');
  assert.equal(t.editable, false);
  assert.equal(t.passwordSet, false);
});

test('getTsdb surfaces the effective connection target but never the password', () => {
  const config = {
    tsdb: {
      enabled: true, host: 'tsdb.local', port: 5432, user: 'blueeye_tsdb',
      password: 'hunter2', database: 'blueeye_telemetry', connectionLimit: 8, connectionTimeoutMs: 4000,
    },
  };
  const svc = createSettingsService({ settingsRepo: memRepo(), config });
  const t = svc.getTsdb();
  assert.equal(t.enabled, true);
  assert.equal(t.host, 'tsdb.local');
  assert.equal(t.port, 5432);
  assert.equal(t.user, 'blueeye_tsdb');
  assert.equal(t.database, 'blueeye_telemetry');
  assert.equal(t.connectionLimit, 8);
  assert.equal(t.connectionTimeoutMs, 4000);
  assert.equal(t.passwordSet, true);
  assert.ok(!('password' in t));
  assert.ok(!JSON.stringify(t).includes('hunter2'));
});

test('getTsdb tolerates a config with no tsdb block', () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: {} });
  const t = svc.getTsdb();
  assert.equal(t.enabled, false);
  assert.equal(t.host, null);
  assert.equal(t.passwordSet, false);
});
