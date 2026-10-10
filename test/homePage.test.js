'use strict';

// public/views/home.js — the Overview landing screen on the UI contract
// (docs/ui-contract.md).
//
// The behaviour that must survive: the bare root opens it, the counts come
// from the three reads the other screens already make, each list is a
// shortlist that links into the screen that owns it, and — the point — a
// source that cannot be read takes down its own panel and says so instead of
// showing a reassuring zero.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const FLEET = {
  windowMin: 60,
  summary: { ok: 2, warn: 1, bad: 1, down: 0, stale: 0, unknown: 0, offline: 1, total: 4, acknowledged: 0 },
  agents: [
    { agentId: 7, hostname: 'oslo-edge-01', displayName: 'oslo-edge-01', locationName: 'Oslo', online: true, status: 'online', lastReportAt: '2026-09-12T14:02:00.000Z', health: { status: 'bad', metrics: {} } },
    { agentId: 8, hostname: 'hq-1', displayName: 'hq-1', locationName: 'HQ', online: false, status: 'offline', lastReportAt: null, health: { status: 'down', metrics: {} } },
    { agentId: 9, hostname: 'oslo-2', displayName: 'oslo-2', locationName: 'Oslo', online: true, status: 'online', lastReportAt: '2026-09-12T14:00:00.000Z', health: { status: 'ok', metrics: {} } },
  ],
};
const TSHOOT = {
  window: { from: '2026-09-12T13:00:00.000Z', to: '2026-09-12T14:00:00.000Z', minutes: 60 },
  summary: { activeFaults: 47, affectedDevices: 9, rootCauses: 2, anomalies: 3, devicesDown: 1, devicesUnreachable: 2, devicesDegraded: 0 },
  rootCauses: [
    { id: 11, source: 'cluster', clusterId: 11, severity: 'critical', cause: 'Core switch core-sw-1 is down.', affectedDeviceIds: [1, 2, 3], firstSeen: '2026-09-12T13:10:00.000Z' },
    { id: 4, source: 'case', caseId: 4, severity: 'warning', cause: 'Loss on the Oslo uplink.', affectedDeviceIds: [7], firstSeen: '2026-09-12T13:40:00.000Z' },
  ],
  anomalies: [], timeline: [], topology: { counts: {}, nodes: [] }, partial: false, failedSources: [], restricted: [],
};
const CHANGES = {
  since: '2026-09-11T14:00:00.000Z', total: 2, partial: false, failedSources: [], groups: [],
  events: [
    { timestamp: '2026-09-12T14:02:00.000Z', severity: 'CRIT', kind: 'probe', type: 'probe.latency.degraded', summary: 'latency degraded at oslo-edge-01', agentId: 7, ackKey: 'a', count: 1 },
    { timestamp: '2026-09-12T10:44:00.000Z', severity: 'WARN', kind: 'finding', type: 'finding.loss', summary: 'loss on oslo-edge-01', agentId: 7, ackKey: 'b', count: 1 },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push(key);
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
const settle = () => new Promise((r) => setTimeout(r, 250));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/fleet/health': FLEET,
  'GET /api/troubleshooting/overview': TSHOOT,
  'GET /api/changes': CHANGES,
}, over);

const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];
const panelBy = (doc, re) => panels(doc).find((p) => re.test((p.querySelector('h2') || {}).textContent || ''));
const cards = (doc) => [...doc.querySelectorAll('#view .stat-card')].map((c) => c.textContent);

test('the bare root opens the Overview: header with help, the counts, and the three shortlists', async (t) => {
  const { doc, errors, log, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(window.location.pathname, '/overview');
  assert.equal(doc.querySelector('.tabs button.active').dataset.view, 'home');

  for (const call of ['GET /api/fleet/health', 'GET /api/troubleshooting/overview', 'GET /api/changes']) {
    assert.ok(log.includes(call), `${call} was not made`);
  }
  const view = doc.querySelector('#view');
  assert.equal(view.querySelector('h1').textContent.replace('?', '').trim(), 'Overview');
  assert.ok(view.querySelector('.page-head .help-btn'), 'help lives in the (?) popover');

  // The counts, each from its own source.
  assert.ok(cards(doc).some((c) => /^4Agents$/.test(c)), cards(doc).join(' | '));
  assert.ok(cards(doc).some((c) => /^1Offline$/.test(c)));
  assert.ok(cards(doc).some((c) => /^2Not OK$/.test(c)), 'bad + down + warn');
  assert.ok(cards(doc).some((c) => /^2Root causes$/.test(c)));
  assert.ok(cards(doc).some((c) => /^47Active faults$/.test(c)));
  assert.ok(cards(doc).some((c) => /^2Changes \(24h\)$/.test(c)));

  const causes = panelBy(doc, /^What needs attention/);
  assert.ok(causes);
  assert.match(causes.textContent, /Core switch core-sw-1 is down\./);
  assert.match(causes.textContent, /3 device\(s\)/);

  // Only the agents that are not OK, and never the healthy one.
  const fleet = panelBy(doc, /^Agents worth a look/);
  assert.match(fleet.textContent, /oslo-edge-01/);
  assert.match(fleet.textContent, /hq-1/);
  assert.doesNotMatch(fleet.textContent, /oslo-2/);
  assert.match(fleet.textContent, /OFFLINE/);

  const changes = panelBy(doc, /^What changed/);
  assert.match(changes.textContent, /latency degraded at oslo-edge-01/);
  assert.match(changes.textContent, /Critical/);

  assert.doesNotMatch(view.textContent, /home\.(stat|col|causes|agents|changes)\./, 'no raw catalogue key reaches the screen');
  assert.equal(view.querySelector('.inline-note'), null, 'nothing failed, so nothing is flagged');
});

test('a row links into the screen that owns it', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /agents/7': { id: 7, hostname: 'oslo-edge-01', status: 'online' } }) });
  await settle();
  const link = [...panelBy(doc, /^Agents worth a look/).querySelectorAll('.hostlink')][0];
  assert.ok(link);
  link.click();
  await settle();
  assert.match(window.location.pathname, /^\/agents\/7$/);
});

test('a count card opens the screen behind the number', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const card = [...doc.querySelectorAll('#view .stat-card')].find((c) => /Root causes/.test(c.textContent));
  card.click();
  await settle();
  assert.equal(window.location.pathname, '/troubleshooting/graph');
});

// 404 (the route is not mounted on this deployment) and 500 (it is, and it
// broke) are the two answers the page must survive, and it must survive them
// the same way: one panel down, the rest of the screen intact.
for (const status of [404, 500]) {
  test(`a source answering ${status} takes down its own panel only, and the counts it fed read as a dash`, async (t) => {
    const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/fleet/health': { status, body: { error: 'boom' } } }) });
    await settle();
    assert.deepEqual(errors, []);
    const fleet = panelBy(doc, /^Agents worth a look/);
    assert.ok(fleet.querySelector('.state.is-error'), 'the fleet panel does not say it failed');
    assert.match(fleet.textContent, /GET \/api\/fleet\/health/, 'the failed call is not named');

    // The other two still rendered.
    assert.match(panelBy(doc, /^What needs attention/).textContent, /Core switch core-sw-1 is down\./);
    assert.match(panelBy(doc, /^What changed/).textContent, /latency degraded/);

    // Never a reassuring zero for a number nobody could read.
    assert.ok(cards(doc).some((c) => /^—Agents$/.test(c)), cards(doc).join(' | '));
    assert.ok(cards(doc).some((c) => /^—Offline$/.test(c)));
    assert.match(doc.querySelector('#view .inline-note').textContent, /Could not read: fleet health/);
  });
}

// The troubleshooting rollup answers 503 when the aggregation service is not
// wired at all — a deployment state, not a fault, and the panel says it the
// same way rather than rendering an empty all-clear.
test('the root-cause panel says so when the rollup is not available (503)', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/troubleshooting/overview': { status: 503, body: { error: 'Troubleshooting overview is not available' } } }) });
  await settle();
  const causes = panelBy(doc, /^What needs attention/);
  assert.ok(causes.querySelector('.state.is-error'));
  assert.doesNotMatch(causes.textContent, /No live root cause/, 'an unread source must not read as an all-clear');
  assert.ok(cards(doc).some((c) => /^—Root causes$/.test(c)));
});

test('an all-clear is an empty state per list, not a blank page', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /api/fleet/health': { ...FLEET, summary: { ok: 3, warn: 0, bad: 0, down: 0, stale: 0, unknown: 0, offline: 0, total: 3 }, agents: [FLEET.agents[2]] },
      'GET /api/troubleshooting/overview': { ...TSHOOT, summary: { ...TSHOOT.summary, rootCauses: 0, activeFaults: 0 }, rootCauses: [] },
      'GET /api/changes': { ...CHANGES, total: 0, events: [] },
    }),
  });
  await settle();
  assert.match(panelBy(doc, /^What needs attention/).textContent, /No live root cause/);
  assert.match(panelBy(doc, /^Agents worth a look/).textContent, /Every agent is OK/);
  assert.match(panelBy(doc, /^What changed/).textContent, /Nothing changed/);
});

