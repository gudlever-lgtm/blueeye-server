'use strict';

// public/views/systemLogs.js — System Logs on the UI contract
// (docs/ui-contract.md).
//
// The migration this pins: the control row becomes a Toolbar, the level badge
// joins the app's one severity vocabulary, a server ring that cannot be read is
// an advisory rather than a footnote to the row count, and an empty table says
// which kind of empty it is.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const ENTRIES = [
  { id: 's1', ts: '2026-09-17T09:12:41.000Z', level: 'error', source: 'server', msg: 'MySQL connection lost', meta: { attempt: 2 } },
  { id: 's2', ts: '2026-09-17T09:12:03.000Z', level: 'warn', source: 'server', msg: 'agent missed 2 heartbeats' },
  { id: 's3', ts: '2026-09-17T09:11:55.000Z', level: 'info', source: 'server', msg: 'discovery sweep finished' },
  { id: 'c4', ts: '2026-09-17T09:10:02.000Z', level: 'error', source: 'client', msg: 'TypeError in flows', meta: { view: 'flows' } },
  { id: 's5', ts: '2026-09-17T09:09:00.000Z', level: 'debug', source: 'server', msg: 'retention pass' },
];

function boot({ t, routes = {}, url = 'http://server.test/logs', role = 'admin' } = {}) {
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
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/logs': { entries: ENTRIES },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const bar = (doc) => doc.querySelector('#view .toolbar-ui');
const sel = (doc, i) => [...bar(doc).querySelectorAll('select')][i];

test('System Logs is a ListPage with a Toolbar', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /System Logs/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.ok(bar(doc), 'the controls are not a Toolbar');
  assert.equal(doc.querySelectorAll('#view .history-controls').length, 0, 'the old control row survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading block survived');
  // Refresh is a toolbar action, not a loose button in the filter row.
  assert.match(bar(doc).querySelector('.toolbar-right button').textContent, /Refresh/);
  assert.equal(rows(doc).length, 5);
});

test('the level badge is on the app\'s one severity vocabulary', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const tones = rows(doc).map((r) => [...r.querySelector('.badge-ui').classList].filter((c) => c !== 'badge-ui')[0]);
  assert.deepEqual(tones, ['crit', 'warn', 'info', 'crit', 'neutral']);
  // `danger` and `active` were this screen's own words for the same thing.
  assert.equal(doc.querySelectorAll('#view .badge.danger, #view .badge.active').length, 0);
});

test('the dropdowns count over the set the other one narrowed', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  // 5 entries: 2 error, 1 warn, 1 info, 1 debug. "Warn+" is level >= warn = 3.
  assert.deepEqual([...sel(doc, 0).options].map((o) => o.textContent),
    ['All levels (5)', 'Debug+ (5)', 'Info+ (4)', 'Warn+ (3)', 'Errors only (2)']);
  assert.deepEqual([...sel(doc, 1).options].map((o) => o.textContent),
    ['All sources (5)', 'server (4)', 'dashboard (1)']);

  sel(doc, 1).value = 'client';
  sel(doc, 1).dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  // Now the LEVEL counts are over the dashboard rows only — one error.
  assert.deepEqual([...sel(doc, 0).options].map((o) => o.textContent),
    ['All levels (1)', 'Debug+ (1)', 'Info+ (1)', 'Warn+ (1)', 'Errors only (1)']);
  // …while the SOURCE counts still span every level, so the selection is
  // reversible without guessing.
  assert.deepEqual([...sel(doc, 1).options].map((o) => o.textContent),
    ['All sources (5)', 'server (4)', 'dashboard (1)']);
  assert.equal(rows(doc).length, 1);
});

test('the level filter is a floor, not an exact match', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  sel(doc, 0).value = 'warn';
  sel(doc, 0).dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 3, 'Warn+ did not include the errors');
  assert.match(doc.querySelector('#view .panel-head .meta-xs').textContent, /3 of 5/);
});

test('search goes to the server and filters the merged set', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const q = bar(doc).querySelector('input[type=search]');
  q.value = 'MySQL';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(600);
  assert.match(log.filter((x) => x.key === 'GET /api/logs').pop().url, /q=MySQL/);
  assert.equal(rows(doc).length, 1);
  assert.match(rows(doc)[0].textContent, /MySQL/);
  // The field is not rebuilt, so the caret stays where the reader left it.
  assert.equal(bar(doc).querySelector('input[type=search]'), q);
});

test('search also matches the meta, which is where the useful half often is', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const q = bar(doc).querySelector('input[type=search]');
  q.value = 'flows';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(600);
  assert.equal(rows(doc).length, 1);
  assert.match(rows(doc)[0].textContent, /TypeError/);
});

test('Clear filters is dead until there is something to clear', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const clear = () => [...bar(doc).querySelectorAll('button')].find((b) => /Clear filters/.test(b.textContent));
  assert.equal(clear().disabled, true);
  sel(doc, 0).value = 'error';
  sel(doc, 0).dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(clear().disabled, false);
  clear().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 5);
  assert.equal(bar(doc).querySelector('input[type=search]').value, '');
});

test('a filter that matches nothing is not the same as an empty ring', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const q = bar(doc).querySelector('input[type=search]');
  q.value = 'zzzzz';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(600);
  const state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No entries match/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Clear filters/.test(b.textContent)));

  const quiet = boot({ t, routes: SESSION({ 'GET /api/logs': { entries: [] } }) });
  await settle();
  const s2 = quiet.doc.querySelector('#view .state');
  assert.match(s2.textContent, /Nothing logged yet/);
  assert.equal(s2.querySelectorAll('button').length, 0, 'nothing to clear, but a Clear is offered');
});

test('a 500 on the ring is an advisory, and the local errors are still shown', async (t) => {
  // A toast here would re-enter recordClientLog, so it never was one — but it
  // used to be appended to the row count in the same grey span.
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/logs': { status: 500, body: { error: 'ring gone' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the ring');
  const note = doc.querySelector('#view .inline-note.is-warn');
  assert.ok(note, 'a ring that could not be read said nothing');
  assert.match(note.textContent, /ring gone/);
  assert.match(note.textContent, /this browser/);
  // Nothing was thrown, so the screen still renders its (empty) local ring.
  assert.ok(doc.querySelector('#view .state'), 'the table is not in a state at all');
});

test('a 404 on the ring is reported the same way, not as an empty log', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/logs': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const note = doc.querySelector('#view .inline-note.is-warn');
  assert.ok(note, 'a 404 was drawn as a quiet server');
  assert.match(note.textContent, /Not Found|404/i);
});

test('Refresh re-reads the ring', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const before = log.filter((x) => x.key === 'GET /api/logs').length;
  bar(doc).querySelector('.toolbar-right button').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/logs').length > before);
});
