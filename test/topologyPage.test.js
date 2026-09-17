'use strict';

// public/views/topology.js — Topology on the UI contract (docs/ui-contract.md).
//
// Diagram / Layers / Map were three buttons pretending to be tabs, and every
// table row carried three probe buttons that stacked into a three-line column.
// These tests hold what had to survive: the mode is a real tab strip with the
// mode in the URL, agent scope still wins over site scope on the request, and
// the three probes are still all reachable from a row.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const AGENTS = [
  { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', status: 'online' },
  { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02', status: 'offline' },
];
const LOCATIONS = [{ id: 1, name: 'Oslo' }, { id: 2, name: 'Copenhagen' }];
const TOPOLOGY = {
  totals: { nodes: 4, internal: 2, external: 2, edges: 3 },
  nodes: [
    { id: '10.0.0.5', kind: 'internal', degree: 3, bytesIn: 8400000, bytesOut: 2100000 },
    { id: '10.0.0.9', kind: 'internal', degree: 1, bytesIn: 120000, bytesOut: 40000 },
    { id: '142.250.74.1', kind: 'external', degree: 2, bytesIn: 6100000, bytesOut: 900000, asnName: 'Google', country: 'US', lat: 37.7, lng: -122.4 },
    { id: '5.9.1.2', kind: 'external', degree: 1, bytesIn: 400000, bytesOut: 90000, asnName: 'Hetzner', country: 'DE', lat: 50.1, lng: 8.6 },
  ],
  edges: [
    { from: '10.0.0.5', to: '142.250.74.1', bytes: 6100000, flows: 412 },
    { from: '10.0.0.5', to: '5.9.1.2', bytes: 400000, flows: 51 },
    { from: '10.0.0.9', to: '142.250.74.1', bytes: 120000, flows: 9 },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/topology', role = 'operator' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u), body: opts.body });
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
const settle = () => new Promise((r) => setTimeout(r, 180));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': AGENTS,
  'GET /locations': LOCATIONS,
  'GET /api/topology': TOPOLOGY,
  'GET /api/topology/graph': {
    totals: { nodes: 3, l2_link: 2, service_dep: 1 },
    nodes: [
      { id: 7, label: 'sw-core-01' }, { id: 8, label: 'sw-acc-a' }, { id: 9, label: 'sw-acc-b' },
    ],
    edges: [
      { source: 7, target: 8, type: 'l2_link', bytes: 0 },
      { source: 7, target: 9, type: 'l2_link', bytes: 0 },
      { source: 8, target: 9, type: 'service_dep', bytes: 4200 },
    ],
  },
  'GET /api/topology/changes': { events: [] },
}, over);

const tabs = (doc) => [...doc.querySelectorAll('#view [role="tablist"] .subtab')];
const panelBy = (doc, re) => [...doc.querySelectorAll('#view .panel-ui')].find((p) => re.test(p.textContent));
const depRows = (doc) => {
  const p = panelBy(doc, /Top dependencies/);
  return p ? [...p.querySelectorAll('table.dt tbody tr')] : [];
};
const hostRows = (doc) => {
  const p = panelBy(doc, /Busiest hosts/);
  return p ? [...p.querySelectorAll('table.dt tbody tr')] : [];
};
const selects = (doc) => [...doc.querySelectorAll('#view .toolbar-ui select')];

test('Topology is a DashboardPage with a real tab strip, not three buttons', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .topo-mode').length, 0, 'the button toggle survived');
  assert.equal(doc.querySelectorAll('#view .topo-action-bar').length, 0, 'the old action bar survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0);
  const strip = doc.querySelector('#view [role="tablist"]');
  assert.ok(strip, 'the modes are not a tab strip');
  assert.deepEqual(tabs(doc).map((b) => b.textContent), ['Diagram', 'Layers', 'Map']);
  assert.equal(tabs(doc)[0].getAttribute('aria-selected'), 'true');
  // One stop in the tab order, arrows move within — that is what the pattern is for.
  assert.deepEqual(tabs(doc).map((b) => b.tabIndex), [0, -1, -1]);
});

test('the mode goes into the URL, and a deep link opens there', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  tabs(doc)[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(new window.URLSearchParams(window.location.search).get('mode'), 'map');
  assert.ok(panelBy(doc, /Map/), 'the map panel did not open');

  const deep = boot({ t, routes: SESSION(), url: 'http://server.test/topology?mode=layers' });
  await settle();
  assert.equal(tabs(deep.doc)[1].getAttribute('aria-selected'), 'true');
});

test('a ?layer deep link opens Layers, because that is what it is about', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), url: 'http://server.test/topology?layer=l2' });
  await settle();
  assert.equal(tabs(doc)[1].getAttribute('aria-selected'), 'true');
  assert.ok(panelBy(doc, /Layers/));
});

test('both tables render, and sort from their headers', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(depRows(doc).length, 3);
  assert.equal(hostRows(doc).length, 4);
  // Bytes descending by default.
  assert.match(depRows(doc)[0].textContent, /142\.250\.74\.1/);

  const header = [...panelBy(doc, /Top dependencies/).querySelectorAll('thead th')]
    .find((th) => /^Flows/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const flows = depRows(doc).map((r) => Number(r.children[4].textContent));
  assert.deepEqual(flows, [...flows].sort((a, b) => b - a), `not sorted: ${flows.join(', ')}`);
});

test('a row offers one probe and keeps the other two behind the menu', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const acts = [...depRows(doc)[0].querySelectorAll('.row-act > button')];
  assert.equal(acts.length, 2, 'the three-button row survived');
  assert.match(acts[0].textContent, /Ping/);
  assert.equal(doc.querySelectorAll('#view .row-actions').length, 0, 'the legacy action row survived');

  acts[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const labels = [...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent);
  assert.ok(labels.some((l) => /Show route/i.test(l)));
  assert.ok(labels.some((l) => /Path/i.test(l)));
});

test('with no online agent there is nothing to probe from, so no probe column', async (t) => {
  const offline = AGENTS.map((a) => Object.assign({}, a, { status: 'offline' }));
  const { doc } = boot({ t, routes: SESSION({ 'GET /agents': offline }) });
  await settle();
  assert.equal(doc.querySelectorAll('#view .row-act').length, 0, 'probes were offered with no agent to run them');
  assert.equal(selects(doc).length, 2, 'the agent picker is shown with no online agent');
  assert.equal(depRows(doc).length, 3, 'the tables went with the probes');
});

test('agent scope wins over site scope on the request, and disables the site control', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const [site, , agent] = selects(doc);
  site.value = '2';
  site.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  let last = log.filter((x) => x.key === 'GET /api/topology').pop();
  assert.match(last.url, /locationId=2/);

  const agentSel = selects(doc)[2];
  agentSel.value = '7';
  agentSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  last = log.filter((x) => x.key === 'GET /api/topology').pop();
  assert.match(last.url, /agentId=7/);
  assert.ok(!/locationId/.test(last.url), 'the site filter was sent alongside the agent scope');
  assert.ok(selects(doc)[0].disabled, 'the ignored site control stayed enabled');
  void agent;
});

test('the window reaches the request and the panel says what is on screen', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const win = selects(doc)[1];
  win.value = '1440';
  win.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/topology').pop().url, /minutes=1440/);
  const note = panelBy(doc, /Diagram/).querySelector('.panel-head .meta-xs');
  assert.match(note.textContent, /Last 24 hours/);
  assert.match(note.textContent, /4 hosts/);
});

test('an empty window is an EmptyState that says where the data comes from', async (t) => {
  const bare = { totals: { nodes: 0, internal: 0, external: 0, edges: 0 }, nodes: [], edges: [] };
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/topology': bare }) });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state);
  assert.match(state.textContent, /NetFlow or sFlow/);
  assert.equal(depRows(doc).length, 0);
});

test('a 500 is an ErrorState with the shell and the header intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/topology': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/topology/);
  assert.ok(doc.querySelector('#view .page-head h1'));
  assert.ok(doc.querySelector('.sidebar'));
});

test('a viewer is not offered What if? or Recompute', async (t) => {
  const { doc } = boot({
    t, role: 'viewer', url: 'http://server.test/topology?mode=layers',
    routes: SESSION({ 'GET /me': { id: 1, email: 'x@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  const panel = panelBy(doc, /Layers/);
  const labels = [...panel.querySelectorAll('.panel-actions .btn')].map((b) => b.textContent);
  assert.ok(!labels.some((l) => /What if/i.test(l)), 'a viewer was offered the blast-radius preview');
  assert.ok(!labels.some((l) => /Recompute/i.test(l)), 'a viewer was offered the recompute');
});

test('an operator gets What if?, and it puts the focus in the URL', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION(), url: 'http://server.test/topology?mode=layers' });
  await settle();
  const panel = panelBy(doc, /Layers/);
  const whatIf = [...panel.querySelectorAll('.panel-actions .btn')].find((b) => /What if/i.test(b.textContent));
  assert.ok(whatIf, 'no what-if toggle');
  whatIf.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(doc.querySelector('#view .blast-slot'), 'the what-if prompt did not appear');
  void window;
});

// The Layers dropdown did nothing. `params` is a snapshot taken once at render,
// and parseParams always fills `layer` (defaulting to 'both'), so the
// `params.layer || state.layer` read could never see a change: picking L2 set
// state, synced the URL, redrew — and read 'both' back out of the stale
// snapshot. The deep link seeds the layer once; after that the operator owns it.
test('the Layers dropdown actually switches layer', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION(), url: 'http://server.test/topology?mode=layers' });
  await settle();

  const layerSel = [...doc.querySelectorAll('#view select')]
    .find((s) => [...s.options].some((o) => o.value === 'l2'));
  assert.ok(layerSel, 'the layer picker is missing');
  assert.equal(layerSel.value, 'both');

  layerSel.value = 'l2';
  layerSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();

  const after = [...doc.querySelectorAll('#view select')]
    .find((s) => [...s.options].some((o) => o.value === 'l2'));
  assert.equal(after.value, 'l2', 'the picker snapped back to the URL value');
  assert.equal(new window.URLSearchParams(window.location.search).get('layer'), 'l2');

  after.value = 'dep';
  after.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const third = [...doc.querySelectorAll('#view select')]
    .find((s) => [...s.options].some((o) => o.value === 'l2'));
  assert.equal(third.value, 'dep', 'a second switch must work too');
  assert.equal(new window.URLSearchParams(window.location.search).get('layer'), 'dep');
});
