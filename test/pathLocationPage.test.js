'use strict';

// public/views/pathLocation.js — Path & location on the UI contract
// (docs/ui-contract.md), booted in jsdom against a fake fetch.
//
// The answers the fake serves are computed by the REAL service over the
// fixture network (test-support/l2TopologyFixture.js), so the screen is tested
// against the shape the server actually sends rather than a hand-written copy
// that could drift from it.
//
// What must survive: the hop list is drawn as a vertical path with each port's
// state; a gap is drawn as its own step and its uncertainty is said above the
// path in the reader's language; "where is it" shows switch, port, VLAN and
// provenance; the inventory is operator+ and a viewer is told so; universal
// search offers the jump for an IP or a MAC.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const { createDeviceLocator } = require('../src/topology/deviceLocator');
const { parseEndpoint } = require('../src/validation/l2PathValidation');
const F = require('../test-support/l2TopologyFixture');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const DATA = {};
before(async () => {
  const loc = createDeviceLocator({ ...F.repos(), now: () => new Date('2026-09-24T12:00:00Z') });
  DATA.path = JSON.parse(JSON.stringify(await loc.path({ from: parseEndpoint('agent:7'), to: parseEndpoint('10.1.10.6') })));
  DATA.gap = JSON.parse(JSON.stringify(await loc.path({ from: parseEndpoint('10.1.10.5'), to: parseEndpoint('10.1.10.7') })));
  DATA.locate = JSON.parse(JSON.stringify(await loc.where({ q: parseEndpoint('10.1.10.5') })));
  DATA.inventory = JSON.parse(JSON.stringify(await loc.inventory({ limit: 50, offset: 0 })));
});

function boot({ t, routes = {}, url = 'http://server.test/path-location', role = 'viewer' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const [p, qs] = String(u).split('?');
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push(qs ? `${key}?${qs}` : key);
    let hit = routes[key];
    if (typeof hit === 'function') hit = hit(new URLSearchParams(qs || ''));
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
const settle = () => new Promise((r) => setTimeout(r, 250));

const SESSION = (role, over = {}, locale = null) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role, preferences: locale ? { locale } : {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/topology/l2-path': (q) => (q.get('to') === '10.1.10.7' ? DATA.gap : DATA.path),
  'GET /api/devices/locate': DATA.locate,
  'GET /api/devices/inventory': DATA.inventory,
}, over);

const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];
const panelBy = (doc, re) => panels(doc).find((p) => re.test((p.querySelector('h2') || {}).textContent || ''));
function fill(doc, id, value) {
  const i = doc.getElementById(id);
  i.value = value;
  i.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
}
const button = (root, re) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));

test('Path & location is a contract page with help, and a viewer is told the inventory is operator+', async (t) => {
  const { doc, errors, log } = boot({ t, routes: SESSION('viewer') });
  await settle();
  assert.deepEqual(errors, []);
  const view = doc.querySelector('#view');
  assert.equal(view.querySelector('h1').textContent.replace('?', '').trim(), 'Path & location');
  assert.ok(view.querySelector('.page-head .help-btn'), 'help lives in the (?) popover');
  assert.ok(panelBy(doc, /^Path from A to B/));
  assert.ok(panelBy(doc, /^Where is it\?/));
  const inv = panelBy(doc, /^Device inventory/);
  assert.match(inv.textContent, /needs the operator role/);
  assert.ok(!log.some((l) => l.startsWith('GET /api/devices/inventory')), 'a viewer is not sent to a 403');
  // The nav entry exists and is active.
  const nav = doc.querySelector('button[data-view="pathLocation"]');
  assert.ok(nav);
  assert.equal(nav.textContent.trim(), 'Path & location');
});

test('finding a path draws A, each switch with its ports, and B — and a switch opens its own page', async (t) => {
  const { doc, log, window } = boot({ t, routes: SESSION('viewer', { 'GET /api/snmp-devices/2': { id: 2, host: '10.0.0.2', displayName: 'sw-a', interfaces: [] } }) });
  await settle();
  fill(doc, 'l2p-from', 'agent:7');
  fill(doc, 'l2p-to', '10.1.10.6');
  button(panelBy(doc, /^Path from A to B/), /Find path/).click();
  await settle();
  assert.ok(log.includes('GET /api/topology/l2-path?from=agent%3A7&to=10.1.10.6'));
  const steps = [...doc.querySelectorAll('#view .l2p-path > .l2p-step')];
  assert.deepEqual(steps.map((s) => s.classList[1]), ['l2p-end', 'l2p-hop', 'l2p-hop', 'l2p-hop', 'l2p-end']);
  assert.match(steps[1].textContent, /sw-a/);
  assert.match(steps[1].textContent, /HQ · Building 3, room 2\.14, rack B/, 'site and sysLocation');
  assert.match(steps[1].textContent, /Gi0\/5/);
  assert.match(steps[1].textContent, /access/);
  assert.match(steps[1].textContent, /Gi0\/48/);
  assert.match(steps[1].textContent, /10 Gb\/s/);
  assert.match(steps[1].textContent, /discards 2\/0 pps/, 'the counters are shown');
  assert.ok(steps[1].querySelector('.l2p-portline.is-warn'), 'discards mark the port line');
  assert.match(steps[2].textContent, /CDP/);
  assert.match(panelBy(doc, /^Path from A to B/).textContent, /Both ends are in VLAN 10/);
  steps[1].querySelector('.hostlink').click();
  await settle();
  assert.match(window.location.pathname, /^\/snmp-devices\/2$/);
});

test('a missing LLDP link is drawn as a gap step and said above the path', async (t) => {
  const { doc } = boot({ t, routes: SESSION('viewer') });
  await settle();
  fill(doc, 'l2p-from', '10.1.10.5');
  fill(doc, 'l2p-to', '10.1.10.7');
  button(panelBy(doc, /^Path from A to B/), /Find path/).click();
  await settle();
  const gap = doc.querySelector('#view .l2p-gap');
  assert.ok(gap);
  assert.match(gap.textContent, /Missing link/);
  assert.match(gap.textContent, /sw-b Gi0\/10 → sw-c Gi0\/47/);
  assert.match(gap.textContent, /desk-switch/);
  const warn = [...doc.querySelectorAll('#view .inline-note.is-warn')].map((n) => n.textContent).join(' | ');
  assert.match(warn, /an unmanaged switch or missing LLDP between them/);
});

test('"where is it" shows switch, port, VLAN name and who reported it', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION('viewer') });
  await settle();
  fill(doc, 'l2p-q', '10.1.10.5');
  doc.getElementById('l2p-q').dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.ok(log.includes('GET /api/devices/locate?q=10.1.10.5'));
  const p = panelBy(doc, /^Where is it\?/);
  assert.match(p.textContent, /sw-a/);
  assert.match(p.textContent, /Gi0\/5 — desk 12/);
  assert.match(p.textContent, /10 \(office\)/);
  assert.match(p.textContent, /HQ/);
  assert.match(p.textContent, /forwarding table of sw-core Gi0\/1/);
});

test('an unknown device is a quiet "not known", with the server\'s reason', async (t) => {
  const { doc } = boot({ t, routes: SESSION('viewer', { 'GET /api/devices/locate': { status: 404, body: { error: 'Device not found', details: { q: 'ghost is not known to this server' } } } }) });
  await settle();
  fill(doc, 'l2p-q', 'ghost');
  button(panelBy(doc, /^Where is it\?/), /Locate/).click();
  await settle();
  const p = panelBy(doc, /^Where is it\?/);
  assert.match(p.textContent, /Not known to this server/);
  assert.match(p.textContent, /ghost is not known to this server/);
});

test('an operator gets the inventory; opening a row locates it', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION('operator'), role: 'operator' });
  await settle();
  assert.ok(log.some((l) => l.startsWith('GET /api/devices/inventory?limit=50&offset=0')));
  const inv = panelBy(doc, /^Device inventory/);
  const rows = [...inv.querySelectorAll('tbody tr')];
  assert.ok(rows.length >= 8);
  assert.match(inv.textContent, /Agent/);
  assert.match(inv.textContent, /ARP only/);
  const pcC = rows.find((r) => /b8:27:eb:00:00:0d/.test(r.textContent));
  assert.match(pcC.textContent, /sw-c/);
  assert.match(pcC.textContent, /Raspberry Pi/);
  pcC.click();
  await settle();
  assert.ok(log.includes('GET /api/devices/locate?q=10.1.10.7'));
});

test('in Danish no raw catalogue key reaches the screen', async (t) => {
  const { doc } = boot({ t, routes: SESSION('operator', {}, 'da'), role: 'operator' });
  await settle();
  fill(doc, 'l2p-from', '10.1.10.5');
  fill(doc, 'l2p-to', '10.1.10.7');
  button(panelBy(doc, /^Sti fra A til B/), /Find sti/).click();
  await settle();
  const view = doc.querySelector('#view');
  assert.match(view.textContent, /Manglende forbindelse/);
  assert.match(view.textContent, /ustyret switch eller manglende LLDP/);
  assert.doesNotMatch(view.textContent, /l2p\.[a-z]/, 'no raw key');
});

test('universal search offers the jump to Path & location for an IP hit', async (t) => {
  const hit = { type: 'ip', display_name: '10.1.10.5', target: 'agent:7', confidence: 'exact', source: 'arp', last_seen: F.T(1) };
  const { doc, log, window } = boot({
    t,
    url: 'http://server.test/changes',
    routes: SESSION('viewer', {
      'GET /api/search': { hits: [hit], total: 1 },
      'GET /api/changes': { events: [], total: 0 },
    }),
  });
  await settle();
  const sq = doc.getElementById('search-q');
  sq.value = '10.1.10.5';
  sq.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  const jump = button(doc.getElementById('modal-card'), /Open Path & location/);
  assert.ok(jump, 'the search result offers the jump');
  jump.click();
  await settle();
  assert.match(window.location.pathname, /^\/path-location$/);
  assert.ok(log.includes('GET /api/devices/locate?q=10.1.10.5'), 'arrives with the question asked');
  assert.equal(doc.getElementById('l2p-q').value, '10.1.10.5');
});

// ---- suggestions -------------------------------------------------------------
// The endpoint fields stay free text, but they offer what the server already
// knows: agents (viewer+, as agent:<id>) and, for an operator, the device
// inventory by IP or MAC.
const AGENTS = [
  { id: 7, hostname: 'oslo-edge-01.corp', display_name: 'oslo-edge-01', location_name: 'Oslo', status: 'online' },
  { id: 9, hostname: 'cph-branch-09.corp', display_name: null, location_name: 'Copenhagen', status: 'offline' },
];
const options = (doc, id) => [...doc.getElementById(id).parentNode.querySelectorAll('.ui-sug-opt')];

test('typing into an endpoint field offers agents, and picking one fills agent:<id>', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION('viewer', { 'GET /agents': AGENTS }) });
  await settle();
  fill(doc, 'l2p-from', 'oslo');
  await settle();
  assert.ok(log.includes('GET /agents'), 'the agent list is fetched for the suggestions');
  assert.ok(!log.some((l) => l.startsWith('GET /api/devices/inventory')), 'a viewer never asks the operator-only inventory');
  const opts = options(doc, 'l2p-from');
  assert.equal(opts.length, 1);
  assert.match(opts[0].textContent, /oslo-edge-01/);
  assert.match(opts[0].textContent, /agent:7/);
  assert.match(opts[0].textContent, /Oslo/);
  opts[0].dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(doc.getElementById('l2p-from').value, 'agent:7');
  assert.equal(options(doc, 'l2p-from').length, 0, 'the list closes once picked');
});

test('a hostname, a site or the bare id all find the agent', async (t) => {
  const { doc } = boot({ t, routes: SESSION('viewer', { 'GET /agents': AGENTS }) });
  await settle();
  for (const [typed, expected] of [['cph-branch', 'cph-branch-09.corp'], ['copenhagen', 'cph-branch-09.corp'], ['9', 'cph-branch-09.corp']]) {
    fill(doc, 'l2p-from', typed);
    await settle();
    const opts = options(doc, 'l2p-from');
    assert.equal(opts.length, 1, typed);
    assert.match(opts[0].textContent, new RegExp(expected), typed);
  }
});

test('an operator is also offered the device inventory, by the address the lookup resolves', async (t) => {
  const { doc, log } = boot({
    t,
    role: 'operator',
    routes: SESSION('operator', {
      'GET /agents': AGENTS,
      'GET /api/devices/inventory': (q) => (q.get('q') === 'sw-a'
        ? { items: [{ key: 'd:2', kind: 'switch', id: 2, name: 'sw-a', ips: ['10.0.0.2'], macs: [{ mac: '00:11:22:33:44:02' }], site: { name: 'HQ' } }], total: 1, offset: 0 }
        : DATA.inventory),
    }),
  });
  await settle();
  fill(doc, 'l2p-to', 'sw-a');
  await settle();
  assert.ok(log.some((l) => l.startsWith('GET /api/devices/inventory?limit=6&offset=0&q=sw-a')));
  const opts = options(doc, 'l2p-to');
  assert.equal(opts.length, 1);
  assert.match(opts[0].textContent, /sw-a/);
  assert.match(opts[0].textContent, /10\.0\.0\.2 · HQ/);
  opts[0].dispatchEvent(new doc.defaultView.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(doc.getElementById('l2p-to').value, '10.0.0.2');
});

test('the field stays free text: an unknown value still runs the lookup, and Enter picks the highlighted suggestion', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION('viewer', { 'GET /agents': AGENTS }) });
  await settle();
  const ev = (id, key) => doc.getElementById(id).dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key, bubbles: true }));
  // Nothing matches — the list says so and Enter still runs the path.
  fill(doc, 'l2p-from', 'de:ad:be:ef:00:01');
  fill(doc, 'l2p-to', '10.1.10.6');
  await settle();
  assert.match(doc.getElementById('l2p-from').parentNode.textContent, /Nothing on this server matches/);
  ev('l2p-to', 'Enter');
  await settle();
  assert.ok(log.includes('GET /api/topology/l2-path?from=de%3Aad%3Abe%3Aef%3A00%3A01&to=10.1.10.6'));
  // With a suggestion highlighted, Enter picks it instead of running.
  fill(doc, 'l2p-from', 'oslo');
  await settle();
  ev('l2p-from', 'ArrowDown');
  ev('l2p-from', 'Enter');
  assert.equal(doc.getElementById('l2p-from').value, 'agent:7');
});

test('a failing agent list leaves the field working', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION('viewer', { 'GET /agents': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  fill(doc, 'l2p-q', 'oslo');
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(options(doc, 'l2p-q').length, 0);
  assert.equal(doc.getElementById('l2p-q').value, 'oslo');
});
