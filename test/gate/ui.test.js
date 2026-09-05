'use strict';

// GATE · UI — blueeye-server dashboard (public/)
//
// The dashboard is dependency-free vanilla JS with no build step, so nothing
// catches a broken page before a browser does. This suite (1) parses every
// shipped asset, (2) checks the contract between index.html, app.js, the
// i18n catalogues and the API (data-view ↔ views.<tab> ↔ PAGE_INFO, role and
// feature attributes, t() keys present in BOTH locales, api() paths mounted),
// and (3) boots the real dashboard in jsdom against a fake fetch to exercise
// the login screen, the session boot and the role-gated navigation.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');

const { makeApp } = require('../../test-support/fakes');
const I18n = require('../../public/i18n');
const { KNOWN_FEATURES } = require('../../src/license/features');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const jsFiles = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.js'));
const cssFiles = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css'));

const uniq = (arr) => [...new Set(arr)];
const dom0 = new JSDOM(html);
const navButtons = [...dom0.window.document.querySelectorAll('button[data-view]')];
const dataViews = uniq(navButtons.map((b) => b.dataset.view));
const viewHandlers = uniq([...appJs.matchAll(/^views\.([A-Za-z]+) = /gm)].map((m) => m[1]));
const app = makeApp();

// ---------------------------------------------------------------- assets
test('every public/*.js parses as a classic script and every *.css is balanced', () => {
  for (const f of jsFiles) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { filename: f }), f);
  }
  for (const f of cssFiles) {
    const css = fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!css.includes('/*') && !css.includes('*/'), `${f}: stray comment delimiter`);
    const opens = (css.match(/\{/g) || []).length;
    const closes = (css.match(/\}/g) || []).length;
    assert.equal(opens, closes, `${f}: ${opens} { vs ${closes} }`);
  }
});

test('index.html: local assets exist and are served; external assets are only the CSP-allowed Leaflet CDN; no inline scripts', async () => {
  const doc = dom0.window.document;
  assert.ok(doc.querySelector('meta[name="viewport"]'));
  assert.ok(doc.title.includes('BlueEyes'));
  const refs = [
    ...[...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')),
    ...[...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href')),
  ];
  for (const ref of refs) {
    if (/^https?:/.test(ref)) {
      assert.match(ref, /^https:\/\/unpkg\.com\/leaflet/, `${ref}: external asset outside the CSP allowlist`);
      continue;
    }
    assert.ok(ref.startsWith('/'), `${ref}: relative asset`);
    const file = ref.split('?')[0];
    assert.ok(fs.existsSync(path.join(PUBLIC, file)), `${ref} missing on disk`);
    const res = await request(app).get(ref);
    assert.equal(res.status, 200, `${ref} → ${res.status}`);
    assert.match(res.headers['content-type'], file.endsWith('.css') ? /text\/css/ : /javascript/, ref);
  }
  assert.equal(doc.querySelectorAll('script:not([src])').length, 0, 'inline <script> would violate the CSP');
  const inlineHandlers = [...doc.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on\w+/i.test(a.name)));
  assert.deepEqual(inlineHandlers.map((e) => e.outerHTML.slice(0, 60)), [], 'inline on* handlers would violate the CSP');
});

test('GET / serves the dashboard as HTML with the version-stamped assets', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  const version = require('../../package.json').version;
  assert.ok(res.text.includes(`/app.js?v=${version}`), 'app.js is not cache-busted with the current version');
});

// ---------------------------------------------------------------- html ↔ js contract
test('every data-view button has a views.<tab> handler', () => {
  assert.ok(dataViews.length >= 20, `only ${dataViews.length} nav views`);
  const missing = dataViews.filter((v) => !viewHandlers.includes(v));
  assert.deepEqual(missing, []);
});

test('every nav view has a PAGE_INFO help entry', () => {
  const start = appJs.indexOf('const PAGE_INFO = {');
  assert.ok(start > 0);
  const block = appJs.slice(start, appJs.indexOf('\n};', start));
  const inline = [...block.matchAll(/^  ([A-Za-z_]+): \{/gm)].map((m) => m[1]);
  const later = [...appJs.matchAll(/^PAGE_INFO\.([A-Za-z_]+) = \{/gm)].map((m) => m[1]);
  const missing = dataViews.filter((v) => !inline.includes(v) && !later.includes(v));
  assert.deepEqual(missing, []);
});

test('data-min-role and data-feature attributes use known values', () => {
  for (const b of navButtons) {
    if (b.dataset.minRole !== undefined) assert.ok(['operator', 'admin'].includes(b.dataset.minRole), `${b.dataset.view}: data-min-role=${b.dataset.minRole}`);
    if (b.dataset.feature !== undefined) assert.ok(KNOWN_FEATURES.includes(b.dataset.feature), `${b.dataset.view}: unknown feature ${b.dataset.feature}`);
  }
  const roleGated = navButtons.filter((b) => b.dataset.minRole).map((b) => b.dataset.view);
  for (const must of ['discovery', 'logs', 'enrollment']) assert.ok(roleGated.includes(must), `${must} lost its role gate`);
});

test('every t() key used by the dashboard exists in BOTH locales, and the catalogues are in parity', () => {
  const missing = [];
  for (const f of jsFiles) {
    if (f === 'i18n.js') continue;
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)) {
      for (const locale of I18n.LOCALES) if (!I18n.has(m[1], locale)) missing.push(`${f}: ${m[1]} (${locale})`);
    }
  }
  assert.deepEqual(uniq(missing), []);
  for (const locale of I18n.LOCALES) assert.deepEqual(I18n.missingKeys(locale), [], `${locale} catalogue incomplete`);
  const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
  for (const k of Object.keys(I18n.STRINGS.en)) {
    assert.deepEqual(placeholders(I18n.STRINGS.da[k]), placeholders(I18n.STRINGS.en[k]), `placeholder mismatch: ${k}`);
  }
});

test('every API path app.js calls is mounted on the server', () => {
  const routesIndex = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'index.js'), 'utf8');
  const mounted = [...routesIndex.matchAll(/router\.use\('(\/[\w/-]+)'/g)].map((m) => m[1]);
  assert.ok(mounted.length >= 50);
  const called = uniq([...appJs.matchAll(/api\((?:`|')(\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1]));
  assert.ok(called.length >= 100, `found ${called.length} api() calls`);
  const unmounted = called.filter((p) => !mounted.some((m) => p === m || p.startsWith(`${m}/`)));
  assert.deepEqual(unmounted, []);
});

// ---------------------------------------------------------------- jsdom boot
function fakeFetch(routes, log) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const k = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push(k);
    const hit = routes[k];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found', path: p } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

// Every booted window is closed when its test ends: app.js arms refresh
// timers and a live-update socket at boot, and an open jsdom window would keep
// the test process alive after the last assertion.
async function boot({ routes = {}, token = null, role = null, t = null } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String(e && e.message || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const log = [];
  window.fetch = fakeFetch(routes, log);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  if (t) t.after(() => window.close());
  if (token) window.localStorage.setItem('blueeye.server.token', token);
  if (role) window.localStorage.setItem('blueeye.server.role', role);
  const scripts = [...window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')).filter((s) => s.startsWith('/'));
  for (const s of scripts) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  await new Promise((r) => setTimeout(r, 60));
  return { window, doc: window.document, errors, log };
}
const hidden = (el) => el.classList.contains('hidden');

test('boot: without a token the login form is shown, the app is hidden and no script throws', async (t) => {
  const { doc, errors, log } = await boot({ t, routes: { 'GET /auth/sso': { methods: [] } } });
  assert.deepEqual(errors, []);
  assert.equal(hidden(doc.getElementById('login')), false);
  assert.equal(hidden(doc.getElementById('app')), true);
  assert.ok(log.includes('GET /auth/sso'), 'SSO discovery is queried for the login screen');
  assert.ok(!log.some((k) => k.startsWith('GET /api/')), 'no authenticated API call before login');
});

test('boot: a failed login shows the server message', async (t) => {
  const { doc } = await boot({ t, routes: { 'GET /auth/sso': { methods: [] }, 'POST /auth/login': { status: 401, body: { error: 'Invalid credentials' } } } });
  doc.getElementById('email').value = 'a@b.dk';
  doc.getElementById('password').value = 'nope';
  doc.getElementById('login-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(doc.getElementById('login-error').textContent, 'Invalid credentials');
  assert.equal(hidden(doc.getElementById('app')), true);
});

test('boot: with a session the app renders and navigation is role-gated', async (t) => {
  const me = { id: 1, email: 'x@y.dk', role: 'viewer', preferences: {} };
  for (const role of ['viewer', 'operator', 'admin']) {
    const { doc, errors } = await boot({ t, token: 'T', role, routes: { 'GET /me': { ...me, role }, 'GET /auth/sso': { methods: [] }, 'GET /license': { plan: 'professional', features: {} } } });
    assert.deepEqual(errors, [], `${role}: uncaught error during boot`);
    assert.equal(hidden(doc.getElementById('app')), false, `${role}: app hidden`);
    assert.equal(hidden(doc.getElementById('login')), true, `${role}: login shown`);
    const rank = { viewer: 1, operator: 2, admin: 3 };
    for (const b of doc.querySelectorAll('.tabs button[data-min-role]')) {
      const shouldHide = rank[role] < rank[b.dataset.minRole];
      assert.equal(b.classList.contains('role-hidden'), shouldHide, `${role}: tab ${b.dataset.view} (min ${b.dataset.minRole})`);
    }
  }
});

test('boot: a 401 on an authenticated call tears the session down', async (t) => {
  const { doc, window } = await boot({ t, token: 'T', role: 'admin', routes: { 'GET /me': { status: 401, body: { error: 'Invalid or expired token' } } } });
  assert.equal(hidden(doc.getElementById('login')), false);
  assert.equal(window.localStorage.getItem('blueeye.server.token'), null);
});

test('boot: server-supplied strings are never parsed as HTML in the user menu / views (XSS)', async (t) => {
  const XSS = '<img src=x onerror="window.__pwned=1">';
  const { window, doc } = await boot({ t, token: 'T', role: 'admin', routes: { 'GET /me': { id: 1, email: XSS, role: 'admin', name: XSS, preferences: {} }, 'GET /auth/sso': { methods: [] } } });
  assert.equal(window.__pwned, undefined);
  assert.equal(doc.querySelector('#app img[src="x"]'), null, 'payload was parsed as markup');
});
