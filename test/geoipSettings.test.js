'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsService } = require('../src/services/settings');
const { createGeoProvider } = require('../src/geo/provider');

function memRepo(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); return v; },
    _map: m,
  };
}

const CSV_FILE = require('path').join(__dirname, 'fixtures-geoip.csv');
const fs = require('fs');

test.before(() => fs.writeFileSync(CSV_FILE, '8.8.8.0,8.8.8.255,US,15169,GOOGLE\n80.0.0.0,80.255.255.255,DE,3320,DTAG\n'));
test.after(() => { try { fs.unlinkSync(CSV_FILE); } catch { /* ignore */ } });

const cfgNoEnv = { geo: { dbPath: '' } };

test('getGeoip reports disabled when no DB is configured', async () => {
  const liveGeo = createGeoProvider({});
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfgNoEnv, liveGeo });
  const g = await svc.getGeoip();
  assert.equal(g.configured, false);
  assert.equal(g.ranges, 0);
  assert.equal(g.source, null);
  assert.equal(g.dbPath, '');
});

test('getGeoip reflects the env path as the source when set', async () => {
  const liveGeo = createGeoProvider({});
  const svc = createSettingsService({ settingsRepo: memRepo(), config: { geo: { dbPath: '/etc/geoip.csv' } }, liveGeo });
  const g = await svc.getGeoip();
  assert.equal(g.source, 'env');
  assert.equal(g.dbPath, '/etc/geoip.csv');
});

test('setGeoip persists the path, reloads the live provider, and reports ranges', async () => {
  const repo = memRepo();
  const liveGeo = createGeoProvider({});           // starts disabled
  const svc = createSettingsService({ settingsRepo: repo, config: cfgNoEnv, liveGeo });

  const res = await svc.setGeoip({ dbPath: CSV_FILE });
  assert.equal(res.configured, true);
  assert.equal(res.ranges, 2);
  assert.equal(res.source, 'settings');
  // live-applied: the provider now geolocates without a restart.
  assert.equal(liveGeo.lookup('8.8.8.8').country, 'US');
  // persisted as an override.
  assert.deepEqual(await repo.get('geoip'), { dbPath: CSV_FILE });
});

test('setGeoip with an empty path clears the override and disables enrichment', async () => {
  const repo = memRepo({ geoip: { dbPath: CSV_FILE } });
  const liveGeo = createGeoProvider({ dbPath: CSV_FILE });
  const svc = createSettingsService({ settingsRepo: repo, config: cfgNoEnv, liveGeo });
  assert.equal(liveGeo.size, 2);

  const res = await svc.setGeoip({ dbPath: '' });
  assert.equal(res.configured, false);
  assert.equal(res.ranges, 0);
  assert.equal(await repo.get('geoip'), null); // override removed
  assert.equal(liveGeo.lookup('8.8.8.8'), null);
});

test('setGeoip reports ranges:0 for a wrong path instead of failing silently', async () => {
  const liveGeo = createGeoProvider({});
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfgNoEnv, liveGeo });
  const res = await svc.setGeoip({ dbPath: '/no/such/geoip.csv' });
  assert.equal(res.configured, false);
  assert.equal(res.ranges, 0);
  assert.ok(res.error); // the read error is surfaced
});

test('validateGeoip rejects an over-long path', () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfgNoEnv, liveGeo: createGeoProvider({}) });
  assert.rejects(() => svc.setGeoip({ dbPath: 'x'.repeat(1025) }), (e) => e.statusCode === 400);
});

test('applyStoredOverrides reloads the provider from a stored path at boot', async () => {
  const repo = memRepo({ geoip: { dbPath: CSV_FILE } });
  const liveGeo = createGeoProvider({}); // boots disabled (e.g. env unset)
  const svc = createSettingsService({ settingsRepo: repo, config: cfgNoEnv, liveGeo });
  assert.equal(liveGeo.size, 0);
  await svc.applyStoredOverrides();
  assert.equal(liveGeo.size, 2); // override applied on boot
  assert.equal(liveGeo.lookup('80.1.2.3').country, 'DE');
});

test('setGeoip toggles autoUpdate without clearing the path', async () => {
  const repo = memRepo({ geoip: { dbPath: CSV_FILE } });
  const svc = createSettingsService({ settingsRepo: repo, config: cfgNoEnv, liveGeo: createGeoProvider({ dbPath: CSV_FILE }) });
  const res = await svc.setGeoip({ autoUpdate: true });
  assert.equal(res.autoUpdate, true);
  assert.equal(res.dbPath, CSV_FILE); // path preserved
  assert.deepEqual(await repo.get('geoip'), { dbPath: CSV_FILE, autoUpdate: true });
});

test('recordGeoipBuild stores build metadata, reloads, and keeps autoUpdate', async () => {
  const repo = memRepo({ geoip: { autoUpdate: true } });
  const liveGeo = createGeoProvider({});
  const svc = createSettingsService({ settingsRepo: repo, config: cfgNoEnv, liveGeo });
  const res = await svc.recordGeoipBuild({ dbPath: CSV_FILE, month: '2026-06', ranges: 2 });
  assert.equal(res.configured, true);
  assert.equal(res.ranges, 2);
  assert.equal(res.autoUpdate, true);
  assert.equal(res.lastBuild.month, '2026-06');
  assert.equal(res.lastBuild.ranges, 2);
  assert.equal(liveGeo.lookup('8.8.8.8').country, 'US'); // live-reloaded
  const stored = await repo.get('geoip');
  assert.equal(stored.dbPath, CSV_FILE);
  assert.equal(stored.autoUpdate, true); // preserved
  assert.equal(stored.build.month, '2026-06');
});
