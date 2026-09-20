'use strict';

// public/views/location.js — one location, as a DetailPage (template D)
// (docs/ui-contract.md).
//
// The migration this pins: a heading row with eight things in it becomes a
// PageHeader, six kpiCards become a StatStrip, and a ten-column agents table
// loses the three columns that were either a second copy of another or a fact
// that lives on the page the row opens.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const LOC = { id: 1, name: 'Oslo HQ', description: 'Head office', latitude: 59.913, longitude: 10.739 };
const AGENTS = [
  { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01.lan', status: 'online', location_id: 1, last_seen: '2026-09-17T18:29:00.000Z' },
  { id: 8, display_name: 'oslo-edge-02', hostname: 'oslo-edge-02.lan', status: 'offline', location_id: 1, last_seen: '2026-09-17T09:00:00.000Z' },
  { id: 9, display_name: 'cph-core-02', hostname: 'cph-core-02', status: 'online', location_id: 2, last_seen: '2026-09-17T18:00:00.000Z' },
];
const FLEET = {
  summary: {},
  agents: [
    { agentId: 7, online: true, health: { status: 'warn', metrics: { rttMs: 42, baselineMs: 21, lossPct: 3.1, jitterMs: 12, targets: 4, reachable: 3 } }, throughput: { ok: true, downMbps: 480, upMbps: 92 }, quality: { version: '0.42.0' } },
    { agentId: 8, online: false, health: { status: 'down', metrics: {} }, throughput: null, quality: { version: '0.40.0' } },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/locations/1', role = 'admin' } = {}) {
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
    // An envelope is `{ status, body }`; anything else IS the body.
    const envelope = hit !== undefined && hit !== null && typeof hit === 'object' && 'body' in hit;
    const status = hit === undefined ? 404 : (envelope ? (hit.status || 200) : 200);
    const body = hit === undefined ? { error: 'Not Found' } : (envelope ? hit.body : hit);
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
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /locations': [LOC],
  'GET /agents': AGENTS,
  'GET /api/fleet/health': FLEET,
  'GET /api/flows/map': { sites: [], arcs: [] },
}, over);

const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];
const stats = (doc) => [...doc.querySelectorAll('#view .stat-card')];
const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const heads = (doc) => [...doc.querySelectorAll('#view table.dt thead th')].map((h) => h.textContent.trim());

test('the location is a DetailPage with one primary', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Oslo HQ/);
  // The 📍 was glued to the name inside the <h2>.
  assert.ok(!/📍/.test(doc.querySelector('#view .page-head').textContent), 'the emoji survived');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 1);
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading row survived');
});

test('the description and the coordinates are the lead', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const lead = doc.querySelector('#view .page-head p');
  assert.match(lead.textContent, /Head office/);
  assert.match(lead.textContent, /59\.913, 10\.739/);
});

test('a site with no coordinates says so rather than printing nothing', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /locations': [{ id: 1, name: 'Oslo HQ', description: null, latitude: null, longitude: null }] }),
  });
  await settle();
  const lead = doc.querySelector('#view .page-head p');
  assert.match(lead.textContent, /No description/);
  assert.match(lead.textContent, /no coordinates/);
});

test('the six kpiCards are a StatStrip, with the sub-line folded into the label', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(doc.querySelectorAll('#view .noc-kpis, #view .kpi').length, 0, 'the old KPI row survived');
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-l').textContent), [
    'Agents online', 'Median latency', 'Worst packet loss', 'Median jitter', 'Monitored targets', 'Alerts',
  ]);
  const byLabel = {};
  for (const c of stats(doc)) byLabel[c.querySelector('.stat-l').textContent] = c;
  assert.equal(byLabel['Agents online'].querySelector('.stat-n').textContent, '1/2');
  assert.equal(byLabel['Median latency'].querySelector('.stat-n').textContent, '42 ms');
  assert.equal(byLabel['Worst packet loss'].querySelector('.stat-n').textContent, '3.1%');
  // One of two agents online, and one of them down: both are worth a tone.
  assert.ok(byLabel['Agents online'].classList.contains('warn'));
  assert.ok(byLabel['Worst packet loss'].classList.contains('warn'));
});

test('the table drops the three columns that said nothing new', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // Connection was the socket and Health is derived from it, so `offline` and
  // `down` were always the same row twice. Targets and Version are on the
  // agent's own page, which the row opens.
  assert.deepEqual(heads(doc),
    ['Agent', 'Health', 'Loss', 'Latency', 'Jitter', 'Throughput', 'Last seen']);
});

test('only this site\'s agents are listed', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(rows(doc).length, 2);
  assert.deepEqual(rows(doc).map((r) => r.querySelector('td').textContent.trim()),
    ['oslo-edge-01', 'oslo-edge-02']);
  assert.match(doc.querySelector('#view .panel-head .meta-xs').textContent, /2 agents/);
});

test('health is a Badge on a tone, and a row with no verdict says so', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const badge = (i) => rows(doc)[i].querySelectorAll('td')[1].querySelector('.badge-ui');
  assert.ok(badge(0).classList.contains('warn'));
  assert.ok(badge(1).classList.contains('crit'));
  assert.equal(doc.querySelectorAll('#view table.dt .badge.online, #view table.dt .badge.offline').length, 0,
    'the raw-status class survived');
});

test('the row opens the agent', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /agents/7': AGENTS[0] }) });
  await settle();
  rows(doc)[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/agents/7');
});

test('an empty site says what to do about it', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /agents': [AGENTS[2]], 'GET /api/fleet/health': { summary: {}, agents: [] } }),
  });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'no EmptyState');
  assert.match(state.textContent, /No agents here yet/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Add an agent/.test(b.textContent)),
    'a site with nobody at it offers no way to put somebody there');
  // The map card and the flow list are deliberately unmigrated, so their own
  // grey sentences stay (Leaflet is unavailable in jsdom). The agents panel's
  // must not.
  assert.equal(doc.querySelectorAll('#view .panel .empty').length, 0,
    'the old grey sentence survived');
});

test('a viewer is offered no Edit', async (t) => {
  const { doc } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 0);
  assert.ok(headBtns(doc).some((b) => /Locations/.test(b.textContent)), 'no way back to the list');
  // …and can still read the site.
  assert.equal(rows(doc).length, 2);
});

test('the map and the data flows sit side by side, and the flows say where they go', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const grid = doc.querySelector('#view .panel-grid');
  assert.ok(grid, 'the map and the flows are not a grid');
  assert.match(grid.textContent, /Traffic map — Oslo HQ/);
  assert.match(grid.textContent, /Data flows/);
  assert.match(grid.textContent, /Click a flow to inspect it in Flows/);
});

test('a missing location is a 404 with no pointless Retry', async (t) => {
  const { doc, errors } = boot({ t, url: 'http://server.test/locations/999', routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a missing location is not an ErrorState');
  assert.match(err.textContent, /999 does not exist/);
  assert.ok(![...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
  assert.ok(headBtns(doc).some((b) => /Locations/.test(b.textContent)));
});

test('a 500 on the fleet health costs the figures, never the page', async (t) => {
  // The three reads are independent and each falls back, so a failed health
  // read leaves the site and its agents readable.
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /api/fleet/health': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the health read');
  assert.equal(rows(doc).length, 2, 'the agents went with it');
  // The denominator is the site's roster, which the failed read did not touch.
  assert.equal(stats(doc)[0].querySelector('.stat-n').textContent, '0/2');
  assert.equal(stats(doc)[1].querySelector('.stat-n').textContent, '\u2013');
});

test('the record marks itself in the rail and in the breadcrumb', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const marked = doc.querySelector('.tabs button.active');
  assert.ok(marked, 'nothing in the sidebar says where the reader is');
  assert.equal(marked.dataset.view, 'locations');
  assert.match(doc.querySelector('#crumb').textContent, /Administration.*Locations.*#1/);
});
