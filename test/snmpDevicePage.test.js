'use strict';

// public/views/snmpDevice.js — one polled switch. Pins what a technician needs
// on the switch page: the port table can be filtered, the forwarding table is
// shown (with a copy button on each MAC), and utilisation is the busier
// direction rather than the in-direction only.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/snmp-devices/3', role = 'admin' } = {}) {
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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const DEVICE = {
  device: { id: 3, displayName: 'sw-access-1', host: '10.0.0.2', supported: ['fdb'], lastOkAt: '2026-09-17T18:40:00.000Z' },
  interfaces: [
    { id: 11, ifName: 'Gi1/0/1', ifAlias: 'uplink core', operStatus: 'up', adminStatus: 'up', speedMbps: 1000, nameSource: 'ifName' },
    { id: 12, ifName: 'Gi1/0/2', ifAlias: 'printer', operStatus: 'down', adminStatus: 'up', speedMbps: 100, nameSource: 'ifName' },
    { id: 13, ifName: 'Gi1/0/3', ifAlias: '', operStatus: 'up', adminStatus: 'up', speedMbps: 1000, nameSource: 'ifName' },
  ],
  fdb: [
    { mac: 'aa:bb:cc:00:00:01', vlan: 10, bridgePort: 1, ifName: 'Gi1/0/1', portMacCount: 40, moveCount: 0, lastSeen: '2026-09-17T18:39:00.000Z' },
    { mac: 'aa:bb:cc:00:00:02', vlan: 20, bridgePort: 3, ifName: 'Gi1/0/3', portMacCount: 1, moveCount: 4, lastSeen: '2026-09-17T18:39:00.000Z' },
  ],
  fdbTotal: 2,
  neighbours: [],
};
const COUNTERS = { counters: [
  { interfaceId: 11, inBps: 2e6, outBps: 9e8, inUtilPct: 0.2, outUtilPct: 90, inErrPps: 0, outErrPps: 0.5, inDiscPps: 0, outDiscPps: 0 },
] };

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [],
  'GET /api/snmp-devices/3': DEVICE,
  'GET /api/snmp-devices/3/counters': COUNTERS,
}, over);

const panelByTitle = (doc, re) => [...doc.querySelectorAll('#view .panel-ui')]
  .find((p) => re.test((p.querySelector('h2') || {}).textContent || ''));

test('the switch page renders its ports and its MAC table without errors', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const macs = panelByTitle(doc, /MAC address table/);
  assert.ok(macs, 'no MAC table');
  const rows = [...macs.querySelectorAll('table.dt tbody tr')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /aa:bb:cc:00:00:01/);
  assert.ok(rows[0].querySelector('.copy-btn'), 'no copy button on the MAC');
  // A MAC that keeps moving carries the tone.
  assert.ok(rows[1].querySelector('.num-crit'), 'a MAC moving 4 times is not flagged');
});

test('the MAC table filters by MAC in any notation, port or VLAN', async (t) => {
  const { window, doc } = boot({ t, routes: SESSION() });
  await settle();
  const macs = panelByTitle(doc, /MAC address table/);
  const input = macs.querySelector('input[type=search]');
  input.value = 'aa-bb-cc-00-00-02';
  input.dispatchEvent(new window.Event('input'));
  let rows = [...macs.querySelectorAll('table.dt tbody tr')];
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Gi1\/0\/3/);
  input.value = 'gi1/0/1';
  input.dispatchEvent(new window.Event('input'));
  rows = [...macs.querySelectorAll('table.dt tbody tr')];
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /aa:bb:cc:00:00:01/);
});

test('the port table filters as it is typed', async (t) => {
  const { window, doc } = boot({ t, routes: SESSION() });
  await settle();
  const ports = panelByTitle(doc, /Ports|Porte/);
  const input = ports.querySelector('input[type=search]');
  input.value = 'printer';
  input.dispatchEvent(new window.Event('input'));
  const rows = [...ports.querySelectorAll('table.dt tbody tr')];
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Gi1\/0\/2/);
});

test('utilisation is the busier direction, so a saturated uplink does not read idle', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const ports = panelByTitle(doc, /Ports|Porte/);
  const first = ports.querySelector('table.dt tbody tr');
  assert.match(first.textContent, /90 %/);
  // And the rates are in bits.
  assert.match(first.textContent, /900\.0 Mbit\/s/);
});
