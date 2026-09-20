'use strict';

// public/views/interfaces.js — Interfaces on the UI contract
// (docs/ui-contract.md).
//
// The migration this pins: the control row becomes a Toolbar, the status chip
// joins the app's one severity vocabulary, an idle virtual port stops sorting
// above the port that is actually dropping frames, and the flow-source empty
// state keeps every word of its explanation.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const IFACES = [
  { iface: 'eth0', status: 'warn', virtual: false, linkDown: false, speedMbps: 1000, operStatus: 'up', utilPct: 82, rxBytesPerSec: 94e6, txBytesPerSec: 12e6, errPerSec: 0, dropPerSec: 14 },
  { iface: 'eth1', status: 'bad', virtual: false, linkDown: false, speedMbps: 1000, operStatus: 'up', utilPct: 31, rxBytesPerSec: 3e6, txBytesPerSec: 8e5, errPerSec: 7, dropPerSec: 0 },
  { iface: 'eth2', status: 'ok', virtual: false, linkDown: false, speedMbps: 10000, operStatus: 'up', utilPct: 4, rxBytesPerSec: 4e5, txBytesPerSec: 12e4, errPerSec: 0, dropPerSec: 0 },
  { iface: 'docker0', status: 'down', virtual: true, linkDown: true, speedMbps: null, operStatus: 'down', utilPct: null, rxBytesPerSec: 0, txBytesPerSec: 0, errPerSec: 0, dropPerSec: 0 },
];

function boot({ t, routes = {}, url = 'http://server.test/interfaces', role = 'admin' } = {}) {
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
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [
    { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', status: 'online' },
    { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02', status: 'online' },
  ],
  'GET /api/interfaces': { source: 'proc', ts: '2026-09-17T18:40:00.000Z', interfaces: IFACES },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const names = (doc) => rows(doc).map((tr) => tr.querySelector('td').textContent.trim());

test('Interfaces is a ListPage with a Toolbar', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Interfaces/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.ok(doc.querySelector('#view .toolbar-ui'), 'the controls are not a Toolbar');
  assert.equal(doc.querySelectorAll('#view .history-controls, #view .section-head').length, 0,
    'the old control row and heading survived');
  assert.match(doc.querySelector('#view .toolbar-ui .toolbar-right button').textContent, /Refresh/);
  assert.equal(rows(doc).length, 4);
});

test('the measurement line is the panel\'s note, not a span at the end of the controls', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const note = doc.querySelector('#view .panel-head .meta-xs');
  assert.ok(note, 'nothing says where the numbers came from');
  assert.match(note.textContent, /proc/);
  assert.equal(doc.querySelectorAll('#view .toolbar-ui .muted').length, 0);
});

test('an idle virtual port does not sort above the port dropping frames', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // docker0 is `status: down`, which used to rank it FIRST — above eth1, which
  // is actually erroring. It reads IDLE, so it ranks below OK too.
  assert.deepEqual(names(doc), ['eth1', 'eth0', 'eth2', 'docker0']);
});

test('the status chip is on the app\'s severity tones', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const tone = (n) => {
    const b = rows(doc).find((tr) => tr.querySelector('td').textContent.trim() === n).querySelector('.badge-ui');
    return [...b.classList].filter((c) => c !== 'badge-ui')[0];
  };
  assert.equal(tone('eth1'), 'crit');
  assert.equal(tone('eth0'), 'warn');
  assert.equal(tone('eth2'), 'ok');
  // An idle virtual port is not a fault, so it is neutral — not the red its
  // `down` status would otherwise earn it.
  assert.equal(tone('docker0'), 'neutral');
  assert.equal(doc.querySelectorAll('#view .badge.online, #view .badge.error, #view .badge.grace').length, 0,
    'the old badge classes survived');
});

test('errors and discards carry their own tone, and a zero does not', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const row = (n) => rows(doc).find((tr) => tr.querySelector('td').textContent.trim() === n);
  assert.ok(row('eth1').querySelector('.num-crit'), 'a port erroring reads like a port that is fine');
  assert.ok(row('eth0').querySelector('.num-warn'), 'a port discarding reads like a port that is fine');
  assert.equal(row('eth2').querySelectorAll('.num-crit, .num-warn').length, 0,
    'a zero is coloured as if it were a problem');
});

test('picking another agent reads that agent', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const sel = doc.querySelector('#view .toolbar-ui select');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['oslo-edge-01', 'cph-core-02']);
  sel.value = '8';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/interfaces').pop().url, /agentId=8/);
});

test('a flow-source agent is told this table can never fill, and why', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /api/interfaces': { source: 'sflow', ts: null, interfaces: [] } }),
  });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'no state at all');
  assert.ok(!state.classList.contains('is-error'), 'a working agent is drawn as a failure');
  // The distinction that matters: not "no data yet" — this will never have data,
  // and the fix is a setting, not a wait.
  assert.match(state.textContent, /flows, not interface counters/i);
  assert.match(state.textContent, /proc/);
  assert.match(state.textContent, /snmp/);
  // …and it points at the screens that DO use what this agent reports.
  assert.ok([...state.querySelectorAll('button, a')].some((n) => /Traffic/.test(n.textContent)));
  assert.ok([...state.querySelectorAll('button')].some((b) => /Change the traffic source/.test(b.textContent)));
});

test('a proc agent with no measurement yet says to wait, not to change a setting', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /api/interfaces': { source: 'proc', ts: null, interfaces: [] } }),
  });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No interface data yet/);
  assert.ok(!/flows, not interface counters/i.test(state.textContent));
});

test('no agents at all is one state, not a picker above an empty table', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /agents': [] }) });
  await settle();
  assert.equal(doc.querySelectorAll('#view .toolbar-ui').length, 0, 'an agent picker with nothing in it');
  const state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No agents yet/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Open Agents/.test(b.textContent)));
});

test('a 500 is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors, window, log } = boot({
    t, routes: SESSION({ 'GET /api/interfaces': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the read');
  assert.ok(doc.querySelector('#view .toolbar-ui'), 'the agent picker went with it');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed read is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/api\/interfaces/);

  const before = log.filter((x) => x.key === 'GET /api/interfaces').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/interfaces').length > before, 'Retry did not retry');
});

test('a 404 is reported, not drawn as "no data yet"', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/interfaces': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 was drawn as an agent that has not measured yet');
  assert.match(err.textContent, /Not Found|404/i);
});

test('the agent page draws the same table, from the same module', async (t) => {
  // Two copies of this table would drift, so app.js reads it off the view.
  const src = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(src, /function interfaceTable\(interfaces, source = null\) \{[\s\S]*?return v\.table\(interfaces, source\);/);
  assert.doesNotMatch(src, /const IFACE_RANK/);
  assert.doesNotMatch(src, /function ifaceStatusBadge/);
  void t;
});
