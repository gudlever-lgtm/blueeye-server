'use strict';

// The Probes & Tests results table, after it took the Monitors disclosure shape.
//
// Two claims are worth testing and neither is about appearance:
//
//   1. The Measured column says something for EVERY probe type. The three
//      columns it replaced (RTT / Loss / Jitter) fit ping and left four of the
//      nine types completely blank, while pageload and transaction put a number
//      under "RTT" that is not an RTT.
//   2. Opening a row in place actually survives — the table refreshes every five
//      seconds and used to replace its own tbody, which would have closed any
//      open row before anyone finished reading it.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const ME = { id: 1, email: 'op@blueeye.local', role: 'operator', preferences: {} };
const AGENTS = [{ id: 9, hostname: 'h1', display_name: 'Branch agent' }];
const TS = new Date().toISOString();

const row = (over) => ({ id: 1, ts: TS, target: 'example.com', ok: true, ...over });

function fakeFetch(routes, calls) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, path: p, url: String(url) });
    const hit = routes[`${method} ${p}`];
    const status = hit === undefined ? 404 : 200;
    const payload = hit === undefined ? { error: 'Not Found' } : hit;
    return {
      ok: status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function boot(t, results, extraRoutes = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const calls = [];
  window.fetch = fakeFetch({
    'GET /me': ME,
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    'GET /license/features': {},
    'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
    'GET /agents': AGENTS,
    'GET /api/probes/latest': { agentId: 9, results },
    'GET /api/probes': { agentId: 9, results: [] },
    'GET /api/findings': [],
    ...extraRoutes,
  }, calls);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', 'operator');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  window.document.querySelector('button[data-view="probes"]').click();
  await tick(250);
  return { window, doc: window.document, errors, calls };
}

const cells = (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
const measuredOf = (tr) => cells(tr)[3];

// ------------------------------------------------------- the Measured column
test('every probe type says what it measured — none of them is blank', async (t) => {
  const results = [
    row({ type: 'ping', target: '1.1.1.1', rttMs: 12.3, lossPct: 0, jitterMs: 1.4 }),
    row({ type: 'tcp', target: 'host:443', rttMs: 9, lossPct: 0 }),
    row({ type: 'dns', target: 'example.com', rttMs: 22, lossPct: 0 }),
    row({ type: 'http', target: 'https://x/', rttMs: 81, status: 200 }),
    row({ type: 'curl', target: 'https://x/', rttMs: 81, status: 200, bytes: 8878 }),
    row({ type: 'pageload', target: 'https://x/', rttMs: 1240, bytes: 348000 }),
    row({ type: 'transaction', target: 'https://x/', rttMs: 4200, elements: [{}, {}, {}] }),
    row({ type: 'traceroute', target: '8.8.8.8', hops: [{ hop: 1, lossPct: 0 }, { hop: 2, lossPct: 33 }] }),
    row({ type: 'tcptraceroute', target: '8.8.8.8:443', hops: [{ hop: 1, lossPct: 0 }] }),
    row({ type: 'path_mtu', target: '10.0.0.1', mtu: { pathMtu: 1420, recommendedMss: 1380 } }),
  ];
  const { doc, errors } = await boot(t, results);
  const rows = [...doc.querySelectorAll('.probe-result-row')];
  assert.equal(rows.length, results.length);
  for (const tr of rows) {
    const m = measuredOf(tr);
    assert.notEqual(m, '–', `${cells(tr)[1]} measured nothing`);
    assert.ok(m.length > 0);
  }
  assert.deepEqual(errors, []);
});

test('the Measured column uses each type\'s own words, not a borrowed RTT label', async (t) => {
  const results = [
    row({ type: 'ping', target: '1.1.1.1', rttMs: 12.3, lossPct: 2, jitterMs: 1.4 }),
    row({ type: 'pageload', target: 'https://x/', rttMs: 1240, bytes: 348000 }),
    row({ type: 'transaction', target: 'https://x/', rttMs: 4200, elements: [{}, {}, {}] }),
    row({ type: 'traceroute', target: '8.8.8.8', hops: [{ hop: 1, lossPct: 0 }, { hop: 2, lossPct: 33 }] }),
    row({ type: 'path_mtu', target: '10.0.0.1', mtu: { pathMtu: 1420, recommendedMss: 1380 } }),
    row({ type: 'curl', target: 'https://x/', rttMs: 81, status: 200, bytes: 8878 }),
  ];
  const { doc } = await boot(t, results);
  const byType = {};
  for (const tr of doc.querySelectorAll('.probe-result-row')) byType[cells(tr)[1]] = measuredOf(tr);

  assert.match(byType.ping, /12\.3 ms.*2% loss.*1\.4 ms jitter/);
  // pageload's number is a whole-page load time and transaction's is a total
  // across steps — under a column headed "RTT" both were simply wrong.
  assert.match(byType.pageload, /1240 ms load/);
  assert.match(byType.transaction, /4200 ms total · 3 steps/);
  assert.match(byType.traceroute, /2 hops · 33% worst hop loss/);
  assert.match(byType.path_mtu, /1420 B · MSS 1380/);
  assert.match(byType.curl, /81 ms · 200/);
});

test('a result with nothing to report reads as an em dash, never an invented zero', async (t) => {
  const { doc } = await boot(t, [
    row({ type: 'path_mtu', target: '10.0.0.1', ok: false, detail: 'ping failed: socket: Operation not permitted', mtu: { pathMtu: null } }),
    row({ type: 'traceroute', target: '8.8.8.8', ok: false, detail: 'traceroute not installed', hops: [] }),
  ]);
  const rows = [...doc.querySelectorAll('.probe-result-row')];
  for (const tr of rows) assert.equal(measuredOf(tr), '–');
  // The reason is on the row, not behind a click.
  assert.match(rows[0].textContent, /Operation not permitted/);
  assert.match(rows[1].textContent, /traceroute not installed/);
});

test('a path-MTU blackhole is on the closed row — the one finding that must not hide', async (t) => {
  const { doc } = await boot(t, [
    row({ type: 'path_mtu', target: '10.0.0.1', mtu: { pathMtu: 1420, recommendedMss: 1380, blackholeDetected: true } }),
  ]);
  assert.match(doc.querySelector('.probe-result-row').textContent, /blackhole/i);
});

// ------------------------------------------------------------- disclosure
test('a row opens in place and closes again', async (t) => {
  const { doc } = await boot(t, [row({ type: 'ping', target: '1.1.1.1', rttMs: 12 })]);
  const tr = doc.querySelector('.probe-result-row');
  const detail = doc.querySelector('.probe-detail-row');
  assert.equal(detail.hidden, true);
  assert.equal(tr.querySelector('.sa-disclosure').textContent, '▸');

  tr.click();
  await tick(200);
  assert.equal(detail.hidden, false);
  assert.ok(tr.classList.contains('open'));
  assert.equal(tr.querySelector('.sa-disclosure').textContent, '▾');

  tr.click();
  await tick(50);
  assert.equal(detail.hidden, true);
  assert.ok(!tr.classList.contains('open'));
});

test('the row answers the keyboard, which the button it replaced did for free', async (t) => {
  const { window, doc } = await boot(t, [row({ type: 'ping', target: '1.1.1.1', rttMs: 12 })]);
  const tr = doc.querySelector('.probe-result-row');
  assert.equal(tr.getAttribute('tabindex'), '0', 'a clickable <tr> is not focusable on its own');
  for (const key of ['Enter', ' ']) {
    tr.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    // eslint-disable-next-line no-await-in-loop
    await tick(200);
  }
  // Opened then closed again.
  assert.equal(doc.querySelector('.probe-detail-row').hidden, true);
});

test('only one row is open at a time', async (t) => {
  const { doc } = await boot(t, [
    row({ type: 'ping', target: '1.1.1.1', rttMs: 12 }),
    row({ type: 'ping', target: '8.8.8.8', rttMs: 20 }),
  ]);
  const rows = [...doc.querySelectorAll('.probe-result-row')];
  const details = [...doc.querySelectorAll('.probe-detail-row')];
  rows[0].click(); await tick(200);
  assert.equal(details[0].hidden, false);

  rows[1].click(); await tick(200);
  // Two open path visualisations would each write the brush window to the URL,
  // and the second would overwrite the first's without saying so.
  assert.equal(details[0].hidden, true, 'opening the second must close the first');
  assert.equal(details[1].hidden, false);
  assert.equal(doc.querySelectorAll('.probe-result-row.open').length, 1);
});

test('the detail is fetched once, however many times the row is toggled', async (t) => {
  const ctx = await boot(t, [row({ type: 'ping', target: '1.1.1.1', rttMs: 12 })]);
  const tr = ctx.doc.querySelector('.probe-result-row');
  const historyCalls = () => ctx.calls.filter((c) => c.path === '/api/probes').length;

  tr.click(); await tick(250);
  const first = historyCalls();
  assert.ok(first > 0, 'opening fetched the history');

  tr.click(); await tick(50);
  tr.click(); await tick(250);
  assert.equal(historyCalls(), first, 're-opening re-fetched');
});

test('a failing detail shows the error in the row instead of leaving it blank', async (t) => {
  const ctx = await boot(t, [row({ type: 'ping', target: '1.1.1.1', rttMs: 12 })], {
    'GET /api/probes': undefined, // 404 from the fake
  });
  ctx.doc.querySelector('.probe-result-row').click();
  await tick(300);
  const detail = ctx.doc.querySelector('.probe-detail-row');
  assert.equal(detail.hidden, false);
  assert.ok(detail.textContent.trim().length > 0, 'an open row that shows nothing is worse than a closed one');
});

// ----------------------------------------------------------------- refresh
test('the five-second refresh is paused while a row is open, and says so', async (t) => {
  const ctx = await boot(t, [row({ type: 'ping', target: '1.1.1.1', rttMs: 12 })]);
  const note = [...ctx.doc.querySelectorAll('.probes .muted.small')]
    .find((n) => /refresh paused/i.test(n.textContent));
  assert.ok(note, 'no pause notice in the DOM');
  assert.equal(note.hidden, true, 'hidden while nothing is open');

  const tr = ctx.doc.querySelector('.probe-result-row');
  tr.click();
  await tick(200);
  assert.equal(note.hidden, false, 'a table that quietly stopped updating is its own trap');

  // The refresh would replace the tbody and close the row; it must not fire.
  const before = ctx.calls.filter((c) => c.path === '/api/probes/latest').length;
  await tick(5600);
  assert.equal(ctx.calls.filter((c) => c.path === '/api/probes/latest').length, before,
    'the refresh ran and would have closed the open row');
  assert.equal(ctx.doc.querySelector('.probe-detail-row').hidden, false, 'the row is still open');

  tr.click();
  await tick(50);
  assert.equal(note.hidden, true, 'and it resumes when the row closes');
});

// ------------------------------------------------------------------ actions
test('the Install button does not open the row it sits in', async (t) => {
  const { doc } = await boot(t, [
    row({ type: 'traceroute', target: '8.8.8.8', ok: false, detail: 'traceroute not installed', hops: [] }),
  ]);
  const btn = [...doc.querySelectorAll('.probe-result-row button')].find((b) => /install/i.test(b.textContent));
  assert.ok(btn, 'no install button on a probe that names a missing tool');
  btn.click();
  await tick(150);
  assert.equal(doc.querySelector('.probe-detail-row').hidden, true, 'clicking an action opened the row');
});

// ------------------------------------------- a trace opens its path in the row
test('a traceroute row opens the path visualisation inside the table', async (t) => {
  // The fattest case: the detail is an SVG hop graph plus a brushable timeline,
  // and both size themselves from their container. Dropped into a <td> they
  // would otherwise be sized by the table's column algorithm.
  const hops = [{ hop: 1, ip: '192.0.2.1', rttMs: 1, lossPct: 0 }, { hop: 2, ip: '8.8.8.8', rttMs: 9, lossPct: 0 }];
  const ctx = await boot(t, [row({ type: 'traceroute', target: '8.8.8.8', hops })], {
    'GET /api/probes/path': {
      agentId: 9,
      target: '8.8.8.8',
      nodes: [
        { hop: 0, ip: null, label: 'Agent' },
        { hop: 1, ip: '192.0.2.1', rttMs: 1, lossPct: 0 },
        { hop: 2, ip: '8.8.8.8', rttMs: 9, lossPct: 0 },
      ],
      links: [],
      asGraph: { nodes: [], links: [] },
    },
    'GET /api/probes/path/metrics': { metrics: [{ id: 'latency', label: 'Latency', unit: 'ms', render: 'line' }] },
    'GET /api/probes/path/timeseries': { agentId: 9, target: '8.8.8.8', overlay: 'off', metric: 'latency', series: [] },
  });

  const tr = ctx.doc.querySelector('.probe-result-row');
  tr.click();
  await tick(500);

  const cell = ctx.doc.querySelector('.probe-detail-row > td');
  assert.equal(ctx.doc.querySelector('.probe-detail-row').hidden, false);
  assert.equal(cell.getAttribute('colspan'), '6', 'the detail must span the table, not sit in one column');
  assert.ok(cell.querySelector('.pathviz'), `no path visualisation: ${cell.textContent.slice(0, 200)}`);
  assert.deepEqual(ctx.errors, []);
});

test('closing a trace row leaves the URL alone for the next one', async (t) => {
  // pathVisualization persists its brush window to the query string. With two
  // rows open at once the second would overwrite the first's silently, which is
  // why the table is an accordion — this pins that only one is ever mounted.
  const ctx = await boot(t, [
    row({ type: 'traceroute', target: '8.8.8.8', hops: [{ hop: 1, ip: '192.0.2.1' }] }),
    row({ type: 'traceroute', target: '1.1.1.1', hops: [{ hop: 1, ip: '192.0.2.1' }] }),
  ], {
    'GET /api/probes/path': { agentId: 9, nodes: [{ hop: 0 }, { hop: 1, ip: '192.0.2.1' }], links: [], asGraph: { nodes: [], links: [] } },
    'GET /api/probes/path/metrics': { metrics: [] },
    'GET /api/probes/path/timeseries': { series: [] },
  });
  const rows = [...ctx.doc.querySelectorAll('.probe-result-row')];
  rows[0].click(); await tick(400);
  rows[1].click(); await tick(400);
  assert.equal(ctx.doc.querySelectorAll('.probe-detail-row:not([hidden]) .pathviz').length, 1,
    'two path visualisations were mounted at once');
});
