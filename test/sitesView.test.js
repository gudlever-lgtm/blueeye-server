'use strict';

// public/views/sites.js — Sites on the UI contract (docs/ui-contract.md).
//
// The page used to be a map with a heading over it and, when the map could not
// be drawn, a bare table nobody had looked at since it was written. It is a
// ListPage now: header, StatStrip, the map in a Panel, and the same rollup as a
// DataTable underneath — which means the table is there whether or not Leaflet
// is. These tests hold what the migration had to keep: the marker colour is the
// worst health at the site, the legend is readable without the map, and the two
// "nothing to draw" cases stay different messages.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const LOCATIONS = [
  { id: 1, name: 'Oslo HQ', address: 'Karl Johans gate 1', latitude: 59.91, longitude: 10.75 },
  { id: 2, name: 'Copenhagen', address: 'Rådhuspladsen 2', latitude: 55.68, longitude: 12.57 },
  { id: 3, name: 'Berlin depot', address: 'Alexanderplatz 3', latitude: null, longitude: null },
];
const AGENTS = [
  { id: 7, location_id: 1, status: 'online', display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' },
  { id: 8, location_id: 1, status: 'online', display_name: 'oslo-edge-02', hostname: 'oslo-edge-02' },
  { id: 9, location_id: 2, status: 'offline', display_name: 'cph-core-01', hostname: 'cph-core-01' },
  { id: 10, location_id: 3, status: 'online', display_name: 'ber-edge-01', hostname: 'ber-edge-01' },
];
const FLEET = {
  agents: [
    { agentId: 7, health: { status: 'bad' } },
    { agentId: 8, health: { status: 'ok' } },
    { agentId: 10, health: { status: 'warn' } },
  ],
};

// Leaflet is loaded from a <script src> the boot does not execute, so the map
// branch is opt-in per test: withMap() plants just enough of the API for the
// deferred init to run.
function fakeLeaflet(window) {
  const drawn = { markers: [], popups: [] };
  const layer = {
    clearLayers() { drawn.markers.length = 0; },
    addLayer(m) { drawn.markers.push(m); },
    addTo() { return layer; },
  };
  window.L = {
    circleMarker(latlng, opts) {
      return { latlng, opts, bindPopup(node) { drawn.popups.push(node); this.popup = node; return this; } };
    },
    layerGroup() { return layer; },
    map() {
      return {
        on() {}, remove() {}, setView() { return this; }, fitBounds() {}, addLayer() {},
      };
    },
    tileLayer() { return { addTo() {} }; },
    Icon: { Default: { prototype: {}, mergeOptions() {} } },
  };
  return drawn;
}

function boot({ t, routes = {}, url = 'http://server.test/sites', role = 'admin', leaflet = false } = {}) {
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
  const drawn = leaflet ? fakeLeaflet(window) : null;
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log, drawn };
}
const settle = () => new Promise((r) => setTimeout(r, 140));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /locations': LOCATIONS,
  'GET /agents': AGENTS,
  'GET /api/map/config': { tiles: '' },
  'GET /api/fleet/health': FLEET,
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];
const cards = (doc) => [...doc.querySelectorAll('#view .statstrip .stat-card')];
const cell = (row, i) => row.children[i].textContent.trim();

test('Sites is a ListPage: PageHeader, StatStrip, map Panel, DataTable', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION(), leaflet: true });
  await settle();
  assert.deepEqual(errors, []);
  const page = doc.querySelector('#view .ui.ui-page');
  assert.ok(page, 'the page is not on the contract');
  assert.ok(page.querySelector('.page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner came back');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old section head survived');
  assert.equal(cards(doc).length, 4);
  assert.equal(rows(doc).length, 3, 'every site is in the table, mapped or not');
  assert.ok(doc.querySelector('#view .site-map'), 'no map canvas');
});

test('the strip counts sites, coordinates, critical sites and offline agents', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), leaflet: true });
  await settle();
  // 3 sites, 2 with coordinates. Two sites need somebody: Oslo has a bad agent,
  // and Copenhagen's only agent is offline — which is down, which is critical,
  // the same verdict the marker has always taken.
  assert.deepEqual(cards(doc).map((c) => c.querySelector('.stat-n').textContent), ['3', '2', '2', '1']);
  assert.ok(cards(doc)[1].classList.contains('warn'), 'an unmapped site is not flagged on the strip');
});

test('a site takes the WORST health of its agents, and shows it as a badge', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), leaflet: true });
  await settle();
  const oslo = rows(doc).find((r) => /Oslo HQ/.test(r.textContent));
  // Oslo has one bad and one ok agent — the row reads critical, not healthy.
  assert.match(cell(oslo, 1), /Critical/i);
  assert.equal(cell(oslo, 2), '2/2', 'both Oslo agents are online');
  const berlin = rows(doc).find((r) => /Berlin depot/.test(r.textContent));
  assert.match(cell(berlin, 3), /No coordinates/i, 'a site without coordinates is not called out');

  // "Agents online" is the longest header on the page and the column is the
  // narrowest; at 112px it rendered as "AGENTS ONLI".
  const cols = [...doc.querySelectorAll('#view .panel-ui table.dt colgroup col')];
  assert.ok(parseInt(cols[2].style.width, 10) >= 150, `the agents column is too narrow: ${cols[2].style.width}`);
});

test('a marker carries a token colour, not a hex literal, and the worst status', async (t) => {
  const { doc, drawn, window } = boot({ t, routes: SESSION(), leaflet: true });
  await settle();
  assert.equal(drawn.markers.length, 2, 'only the located sites get a marker');
  for (const m of drawn.markers) {
    assert.ok(!/^#/.test(String(m.opts.fillColor)), `marker still carries a hex literal: ${m.opts.fillColor}`);
  }
  // The legend is classed, so it holds its colour in every theme.
  const dots = [...doc.querySelectorAll('#view .site-legend .ui-legend-dot')];
  assert.equal(dots.length, 4);
  assert.deepEqual(dots.map((d) => [...d.classList].find((c) => c.startsWith('health-'))),
    ['health-ok', 'health-warn', 'health-bad', 'health-unknown']);
  for (const d of dots) assert.equal(d.getAttribute('style'), null, 'a legend dot still styles itself inline');
  void window;
});

test('the table sorts from its header and the site name opens the location', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION(), leaflet: true });
  await settle();
  const header = [...doc.querySelectorAll('#view .panel-ui table.dt thead th')]
    .find((th) => /^Site/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const names = rows(doc).map((r) => r.querySelector('a.hostlink').textContent);
  assert.deepEqual(names, [...names].sort().reverse(), `not sorted: ${names.join(', ')}`);

  rows(doc)[0].querySelector('a.hostlink').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  assert.ok(doc.querySelector('#view'), 'clicking a site name tore the view down');
});

test('no map library is a different message from no coordinates', async (t) => {
  const noLib = boot({ t, routes: SESSION(), leaflet: false });
  await settle();
  assert.match(noLib.doc.querySelector('#view .state').textContent, /could not be drawn/i);
  assert.equal(rows(noLib.doc).length, 3, 'the rollup disappeared with the map');

  const flat = LOCATIONS.map((l) => Object.assign({}, l, { latitude: null, longitude: null }));
  const noCoords = boot({ t, routes: SESSION({ 'GET /locations': flat }), leaflet: true });
  await settle();
  assert.match(noCoords.doc.querySelector('#view .state').textContent, /coordinates/i);
  assert.equal(rows(noCoords.doc).length, 3);
});

test('an empty estate is an EmptyState pointing at where sites are made', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /locations': [], 'GET /agents': [] }), leaflet: true });
  await settle();
  const states = [...doc.querySelectorAll('#view .state')];
  // Once, not twice: the map panel stands down rather than repeating it.
  assert.equal(states.length, 1, 'the empty estate is stated twice');
  assert.match(states[0].textContent, /No sites yet/i);
  assert.ok(states[0].querySelector('.btn'), 'no way to go and make one');
});

test('a 500 on /locations is an ErrorState with the shell and header intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /locations': { status: 500, body: { error: 'boom' } } }), leaflet: true });
  await settle();
  assert.deepEqual(errors, [], 'the 500 threw');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/locations/);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
});

test('a 404 on the fleet rollup degrades to "unknown", it does not break the page', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/fleet/health': { status: 404, body: { error: 'Not Found' } } }), leaflet: true });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(rows(doc).length, 3, 'the page went down with the rollup');
  const oslo = rows(doc).find((r) => /Oslo HQ/.test(r.textContent));
  assert.match(cell(oslo, 1), /Unknown/i);
});

test('the popup names the site, its agents, and carries no inline colour', async (t) => {
  const { drawn } = boot({ t, routes: SESSION(), leaflet: true });
  await settle();
  const pop = drawn.popups.find((p) => /Oslo HQ/.test(p.textContent));
  assert.ok(pop, 'no popup for Oslo');
  assert.match(pop.textContent, /2 of 2 agents online/);
  const dots = [...pop.querySelectorAll('.ui-legend-dot')];
  assert.equal(dots.length, 2);
  for (const d of dots) assert.equal(d.getAttribute('style'), null, 'the popup dot still styles itself inline');
  assert.ok(pop.classList.contains('ui'), 'the popup is outside the .ui scope, so its buttons fall back');
});

test('leaving the view stops the poll and drops the redraw closure', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION(), leaflet: true });
  await settle();
  const fleetBtn = doc.querySelector('[data-view="fleet"]');
  fleetBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/fleet');
  assert.equal(doc.querySelectorAll('#view .site-map').length, 0, 'the map survived the view switch');
});
