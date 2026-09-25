'use strict';

// Routing + the UI-contract preview screens (docs/ui-contract.md, phase 1).
//
// Three things are under test, and they are the three the contract asks for:
//   * the view ↔ path map itself (public/routes.js),
//   * the server's answer to a browser navigation — 200 with the shell on a
//     real address, 404 with the SAME shell on one that does not exist,
//   * the dashboard booting on an address: the right view, the sidebar marked,
//     the breadcrumb matching, and a role that may not open a screen being told
//     so rather than shown it.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');

const { makeApp } = require('../test-support/fakes');
const Routes = require('../public/routes.js');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const app = makeApp();

// A browser navigation. app.js's api() sends neither header, which is exactly
// what keeps a fetch for /agents from being answered with the dashboard.
const navigate = (p) => request(app).get(p)
  .set('Accept', 'text/html,application/xhtml+xml')
  .set('Sec-Fetch-Dest', 'document');

// ---------------------------------------------------------------- the map
test('routes: every view resolves to a path and back to itself', () => {
  for (const [view, spec] of Object.entries(Routes.VIEWS)) {
    const opts = {};
    if (spec.tabs) opts.tab = spec.tabs[0];
    if (spec.param) opts.id = 42;
    const p = Routes.pathFor(view, opts);
    const hit = Routes.match(p);
    assert.ok(hit, `${view}: ${p} matched nothing`);
    assert.equal(hit.view, view, `${view}: ${p} → ${hit.view}`);
    if (spec.tabs) assert.equal(hit.tab, spec.tabs[0], `${view}: sub-tab lost`);
    if (spec.param) assert.equal(hit.id, 42, `${view}: id lost`);
  }
});

test('routes: no two views claim the same address', () => {
  const seen = new Map();
  for (const [view, spec] of Object.entries(Routes.VIEWS)) {
    // /agents (list) and /agents/:id (detail) share a prefix by design; the
    // trailing segment is what tells them apart.
    const key = spec.path + (spec.param ? '/:id' : '');
    assert.ok(!seen.has(key), `${view} and ${seen.get(key)} both claim ${key}`);
    seen.set(key, view);
  }
});

test('routes: the bare root is Changes, and an unknown address matches nothing', () => {
  assert.equal(Routes.match('/').view, Routes.HOME);
  assert.equal(Routes.match('/index.html').view, Routes.HOME);
  assert.equal(Routes.match('/changes/').view, 'changes', 'a trailing slash is the same screen');
  for (const bad of ['/nope', '/agents/abc', '/probes/nope', '/agents/1/2', '/ui-preview', '/ui-preview/changes']) {
    assert.equal(Routes.match(bad), null, `${bad} should match nothing`);
    assert.equal(Routes.isAppPath(bad), false, bad);
  }
});

test('routes: a query string or a fragment does not change which screen an address names', () => {
  assert.equal(Routes.match('/fleet?severity=CRIT&site=vest').view, 'fleet');
  assert.equal(Routes.match('/topology#focus').view, 'topology');
});

// ---------------------------------------------------------------- the server
test('a navigation to an app path is answered 200 with the version-stamped shell', async () => {
  const version = require('../package.json').version;
  for (const p of ['/', '/changes', '/probes/connection', '/agents/12', '/settings/retention', '/ui-kitchen-sink']) {
    const res = await navigate(p);
    assert.equal(res.status, 200, `${p} → ${res.status}`);
    assert.match(res.headers['content-type'], /text\/html/, p);
    assert.ok(res.text.includes(`/app.js?v=${version}`), `${p}: shell not version-stamped`);
    assert.ok(res.text.includes('id="crumb"'), `${p}: shell has no breadcrumb`);
    assert.ok(res.text.includes('class="tabs"'), `${p}: shell has no sidebar`);
  }
});

test('a navigation to an unknown address is answered 404 with the SAME shell', async () => {
  for (const p of ['/nope', '/agents/abc', '/ui-preview/changes', '/deep/unknown/path']) {
    const res = await navigate(p);
    assert.equal(res.status, 404, `${p} → ${res.status}`);
    assert.match(res.headers['content-type'], /text\/html/, p);
    assert.ok(res.text.includes('class="tabs"'), `${p}: the 404 lost the sidebar`);
    assert.ok(res.text.includes('/app.js'), `${p}: the 404 lost the app`);
  }
});

test('a fetch is never answered with the shell — the API still owns its paths', async () => {
  // /agents is both a screen and an endpoint. Without a token the endpoint says
  // 401 in JSON; answering a fetch with 200 text/html would break every client.
  for (const p of ['/agents', '/locations', '/settings', '/logs']) {
    const res = await request(app).get(p);
    assert.notEqual(res.status, 200, `${p}: an unauthenticated fetch got through`);
    assert.doesNotMatch(String(res.headers['content-type'] || ''), /text\/html/, `${p} was answered with the shell`);
  }
  const unknown = await request(app).get('/api/definitely-not-a-route');
  assert.equal(unknown.status, 404);
  assert.doesNotMatch(String(unknown.headers['content-type'] || ''), /text\/html/, 'an unknown API path must stay JSON');
});

test('an HTML document the API itself serves is not swallowed by the shell', async () => {
  // The NIS2 report documents and the report exports render their own HTML and
  // are opened as navigations. They are not app paths, so the first handler has
  // to leave them alone and the API has to answer before the 404 shell does.
  const res = await navigate('/api/nis2/reports/1/document');
  assert.notEqual(res.status, 200);
  assert.ok([401, 403, 404].includes(res.status), `unexpected ${res.status}`);
});

// ---------------------------------------------------------------- the client
function bootAt(url, { role = 'admin', routes = {}, t } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const k = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push(k);
    const hit = routes[k];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  if (t) t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  const scripts = [...window.document.querySelectorAll('script[src]')]
    .map((s) => s.getAttribute('src')).filter((s) => s.startsWith('/') && !s.startsWith('/vendor/'));
  for (const s of scripts) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  return { window, doc: window.document, errors, log };
}
const settle = () => new Promise((r) => setTimeout(r, 90));

const SESSION = (role) => ({
  'GET /me': { id: 1, email: 'x@y.dk', role, preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [{ id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' }],
  'GET /api/changes': {
    since: '2026-09-10T08:14:00.000Z', total: 2, rawTotal: 9, correlated: 7, returned: 2,
    partial: false, failedSources: [], truncated: false,
    groups: [], events: [
      { timestamp: '2026-09-12T14:02:00.000Z', firstAt: '2026-09-12T13:00:00.000Z', source: 'probe', type: 'probe.latency.degraded', severity: 'CRIT', summary: 'latency degraded at oslo-edge-01', agentId: 7, kind: 'probe', metric: 'latency', family: 'latency', count: 135, findingCount: 0 },
      { timestamp: '2026-09-12T10:44:00.000Z', firstAt: '2026-09-12T10:44:00.000Z', source: 'finding', type: 'finding.loss', severity: 'WARN', summary: 'loss on oslo-edge-01', agentId: 7, kind: 'finding', metric: 'loss', family: 'loss', count: 1, findingCount: 2 },
    ],
  },
  'GET /api/connection-test/checks': {
    host: null,
    checks: [
      { id: 'ping', type: 'ping', port: null, available: true, appliesTo: 'any', applies: true },
      { id: 'tcp443', type: 'tcp', port: 443, available: true, appliesTo: 'any', applies: true },
      { id: 'tls', type: 'tcp', port: 443, available: false, appliesTo: 'any', applies: false },
      { id: 'rdns', type: 'dns', port: null, available: false, appliesTo: 'any', applies: false },
    ],
  },
});

test('boot: the first paint comes from the address, not from a default', async (t) => {
  for (const [url, view, navLabel] of [
    ['http://server.test/', 'changes', 'Changes'],
    ['http://server.test/fleet', 'fleet', 'Fleet'],
    ['http://server.test/topology', 'topology', 'Topology'],
    ['http://server.test/probes/connection', 'probes', 'Probes & Tests'],
  ]) {
    const { doc, window, errors } = bootAt(url, { t, routes: SESSION('admin') });
    await settle();
    assert.deepEqual(errors, [], `${url}: uncaught error`);
    const active = doc.querySelector('.tabs button.active');
    assert.ok(active, `${url}: nothing marked active in the sidebar`);
    assert.equal(active.dataset.view, view, `${url}: sidebar marks ${active.dataset.view}`);
    assert.equal(active.textContent.trim(), navLabel, url);
    // The group holding the active item is unfolded, or the marking is invisible.
    assert.equal(active.closest('.nav-group').classList.contains('collapsed'), false,
      `${url}: the active item is inside a collapsed group`);
    assert.equal(window.location.pathname, Routes.pathFor(view, Routes.match(new URL(url).pathname).tab
      ? { tab: Routes.match(new URL(url).pathname).tab } : {}), `${url}: the address moved`);
  }
});

test('boot: the breadcrumb names the section and the page the route points at', async (t) => {
  const { doc } = bootAt('http://server.test/probes/connection', { t, routes: SESSION('admin') });
  await settle();
  const crumb = doc.getElementById('crumb');
  assert.ok(crumb, 'no breadcrumb in the shell');
  assert.match(crumb.textContent, /Diagnostics/, 'the section is missing');
  assert.match(crumb.textContent, /Probes/, 'the page is missing');
  assert.match(crumb.textContent, /Connection test/, 'the sub-page is missing');
  assert.equal(crumb.querySelectorAll('.crumb-here').length, 1, 'exactly one crumb is the current page');
});

test('boot: a sub-tab and a filter both survive a reload, because both are in the URL', async (t) => {
  const { doc, window } = bootAt('http://server.test/fleet?severity=CRIT&site=vest', { t, routes: SESSION('admin') });
  await settle();
  assert.equal(doc.querySelector('.tabs button.active').dataset.view, 'fleet');
  // Fleet names its column set in the path, the way Settings and Probes name
  // their sub-tab, so a bare /fleet settles on the default set.
  assert.equal(window.location.pathname, '/fleet/health', 'the path was rewritten');
  const q = new window.URLSearchParams(window.location.search);
  assert.equal(q.get('severity'), 'CRIT', 'the filter was dropped from the URL');
  assert.equal(q.get('site'), 'vest', 'the filter was dropped from the URL');
});

test('boot: an unknown address renders the 404 view inside the ordinary shell', async (t) => {
  const { doc } = bootAt('http://server.test/nope', { t, routes: SESSION('admin') });
  await settle();
  assert.equal(doc.getElementById('app').classList.contains('hidden'), false, 'the shell is gone');
  assert.ok(doc.querySelector('.sidebar'), 'the 404 lost the sidebar');
  assert.ok(doc.querySelector('.topbar'), 'the 404 lost the topbar');
  const view = doc.getElementById('view');
  assert.match(view.textContent, /404/);
  assert.match(view.textContent, /\/nope/, 'the 404 does not say which address failed');
  assert.ok(view.querySelector('.ui .page-head h1'), 'the 404 is not built from the contract components');
});

test('boot: navigating pushes history, and Back returns to the previous screen', async (t) => {
  const { doc, window } = bootAt('http://server.test/changes', { t, routes: SESSION('admin') });
  await settle();
  const fleetBtn = doc.querySelector('.tabs button[data-view="fleet"]');
  fleetBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/fleet/health');
  window.history.back();
  await settle();
  assert.equal(window.location.pathname, '/changes', 'Back did not return to Changes');
  assert.equal(doc.querySelector('.tabs button.active').dataset.view, 'changes');
});

test('boot: a role-gated screen is refused by address as well as hidden in the rail', async (t) => {
  // /discovery is admin-only. A viewer typing the address must not get it just
  // because they did not go through the nav.
  const { doc } = bootAt('http://server.test/discovery', { t, role: 'viewer', routes: SESSION('viewer') });
  await settle();
  assert.match(doc.getElementById('view').textContent, /403/);
  const tab = doc.querySelector('.tabs button[data-view="discovery"]');
  assert.ok(tab.classList.contains('role-hidden'), 'the rail still offers it');
});

test('boot: the 403 and the 404 keep the address in the bar and say so in the breadcrumb', async (t) => {
  const gone = bootAt('http://server.test/nope', { t, routes: SESSION('admin') });
  await settle();
  assert.equal(gone.window.location.pathname, '/nope', 'the 404 rewrote the address it was meant to name');
  assert.match(gone.doc.getElementById('crumb').textContent, /not found/i);

  const denied = bootAt('http://server.test/discovery', { t, role: 'viewer', routes: SESSION('viewer') });
  await settle();
  assert.equal(denied.window.location.pathname, '/discovery', 'the 403 rewrote the address');
  assert.match(denied.doc.getElementById('crumb').textContent, /not allowed/i);
});

// ---------------------------------------------------------------- kitchen sink
test('boot: /ui-kitchen-sink renders every component section, admin only', async (t) => {
  const { doc, window, errors } = bootAt('http://server.test/ui-kitchen-sink', { t, routes: SESSION('admin') });
  await settle();
  assert.deepEqual(errors, []);
  const ui = doc.querySelector('#view .ui');
  assert.ok(ui, 'the reference is not built from the contract components');
  assert.ok(ui.querySelector('.page-head h1'), 'no PageHeader');
  const KitchenSink = require('../public/kitchenSink.js');
  const tabs = [...ui.querySelectorAll('.subtabs .subtab')];
  assert.ok(tabs.length >= 8, `only ${tabs.length} sections`);

  // Every section renders without throwing, and none of them is empty.
  for (const tab of tabs) {
    tab.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle();
    const body = ui.lastElementChild;
    assert.ok(body.querySelector('.panel-ui'), `${tab.textContent}: rendered no panel`);
    assert.ok(body.textContent.trim().length > 20, `${tab.textContent}: rendered nothing`);
  }
  assert.deepEqual(errors, [], 'a section threw while rendering');
  void KitchenSink;
});

test('boot: the kitchen sink shows each state, and its overlays open and close', async (t) => {
  const { doc, window } = bootAt('http://server.test/ui-kitchen-sink', { t, routes: SESSION('admin') });
  await settle();
  const pick = (name) => [...doc.querySelectorAll('#view .subtabs .subtab')]
    .find((b) => b.dataset.tab === name);

  pick('states').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const plain = [...doc.querySelectorAll('#view .state')].filter((n) => !n.classList.contains('is-error'));
  assert.equal(plain.length, 1, 'no EmptyState');
  assert.ok(doc.querySelector('#view .state.is-error'), 'no ErrorState');
  assert.ok(doc.querySelector('#view .skel-row'), 'no LoadingState');
  assert.ok(doc.querySelector('#view .inline-note.is-warn'), 'no warning inline note');

  pick('overlays').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const [drawerBtn, okBtn, errBtn] = [...doc.querySelectorAll('#view .panel-body .btn')];
  drawerBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(doc.querySelector('.ui-drawer'), 'the Drawer did not open');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.querySelector('.ui-drawer'), null, 'Escape did not close the Drawer');

  okBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  errBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  const toasts = doc.querySelectorAll('#ui-toasts .ui-toast');
  assert.equal(toasts.length, 2, 'toasts do not stack');
  assert.ok(doc.querySelector('#ui-toasts .ui-toast.err'));
});

test('boot: the kitchen sink is admin only, by address as well as by rail', async (t) => {
  for (const role of ['viewer', 'operator']) {
    const { doc } = bootAt('http://server.test/ui-kitchen-sink', { t, role, routes: SESSION(role) });
    await settle();
    assert.match(doc.getElementById('view').textContent, /403/, role);
    assert.equal(doc.querySelector('#view .statstrip'), null, `${role}: it rendered anyway`);
  }
});

test('boot: leaving a screen takes its body-level overlays with it', async (t) => {
  // The Drawer, the popover and the toasts hang off <body>, so a view switch
  // does not remove them — which would leave a Drawer floating over Fleet.
  // This ran against /ui-preview/changes; it runs against the real Changes
  // screen now that the preview routes are gone.
  const { doc, window } = bootAt('http://server.test/changes', { t, routes: SESSION('admin') });
  await settle();
  doc.querySelector('#view table.dt tbody tr').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(doc.querySelector('.ui-drawer'), 'no Drawer to leave behind');
  doc.querySelector('.tabs button[data-view="fleet"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(doc.querySelector('.ui-drawer'), null, 'the Drawer followed us to Fleet');
  assert.equal(doc.querySelector('.ui-scrim'), null, 'the scrim followed us to Fleet');
});
