'use strict';

// public/views/settings.js — Settings' page shell on the UI contract
// (docs/ui-contract.md).
//
// A SHELL migration: the twenty-two section bodies stay in public/app.js. What
// is tested here is the page they sit on — twenty-two buttons pretending to be
// tabs becoming two levels of SubTabs, the licence pill becoming a Badge that
// moves with the section, and a section that throws no longer replacing the
// whole page with a red box.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/settings/retention', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u) });
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
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': { analysis: true, alerting: true, rbac: true, api_access: true, assistant: false, geo: true, service_tests: true },
  'GET /license/plan': { plan_name: 'Professional', modules: {} },
  'GET /api/settings/retention': { rawDays: 30, aggregatedDays: 365, findingsDays: 180 },
  'GET /api/settings': { retention: { rawDays: 30 } },
}, over);

const strips = (doc) => [...doc.querySelectorAll('#view .ui-page > div > [role="tablist"]')];
const tabsIn = (strip) => [...strip.querySelectorAll('.subtab')];
const activeIn = (strip) => (tabsIn(strip).find((b) => b.getAttribute('aria-selected') === 'true') || {}).dataset;

test('twenty-two buttons become two levels of SubTabs', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Settings/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  // The old picker: .settings-nav, five clusters of .small ghost buttons.
  assert.equal(doc.querySelectorAll('#view .settings-nav, #view .navlist').length, 0,
    'the button clusters survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading block survived');

  assert.equal(strips(doc).length, 2, 'there are not exactly two strips');
  assert.deepEqual(tabsIn(strips(doc)[0]).map((b) => b.textContent),
    ['Access & security', 'Detection & alerts', 'Data', 'System', 'Personal']);
  // The second strip is the sections of the group the URL landed in.
  assert.deepEqual(tabsIn(strips(doc)[1]).map((b) => b.dataset.tab),
    ['database', 'retention', 'types', 'map']);
  assert.equal(activeIn(strips(doc)[0]).tab, '2', 'Data is not the selected group');
  assert.equal(activeIn(strips(doc)[1]).tab, 'retention');
});

test('a deep link selects the group its section is in', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/settings/apitokens', routes: SESSION({ 'GET /api/tokens': { tokens: [] } }) });
  await settle();
  assert.equal(activeIn(strips(doc)[0]).tab, '0', 'Access & security is not selected');
  assert.equal(activeIn(strips(doc)[1]).tab, 'apitokens');
  assert.match(doc.querySelector('#crumb').textContent, /API tokens/, 'the crumb printed the raw tab key');
});

test('picking a section puts it in the URL and leaves the group where it is', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /api/traffic-types': { types: [] } }) });
  await settle();
  tabsIn(strips(doc)[1]).find((b) => b.dataset.tab === 'types')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/settings/types');
  assert.equal(activeIn(strips(doc)[0]).tab, '2', 'the group moved under the reader');
  assert.equal(activeIn(strips(doc)[1]).tab, 'types');
});

test('picking a group opens that group\'s first section', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /users': [] }) });
  await settle();
  tabsIn(strips(doc)[0]).find((b) => b.dataset.tab === '0')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  // A group with nothing selected under it is a strip with no page behind it.
  assert.equal(window.location.pathname, '/settings/users');
  assert.equal(activeIn(strips(doc)[1]).tab, 'users');
  assert.deepEqual(tabsIn(strips(doc)[1]).map((b) => b.dataset.tab),
    ['users', 'auth', 'apitokens', 'agentkey']);
});

test('the licence answer is a Badge that moves with the section', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const badge = () => doc.querySelector('#view .toolbar-ui .badge-ui');
  // Retention is baseline — in every licence, not gateable.
  assert.ok(badge().classList.contains('ok'));
  assert.match(badge().textContent, /included/);
  assert.equal(doc.querySelectorAll('#view .settings-license-row').length, 0, 'the old pill row survived');
  assert.equal(doc.querySelectorAll('#view .badge.active, #view .badge.bad').length, 0, 'the old pill classes survived');

  // AI is excluded by this licence, so its section says so.
  tabsIn(strips(doc)[0]).find((b) => b.dataset.tab === '1')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  tabsIn(strips(doc)[1]).find((b) => b.dataset.tab === 'ai')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(badge().classList.contains('crit'), 'an excluded section reads as included');
  assert.match(badge().textContent, /not in your licence/);
});

test('a non-admin sees only the sections their role can open', async (t) => {
  const { doc } = boot({
    t, role: 'viewer', url: 'http://server.test/settings/appearance',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  // Every group but Personal is admin-only, so the group strip collapses too.
  assert.deepEqual(tabsIn(strips(doc)[0]).map((b) => b.textContent), ['Personal']);
  assert.deepEqual(tabsIn(strips(doc)[1]).map((b) => b.dataset.tab), ['appearance', 'license']);
});

test('a viewer deep-linking to an admin section lands on one they can open', async (t) => {
  const { doc, window } = boot({
    t, role: 'viewer', url: 'http://server.test/settings/database',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(activeIn(strips(doc)[1]).tab, 'appearance', 'a section they cannot open was drawn empty');
  assert.equal(window.location.pathname, '/settings/appearance', 'the address still names a section they cannot open');
});

test('a section that throws stays inside its own slot', async (t) => {
  const { doc, errors, window, log } = boot({
    t, url: 'http://server.test/settings/retention',
    routes: SESSION({ 'GET /api/settings': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the section');
  assert.equal(strips(doc).length, 2, 'the strips went down with the section');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed section is not an ErrorState');
  assert.match(err.textContent, /Retention could not be loaded/);
  assert.match(err.textContent, /boom/);
  assert.equal(doc.querySelectorAll('#view .empty.error').length, 0, 'the old red box survived');
  // The section is still the selected one, so Retry has something to retry.
  assert.equal(activeIn(strips(doc)[1]).tab, 'retention');
  const before = log.filter((x) => x.key === 'GET /api/settings').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/settings').length > before, 'Retry did not retry');
});

test('a 404 inside a section is reported, not drawn as an empty section', async (t) => {
  const { doc, errors } = boot({
    t, url: 'http://server.test/settings/retention', routes: SESSION({ 'GET /api/settings': undefined }),
  });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 section drew nothing');
  assert.match(err.textContent, /Not Found|404/i);
});

test('the shell does not draw a second panel around the section\'s own', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // Retention draws its own .settings-card with its own heading; a panel around
  // it is a box inside a box with the section's name on both.
  assert.ok(doc.querySelector('#view .settings-card'), 'the section body is gone');
  assert.equal(doc.querySelectorAll('#view .panel-ui').length, 0,
    'the shell wrapped the section in a second panel');
});
