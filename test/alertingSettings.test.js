'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createSettingsService } = require('../src/services/settings');
const { loadAlertingConfig } = require('../src/analysis/alerting/config');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');
const { createSyslogChannel } = require('../src/analysis/alerting/channels/syslog');
const { createEmailChannel } = require('../src/analysis/alerting/channels/email');
const { makeApp, makeSettingsService, makeFeatureGate, authHeader } = require('../test-support/fakes');

function memRepo(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); return v; } };
}
const cfg = { geo: { tileUrl: 'https://t/{z}/{x}/{y}.png', tileAttribution: 'a', tileMaxZoom: 19, geocodeUrl: '' } };
const svcWith = (liveAlerting, repo = memRepo()) => createSettingsService({ settingsRepo: repo, config: cfg, liveAlerting });

// ---- settings service: alerting config (secret-safe) -----------------------

test('getAlertingSafe redacts both secrets; getAlerting keeps them for internal use', async () => {
  const liveAlerting = loadAlertingConfig({
    ALERTING_ENABLED: 'true', ALERT_EMAIL_ENABLED: 'true', ALERT_EMAIL_TO: 'ops@x.eu',
    SMTP_HOST: 'mail', SMTP_PASS: 'smtp-pw-1234',
    ALERT_WEBHOOK_ENABLED: 'true', ALERT_WEBHOOK_URL: 'https://h/x', ALERT_WEBHOOK_SECRET: 'hook-secret-9999',
  });
  const svc = svcWith(liveAlerting);

  const safe = await svc.getAlertingSafe();
  assert.equal(safe.enabled, true);
  assert.equal(safe.channels.email.to, 'ops@x.eu');
  assert.equal(safe.channels.email.smtp.host, 'mail');
  assert.equal(safe.channels.email.smtpPassSet, true);
  assert.equal(safe.channels.email.smtpPassHint, '••••1234');
  assert.equal(safe.channels.webhook.secretSet, true);
  assert.equal(safe.channels.webhook.secretHint, '••••9999');
  // The raw secrets never appear anywhere in the safe view.
  const flat = JSON.stringify(safe);
  assert.ok(!flat.includes('smtp-pw-1234'));
  assert.ok(!flat.includes('hook-secret-9999'));
  assert.equal(safe.channels.email.smtp.pass, undefined);
  assert.equal(safe.channels.webhook.secret, undefined);

  // Server-internal getter keeps the raw secrets (for live-apply / persistence).
  const full = await svc.getAlerting();
  assert.equal(full.channels.email.smtp.pass, 'smtp-pw-1234');
  assert.equal(full.channels.webhook.secret, 'hook-secret-9999');
});

test('setAlerting persists, live-applies onto the alerting config, and returns the redacted view', async () => {
  const liveAlerting = loadAlertingConfig({});
  const repo = memRepo();
  const svc = svcWith(liveAlerting, repo);

  const out = await svc.setAlerting({
    enabled: true, cooldownMs: 60000,
    webhook: { enabled: true, minSeverity: 'WARN', url: 'https://hooks.example.eu/be', secret: 'sig-key-4242' },
  });
  assert.equal(out.enabled, true);
  assert.equal(out.cooldownMs, 60000);
  assert.deepEqual(out.channels.webhook, { enabled: true, minSeverity: 'WARN', url: 'https://hooks.example.eu/be', secretSet: true, secretHint: '••••4242' });
  assert.ok(!JSON.stringify(out).includes('sig-key-4242')); // raw secret never returned

  // Live-applied IN PLACE so the dispatcher + channels (which hold these objects) see it.
  assert.equal(liveAlerting.enabled, true);
  assert.equal(liveAlerting.cooldownMs, 60000);
  assert.equal(liveAlerting.channels.webhook.enabled, true);
  assert.equal(liveAlerting.channels.webhook.url, 'https://hooks.example.eu/be');
  assert.equal(liveAlerting.channels.webhook.secret, 'sig-key-4242');
  // Persisted under the 'alerting' key (with the secret).
  assert.equal((await repo.get('alerting')).channels.webhook.secret, 'sig-key-4242');
});

test('setAlerting merges partial channel patches without clobbering other channels', async () => {
  const liveAlerting = loadAlertingConfig({});
  const svc = svcWith(liveAlerting);
  await svc.setAlerting({ email: { enabled: true, minSeverity: 'WARN', to: 'a@b.eu', smtp: { host: 'mail.eu' } } });
  const out = await svc.setAlerting({ syslog: { enabled: true, host: 'log.eu', port: 1514, proto: 'tcp' } });
  // The earlier email edit survived the later syslog-only save.
  assert.equal(out.channels.email.enabled, true);
  assert.equal(out.channels.email.to, 'a@b.eu');
  assert.equal(out.channels.email.smtp.host, 'mail.eu');
  assert.equal(out.channels.syslog.enabled, true);
  assert.equal(out.channels.syslog.host, 'log.eu');
  assert.equal(out.channels.syslog.port, 1514);
  assert.equal(out.channels.syslog.proto, 'tcp');
});

test('setAlerting: a blank secret keeps it, clear flags remove it', async () => {
  const liveAlerting = loadAlertingConfig({ SMTP_PASS: 'keep-smtp-7777', ALERT_WEBHOOK_SECRET: 'keep-hook-8888' });
  const svc = svcWith(liveAlerting);

  // Saving without retyping (blank) must not wipe either secret.
  let out = await svc.setAlerting({ email: { smtp: { host: 'mail2' } }, webhook: { url: 'https://h2/x' } });
  assert.equal(out.channels.email.smtpPassSet, true);
  assert.equal(out.channels.webhook.secretSet, true);
  assert.equal(liveAlerting.channels.email.smtp.pass, 'keep-smtp-7777');
  assert.equal(liveAlerting.channels.webhook.secret, 'keep-hook-8888');

  // Explicit clears remove them.
  out = await svc.setAlerting({ email: { clearSmtpPass: true }, webhook: { clearSecret: true } });
  assert.equal(out.channels.email.smtpPassSet, false);
  assert.equal(out.channels.email.smtpPassHint, '');
  assert.equal(out.channels.webhook.secretSet, false);
  assert.equal(liveAlerting.channels.email.smtp.pass, '');
  assert.equal(liveAlerting.channels.webhook.secret, '');
});

test('validateAlerting rejects bad severity, port, url and proto', async () => {
  const svc = svcWith(loadAlertingConfig({}));
  await assert.rejects(() => svc.setAlerting({ email: { minSeverity: 'LOUD' } }), (e) => e.statusCode === 400 && Boolean(e.details['email.minSeverity']));
  await assert.rejects(() => svc.setAlerting({ syslog: { port: 0 } }), (e) => e.statusCode === 400 && Boolean(e.details['syslog.port']));
  await assert.rejects(() => svc.setAlerting({ webhook: { url: 'ftp://nope' } }), (e) => e.statusCode === 400 && Boolean(e.details['webhook.url']));
  await assert.rejects(() => svc.setAlerting({ syslog: { proto: 'sctp' } }), (e) => e.statusCode === 400 && Boolean(e.details['syslog.proto']));
  await assert.rejects(() => svc.setAlerting({ email: { to: 'not-an-email' } }), (e) => e.statusCode === 400 && Boolean(e.details['email.to']));
  await assert.rejects(() => svc.setAlerting({ cooldownMs: -1 }), (e) => e.statusCode === 400 && Boolean(e.details.cooldownMs));
});

test('applyStoredOverrides re-applies the alerting override onto the live config at boot', async () => {
  const stored = loadAlertingConfig({ ALERTING_ENABLED: 'true', ALERT_SYSLOG_ENABLED: 'true', SYSLOG_HOST: 'boot-log', SYSLOG_PORT: '1601' });
  const repo = memRepo({ alerting: stored });
  const liveAlerting = loadAlertingConfig({}); // starts disabled/empty
  const svc = svcWith(liveAlerting, repo);
  await svc.applyStoredOverrides();
  assert.equal(liveAlerting.enabled, true);
  assert.equal(liveAlerting.channels.syslog.enabled, true);
  assert.equal(liveAlerting.channels.syslog.host, 'boot-log');
  assert.equal(liveAlerting.channels.syslog.port, 1601);
});

// ---- live-apply reaches the dispatcher + channels (no restart) -------------

test('a runtime setAlerting is observed by the dispatcher and channels that share the config', async () => {
  const liveAlerting = loadAlertingConfig({}); // disabled, no channels configured
  const sent = [];
  const syslog = createSyslogChannel({ config: liveAlerting.channels.syslog, send: async (buf, dst) => { sent.push({ line: buf.toString(), dst }); } });
  const dispatcher = createDispatcher({ config: liveAlerting, channels: { syslog }, now: () => 0 });
  const svc = svcWith(liveAlerting);

  // Before: disabled -> nothing dispatched.
  let res = await dispatcher.dispatch({ id: 'f0', hostId: '9', metric: 'cpu', kind: 'ANOMALY', severity: 'CRIT', explanation: 'x', createdAt: new Date() });
  assert.equal(res.dispatched, false);
  assert.equal(res.reason, 'disabled');

  // Enable + configure syslog at runtime.
  await svc.setAlerting({ enabled: true, syslog: { enabled: true, minSeverity: 'INFO', host: 'live-log', port: 514, proto: 'udp' } });

  // After: the dispatcher (config.enabled) and the channel (config.host) both see it.
  res = await dispatcher.dispatch({ id: 'f1', hostId: '9', metric: 'cpu', kind: 'ANOMALY', severity: 'CRIT', explanation: 'x', createdAt: new Date() });
  assert.equal(res.dispatched, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].dst.host, 'live-log');
});

test('the email channel rebuilds its transport when SMTP changes at runtime', async () => {
  const liveAlerting = loadAlertingConfig({});
  const builds = [];
  const sent = [];
  // createTransport factory: records each (re)build and returns a recording mailer.
  const email = createEmailChannel({
    config: liveAlerting.channels.email,
    createTransport: (smtp) => {
      builds.push({ ...smtp });
      return smtp && smtp.host ? { sendMail: async (m) => { sent.push(m); } } : null;
    },
  });
  const svc = svcWith(liveAlerting);

  // No SMTP host yet -> no transport.
  assert.equal((await email.send({ hostId: '9', metric: 'cpu', severity: 'CRIT' })).ok, false);

  // Configure SMTP + recipient at runtime; the next send rebuilds + delivers.
  await svc.setAlerting({ email: { enabled: true, to: 'ops@x.eu', from: 'be@x.eu', smtp: { host: 'mail.eu', port: 587 } } });
  const r = await email.send({ hostId: '9', metric: 'cpu', severity: 'CRIT', explanation: 'high', kind: 'ANOMALY' });
  assert.equal(r.ok, true);
  assert.equal(sent[0].to, 'ops@x.eu');
  assert.ok(builds.some((b) => b.host === 'mail.eu'));
});

// ---- settings route --------------------------------------------------------

test('PUT /api/settings/alerting saves (admin); GET reflects it; secrets are never echoed', async () => {
  const app = makeApp({ settingsService: makeSettingsService() });
  const put = await request(app).put('/api/settings/alerting').set('Authorization', authHeader('admin'))
    .send({ enabled: true, webhook: { enabled: true, minSeverity: 'CRIT', url: 'https://h/x', secret: 'route-secret-4242' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.alerting.enabled, true);
  assert.equal(put.body.alerting.channels.webhook.secretSet, true);
  assert.equal(put.body.alerting.channels.webhook.secretHint, '••••4242');
  assert.ok(!JSON.stringify(put.body).includes('route-secret-4242')); // raw secret never returned

  const get = await request(app).get('/api/settings').set('Authorization', authHeader('admin'));
  assert.equal(get.body.alerting.enabled, true);
  assert.equal(get.body.alerting.channels.webhook.url, 'https://h/x');
  assert.equal(get.body.alerting.channels.webhook.secretSet, true);
  assert.equal(get.body.alerting.channels.webhook.secret, undefined);
});

test('PUT /api/settings/alerting validates (400) and is admin-only (403 / 401)', async () => {
  assert.equal((await request(makeApp()).put('/api/settings/alerting').set('Authorization', authHeader('admin')).send({ syslog: { proto: 'bogus' } })).status, 400);
  assert.equal((await request(makeApp()).put('/api/settings/alerting').set('Authorization', authHeader('viewer')).send({ enabled: true })).status, 403);
  assert.equal((await request(makeApp()).put('/api/settings/alerting').send({ enabled: true })).status, 401);
});

test('PUT /api/settings/alerting is refused (403) when the licence excludes alerting', async () => {
  const app = makeApp({ featureGate: makeFeatureGate({ features: { alerting: false } }) });
  const res = await request(app).put('/api/settings/alerting').set('Authorization', authHeader('admin')).send({ enabled: true });
  assert.equal(res.status, 403);
  assert.equal(res.body.feature, 'alerting');
});
