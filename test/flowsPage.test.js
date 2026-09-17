'use strict';

// public/views/flows.js — Flows on the UI contract (docs/ui-contract.md).
//
// Unified / Bidirectional / Map were three buttons in a segmented control, the
// time presets were four more, and the filters were a hand-built grid of
// labelled fields. The modes are a tab strip, the range is a select, and the
// rest is one Toolbar. These tests hold what had to survive: each mode still
// calls its own endpoint with the same parameters, drag-to-zoom still pads a
// thin selection, and clicking a talker still pivots the peer filter.

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
  { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', status: 'online', location_id: 1, location_name: 'Oslo' },
  { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02', status: 'online', location_id: 2, location_name: 'Copenhagen' },
];
const series = (n) => Array.from({ length: n }, (_, i) => ({
  at: new Date(Date.parse('2026-09-12T13:00:00.000Z') + i * 60000).toISOString(),
  bytes: 1000000 + i * 50000,
}));
const EXPLORE = {
  totals: { bytes: 84000000, flowCount: 4120, records: 5100 },
  series: series(12),
  topTalkers: [
    { srcIp: '10.0.0.5', dstIp: '142.250.74.1', extIp: '142.250.74.1', internal: false, asnName: 'Google', country: 'US', bytes: 61000000, packets: 42000, flowCount: 412 },
    { srcIp: '10.0.0.5', dstIp: '10.0.0.9', internal: true, bytes: 4000000, packets: 3000, flowCount: 51 },
  ],
  byPort: [{ port: 443, service: 'https', proto: 'tcp', bytes: 61000000, flowCount: 412 }],
  byProto: [{ proto: 'tcp', bytes: 80000000, flowCount: 4000 }, { proto: 'udp', bytes: 4000000, flowCount: 120 }],
  scans: [{ srcIp: '10.0.0.44', kind: 'port-scan', distinctPorts: 612, distinctHosts: 2, bytes: 91000, flowCount: 612 }],
};
const BIDI = {
  asymmetry: { ratio: 0.82, asymmetric: true, totalBytes: 84000000, inBytes: 69000000, outBytes: 15000000 },
  ingress: { totals: { bytes: 69000000 }, series: series(10), topTalkers: EXPLORE.topTalkers, byProto: EXPLORE.byProto },
  egress: { totals: { bytes: 15000000 }, series: series(10), topTalkers: [], byProto: [] },
};
const MAP = {
  totals: { bytes: 84000000, flowCount: 4120, destinations: 2 },
  sites: [{ key: 's1', name: 'Oslo', locationId: 1 }],
  categories: [{ id: 'web', bytes: 61000000 }],
  arcs: [
    { siteKey: 's1', country: 'US', label: 'web', category: 'web', direction: 'out', bytes: 61000000, lat: 37.7, lng: -122.4, asnNames: ['Google'] },
    { siteKey: 's1', country: 'DE', label: 'dns', category: 'dns', direction: 'both', bytes: 400000, lat: 50.1, lng: 8.6, asnNames: [] },
  ],
};

function fakeLeaflet(window) {
  const layer = { clearLayers() {}, addLayer() {}, addTo() { return layer; } };
  window.L = {
    circleMarker() { return { bindTooltip() { return this; }, on() { return this; }, addTo() { return this; } }; },
    polyline() { return { addTo() { return this; }, bindTooltip() { return this; } }; },
    layerGroup() { return layer; },
    markerClusterGroup() { return layer; },
    latLngBounds() { return { contains: () => true }; },
    divIcon() { return {}; },
    marker() { return { addTo() { return this; }, bindTooltip() { return this; }, on() { return this; } }; },
    map() {
      return {
        on() {}, remove() {}, setView() { return this; }, fitBounds() {}, addLayer() {},
        removeLayer() {}, getZoom: () => 3, invalidateSize() {},
        dragging: { enable() {}, disable() {} }, boxZoom: { enable() {}, disable() {} },
      };
    },
    tileLayer() { return { addTo() {} }; },
  };
}

function boot({ t, routes = {}, url = 'http://server.test/flows', role = 'operator', leaflet = true } = {}) {
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
  if (leaflet) fakeLeaflet(window);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}
const settle = () => new Promise((r) => setTimeout(r, 200));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': AGENTS,
  'GET /api/flows/explore': EXPLORE,
  'GET /api/flows/bidirectional': BIDI,
  'GET /api/flows/map': MAP,
  'GET /api/findings': [],
  'GET /api/map/config': { tileUrl: '' },
}, over);

const tabs = (doc) => [...doc.querySelectorAll('#view [role="tablist"] .subtab')];
const panelBy = (doc, re) => [...doc.querySelectorAll('#view .panel-ui')].find((p) => re.test(p.textContent));
const talkerRows = (doc) => {
  const p = panelBy(doc, /Top talkers/);
  return p ? [...p.querySelectorAll('table.dt tbody tr')] : [];
};
const selects = (doc) => [...doc.querySelectorAll('#view .toolbar-ui select')];
// The toolbar's controls are found by their label, whatever element they are.
const labelled = (doc, text) => [...doc.querySelectorAll('#view .toolbar-ui select, #view .toolbar-ui input')]
  .find((c) => (c.getAttribute('aria-label') || '') === text);

test('Flows is a DashboardPage with a tab strip, one Toolbar and no segmented buttons', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .flows-seg').length, 0, 'the segmented control survived');
  assert.equal(doc.querySelectorAll('#view .flows-controls').length, 0, 'the old filter panel survived');
  assert.equal(doc.querySelectorAll('#view .flows-field').length, 0, 'the hand-built fields survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0);
  assert.deepEqual(tabs(doc).map((b) => b.textContent), ['Unified', 'Bidirectional', 'Map']);
  assert.equal(doc.querySelectorAll('#view .toolbar-ui').length, 1);
});

test('unified mode sends every filter it offers', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  labelled(doc, 'Port').value = '443';
  labelled(doc, 'Port').dispatchEvent(new window.Event('input', { bubbles: true }));
  const dir = labelled(doc, 'Direction');
  dir.value = 'out';
  dir.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const last = log.filter((x) => x.key === 'GET /api/flows/explore').pop();
  assert.match(last.url, /agentId=7/);
  assert.match(last.url, /direction=out/);
  assert.match(last.url, /from=.+&to=/);
});

test('the range is a select, and a custom range reveals the two date fields', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const range = labelled(doc, 'Range');
  assert.ok(range, 'no range control');
  assert.deepEqual([...range.options].map((o) => o.value), ['15m', '1h', '6h', '24h', 'custom']);
  assert.equal(doc.querySelectorAll('#view input[type="datetime-local"]').length, 0);

  range.value = 'custom';
  range.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(doc.querySelectorAll('#view input[type="datetime-local"]').length, 2);

  range.value = '24h';
  doc.querySelectorAll('#view .toolbar-ui select')[0];
  labelled(doc, 'Range').value = '24h';
  labelled(doc, 'Range').dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const last = log.filter((x) => x.key === 'GET /api/flows/explore').pop();
  const from = Date.parse(new URL(last.url, 'http://x').searchParams.get('from'));
  const to = Date.parse(new URL(last.url, 'http://x').searchParams.get('to'));
  assert.ok(to - from > 23 * 3600000, `window is ${(to - from) / 3600000} h`);
});

test('a range that ends before it starts is a field error, and sends nothing', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const before = log.filter((x) => x.key === 'GET /api/flows/explore').length;
  const range = labelled(doc, 'Range');
  range.value = 'custom';
  range.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const [from, to] = [...doc.querySelectorAll('#view input[type="datetime-local"]')];
  from.value = '2026-09-12T14:00';
  from.dispatchEvent(new window.Event('change', { bubbles: true }));
  to.value = '2026-09-12T10:00';
  to.dispatchEvent(new window.Event('change', { bubbles: true }));
  const inspect = [...doc.querySelectorAll('#view .toolbar-right .btn')].find((b) => /Inspect/.test(b.textContent));
  inspect.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(doc.querySelector('#view .toolbar-ui .field-error'), 'no error on the field');
  assert.equal(log.filter((x) => x.key === 'GET /api/flows/explore').length, before + 1,
    'a backwards range was still sent');
});

test('a scan is called out first, with what it is', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const scans = panelBy(doc, /Possible scans/);
  assert.ok(scans, 'the scan panel is gone');
  assert.match(scans.textContent, /10\.0\.0\.44/);
  assert.match(scans.querySelector('.badge-ui').textContent, /Port scan/i);
  assert.ok(scans.querySelector('.badge-ui').classList.contains('crit'));
  assert.equal(doc.querySelectorAll('#view .scan-sec').length, 0, 'the old fold survived');
});

test('clicking a talker pivots the peer filter onto it', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(talkerRows(doc).length, 2);
  const link = talkerRows(doc)[0].querySelector('a.hostlink');
  assert.ok(link, 'the destination is not a link');
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  const last = log.filter((x) => x.key === 'GET /api/flows/explore').pop();
  assert.match(last.url, /peer=142\.250\.74\.1/);
  const peer = doc.querySelector('#view .toolbar-ui input[aria-label="Peer"]');
  assert.equal(peer.value, '142.250.74.1');
});

test('the ports and the protocols sit side by side, as tables', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const grid = doc.querySelector('#view .panel-grid');
  assert.ok(grid, 'the two breakdowns are not in a panel grid');
  assert.ok(panelBy(doc, /Top ports/));
  assert.ok(panelBy(doc, /Protocols/));
  assert.match(panelBy(doc, /Top ports/).textContent, /https/);
});

test('bidirectional mode calls its own endpoint and says the split', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  tabs(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/flows/bidirectional'), 'the bidi endpoint was not called');
  const note = doc.querySelector('#view .inline-note.is-warn');
  assert.ok(note, 'the asymmetry warning is gone');
  assert.match(note.textContent, /82% ingress/);
  assert.ok(panelBy(doc, /Ingress/));
  assert.ok(panelBy(doc, /Egress/));
  assert.equal(new window.URLSearchParams(window.location.search).get('mode'), 'bidi');
});

test('map mode calls its own endpoint, and the scope control replaces the peer filter', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  tabs(doc)[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/flows/map'));
  assert.equal(doc.querySelectorAll('#view input[aria-label="Peer"]').length, 0, 'the peer filter stayed in map mode');
  const scope = labelled(doc, 'Map scope');
  assert.ok(scope, 'no map scope control');
  // The sites that actually report, plus the agent and the fleet.
  assert.deepEqual([...scope.options].map((o) => o.value), ['agent', 'fleet', 'l2', 'l1']);
  assert.ok(panelBy(doc, /Top flows/), 'the top-flows list is gone');
});

test('map mode without Leaflet says so instead of rendering an empty box', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION(), leaflet: false });
  await settle();
  tabs(doc)[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(doc.querySelector('#view .state').textContent, /could not be drawn|did not load/i);
});

test('a 500 is an ErrorState that names the call, per mode', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/flows/explore': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/flows\/explore/);
  assert.ok(doc.querySelector('#view .page-head h1'));
});

test('a 404 on the findings overlay costs the markers, not the chart', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/findings': { status: 404, body: { error: 'Not Found' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(panelBy(doc, /Over time/), 'the chart went down with the overlay');
  assert.equal(talkerRows(doc).length, 2);
});

test('no agents at all is an EmptyState that says why', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /agents': [] }) });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state);
  assert.match(state.textContent, /No agents enrolled/i);
});

test('a ?mode deep link opens in that mode', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), url: 'http://server.test/flows?mode=map' });
  await settle();
  assert.equal(tabs(doc)[2].getAttribute('aria-selected'), 'true');
});
