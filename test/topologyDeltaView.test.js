'use strict';

// public/views/topologyDelta.js — the topology delta feed on the UI contract
// (docs/ui-contract.md).
//
// The page carried three rows of controls: change-type chips, a site/severity
// bar, and a third row of removable chips repeating what the second one already
// said. The types are a StatStrip now and the rest is one Toolbar. These tests
// hold what had to survive: the type filter is still in the URL, the site and
// severity are still the SHARED global filter rather than a second copy, and a
// viewer still gets told why the feed is empty rather than shown an error.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const ev = (type, sev, agentId, summary, ts) => ({
  type: `topology.${type}`, severity: sev, agentId, summary, timestamp: ts,
});
const EVENTS = [
  ev('neighbour_added', 'INFO', 7, 'Gi0/2 sees sw-core-01', '2026-09-12T14:02:00.000Z'),
  ev('flapping', 'CRIT', 7, 'Gi0/2 flapped 12 times in 5 minutes', '2026-09-12T13:58:00.000Z'),
  ev('link_state_changed', 'WARN', 8, 'Gi0/1 went down', '2026-09-12T11:20:00.000Z'),
  ev('port_moved', 'WARN', 8, 'b8:27:eb:… moved from Gi0/3 to Gi0/7', '2026-09-12T10:44:00.000Z'),
  ev('neighbour_removed', 'INFO', 9, 'sw-edge-04 no longer seen', '2026-09-11T22:05:00.000Z'),
];
const AGENTS = [
  { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', location_id: 1, location_name: 'Oslo' },
  { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02', location_id: 2, location_name: 'Copenhagen' },
  { id: 9, display_name: 'sto-branch-07', hostname: 'sto-branch-07', location_id: 3, location_name: 'Stockholm' },
];
const LOCATIONS = [{ id: 1, name: 'Oslo' }, { id: 2, name: 'Copenhagen' }, { id: 3, name: 'Stockholm' }];

function boot({ t, routes = {}, url = 'http://server.test/topology-delta', role = 'admin' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 160));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/topology/changes': { events: EVENTS },
  'GET /agents': AGENTS,
  'GET /locations': LOCATIONS,
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view .panel-ui table.dt tbody tr')];
const cards = (doc) => [...doc.querySelectorAll('#view .statstrip .stat-card')];
const selects = (doc) => [...doc.querySelectorAll('#view .toolbar-ui select')];

test('the delta feed is a ListPage: PageHeader, StatStrip, one Toolbar, DataTable', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  // The nav, the breadcrumb and the title agree. Two screens were both called
  // "Changes", which is one too many.
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace('?', '').trim(), 'Topology delta');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .delta-typebar').length, 0, 'the chip bar survived');
  assert.equal(doc.querySelectorAll('#view .delta-globalbar').length, 0, 'the second chip bar survived');
  assert.equal(doc.querySelectorAll('#view .chip').length, 0, 'chips survived');
  assert.equal(doc.querySelectorAll('#view .toolbar-ui').length, 1, 'there is more than one toolbar');
  assert.equal(cards(doc).length, 5, 'the five change types are not a StatStrip');
  assert.equal(rows(doc).length, 5);
});

test('the strip counts every type and filters on click, into the URL', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(cards(doc).map((c) => c.querySelector('.stat-n').textContent), ['1', '1', '1', '1', '1']);
  const flapping = cards(doc).find((c) => /Flapping/.test(c.textContent));
  flapping.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 1);
  assert.match(rows(doc)[0].textContent, /flapped 12 times/);
  assert.equal(new window.URLSearchParams(window.location.search).get('changeTypes'), 'flapping');
  // The counts stay whole-feed under the filter — otherwise the filter hides
  // the very thing it points at.
  assert.deepEqual(cards(doc).map((c) => c.querySelector('.stat-n').textContent), ['1', '1', '1', '1', '1']);
  assert.equal(cards(doc).find((c) => /Flapping/.test(c.textContent)).getAttribute('aria-pressed'), 'true');
});

test('a changeTypes deep link arrives filtered', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), url: 'http://server.test/topology-delta?changeTypes=port_moved' });
  await settle();
  assert.equal(rows(doc).length, 1);
  assert.match(rows(doc)[0].textContent, /moved from Gi0\/3/);
});

test('the site and severity are the SHARED filter, and reach the shared URL', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const [site, sev] = selects(doc);
  site.value = '2';
  site.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 2, 'the site filter did not narrow the feed');
  assert.ok(rows(doc).every((r) => /cph-core-02/.test(r.textContent)));
  assert.equal(new window.URLSearchParams(window.location.search).get('site'), '2');

  sev.value = 'CRIT';
  sev.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  // Copenhagen has no CRIT, so the two filters compose rather than replace.
  assert.equal(rows(doc).length, 0);
  assert.ok(doc.querySelector('#view .state'), 'no EmptyState for a filter that matched nothing');
});

test('clearing the filters brings the whole feed back, URL included', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION(), url: 'http://server.test/topology-delta?changeTypes=flapping' });
  await settle();
  assert.equal(rows(doc).length, 1);
  const clear = [...doc.querySelectorAll('#view .toolbar-right .btn')].find((b) => /Clear/i.test(b.textContent));
  assert.ok(clear, 'no way to clear the filter');
  clear.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(rows(doc).length, 5);
  assert.equal(new window.URLSearchParams(window.location.search).get('changeTypes'), null);
});

test('the table sorts from its header and the host is a link', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  // Newest first by default.
  assert.match(rows(doc)[0].textContent, /sees sw-core-01/);
  const header = [...doc.querySelectorAll('#view .panel-ui table.dt thead th')]
    .find((th) => /^Host/.test(th.textContent));
  header.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const names = rows(doc).map((r) => (r.querySelector('a.hostlink') || {}).textContent);
  assert.deepEqual(names, [...names].sort().reverse(), `not sorted: ${names.join(', ')}`);
});

test('a 403 is an explanation, not an error', async (t) => {
  // The nav gates the page at operator, so a viewer never gets this far — this
  // is the server refusing somebody the client let through.
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/topology/changes': { status: 403, body: { error: 'Forbidden' } } }), role: 'operator' });
  await settle();
  assert.deepEqual(errors, []);
  const state = doc.querySelector('#view .state');
  assert.ok(state);
  assert.equal(doc.querySelectorAll('#view .state.is-error').length, 0, 'a 403 was reported as a failure');
  assert.match(state.textContent, /operator and admin only/i);
});

test('a 500 IS an error, names the call, and keeps the shell', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/topology/changes': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/topology\/changes/);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
});

test('an empty feed reads differently from a filter that matched nothing', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/topology/changes': { events: [] } }) });
  await settle();
  assert.match(doc.querySelector('#view .state').textContent, /No topology changes recorded yet/i);
});

test('the severity labels go through the catalogue, in both languages', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const opts = [...selects(doc)[1].options].map((o) => o.textContent);
  assert.ok(!opts.includes('Kritiske'), 'the Danish string is still hardcoded on the English screen');
  assert.ok(opts.some((o) => /Critical/i.test(o)), `no critical option: ${opts.join(', ')}`);
});
