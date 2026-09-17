'use strict';

// public/views/locations.js — Locations on the UI contract
// (docs/ui-contract.md).
//
// The migration this pins: six buttons in every row's last cell, with Delete
// one mis-click from Edit, become one hover action and a ⋯ menu; an empty
// estate offers the button that fixes it; a failed load is an ErrorState rather
// than a blank page.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const LOCS = [
  { id: 1, name: 'Oslo HQ', description: 'Head office', latitude: 59.9, longitude: 10.7 },
  { id: 2, name: 'Copenhagen DC', description: null, latitude: 55.7, longitude: 12.6 },
];

function boot({ t, routes = {}, url = 'http://server.test/locations', role = 'admin' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 250));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /locations': LOCS,
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];

test('Locations is a ListPage with one primary action', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Locations/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .page-head .btn-primary').length, 1, 'more than one primary');
  assert.ok(headBtns(doc).some((b) => /New location/.test(b.textContent)));
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading block survived');
});

test('the six row buttons become one action and a menu', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(rows(doc).length, 2);
  const act = rows(doc)[0].querySelector('.row-act');
  assert.ok(act, 'no row actions');
  // One visible-on-hover action, one ⋯ — not six buttons in a cell.
  assert.equal(act.querySelectorAll('button').length, 2);
  assert.match(act.querySelector('button.on-hover').textContent, /Edit/);
  assert.equal(doc.querySelectorAll('#view .row-actions').length, 0, 'the old button row survived');

  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const menu = doc.querySelector('.ui-rowmenu');
  assert.ok(menu, 'the ⋯ opened no menu');
  const labels = [...menu.querySelectorAll('button')].map((b) => b.textContent);
  assert.deepEqual(labels, ['Live traffic', 'Traffic history', 'AI status', 'Delete location']);
  // Delete is destructive, last, and behind a separator.
  const del = [...menu.querySelectorAll('button')].pop();
  assert.ok(del.classList.contains('danger'), 'Delete is not marked destructive');
  assert.ok(menu.querySelector('hr'), 'Delete sits flush against the reads');
});

test('a viewer is offered neither New, nor Edit, nor Delete', async (t) => {
  const { doc, window } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(headBtns(doc).filter((b) => /New location/.test(b.textContent)).length, 0);
  const act = rows(doc)[0].querySelector('.row-act');
  assert.equal(act.querySelectorAll('button.on-hover').length, 0, 'a viewer is offered Edit');
  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const labels = [...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent);
  assert.deepEqual(labels, ['Live traffic', 'Traffic history', 'AI status'], 'a viewer is offered Delete');
});

test('AI status goes when the licence excludes the assistant', async (t) => {
  const { doc, window } = boot({
    t, routes: SESSION({ 'GET /license/features': { assistant: false } }),
  });
  await settle();
  rows(doc)[0].querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const labels = [...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent);
  assert.ok(!labels.includes('AI status'), 'a menu entry that answers 403 is still offered');
  assert.ok(labels.includes('Live traffic'), 'the rest of the menu went with it');
});

test('the row opens the location', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /locations/1': { id: 1, name: 'Oslo HQ' } }) });
  await settle();
  rows(doc)[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/locations/1');
});

test('an empty estate offers the button that fixes it', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /locations': [] }) });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'no EmptyState');
  assert.match(state.textContent, /No locations yet/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /New location/.test(b.textContent)),
    'the empty state says there is nothing and offers no way to change that');
  assert.equal(doc.querySelectorAll('#view .empty').length, 0, 'the old grey sentence survived');
});

test('a 500 is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors, window, log } = boot({
    t, routes: SESSION({ 'GET /locations': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the load');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed load is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/locations/);

  const before = log.filter((x) => x.key === 'GET /locations').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /locations').length > before, 'Retry did not retry');
});

test('a 404 on the list is reported, not rendered as an empty estate', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /locations': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 was drawn as "no locations yet"');
  assert.match(err.textContent, /Not Found|404/i);
});
