'use strict';

// public/views/home.js — the Overview landing screen on the UI contract
// (docs/ui-contract.md).
//
// The behaviour that must survive: the bare root opens it, the counts come
// from reads the other screens already make, every row links into the record
// that owns it, and — the point — a source that cannot be read takes down its
// own panel and says so instead of showing a reassuring zero.
//
// The screen is now one RANKED queue plus the honest counterpart to it ("what
// we cannot see"), rather than three lists side by side for the reader to
// compare by eye. Two things are therefore load-bearing and tested as such:
// the ordering (home.js exports attentionRows for exactly that), and the
// observed/suspected distinction — a correlated cause presented like a
// measurement is how somebody replaces the wrong switch.

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

// Two per-device cases an operator works, and one cross-agent situation.
const EVENTS = {
  bulkMax: 100,
  bulkAll: true,
  events: [
    {
      id: 21, hostId: 7, title: 'Packet loss on oslo-edge-01', status: 'open', severity: 'CRIT',
      firstEventAt: '2026-09-12T13:30:00.000Z', lastEventAt: '2026-09-12T14:00:00.000Z',
      agentName: 'oslo-edge-01', agentHostname: 'oslo-edge-01', locationName: 'Oslo', clusterId: 11,
    },
    {
      id: 22, hostId: 9, title: 'Interface errors on oslo-2', status: 'investigating', severity: 'WARN',
      firstEventAt: '2026-09-12T12:00:00.000Z', lastEventAt: '2026-09-12T13:00:00.000Z',
      agentName: 'oslo-2', agentHostname: 'oslo-2', locationName: 'Oslo',
    },
    // Closed: never in the queue, however severe it was.
    {
      id: 23, hostId: 9, title: 'Old and dealt with', status: 'closed', severity: 'CRIT',
      firstEventAt: '2026-09-01T12:00:00.000Z', agentName: 'oslo-2', locationName: 'Oslo',
    },
  ],
};
const SITUATIONS = {
  page: { limit: 20, offset: 0, total: 1 },
  clusters: [
    {
      id: 11, status: 'open', confidence: 'medium', suspectedCommonCause: 'Shared uplink at Oslo',
      memberFindingIds: [1, 2, 3], alertMemberCount: 3, alertLastSeverity: 'WARN',
      detectedAt: '2026-09-12T13:20:00.000Z', groupingBasis: {},
    },
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
  'GET /api/events': EVENTS,
  'GET /api/event-clusters': SITUATIONS,
}, over);

const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];
const panelBy = (doc, re) => panels(doc).find((p) => re.test((p.querySelector('h2') || {}).textContent || ''));
const cards = (doc) => [...doc.querySelectorAll('#view .stat-card')].map((c) => c.textContent);

test('the bare root opens the Overview: header with help, the counts, and the queue', async (t) => {
  const { doc, errors, log, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(window.location.pathname, '/overview');
  assert.equal(doc.querySelector('.tabs button.active').dataset.view, 'home');

  for (const call of [
    'GET /api/fleet/health', 'GET /api/troubleshooting/overview', 'GET /api/changes',
    'GET /api/events', 'GET /api/event-clusters',
  ]) {
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

  // ONE queue, carrying all four kinds of row.
  const queue = panelBy(doc, /^Needs attention/);
  assert.ok(queue, panels(doc).map((p) => p.querySelector('h2').textContent).join(' | '));
  assert.match(queue.textContent, /Packet loss on oslo-edge-01/, 'the event case is missing');
  assert.match(queue.textContent, /Shared uplink at Oslo/, 'the situation is missing');
  assert.match(queue.textContent, /Core switch core-sw-1 is down\./, 'the correlated cause is missing');
  assert.match(queue.textContent, /hq-1/, 'the offline agent is missing');
  // A closed case is finished work, not a queue item.
  assert.doesNotMatch(queue.textContent, /Old and dealt with/);

  const gaps = panelBy(doc, /^What we cannot see/);
  assert.match(gaps.textContent, /oslo-edge-01/);
  assert.match(gaps.textContent, /hq-1/);
  assert.doesNotMatch(gaps.textContent, /oslo-2/, 'a healthy agent is not a gap');
  assert.match(gaps.textContent, /unknown, not healthy/i, 'missing data must not read as health');

  const changes = panelBy(doc, /^What changed/);
  assert.match(changes.textContent, /latency degraded at oslo-edge-01/);
  assert.match(changes.textContent, /Critical/);

  assert.doesNotMatch(view.textContent, /home\.(stat|col|queue|basis|gaps|agents|changes|source)\./, 'no raw catalogue key reaches the screen');
  // Nothing failed, so nothing is flagged above the queue and the queue does
  // not say it was built incomplete. The one note on the screen is the gaps
  // panel's own lead, which is there BECAUSE two agents are not reliable.
  assert.equal(queue.querySelector('.inline-note'), null, 'the queue claims a missing source');
  const notes = [...view.querySelectorAll('.inline-note')];
  assert.equal(notes.length, 1, notes.map((n) => n.textContent).join(' | '));
  assert.ok(gaps.contains(notes[0]), 'an unexplained note on a screen where nothing failed');
});

// --- the ordering, as the product decision it is -----------------------------

const { attentionRows } = require('../public/views/home.js');
const AT = (over) => attentionRows(Object.assign({
  situations: [], events: [], causes: [], agents: [], now: Date.parse('2026-09-12T14:00:00.000Z'),
}, over));

test('severity outranks everything else in the queue', () => {
  const rows = AT({
    // An hour-old WARN situation covering nine devices, against a one-minute
    // CRIT on one. Impact, age and breadth all favour the first; severity wins.
    situations: [{ id: 1, alertLastSeverity: 'WARN', suspectedCommonCause: 'wide', alertMemberCount: 9, detectedAt: '2026-09-12T13:00:00.000Z', status: 'open' }],
    events: [{ id: 2, severity: 'CRIT', title: 'narrow', status: 'open', firstEventAt: '2026-09-12T13:59:00.000Z' }],
  });
  assert.deepEqual(rows.map((r) => r.kind), ['event', 'situation']);
});

test('nobody-has-it outranks somebody-is-on-it at the same severity', () => {
  const rows = AT({
    events: [
      { id: 1, severity: 'WARN', title: 'picked up', status: 'investigating', firstEventAt: '2026-09-12T10:00:00.000Z' },
      { id: 2, severity: 'WARN', title: 'untouched', status: 'open', firstEventAt: '2026-09-12T13:50:00.000Z' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.title), ['untouched', 'picked up'], 'a queue that ranks the worked item first is not a queue');
});

test('an observed thing outranks a suspected one, and both say which they are', () => {
  const rows = AT({
    events: [{ id: 1, severity: 'WARN', title: 'measured', status: 'open', firstEventAt: '2026-09-12T13:00:00.000Z' }],
    causes: [{ id: 2, severity: 'WARN', cause: 'theory', affectedDeviceIds: [1], firstSeen: '2026-09-12T13:00:00.000Z' }],
  });
  assert.deepEqual(rows.map((r) => r.basis), ['observed', 'suspected']);
  assert.deepEqual(rows.map((r) => r.title), ['measured', 'theory']);
});

test('age breaks a tie but never climbs over a severity', () => {
  const rows = AT({
    events: [
      { id: 1, severity: 'INFO', title: 'ancient', status: 'open', firstEventAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, severity: 'WARN', title: 'fresh', status: 'open', firstEventAt: '2026-09-12T13:59:00.000Z' },
      { id: 3, severity: 'INFO', title: 'newer', status: 'open', firstEventAt: '2026-09-12T13:00:00.000Z' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.title), ['fresh', 'ancient', 'newer']);
});

test('an offline agent is CRIT and marked as no data, not as a measurement', () => {
  const rows = AT({ agents: [{ agentId: 5, online: false, hostname: 'gw', lastReportAt: '2026-09-11T14:00:00.000Z' }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'CRIT');
  assert.equal(rows[0].basis, 'nodata');
  // An agent that IS reporting is not a queue row; it may still be a gap.
  assert.equal(AT({ agents: [{ agentId: 6, online: true, hostname: 'ok' }] }).length, 0);
});

test('the order is stable across identical reads', () => {
  const src = {
    events: [
      { id: 1, severity: 'WARN', title: 'a', status: 'open', firstEventAt: '2026-09-12T13:00:00.000Z' },
      { id: 2, severity: 'WARN', title: 'b', status: 'open', firstEventAt: '2026-09-12T13:00:00.000Z' },
    ],
    now: Date.parse('2026-09-12T14:00:00.000Z'),
  };
  // Two rows that score the same must not swap places on every 30 s poll.
  assert.deepEqual(attentionRows(src).map((r) => r.id), attentionRows(src).map((r) => r.id));
});

// --- a row opens the record behind it ----------------------------------------

test('an event row opens the event case, and a situation row the situation', async (t) => {
  const { doc, window } = boot({
    t,
    routes: SESSION({
      'GET /api/events/21': { event: { id: 21, title: 'Packet loss on oslo-edge-01', status: 'open', severity: 'CRIT' }, anomalies: [] },
      'GET /api/event-clusters/11': { cluster: SITUATIONS.clusters[0], members: [] },
    }),
  });
  await settle();
  const queue = panelBy(doc, /^Needs attention/);
  const link = [...queue.querySelectorAll('.hostlink')].find((a) => /Packet loss/.test(a.textContent));
  assert.ok(link, 'no link on the event row');
  link.click();
  await settle();
  assert.match(window.location.pathname, /^\/events\/21$/, 'the row did not open its own record');
});

test('a gap row opens the agent', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /agents/7': { id: 7, hostname: 'oslo-edge-01', status: 'online' } }) });
  await settle();
  const link = [...panelBy(doc, /^What we cannot see/).querySelectorAll('.hostlink')][0];
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

// --- a source that cannot be read ------------------------------------------
//
// 404 (the route is not mounted on this deployment) and 500 (it is, and it
// broke) are the two answers the page must survive, and it must survive them
// the same way: the queue says what it was built without, the rest stands.

for (const status of [404, 500]) {
  test(`a source answering ${status} leaves the rest of the screen standing, and the counts it fed read as a dash`, async (t) => {
    const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/fleet/health': { status, body: { error: 'boom' } } }) });
    await settle();
    assert.deepEqual(errors, []);

    const gaps = panelBy(doc, /^What we cannot see/);
    assert.ok(gaps.querySelector('.state.is-error'), 'the fleet panel does not say it failed');
    assert.match(gaps.textContent, /GET \/api\/fleet\/health/, 'the failed call is not named');

    // The queue still ranks what the OTHER four sources know, and says what it
    // is missing rather than looking complete.
    const queue = panelBy(doc, /^Needs attention/);
    assert.match(queue.textContent, /Packet loss on oslo-edge-01/);
    assert.match(queue.querySelector('.inline-note').textContent, /Built without: fleet health/);
    assert.match(panelBy(doc, /^What changed/).textContent, /latency degraded/);

    // Never a reassuring zero for a number nobody could read.
    assert.ok(cards(doc).some((c) => /^—Agents$/.test(c)), cards(doc).join(' | '));
    assert.ok(cards(doc).some((c) => /^—Offline$/.test(c)));
    assert.match(doc.querySelector('#view .inline-note').textContent, /Could not read: fleet health/);
  });
}

test('an empty queue is only an all-clear when every source answered', async (t) => {
  const quiet = {
    'GET /api/fleet/health': { ...FLEET, summary: { ok: 3, warn: 0, bad: 0, down: 0, stale: 0, unknown: 0, offline: 0, total: 3 }, agents: [FLEET.agents[2]] },
    'GET /api/troubleshooting/overview': { ...TSHOOT, summary: { ...TSHOOT.summary, rootCauses: 0, activeFaults: 0 }, rootCauses: [] },
    'GET /api/changes': { ...CHANGES, total: 0, events: [] },
    'GET /api/events': { ...EVENTS, events: [] },
    'GET /api/event-clusters': { ...SITUATIONS, clusters: [] },
  };
  const all = boot({ t, routes: SESSION(quiet) });
  await settle();
  assert.match(panelBy(all.doc, /^Needs attention/).textContent, /Nothing in the queue/);
  assert.match(panelBy(all.doc, /^What we cannot see/).textContent, /Every agent is reporting/);
  assert.match(panelBy(all.doc, /^What changed/).textContent, /Nothing changed/);

  // One source down and nothing found is NOT an all-clear. This is the whole
  // honesty rule on this screen: absence of data never renders as health.
  const partial = boot({
    t,
    routes: SESSION({ ...quiet, 'GET /api/event-clusters': { status: 503, body: { error: 'nope' } } }),
  });
  await settle();
  const queue = panelBy(partial.doc, /^Needs attention/);
  assert.match(queue.textContent, /Nothing we could see/);
  assert.doesNotMatch(queue.textContent, /Nothing in the queue/, 'an unread source must not read as an all-clear');
  assert.equal(queue.querySelector('.state.is-ok'), null, 'a green state over missing data');
});

test('the queue says so when every source behind it is down', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /api/fleet/health': { status: 503, body: { error: 'nope' } },
      'GET /api/troubleshooting/overview': { status: 503, body: { error: 'nope' } },
      'GET /api/events': { status: 503, body: { error: 'nope' } },
      'GET /api/event-clusters': { status: 503, body: { error: 'nope' } },
    }),
  });
  await settle();
  const queue = panelBy(doc, /^Needs attention/);
  assert.ok(queue.querySelector('.state.is-error'), 'an empty queue over four dead sources');
  assert.doesNotMatch(queue.textContent, /Nothing in the queue/);
});
