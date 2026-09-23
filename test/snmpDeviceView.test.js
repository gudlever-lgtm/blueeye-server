'use strict';

// public/views/snmpDevice.js — the switch page shows what the server now keeps
// (migrations 116-117): FCS, late collisions and duplex beside errors and
// discards, the VLAN names, and what the switch says it is (sysDescr).
//
// Booted through the real dashboard at /snmp-devices/1, like the other view
// tests, so the route, the i18n catalogue and the UI kit are all real.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/snmp-devices/1' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
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
  window.localStorage.setItem('blueeye.server.role', 'admin');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors };
}
const settle = () => new Promise((r) => setTimeout(r, 160));

const DEVICE = {
  device: {
    id: 1, host: '10.14.0.11', displayName: 'sw-core-1', supported: ['if', 'fdb', 'vlan'],
    sysDescr: 'Cisco IOS Software, C2960X Software, Version 15.2(7)E3', lastOkAt: new Date().toISOString(),
  },
  interfaces: [
    { id: 5, ifName: 'Fa0/5', operStatus: 'up', adminStatus: 'up', speedMbps: 100 },
    { id: 7, ifName: 'Fa0/7', operStatus: 'up', adminStatus: 'up', speedMbps: 100 },
    { id: 9, ifName: 'Fa0/9', operStatus: 'up', adminStatus: 'up', speedMbps: 100 },
  ],
  fdb: [],
  fdbTotal: 0,
  neighbours: [],
  vlans: [{ vlan: 10, name: 'Data' }, { vlan: 20, name: 'Voice' }],
};
const COUNTERS = {
  deviceId: 1,
  counters: [
    { interfaceId: 5, duplex: 'full', fcsPps: 0, lateCollPps: 0, inErrPps: 0, outErrPps: 0 },
    { interfaceId: 7, duplex: 'half', fcsPps: 0.2, lateCollPps: 1.5, inErrPps: 0.2, outErrPps: 0 },
    { interfaceId: 9, duplex: null, fcsPps: null, lateCollPps: null },
  ],
};
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/settings/maintenance': { windows: [] },
  'GET /api/snmp-devices/1': DEVICE,
  'GET /api/snmp-devices/1/counters': COUNTERS,
}, over);

function tableRows(doc, headerText) {
  const tables = [...doc.querySelectorAll('#view table')];
  const table = tables.find((tb) => [...tb.querySelectorAll('thead th')].some((th) => th.textContent.trim() === headerText));
  return table ? { head: [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()), rows: [...table.querySelectorAll('tbody tr')] } : null;
}

test('the port table shows FCS, late collisions and duplex, and a half-duplex port with late collisions is flagged', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const ports = tableRows(doc, 'Port');
  assert.ok(ports, 'the port table rendered');
  for (const h of ['FCS', 'Late coll.', 'Duplex']) assert.ok(ports.head.includes(h), `missing column ${h}: ${ports.head.join('|')}`);

  const col = (name) => ports.head.indexOf(name);
  const cell = (row, name) => row.querySelectorAll('td')[col(name)];
  const [full, half, silent] = ports.rows;

  assert.match(cell(full, 'Duplex').textContent, /Full/);
  // Half duplex WITH late collisions is the mismatch signature: critical, with
  // the reason on hover.
  const badge = cell(half, 'Duplex').querySelector('.badge-ui');
  assert.ok(badge && badge.classList.contains('crit'), 'half duplex with late collisions must read as a fault');
  assert.match(badge.getAttribute('title') || '', /duplex mismatch/);
  assert.match(cell(half, 'Late coll.').textContent, /1\.5/);
  // A port that could not answer shows a dash, never a zero or "full".
  assert.equal(cell(silent, 'Duplex').textContent.trim(), '–');
  assert.equal(cell(silent, 'FCS').textContent.trim(), '–');
});

test('the VLAN names and sysDescr are on the page', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const text = doc.querySelector('#view').textContent;
  assert.match(text, /Cisco IOS Software, C2960X Software, Version 15\.2\(7\)E3/);
  const vlans = tableRows(doc, 'VLAN');
  assert.ok(vlans, 'the VLAN table rendered');
  assert.deepEqual(
    vlans.rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent.trim())),
    [['10', 'Data'], ['20', 'Voice']],
  );
});

test('a deep link to /snmp-devices/:id opens THAT switch (it used to say "No device selected")', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.doesNotMatch(doc.querySelector('#view').textContent, /No device selected/);
  assert.match(doc.querySelector('#view').textContent, /sw-core-1/);
});

test('a switch without VLAN names or sysDescr gets no empty panel', async (t) => {
  const { doc, errors } = boot({
    t,
    routes: SESSION({ 'GET /api/snmp-devices/1': { ...DEVICE, vlans: [], device: { ...DEVICE.device, sysDescr: null } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(tableRows(doc, 'VLAN'), null);
  assert.doesNotMatch(doc.querySelector('#view').textContent, /Reports itself as/);
});
