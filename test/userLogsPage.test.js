'use strict';

// public/views/userLogs.js — User Logs on the UI contract
// (docs/ui-contract.md).
//
// The migration this pins: three stacked lines per cell become one-line rows
// plus a Drawer, the "flagged: 3" badge in a grey line becomes a StatStrip that
// filters, and a failed load stops showing a red box above an empty table.

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
  { ts: '2026-09-17T09:12:41.000Z', userId: 4, name: null, email: 'ops@acme.dk', action: 'auth.login.failed', actionLabel: 'Sign-in failed', target: 'session', method: 'POST', path: '/auth/login', status: 401, ip: '10.0.0.44', flagLevel: 'critical', flags: [{ message: 'Four failed sign-ins in five minutes.' }] },
  { ts: '2026-09-17T09:05:02.000Z', userId: 1, name: 'Ada Lovelace', email: 'ada@blueeye.local', action: 'settings.retention.update', actionLabel: 'Changed retention', target: 'retention', method: 'PUT', path: '/api/settings/retention', status: 200, ip: '10.0.0.9', flagLevel: 'notice', flags: [{ message: 'Retention was shortened.' }] },
  { ts: '2026-09-17T08:58:10.000Z', userId: 1, name: 'Ada Lovelace', email: 'ada@blueeye.local', action: 'agent.delete', actionLabel: 'Deleted an agent', target: 'agent #18', method: 'DELETE', path: '/agents/18', status: 200, ip: '10.0.0.9', flagLevel: 'none', flags: [] },
  { ts: '2026-09-17T08:40:00.000Z', userId: 9, name: 'Removed account', email: 'gone@acme.dk', deletedUser: true, action: 'report.export', actionLabel: 'Exported a report', target: 'nis2/readiness', status: 200, ip: '10.0.0.71', flagLevel: 'warn', flags: [{ message: 'The account no longer exists.' }] },
];
const LOG = { total: 128, summary: { total: 128, users: 5, flagged: 3 }, entries: ENTRIES };

function boot({ t, routes = {}, url = 'http://server.test/user-logs', role = 'admin' } = {}) {
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
    return {
      ok: status < 300, status, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => ({}),
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
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
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /users': [{ id: 1, name: 'Ada Lovelace', email: 'ada@blueeye.local' }, { id: 4, name: null, email: 'ops@acme.dk' }],
  'GET /api/audit/users': LOG,
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const bar = (doc) => doc.querySelector('#view .toolbar-ui');
const stats = (doc) => [...doc.querySelectorAll('#view .stat-card')];

test('User Logs is a ListPage with a StatStrip and a Toolbar', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /User Logs/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.ok(bar(doc), 'the controls are not a Toolbar');
  assert.equal(doc.querySelectorAll('#view .history-controls').length, 0, 'the old control row survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading block survived');
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-n').textContent), ['128', '5', '3']);
  assert.equal(rows(doc).length, 4);
});

test('a row is one line — the rest is in the Drawer', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  // Five columns, one line each. The raw action key, the request line and the
  // flag's reasons used to be stacked inside three of these cells.
  assert.deepEqual([...doc.querySelectorAll('#view table.dt thead th')].map((h) => h.textContent.trim()),
    ['When', 'Name', 'Action', 'Target', 'Flag']);
  assert.ok(!/auth\.login\.failed/.test(rows(doc)[0].textContent), 'the raw action key is still in the row');
  assert.ok(!/HTTP 401/.test(rows(doc)[0].textContent), 'the request line is still in the row');
  assert.ok(!/Four failed sign-ins/.test(rows(doc)[0].textContent), 'the flag reasons are still in the row');

  rows(doc)[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(drawer, 'the row opened nothing');
  assert.match(drawer.querySelector('h2').textContent, /Sign-in failed/);
  assert.match(drawer.textContent, /Four failed sign-ins/);
  assert.match(drawer.textContent, /auth\.login\.failed/);
  assert.match(drawer.textContent, /POST \/auth\/login/);
  assert.match(drawer.textContent, /401/);
  assert.match(drawer.textContent, /10\.0\.0\.44/);
  assert.match(drawer.textContent, /ops@acme\.dk/);
});

test('an unflagged row carries no badge, and its drawer has no "why"', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const clean = rows(doc)[2];
  assert.equal(clean.querySelectorAll('.badge-ui').length, 0, 'a green OK on every line is noise');
  clean.dispatchEvent(new window.Event('click', { bubbles: true }));
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(!/Why this is flagged/i.test(drawer.textContent), 'an unflagged row explains a flag it does not have');
  assert.match(drawer.textContent, /agent\.delete/);
});

test('a deleted account is said so, in the row\'s drawer', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  rows(doc)[3].dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.match(doc.querySelector('.ui-drawer').textContent, /account deleted since/);
});

test('the flag tones are the app\'s, not this screen\'s', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const tone = (i) => {
    const b = rows(doc)[i].querySelector('.badge-ui');
    return b ? [...b.classList].filter((c) => c !== 'badge-ui')[0] : null;
  };
  assert.deepEqual([tone(0), tone(1), tone(2), tone(3)], ['crit', 'neutral', null, 'warn']);
});

test('the flagged count is the filter', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const flagged = () => stats(doc)[2];
  assert.equal(flagged().getAttribute('aria-pressed'), 'false');
  flagged().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/audit/users').pop().url, /flagged=1/);
  assert.equal(flagged().getAttribute('aria-pressed'), 'true');
  // …and it un-filters, which the old checkbox did too but a count could not.
  flagged().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(!/flagged=1/.test(log.filter((x) => x.key === 'GET /api/audit/users').pop().url));
});

test('the user picker lists the accounts that exist now', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const sel = bar(doc).querySelector('select');
  assert.deepEqual([...sel.options].map((o) => o.textContent),
    ['All users', 'Ada Lovelace · ada@blueeye.local (#1)', 'ops@acme.dk (#4)']);
  sel.value = '4';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/audit/users').pop().url, /user=4/);
});

test('a 500 on the user list costs the picker, never the log', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /users': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.deepEqual([...bar(doc).querySelector('select').options].map((o) => o.textContent), ['All users']);
  assert.equal(rows(doc).length, 4, 'the log went down with the dropdown');
});

test('search is debounced and goes to the server', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const q = bar(doc).querySelector('input[type=search]');
  q.value = 'retention';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(600);
  assert.match(log.filter((x) => x.key === 'GET /api/audit/users').pop().url, /q=retention/);
  assert.equal(bar(doc).querySelector('input[type=search]'), q, 'the field was rebuilt and lost the caret');
});

test('an empty log and an empty filter are different states', async (t) => {
  const { doc, window } = boot({
    t, routes: SESSION({ 'GET /api/audit/users': { total: 0, summary: { total: 0, users: 0, flagged: 0 }, entries: [] } }),
  });
  await settle();
  let state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No user activity recorded yet/);
  assert.equal(state.querySelectorAll('button').length, 0, 'nothing to clear, but a Clear is offered');

  stats(doc)[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No user activity matches/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Clear filters/.test(b.textContent)));
});

test('a 500 on the log is an ErrorState, not a red box above an empty table', async (t) => {
  const { doc, errors, window, log } = boot({
    t, routes: SESSION({ 'GET /api/audit/users': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the log');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed load is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/api\/audit\/users/);
  // The failure and an empty table are no longer both on screen.
  assert.equal(doc.querySelectorAll('#view table.dt').length, 0);
  assert.equal(stats(doc).length, 0, 'the summary kept showing numbers the load never returned');

  const before = log.filter((x) => x.key === 'GET /api/audit/users').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/audit/users').length > before, 'Retry did not retry');
});

test('a 404 on the log is reported, not drawn as an empty audit trail', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/audit/users': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 was drawn as "nobody did anything"');
  assert.match(err.textContent, /Not Found|404/i);
});

test('CSV export asks for the same rows the table is showing', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  stats(doc)[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  [...doc.querySelectorAll('#view .page-head button')].find((b) => /CSV/.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const call = log.find((x) => x.key === 'GET /api/audit/users/export.csv');
  assert.ok(call, 'the export asked for nothing');
  assert.match(call.url, /flagged=1/, 'the export ignored the filter the reader set');
});
