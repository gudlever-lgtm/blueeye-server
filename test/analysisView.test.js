'use strict';

// public/views/analysis.js — Analysis on the UI contract (docs/ui-contract.md).
//
// The change this screen exists to make: a finding used to carry three buttons
// in its last cell, which stacked into a three-line column. Acknowledge is now
// the one action on the row; the rest are behind ⋯ and the explanation they led
// to is in the Drawer. The tests below hold that, and hold the behaviour that
// had to survive the migration.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const FINDINGS = [
  { id: 11, createdAt: '2026-09-12T14:02:00.000Z', hostId: 7, metric: 'latency', severity: 'CRIT', kind: 'SPIKE', deviation: 6.4, explanation: 'median rtt 61.3 ms vs baseline 18.2 ms', acked: false, correlatedWith: [1, 2] },
  { id: 12, createdAt: '2026-09-12T10:44:00.000Z', hostId: 8, metric: 'loss', severity: 'WARN', kind: 'SPIKE', deviation: 3.1, explanation: '2.4% loss vs baseline 0.0%', acked: false, originalSeverity: 'CRIT' },
  { id: 13, createdAt: '2026-09-11T16:22:00.000Z', hostId: 7, metric: 'jitter', severity: 'INFO', kind: 'FLATLINE', deviation: null, explanation: 'jitter has gone flat', acked: true },
];
const SUMMARY = {
  total: 3, unacked: 2,
  bySeverity: { CRIT: 1, WARN: 1, INFO: 1 },
  byMetric: [{ metric: 'latency', count: 1, avgDeviation: 6.4, maxDeviation: 6.4 }, { metric: 'loss', count: 1, avgDeviation: 3.1, maxDeviation: 3.1 }],
  byHost: [{
    hostId: 7, count: 2, crit: 1, warn: 0, avgDeviation: 6.4,
    lastAt: '2026-09-12T14:00:00.000Z',
    topMetrics: [
      { metric: 'probe.latency', count: 1, crit: 1, lastAt: '2026-09-12T14:00:00.000Z' },
      { metric: 'probe.loss', count: 1, crit: 0, lastAt: '2026-09-12T13:00:00.000Z' },
    ],
  }],
};

function boot({ t, routes = {}, url = 'http://server.test/analysis', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push({ key, url: String(u) });
    const hit = routes[key];
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
const settle = () => new Promise((r) => setTimeout(r, 110));
// The page carries three tables: the findings list, and the two breakdown
// panels inside the panel grid. Anything about "the list" means the first.
// The FINDINGS list specifically. The page now leads with a "what is wrong,
// where" overview, which is also a .panel-ui table.dt — a selector that takes
// every table on the page silently counted those rows too.
const panelByTitle = (doc, re) => [...doc.querySelectorAll('#view .panel-ui')]
  .find((p) => {
    const h = p.querySelector('.panel-head h2');
    return h && re.test(h.textContent.trim());
  });
const listRows = (doc) => {
  const panel = panelByTitle(doc, /^Findings$/);
  return panel ? [...panel.querySelectorAll('table.dt tbody tr')] : [];
};
const overviewRows = (doc) => {
  const panel = panelByTitle(doc, /^What is wrong/);
  return panel ? [...panel.querySelectorAll('table.dt tbody tr')] : [];
};
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: { analysis: true } },
  'GET /agents': [{ id: 7, display_name: 'oslo-edge-01' }, { id: 8, display_name: 'cph-core-02' }],
  'GET /api/findings': FINDINGS,
  'GET /api/findings/summary': SUMMARY,
  'GET /api/findings/11/context': { changes: [{ timestamp: '2026-09-12T13:58:00.000Z', summary: 'Gi0/2 went down', type: 'interface.down' }], partial: false, failedSources: [] },
  'POST /api/findings/11/ack': { ok: true },
}, over);

test('THE FIX: one action on the row, the rest behind ⋯ — no stack of buttons', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const rows = listRows(doc);
  assert.equal(rows.length, 3);
  for (const tr of rows) {
    const cell = tr.querySelector('.row-act');
    assert.ok(cell, 'the actions cell is not a rowActions');
    // At most two controls: the hover primary and the ⋯. An acknowledged
    // finding has only the ⋯, because there is nothing left to acknowledge.
    const btns = cell.querySelectorAll('.btn');
    assert.ok(btns.length <= 2, `${btns.length} buttons stacked in one cell`);
    assert.ok(cell.querySelector('[aria-haspopup="menu"]'), 'no ⋯ menu');
  }
  const unacked = rows[0].querySelector('.row-act .on-hover');
  assert.ok(unacked, 'Acknowledge is not the hover action');
  assert.match(unacked.textContent, /Acknowledge/);
  // The acknowledged row offers no Acknowledge at all.
  assert.equal(rows[2].querySelector('.row-act .on-hover'), null);
});

test('the ⋯ menu carries what used to be the other two buttons', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  listRows(doc)[0].querySelector('[aria-haspopup="menu"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  const menu = doc.querySelector('.ui-rowmenu');
  assert.ok(menu, 'the ⋯ opened nothing');
  const labels = [...menu.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(labels.some((l) => /Open details/i.test(l)), labels.join(', '));
  assert.ok(labels.some((l) => /Fleet/i.test(l)), labels.join(', '));
  // The admin-only severity-rule entry — the third button that used to stack.
  assert.ok(labels.some((l) => /severity rule/i.test(l)), labels.join(', '));
});

test('a viewer gets no Acknowledge and no severity rule, and still reads the page', async (t) => {
  const { doc, window } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.ok(listRows(doc).length, 'a viewer cannot read Analysis');
  listRows(doc)[0].querySelector('[aria-haspopup="menu"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  const labels = [...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent);
  assert.ok(!labels.some((l) => /severity rule/i.test(l)), 'a viewer was offered a severity rule');
});

test('Analysis is a ListPage: PageHeader, StatStrip, Toolbar, DataTable, no banner', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const ui = doc.querySelector('#view .ui.ui-page');
  assert.ok(ui);
  assert.ok(ui.querySelector('.page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner came back');
  assert.equal(doc.querySelectorAll('#view .fs-chip').length, 0, 'the severity chips survived');
  assert.equal(ui.querySelectorAll('.page-head-actions .btn-primary').length, 0,
    'an export is not a primary action');
  const stats = [...ui.querySelectorAll('.statstrip .stat-card')];
  assert.equal(stats.length, 5, 'the overview is not a StatStrip');
  assert.match(stats[0].textContent, /3/);
  assert.match(stats[1].textContent, /2/);
});

test('the StatStrip filters, and the request carries the filter', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  doc.querySelector('#view .stat-card.crit').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const last = log.filter((c) => c.key === 'GET /api/findings').pop();
  assert.equal(new URL(last.url, 'http://server.test').searchParams.get('severity'), 'CRIT');
});

test('the metric filter is scoped by host+severity but the summary is not, so the dropdown stays useful', async (t) => {
  const { log } = boot({ t, routes: SESSION() });
  await settle();
  const summary = log.filter((c) => c.key === 'GET /api/findings/summary').pop();
  assert.ok(summary, 'the summary was never fetched');
  assert.equal(new URL(summary.url, 'http://server.test').searchParams.get('metric'), null,
    'the summary carried the metric filter, so its own breakdown could never offer another metric');
});

test('a row opens the Drawer: the explanation, the numbers, and what changed just before', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  listRows(doc)[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(drawer, 'the row opened nothing');
  assert.ok(drawer.querySelector('.drawer-head .badge-ui.crit'));
  assert.match(drawer.textContent, /median rtt 61\.3 ms/, 'the explanation is not in the Drawer');
  assert.match(drawer.textContent, /6\.4σ/, 'the deviation is not in the Drawer');
  // The context is a second request, made when the Drawer opens, not per row.
  assert.match(drawer.textContent, /Gi0\/2 went down/, 'what changed did not load');
});

test('a severity a rule changed says so, on the row, and the note is not truncated away', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const panel = panelByTitle(doc, /^Findings$/);
  // BY HEADER, and inside the findings panel. Indexing children[3] of whatever
  // .panel-ui came first broke the moment the page grew an overview above the
  // list — and it would break again on the next column.
  const heads = [...panel.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  const sevAt = heads.findIndex((h) => /^Severity/.test(h));
  assert.ok(sevAt >= 0, `no severity column — headers: ${heads.join(' | ')}`);

  const cell = listRows(doc)[1].children[sevAt];
  assert.match(cell.textContent, /WARN/);
  assert.match(cell.textContent, /CRIT/, 'a downgraded finding does not say what was detected');
  // The column has to hold the badge AND the note: "wa…" tells nobody anything.
  const col = [...panel.querySelectorAll('colgroup col')][sevAt];
  assert.ok(parseInt(col.style.width, 10) >= 170,
    `severity column is ${col.style.width} — too narrow for the badge plus the rule note`);
});

test('Acknowledge posts, and the screen re-reads rather than guessing', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const before = log.filter((c) => c.key === 'GET /api/findings').length;
  listRows(doc)[0].querySelector('.row-act .on-hover')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(log.filter((c) => c.key === 'POST /api/findings/11/ack').length, 1);
  assert.ok(log.filter((c) => c.key === 'GET /api/findings').length > before, 'the list was not re-read');
  assert.ok(doc.querySelector('#ui-toasts .ui-toast'), 'no confirmation');
});

test('an empty result is an EmptyState with a way to widen the filter', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/findings': [], 'GET /api/findings/summary': { total: 0, unacked: 0, bySeverity: {}, byMetric: [], byHost: [] } }) });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'no EmptyState');
  assert.equal(state.classList.contains('is-error'), false);
  assert.equal(listRows(doc).length, 0);
});

test('a 500 is an ErrorState naming the call, with the shell and the strip intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/findings': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, [], 'the 500 threw');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/findings/);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('#view .statstrip'), 'the summary died with the list');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
});

test('the breakdowns are panels, not chips, and their rows still pivot the filter', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const panels = [...doc.querySelectorAll('#view .panel-grid .panel-ui')];
  assert.equal(panels.length, 2, 'By metric / By host are not two panels');
  const metricLink = panels[0].querySelector('a.hostlink');
  assert.ok(metricLink, 'a metric row is not clickable');
  metricLink.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const last = log.filter((c) => c.key === 'GET /api/findings').pop();
  assert.equal(new URL(last.url, 'http://server.test').searchParams.get('metric'), 'latency');
});


// ============================================== what is wrong, and where
// The page used to open with five totals and then five hundred raw rows. At
// 184 668 findings that is a firehose with a header — nobody reads row 300,
// and the one finding that mattered is in there with the rest.

test('the page LEADS with the places, not with the rows', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();

  const panels = [...doc.querySelectorAll('#view .panel-ui .panel-head h2')].map((h) => h.textContent.trim());
  const overviewAt = panels.findIndex((p) => /^What is wrong/.test(p));
  const listAt = panels.findIndex((p) => /^Findings$/.test(p));
  assert.ok(overviewAt >= 0, `no overview panel — panels: ${panels.join(' | ')}`);
  assert.ok(overviewAt < listAt, 'the raw list comes before the overview');
});

test('a place says WHAT is wrong on it, not just how much', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const row = overviewRows(doc)[0];
  assert.ok(row, 'no overview rows');

  // The NAME, not the agent id — "host 7" is a number somebody looks up.
  assert.match(row.textContent, /oslo-edge-01/);
  // …and the metrics that are actually wrong on it.
  assert.match(row.textContent, /probe\.latency/);
  assert.match(row.textContent, /probe\.loss/);
});

test('a viewer sees the overview but is offered no Accept', async (t) => {
  const admin = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(overviewRows(admin.doc)[0].textContent.includes('Accept'), 'an admin can accept');

  // `role` seeds localStorage, which is what the module reads at load — the
  // page renders before GET /me lands, so overriding only the route is not
  // enough to make it a viewer.
  const viewer = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.ok(overviewRows(viewer.doc).length, 'a viewer still gets the overview');
  assert.ok(!overviewRows(viewer.doc)[0].textContent.includes('Accept'), 'but cannot accept');
});

test('Accept scopes to that host and the screen re-reads', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION({ 'POST /api/findings/ack': { acked: 2 } }) });
  await settle();
  const btn = [...overviewRows(doc)[0].querySelectorAll('.btn')].find((b) => /Accept/.test(b.textContent));
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  const call = log.find((c) => /POST \/api\/findings\/ack/.test(c.key));
  assert.ok(call, `no accept posted — calls: ${log.map((c) => c.key).join(', ')}`);
  // Scoped to the row it was clicked on, so it accepts what the row says and
  // nothing wider. `key` drops the query string, so the scope is on `url`.
  assert.match(call.url, /hostId=7/);
});
