'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGeoipUpdater } = require('../src/geo/geoipUpdater');

const quiet = { info() {}, warn() {} };
const cfg = { geo: { buildPath: '/tmp/geoip.csv', sourceUrl: 'https://x/free' } };

// Minimal settings-service double: serves getGeoip and records builds.
function fakeSettings(initial = {}) {
  const state = { autoUpdate: false, lastBuild: null, configured: false, ...initial };
  return {
    recorded: [],
    async getGeoip() { return { autoUpdate: state.autoUpdate, lastBuild: state.lastBuild, configured: state.configured }; },
    async recordGeoipBuild({ dbPath, month, ranges }) {
      this.recorded.push({ dbPath, month, ranges });
      state.lastBuild = { month, ranges };
      state.configured = ranges > 0;
      return {};
    },
  };
}
const jun9 = () => new Date(Date.UTC(2026, 5, 9));

test('runUpdate builds the current month and records it', async () => {
  const seen = [];
  const build = async ({ country, out }) => { seen.push({ url: country.url, out }); return { rows: 1234 }; };
  const settings = fakeSettings();
  const up = createGeoipUpdater({ settingsService: settings, config: cfg, build, now: jun9, logger: quiet });
  const s = await up.runUpdate({ includeAsn: true });
  assert.equal(s.state, 'ok');
  assert.equal(s.ranges, 1234);
  assert.equal(s.month, '2026-06');
  assert.match(seen[0].url, /dbip-country-lite-2026-06\.csv\.gz$/);
  assert.equal(seen[0].out, '/tmp/geoip.csv');
  assert.deepEqual(settings.recorded, [{ dbPath: '/tmp/geoip.csv', month: '2026-06', ranges: 1234 }]);
});

test('runUpdate omits ASN when countryOnly', async () => {
  let asnSeen = 'unset';
  const build = async ({ asn }) => { asnSeen = asn; return { rows: 1 }; };
  const up = createGeoipUpdater({ settingsService: fakeSettings(), config: cfg, build, now: jun9, logger: quiet });
  await up.runUpdate({ includeAsn: false });
  assert.equal(asnSeen, null);
});

test('runUpdate falls back to the previous month on a 404', async () => {
  const build = async ({ country }) => { if (/2026-06/.test(country.url)) throw new Error('HTTP 404'); return { rows: 7 }; };
  const up = createGeoipUpdater({ settingsService: fakeSettings(), config: cfg, build, now: jun9, logger: quiet });
  const s = await up.runUpdate();
  assert.equal(s.state, 'ok');
  assert.equal(s.month, '2026-05');
});

test('runUpdate reports an error when every month fails (e.g. air-gapped/403)', async () => {
  const build = async () => { throw new Error('HTTP 403'); };
  const up = createGeoipUpdater({ settingsService: fakeSettings(), config: cfg, build, now: jun9, logger: quiet });
  const s = await up.runUpdate();
  assert.equal(s.state, 'error');
  assert.match(s.error, /403/);
});

test('maybeAutoUpdate is a no-op when auto-update is off', async () => {
  let built = 0;
  const up = createGeoipUpdater({ settingsService: fakeSettings({ autoUpdate: false }), config: cfg, build: async () => { built += 1; return { rows: 1 }; }, now: jun9, logger: quiet });
  assert.equal(await up.maybeAutoUpdate(), false);
  assert.equal(built, 0);
});

test('maybeAutoUpdate is a no-op when already current this month', async () => {
  let built = 0;
  const settings = fakeSettings({ autoUpdate: true, configured: true, lastBuild: { month: '2026-06' } });
  const up = createGeoipUpdater({ settingsService: settings, config: cfg, build: async () => { built += 1; return { rows: 1 }; }, now: jun9, logger: quiet });
  assert.equal(await up.maybeAutoUpdate(), false);
  assert.equal(built, 0);
});

test('maybeAutoUpdate refreshes when on and stale', async () => {
  let built = 0;
  const settings = fakeSettings({ autoUpdate: true, configured: true, lastBuild: { month: '2026-05' } });
  const up = createGeoipUpdater({ settingsService: settings, config: cfg, build: async () => { built += 1; return { rows: 99 }; }, now: jun9, logger: quiet });
  assert.equal(await up.maybeAutoUpdate(), true);
  assert.equal(built, 1);
  assert.equal(settings.recorded[0].ranges, 99);
});
