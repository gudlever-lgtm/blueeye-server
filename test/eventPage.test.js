'use strict';

// public/views/event.js — one event, as a DetailPage (template D)
// (docs/ui-contract.md).
//
// The migration this pins: the heading with its run of `·` separators becomes a
// PageHeader with the severity beside the title, the status transitions become
// one primary, two more severity vocabularies join the app's one, and the
// record's page finally marks itself in the rail.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const EVENT = (over = {}) => ({
  event: Object.assign({
    id: 11, title: 'CRIT packet loss on oslo-edge-01', severity: 'CRIT', status: 'open',
    hostId: 7, agentName: 'oslo-edge-01', locationName: 'Oslo HQ',
    firstEventAt: '2026-09-17T13:40:00.000Z', lastEventAt: '2026-09-17T14:02:00.000Z',
  }, over),
  anomalies: [
    { severity: 'CRIT', metric: 'packet_loss', explanation: '14.2% against a 0.3% baseline', createdAt: '2026-09-17T13:40:00.000Z', target: '8.8.8.8' },
    { severity: 'WARN', metric: 'rtt_ms', explanation: '82 ms against a 21 ms baseline', createdAt: '2026-09-17T13:41:00.000Z' },
  ],
});

function boot({ t, routes = {}, url = 'http://server.test/events/11', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u), body: opts.body });
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.prompt = () => 'because the fault came back';
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
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [{ id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' }],
  'GET /api/events/11': EVENT(),
  'GET /api/events/11/timeline': { events: [] },
  'GET /api/events/11/similar': { similar: [] },
  'GET /api/events/11/notes': { notes: [], ruledOut: [] },
  'GET /api/events/11/config-context': { configChangeId: null },
}, over);

const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];
const panelTitles = (doc) => [...doc.querySelectorAll('#view .panel-ui > .panel-head h2')].map((h) => h.textContent);

test('the event is a DetailPage with its severity beside the title', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  const h1 = doc.querySelector('#view .page-head h1');
  assert.match(h1.textContent, /CRIT packet loss on oslo-edge-01/);
  // Template D's status slot: the record's state sits beside its name.
  assert.ok(h1.querySelector('.badge-ui'), 'the severity is not on the title');
  assert.ok(h1.querySelector('.badge-ui').classList.contains('crit'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .inc-header, #view .inc-actions').length, 0,
    'the old heading block survived');
});

test('the where is the lead, and the agent is a link', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /agents/7': { id: 7 } }) });
  await settle();
  const lead = doc.querySelector('#view .page-head p');
  assert.match(lead.textContent, /Oslo HQ/);
  assert.match(lead.textContent, /opened/);
  const link = lead.querySelector('.hostlink');
  assert.ok(link, 'the agent is not a link — an event with only an id in its title is unplaceable');
  link.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/agents/7');
});

test('both moves from open are offered, and only one of them is primary', async (t) => {
  // `open` has two: pick it up (investigating) or dismiss it (resolved), since
  // most events are read and closed in one go. At most one primary in a page
  // header, so the last is primary and the rest secondary.
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const labels = headBtns(doc).map((b) => b.textContent);
  assert.ok(labels.some((l) => /Investigating/.test(l)), `no investigating move — ${labels.join(', ')}`);
  assert.ok(labels.some((l) => /Resolved/.test(l)), `no resolved move — ${labels.join(', ')}`);

  const primaries = headBtns(doc).filter((b) => b.classList.contains('btn-primary'));
  assert.equal(primaries.length, 1, 'more than one primary on the record');
  assert.ok(headBtns(doc).some((b) => /Events/.test(b.textContent)), 'no way back to the list');
});

test('the status badge is on the app\'s tones, not a class named after the state', async (t) => {
  const open = boot({ t, routes: SESSION() });
  await settle();
  const badge = (d) => d.querySelector('#view .page-head p .badge-ui');
  assert.ok(badge(open.doc).classList.contains('crit'));
  assert.equal(open.doc.querySelectorAll('[class*="inc-status-"], [class*="inc-sev-"]').length, 0,
    'the old severity vocabularies survived');

  const closed = boot({ t, routes: SESSION({ 'GET /api/events/11': EVENT({ status: 'resolved' }) }) });
  await settle();
  assert.ok(badge(closed.doc).classList.contains('ok'));
});

test('moving the state asks the server and says so', async (t) => {
  const { doc, window, log } = boot({
    t, routes: SESSION({ 'PATCH /api/events/11': { ok: true } }),
  });
  await settle();
  // BY LABEL, not "the primary": `open` has two moves and which one is primary
  // is a layout decision, not the thing this test is about.
  headBtns(doc).find((b) => /Investigating/.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const call = log.find((x) => x.key === 'PATCH /api/events/11');
  assert.ok(call, 'the move asked the server nothing');
  assert.equal(JSON.parse(call.body).status, 'investigating');
});

test('an open event can be resolved without being investigated first', async (t) => {
  // Most events are read and dismissed in one go, and making those walk
  // through `investigating` recorded a step nobody performed.
  const { doc, window, log } = boot({
    t, routes: SESSION({ 'PATCH /api/events/11': { ok: true } }),
  });
  await settle();
  headBtns(doc).find((b) => /Resolved/.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(JSON.parse(log.find((x) => x.key === 'PATCH /api/events/11').body).status, 'resolved');
});

test('reopening a closed case has to be justified', async (t) => {
  const { doc, window, log } = boot({
    t, routes: SESSION({
      'GET /api/events/11': EVENT({ status: 'closed' }),
      'PATCH /api/events/11': { ok: true },
    }),
  });
  await settle();
  const btn = headBtns(doc).find((b) => b.classList.contains('btn-primary'));
  assert.match(btn.textContent, /Reopen/);
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const sent = JSON.parse(log.find((x) => x.key === 'PATCH /api/events/11').body);
  assert.equal(sent.status, 'open');
  // Reopening says the previous shift's conclusion was wrong, so it carries one.
  assert.match(sent.comment, /fault came back/);
});

test('a viewer is offered no move, only the way back', async (t) => {
  const { doc } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 0);
  assert.ok(headBtns(doc).some((b) => /Events/.test(b.textContent)));
  // …and the panels that only an operator can act on are not drawn either.
  assert.ok(!panelTitles(doc).includes('Config context'));
});

test('the evidence comes first and the work log straight after it', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const kids = [...doc.querySelectorAll('#view .ui-page > *')];
  const at = (re) => kids.findIndex((k) => re.test(k.textContent));
  const anomalies = at(/Anomalies/);
  const log = at(/Work log/);
  assert.ok(anomalies > 0, 'no anomalies panel');
  assert.ok(log > anomalies, 'the work log is above the evidence');
  // Nothing but evidence sits between the anomalies and the work log.
  for (const k of kids.slice(anomalies + 1, log)) {
    assert.match(k.textContent, /Affected path|Traffic and interface errors/);
  }
  // It draws its own card, so the page does not put a panel around it.
  assert.ok(!kids[log].classList.contains('panel-ui'), 'the work log is double-framed');
});

test('the anomalies panel says how many and reads as a history', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const panel = [...doc.querySelectorAll('#view .panel-ui')]
    .find((p) => /Anomalies/.test((p.querySelector('h2') || {}).textContent || ''));
  assert.ok(panel, 'no anomalies panel');
  assert.match(panel.querySelector('.meta-xs').textContent, /2 linked/);
  assert.equal(panel.querySelectorAll('.hist li').length, 2);
  assert.match(panel.textContent, /packet_loss/);
  assert.equal(panel.querySelectorAll('.inc-anoms').length, 0, 'the old list survived');
});

test('an event with no findings behind it says so', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /api/events/11': { event: EVENT().event, anomalies: [] } }),
  });
  await settle();
  const panel = [...doc.querySelectorAll('#view .panel-ui')]
    .find((p) => /Anomalies/.test((p.querySelector('h2') || {}).textContent || ''));
  assert.match(panel.textContent, /No linked anomalies/);
});

test('the affected path is drawn only when there is a path to draw', async (t) => {
  const withTarget = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(panelTitles(withTarget.doc).includes('Affected path'));

  // No anomaly carries a target and the event has none: not an empty panel, a
  // panel that does not apply.
  const without = boot({
    t,
    routes: SESSION({
      'GET /api/events/11': {
        event: EVENT().event,
        anomalies: [{ severity: 'WARN', metric: 'rtt_ms', createdAt: '2026-09-17T13:41:00.000Z' }],
      },
    }),
  });
  await settle();
  assert.ok(!panelTitles(without.doc).includes('Affected path'));
});

test('no event selected is an EmptyState, not a grey box', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/events', routes: SESSION() });
  await settle();
  // Reached through the list, so this is the Events screen — the detail page's
  // own no-selection state is what the direct address produces.
  assert.ok(doc.querySelector('#view .ui-page'));
});

test('a 404 names the id it could not find, and offers no pointless Retry', async (t) => {
  const { doc, errors } = boot({
    t, url: 'http://server.test/events/999', routes: SESSION({ 'GET /api/events/999': undefined }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a missing event is not an ErrorState');
  assert.match(err.textContent, /999 does not exist/);
  // Retrying a 404 asks the same question and gets the same answer.
  assert.ok(![...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
  assert.ok(headBtns(doc).some((b) => /Events/.test(b.textContent)), 'no way back from a dead link');
});

test('a 500 is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /api/events/11': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed load is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/api\/events\/11/);
  assert.ok([...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
});

test('the record marks itself in the rail and in the breadcrumb', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // A record's page has no rail entry of its own — it is reached from the list,
  // so it marks the list. Without that the sidebar marks nothing at all and the
  // crumb prints the raw view key: "event / #11".
  const marked = doc.querySelector('.tabs button.active');
  assert.ok(marked, 'nothing in the sidebar says where the reader is');
  assert.equal(marked.dataset.view, 'events');
  assert.match(doc.querySelector('#crumb').textContent, /Insights.*Events.*#11/);
});
