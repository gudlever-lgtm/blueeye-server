'use strict';

// Event markers on the history charts, driven through the view that draws them.
//
// The bug this pins: markers were drawn one per finding, unbounded. An ongoing
// problem raises a finding every cooldown window — about one per half hour per
// (metric, target) — so a ten-day view of an unhappy target carried several
// hundred, one dashed line each. Every pixel column got a line, the chart became
// a red hatch with the data somewhere underneath, and the triangles merged into
// a solid strip along the axis.
//
// Fewer marks is only half an answer; the other half is that the ones drawn must
// still account for the ones they replaced. So these assert both: the count is
// bounded by the chart's width, AND no event goes missing from the tooltips.
//
// Exercised through the Probes view rather than by calling historyChart(): app.js
// is strict-mode, so its declarations are not reachable as globals — and going
// through the view covers findingMarkers() and the API shape on the way.

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

const DAY = 86400000;
const TO = Date.now();
const FROM = TO - 10 * DAY;

// Ten days of RTT samples for one tcp target — the shape of the screenshot.
const HISTORY = Array.from({ length: 300 }, (_, i) => ({
  id: i + 1,
  ts: new Date(FROM + ((TO - FROM) / 299) * i).toISOString(),
  type: 'tcp',
  target: 'mundtrold.dk:443',
  ok: true,
  rttMs: 5 + (i % 7),
}));
const LATEST = [{ id: 1, ts: new Date(TO).toISOString(), type: 'tcp', target: 'mundtrold.dk:443', ok: true, rttMs: 9, jitterMs: 4 }];

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function openChart(t, findings, historyOverride = null) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const routes = {
    'GET /me': ME,
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    'GET /license/features': {},
    'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
    'GET /agents': AGENTS,
    'GET /api/probes/latest': { agentId: 9, results: LATEST },
    'GET /api/probes': { agentId: 9, results: historyOverride || HISTORY },
    'GET /api/findings': findings,
  };
  window.fetch = async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const status = hit === undefined ? 404 : 200;
    const payload = hit === undefined ? { error: 'Not Found' } : hit;
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
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
  window.document.querySelector('.probe-result-row').click();
  await tick(350);
  const doc = window.document;
  return { doc, errors, marks: [...doc.querySelectorAll('path.chart-marker')] };
}

const finding = (t0, severity, i) => ({
  id: `f${i}`,
  createdAt: new Date(t0).toISOString(),
  severity,
  metric: 'probe.latency',
  explanation: `event ${i}`,
});

test('five hundred findings do not become five hundred lines', async (t) => {
  const findings = Array.from({ length: 500 }, (_, i) => finding(FROM + ((TO - FROM) / 499) * i, i % 50 === 0 ? 'CRIT' : 'WARN', i));
  const { doc, marks, errors } = await openChart(t, findings);

  // The chart is 1000 units wide with 76 of padding; at 8 units per slot that is
  // ~116 distinguishable positions. The old code drew 500.
  assert.ok(marks.length > 0, 'the markers vanished entirely');
  assert.ok(marks.length <= 120, `${marks.length} marks drawn`);
  // One dashed line per drawn mark, not per finding. (The normal-range band
  // draws a dashed midline too, hence the tolerance of one.)
  const dashed = [...doc.querySelectorAll('.big-chart-svg line[stroke-dasharray]')];
  assert.ok(dashed.length <= marks.length + 1, `${dashed.length} dashed lines for ${marks.length} marks`);
  assert.deepEqual(errors, []);
});

test('a cluster says how many it stands for, and none of them is lost', async (t) => {
  // Forty findings inside one minute — a single pixel column of a ten-day view.
  const findings = Array.from({ length: 40 }, (_, i) => finding(FROM + DAY + i * 100, 'WARN', i));
  const { marks } = await openChart(t, findings);
  assert.equal(marks.length, 1, `${marks.length} marks for one pixel column`);

  const tip = marks[0].querySelector('title').textContent;
  assert.match(tip, /^40 events/, 'the count must be stated, not implied');
  assert.match(tip, /event 0/, 'a sample of the labels survives');
  assert.match(tip, /\+36 more/, 'and the remainder is accounted for, not dropped');
});

test('the worst severity in a cluster is the one that colours it', async (t) => {
  // One CRIT buried in a run of INFOs is exactly what somebody is looking for,
  // so position within the cluster must not decide the colour.
  const findings = Array.from({ length: 30 }, (_, i) => finding(FROM + DAY + i * 100, i === 7 ? 'CRIT' : 'INFO', i));
  const { marks } = await openChart(t, findings);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].getAttribute('fill'), '#dc2626', 'the CRIT was swallowed by the INFOs around it');
});

test('a lone event still reads as a lone event', async (t) => {
  const { marks } = await openChart(t, [finding(FROM + 5 * DAY, 'WARN', 1)]);
  assert.equal(marks.length, 1);
  const tip = marks[0].querySelector('title').textContent;
  assert.doesNotMatch(tip, /\d+ events/, 'a single event must not be dressed up as a cluster');
  assert.match(tip, /event 1/);
});

test('a cluster is drawn taller than a lone event, so density reads without a tooltip', async (t) => {
  const one = await openChart(t, [finding(FROM + DAY, 'WARN', 1)]);
  const many = await openChart(t, Array.from({ length: 12 }, (_, i) => finding(FROM + DAY + i * 100, 'WARN', i)));
  assert.equal(one.marks.length, 1);
  assert.equal(many.marks.length, 1);
  assert.notEqual(one.marks[0].getAttribute('d'), many.marks[0].getAttribute('d'));
});

test('findings outside the window are not drawn, and no findings draws nothing', async (t) => {
  const outside = await openChart(t, [finding(FROM - 30 * DAY, 'CRIT', 1), finding(TO + 30 * DAY, 'CRIT', 2)]);
  assert.equal(outside.marks.length, 0);
  const none = await openChart(t, []);
  assert.equal(none.marks.length, 0);
});

test('a finding with no timestamp is skipped rather than drawn at the origin', async (t) => {
  const { marks } = await openChart(t, [
    { id: 'a', severity: 'CRIT', metric: 'x', explanation: 'no timestamp' },
    { id: 'b', createdAt: 'nonsense', severity: 'CRIT', metric: 'x', explanation: 'bad timestamp' },
    finding(FROM + 5 * DAY, 'WARN', 9),
  ]);
  assert.equal(marks.length, 1);
  assert.match(marks[0].querySelector('title').textContent, /event 9/);
});

test('a failed probe in the history is still marked, alongside the findings', async (t) => {
  // Probe failures are markers too, from a different source — they must survive
  // the clustering rather than be crowded out by findings at the same instant.
  const history = HISTORY.slice();
  history[150] = { ...history[150], ok: false, rttMs: null, detail: 'connection refused' };
  const { marks } = await openChart(t, [], history);
  assert.equal(marks.length, 1);
  assert.match(marks[0].querySelector('title').textContent, /connection refused/);
});
