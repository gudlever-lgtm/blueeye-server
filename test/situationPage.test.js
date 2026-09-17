'use strict';

// public/views/situation.js — one situation, as a DetailPage (template D)
// (docs/ui-contract.md).
//
// A SHELL migration: the five panels stay in public/clusterView.js, which ships
// standalone. What is tested here is the page they sit on — and the confidence
// scale, which the detail and the list disagreed about.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CLUSTER = (over = {}) => ({
  cluster: Object.assign({
    id: 14, status: 'open', confidence: 'high',
    suspectedRootCause: { classification: 'network-layer', explanation: 'One shared upstream hop.' },
    affectedAgents: [{ id: 7, name: 'oslo-edge-01' }, { id: 8, name: 'cph-core-02' }, { id: 9, name: 'sto-branch-07' }],
    firstSeen: '2026-09-17T13:40:00.000Z', lastSeen: '2026-09-17T14:20:00.000Z',
    confidenceBreakdown: { sharedHop: true },
  }, over),
});

function boot({ t, routes = {}, url = 'http://server.test/situations/14', role = 'admin' } = {}) {
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
  window.prompt = () => 'upstream carrier fixed the peering';
  window.confirm = () => true;
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
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/event-clusters/14': CLUSTER(),
  'GET /api/event-clusters/14/timeline': { window: { lookbackMinutes: 30 }, whatChanged: [], events: [] },
  'GET /api/event-clusters/14/recommended-actions': { actions: [] },
}, over);

const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];

test('the situation is a DetailPage led by its suspected cause', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  const h1 = doc.querySelector('#view .page-head h1');
  // The id is already in the address; the cause is what the reader came for.
  assert.match(h1.textContent, /Network layer/);
  assert.ok(!/Situation #14/.test(h1.textContent), 'the headline is still the record id');
  assert.ok(h1.querySelector('.badge-ui').classList.contains('crit'), 'the status is not beside the title');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .inc-header, #view .inc-actions').length, 0,
    'the module still draws its own heading');
});

test('the lead carries the confidence, the spread and the window', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const lead = doc.querySelector('#view .page-head p');
  assert.match(lead.textContent, /High confidence/);
  assert.match(lead.textContent, /3 agents/);
  assert.match(lead.textContent, /first seen/);
  assert.match(lead.textContent, /last activity/);
});

test('Resolve is the primary, Acknowledge the secondary beside it', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const primaries = headBtns(doc).filter((b) => b.classList.contains('btn-primary'));
  assert.equal(primaries.length, 1, 'more than one primary on the record');
  // Resolve closes the story; Acknowledge only says somebody saw it.
  assert.match(primaries[0].textContent, /Resolve/);
  assert.ok(headBtns(doc).some((b) => /Acknowledge/.test(b.textContent)));
  assert.ok(headBtns(doc).some((b) => /Situations/.test(b.textContent)), 'no way back to the list');
});

test('an acknowledged situation is offered only the move that is left', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/event-clusters/14': CLUSTER({ status: 'acknowledged' }) }) });
  await settle();
  assert.ok(!headBtns(doc).some((b) => /Acknowledge/.test(b.textContent)));
  assert.ok(headBtns(doc).some((b) => b.classList.contains('btn-primary') && /Resolve/.test(b.textContent)));
});

test('a resolved situation is offered no move at all', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/event-clusters/14': CLUSTER({ status: 'resolved' }) }) });
  await settle();
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 0);
  assert.ok(doc.querySelector('#view .page-head h1 .badge-ui').classList.contains('ok'));
});

test('a viewer is offered no move', async (t) => {
  const { doc } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(headBtns(doc).filter((b) => /Acknowledge|Resolve/.test(b.textContent)).length, 0);
  assert.ok(headBtns(doc).some((b) => /Situations/.test(b.textContent)));
});

test('resolving carries the note that says how', async (t) => {
  const { doc, window, log } = boot({
    t, routes: SESSION({ 'POST /api/event-clusters/14/resolve': { ok: true } }),
  });
  await settle();
  headBtns(doc).find((b) => b.classList.contains('btn-primary'))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const call = log.find((x) => x.key === 'POST /api/event-clusters/14/resolve');
  assert.ok(call, 'resolve asked the server nothing');
  assert.match(JSON.parse(call.body).note, /peering/);
});

test('acknowledging needs no note', async (t) => {
  const { doc, window, log } = boot({
    t, routes: SESSION({ 'POST /api/event-clusters/14/ack': { ok: true } }),
  });
  await settle();
  headBtns(doc).find((b) => /Acknowledge/.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'POST /api/event-clusters/14/ack'));
});

test('the module still draws the five panels', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const body = doc.querySelector('#view .cluster-detail');
  assert.ok(body, 'the module body is gone');
  assert.match(body.textContent, /What changed just before/);
  assert.match(body.textContent, /Evidence/);
  assert.match(body.textContent, /Recommended actions/);
});

test('confidence is not severity — one scale, on both the header and the evidence', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  // The Evidence panel used to badge high confidence in crit red, two inches
  // under the header's green "High confidence" — the same value, two answers.
  assert.match(css, /\.badge\.conf-high \{ background: var\(--ok-weak\); color: var\(--sev-ok\); \}/);
  assert.ok(doc.querySelector('#view .page-head p .badge-ui').classList.contains('ok'));

  const low = boot({ t, routes: SESSION({ 'GET /api/event-clusters/14': CLUSTER({ confidence: 'low' }) }) });
  await settle();
  // A low-confidence grouping is a hypothesis: muted, not alarming.
  assert.ok(low.doc.querySelector('#view .page-head p .badge-ui').classList.contains('neutral'));
});

test('a 404 names the id it could not find, and offers no pointless Retry', async (t) => {
  const { doc, errors } = boot({
    t, url: 'http://server.test/situations/999',
    routes: SESSION({ 'GET /api/event-clusters/999': undefined }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a missing situation is not an ErrorState');
  assert.match(err.textContent, /999 does not exist/);
  assert.ok(![...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
  assert.ok(headBtns(doc).some((b) => /Situations/.test(b.textContent)), 'no way back from a dead link');
});

test('a 500 is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /api/event-clusters/14': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err);
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/api\/event-clusters\/14/);
  assert.ok([...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
});

test('a failed timeline costs its panel, never the page', async (t) => {
  // The timeline and the recommended actions are independent fetches.
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /api/event-clusters/14/timeline': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the timeline');
  assert.ok(doc.querySelector('#view .cluster-detail'), 'the other panels went with it');
});

test('the record marks itself in the rail and in the breadcrumb', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const marked = doc.querySelector('.tabs button.active');
  assert.ok(marked, 'nothing in the sidebar says where the reader is');
  assert.equal(marked.dataset.view, 'clusters');
  assert.match(doc.querySelector('#crumb').textContent, /Insights.*Situations.*#14/);
});

test('the standalone module still owns its own heading without the flag', async (t) => {
  const src = fs.readFileSync(path.join(PUBLIC, 'clusterView.js'), 'utf8');
  assert.match(src, /if \(!opts\.embedded\) container\.appendChild\(renderHeader/);
  assert.match(src, /function renderHeader/, 'the standalone heading was removed');
  void t;
});
