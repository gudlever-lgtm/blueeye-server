'use strict';

// public/views/fleet.js — Fleet on the UI contract (docs/ui-contract.md).
//
// The metric cards became a StatStrip, the removable chip row went (a card
// shows its own state), and the grid became a DataTable with sorting in the
// header. These tests hold the behaviour that had to survive: the counts stay
// whole-fleet under a filter, health sorts rather than filters, and the page
// still renders when the licence-gated rollup is not included.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const agent = (id, name, status, online, over = {}) => Object.assign({
  agentId: id, displayName: name, hostname: name, online,
  health: { status, score: { ok: 100, warn: 60, bad: 20, down: 0 }[status] || 50, metrics: { lossPct: 0, latencyMs: 12, jitterMs: 2, targets: 3, reachable: 3, lastTs: '2026-09-12T14:00:00.000Z' } },
  locationName: 'Oslo', throughput: null, quality: { status: 'ok' },
}, over);

const HEALTH = {
  summary: { ok: 2, warn: 1, bad: 1, down: 0, offline: 1 },
  agents: [
    agent(7, 'oslo-edge-01', 'bad', true),
    agent(8, 'cph-core-02', 'warn', true, { locationName: 'Copenhagen' }),
    agent(9, 'sto-branch-07', 'ok', false, { locationName: 'Stockholm' }),
    agent(10, 'ber-edge-03', 'ok', true, { locationName: 'Berlin' }),
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/fleet', role = 'admin' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 140));
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/fleet/health': HEALTH,
  'GET /api/settings/maintenance': { windows: [] },
  'GET /api/dashboard/advanced': { widgets: {} },
  'GET /api/flows/map': { sites: [], flows: [] },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];
const cards = (doc) => [...doc.querySelectorAll('#view .statstrip .stat-card')];

test('Fleet is a ListPage: PageHeader, StatStrip, Toolbar, DataTable — chips gone', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const ui = doc.querySelector('#view .ui.ui-page');
  assert.ok(ui);
  assert.ok(ui.querySelector('.page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner came back');
  assert.equal(doc.querySelectorAll('#view .metric-card').length, 0, 'the legacy metric cards survived');
  assert.equal(doc.querySelectorAll('#view .filter-chip').length, 0, 'the removable chip row survived');
  assert.equal(doc.querySelectorAll('#view table.fleet-table').length, 0, 'the legacy grid survived');
  assert.equal(cards(doc).length, 4, 'the four metric cards are not a StatStrip');
  assert.equal(rows(doc).length, 4);
});

test('the counts are whole-fleet, and stay whole-fleet under a filter', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const values = cards(doc).map((c) => c.querySelector('.stat-n').textContent);
  // 2 of 4 healthy → 50%. 1 bad + 0 down → 1 critical. 1 warn. 1 offline.
  assert.deepEqual(values, ['50%', '1', '1', '1']);

  cards(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 1, 'the card did not filter the grid');
  // The summary is whole-fleet, so the cards must not shrink with the grid —
  // otherwise a filter hides the very thing it was meant to point at.
  assert.deepEqual(cards(doc).map((c) => c.querySelector('.stat-n').textContent), ['50%', '1', '1', '1']);
  assert.equal(cards(doc)[1].getAttribute('aria-pressed'), 'true');
});

test('Fleet health is a SORT, not a filter', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const before = rows(doc).length;
  cards(doc)[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, before, 'the health card removed rows — it is a sort');
  // Worst first: the bad agent leads.
  assert.match(rows(doc)[0].textContent, /oslo-edge-01/);
});

test('the grid sorts from its header, and the host is a link', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const header = [...doc.querySelectorAll('#view .panel-ui table.dt thead th')]
    .find((th) => /Agent/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const names = rows(doc).map((r) => r.querySelector('a.hostlink').textContent);
  assert.deepEqual(names, [...names].sort().reverse(), `not sorted: ${names.join(', ')}`);
  assert.ok(doc.querySelector('#view .panel-ui table.dt thead th[aria-sort]'), 'the sorted column is not marked');
});

test('a filter that matches nothing is an EmptyState with a way out', async (t) => {
  const quiet = { summary: { ok: 4, warn: 0, bad: 0, down: 0, offline: 0 }, agents: HEALTH.agents.map((a) => Object.assign({}, a, { health: { status: 'ok', score: 100, metrics: a.health.metrics }, online: true })) };
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /api/fleet/health': quiet }) });
  await settle();
  cards(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'no EmptyState');
  assert.equal(rows(doc).length, 0);
  const out = state.querySelector('.btn');
  assert.ok(out, 'no way out of the filter');
  out.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 4, 'clearing the filter did not bring the fleet back');
});

test('no agents at all is a different message from no agents matching', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/fleet/health': { summary: {}, agents: [] } }) });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state);
  assert.match(state.textContent, /enrolled/i, 'an empty fleet reads as a filter that matched nothing');
});

test('an active maintenance window stays on screen as a note, not behind the (?)', async (t) => {
  const now = Date.now();
  const windows = [{ name: 'core upgrade', from: new Date(now - 60000).toISOString(), to: new Date(now + 60000).toISOString() }];
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/settings/maintenance': { windows } }) });
  await settle();
  const note = doc.querySelector('#view .inline-note.is-warn');
  assert.ok(note, 'the maintenance banner disappeared in the migration');
  assert.match(note.textContent, /core upgrade/);
  assert.match(note.textContent, /suppressed/i, 'the note does not say what it means for alerts');
});

test('a 500 is an ErrorState with the shell, the header and the strip intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/fleet/health': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, [], 'the 500 threw');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/fleet\/health/);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
});

test('the licence-gated rollup is omitted, not broken, when the plan excludes it', async (t) => {
  const { doc, errors, log } = boot({
    t,
    routes: SESSION({
      'GET /license': { plan: 'essential', features: {} },
      'GET /api/dashboard/advanced': { status: 403, body: { error: 'Not in this plan' } },
    }),
  });
  await settle();
  assert.deepEqual(errors, [], 'the gated rollup threw');
  assert.ok(rows(doc).length, 'the core Overview did not render without the rollup');
  void log;
});

test('the filter is mirrored into the URL, so a narrowed view is a link', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  cards(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/fleet');
  assert.equal(new window.URLSearchParams(window.location.search).get('severity'), 'CRIT');
});

test('a deep link opens pre-filtered', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/fleet?severity=CRIT', routes: SESSION() });
  await settle();
  assert.equal(rows(doc).length, 1, 'the shared link did not open filtered');
  assert.equal(cards(doc)[1].getAttribute('aria-pressed'), 'true');
});

test('template A order: the StatStrip and the grid come before the panels that summarise them', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const page = doc.querySelector('#view .ui-page');
  const kids = [...page.children];
  const at = (pred) => kids.findIndex(pred);
  const header = at((n) => n.classList.contains('page-head'));
  const strip = at((n) => n.querySelector && n.querySelector('.statstrip'));
  const toolbar = at((n) => n.querySelector && n.querySelector('.toolbar-ui'));
  const grid = at((n) => n.querySelector && n.querySelector('table.dt'));
  assert.ok(header < strip, 'the StatStrip is above the PageHeader');
  assert.ok(strip < toolbar, 'the Toolbar is above the StatStrip');
  assert.ok(toolbar < grid, 'the grid is above the Toolbar');
});

test('sorting by latency actually reorders — it reads the field the cell reads', async (t) => {
  const withRtt = {
    summary: { ok: 3, warn: 0, bad: 0, down: 0, offline: 0 },
    agents: [
      agent(1, 'slow', 'ok', true, { health: { status: 'ok', score: 100, metrics: { rttMs: 90, lossPct: 0, jitterMs: 1, targets: 1, reachable: 1, lastTs: '2026-09-12T14:00:00.000Z' } } }),
      agent(2, 'quick', 'ok', true, { health: { status: 'ok', score: 100, metrics: { rttMs: 8, lossPct: 0, jitterMs: 1, targets: 1, reachable: 1, lastTs: '2026-09-12T14:00:00.000Z' } } }),
      agent(3, 'middling', 'ok', true, { health: { status: 'ok', score: 100, metrics: { rttMs: 40, lossPct: 0, jitterMs: 1, targets: 1, reachable: 1, lastTs: '2026-09-12T14:00:00.000Z' } } }),
    ],
  };
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /api/fleet/health': withRtt }) });
  await settle();
  const th = [...doc.querySelectorAll('#view .panel-ui table.dt thead th')].find((n) => /Latency/.test(n.textContent));
  th.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const names = rows(doc).map((r) => r.querySelector('a.hostlink').textContent);
  assert.deepEqual(names, ['slow', 'middling', 'quick'], `latency sort did nothing: ${names.join(', ')}`);
});

// The probe-outage widget is called `probeOutages` by the server; the panel read
// `events`, and threw on every current server. It also offers the outage's NIS2
// notification draft (GET /api/reports/nis2-draft/:id), which had no UI caller.
test('open issues: probe outages render, and each offers its NIS2 draft to an operator', async (t) => {
  const widgets = {
    probeOutages: { active: 1, recent: [{ id: 42, agentId: 1, agentName: 'oslo-edge-01', metric: 'reachability', severity: 'critical', startedAt: '2026-09-17T13:40:00.000Z' }] },
    findings: { open: 0, recent: [] },
    eventCases: { open: 0, recent: [] },
  };
  const { doc, window, errors, log } = boot({
    t,
    routes: SESSION({
      'GET /api/dashboard/advanced': { widgets },
      'GET /api/reports/nis2-draft/42': { probeOutageId: 42, draft: 'NIS2 INCIDENT NOTIFICATION — DRAFT\nIncident reference: #42' },
    }),
  });
  await settle();
  assert.deepEqual(errors, []);
  const btn = [...doc.querySelectorAll('#view .fleet-issues button')].find((b) => /NIS2 draft/.test(b.textContent));
  assert.ok(btn, 'no NIS2 draft action on the outage');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/reports/nis2-draft/42'));
  assert.match(doc.querySelector('#view .fleet-issues pre').textContent, /Incident reference: #42/);
  assert.equal(window.location.pathname, '/fleet', 'the button did not also open the agent row');
});
