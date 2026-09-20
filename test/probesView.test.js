'use strict';

// public/views/probes.js — the Probes & Tests page shell on the UI contract.
//
// The shell is migrated; the three tab bodies are not yet. These tests hold the
// line that matters while that is true: the page is a FormPage with one tab
// pattern and one help control, the tab is in the address, and the bodies still
// render and still do their work.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CHECKS = {
  host: null,
  checks: [
    { id: 'dns', type: 'dns', port: null, available: true, appliesTo: 'hostname', applies: true },
    { id: 'ping', type: 'ping', port: null, available: true, appliesTo: 'any', applies: true },
    { id: 'tcp443', type: 'tcp', port: 443, available: true, appliesTo: 'any', applies: true },
    { id: 'tls', type: 'tcp', port: 443, available: false, appliesTo: 'any', applies: false },
  ],
};

function boot({ t, url = 'http://server.test/probes', routes = {}, role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push(`${(opts.method || 'GET').toUpperCase()} ${p}`);
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
const settle = () => new Promise((r) => setTimeout(r, 120));
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [{ id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', status: 'online' }],
  'GET /api/connection-test/checks': CHECKS,
  'GET /api/test-packages': [],
  'GET /api/probes': [],
  'GET /api/targets': [],
}, over);

test('Probes is a FormPage shell: PageHeader with (?), SubTabs, and no info banner', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const ui = doc.querySelector('#view .ui.ui-page');
  assert.ok(ui, 'the page is not built from the contract components');
  assert.ok(ui.querySelector('.page-head h1'), 'no PageHeader');
  assert.equal(ui.querySelector('.page-head h1').textContent.replace('?', '').trim(), 'Probes & Tests');
  assert.ok(ui.querySelector('.page-head .help-btn'), 'no (?) help control');
  assert.equal(ui.querySelectorAll('.page-head p').length, 1, 'the lead is one line');
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner came back');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the legacy page heading survived');
});

test('the four tabs are one strip, built by tabStrip, with one tab stop', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const strip = doc.querySelector('#view .subtabs[role="tablist"]');
  assert.ok(strip, 'the tabs are not a tablist');
  const tabs = [...strip.querySelectorAll('.subtab')];
  assert.deepEqual(tabs.map((b) => b.dataset.tab), ['run', 'connection', 'burst', 'packages']);
  assert.equal(tabs.filter((b) => b.getAttribute('aria-selected') === 'true').length, 1);
  assert.equal(tabs.filter((b) => b.tabIndex === 0).length, 1, 'the strip has one tab stop');
  assert.equal(doc.querySelectorAll('#view .seg-btn').length, 0, 'a second tab pattern survived');
});

test('the (?) carries the help the banner used to, and it is the ACTIVE tab’s help', async (t) => {
  const { doc, window } = boot({ t, url: 'http://server.test/probes/connection', routes: SESSION() });
  await settle();
  doc.querySelector('#view .help-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  const pop = doc.querySelector('.ui-popover');
  assert.ok(pop, 'the (?) opened nothing');
  assert.match(pop.textContent, /Connection test/, 'the popover shows another tab’s help');
  assert.match(pop.textContent, /Stop/, 'the Connection test help lost its Stop section');
});

test('the tab is in the address: a deep link opens it, and picking one moves the address', async (t) => {
  const { doc, window } = boot({ t, url: 'http://server.test/probes/packages', routes: SESSION() });
  await settle();
  const sel = () => doc.querySelector('#view .subtab[aria-selected="true"]').dataset.tab;
  assert.equal(sel(), 'packages', 'the deep link did not open its tab');

  [...doc.querySelectorAll('#view .subtab')].find((b) => b.dataset.tab === 'connection')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/probes/connection', 'the address did not follow the tab');
  assert.equal(sel(), 'connection');

  window.history.back();
  await settle();
  assert.equal(window.location.pathname, '/probes/packages', 'Back did not return to the previous tab');
});

test('the tab bodies still render — the shell migration did not take them with it', async (t) => {
  for (const [tab, marker] of [['connection', /Connection test|Run/i], ['packages', /package|Test/i]]) {
    const { doc, errors } = boot({ t, url: `http://server.test/probes/${tab}`, routes: SESSION() });
    await settle();
    assert.deepEqual(errors, [], `${tab}: threw`);
    const body = doc.querySelector('#view .ui.ui-page').lastElementChild;
    assert.ok(body.textContent.trim().length > 20, `${tab}: rendered nothing`);
    assert.match(body.textContent, marker, tab);
  }
});

test('the Connection test body still reads the server catalogue, not a list of its own', async (t) => {
  const { log } = boot({ t, url: 'http://server.test/probes/connection', routes: SESSION() });
  await settle();
  assert.ok(log.includes('GET /api/connection-test/checks'),
    'the screen stopped asking the server what it can run');
});

test('a failing tab body is an ErrorState inside the shell, not a blank page', async (t) => {
  const { doc, errors } = boot({
    t,
    url: 'http://server.test/probes/connection',
    routes: SESSION({ 'GET /api/connection-test/checks': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, [], 'the 500 threw');
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive the 500');
  assert.ok(doc.querySelector('#view .subtabs'), 'the tabs did not survive the 500');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive the 500');
});
