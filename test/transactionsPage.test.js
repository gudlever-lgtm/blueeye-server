'use strict';

// public/views/transactions.js — Transaction tests on the UI contract
// (docs/ui-contract.md).
//
// A SHELL migration: the header, the tabs and the list are on the contract; the
// create/edit form, the matrix and the per-test detail are passed in whole.
// These tests hold the shell's behaviour and the list's: Delete moved into the
// ⋯ menu, the type and the enabled flag are badges, and the unmigrated builders
// can still get back to the list.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const TESTS = [
  { id: 1, name: 'checkout', type: 'http', target: 'https://shop.example/checkout', agent_ids: [7, 8], interval_sec: 60, enabled: true },
  { id: 2, name: 'auth-dns', type: 'dns', target: 'login.example', agent_ids: [7], interval_sec: 300, enabled: false },
  { id: 3, name: 'vpn-icmp', type: 'icmp', target: '10.0.0.1', agent_ids: [], interval_sec: 30, enabled: true },
];

function boot({ t, routes = {}, url = 'http://server.test/transaction-tests', role = 'admin' } = {}) {
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
  window.confirm = () => true;
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
const settle = () => new Promise((r) => setTimeout(r, 180));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/transactions': TESTS,
  'GET /agents': [{ id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' }],
  'DELETE /api/transactions/2': { ok: true },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];
const tabs = (doc) => [...doc.querySelectorAll('#view [role="tablist"] .subtab')];

test('Transaction tests is a ListPage: PageHeader, one primary, SubTabs, DataTable', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old head survived');
  assert.equal(doc.querySelectorAll('#view table.data-table').length, 0, 'the legacy table survived');
  assert.equal(doc.querySelectorAll('#view .page-head-actions .btn-primary').length, 1);
  assert.deepEqual(tabs(doc).map((b) => b.textContent), ['List', 'Matrix']);
  assert.equal(rows(doc).length, 3);
});

test('the type and the enabled flag are badges, not chips and not plain text', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(doc.querySelectorAll('#view .chip').length, 0, 'the type is still a chip');
  const first = rows(doc).find((r) => /checkout/.test(r.textContent));
  assert.match(first.children[1].querySelector('.badge-ui').textContent, /http/);
  assert.match(first.children[5].querySelector('.badge-ui').textContent, /Active/);
  const off = rows(doc).find((r) => /auth-dns/.test(r.textContent));
  assert.match(off.children[5].querySelector('.badge-ui').textContent, /Disabled/);
  assert.ok(off.children[5].querySelector('.badge-ui').classList.contains('neutral'));
});

test('Edit is the row action; Delete is behind the ⋯ menu', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const acts = [...rows(doc)[0].querySelectorAll('.row-act > button')];
  assert.equal(acts.length, 2, 'the two-button cell survived');
  assert.match(acts[0].textContent, /Edit/);
  acts[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const menu = doc.querySelector('.ui-rowmenu');
  assert.ok(menu, 'no ⋯ menu');
  const del = [...menu.querySelectorAll('button')].find((b) => /Delete/.test(b.textContent));
  assert.ok(del, 'Delete is not in the menu');
  assert.ok(del.classList.contains('danger'), 'Delete is not marked destructive');
});

test('deleting confirms, calls the API, and comes back to the list', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const row = rows(doc).find((r) => /auth-dns/.test(r.textContent));
  [...row.querySelectorAll('.row-act > button')][1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => /Delete/.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'DELETE /api/transactions/2'), 'nothing was deleted');
  // The unmigrated builders navigate back to "the list", which is the view's.
  assert.ok(rows(doc).length, 'the list did not come back after the delete');
});

test('the table sorts from its header', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const names = () => rows(doc).map((r) => r.querySelector('a.hostlink').textContent);
  assert.deepEqual(names(), ['auth-dns', 'checkout', 'vpn-icmp']);
  const header = [...doc.querySelectorAll('#view table.dt thead th')].find((th) => /^Interval/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const intervals = rows(doc).map((r) => parseInt(r.children[4].textContent, 10));
  assert.deepEqual(intervals, [...intervals].sort((a, b) => b - a), `not sorted: ${intervals.join(', ')}`);
});

test('a viewer sees the list but is offered nothing to change', async (t) => {
  const { doc } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 1, email: 'x@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(rows(doc).length, 3, 'a viewer cannot read the list');
  assert.equal(doc.querySelectorAll('#view .page-head-actions .btn').length, 0, 'a viewer was offered "New test"');
  assert.equal(doc.querySelectorAll('#view .row-act').length, 0, 'a viewer was offered the row actions');
});

test('an empty list is an EmptyState with a way to make the first one', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/transactions': [] }) });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state);
  assert.match(state.textContent, /No transaction tests yet/i);
  assert.ok(state.querySelector('.btn'), 'no way to make one');
});

test('the Matrix tab hands over to the unmigrated builder', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  tabs(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(tabs(doc)[1].getAttribute('aria-selected'), 'true');
  // The matrix reads the tests AND the agents; the list reads only the tests.
  assert.ok(log.some((x) => x.key === 'GET /agents'), 'the matrix builder did not run');
  assert.equal(window.location.pathname, '/transaction-tests/matrix');
});

test('a 500 on the list is reported, and the shell survives', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/transactions': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  assert.equal(rows(doc).length, 0);
});
