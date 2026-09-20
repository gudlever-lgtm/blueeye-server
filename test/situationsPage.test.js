'use strict';

// public/views/situations.js — Situations on the UI contract
// (docs/ui-contract.md).
//
// "Loading…", "No situations match." and the error were all one <td colspan=6>
// — three different answers wearing the same clothes. They are a skeleton, an
// EmptyState and an ErrorState now. These tests hold that, and the behaviour
// the page had: the status filter reaches the server, and a row opens the
// situation.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CLUSTERS = [
  { id: 21, confidence: 'high', status: 'open', memberFindingIds: [1, 2, 3, 4], suspectedCommonCause: 'Uplink saturation at Oslo', createdAt: '2026-09-12T13:40:00.000Z', detectedAt: '2026-09-12T14:02:00.000Z' },
  { id: 22, confidence: 'medium', status: 'acknowledged', memberFindingIds: [5, 6], suspectedCommonCause: 'DNS resolver slow', createdAt: '2026-09-12T11:20:00.000Z', detectedAt: '2026-09-12T12:00:00.000Z' },
  { id: 23, confidence: 'low', status: 'resolved', memberFindingIds: [7], suspectedCommonCause: null, createdAt: '2026-09-11T22:05:00.000Z', detectedAt: '2026-09-11T23:00:00.000Z' },
];

function boot({ t, routes = {}, url = 'http://server.test/situations', role = 'operator' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 180));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/event-clusters': { clusters: CLUSTERS },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];
const cards = (doc) => [...doc.querySelectorAll('#view .statstrip .stat-card')];

test('Situations is a ListPage: PageHeader, StatStrip, Toolbar, DataTable', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .clusters-view').length, 0, 'the old wrapper survived');
  assert.equal(doc.querySelectorAll('#view table.data').length, 0, 'the hand-built table survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0);
  assert.equal(cards(doc).length, 4);
  assert.equal(rows(doc).length, 3);
});

test('the strip counts by status and filters through the server', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(cards(doc).map((c) => c.querySelector('.stat-n').textContent), ['1', '1', '1', '0']);
  cards(doc).find((c) => /Acknowledged/.test(c.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/event-clusters').pop().url, /status=acknowledged/);
  assert.equal(doc.querySelector('#view .toolbar-ui select').value, 'acknowledged');
});

test('the three "nothing here" answers are three different things', async (t) => {
  // Empty.
  const empty = boot({ t, routes: SESSION({ 'GET /api/event-clusters': { clusters: [] } }) });
  await settle();
  const st = empty.doc.querySelector('#view .state');
  assert.ok(st && !st.classList.contains('is-error'));
  assert.match(st.textContent, /No situations yet/i);

  // Failed.
  const bad = boot({ t, routes: SESSION({ 'GET /api/event-clusters': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  const err = bad.doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failure reads as an empty list');
  assert.match(err.textContent, /GET \/api\/event-clusters/);
  assert.deepEqual(bad.errors, []);
  assert.ok(bad.doc.querySelector('#view .page-head h1'), 'the header went down with the table');
});

test('a filter that matched nothing offers a way out; an empty list does not', async (t) => {
  // The server answers a filtered read with an empty set, so the page has to
  // tell the two apart from its own filter state, not from the response.
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /api/event-clusters': { clusters: [] } }) });
  await settle();
  const before = doc.querySelector('#view .state');
  assert.match(before.textContent, /No situations yet/i);
  assert.equal(before.querySelectorAll('.btn').length, 0, 'an empty list offered a filter to clear');

  const sel = doc.querySelector('#view .toolbar-ui select');
  sel.value = 'closed';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const after = doc.querySelector('#view .state');
  assert.match(after.textContent, /No situations in that state/i);
  assert.ok(after.querySelector('.btn'), 'no way out of the filter');
  after.querySelector('.btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(doc.querySelector('#view .state').textContent, /No situations yet/i);
});

test('the table sorts from its header and the cause opens the situation', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const header = [...doc.querySelectorAll('#view table.dt thead th')].find((th) => /^Members/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const members = rows(doc).map((r) => Number(r.children[2].textContent));
  assert.deepEqual(members, [4, 2, 1]);

  rows(doc)[0].querySelector('a.hostlink').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(window.location.pathname, '/situations/21');
});

test('a situation with no common cause says so instead of showing a dash', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const none = rows(doc).find((r) => /Low/.test(r.textContent));
  assert.match(none.children[3].textContent, /No common cause identified/i);
});

test('confidence and status are badges that follow the palette', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const first = rows(doc)[0];
  const conf = first.children[0].querySelector('.badge-ui');
  const status = first.children[1].querySelector('.badge-ui');
  assert.ok(conf && status, 'the badges are gone');
  assert.equal(doc.querySelectorAll('#view .badge.conf-high').length, 0, 'the legacy badge class survived');
  assert.equal(doc.querySelectorAll('#view .badge.inc-status-open').length, 0, 'the legacy status class survived');
  assert.match(conf.textContent, /High/);
  assert.match(status.textContent, /Open/);
});

test('a row opens the situation', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  rows(doc)[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/situations/22');
});
