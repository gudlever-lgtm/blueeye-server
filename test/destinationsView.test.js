'use strict';

// public/views/destinations.js — Destinations on the UI contract
// (docs/ui-contract.md).
//
// The page used to keep a 340px panel beside the map at all times. A circle, a
// site pin and a dragged region all wrote into it, with nothing to say which of
// the three you were reading and no way to put it away. That panel is the
// Drawer now. These tests hold what had to survive the move: the detail still
// comes from the same endpoints, a 404 on a destination is still an answer
// rather than a failure, and the two colour scales are still two scales.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const OVERVIEW = {
  internalHosts: [
    { hostId: 7, siteName: 'Oslo HQ', status: 'online', lat: 59.91, lng: 10.75 },
    { hostId: 8, siteName: 'Copenhagen', status: 'offline', lat: 55.68, lng: 12.57 },
  ],
  externalDestinations: [
    { country: 'US', asn: 15169, asnName: 'Google', bytes: 8400000, flowCount: 412, deviation: 0.9, lat: 37.7, lng: -122.4 },
    { country: 'DE', asn: 24940, asnName: 'Hetzner', bytes: 3100000, flowCount: 180, deviation: 0.3, lat: 50.1, lng: 8.6 },
    { country: 'SE', asn: 1299, asnName: 'Arelion', bytes: 900000, flowCount: 44, deviation: 0.02, lat: 59.3, lng: 18.0 },
    { country: 'NO', asn: null, asnName: null, bytes: 120000, flowCount: 9, deviation: 0, lat: null, lng: null },
  ],
};
const FLOWS = {
  totals: { bytes: 8400000, flowCount: 412 },
  byDirection: [{ direction: 'in', bytes: 6000000 }, { direction: 'out', bytes: 2400000 }],
  byProto: [{ proto: 'tcp', bytes: 8000000 }, { proto: 'udp', bytes: 400000 }],
  byAsn: [{ asn: 15169, asnName: 'Google', bytes: 8400000 }],
};

function fakeLeaflet(window) {
  const drawn = { hosts: [], dests: [] };
  const mk = (bucket) => ({
    clearLayers() { bucket.length = 0; },
    addLayer(m) { bucket.push(m); },
    addTo() { return this; },
  });
  const hostLayer = mk(drawn.hosts);
  const destLayer = mk(drawn.dests);
  window.L = {
    circleMarker(latlng, opts) {
      return {
        latlng, opts, handlers: {}, bindTooltip() { return this; }, bindPopup() { return this; },
        addTo(layer) { if (layer && layer.addLayer) layer.addLayer(this); return this; },
        on(ev, fn) { this.handlers[ev] = fn; return this; },
      };
    },
    // Destinations cluster, sites do not — which is how the two layers are told
    // apart here.
    layerGroup() { return hostLayer; },
    markerClusterGroup() { return destLayer; },
    // One per trace on the map: a traceroute path's own layer.
    featureGroup() {
      const layer = { items: [], handlers: {},
        clearLayers() { this.items.length = 0; }, addLayer(m) { this.items.push(m); },
        addTo() { return this; }, on(ev, fn) { this.handlers[ev] = fn; return this; } };
      (window.__paths = window.__paths || []).push(layer);
      return layer;
    },
    latLngBounds() { return { contains: () => true }; },
    rectangle() { return { setBounds() {}, addTo() { return this; } }; },
    polyline() { return { addTo(layer) { if (layer && layer.addLayer) layer.addLayer(this); return this; } }; },
    map() {
      const m = {
        handlers: {},
        on(ev, fn) { m.handlers[ev] = fn; return m; },
        remove() {}, setView() { return m; }, fitBounds() {}, addLayer() {}, removeLayer() {},
        dragging: { enable() {}, disable() {} },
        boxZoom: { enable() {}, disable() {} },
      };
      window.__map = m;
      return m;
    },
    tileLayer() { return { addTo() {} }; },
  };
  window.__drawn = drawn;
  return drawn;
}

function boot({ t, routes = {}, url = 'http://server.test/destinations', role = 'admin', leaflet = true } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    // The BODY matters: "Show path" dispatching the wrong probe type was
    // invisible while the harness recorded only the method and the path.
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u), body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  // Records its listeners so a test can push a dashboard frame through the
  // same handler the real socket feeds.
  window.__sockets = [];
  window.WebSocket = class {
    constructor(u) { this.url = String(u); this.readyState = 3; this.listeners = {}; window.__sockets.push(this); }
    close() {} send() {}
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    removeEventListener() {}
  };
  window.EventSource = window.WebSocket;
  if (t) t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  const drawn = leaflet ? fakeLeaflet(window) : null;
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log, drawn };
}
const settle = () => new Promise((r) => setTimeout(r, 160));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/geo/config': { geoip: { configured: true } },
  'GET /api/geo/overview': OVERVIEW,
  'GET /api/fleet/health': { agents: [{ agentId: 7, health: { status: 'bad' } }] },
  'GET /agents': [{ id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' }],
  'GET /api/geo/select/flows': FLOWS,
  'GET /api/geo/select/findings': { findings: [{ id: 1, severity: 'WARN', metric: 'bytes', explanation: 'volume doubled' }] },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];
const drawer = (doc) => doc.querySelector('.ui-drawer');

test('Destinations is a ListPage: PageHeader, Toolbar, map Panel, DataTable — the side panel is gone', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .geo-panel').length, 0, 'the always-on side panel survived');
  assert.equal(doc.querySelectorAll('#view .geo-top').length, 0, 'the old top table survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old section head survived');
  assert.ok(doc.querySelector('#view .site-map'), 'no map canvas');
  // Three of the four destinations are placeable; the fourth has no coordinates
  // and still belongs in the table.
  assert.equal(rows(doc).length, 4);
});

test('a destination row opens the Drawer with the breakdown and the findings', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(drawer(doc), null, 'the drawer is open before anything was clicked');
  const row = rows(doc).find((r) => /Google/.test(r.textContent));
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const d = drawer(doc);
  assert.ok(d, 'no Drawer');
  assert.match(d.querySelector('h2').textContent, /US · AS15169 Google/);
  const headings = [...d.querySelectorAll('.dsec h3')].map((h) => h.textContent);
  assert.deepEqual(headings, ['Totals', 'Direction', 'Protocol', 'ASN', 'Findings (1)']);
  assert.match(d.textContent, /volume doubled/);
  // Escape closes it and gives the map the full width back.
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  assert.equal(drawer(doc), null, 'Escape did not close the Drawer');
});

test('a 404 on the flows is "no data", not an error', async (t) => {
  const { doc, window, errors } = boot({ t, routes: SESSION({ 'GET /api/geo/select/flows': { status: 404, body: { error: 'Not Found' } } }) });
  await settle();
  rows(doc)[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const d = drawer(doc);
  assert.ok(d);
  assert.equal(d.querySelectorAll('.state.is-error').length, 0, 'a 404 was reported as a failure');
  assert.match(d.textContent, /No data for this destination/i);
  assert.deepEqual(errors, []);
});

test('a 500 on the flows IS an error, and names the call', async (t) => {
  const { doc, window, errors } = boot({ t, routes: SESSION({ 'GET /api/geo/select/flows': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  rows(doc)[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const d = drawer(doc);
  assert.ok(d.querySelector('.state.is-error'), 'no ErrorState in the Drawer');
  assert.match(d.textContent, /GET \/api\/geo\/select\/flows/);
  assert.deepEqual(errors, []);
});

test('a 500 on the overview is an ErrorState with the shell and the header intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/geo/overview': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, [], 'the 500 threw');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/geo\/overview/);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
});

test('sites and destinations keep two separate colour scales, both from tokens', async (t) => {
  const { doc, drawn } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(drawn.hosts.length, 2, 'the site pins are gone');
  assert.equal(drawn.dests.length, 3, 'only the placeable destinations get a circle');
  for (const m of drawn.hosts.concat(drawn.dests)) {
    assert.ok(!/^#/.test(String(m.opts.fillColor)), `a marker still carries a hex literal: ${m.opts.fillColor}`);
  }
  // Volume drives the radius, so the biggest destination is the biggest circle.
  const radii = drawn.dests.map((m) => m.opts.radius);
  assert.ok(radii[0] > radii[2], 'the radius stopped following the volume');

  const dots = [...doc.querySelectorAll('#view .site-legend .ui-legend-dot')];
  assert.deepEqual(dots.map((d) => [...d.classList].find((c) => c !== 'ui-legend-dot')),
    ['health-ok', 'health-warn', 'health-bad', 'dev-info', 'dev-warn', 'dev-crit']);
  for (const d of dots) assert.equal(d.getAttribute('style'), null, 'a legend dot still styles itself inline');
});

test('the deviation is a badge on the row, and the table sorts by it', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  // Default sort is volume, descending.
  assert.match(rows(doc)[0].textContent, /Google/);
  const header = [...doc.querySelectorAll('#view .panel-ui table.dt thead th')]
    .find((th) => /Deviation/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const badges = rows(doc).map((r) => r.querySelector('.badge-ui').textContent);
  assert.deepEqual(badges, ['+90%', '+30%', '+2%', '0%']);
  assert.ok(rows(doc)[0].querySelector('.badge-ui').classList.contains('crit'));
  assert.ok(rows(doc)[3].querySelector('.badge-ui').classList.contains('info'));
});

test('a site pin opens the Drawer for that site, not for a destination', async (t) => {
  const { doc, drawn } = boot({ t, routes: SESSION({ 'GET /api/findings': [] }) });
  await settle();
  drawn.hosts[0].handlers.click();
  await settle();
  const d = drawer(doc);
  assert.ok(d, 'no Drawer for the site pin');
  assert.match(d.querySelector('h2').textContent, /Oslo HQ/);
  assert.match(d.textContent, /Findings \(0\)/);
});

test('no GeoIP database is an inline note, not a banner', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/geo/config': { geoip: { configured: false } } }) });
  await settle();
  const note = doc.querySelector('#view .inline-note.is-warn');
  assert.ok(note, 'the GeoIP warning disappeared in the migration');
  assert.match(note.textContent, /Settings → Map/);
  assert.equal(doc.querySelectorAll('#view .alert-banner').length, 0, 'the legacy banner survived');
});

test('a viewer is told to ask someone; an admin is sent to the setting', async (t) => {
  const v = boot({ t, routes: SESSION({ 'GET /api/geo/config': { geoip: { configured: false } } }), role: 'viewer' });
  await settle();
  assert.match(v.doc.querySelector('#view .inline-note').textContent, /Ask an administrator/i);
});

test('an empty period is an EmptyState, and says so differently without GeoIP', async (t) => {
  const bare = { internalHosts: [], externalDestinations: [] };
  const a = boot({ t, routes: SESSION({ 'GET /api/geo/overview': bare }) });
  await settle();
  assert.match(a.doc.querySelector('#view .panel-ui .state').textContent, /No external destinations/i);

  const b = boot({ t, routes: SESSION({ 'GET /api/geo/overview': bare, 'GET /api/geo/config': { geoip: { configured: false } } }) });
  await settle();
  assert.match(b.doc.querySelector('#view .panel-ui .state').textContent, /GeoIP database is loaded/i);
});

test('without Leaflet the table is still the whole content', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION(), leaflet: false });
  await settle();
  assert.deepEqual(errors, []);
  assert.match(doc.querySelector('#view .state').textContent, /could not be drawn/i);
  assert.equal(rows(doc).length, 4, 'the rollup disappeared with the map');
});

test('the period picker refetches with a since, and the map is not rebuilt', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const before = window.__map;
  const sel = doc.querySelector('#view .toolbar-ui select');
  sel.value = '7d';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const reload = log.filter((x) => x.key === 'GET /api/geo/overview').pop();
  assert.match(reload.url, /since=/, 'the period did not reach the server');
  assert.equal(window.__map, before, 'the map was rebuilt under the reader');
  // The panel still says what is on it, though.
  assert.match(doc.querySelector('#view .panel-ui .panel-head .meta-xs').textContent, /4 external destinations/);
});

// ---------------------------------------------------------------- Show path
//
// "Show path" could report no path for three different reasons and showed the
// same nothing for all of them: the run it dispatched did not match the query
// it then polled, the poll gave up after sixteen seconds, and a probe that
// FAILED produced a toast rather than the agent's own reason.

const pathFor = (log) => log.filter((c) => c.key === 'GET /api/probes/path');
const runFor = (log) => log.filter((c) => c.key.startsWith('POST /agents/'));

async function showPath(t, routes, { target = '8.8.8.8' } = {}) {
  const { doc, window, log, errors } = boot({ t, routes: SESSION(routes) });
  await settle();
  const sel = [...doc.querySelectorAll('#view select')]
    .find((s) => [...s.options].some((o) => o.value === '7'));
  assert.ok(sel, 'the path agent picker is missing');
  sel.value = '7';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const input = [...doc.querySelectorAll('#view input[type="text"]')].pop();
  assert.ok(input, 'the path target field is missing');
  input.value = target;
  const btn = [...doc.querySelectorAll('#view button')].find((b) => /path/i.test(b.textContent) && !/clear/i.test(b.textContent));
  assert.ok(btn, 'the Show path button is missing');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  return { doc, window, log, errors };
}

test('Show path dispatches the SAME probe type it then polls for', async (t) => {
  // The stored history says this target was last traced with tcptraceroute, so
  // the query filters on tcptraceroute. Dispatching a plain traceroute stored a
  // result the poll was never looking for, and the path never arrived.
  const { log } = await showPath(t, {
    'GET /api/probes/latest': { agentId: 7, results: [{ type: 'tcptraceroute', target: '8.8.8.8', ok: true }] },
    'GET /api/probes/path': { nodes: [], stops: [] },
    'POST /agents/7/probe': { delivered: 1 },
  });

  const asked = pathFor(log)[0];
  assert.ok(asked, 'no path query was made');
  const queried = new URL(asked.url, 'http://server.test').searchParams.get('probeType');
  const run = runFor(log)[0];
  assert.ok(run, 'no probe run was dispatched');
  assert.equal(queried, 'tcptraceroute', 'the query should follow the target history');
  assert.equal(run.body && run.body.type, queried,
    `dispatched ${run.body && run.body.type} but polled for ${queried} — the path can never arrive`);
  assert.equal(run.body && run.body.host, '8.8.8.8');
});

test('a probe that FAILED shows the agent\'s own reason, not an empty panel', async (t) => {
  const { doc } = await showPath(t, {
    // traceroute -T needs root on most hosts; the agent says so on the result.
    'GET /api/probes/latest': {
      agentId: 7,
      results: [{ type: 'traceroute', target: '8.8.8.8', ok: false, detail: 'traceroute: you must be root to use -T' }],
    },
    'GET /api/probes/path': { nodes: [], stops: [] },
    'POST /agents/7/probe': { delivered: 1 },
  });
  // One poll tick (5 s) is enough: the failure is spotted on the first pass.
  await new Promise((r) => setTimeout(r, 6000));

  const view = doc.querySelector('#view').textContent;
  assert.match(view, /root/i, "the agent's own reason is not shown anywhere");
  assert.match(view, /geolocated stops|stops/i, '"Show path" produced no result panel at all — only a toast');
});

// ------------------------------------------------------ live + several traces
//
// A trace that ran longer than the old 90 s poll window was reported as never
// having come back, every re-click sent the agent another traceroute, and only
// one path could sit on the map at a time.

// Delivers one dashboard-socket frame to every socket the app opened.
function frame(window, type, payload) {
  const socks = window.__sockets.filter((x) => (x.listeners.message || []).length);
  assert.ok(socks.length, 'the dashboard never opened its live socket');
  for (const sock of socks) for (const fn of sock.listeners.message) fn({ data: JSON.stringify({ type, payload }) });
}

const clickButton = async (window, doc, re) => {
  const btn = [...doc.querySelectorAll('#view button')].find((b) => re.test(b.textContent));
  assert.ok(btn, `no button matching ${re}`);
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
};

async function pickAgentAndTarget(t, routes, target) {
  const { doc, window, log, errors } = boot({ t, routes: SESSION(routes) });
  await settle();
  const sel = [...doc.querySelectorAll('#view select')].find((s) => [...s.options].some((o) => o.value === '7'));
  sel.value = '7';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  if (target != null) [...doc.querySelectorAll('#view input[type="text"]')].pop().value = target;
  return { doc, window, log, errors };
}

test('Trace now draws each hop as the agent streams it', async (t) => {
  const { doc, window, errors } = await pickAgentAndTarget(t, {
    'GET /api/probes/latest': { agentId: 7, results: [] },
    'GET /api/probes/path': { nodes: [], stops: [], origin: { lat: 55.6, lng: 12.5, label: 'oslo-edge-01' } },
    'POST /agents/7/probe': { delivered: 1 },
  }, 'us.cnn.com');
  await clickButton(window, doc, /^Trace now$/);
  assert.match(doc.querySelector('#view').textContent, /waiting for the first hop/i);

  frame(window, 'trace-hop', { agentId: '7', probeType: 'traceroute', target: 'us.cnn.com',
    node: { kind: 'hop', hop: 1, ip: '192.168.1.1', private: true, rttMs: 1.2, severity: 'ok' } });
  frame(window, 'trace-hop', { agentId: '7', probeType: 'traceroute', target: 'us.cnn.com',
    node: { kind: 'hop', hop: 2, ip: '62.61.1.1', country: 'DK', lat: 56, lng: 10, rttMs: 8, severity: 'ok' } });
  const view = doc.querySelector('#view').textContent;
  assert.match(view, /reached hop 2/i);
  assert.match(view, /62\.61\.1\.1/);
  assert.match(view, /192\.168\.1\.1/);
  assert.deepEqual(errors, []);
});

test('a second click on a running trace joins it instead of sending another', async (t) => {
  const { doc, window, log } = await pickAgentAndTarget(t, {
    'GET /api/probes/latest': { agentId: 7, results: [] },
    'GET /api/probes/path': { nodes: [], stops: [] },
    'POST /agents/7/probe': { delivered: 1 },
  }, 'us.cnn.com');
  await clickButton(window, doc, /^Trace now$/);
  await clickButton(window, doc, /^Trace now$/);
  await clickButton(window, doc, /^Show path$/);
  assert.equal(runFor(log).length, 1, 'the agent was asked to trace the same target more than once');
});

test('a tcptraceroute target stored as host:port is sent as host + port', async (t) => {
  const { doc, window, log } = await pickAgentAndTarget(t, {
    'GET /api/probes/latest': { agentId: 7, results: [{ type: 'tcptraceroute', target: 'us.cnn.com:443', ok: true }] },
    'GET /api/probes/path': { nodes: [], stops: [] },
    'POST /agents/7/probe': { delivered: 1 },
  }, 'us.cnn.com:443');
  await clickButton(window, doc, /^Trace now$/);
  const run = runFor(log)[0];
  assert.ok(run);
  assert.deepEqual(run.body, { type: 'tcptraceroute', host: 'us.cnn.com', port: 443 });
});

test('the finished run is drawn as soon as the server says it landed', async (t) => {
  const routes = {
    'GET /api/probes/latest': { agentId: 7, results: [] },
    'GET /api/probes/path': { nodes: [], stops: [], lastTs: null },
    'POST /agents/7/probe': { delivered: 1 },
  };
  const { doc, window } = await pickAgentAndTarget(t, routes, 'us.cnn.com');
  await clickButton(window, doc, /^Trace now$/);
  // The run lands; the next /path read returns it.
  const landed = {
    target: 'us.cnn.com', samples: 1, lastTs: '2026-09-22T10:00:00.000Z',
    nodes: [
      { kind: 'source', hop: 0, label: 'oslo-edge-01', lat: 55.6, lng: 12.5, severity: 'ok' },
      { kind: 'dest', hop: 9, ip: '151.101.1.67', country: 'US', lat: 39, lng: -98, rttMs: 98, severity: 'ok' },
    ],
  };
  // eslint-disable-next-line no-param-reassign
  const realFetch = window.fetch;
  window.fetch = async (u, opts) => {
    if (String(u).includes('/api/probes/path')) {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => landed, text: async () => JSON.stringify(landed) };
    }
    return realFetch(u, opts);
  };
  frame(window, 'probe-result', { agentId: 7, type: 'traceroute', target: 'us.cnn.com', ok: true });
  await settle();
  const view = doc.querySelector('#view').textContent;
  assert.match(view, /1 runs · 2 stops/);
  assert.match(view, /1 runs aggregated · 2 geolocated stops/);
});

test('Show all traces puts every traced target on the list, each removable', async (t) => {
  const graph = (target) => ({
    target, samples: 3, lastTs: '2026-09-22T10:00:00.000Z',
    nodes: [
      { kind: 'source', hop: 0, label: 'oslo-edge-01', lat: 55.6, lng: 12.5, severity: 'ok' },
      { kind: 'dest', hop: 5, ip: '1.1.1.1', country: 'DE', lat: 51, lng: 10, rttMs: 20, severity: 'ok' },
    ],
  });
  const { doc, window, log } = await pickAgentAndTarget(t, {
    'GET /api/probes/latest': { agentId: 7, results: [
      { type: 'traceroute', target: 'a.example', ok: true },
      { type: 'traceroute', target: 'b.example', ok: true },
      { type: 'ping', target: 'c.example', ok: true },
    ] },
    'GET /api/probes/path': graph('x'),
  }, null);
  await clickButton(window, doc, /^Show all traces$/);
  const view = doc.querySelector('#view').textContent;
  assert.match(view, /a\.example/);
  assert.match(view, /b\.example/);
  assert.doesNotMatch(view, /c\.example/, 'a ping target is not a trace');
  assert.match(view, /2 trace\(s\)/);
  assert.equal(runFor(log).length, 0, 'showing stored traces must not start new runs');

  const remove = [...doc.querySelectorAll('#view button')].find((b) => /Remove the trace to a\.example/.test(b.getAttribute('aria-label') || ''));
  assert.ok(remove);
  remove.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(doc.querySelector('#view').textContent, /1 trace\(s\)/);
});

// ------------------------------------------------------------ trace history
//
// The graph on the map is a median over the newest runs, which is the right
// answer to "is this path healthy" and the wrong one to "why was it slow on
// Tuesday". The history keeps the runs apart: open one, and see what changed.

const RUNS = {
  total: 3,
  runs: [
    { id: 3, ts: '2026-09-25T12:00:00Z', ok: true, hopCount: 4, respondingCount: 4, silentCount: 0, rttMs: 60, lossPct: 0, routeChanged: true },
    { id: 2, ts: '2026-09-25T11:00:00Z', ok: true, hopCount: 3, respondingCount: 3, silentCount: 0, rttMs: 20, lossPct: 0, routeChanged: false },
    { id: 1, ts: '2026-09-25T10:00:00Z', ok: false, hopCount: 0, respondingCount: 0, silentCount: 0, rttMs: null, lossPct: null, detail: 'could not resolve the target name', routeChanged: false },
  ],
};
const COMPARE = {
  before: { id: 2, ts: '2026-09-25T11:00:00Z' },
  after: { id: 3, ts: '2026-09-25T12:00:00Z' },
  diff: {
    routeChanged: true, addedCount: 1, removedCount: 0, rttDeltaMs: 40,
    rows: [
      { kind: 'same', ip: '10.0.0.1', beforeHop: 1, afterHop: 1, deltaMs: 0 },
      { kind: 'added', ip: '80.9.9.9', beforeHop: null, afterHop: 3, deltaMs: null },
      { kind: 'same', ip: '93.1.1.1', beforeHop: 3, afterHop: 4, deltaMs: 40 },
    ],
  },
};
const GRAPH = {
  samples: 2, nodes: [{ kind: 'source', hop: 0, lat: 55.6, lng: 12.5, label: 'oslo-edge-01' }, { kind: 'dest', hop: 1, ip: '93.1.1.1', rttMs: 20, lat: 50, lng: 8, place: { country: 'DE', precision: 'country', source: 'geoip-country', certainty: 'exact' } }],
  stops: [], links: [],
};

async function openHistory(t, extraRoutes = {}) {
  const env = await showPath(t, {
    'GET /api/probes/latest': { agentId: 7, results: [{ type: 'traceroute', target: '8.8.8.8', ok: true }] },
    'GET /api/probes/path': GRAPH,
    'GET /api/probes/path/runs': RUNS,
    'GET /api/probes/path/compare': COMPARE,
    ...extraRoutes,
  });
  const details = [...env.doc.querySelectorAll('#view details')]
    .find((d) => /History|Historik/.test(d.querySelector('summary').textContent));
  assert.ok(details, 'the History section is missing from the trace detail');
  details.open = true;
  details.dispatchEvent(new env.window.Event('toggle', { bubbles: true }));
  await settle();
  return { ...env, details };
}

test('the history lists every run, and marks the one that took a different route', async (t) => {
  const { doc, log } = await openHistory(t);
  assert.equal(log.filter((c) => c.key === 'GET /api/probes/path/runs').length, 1, 'the list is fetched once, when opened');
  const rows = [...doc.querySelectorAll('#view .path-runs li')];
  assert.equal(rows.length, 3, 'a run per stored run, newest first');
  assert.match(rows[0].textContent, /different route/i, 'the reroute is what a history is scanned for');
  assert.ok(!/different route/i.test(rows[1].textContent));
  // A run that traced nothing still says why, rather than reading as an empty row.
  assert.match(rows[2].textContent, /could not resolve/);
});

test('the history is not fetched until it is opened', async (t) => {
  const { log } = await showPath(t, {
    'GET /api/probes/latest': { agentId: 7, results: [{ type: 'traceroute', target: '8.8.8.8', ok: true }] },
    'GET /api/probes/path': GRAPH,
    'GET /api/probes/path/runs': RUNS,
  });
  assert.equal(log.filter((c) => c.key === 'GET /api/probes/path/runs').length, 0);
});

test('opening a run loads THAT run and what changed since the one before it', async (t) => {
  const { doc, window, log } = await openHistory(t, {
    'GET /api/probes/path': { ...GRAPH, samples: 1, runId: 3 },
  });
  [...doc.querySelectorAll('#view .path-runs li')][0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const run = log.find((c) => c.key === 'GET /api/probes/path' && /runId=3/.test(c.url));
  assert.ok(run, 'the run itself was never fetched');
  assert.ok(log.find((c) => c.key === 'GET /api/probes/path/compare' && /runId=3/.test(c.url)), 'nothing was compared');
  const view = doc.querySelector('#view').textContent;
  assert.match(view, /Route changed|Ruten ændrede/, 'the comparison is not shown');
  assert.match(view, /40 ms slower|40 ms langsommere/, 'the end-to-end change is not shown');
  assert.match(view, /80\.9\.9\.9/, 'the hop that appeared is not named');
  // The panel has to say it is showing ONE run, not the usual median.
  assert.match(view, /one run|én kørsel/i);
});

test('a history that cannot be read says so, and an empty one is not an error', async (t) => {
  const bad = await openHistory(t, { 'GET /api/probes/path/runs': { status: 500, body: { error: 'Internal Server Error' } } });
  assert.match(bad.doc.querySelector('#view').textContent, /Internal Server Error|fejl/i);

  const empty = await openHistory(t, { 'GET /api/probes/path/runs': { total: 0, runs: [] } });
  const view = empty.doc.querySelector('#view').textContent;
  assert.match(view, /No runs kept|Ingen kørsler gemt/i);
  assert.equal(empty.errors.length, 0);
});
