'use strict';

// The alerting master switch (ALERTING_ENABLED / Settings → Alerting) is
// tri-state. It used to default to false, so a customer who configured a
// channel and nothing else got no alert at all and nothing said why. Now:
//
//   unset / "auto" → on iff at least one channel is configured
//   explicit false → off, even with channels configured
//   explicit true  → on
//
// See src/analysis/alerting/config.js and docs/alerting.md.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  loadAlertingConfig, parseEnabledSetting, channelConfigured, resolveAlertingEnabled,
} = require('../src/analysis/alerting/config');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');
const { createSettingsService } = require('../src/services/settings');
const { makeApp, makeSettingsService, authHeader } = require('../test-support/fakes');

const WEBHOOK = { ALERT_WEBHOOK_ENABLED: 'true', ALERT_WEBHOOK_URL: 'https://hooks.example.eu/x' };

function memRepo(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); return v; } };
}
const geo = { geo: { tileUrl: 'https://t/{z}/{x}/{y}.png', tileAttribution: 'a', tileMaxZoom: 19, geocodeUrl: '' } };

// ---- env: the three cases ---------------------------------------------------

test('UNSET + a configured channel → alerting is ON (auto-channels)', () => {
  const cfg = loadAlertingConfig({ ...WEBHOOK });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.enabledSetting, null);
  assert.equal(cfg.enabledReason, 'auto-channels');
  assert.deepEqual(resolveAlertingEnabled(cfg).configuredChannels, ['webhook']);
});

test('UNSET + no configured channel → alerting is OFF (auto-no-channels)', () => {
  const cfg = loadAlertingConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.enabledReason, 'auto-no-channels');
  // An enabled channel with nowhere to send to does not count.
  assert.equal(loadAlertingConfig({ ALERT_WEBHOOK_ENABLED: 'true' }).enabled, false);
  assert.equal(loadAlertingConfig({ ALERT_EMAIL_ENABLED: 'true', ALERT_EMAIL_TO: 'ops@x.eu' }).enabled, false, 'no SMTP host');
  // "auto" is the same as unset.
  assert.equal(loadAlertingConfig({ ALERTING_ENABLED: 'auto', ...WEBHOOK }).enabled, true);
  assert.equal(loadAlertingConfig({ ALERTING_ENABLED: '', ...WEBHOOK }).enabled, true);
});

test('explicit false / 0 → OFF even with a configured channel', () => {
  for (const v of ['false', '0', 'no', 'off']) {
    const cfg = loadAlertingConfig({ ALERTING_ENABLED: v, ...WEBHOOK });
    assert.equal(cfg.enabled, false, v);
    assert.equal(cfg.enabledReason, 'explicit-off', v);
  }
});

test('explicit true → ON, also without a configured channel', () => {
  for (const v of ['true', '1', 'yes', 'on']) {
    const cfg = loadAlertingConfig({ ALERTING_ENABLED: v });
    assert.equal(cfg.enabled, true, v);
    assert.equal(cfg.enabledReason, 'explicit-on', v);
  }
});

test('parseEnabledSetting / channelConfigured', () => {
  assert.equal(parseEnabledSetting(undefined), null);
  assert.equal(parseEnabledSetting('  '), null);
  assert.equal(parseEnabledSetting('garbage'), false, 'an unrecognised value fails closed');
  assert.equal(channelConfigured('syslog', { enabled: true, host: 'log.local' }), true);
  assert.equal(channelConfigured('syslog', { enabled: false, host: 'log.local' }), false);
  assert.equal(channelConfigured('matrix', { enabled: true, homeserver: 'https://m', roomId: '!a:b', accessToken: '' }), false);
});

test('the dispatcher really sends in automatic mode, and describe() says why', async () => {
  const cfg = loadAlertingConfig({ ...WEBHOOK });
  const sent = [];
  const d = createDispatcher({ config: cfg, channels: { webhook: { send: async (f) => { sent.push(f); return { ok: true }; } } } });
  const r = await d.dispatch({ id: 'f1', hostId: '1', metric: 'probe.loss', kind: 'THRESHOLD', severity: 'CRIT', explanation: 'x', evidence: [{}] });
  assert.equal(r.dispatched, true);
  assert.equal(sent.length, 1);
  const desc = d.describe();
  assert.equal(desc.enabled, true);
  assert.equal(desc.enabledSetting, null);
  assert.equal(desc.enabledReason, 'auto-channels');
  assert.deepEqual(desc.configuredChannels, ['webhook']);

  const off = createDispatcher({ config: loadAlertingConfig({ ALERTING_ENABLED: 'false', ...WEBHOOK }), channels: {} });
  assert.equal((await off.dispatch({ id: 'f', hostId: '1', metric: 'm', kind: 'THRESHOLD', severity: 'CRIT' })).reason, 'disabled');
  assert.equal(off.describe().enabledReason, 'explicit-off');
});

// ---- stored settings (Settings → Alerting) -----------------------------------

test('settings: configuring a channel in automatic mode switches alerting on, live, and says why', async () => {
  const live = loadAlertingConfig({});
  const svc = createSettingsService({ settingsRepo: memRepo(), config: geo, liveAlerting: live });
  assert.equal(live.enabled, false);
  const out = await svc.setAlerting({ syslog: { enabled: true, host: 'log.example.eu' } });
  assert.equal(out.enabledMode, 'auto');
  assert.equal(out.enabled, true);
  assert.equal(out.enabledReason, 'auto-channels');
  assert.deepEqual(out.configuredChannels, ['syslog']);
  assert.equal(live.enabled, true, 'not live-applied');
  // An explicit Off wins over the configured channel; back to auto turns it on again.
  assert.equal((await svc.setAlerting({ enabledMode: 'off' })).enabled, false);
  assert.equal(live.enabled, false);
  assert.equal(live.enabledReason, 'explicit-off');
  assert.equal((await svc.setAlerting({ enabled: null })).enabledMode, 'auto');
  assert.equal(live.enabled, true);
  // The older boolean form still works and is explicit.
  assert.equal((await svc.setAlerting({ enabled: true })).enabledMode, 'on');
  assert.equal((await svc.setAlerting({ enabled: false })).enabledMode, 'off');
});

test('settings: a row stored before the tri-state — false reads as automatic, true as on', async () => {
  const legacy = (enabled) => ({
    enabled, cooldownMs: 900000,
    channels: { webhook: { enabled: true, minSeverity: 'CRIT', url: 'https://hooks.example.eu/x', secret: '' } },
  });
  for (const [stored, mode, effective] of [[false, 'auto', true], [true, 'on', true]]) {
    const live = loadAlertingConfig({});
    const svc = createSettingsService({ settingsRepo: memRepo({ alerting: legacy(stored) }), config: geo, liveAlerting: live });
    await svc.applyStoredOverrides();
    assert.equal(live.enabled, effective, `stored ${stored}`);
    const safe = await svc.getAlertingSafe();
    assert.equal(safe.enabledMode, mode, `stored ${stored}`);
  }
});

// The test above covers only an UNSET env. Upgrading with ALERTING_ENABLED=false
// in the environment plus a legacy row (stored false + a configured channel)
// used to read the row as automatic and switch alerting ON over the operator's
// explicit env Off. An explicit env false wins over an ambiguous legacy false.
test('settings: legacy stored false + env ALERTING_ENABLED=false → stays OFF after upgrade', async () => {
  const legacyRow = {
    enabled: false, cooldownMs: 900000,
    channels: { webhook: { enabled: true, minSeverity: 'CRIT', url: 'https://hooks.example.eu/x', secret: '' } },
  };
  const live = loadAlertingConfig({ ALERTING_ENABLED: 'false', ...WEBHOOK });
  const svc = createSettingsService({ settingsRepo: memRepo({ alerting: legacyRow }), config: geo, liveAlerting: live });
  await svc.applyStoredOverrides();
  assert.equal(live.enabled, false, 'legacy false switched alerting on over env false');
  assert.equal(live.enabledReason, 'explicit-off');
  const safe = await svc.getAlertingSafe();
  assert.equal(safe.enabledMode, 'off');
  assert.equal(safe.enabled, false);
  // A later channel-card save persists the Off rather than flipping to auto.
  assert.equal((await svc.setAlerting({ syslog: { enabled: true, host: 'log.example.eu' } })).enabledMode, 'off');
  assert.equal(live.enabled, false);
  // The admin can still choose automatic deliberately.
  assert.equal((await svc.setAlerting({ enabledMode: 'auto' })).enabled, true);
});

test('settings: an invalid enabledMode is refused', async () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: geo, liveAlerting: loadAlertingConfig({}) });
  await assert.rejects(() => svc.setAlerting({ enabledMode: 'sometimes' }), (e) => e.status === 400 || /invalid/.test(e.message));
});

// ---- GET /api/alerting/config (the screen reads it) --------------------------

test('GET /api/alerting/config carries the effective state + reason (viewer+) → 200; 401 without a token', async () => {
  const dispatcher = createDispatcher({ config: loadAlertingConfig({ ...WEBHOOK }), channels: {} });
  const app = makeApp({ dispatcher, settingsService: makeSettingsService() });
  const res = await request(app).get('/api/alerting/config').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.enabledReason, 'auto-channels');
  assert.deepEqual(res.body.configuredChannels, ['webhook']);
  assert.equal((await request(app).get('/api/alerting/config')).status, 401);
});
