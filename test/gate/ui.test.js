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
const { ALL_FEATURE_KEYS } = require('../../src/license/plans');

// A nav button may be gated by EITHER a legacy proof feature (analysis/assistant/
// alerting/geo) or a packaged plan key (api_access, service_tests, …). Checking
// only KNOWN_FEATURES rejected every plan key, so no plan-gated tab could pass
// the gate at all — this widens the sweep to the real set, it does not loosen it.
const GATEABLE_FEATURES = [...new Set([...KNOWN_FEATURES, ...ALL_FEATURE_KEYS])];

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
    if (b.dataset.feature !== undefined) assert.ok(GATEABLE_FEATURES.includes(b.dataset.feature), `${b.dataset.view}: unknown feature ${b.dataset.feature}`);
  }
  const roleGated = navButtons.filter((b) => b.dataset.minRole).map((b) => b.dataset.view);
  for (const must of ['discovery', 'logs', 'enrollment']) assert.ok(roleGated.includes(must), `${must} lost its role gate`);
});

test('every tab strip is built by tabStrip(), and the tab look is a strip rather than a button', () => {
  // A hand-rolled .subtabs container renders the same and behaves worse: no
  // roving tabindex, no arrow keys, and nothing telling a screen reader the row
  // is a tablist. The helper is the only place allowed to make one.
  const HELPER = "class: `subtabs${className ? ` ${className}` : ''}`,";
  const rogue = [];
  for (const f of jsFiles) {
    if (f === 'i18n.js') continue;
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of src.matchAll(/class:\s*[`'"][^`'"]*\bsubtabs\b[^`'"]*[`'"],?/g)) {
      if (f === 'app.js' && m[0].startsWith('class: `subtabs${className')) continue;
      rogue.push(`${f}: ${m[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(rogue, [], 'build tab strips with tabStrip() so they keep the keyboard and the screen reader');
  assert.ok(appJs.includes(HELPER), 'tabStrip() no longer builds the strip — update this rule with it');

  // Service Assurance ships its own stylesheet and its own tab bar (the module
  // is extractable by design), so it is checked where it lives rather than
  // exempted: same roles, same roving tabindex.
  const sa = fs.readFileSync(path.join(PUBLIC, 'serviceAssurance.js'), 'utf8');
  for (const needed of ["role: 'tablist'", "role: 'tab'", "'aria-selected'", 'ArrowRight']) {
    assert.ok(sa.includes(needed), `serviceAssurance.js tab bar is missing ${needed}`);
  }

  // The look itself: the selected tab is marked by the accent rule under the
  // strip, not by a button's background — that similarity is what made a tab
  // indistinguishable from a form control in the first place.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  const active = css.slice(css.indexOf('.subtabs .subtab.active'));
  assert.match(active.slice(0, 200), /border-bottom-color:\s*var\(--accent\)/, 'the active tab lost its underline');
  const saCss = fs.readFileSync(path.join(PUBLIC, 'serviceAssurance.css'), 'utf8');
  assert.match(saCss.slice(saCss.indexOf('.sa-tab.active'), saCss.indexOf('.sa-tab.active') + 200), /border-bottom-color/);
});

test('every t() key used by the dashboard exists in BOTH locales, and the catalogues are in parity', () => {
  const missing = [];
  for (const f of jsFiles) {
    if (f === 'i18n.js') continue;
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'/g)) {
      for (const locale of I18n.LOCALES) if (!I18n.has(m[1], locale)) missing.push(`${f}: ${m[1]} (${locale})`);
    }
    // A counted line carries two catalogue entries — `key.one` and `key.other` —
    // and plural() picks between them. Both have to exist in both locales, or
    // the sentence renders as the key on whichever count nobody tested.
    for (const m of src.matchAll(/\bplural\('([a-zA-Z0-9_.-]+)'/g)) {
      for (const form of ['one', 'other']) {
        for (const locale of I18n.LOCALES) {
          if (!I18n.has(`${m[1]}.${form}`, locale)) missing.push(`${f}: ${m[1]}.${form} (${locale})`);
        }
      }
    }
  }
  assert.deepEqual(uniq(missing), []);
  for (const locale of I18n.LOCALES) assert.deepEqual(I18n.missingKeys(locale), [], `${locale} catalogue incomplete`);
  const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
  for (const k of Object.keys(I18n.STRINGS.en)) {
    assert.deepEqual(placeholders(I18n.STRINGS.da[k]), placeholders(I18n.STRINGS.en[k]), `placeholder mismatch: ${k}`);
  }
});

test('the static sidebar is fully translatable: every nav control carries a data-i18n key that exists in BOTH locales', () => {
  const doc = dom0.window.document;
  // The rail is static markup — render() never rewrites it, so anything without
  // a data-i18n attribute stays in whichever language it was typed in. (That is
  // how "Transaktionstests" once sat in the English menu.) Sweep every control
  // in .tabs, not just the ones somebody remembered to key.
  const unkeyed = [...doc.querySelectorAll('.tabs button')]
    .filter((b) => !b.dataset.i18n)
    .map((b) => b.dataset.view || b.textContent.trim());
  assert.deepEqual(unkeyed, [], 'nav controls with no data-i18n key');

  // Every key the markup names — text and the two attribute forms — has to
  // resolve in both locales, or the rail renders the key itself.
  const ATTRS = [['data-i18n', 'i18n'], ['data-i18n-title', 'i18nTitle'], ['data-i18n-aria-label', 'i18nAriaLabel']];
  const missing = [];
  for (const [attr, prop] of ATTRS) {
    for (const node of doc.querySelectorAll(`[${attr}]`)) {
      const key = node.dataset[prop];
      for (const locale of I18n.LOCALES) if (!I18n.has(key, locale)) missing.push(`${attr}=${key} (${locale})`);
    }
  }
  assert.deepEqual(uniq(missing), []);
});

test('every API path app.js calls is mounted on the server', () => {
  const routesIndex = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'index.js'), 'utf8');
  const mounted = [...routesIndex.matchAll(/router\.use\('(\/[\w/-]+)'/g)].map((m) => m[1]);
  assert.ok(mounted.length >= 50);
  // withLocale() wraps the path for the server-rendered NIS2 documents, so the
  // sweep has to look through it as well as at a bare api('/…') call.
  const called = uniq([...appJs.matchAll(/api\((?:withLocale\()?(?:`|')(\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1]));
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

test('boot: switching the language relabels the static sidebar, and the nav-group identities survive it', async (t) => {
  const me = { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} };
  const { doc, window } = await boot({
    t, token: 'T', role: 'admin',
    routes: { 'GET /me': me, 'GET /auth/sso': { methods: [] }, 'GET /license': { plan: 'professional', features: {} }, 'PUT /me/preferences': { ok: true } },
  });
  const btn = (view) => doc.querySelector(`.tabs button[data-view="${view}"]`);
  assert.equal(btn('changes').textContent, I18n.STRINGS.en['nav.view.changes']);
  assert.equal(btn('transactions').textContent, 'Transaction tests', 'the English menu must not carry a Danish label');

  // Drive the real control, not the helper: the account menu's DA button is
  // what a user presses, and it is the wiring (setLocale → the static rail)
  // that regressed before, not the lookup.
  const da = [...doc.querySelectorAll('#lang-switch button')].find((b) => b.textContent === 'DA');
  assert.ok(da, 'no DA button in the language switch');
  da.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(window.I18n.getLocale(), 'da');
  assert.equal(btn('changes').textContent, I18n.STRINGS.da['nav.view.changes']);
  assert.equal(btn('settings').textContent, I18n.STRINGS.da['nav.view.settings']);
  assert.equal(doc.querySelector('#nav-toggle').getAttribute('aria-label'), I18n.STRINGS.da['nav.toggle']);

  // data-category is the stable identity setupNavGroups remembers collapsed
  // state under. Translating the visible label must not move it.
  const cats = [...doc.querySelectorAll('.tabs .nav-group')].map((g) => g.dataset.category);
  assert.deepEqual(cats, ['Monitoring', 'Fleet', 'Diagnostics', 'Service Assurance', 'Insights', 'Guides', 'Administration']);
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
