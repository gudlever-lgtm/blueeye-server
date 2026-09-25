'use strict';

// public/views/traffic.js — Traffic on the UI contract (docs/ui-contract.md).
//
// Three controls used to ask one question — which series to plot: two chips for
// the totals and a "Pr. agent" fold for the rest. They are one picker now, and
// the legend is where a series comes off again. These tests hold what had to
// survive that: the totals are still what you get on first load, the reader's
// choice still survives a tick, and the drag-to-zoom still freezes the chart
// against the 3-second poll.

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
  { id: 7, status: 'online', display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' },
  { id: 8, status: 'online', display_name: 'cph-core-02', hostname: 'cph-core-02' },
  { id: 9, status: 'offline', display_name: 'sto-branch-07', hostname: 'sto-branch-07' },
];
const result = (rx, tx) => [{ payload: { traffic: { totals: { rxBytesPerSec: rx, txBytesPerSec: tx } } } }];

function boot({ t, routes = {}, url = 'http://server.test/traffic', role = 'admin' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 160));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': AGENTS,
  'GET /agents/7/results': result(1200000, 240000),
  'GET /agents/8/results': result(600000, 120000),
  'GET /agents/9/results': result(0, 0),
  'GET /locations': [{ id: 1, latitude: 59.9, longitude: 10.7 }, { id: 2, latitude: null }],
  'GET /api/findings': [],
  'GET /system/storage': { disk: {}, db: {} },
}, over);

const cards = (doc) => [...doc.querySelectorAll('#view .statstrip .stat-card')];
const legend = (doc) => [...doc.querySelectorAll('#view .ui-chart-legend .ui-legend-item')];
const picker = (doc) => doc.querySelector('#view .toolbar-ui select');
const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];

test('Traffic is a DashboardPage: PageHeader, StatStrip, a chart Panel, a Top-agents table', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner came back');
  assert.equal(doc.querySelectorAll('#view .kpis').length, 0, 'the legacy KPI strip survived');
  assert.equal(doc.querySelectorAll('#view .chart-card').length, 0, 'the legacy chart card survived');
  assert.equal(doc.querySelectorAll('#view .chip-det').length, 0, 'the "Pr. agent" chip fold survived');
  assert.equal(cards(doc).length, 4);
  assert.equal(rows(doc).length, 3, 'the top-agents table is not a DataTable');
});

test('the strip carries the two totals, the agents and the sites', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const values = cards(doc).map((c) => c.querySelector('.stat-n').textContent);
  // 1.2 MB + 0.6 MB in, 240 kB + 120 kB out; 2 of 3 agents online; 2 sites.
  assert.match(values[0], /MB\/s$/);
  assert.match(values[1], /kB\/s$|KB\/s$/i);
  assert.equal(values[2], '2 / 3');
  assert.equal(values[3], '2');
  assert.ok(cards(doc)[2].classList.contains('warn'), 'an agent being down is not flagged');
});

test('the first load plots the two totals, and the picker offers the rest', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const names = legend(doc).map((l) => l.textContent.replace('×', '').trim());
  assert.deepEqual(names, ['Total RX', 'Total TX']);
  // What is already plotted is not offered again.
  const options = [...picker(doc).options].map((o) => o.textContent);
  assert.ok(!options.includes('Total RX'), 'a plotted series is still in the picker');
  assert.ok(options.some((o) => /oslo-edge-01/.test(o)), 'the agents are not offered');
  assert.equal(options.length, 1 + AGENTS.length * 2, 'the picker is missing series');
});

test('the picker adds a series and the legend takes it off again', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const sel = picker(doc);
  const opt = [...sel.options].find((o) => /oslo-edge-01/.test(o.textContent));
  sel.value = opt.value;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(legend(doc).length, 3, 'the picked series was not plotted');
  assert.ok(legend(doc).some((l) => /oslo-edge-01/.test(l.textContent)));

  const item = legend(doc).find((l) => /oslo-edge-01/.test(l.textContent));
  item.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(legend(doc).length, 2, 'the legend did not remove the series');
  // And it is back on offer.
  assert.ok([...picker(doc).options].some((o) => /oslo-edge-01/.test(o.textContent)));
});

test('a legend dot takes its colour from a class, never an inline style', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const dots = [...doc.querySelectorAll('#view .ui-chart-legend .ui-legend-dot')];
  assert.equal(dots.length, 2);
  for (const d of dots) {
    assert.equal(d.getAttribute('style'), null, 'a legend dot still styles itself inline');
    assert.ok([...d.classList].some((c) => /^ui-series-\d$/.test(c)), 'no series class on the dot');
  }
});

test('"Reset zoom" is disabled while the chart is live', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const btn = [...doc.querySelectorAll('#view .toolbar-right .btn')].find((b) => /Reset zoom/i.test(b.textContent));
  assert.ok(btn, 'no reset control');
  assert.ok(btn.disabled, 'reset is offered with nothing to reset');
});

test('an unacked CRIT finding is an inline note with a way into Analysis', async (t) => {
  const finding = { severity: 'CRIT', metric: 'latency', explanation: 'p95 doubled at oslo-edge-01', acked: false, createdAt: '2026-09-12T14:00:00.000Z' };
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/findings': [finding] }) });
  await settle();
  const note = doc.querySelector('#view .inline-note.is-crit');
  assert.ok(note, 'the alert banner did not become an inline note');
  assert.match(note.textContent, /p95 doubled/);
  assert.equal(doc.querySelectorAll('#view .alert-banner').length, 0, 'the legacy banner survived');
  assert.ok(note.querySelector('.btn'), 'no way through to the finding');
});

test('no finding means no note at all — an empty bar is not a state', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(doc.querySelectorAll('#view .inline-note').length, 0);
});

test('a 500 on /agents is an ErrorState with the shell and the header intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /agents': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, [], 'the 500 threw');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/agents/);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
});

test('a 404 on one agent\'s results counts as zero, it does not lose the tick', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /agents/8/results': { status: 404, body: { error: 'Not Found' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(rows(doc).length, 3, 'the agent dropped out of the table');
  assert.equal(cards(doc)[2].querySelector('.stat-n').textContent, '2 / 3');
});

test('the three unmigrated folds are still on the page', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(doc.querySelector('#view .storage-fold'), 'the storage fold is gone');
  assert.ok(doc.querySelector('#view .hist-row .hist-main'), 'the history explorer is gone');
  // And the storage line is filled on mount, not on the tenth tick.
  assert.ok(!/Storage …/.test(doc.querySelector('#view .storage-line').textContent),
    'the storage line is still on its placeholder');
  const summaries = [...doc.querySelectorAll('#view details.sec > summary')].map((x) => x.textContent);
  assert.ok(summaries.some((x) => /History/.test(x)), 'the history fold is gone');
  assert.ok(summaries.some((x) => /Traffic type/.test(x)), 'the traffic-type fold is gone');
});

test('a viewer sees the page; nothing on it is an operator action', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION(), role: 'viewer' });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'a viewer cannot read the traffic');
  assert.equal(cards(doc).length, 4);
});

// ---- Why a row reads no bandwidth ------------------------------------------
// A flow-sourced agent used to show a permanent 0 B/s: the collectors reported
// byte counts and no rate at all. They report rates now (agent 0.45.1), and
// where there is still nothing to show the table says which of the four
// reasons it is, rather than printing a zero and leaving the reader to guess.

const cellsOf = (doc) => rows(doc).map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim()));

test('an agent that never reported says so instead of reading 0 B/s', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /agents/9/results': [] }) });
  await settle();
  const row = cellsOf(doc).find((c) => /sto-branch-07/.test(c[0]));
  assert.equal(row[2], '–', 'a rate nobody can source is still printed as a number');
  assert.match(row[4], /Never reported/);
});

test('a flow source with nothing exporting to it names that, not zero', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /agents/9/results': [{ payload: { traffic: { source: 'sflow', datagrams: 0, totals: { bytes: 0, bytesPerSec: 0 } } } }],
    }),
  });
  await settle();
  const row = cellsOf(doc).find((c) => /sto-branch-07/.test(c[0]));
  assert.match(row[4], /Nothing is exporting/);
});

test('a switch exporting sFlow shows its rate and says the direction is unknown', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /agents/9/results': [{
        payload: {
          traffic: {
            source: 'sflow', datagrams: 120,
            totals: { bytes: 6000000, bytesPerSec: 100000, rxBytesPerSec: 0, txBytesPerSec: 0, unattributedBytes: 6000000 },
          },
        },
      }],
    }),
  });
  await settle();
  const row = cellsOf(doc).find((c) => /sto-branch-07/.test(c[0]));
  assert.match(row[4], /direction unknown/);
  assert.match(row[4], /\d[\d.]*\s?[kKM]B\/s/, 'the rate it CAN measure is not shown');
});

test('an agent below 0.45.1 on a flow source is named as too old, not as idle', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      // No rate fields at all — the pre-0.45.1 flow snapshot.
      'GET /agents/9/results': [{ payload: { traffic: { source: 'sflow', datagrams: 120, totals: { bytes: 6000000, packets: 40, flows: 9 } } } }],
    }),
  });
  await settle();
  const row = cellsOf(doc).find((c) => /sto-branch-07/.test(c[0]));
  assert.match(row[4], /too old/);
});

test('a result older than five minutes is not current bandwidth', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /agents/9/results': [{
        created_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
        payload: { traffic: { source: 'proc', totals: { rxBytesPerSec: 900000, txBytesPerSec: 900000 } } },
      }],
    }),
  });
  await settle();
  const row = cellsOf(doc).find((c) => /sto-branch-07/.test(c[0]));
  assert.equal(row[2], '–', 'a 45-minute-old reading is still shown as current');
  assert.match(row[4], /Last reported/);
});

test('an agent that is reporting fine carries no note', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const row = cellsOf(doc).find((c) => /oslo-edge-01/.test(c[0]));
  assert.match(row[2], /MB\/s$/);
  assert.equal(row[4], '', 'a healthy row was given a reason it does not need');
});
