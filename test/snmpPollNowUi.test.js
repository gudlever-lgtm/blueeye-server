'use strict';

// The dashboard half of two E2E findings:
//   N2 — "Poll now" now gets the agent's answer back, and says it in words:
//        how many devices answered, or that this device is not the agent's.
//   N1 — the certificate panel reads chain trust apart from the name, so a
//        certificate for the wrong virtual host no longer shows "does not
//        validate — ERR_TLS_CERT_ALTNAME_INVALID" under Chain.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I18n = require('../public/i18n');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// One top-level function out of app.js, evaluated with t()/plural() bound to
// the real catalogue.
function load(name, locale = 'en') {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in public/app.js`);
  const end = src.indexOf('\n}\n', start);
  I18n.setLocale(locale);
  const ctx = { t: (k, p) => I18n.t(k, p), plural: (k, n, p) => I18n.plural(k, n, p) };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end + 2)}; this.fn = ${name};`, ctx);
  return ctx.fn;
}

test('poll-now says what the agent answered', () => {
  const outcome = load('snmpPollOutcome');
  const res = (result) => ({ ok: true, pending: false, result });
  assert.equal(outcome(res({ devices: 2, polled: 2, failed: 0, deviceAssigned: true })), 'Polled 2 devices: 2 answered, 0 did not.');
  assert.equal(outcome(res({ devices: 1, polled: 0, failed: 1, deviceAssigned: true })), 'Polled 1 device: 0 answered, 1 did not.');
  assert.match(outcome(res({ devices: 3, polled: 3, failed: 0, deviceAssigned: false })), /not assigned to the polling agent/);
  assert.match(outcome(res({ devices: 0, polled: 0, failed: 0, deviceAssigned: false })), /no SNMP devices assigned/);
  assert.match(outcome(res({ error: 'handler failed: boom' })), /could not poll: handler failed: boom/);
  // 202: still polling (or an agent too old to answer) — the old message.
  assert.equal(outcome({ ok: true, pending: true }), I18n.t('snmpdev.poll.queued', {}, 'en'));
});

test('poll-now reads in Danish too', () => {
  const outcome = load('snmpPollOutcome', 'da');
  try {
    assert.equal(outcome({ pending: false, result: { devices: 2, polled: 1, failed: 1, deviceAssigned: true } }), 'Pollede 2 enheder: 1 svarede, 1 svarede ikke.');
    assert.match(outcome({ pending: false, result: { devices: 2, deviceAssigned: false } }), /ikke tildelt/);
  } finally { I18n.setLocale('en'); }
});

test('the poll-now keys exist in both catalogues', () => {
  for (const key of ['snmpdev.poll.running', 'snmpdev.poll.done.one', 'snmpdev.poll.done.other', 'snmpdev.poll.notAssigned',
    'snmpdev.poll.noDevices', 'snmpdev.poll.failed', 'probe.tls.nameBadFor']) {
    assert.ok(I18n.has(key, 'en') && I18n.has(key, 'da'), `${key} missing from a catalogue`);
  }
});

test('the certificate panel reads chain trust apart from a name mismatch', () => {
  const chainTrusted = load('tlsChainTrusted');
  assert.equal(chainTrusted({ authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID', chainTrusted: true }), true);
  // A row stored before the server kept chainTrusted.
  assert.equal(chainTrusted({ authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' }), true);
  assert.equal(chainTrusted({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), false);
  assert.equal(chainTrusted({ authorized: true }), true);
  assert.equal(chainTrusted({ authorized: false, chainTrusted: false }), false);
  assert.equal(I18n.t('probe.tls.nameBadFor', { name: 'shop.example.dk' }, 'en'), 'NOT valid for shop.example.dk');
});
