'use strict';

// The login and forced-password-change screens on the UI contract
// (docs/ui-contract.md). They are static markup in index.html that render()
// never touches, so — like the sidebar — they carry data-i18n attributes that
// applyStaticTranslations() walks.
//
// The migration this pins: the login card off `.card` and onto the contract's
// tokens and controls, and the forced-change screen off hardcoded
// Danish-slash-English on every line.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, locale = null, token = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u), body: opts.body });
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  if (t) t.after(() => window.close());
  if (locale) window.localStorage.setItem('blueeye.locale', locale);
  if (token) {
    window.localStorage.setItem('blueeye.server.token', token);
    window.localStorage.setItem('blueeye.server.role', 'admin');
  }
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const SSO_OFF = { 'GET /auth/sso': { oidc: { enabled: false }, saml: { enabled: false } } };

test('the login card is on the contract, not on .card', async (t) => {
  const { doc, errors } = boot({ t, routes: SSO_OFF });
  await settle();
  assert.deepEqual(errors, []);
  const login = doc.querySelector('#login');
  assert.ok(login.classList.contains('ui'), 'the login screen is outside the .ui scope');
  assert.ok(login.classList.contains('ui-auth'));
  assert.equal(doc.querySelectorAll('#login .card, #force-change .card').length, 0, 'the old .card survived');
  assert.ok(doc.querySelector('#login .auth-card'));
  // Contract controls: labelled fields and one primary.
  assert.deepEqual([...login.querySelectorAll('.f > label')].map((l) => l.getAttribute('for')), ['email', 'password']);
  const submit = login.querySelector('button[type=submit]');
  assert.ok(submit.classList.contains('btn') && submit.classList.contains('btn-primary'));
  assert.equal(login.querySelectorAll('.btn-primary').length, 1, 'more than one primary on the login card');
});

test('every string on both screens comes from the catalogue', async (t) => {
  const { doc } = boot({ t, routes: SSO_OFF });
  await settle();
  // The forced-change screen used to read "Ny adgangskode / New password" on
  // every line — both languages at once, in the markup.
  for (const id of ['login', 'force-change']) {
    const screen = doc.querySelector(`#${id}`);
    for (const node of screen.querySelectorAll('label, button, p:not(.field-error), .auth-sub')) {
      if (!node.textContent.trim()) continue;
      assert.ok(node.hasAttribute('data-i18n'),
        `#${id}: "${node.textContent.trim()}" is hardcoded`);
    }
    assert.ok(!/ \/ /.test(screen.textContent), `#${id} still carries both languages at once`);
  }
});

test('the labels follow the language', async (t) => {
  const en = boot({ t, routes: SSO_OFF, locale: 'en' });
  await settle();
  assert.match(en.doc.querySelector('label[for=password]').textContent, /Password/);
  assert.match(en.doc.querySelector('#force-change p.meta').textContent, /Choose a new password/);

  const da = boot({ t, routes: SSO_OFF, locale: 'da' });
  await settle();
  assert.match(da.doc.querySelector('label[for=password]').textContent, /Adgangskode/);
  assert.match(da.doc.querySelector('#force-change p.meta').textContent, /V(æ|æ)lg en ny adgangskode/);
  assert.match(da.doc.querySelector('#login button[type=submit]').textContent, /Log ind/);
});

test('a 401 puts the reason on the form, and the error slot is empty until then', async (t) => {
  const { doc, window, errors } = boot({
    t, routes: Object.assign({ 'POST /auth/login': { status: 401, body: { error: 'Invalid credentials' } } }, SSO_OFF),
  });
  await settle();
  const err = doc.querySelector('#login-error');
  assert.equal(err.textContent, '', 'the error slot is not empty before anything went wrong');
  assert.ok(err.classList.contains('field-error'), 'the error is not on the contract');
  assert.equal(err.getAttribute('role'), 'alert', 'a failure nobody is told about');

  doc.querySelector('#password').value = 'wrong';
  doc.querySelector('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(errors, []);
  assert.match(doc.querySelector('#login-error').textContent, /Invalid credentials/);
  // The app stays hidden behind a failed sign-in.
  assert.ok(doc.querySelector('#app').classList.contains('hidden'));
});

test('a 500 on sign-in is reported the same way, and nothing else breaks', async (t) => {
  const { doc, window, errors } = boot({
    t, routes: Object.assign({ 'POST /auth/login': { status: 500, body: { error: 'boom' } } }, SSO_OFF),
  });
  await settle();
  doc.querySelector('#password').value = 'x';
  doc.querySelector('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(errors, []);
  assert.match(doc.querySelector('#login-error').textContent, /boom/);
  assert.ok(!doc.querySelector('#login').classList.contains('hidden'), 'the login screen went away on a failure');
});

test('SSO buttons are contract buttons, and absent when no method is live', async (t) => {
  const off = boot({ t, routes: SSO_OFF });
  await settle();
  assert.ok(off.doc.querySelector('#sso-options').classList.contains('hidden'),
    'an empty SSO block is still drawn');

  const on = boot({
    t,
    routes: { 'GET /auth/sso': { oidc: { enabled: true, loginUrl: '/auth/oidc/start' }, saml: { enabled: false } } },
  });
  await settle();
  const host = on.doc.querySelector('#sso-options');
  assert.ok(!host.classList.contains('hidden'));
  const link = host.querySelector('a');
  assert.ok(link.classList.contains('btn') && link.classList.contains('btn-secondary'),
    'the SSO button is not a contract button');
  assert.equal(link.getAttribute('href'), '/auth/oidc/start');
  assert.equal(on.doc.querySelectorAll('.sso-button').length, 0, 'the old class survived');
});

test('the forced-change screen checks the two new passwords match before asking', async (t) => {
  const { doc, window, log } = boot({
    t, token: 'T',
    routes: Object.assign({
      'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', must_change_password: true, preferences: {} },
    }, SSO_OFF),
  });
  await settle();
  doc.querySelector('#fc-current').value = 'one-time';
  doc.querySelector('#fc-new').value = 'aaaaaaaaaa';
  doc.querySelector('#fc-confirm').value = 'bbbbbbbbbb';
  doc.querySelector('#force-change-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.match(doc.querySelector('#fc-error').textContent, /not the same/);
  assert.equal(log.filter((x) => x.key === 'POST /auth/change-password').length, 0,
    'a mismatch was sent to the server anyway');
});

test('the server has the last word on the new password', async (t) => {
  const { doc, window } = boot({
    t, token: 'T',
    routes: Object.assign({
      'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', must_change_password: true, preferences: {} },
      'POST /auth/change-password': { status: 422, body: { error: 'Password is too short' } },
    }, SSO_OFF),
  });
  await settle();
  doc.querySelector('#fc-current').value = 'one-time';
  doc.querySelector('#fc-new').value = 'short';
  doc.querySelector('#fc-confirm').value = 'short';
  doc.querySelector('#force-change-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.match(doc.querySelector('#fc-error').textContent, /too short/);
});
