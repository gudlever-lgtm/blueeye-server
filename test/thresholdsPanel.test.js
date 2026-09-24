'use strict';

// Settings → Outage thresholds (public/thresholdsPanel.js), booted inside the
// real dashboard.
//
// The behaviour that must survive: every metric is a row, including one with no
// threshold (which says it is NOT evaluated — an absent row would read as
// fine); a location scope says which rows it only inherits; editing goes
// through PUT with the server's validation errors placed under the field they
// are about; removing is a DELETE naming the metric.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/settings/thresholds', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push({ key, url: String(u), body: opts.body ? JSON.parse(opts.body) : null });
    const hit = typeof routes[key] === 'function' ? routes[key]() : routes[key];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
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

// No packet_loss global: that metric is not evaluated anywhere.
const GLOBAL = { scope: 'global', thresholds: [
  { id: 1, location_id: null, metric: 'reachability', warning_value: null, critical_value: null, debounce_count: 3 },
  { id: 2, location_id: null, metric: 'latency', warning_value: 150, critical_value: 300, debounce_count: 3 },
] };
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': { analysis: true, alerting: true },
  'GET /license/plan': { plan_name: 'Professional', modules: {} },
  'GET /locations': [{ id: 4, name: 'Aarhus' }],
  'GET /api/thresholds': GLOBAL,
  'GET /api/thresholds/4': { locationId: 4, thresholds: [
    { id: 1, location_id: null, metric: 'reachability', warning_value: null, critical_value: null, debounce_count: 3, source: 'global' },
    { id: 9, location_id: 4, metric: 'latency', warning_value: 40, critical_value: 80, debounce_count: 2, source: 'location' },
  ] },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const rowFor = (doc, re) => rows(doc).find((r) => re.test(r.cells[0].textContent));

test('every metric is a row; one with no threshold says it is not evaluated', async (t) => {
  const { doc, errors, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(log.some((l) => l.key === 'GET /api/thresholds'));
  assert.equal(rows(doc).length, 3);
  assert.match(rowFor(doc, /Latency/).textContent, /150 ms/);
  assert.match(rowFor(doc, /Latency/).textContent, /300 ms/);
  assert.match(rowFor(doc, /Reachability/).textContent, /any failed probe/);
  assert.match(rowFor(doc, /Packet loss/).textContent, /Not set: not evaluated/);
  assert.match(doc.querySelector('#view').textContent, /no threshold here, so outages are not opened/);
  // The Settings tab is on the second strip, labelled through t().
  const tab = doc.querySelector('#view [role="tab"][data-tab="thresholds"]');
  assert.ok(tab);
  assert.equal(tab.textContent, 'Outage thresholds');
});

test('a location scope marks what it only inherits, and edits there create an override', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION({ 'PUT /api/thresholds/4': { threshold: {} } }) });
  await settle();
  const sel = doc.querySelector('#view .toolbar-ui select');
  sel.value = '4';
  sel.dispatchEvent(new window.Event('change'));
  await settle();
  assert.ok(log.some((l) => l.key === 'GET /api/thresholds/4'));
  assert.match(rowFor(doc, /Latency/).textContent, /Location override/);
  assert.match(rowFor(doc, /Reachability/).textContent, /Inherits global/);
  rowFor(doc, /Reachability/).click();
  const drawer = doc.querySelector('.ui-drawer');
  assert.match(drawer.textContent, /Saving creates an override for this location only/);
  // Reachability has no values to set, only the run length.
  assert.equal(drawer.querySelector('#thr-warn'), null);
  drawer.querySelector('#thr-debounce').value = '5';
  [...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
  await settle();
  const put = log.find((l) => l.key === 'PUT /api/thresholds/4');
  assert.deepEqual(put.body, { metric: 'reachability', debounce_count: '5' });
});

test('the server\'s validation error lands under the field it is about', async (t) => {
  const { doc } = boot({ t, routes: SESSION({
    'PUT /api/thresholds': { status: 400, body: { error: 'Validation failed', details: { critical_value: 'critical_value must be greater than or equal to warning_value' } } },
  }) });
  await settle();
  rowFor(doc, /Latency/).click();
  const drawer = doc.querySelector('.ui-drawer');
  drawer.querySelector('#thr-warn').value = '500';
  drawer.querySelector('#thr-crit').value = '100';
  [...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
  await settle();
  const crit = drawer.querySelector('#thr-crit');
  assert.equal(crit.getAttribute('aria-invalid'), 'true');
  assert.match(crit.parentNode.querySelector('.field-error').textContent, /greater than or equal to warning_value/);
  assert.ok(doc.querySelector('.ui-drawer'), 'the drawer stays open on a 400');
});

test('Remove is a DELETE naming the metric, offered only where there is something to remove', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION({ 'DELETE /api/thresholds': { removed: { scope: 'global', metric: 'latency' } } }) });
  await settle();
  const more = rowFor(doc, /Latency/).querySelector('button[aria-haspopup="menu"]');
  more.click();
  [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => b.textContent === 'Remove').click();
  await settle();
  assert.ok(log.some((l) => l.key === 'DELETE /api/thresholds' && /metric=latency/.test(l.url)), 'the DELETE names the metric');
  // A metric with no threshold has nothing to remove.
  assert.equal(rowFor(doc, /Packet loss/).querySelector('button[aria-haspopup="menu"]'), null);
});

test('a failed read is an ErrorState that names the call', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/thresholds': { status: 500, body: { error: 'Internal Server Error' } } }) });
  await settle();
  const state = doc.querySelector('#view .state.is-error');
  assert.ok(state);
  assert.match(state.textContent, /GET \/api\/thresholds/);
});

test('the section has an address', () => {
  const routes = require('../public/routes.js');
  assert.equal(routes.match('/settings/thresholds').tab, 'thresholds');
});
