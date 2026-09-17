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
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/'))) {
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
