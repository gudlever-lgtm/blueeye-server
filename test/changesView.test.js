'use strict';

// public/views/changes.js — Changes on the UI contract (docs/ui-contract.md).
//
// The screen is a ListPage now, but it is the same screen: the checks below are
// the behaviour that must survive the migration, not the markup that changed.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const FEED = {
  since: '2026-09-10T08:14:00.000Z', total: 3, rawTotal: 40, correlated: 37,
  returned: 3, partial: false, failedSources: [], truncated: false, groups: [],
  events: [
    { timestamp: '2026-09-12T14:02:00.000Z', firstAt: '2026-09-12T13:00:00.000Z', source: 'probe', type: 'probe.latency.degraded', severity: 'CRIT', summary: 'latency degraded at oslo-edge-01', agentId: 7, kind: 'probe', metric: 'latency', family: 'latency', count: 135, findingCount: 0 },
    { timestamp: '2026-09-12T10:44:00.000Z', firstAt: '2026-09-12T10:44:00.000Z', source: 'finding', type: 'finding.loss', severity: 'WARN', summary: 'loss on cph-core-02', agentId: 8, kind: 'finding', metric: 'loss', family: 'loss', count: 1, findingCount: 2 },
    { timestamp: '2026-09-11T16:22:00.000Z', firstAt: '2026-09-11T16:22:00.000Z', source: 'topology', type: 'topology.device_seen', severity: 'INFO', summary: 'new device on VLAN 42', agentId: null, kind: 'topology', metric: null, family: null, count: 1, findingCount: 0 },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/changes', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push({ key, url: String(u), body: opts.body });
    const hit = routes[key];
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
const settle = () => new Promise((r) => setTimeout(r, 90));
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [
    { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' },
    { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02' },
  ],
  'GET /api/changes': FEED,
  'POST /api/changes/seen': { ok: true },
}, over);

test('Changes is a ListPage: PageHeader, StatStrip, Toolbar, DataTable — and no info banner', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const ui = doc.querySelector('#view .ui.ui-page');
  assert.ok(ui, 'Changes is not built from the contract components');
  assert.ok(ui.querySelector('.page-head h1'), 'no PageHeader');
  assert.ok(ui.querySelector('.page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner came back');
  assert.equal(ui.querySelectorAll('.page-head-actions .btn-primary').length, 1, 'one primary, no more');
  assert.match(ui.querySelector('.page-head-actions .btn-primary').textContent, /Mark as seen/);
  assert.ok(ui.querySelector('.statstrip .stat-card.crit'), 'no StatStrip');
  assert.ok(ui.querySelector('.toolbar-ui'), 'no Toolbar');
  assert.ok(ui.querySelector('table.dt'), 'the list is not a real table');
  assert.equal(ui.querySelectorAll('table.dt tbody tr').length, 3);
});

test('Changes still asks the server the same question, with the window and the marker', async (t) => {
  const { log } = boot({ t, routes: SESSION() });
  await settle();
  const call = log.find((c) => c.key === 'GET /api/changes');
  assert.ok(call, 'the feed was never fetched');
  const q = new URL(call.url, 'http://server.test').searchParams;
  assert.equal(q.get('window'), '24h', 'the default window changed');
  assert.equal(q.get('since'), 'last_login', 'the reference marker was dropped');
});

test('THE MARKER RULE: a load never moves it; Mark as seen does', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(log.filter((c) => c.key === 'POST /api/changes/seen').length, 0,
    'loading the page moved the marker — the page could then never show anybody anything again');

  doc.querySelector('#view .page-head-actions .btn-primary')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(log.filter((c) => c.key === 'POST /api/changes/seen').length, 1);
  assert.ok(doc.querySelector('#ui-toasts .ui-toast'), 'no confirmation that it moved');
});

test('the window picker offers the vocabulary the server accepts, and re-asks with it', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const sel = doc.querySelector('#view .toolbar-ui select');
  assert.deepEqual([...sel.options].map((o) => o.value), ['last_seen', '30m', '6h', '24h', '7d'],
    'the picker offers a window the server would 400 on');
  assert.equal(sel.value, 'last_seen', 'the default is no longer "since last seen"');
  sel.value = '7d';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const last = log.filter((c) => c.key === 'GET /api/changes').pop();
  const q = new URL(last.url, 'http://server.test').searchParams;
  assert.equal(q.get('window'), '7d');
  // The server lets since=last_login win over window whenever a marker exists,
  // so sending both made the picker do nothing for anyone who had marked seen.
  assert.equal(q.get('since'), null, 'a fixed window still carries the marker, so the server ignores the window');
  assert.equal(doc.querySelector('#view .toolbar-ui select').value, '7d', 'the picker forgot the choice');
});

test('Mark as seen switches the picker back to "since last seen"', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const sel = doc.querySelector('#view .toolbar-ui select');
  sel.value = '30m';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  doc.querySelector('#view .page-head-actions .btn-primary')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const last = log.filter((c) => c.key === 'GET /api/changes').pop();
  assert.equal(new URL(last.url, 'http://server.test').searchParams.get('since'), 'last_login');
  assert.equal(doc.querySelector('#view .toolbar-ui select').value, 'last_seen');
});

test('the StatStrip filters the table, and clicking the active card clears it', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const rows = () => doc.querySelectorAll('#view table.dt tbody tr').length;
  assert.equal(rows(), 3);
  const crit = doc.querySelector('#view .stat-card.crit');
  crit.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(), 1, 'the card did not filter');
  assert.equal(doc.querySelector('#view .stat-card.crit').getAttribute('aria-pressed'), 'true');
  doc.querySelector('#view .stat-card.crit').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(), 3, 'the filter would not clear');
});

test('a row opens the Drawer with its explanation, and the host is a link, not a chip', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const row = doc.querySelector('#view table.dt tbody tr');
  assert.ok(row.querySelector('a.hostlink'), 'the host is not a link');
  assert.equal(row.querySelectorAll('.chip, .fs-chip, .badge:not(.badge-ui)').length, 0, 'a chip survived');
  row.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(drawer, 'the row opened nothing');
  assert.ok(drawer.querySelector('.drawer-head .badge-ui.crit'), 'no severity on the Drawer header');
  assert.match(drawer.textContent, /Round-trip time is well above its baseline/,
    'the explanation did not come with the row');
  assert.match(drawer.textContent, /135/, 'the repeat count is not in the history');
});

test('a partial result stays on screen as an inline note, not hidden behind the (?)', async (t) => {
  const partial = Object.assign({}, FEED, { partial: true, failedSources: ['topology', 'flows'] });
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/changes': partial }) });
  await settle();
  const note = doc.querySelector('#view .inline-note.is-warn');
  assert.ok(note, 'the partial-result warning disappeared in the migration');
  assert.match(note.textContent, /topology, flows/);
});

test('an empty feed is an EmptyState that names the reference time', async (t) => {
  const empty = Object.assign({}, FEED, { events: [], total: 0, correlated: 0 });
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/changes': empty }) });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'no EmptyState');
  assert.equal(state.classList.contains('is-error'), false);
  assert.match(state.textContent, /2026/, 'the empty state does not say since when');
  assert.equal(doc.querySelector('#view table.dt'), null);
});

test('a 500 is an ErrorState with the failing call, and the shell survives it', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/changes': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, [], 'the 500 threw instead of rendering');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/changes/, 'the error does not say what failed');
  assert.ok(err.querySelector('.btn'), 'no retry');
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
});

test('a viewer sees the screen; the sidebar marks it and the breadcrumb names it', async (t) => {
  const { doc } = boot({ t, role: 'viewer', routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }) });
  await settle();
  assert.ok(doc.querySelector('#view table.dt'), 'a viewer cannot read Changes');
  const active = doc.querySelector('.tabs button.active');
  assert.equal(active.dataset.view, 'changes');
  assert.match(doc.getElementById('crumb').textContent, /Monitoring/);
  assert.match(doc.getElementById('crumb').textContent, /Changes/);
});
