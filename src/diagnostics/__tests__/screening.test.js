'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const s = require('../screening');

test('rollup picks the worst severity', () => {
  assert.equal(s.rollup([{ status: 'ok' }, { status: 'info' }, { status: 'warn' }]), 'warn');
  assert.equal(s.rollup([{ status: 'ok' }, { status: 'bad' }, { status: 'warn' }]), 'bad');
  assert.equal(s.rollup([]), 'ok');
  assert.equal(s.worse('ok', 'info'), 'info');
});

test('screenEmail: implicit TLS is ok, plaintext port 25 is bad, no host is info', () => {
  const ok = s.screenEmail({ enabled: true, to: 'a@b.c', smtp: { host: 'mail.example', port: 465, secure: true, user: 'u' }, smtpPassSet: true });
  assert.equal(ok.posture, 'ok');
  assert.equal(ok.configured, true);

  const bad = s.screenEmail({ enabled: true, to: 'a@b.c', smtp: { host: 'mail.example', port: 25, secure: false } });
  assert.equal(bad.posture, 'bad');
  assert.ok(bad.security.some((c) => c.id === 'tls' && c.status === 'bad'));

  const none = s.screenEmail({});
  assert.equal(none.configured, false);
  assert.equal(none.posture, 'info');
});

test('screenWebhook: http is bad, https without a secret warns, https + secret is ok', () => {
  assert.equal(s.screenWebhook({ enabled: true, url: 'http://hook.example/x' }).posture, 'bad');
  assert.equal(s.screenWebhook({ enabled: true, url: 'https://hook.example/x', secretSet: false }).posture, 'warn');
  assert.equal(s.screenWebhook({ enabled: true, url: 'https://hook.example/x', secretSet: true }).posture, 'ok');
});

test('screenIntegration: plaintext + no auth, private target, and the secure case', () => {
  const insecure = s.screenIntegration({ id: 1, type: 'servicenow', name: 'SN', base_url: 'http://sn.example', auth_type: 'none', enabled: true });
  assert.equal(insecure.posture, 'bad');
  assert.ok(insecure.security.some((c) => c.id === 'transport' && c.status === 'bad'));
  assert.ok(insecure.security.some((c) => c.id === 'auth' && c.status === 'bad'));

  const priv = s.screenIntegration({ id: 2, type: 'webhook', name: 'WH', base_url: 'https://10.0.0.5/hook', auth_type: 'token', enabled: true });
  assert.ok(priv.security.some((c) => c.id === 'target' && c.status === 'bad'));

  const good = s.screenIntegration({ id: 3, type: 'nautobot', name: 'NB', base_url: 'https://nb.example', auth_type: 'token', enabled: true });
  assert.equal(good.posture, 'ok');

  // A webhook with no auth is only a warning (not a hard bad like an ITSM target).
  const wh = s.screenIntegration({ id: 4, type: 'webhook', name: 'WH', base_url: 'https://wh.example', auth_type: 'none', enabled: true });
  assert.ok(wh.security.some((c) => c.id === 'auth' && c.status === 'warn'));
});

test('screenLdap: ldaps ok, remote plaintext bad, localhost plaintext info', () => {
  assert.equal(s.screenLdap({ host: 'dir.example', port: 636, use_tls: true, enabled: true }).posture, 'ok');
  assert.equal(s.screenLdap({ host: 'dir.example', port: 389, use_tls: false, enabled: true }).posture, 'bad');
  assert.equal(s.screenLdap({ host: '127.0.0.1', port: 389, use_tls: false, enabled: true }).posture, 'info');
  assert.equal(s.screenLdap({}).configured, false);
});

test('screenOidc / screenSaml: HTTPS endpoints and signature material', () => {
  assert.equal(s.screenOidc({ issuer: 'https://idp.example', configured: true, clientSecretSet: true }).posture, 'ok');
  assert.equal(s.screenOidc({ issuer: 'http://idp.example', configured: true }).posture, 'bad');

  assert.equal(s.screenSaml({ entryPoint: 'https://idp.example/sso', configured: true, idpCertSet: true }).posture, 'ok');
  assert.equal(s.screenSaml({ entryPoint: 'https://idp.example/sso', configured: true, idpCertSet: false }).posture, 'warn');
  assert.equal(s.screenSaml({ entryPoint: 'http://idp.example/sso', configured: true, idpCertSet: true }).posture, 'bad');
});

test('screenAssistant: EU HTTPS provider ok; plaintext bad; enabled-without-key warns', () => {
  assert.equal(s.screenAssistant({ baseUrl: 'https://api.mistral.ai/v1/chat/completions', configured: true }).posture, 'ok');
  assert.equal(s.screenAssistant({ baseUrl: 'http://llm.local/v1', configured: true }).posture, 'bad');
  assert.ok(s.screenAssistant({ baseUrl: 'https://api.mistral.ai/x', enabled: true, configured: false })
    .security.some((c) => c.id === 'key' && c.status === 'warn'));
});

test('screenMap: plaintext tiles warn (public data, not bad)', () => {
  assert.equal(s.screenMap({ tileUrl: 'https://tiles.example/{z}/{x}/{y}.png' }).posture, 'ok');
  assert.equal(s.screenMap({ tileUrl: 'http://tiles.example/{z}/{x}/{y}.png' }).posture, 'warn');
});

test('screenLicense: maps the manager status to a verdict', () => {
  assert.equal(s.screenLicense({ status: 'valid' }).posture, 'ok');
  assert.equal(s.screenLicense({ status: 'grace' }).posture, 'warn');
  assert.equal(s.screenLicense({ status: 'expired' }).posture, 'bad');
  assert.equal(s.screenLicense({ status: 'unknown' }).posture, 'info');
});
