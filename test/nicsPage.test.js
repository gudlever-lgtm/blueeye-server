'use strict';

// public/views/nics.js — the NIC inventory on the UI contract
// (docs/ui-contract.md).
//
// Driver and firmware strings change when somebody updates a machine, so this
// answers "which firmware is deployed where" — asset work, and it sits under
// Administration for that reason. Its per-agent tab is gone: one agent's cards
// are a section of the Fleet drawer now
// (docs/fleet-and-sites-consolidation.md).
//
// What this pins: the host-name chips are HostLinks, the grey summary line is a
// StatStrip that filters, and the drift table says which firmware is the
// outlier.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const INV = {
  agents: 12,
  totalNics: 31,
  drift: [{
    label: 'Intel X710-DA2',
    count: 9,
    firmwares: [
      { firmwareVersion: '8.50', count: 6, isOutlier: false, agents: [{ id: 7, name: 'oslo-edge-01', iface: 'eth0' }] },
      { firmwareVersion: '7.10', count: 3, isOutlier: true, agents: [{ id: 9, name: 'sto-branch-07', iface: 'eth0' }] },
    ],
  }],
  drivers: [
    { label: 'Intel X710-DA2', count: 9, hasDrift: true, firmwares: [{ firmwareVersion: '8.50', count: 6 }, { firmwareVersion: '7.10', count: 3 }] },
    { label: 'Broadcom BCM57416', count: 14, hasDrift: false, firmwares: [{ firmwareVersion: '218.0', count: 14 }] },
  ],
  byAgent: [
    { id: 7, name: 'oslo-edge-01', location: 'Oslo HQ', nics: [{ iface: 'eth0', driver: 'i40e', driverVersion: '2.22', firmwareVersion: '8.50', busInfo: '0000:3b:00.0' }, { iface: 'eth1', driver: 'i40e', driverVersion: '2.22', firmwareVersion: '8.50', busInfo: '0000:3b:00.1' }] },
    { id: 9, name: 'sto-branch-07', location: null, nics: [{ iface: 'eth0', driver: 'bnxt_en', driverVersion: '2.19', firmwareVersion: '7.10', busInfo: '0000:04:00.0' }] },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/nic-inventory', role = 'admin' } = {}) {
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

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/fleet/nics': INV,
}, over);

const tabs = (doc) => [...doc.querySelectorAll('#view [role="tablist"] .subtab')];
const stats = (doc) => [...doc.querySelectorAll('#view .stat-card')];
const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];
const panelBy = (doc, re) => panels(doc).find((p) => re.test((p.querySelector('h2') || {}).textContent || ''));
const rowsIn = (panel) => [...panel.querySelectorAll('table.dt tbody tr')];

test('the inventory is one page on the contract, with no tab strip left', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /NICs/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .seg, #view .seg-btn').length, 0, 'the segmented control survived');
  assert.equal(doc.querySelectorAll('#view .nics-controls, #view .section-head').length, 0, 'the old chrome survived');
  // The per-agent tab was a second way to ask "what is in this machine", one
  // click from the same answer in the Fleet drawer.
  assert.equal(tabs(doc).length, 0, 'the per-agent tab survived');
});

test('the summary line is a StatStrip, and the drift count filters', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-n').textContent), ['12', '31', '1']);
  assert.equal(doc.querySelectorAll('#view .nics-summary, #view .bad-text').length, 0, 'the grey summary survived');

  // With drift selected, the full model inventory goes — the question is "what
  // is mismatched", not "what is deployed".
  assert.ok(panelBy(doc, /NIC models/), 'the inventory is missing before the filter');
  stats(doc)[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(50);
  assert.equal(stats(doc)[2].getAttribute('aria-pressed'), 'true');
  assert.ok(panelBy(doc, /Firmware drift/));
  assert.ok(!panelBy(doc, /NIC models/), 'the whole inventory is still there under the drift filter');
});

test('the agents on a firmware are HostLinks, not chips', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /agents/9': { id: 9 } }) });
  await settle();
  const drift = panelBy(doc, /Firmware drift/);
  assert.equal(doc.querySelectorAll('#view .nic-chips, #view .chip').length, 0,
    'chips carrying a host name and an action survived');
  const link = [...drift.querySelectorAll('.hostlink')].find((a) => /sto-branch-07/.test(a.textContent));
  assert.ok(link, 'the affected machines are not linked');
  link.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/agents/9');
});

test('the drift table says which firmware is the outlier', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const rows = rowsIn(panelBy(doc, /Firmware drift/));
  assert.equal(rows.length, 2, 'one row per firmware, not one block per model');
  const tone = (tr) => [...tr.querySelector('.badge-ui').classList].filter((c) => c !== 'badge-ui')[0];
  assert.equal(tone(rows[0]), 'ok');
  assert.equal(tone(rows[1]), 'warn');
  assert.match(rows[1].textContent, /7\.10/);
});

test('a model with drift is flagged in the inventory too', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const rows = rowsIn(panelBy(doc, /NIC models/));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].querySelector('.badge-ui'), 'the drifting model is not flagged');
  assert.equal(rows[1].querySelectorAll('.badge-ui').length, 0, 'a model with one firmware is flagged anyway');
  // The drift badge carried `style="margin-left:.4rem"` — the last inline style
  // on this screen. A DataTable's <col width> is the contract's one exemption.
  const inline = [...doc.querySelectorAll('#view [style]')].filter((n) => n.tagName !== 'COL');
  assert.deepEqual(inline.map((n) => n.getAttribute('style')), []);
});

test('nothing reporting yet is one state, not a strip of zeros', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /api/fleet/nics': { agents: 0, totalNics: 0, drift: [], drivers: [], byAgent: [] } }),
  });
  await settle();
  assert.equal(stats(doc).length, 0, 'a strip of zeros above a tab strip above an empty table');
  assert.equal(tabs(doc).length, 0);
  assert.equal(doc.querySelectorAll('#view .toolbar-ui').length, 0);
  const state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No NIC inventory yet/);
  assert.match(state.textContent, /ethtool -i/);
});

test('no drift at all says so rather than showing an empty panel', async (t) => {
  const { doc, window } = boot({
    t, routes: SESSION({ 'GET /api/fleet/nics': Object.assign({}, INV, { drift: [] }) }),
  });
  await settle();
  assert.ok(!panelBy(doc, /Firmware drift/), 'an empty drift panel is drawn anyway');
  stats(doc)[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(50);
  const state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No firmware drift/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Show every model/.test(b.textContent)));
});

test('a 500 is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors, window, log } = boot({
    t, routes: SESSION({ 'GET /api/fleet/nics': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the load');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed load is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/api\/fleet\/nics/);
  assert.equal(stats(doc).length, 0, 'the strip kept showing numbers the load never returned');

  const before = log.filter((x) => x.key === 'GET /api/fleet/nics').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/fleet/nics').length > before, 'Retry did not retry');
});

test('a 404 is reported, not drawn as an empty inventory', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/fleet/nics': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 was drawn as "nothing reports NIC data"');
  assert.match(err.textContent, /Not Found|404/i);
});

test('the agent page draws the same card table, from the same module', async (t) => {
  const src = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(src, /function nicTable\(nics\) \{[\s\S]*?return v\.nicTable\(nics\);/);
  assert.doesNotMatch(src, /class: 'iface-table' \}, el\('thead'/);
  void t;
});
