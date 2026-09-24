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

// ---------------------------------------------------------------- acknowledge
// Acknowledge used to be a toast and nothing else. It now stores the ack
// (POST /api/changes/ack) and the row leaves the default "Not acknowledged" list.
const ACK_FEED = () => ({
  ...FEED,
  events: FEED.events.map((e, i) => ({ ...e, ackKey: String(i + 1).repeat(64), acknowledgedAt: i === 2 ? '2026-09-12T15:00:00.000Z' : null })),
});
const click = (window, node) => node.dispatchEvent(new window.Event('click', { bubbles: true }));
const rowButtons = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr .row-act .btn-secondary')];

test('an acknowledged row is hidden by default and counted in the note', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/changes': ACK_FEED() }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 2, 'the acknowledged row is still listed');
  assert.match(doc.querySelector('#view').textContent, /1 acknowledged hidden/);
  assert.equal(doc.querySelector('#view .stat-card.info .stat-value, #view .stat-card.info').textContent.match(/\d+/)[0], '0',
    'the INFO card still counts the acknowledged INFO row');
});

test('Acknowledge stores the ack and takes the row out of the list', async (t) => {
  const { doc, window, log } = boot({
    t,
    routes: SESSION({
      'GET /api/changes': ACK_FEED(),
      'POST /api/changes/ack': { key: '1'.repeat(64), acknowledgedAt: '2026-09-22T10:00:00.000Z' },
    }),
  });
  await settle();
  const btn = rowButtons(doc)[0];
  assert.match(btn.textContent, /Acknowledge/);
  click(window, btn);
  await settle();
  const call = log.find((c) => c.key === 'POST /api/changes/ack');
  assert.ok(call, 'Acknowledge did not call the server');
  assert.deepEqual(JSON.parse(call.body), { key: '1'.repeat(64) });
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 1, 'the row did not leave the list');
  assert.ok(doc.querySelector('#ui-toasts .ui-toast'), 'no confirmation');
});

test('Show → Acknowledged lists them with an Undo that calls DELETE', async (t) => {
  const { doc, window, log } = boot({
    t,
    routes: SESSION({ 'GET /api/changes': ACK_FEED(), [`DELETE /api/changes/ack/${'3'.repeat(64)}`]: { status: 204, body: null } }),
  });
  await settle();
  const show = [...doc.querySelectorAll('#view .toolbar-ui select')].find((s) => [...s.options].some((o) => o.value === 'acked'));
  assert.ok(show, 'no Show selector');
  show.value = 'acked';
  show.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const rows = doc.querySelectorAll('#view table.dt tbody tr');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Acknowledged/);
  const undo = rowButtons(doc)[0];
  assert.match(undo.textContent, /Undo acknowledge/);
  click(window, undo);
  await settle();
  assert.ok(log.find((c) => c.key === `DELETE /api/changes/ack/${'3'.repeat(64)}`), 'Undo did not call the server');
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 0);
});

test('a failed acknowledge says so and keeps the row', async (t) => {
  const { doc, window } = boot({
    t,
    routes: SESSION({ 'GET /api/changes': ACK_FEED(), 'POST /api/changes/ack': { status: 500, body: { error: 'Internal Server Error' } } }),
  });
  await settle();
  click(window, rowButtons(doc)[0]);
  await settle();
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 2);
  assert.ok(doc.querySelector('#ui-toasts .ui-toast.err'), 'the failure was silent');
});

// ---------------------------------------------------------------- mute this rule
// Mute used to be a toast and nothing else. It now mutes the row's rule (source
// + type, every host) for 24h via POST /api/changes/mute.
const MUTE_FEED = () => {
  const f = ACK_FEED();
  f.events = f.events.map((e, i) => ({ ...e, muteKey: String.fromCharCode(97 + i).repeat(64), mutedUntil: null }));
  // A second row of the first row's rule, on another host.
  f.events.push({ ...f.events[0], agentId: 8, summary: 'latency degraded at cph-core-02', ackKey: '9'.repeat(64) });
  return f;
};
const openMenu = (doc, window, rowIndex) => {
  const tr = doc.querySelectorAll('#view table.dt tbody tr')[rowIndex];
  click(window, tr.querySelector('.row-act .btn-icon'));
  return [...doc.querySelectorAll('.ui-rowmenu button')];
};

test('Mute this rule mutes every row of that rule and hides them', async (t) => {
  const { doc, window, log } = boot({
    t,
    routes: SESSION({
      'GET /api/changes': MUTE_FEED(),
      'POST /api/changes/mute': { key: 'a'.repeat(64), mutedUntil: '2026-09-23T10:00:00.000Z' },
    }),
  });
  await settle();
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 3);
  const item = openMenu(doc, window, 0).find((b) => /Mute this rule/.test(b.textContent));
  assert.ok(item, 'no Mute this rule in the row menu');
  click(window, item);
  await settle();
  const call = log.find((c) => c.key === 'POST /api/changes/mute');
  assert.ok(call, 'Mute did not call the server');
  assert.deepEqual(JSON.parse(call.body), { key: 'a'.repeat(64) });
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 1, 'both rows of the rule should leave the list');
  assert.match(doc.querySelector('#view').textContent, /2 muted hidden/);
});

test('Show → Muted lists them with Unmute this rule, which calls DELETE', async (t) => {
  const f = MUTE_FEED();
  f.events[0].mutedUntil = '2026-09-23T10:00:00.000Z';
  f.events[3].mutedUntil = '2026-09-23T10:00:00.000Z';
  const { doc, window, log } = boot({
    t,
    routes: SESSION({ 'GET /api/changes': f, [`DELETE /api/changes/mute/${'a'.repeat(64)}`]: { status: 204, body: null } }),
  });
  await settle();
  const show = [...doc.querySelectorAll('#view .toolbar-ui select')].find((s) => [...s.options].some((o) => o.value === 'muted'));
  assert.ok(show, 'no Muted option');
  show.value = 'muted';
  show.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 2);
  assert.match(doc.querySelectorAll('#view table.dt tbody tr')[0].textContent, /Muted/);
  const item = openMenu(doc, window, 0).find((b) => /Unmute this rule/.test(b.textContent));
  assert.ok(item, 'no Unmute in the row menu');
  click(window, item);
  await settle();
  assert.ok(log.find((c) => c.key === `DELETE /api/changes/mute/${'a'.repeat(64)}`), 'Unmute did not call the server');
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 0);
});

test('a failed mute says so and keeps the rows', async (t) => {
  const { doc, window } = boot({
    t,
    routes: SESSION({ 'GET /api/changes': MUTE_FEED(), 'POST /api/changes/mute': { status: 500, body: { error: 'Internal Server Error' } } }),
  });
  await settle();
  click(window, openMenu(doc, window, 0).find((b) => /Mute this rule/.test(b.textContent)));
  await settle();
  assert.equal(doc.querySelectorAll('#view table.dt tbody tr').length, 3);
  assert.ok(doc.querySelector('#ui-toasts .ui-toast.err'), 'the failure was silent');
});
