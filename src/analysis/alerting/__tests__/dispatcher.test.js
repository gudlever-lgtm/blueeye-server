'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher } = require('../dispatcher');
const { loadAlertingConfig } = require('../config');

function chan() {
  const calls = [];
  return { calls, send: async (f, g) => { calls.push({ f, g }); return { ok: true, detail: 'sent' }; } };
}

const baseConfig = (over = {}) => ({
  enabled: true,
  cooldownMs: 1000,
  channels: {
    email: { enabled: true, minSeverity: 'WARN' },
    webhook: { enabled: true, minSeverity: 'CRIT' },
    syslog: { enabled: true, minSeverity: 'INFO' },
    ...(over.channels || {}),
  },
  ...over,
});

const finding = (over = {}) => ({ id: `f${Math.random()}`, hostId: '9', metric: 'cpu', kind: 'ANOMALY', severity: 'WARN', explanation: 'x', ...over });

test('respects per-channel minimum severity', async () => {
  const email = chan(); const webhook = chan(); const syslog = chan();
  const d = createDispatcher({ config: baseConfig(), channels: { email, webhook, syslog }, now: () => 0 });
  await d.dispatch(finding({ severity: 'WARN' }));
  assert.equal(email.calls.length, 1); // WARN >= WARN
  assert.equal(syslog.calls.length, 1); // WARN >= INFO
  assert.equal(webhook.calls.length, 0); // WARN < CRIT
});

test('throttles repeated findings within the cooldown', async () => {
  const syslog = chan();
  let t = 0;
  const d = createDispatcher({ config: baseConfig(), channels: { syslog }, now: () => t });
  await d.dispatch(finding({ severity: 'INFO' }));
  t = 500; // within cooldown
  const r2 = await d.dispatch(finding({ severity: 'INFO' }));
  assert.equal(r2.reason, 'throttled');
  assert.equal(syslog.calls.length, 1);
  t = 1500; // past cooldown
  await d.dispatch(finding({ severity: 'INFO' }));
  assert.equal(syslog.calls.length, 2);
});

test('a CRIT escalation is not throttled by a prior WARN (severity is in the key)', async () => {
  const syslog = chan(); // minSeverity INFO -> fires on WARN and CRIT
  let t = 0;
  const d = createDispatcher({ config: baseConfig(), channels: { syslog }, now: () => t });
  await d.dispatch(finding({ severity: 'WARN' })); // sent
  t = 500; // within the 1000ms cooldown
  const crit = await d.dispatch(finding({ severity: 'CRIT' }));
  assert.notEqual(crit.reason, 'throttled'); // escalation must get through
  assert.equal(syslog.calls.length, 2);
  t = 600;
  const warn2 = await d.dispatch(finding({ severity: 'WARN' }));
  assert.equal(warn2.reason, 'throttled'); // same severity still de-duped
  assert.equal(syslog.calls.length, 2);
});

test('one failing channel does not stop the others', async () => {
  const bad = { send: async () => { throw new Error('boom'); } };
  const good = chan();
  const cfg = baseConfig({ channels: { email: { enabled: true, minSeverity: 'INFO' }, syslog: { enabled: true, minSeverity: 'INFO' } } });
  const d = createDispatcher({ config: cfg, channels: { email: bad, syslog: good }, now: () => 0 });
  const res = await d.dispatch(finding({ severity: 'CRIT' }));
  assert.equal(good.calls.length, 1);
  const emailRes = res.results.find((r) => r.channel === 'email');
  assert.equal(emailRes.ok, false);
  assert.match(emailRes.detail, /threw/);
});

test('a disabled dispatcher calls no channels', async () => {
  const syslog = chan();
  const d = createDispatcher({ config: baseConfig({ enabled: false }), channels: { syslog } });
  const res = await d.dispatch(finding({ severity: 'CRIT' }));
  assert.equal(res.dispatched, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(syslog.calls.length, 0);
});

test('describe exposes rules without secrets', () => {
  const cfg = loadAlertingConfig({
    ALERTING_ENABLED: 'true', ALERT_WEBHOOK_ENABLED: 'true', ALERT_WEBHOOK_URL: 'https://h/x',
    ALERT_WEBHOOK_SECRET: 'shh', ALERT_EMAIL_ENABLED: 'true', SMTP_HOST: 'mail', SMTP_PASS: 'pw', ALERT_EMAIL_TO: 'a@b',
  });
  const d = createDispatcher({ config: cfg, channels: {} });
  const desc = d.describe();
  const flat = JSON.stringify(desc);
  assert.ok(!flat.includes('shh'), 'must not leak webhook secret');
  assert.ok(!flat.includes('pw'), 'must not leak smtp password');
  assert.equal(desc.channels.webhook.signed, true);
  assert.equal(desc.channels.email.to, 'a@b');
});

test('test() returns null for an unknown channel, result for a known one', async () => {
  const d = createDispatcher({ config: baseConfig(), channels: { syslog: chan() } });
  assert.equal(await d.test('nope'), null);
  const r = await d.test('syslog');
  assert.equal(r.ok, true);
});
