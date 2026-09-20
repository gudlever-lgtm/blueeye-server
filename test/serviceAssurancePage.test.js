'use strict';

// public/views/serviceAssurance.js — Service Assurance's page shell on the UI
// contract (docs/ui-contract.md).
//
// A SHELL migration: the eight tab bodies stay in public/serviceAssurance.js
// (5,100 lines, ships standalone). What is tested here is the page they sit on
// — the PageHeader the screen never had, and the tab strip that is now the
// shared one rather than the module's own copy of it.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const APPS = [
  { id: 1, name: 'Checkout', description: 'the paying bit', base_url: 'https://shop.example', environment_count: 2, test_count: 9, enabled: true, last_discovery: null },
  { id: 2, name: 'Portal', base_url: 'https://portal.example', environment_count: 1, test_count: 3, enabled: true, last_discovery: null },
];

function boot({ t, routes = {}, url = 'http://server.test/service-assurance', role = 'admin' } = {}) {
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
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}
const settle = () => new Promise((r) => setTimeout(r, 200));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/service-tests/applications': APPS,
  'GET /api/service-tests/journeys': [],
  'GET /api/service-tests/tests': [],
  'GET /api/service-tests/runs': [],
  'GET /api/service-tests/schedules': [],
  'GET /api/service-tests/monitors': [],
  'GET /api/service-tests/worker': { worker_count: 0, workers: [] },
}, over);

const tabs = (doc) => [...doc.querySelectorAll('#view [role="tablist"] .subtab')];

test('Service Assurance sits on a PageHeader it never had', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  const h1 = doc.querySelector('#view .page-head h1');
  assert.ok(h1, 'no PageHeader — the section name appeared only in the nav');
  assert.match(h1.textContent, /Service Assurance/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
});

test('the tab strip is the shared one, not the module\'s own copy', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(doc.querySelectorAll('#view .sa-tabs').length, 0, 'the module still draws its own strip');
  const strip = doc.querySelector('#view [role="tablist"]');
  assert.ok(strip, 'no tab strip');
  assert.ok(strip.classList.contains('subtabs'), 'the strip is not the shared component');
  assert.deepEqual(tabs(doc).map((b) => b.dataset.tab), [
    'applications', 'journeys', 'tests', 'runs', 'history', 'health', 'schedules', 'monitors',
  ]);
  // One stop in the tab order; the arrows move within.
  assert.equal(tabs(doc).filter((b) => b.tabIndex === 0).length, 1);
  // The route's first tab is Health, and so is the nav's first entry — a bare
  // /service-assurance opens there.
  assert.equal(tabs(doc).find((b) => b.getAttribute('aria-selected') === 'true').dataset.tab, 'health');
});

test('the module still draws the body', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION(), url: 'http://server.test/service-assurance/applications' });
  await settle();
  const body = doc.querySelector('#view .sa .sa-body');
  assert.ok(body, 'the module body is gone');
  assert.ok(log.some((x) => x.key === 'GET /api/service-tests/applications'), 'the tab did not load');
  assert.match(body.textContent, /Checkout/);
});

test('picking a tab switches the body and puts the tab in the URL', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const schedules = tabs(doc).find((b) => b.dataset.tab === 'schedules');
  schedules.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/service-tests/schedules'), 'the schedules tab did not load');
  assert.equal(window.location.pathname, '/service-assurance/schedules');
});

test('a deep link opens on that tab', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION(), url: 'http://server.test/service-assurance/monitors' });
  await settle();
  const active = tabs(doc).find((b) => b.getAttribute('aria-selected') === 'true');
  assert.equal(active.dataset.tab, 'monitors');
  assert.ok(log.some((x) => x.key === 'GET /api/service-tests/monitors'));
});

test('a 500 in a tab body stays inside the body — the shell survives', async (t) => {
  const { doc, errors } = boot({ t, url: 'http://server.test/service-assurance/applications', routes: SESSION({ 'GET /api/service-tests/applications': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader went down with the body');
  assert.ok(doc.querySelector('#view [role="tablist"]'), 'the tab strip went down with the body');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  assert.ok(doc.querySelector('#view .sa-error'), 'the body did not report the failure');
});

test('the standalone module still owns its own shell without the flag', async (t) => {
  // The module ships standalone, so `embedded` has to be opt-in: without it the
  // tab bar is still the module's.
  const src = fs.readFileSync(path.join(PUBLIC, 'serviceAssurance.js'), 'utf8');
  assert.match(src, /var embedded = ctx\.mode === 'embedded';/);
  assert.match(src, /if \(embedded\) mount\(host, body\);\s*\n\s*else mount\(host, tabBar\(\), body\);/);
  assert.match(src, /function tabBar\(\)/, 'the standalone tab bar was removed');
  void t;
});
