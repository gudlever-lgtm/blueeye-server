'use strict';

// public/views/troubleshooting.js — Troubleshooting on the UI contract
// (docs/ui-contract.md).
//
// Four zones: the key figures, the topology, the correlated root causes and the
// timeline. These tests hold what had to survive the migration: the fault list
// stays OPT-IN and paged (a fleet can carry tens of thousands of raw alarms,
// and paying for them to paint the screen is what made this tab slow), a cause
// keeps all three of its actions while showing one, and a partial read costs a
// panel rather than the screen.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const OVERVIEW = {
  summary: { activeFaults: 240, affectedDevices: 6, devicesDown: 2, devicesUnreachable: 4, rootCauses: 2 },
  topology: {
    nodes: [
      { id: 7, label: 'sw-core-01', state: 'down', lastSeen: '2026-09-12T13:40:00.000Z' },
      { id: 8, label: 'sw-acc-a', state: 'unreachable_downstream', lastSeen: '2026-09-12T13:41:00.000Z' },
      { id: 9, label: 'sw-acc-b', state: 'ok', lastSeen: '2026-09-12T14:00:00.000Z' },
    ],
    links: [{ from: 7, to: 8, layer: 'l2' }, { from: 7, to: 9, layer: 'l3' }],
    counts: { ok: 1, down: 1, unreachable_downstream: 1 },
    layers: { l2: 1, l3: 1 },
    discovered: ['10.0.9.4'],
  },
  rootCauses: [
    {
      id: 11, severity: 'CRIT', cause: 'sw-core-01 stopped answering', confidence: 'high',
      affectedDeviceIds: [8, 9], blastRadiusCount: 4, primaryDeviceId: 7,
      firstSeen: '2026-09-12T13:40:00.000Z',
    },
    {
      id: 12, severity: 'WARN', cause: 'Egress discards rising on Gi0/1',
      affectedDeviceIds: [9], primaryDeviceId: null, firstSeen: '2026-09-12T12:10:00.000Z',
    },
  ],
  anomalies: [{ linkId: 'oslo→cph', currentVsBaselinePct: 240, since: '2026-09-12T12:00:00.000Z' }],
  timeline: [
    { timestamp: '2026-09-12T13:20:00.000Z', severity: 'INFO', summary: 'config pushed to sw-core-01', type: 'topology.config_pushed' },
    { timestamp: '2026-09-12T13:40:00.000Z', severity: 'CRIT', summary: 'sw-core-01 went down', type: 'agent.disconnected' },
  ],
};
const FAULT_PAGE_1 = {
  total: 240,
  faults: Array.from({ length: 100 }, (_, i) => ({
    id: i + 1, severity: i % 2 ? 'WARN' : 'CRIT', agentId: 7, metric: 'probe.loss',
    createdAt: '2026-09-12T13:45:00.000Z', cause: 'sw-core-01 stopped answering',
  })),
};

function boot({ t, routes = {}, url = 'http://server.test/troubleshooting', role = 'operator' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 180));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/troubleshooting/overview': OVERVIEW,
  'GET /api/troubleshooting/faults': FAULT_PAGE_1,
  'GET /api/topology/blast-radius/7': {
    directly_isolated: [{ path: [{ hostId: 8 }] }],
    dependency_affected: [{ path: [{ hostId: 8 }, { hostId: 9 }] }],
  },
}, over);

const cards = (doc) => [...doc.querySelectorAll('#view .statstrip .stat-card')];
const causes = (doc) => [...doc.querySelectorAll('#view .ts-cause')];
const faultRows = (doc) => {
  const panel = [...doc.querySelectorAll('#view .panel-ui')].find((p) => /Active faults/.test(p.textContent));
  return panel ? [...panel.querySelectorAll('table.dt tbody tr')] : [];
};

test('Troubleshooting is a DashboardPage: PageHeader, Toolbar, StatStrip, Panels', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .kpi-grid').length, 0, 'the legacy KPI grid survived');
  assert.equal(doc.querySelectorAll('#view .ts-split').length, 0, 'the two-column split survived');
  assert.equal(doc.querySelectorAll('#view .ts-panel-head').length, 0, 'the old panel heads survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0);
  assert.equal(cards(doc).length, 4);
  assert.equal(causes(doc).length, 2);
});

const topoPanel = (doc) => [...doc.querySelectorAll('#view .panel-ui')]
  .find((p) => /Topology/i.test(p.querySelector('.panel-head') ? p.querySelector('.panel-head').textContent : ''));

test('the list is a tab on the screen, with an address of its own', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(topoPanel(doc).querySelector('svg'), 'the graph is not what /troubleshooting opens');

  const entry = doc.querySelector('#view .subtabs button[data-tab="list"]');
  assert.ok(entry, 'no list tab on the screen');
  entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();

  const panel = topoPanel(doc);
  assert.equal(panel.querySelectorAll('svg').length, 0, 'the graph is still laid out off screen');
  assert.ok([...panel.querySelectorAll('table.dt thead th')].length, 'no table on the list screen');
  // A screen of its own has an address of its own, or it cannot be linked to
  // and a reload lands somewhere else.
  assert.equal(window.location.pathname, '/troubleshooting/list');
});

test('/troubleshooting/list opens in the table, so the link and the reload hold', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), url: 'http://server.test/troubleshooting/list' });
  await settle();
  const panel = topoPanel(doc);
  assert.equal(panel.querySelectorAll('svg').length, 0, 'the address drew the graph');
  assert.ok([...panel.querySelectorAll('table.dt thead th')].length, 'the address drew no table');
});

test('the lens lives on the page, not in the topbar and not twice in the rail', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const slot = doc.querySelector('#topbar-mode');
  assert.ok(slot, 'the topbar lost its mode slot');
  assert.equal(slot.children.length, 0, 'Troubleshooting still fills the topbar mode slot');
  assert.equal(doc.querySelectorAll('#view .mode-switch').length, 0, 'the switch is in the page');

  const rail = [...doc.querySelectorAll('.tabs button[data-view="troubleshooting"]')];
  assert.equal(rail.length, 1, 'the rail names Troubleshooting more than once');

  const tabs = [...doc.querySelectorAll('#view .subtabs button')].map((b) => b.dataset.tab);
  assert.deepEqual(tabs, ['graph', 'list'], `the strip does not carry both: ${tabs.join(', ')}`);
});

test('the fault list is opt-in: nothing is fetched until the card is clicked', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(log.filter((x) => x.key === 'GET /api/troubleshooting/faults').length, 0,
    'the raw alarms were fetched to paint the page');
  assert.equal(faultRows(doc).length, 0);

  const faultsCard = cards(doc).find((c) => /Active faults/i.test(c.textContent));
  assert.ok(faultsCard, 'no Active faults card');
  faultsCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const req = log.filter((x) => x.key === 'GET /api/troubleshooting/faults');
  assert.equal(req.length, 1, 'the list did not load on demand');
  assert.match(req[0].url, /limit=100&offset=0/);
  assert.equal(faultRows(doc).length, 100);
  // The strip is rebuilt when the list opens, so the card is a new element.
  assert.equal(cards(doc).find((c) => /Active faults/i.test(c.textContent)).getAttribute('aria-pressed'), 'true');
});

test('the fault list pages in, and says how far it has got', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  cards(doc).find((c) => /Active faults/i.test(c.textContent)).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const panel = [...doc.querySelectorAll('#view .panel-ui')].find((p) => /Active faults/.test(p.textContent));
  assert.match(panel.querySelector('.panel-head .meta-xs').textContent, /100 of 240/);
  const more = panel.querySelector('.panel-foot .btn');
  assert.ok(more, 'no way to load the next page');
  assert.match(more.textContent, /100/);
  more.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const req = log.filter((x) => x.key === 'GET /api/troubleshooting/faults');
  assert.equal(req.length, 2);
  assert.match(req[1].url, /offset=100/, 'paging re-read from the start');
});

test('hiding the list again puts the card back to a doorway', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const card = cards(doc).find((c) => /Active faults/i.test(c.textContent));
  card.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(faultRows(doc).length);
  cards(doc).find((c) => /Active faults/i.test(c.textContent)).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(faultRows(doc).length, 0, 'the list stayed open');
});

test('a root cause shows ONE action and keeps the other two behind the menu', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const first = causes(doc)[0];
  const shown = [...first.querySelectorAll('.row-act > button')];
  // One visible action plus the ⋯ trigger.
  assert.equal(shown.length, 2);
  assert.match(shown[0].textContent, /Show path/i);
  assert.equal(doc.querySelectorAll('#view .ts-cause-actions').length, 0, 'the three-button row survived');

  shown[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const menu = doc.querySelector('.ui-rowmenu');
  assert.ok(menu, 'no ⋯ menu');
  const labels = [...menu.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(labels.some((l) => /What changed/i.test(l)));
  assert.ok(labels.some((l) => /Open situation/i.test(l)));
});

test('a cause with no anchor cannot show a path, and says so by omission', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // The second cause has primaryDeviceId: null.
  const second = causes(doc)[1];
  const shown = [...second.querySelectorAll('.row-act > button')];
  assert.equal(shown.length, 1, 'a path was offered with nothing to walk from');
  assert.match(shown[0].getAttribute('aria-label') || '', /more/i);
});

test('"Show path" highlights the blast radius and offers a way back', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const btn = [...causes(doc)[0].querySelectorAll('.row-act > button')][0];
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/topology/blast-radius/7'), 'the radius was not asked for');
  const slot = causes(doc)[0].querySelector('.ts-cause-slot');
  assert.match(slot.textContent, /2 host/i);
  assert.ok([...slot.querySelectorAll('.btn')].some((b) => /Clear/i.test(b.textContent)));
});

test('"What changed?" lists the changes before the fault, or says there were none', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const menuBtn = [...causes(doc)[0].querySelectorAll('.row-act > button')][1];
  menuBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const item = [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => /What changed/i.test(b.textContent));
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const slot = causes(doc)[0].querySelector('.ts-cause-slot');
  assert.ok(slot.textContent.length, 'nothing was said about what changed');
});

test('a partial read is an inline note, and the rest of the page still renders', async (t) => {
  const partial = Object.assign({}, OVERVIEW, { partial: true, failedSources: ['flows', 'topology'] });
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/troubleshooting/overview': partial }) });
  await settle();
  const note = doc.querySelector('#view .inline-note.is-warn');
  assert.ok(note, 'the partial-data warning disappeared');
  assert.match(note.textContent, /flows, topology/);
  assert.equal(cards(doc).length, 4, 'a partial read cost the whole page');
  assert.equal(causes(doc).length, 2);
});

test('a 500 on the overview is an ErrorState with the shell and the header intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/troubleshooting/overview': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/troubleshooting\/overview/);
  assert.ok(doc.querySelector('#view .page-head h1'));
  assert.ok(doc.querySelector('.sidebar'));
});

test('a 500 on the fault page is its own ErrorState — the overview stays up', async (t) => {
  const { doc, window, errors } = boot({ t, routes: SESSION({ 'GET /api/troubleshooting/faults': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  cards(doc).find((c) => /Active faults/i.test(c.textContent)).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState for the fault page');
  assert.match(err.textContent, /GET \/api\/troubleshooting\/faults/);
  assert.equal(causes(doc).length, 2, 'the overview went down with the fault list');
});

test('changing the window refetches and drops the held fault pages', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  cards(doc).find((c) => /Active faults/i.test(c.textContent)).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(faultRows(doc).length, 100);

  const sel = doc.querySelector('#view .toolbar-ui select');
  sel.value = '360';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const overviews = log.filter((x) => x.key === 'GET /api/troubleshooting/overview');
  assert.match(overviews[overviews.length - 1].url, /minutes=360/);
  // The list was open, so page 1 of the NEW set is fetched — not the old rows.
  const faultReqs = log.filter((x) => x.key === 'GET /api/troubleshooting/faults');
  assert.match(faultReqs[faultReqs.length - 1].url, /offset=0/, 'the stale pages were kept');
});

test('the timeline brush selects a window and can be cleared', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const panel = [...doc.querySelectorAll('#view .panel-ui')].find((p) => /Timeline/.test(p.textContent));
  assert.ok(panel, 'no timeline panel');
  assert.ok(panel.querySelector('svg.ts-brush'), 'the brush is gone');
  assert.equal(panel.querySelectorAll('.ts-marker').length, 2, 'the events are not on the brush');
  assert.match(panel.querySelector('.ts-events-head').textContent, /2 event/);
});

test('an empty timeline is an EmptyState, not an empty brush', async (t) => {
  const quiet = Object.assign({}, OVERVIEW, { timeline: [] });
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/troubleshooting/overview': quiet }) });
  await settle();
  const panel = [...doc.querySelectorAll('#view .panel-ui')].find((p) => /Timeline/.test(p.textContent));
  assert.ok(panel.querySelector('.state'), 'no EmptyState');
  assert.equal(panel.querySelectorAll('svg.ts-brush').length, 0);
});

// --- single-host faults: a root cause from an open event case ----------------
// A site with one agent never forms a cross-agent situation, so its faults
// arrive as causes built from its open event cases. The row has to say so and
// open the EVENT (its id is a case id, not a cluster id), and a switch with an
// open port fault is degraded on the map, not green.
const CASE_OVERVIEW = {
  summary: { activeFaults: 4, affectedDevices: 3, devicesDown: 0, devicesUnreachable: 0, devicesDegraded: 3, rootCauses: 1, anomalies: 0 },
  topology: {
    nodes: [
      { id: 1, label: 'vv-agent', kind: 'agent', state: 'degraded', lastSeen: '2026-09-24T11:59:00.000Z' },
      { id: 'd:1', label: 'sw-core', kind: 'device', state: 'degraded', lastSeen: '2026-09-24T11:59:00.000Z' },
      { id: 'd:2', label: 'sw-pump', kind: 'device', state: 'degraded', lastSeen: '2026-09-24T11:59:00.000Z' },
    ],
    links: [{ source: 1, target: 'd:1', layer: 'l2', state: 'degraded' }, { source: 'd:1', target: 'd:2', layer: 'l2', state: 'degraded' }],
    counts: { ok: 0, down: 0, unreachable_downstream: 0, degraded: 3 },
    layers: { l2: 2, l3: 0 },
    discovered: [],
  },
  rootCauses: [{
    id: 'case:5', source: 'case', caseId: 5, clusterId: null, severity: 'CRIT',
    cause: 'Port Gi0/1 on sw-core went down (SNMP poll).', affectedDeviceIds: [1, 'd:1', 'd:2'],
    blastRadiusCount: 0, primaryDeviceId: 'd:1', memberCount: 4, status: 'open',
    firstSeen: '2026-09-24T11:10:00.000Z', lastSeen: '2026-09-24T11:55:00.000Z',
  }],
  anomalies: [],
  timeline: [],
  restricted: [],
};
const CASE_FAULTS = {
  total: 1,
  faults: [{
    findingId: 'f-down', source: 'case', caseId: 5, clusterId: null, severity: 'CRIT', hostId: '1',
    metric: 'if.11.link.down', createdAt: '2026-09-24T11:10:00.000Z', cause: 'Port Gi0/1 on sw-core went down (SNMP poll).',
  }],
};

test('a single-host case renders as a root cause that says so and opens its event', async (t) => {
  const { doc, window, log, errors } = boot({ t, routes: SESSION({
    'GET /api/troubleshooting/overview': CASE_OVERVIEW,
    'GET /api/events/5': { id: 5, title: 'CRIT if.11.link.down on vv-agent', status: 'open', severity: 'CRIT', anomalies: [] },
  }) });
  await settle();
  assert.deepEqual(errors, []);
  const [cause] = causes(doc);
  assert.ok(cause, 'the case did not render as a cause');
  assert.equal(cause.getAttribute('data-source'), 'case');
  assert.match(cause.textContent, /Port Gi0\/1 on sw-core went down/);
  assert.match(cause.textContent, /Event #5 · one host/);
  // The KPI strip is not the "nothing is broken" strip any more.
  assert.match(cards(doc).find((c) => /Active faults/i.test(c.textContent)).textContent, /4/);
  assert.match(cards(doc).find((c) => /Root causes/i.test(c.textContent)).textContent, /1/);

  // The ⋯ menu offers the EVENT, not a situation that does not exist.
  const shown = [...cause.querySelectorAll('.row-act > button')];
  shown[shown.length - 1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const labels = [...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent);
  assert.ok(labels.some((l) => /Open event/i.test(l)), `menu: ${labels.join(', ')}`);
  assert.ok(!labels.some((l) => /Open situation/i.test(l)), 'a case cause offered to open a situation');

  // The inline link opens the event page for case 5.
  const link = cause.querySelector('.ts-cause-case a.hostlink');
  assert.ok(link, 'the event reference is not a link');
  link.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/events/5'), 'the event page was not opened');
  assert.ok(!log.some((x) => /\/api\/event-clusters\/5/.test(x.url)), 'the case id was sent to the situation API');
});

test('a degraded switch is drawn and listed as degraded, in the catalogue\'s words', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/troubleshooting/overview': CASE_OVERVIEW }) });
  await settle();
  assert.equal(doc.querySelectorAll('#view .ts-node.ts-degraded').length, 3, 'degraded nodes drawn as another state');
  assert.equal(doc.querySelectorAll('#view .ts-node.ts-ok').length, 0);
  const legend = doc.querySelector('#view .site-legend');
  assert.match(legend.textContent, /Degraded \(3\)/);
});

test('fault rows from a case link to that event', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION({
    'GET /api/troubleshooting/overview': CASE_OVERVIEW,
    'GET /api/troubleshooting/faults': CASE_FAULTS,
    'GET /api/events/5': { id: 5, title: 'x', status: 'open', severity: 'CRIT', anomalies: [] },
  }) });
  await settle();
  cards(doc).find((c) => /Active faults/i.test(c.textContent)).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const [row] = faultRows(doc);
  assert.ok(row, 'no fault row');
  assert.match(row.textContent, /event #5/);
  const link = [...row.querySelectorAll('button, a')].find((x) => /event #5/.test(x.textContent));
  assert.ok(link, 'the event reference is not a link');
  link.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/events/5'));
});

// --- the strip: four cards, four destinations -------------------------------
// Three of these were figures drawn as buttons. Pressing "Affected devices" did
// nothing at all, which reads as a broken screen rather than as a number.
test('every card on the strip is either a control or plainly not one', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /api/troubleshooting/overview': { ...OVERVIEW, summary: { ...OVERVIEW.summary, anomalies: 1 } },
    }),
  });
  await settle();
  const live = cards(doc).filter((c) => !c.classList.contains('is-static'));
  // Active faults, Affected devices, Root causes — the three with a figure in
  // this fixture. Baseline deviations has one row, so it is live too.
  assert.equal(live.length, 4, 'a card with a figure was left dead');
  for (const c of live) {
    assert.equal(c.disabled, false, `${c.textContent} is a control that cannot be pressed`);
    assert.ok(c.getAttribute('title'), `${c.textContent} does not say where it goes`);
  }
});

test('a card with nothing behind it is disabled rather than a button that does nothing', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /api/troubleshooting/overview': {
        ...OVERVIEW,
        summary: { activeFaults: 0, affectedDevices: 0, devicesDown: 0, devicesUnreachable: 0, rootCauses: 0 },
        rootCauses: [], anomalies: [],
      },
    }),
  });
  await settle();
  const live = cards(doc).filter((c) => !c.classList.contains('is-static'));
  assert.equal(live.length, 0, 'an empty figure still looks pressable');
  for (const c of cards(doc)) assert.equal(c.disabled, true);
});

test('the deviations are their own zone, so the card that counts them can reach them', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const panels = [...doc.querySelectorAll('#view .panel-ui')].map((p) => p.textContent);
  assert.ok(panels.some((x) => /deviation/i.test(x)), 'the deviations panel is gone');
});

// --- mark seen --------------------------------------------------------------
test('a root cause can be marked seen, and the screen re-reads afterwards', async (t) => {
  const { doc, window, log } = boot({
    t,
    routes: SESSION({ 'POST /api/troubleshooting/ack': { source: 'cluster', id: 11, findings: 4, acked: 4, cluster: true } }),
  });
  await settle();
  const menu = causes(doc)[0].querySelector('.row-act > button:last-child');
  menu.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const item = [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => /Mark seen/i.test(b.textContent));
  assert.ok(item, 'no "Mark seen" on a root cause');
  item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();

  const posts = log.filter((x) => x.key === 'POST /api/troubleshooting/ack');
  assert.equal(posts.length, 1, 'marking seen did not reach the server');
  // The figures at the top are what was just changed, so the page re-reads.
  assert.ok(log.filter((x) => x.key === 'GET /api/troubleshooting/overview').length >= 2,
    'the screen kept showing the figures it had just changed');
});

test('a viewer is not offered "Mark seen"', async (t) => {
  const { doc, window } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  const menu = causes(doc)[0].querySelector('.row-act > button:last-child');
  menu.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const item = [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => /Mark seen/i.test(b.textContent));
  assert.equal(item, undefined, 'a viewer was offered a write they cannot do');
});

test('the fault list marks the ticked alarms seen in one request', async (t) => {
  const page = {
    total: 2,
    faults: [
      { findingId: 'f-1', severity: 'CRIT', hostId: 7, metric: 'probe.loss', createdAt: '2026-09-12T13:45:00.000Z', cause: 'sw-core-01 stopped answering' },
      { findingId: 'f-2', severity: 'WARN', hostId: 7, metric: 'probe.rtt', createdAt: '2026-09-12T13:46:00.000Z', cause: 'sw-core-01 stopped answering' },
    ],
  };
  const { doc, window, log } = boot({
    t,
    routes: SESSION({
      'GET /api/troubleshooting/faults': page,
      'POST /api/findings/ack': { acked: 2, requested: 2 },
    }),
  });
  await settle();
  cards(doc).find((c) => /Active faults/i.test(c.textContent)).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  const boxes = faultRows(doc).map((tr) => tr.querySelector('input.dt-check')).filter(Boolean);
  assert.equal(boxes.length, 2, 'the rows carry no way to pick them');
  for (const b of boxes) { b.checked = true; b.dispatchEvent(new window.Event('change', { bubbles: true })); }
  await settle();

  const go = [...doc.querySelectorAll('#view .panel-ui .btn')].find((b) => /Mark 2 seen/i.test(b.textContent));
  assert.ok(go, 'no bulk action once rows are picked');
  go.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(log.filter((x) => x.key === 'POST /api/findings/ack').length, 1);
});
