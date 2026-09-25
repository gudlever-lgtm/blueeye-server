'use strict';

// public/views/events.js — Events on the UI contract (docs/ui-contract.md).
//
// The filters were a row of controls INSIDE the table header, one per column —
// the only table in the app that did it. They are a Toolbar now, which is where
// the contract puts filters and where Analysis's went when it migrated. These
// tests hold what had to survive: status/severity/device still narrow the QUERY
// and location still narrows what came back, and a row still opens the event.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const EVENTS = [
  { id: 11, severity: 'CRIT', status: 'open', title: 'CRIT loss on oslo-edge-01 (Oslo)', hostId: 7, agentName: 'oslo-edge-01', locationName: 'Oslo', firstEventAt: '2026-09-12T13:40:00.000Z', lastEventAt: '2026-09-12T14:02:00.000Z' },
  { id: 12, severity: 'WARN', status: 'investigating', title: 'WARN latency on cph-core-02 (Copenhagen)', hostId: 8, agentName: 'cph-core-02', locationName: 'Copenhagen', firstEventAt: '2026-09-12T11:20:00.000Z', lastEventAt: '2026-09-12T12:00:00.000Z' },
  { id: 13, severity: 'INFO', status: 'resolved', title: 'INFO jitter on sto-branch-07 (Stockholm)', hostId: 9, agentName: 'sto-branch-07', locationName: 'Stockholm', firstEventAt: '2026-09-11T22:05:00.000Z', lastEventAt: '2026-09-11T23:00:00.000Z' },
  { id: 14, severity: 'WARN', status: 'closed', title: 'WARN discards on ber-edge-03 (Berlin)', hostId: 10, agentName: 'ber-edge-03', locationName: 'Berlin', firstEventAt: '2026-09-10T09:00:00.000Z', lastEventAt: '2026-09-10T10:00:00.000Z' },
];

function boot({ t, routes = {}, url = 'http://server.test/events', role = 'operator' } = {}) {
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
  'GET /api/events': { events: EVENTS },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];
const cards = (doc) => [...doc.querySelectorAll('#view .statstrip .stat-card')];
const control = (doc, label) => [...doc.querySelectorAll('#view .toolbar-ui select, #view .toolbar-ui input')]
  .find((c) => (c.getAttribute('aria-label') || '') === label);


// Column lookup BY HEADER, not by position. These used to index children[2]
// and cols[0], which meant adding a column anywhere to the left silently
// re-pointed every assertion at the wrong data. The selection checkbox is
// exactly such a column.
function colIndex(doc, label) {
  const ths = [...doc.querySelectorAll('#view table.dt thead th')];
  const i = ths.findIndex((th) => new RegExp('^' + label).test(th.textContent.trim()));
  if (i < 0) throw new Error(`no column headed "${label}" — headers: ${ths.map((x) => x.textContent.trim()).join(' | ')}`);
  return i;
}
const cellIn = (row, doc, label) => row.children[colIndex(doc, label)];
const colWidth = (doc, label) => parseInt(
  [...doc.querySelectorAll('#view table.dt colgroup col')][colIndex(doc, label)].style.width, 10,
);

test('Events is a ListPage: PageHeader, StatStrip, Toolbar, DataTable', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .col-filter').length, 0, 'the in-header filters survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old section head survived');
  assert.equal(doc.querySelectorAll('#view thead select').length, 0, 'a filter is still inside the table head');
  assert.equal(cards(doc).length, 4);
  assert.equal(rows(doc).length, 4);
  // Clear is there from the start, disabled until there is something to clear.
  const clear = [...doc.querySelectorAll('#view .toolbar-right .btn')].find((b) => /Clear/i.test(b.textContent));
  assert.ok(clear && clear.disabled, 'Clear is offered with nothing to clear');
});

test('the strip counts by status and filters on a click', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(cards(doc).map((c) => c.querySelector('.stat-n').textContent), ['1', '1', '1', '1']);
  const open = cards(doc).find((c) => /Open/.test(c.textContent));
  open.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  // Status is a SERVER filter: the click reloads rather than hiding rows.
  const last = log.filter((x) => x.key === 'GET /api/events').pop();
  assert.match(last.url, /status=open/);
  assert.equal(control(doc, 'Status').value, 'open', 'the toolbar did not follow the card');
});

test('status, severity and device narrow the query; location narrows the rows', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const sev = control(doc, 'Severity');
  sev.value = 'WARN';
  sev.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/events').pop().url, /severity=WARN/);

  const dev = control(doc, 'Agent id…');
  dev.value = 'oslo';
  dev.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/events').pop().url, /device=oslo/);

  // Location is NOT a server filter — the server keys events by device.
  const before = log.filter((x) => x.key === 'GET /api/events').length;
  const loc = control(doc, 'Location…');
  loc.value = 'copenhagen';
  loc.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle();
  assert.equal(log.filter((x) => x.key === 'GET /api/events').length, before, 'location hit the server');
  assert.equal(rows(doc).length, 1);
  assert.match(rows(doc)[0].textContent, /cph-core-02/);
});

test('clearing the filters brings everything back', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const loc = control(doc, 'Location…');
  loc.value = 'oslo';
  loc.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 1);
  const clear = [...doc.querySelectorAll('#view .toolbar-right .btn')].find((b) => /Clear/i.test(b.textContent));
  assert.ok(clear, 'no way to clear the filters');
  assert.ok(!clear.disabled, 'Clear stayed disabled with a filter set');
  clear.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 4);
});

test('the table sorts from its header, newest activity first by default', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.match(rows(doc)[0].textContent, /oslo-edge-01/);
  const header = [...doc.querySelectorAll('#view table.dt thead th')].find((th) => /^Severity/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const sevs = rows(doc).map((r) => r.querySelector('.badge-ui').textContent);
  assert.deepEqual(sevs, ['CRIT', 'WARN', 'WARN', 'INFO']);
  // The severity column has to fit the longest badge; at 92px "WARN" clipped.
  assert.ok(colWidth(doc, 'Severity') >= 104, `severity column is ${colWidth(doc, 'Severity')}px`);
});

test('the condition column drops what the other columns already say', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const cell = cellIn(rows(doc)[0], doc, 'Condition');
  // The stored title repeats severity, device and site; those are columns.
  assert.ok(!/oslo-edge-01/.test(cell.textContent), `condition still repeats the device: ${cell.textContent}`);
  // …and the full title is still the tooltip.
  assert.match(cell.querySelector('span').getAttribute('title'), /CRIT loss on oslo-edge-01/);
});

test('the Guide button is the row action, not a pill in a cell', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(doc.querySelectorAll('#view .guide-pill').length, 0, 'the pill survived');
  const act = rows(doc)[0].querySelector('.row-act > button');
  assert.ok(act, 'no row action');
  assert.match(act.textContent, /Guide/);
  act.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/events/11', 'the guide did not open the event');
});

test('a viewer reads the list and is offered no guide', async (t) => {
  const { doc } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 1, email: 'x@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(rows(doc).length, 4, 'a viewer cannot read the events');
  assert.equal(doc.querySelectorAll('#view .row-act').length, 0, 'a viewer was offered the guide');
});

test('a row opens the event', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  rows(doc)[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/events/12');
});

test('an empty list reads differently from a filter that matched nothing', async (t) => {
  const none = boot({ t, routes: SESSION({ 'GET /api/events': { events: [] } }) });
  await settle();
  assert.match(none.doc.querySelector('#view .state').textContent, /No events yet/i);
});

test('a 500 is an ErrorState with the shell and the header intact', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/events': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/events/);
  assert.ok(doc.querySelector('#view .page-head h1'));
  assert.ok(doc.querySelector('.sidebar'));
});

test('a row that is part of a situation says so, and the link opens the situation (migration 129)', async (t) => {
  const withCluster = EVENTS.map((e) => (e.id === 11 ? { ...e, clusterId: 5 } : e));
  const { doc, window } = boot({ t, routes: SESSION({
    'GET /api/events': { events: withCluster },
    'GET /api/event-clusters/5': { cluster: { id: 5, status: 'open', confidence: 'high', suspectedRootCause: { classification: 'network-layer' }, affectedAgents: ['7', '8'], members: [], eventCases: [] } },
  }) });
  await settle();
  const links = [...doc.querySelectorAll('#view table.dt tbody .hostlink')].filter((a) => /situation #5/.test(a.textContent));
  assert.equal(links.length, 1, 'exactly the clustered row carries the situation link');
  links[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(window.location.pathname, /5/);
  assert.doesNotMatch(window.location.pathname, /^\/events$/);
});

// ---- bulk actions: the cap, and the way past it -----------------------------
// The cap is a bound on the request's WORK, not a guess at what an operator
// might select — so the page has to know it BEFORE the click. It used to find
// out by being refused: 989 selected against a cap of 500, and a 400 after the
// fact. The list reports the policy, and the page draws it.

const tick = (doc, i) => [...doc.querySelectorAll('#view table.dt tbody input[type=checkbox]')][i];
const bulkBtn = (doc, re) => [...doc.querySelectorAll('#view .panel-ui .toolbar-ui .btn')]
  .find((b) => re.test(b.textContent));

test('a selection over the cap disables the id buttons and says what to do instead', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({
    'GET /api/events': { events: EVENTS, bulkMax: 1, bulkAll: true },
  }) });
  await settle();
  // Two OPEN-or-investigating rows is already over a cap of 1. Pick the two
  // that share a status so the bar offers a single next step.
  const boxes = [...doc.querySelectorAll('#view table.dt tbody input[type=checkbox]')];
  boxes[0].click();
  boxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.ok(bulkBtn(doc, /Mark 1 as/), 'one selected is under the cap and offered');

  tick(doc, 1).click();
  tick(doc, 1).dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const note = [...doc.querySelectorAll('#view .inline-note')].map((n) => n.textContent).join(' ');
  assert.match(note, /at most 1 events/);
});

test('"all matching" is offered with a status filter, and POSTs the filter — not 989 ids', async (t) => {
  const posted = [];
  const { doc, window, log } = boot({ t, routes: SESSION({
    'GET /api/events': { events: EVENTS, bulkMax: 500, bulkAll: true },
    'POST /api/events/bulk-status': { moved: 1000, all: true },
  }) });
  const realFetch = window.fetch;
  window.fetch = async (u, opts = {}) => {
    if (String(u).indexOf('bulk-status') !== -1) posted.push(JSON.parse(opts.body));
    return realFetch(u, opts);
  };
  window.confirm = () => true;
  await settle();

  // Without a status filter there is no single next step for "everything
  // matching", so the action is not offered.
  tick(doc, 0).click();
  tick(doc, 0).dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.ok(!bulkBtn(doc, /all matching/i), 'offered with a mixed-status scope');

  // Filter to one status, select, and it appears.
  const sel = control(doc, 'Status');
  sel.value = 'open';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  // The selection survives the reload (the row is still on screen), so the bar
  // is still up — what changed is that the scope now has ONE next step.
  // One button per legal next step, same as the id form: an open event can be
  // picked up (investigating) or dismissed (resolved).
  const allBtns = [...doc.querySelectorAll('#view .panel-ui .toolbar-ui .btn')]
    .filter((b) => /all matching/i.test(b.textContent));
  assert.equal(allBtns.length, 2, 'no "all matching" action with a single-status filter');
  const all = allBtns.find((b) => /resolved/i.test(b.textContent));

  all.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].all, true);
  assert.equal(posted[0].status, 'resolved');
  assert.equal(posted[0].filters.status, 'open');
  assert.ok(!posted[0].ids, 'the filter form still sent ids');
  assert.ok(log.length > 0);
});
