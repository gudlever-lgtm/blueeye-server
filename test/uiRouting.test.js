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
  for (const bad of ['/nope', '/agents/abc', '/probes/nope', '/agents/1/2', '/ui-preview', '/ui-preview/nope']) {
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
  for (const p of ['/', '/changes', '/probes/connection', '/agents/12', '/settings/retention', '/ui-preview/changes']) {
    const res = await navigate(p);
    assert.equal(res.status, 200, `${p} → ${res.status}`);
    assert.match(res.headers['content-type'], /text\/html/, p);
    assert.ok(res.text.includes(`/app.js?v=${version}`), `${p}: shell not version-stamped`);
    assert.ok(res.text.includes('id="crumb"'), `${p}: shell has no breadcrumb`);
    assert.ok(res.text.includes('class="tabs"'), `${p}: shell has no sidebar`);
  }
});

test('a navigation to an unknown address is answered 404 with the SAME shell', async () => {
  for (const p of ['/nope', '/agents/abc', '/ui-preview/nope', '/deep/unknown/path']) {
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
    .map((s) => s.getAttribute('src')).filter((s) => s.startsWith('/'));
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
  assert.equal(window.location.pathname, '/fleet', 'the path was rewritten');
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
  assert.equal(window.location.pathname, '/fleet');
  window.history.back();
  await settle();
  assert.equal(window.location.pathname, '/changes', 'Back did not return to Changes');
  assert.equal(doc.querySelector('.tabs button.active').dataset.view, 'changes');
});

// ---------------------------------------------------------------- the preview
test('boot: /ui-preview/changes renders the ListPage for an admin', async (t) => {
  const { doc, errors } = bootAt('http://server.test/ui-preview/changes', { t, routes: SESSION('admin') });
  await settle();
  assert.deepEqual(errors, []);
  const view = doc.getElementById('view');
  const ui = view.querySelector('.ui');
  assert.ok(ui, 'the page is not built from the contract components');
  // Template A: PageHeader → StatStrip → Toolbar → DataTable.
  assert.ok(ui.querySelector('.page-head h1'), 'no PageHeader');
  assert.ok(ui.querySelector('.page-head .help-btn'), 'no (?) help control');
  assert.equal(ui.querySelectorAll('.hero').length, 0, 'the info banner came back');
  assert.equal(ui.querySelectorAll('.page-head-actions .btn-primary').length, 1,
    'a PageHeader carries at most one primary button');
  assert.match(ui.querySelector('.page-head-actions .btn-primary').textContent, /Mark as seen/);
  assert.ok(ui.querySelector('.statstrip .stat-card.crit'), 'no StatStrip');
  assert.ok(ui.querySelector('.toolbar-ui'), 'no Toolbar');
  const table = ui.querySelector('table.dt');
  assert.ok(table, 'the list is not a real <table>');
  assert.deepEqual([...table.querySelectorAll('thead th')].map((th) => th.textContent.replace(/[↑↓↕]/g, '').trim()),
    ['Time', 'Severity', 'Type', 'Title', 'Host', 'Repeats', '']);
  assert.equal(table.querySelectorAll('tbody tr').length, 2);
  // A host is a link in its own column, and a repeat count is muted text.
  assert.ok(table.querySelector('tbody tr a.hostlink'), 'the host is not a link');
  assert.equal(table.querySelectorAll('tbody .badge-ui:not(.crit):not(.warn):not(.info):not(.ok)').length, 0,
    'a badge outside the severity set means metadata rendered as a chip');
});

test('boot: a row opens the Drawer, with the explanation and the history in it', async (t) => {
  const { doc, window } = bootAt('http://server.test/ui-preview/changes', { t, routes: SESSION('admin') });
  await settle();
  const row = doc.querySelector('#view table.dt tbody tr');
  row.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(drawer, 'the row did not open a Drawer');
  assert.equal(row.getAttribute('aria-selected'), 'true', 'the open row is not marked');
  assert.ok(drawer.querySelector('.drawer-head .badge-ui.crit'), 'the Drawer header has no status');
  const headings = [...drawer.querySelectorAll('.dsec h3')].map((h) => h.textContent);
  assert.ok(headings.some((h) => /What happened/i.test(h)), headings.join(', '));
  assert.ok(headings.some((h) => /History/i.test(h)), headings.join(', '));
  assert.match(drawer.textContent, /Round-trip time is well above its baseline/,
    'the severity explanation is not in the Drawer');
  drawer.querySelector('.drawer-head .btn-icon').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(doc.querySelector('.ui-drawer'), null, 'the Drawer would not close');
});

test('boot: ?state=empty and ?state=error show the shared Empty and Error states', async (t) => {
  const empty = bootAt('http://server.test/ui-preview/changes?state=empty', { t, routes: SESSION('admin') });
  await settle();
  const e = empty.doc.querySelector('#view .state');
  assert.ok(e, 'no EmptyState');
  assert.equal(e.classList.contains('is-error'), false);
  assert.equal(empty.doc.querySelector('#view table.dt'), null, 'the table is still there');

  const bad = bootAt('http://server.test/ui-preview/changes?state=error', { t, routes: SESSION('admin') });
  await settle();
  const err = bad.doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /GET \/api\/changes/, 'the error does not say what failed');
  assert.ok(err.querySelector('.btn'), 'an ErrorState always offers a retry');
  // The shell is intact either way — an error in a panel is not a broken page.
  assert.ok(bad.doc.querySelector('.sidebar'));
  assert.ok(bad.doc.querySelector('#view .page-head h1'));
});

test('boot: a 500 from the API lands in the ErrorState, not in a broken layout', async (t) => {
  const routes = Object.assign({}, SESSION('admin'), { 'GET /api/changes': { status: 500, body: { error: 'boom' } } });
  const { doc, errors } = bootAt('http://server.test/ui-preview/changes', { t, routes });
  await settle();
  assert.deepEqual(errors, [], 'a 500 threw instead of rendering');
  assert.ok(doc.querySelector('#view .state.is-error'), 'no ErrorState for a 500');
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader did not survive the 500');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive the 500');
});

test('boot: /ui-preview/probes renders the FormPage, with the checks the agent cannot run dimmed', async (t) => {
  const { doc, errors } = bootAt('http://server.test/ui-preview/probes', { t, routes: SESSION('admin') });
  await settle();
  assert.deepEqual(errors, []);
  const ui = doc.querySelector('#view .ui');
  assert.ok(ui.querySelector('.page-head h1'), 'no PageHeader');
  // Template C: SubTabs → Panel with FormSection → FormActions bottom right.
  const tabs = [...ui.querySelectorAll('.subtabs[role="tablist"] .subtab')];
  assert.deepEqual(tabs.map((b) => b.textContent), ['Run a probe', 'Connection test', 'Test packages']);
  assert.equal(tabs.filter((b) => b.getAttribute('aria-selected') === 'true').length, 1);
  // tabStrip()'s roving tabindex: one stop in the tab order, arrows move within.
  assert.equal(tabs.filter((b) => b.tabIndex === 0).length, 1, 'the strip has one tab stop');
  assert.ok(ui.querySelector('.form-sec .form-grid-ui .f label[for="uip-agent"]'), 'no Agent field');
  assert.ok(ui.querySelector('.form-sec .form-grid-ui .f label[for="uip-target"]'), 'no Target field');
  const actions = ui.querySelector('.form-actions-ui .actions-right');
  assert.ok(actions.querySelector('.count-field input'), 'the round count is not its own field');
  assert.equal(actions.querySelectorAll('.btn-primary').length, 1, 'Run is the only primary');
  assert.match(actions.querySelector('.btn-primary').textContent, /^Run /);
  const secondary = [...actions.querySelectorAll('.btn-secondary')].map((b) => b.textContent);
  assert.deepEqual(secondary, ['Repeat', 'Stop']);
  // The catalogue: two runnable, two not — and the two that cannot run say why.
  const rows = [...ui.querySelectorAll('table.dt tbody tr')];
  assert.equal(rows.length, 4);
  const dimmed = rows.filter((r) => r.classList.contains('is-dimmed'));
  assert.equal(dimmed.length, 2, 'the checks the agent cannot run are not dimmed');
  assert.ok(dimmed.every((r) => r.querySelector('.badge-ui.neutral')),
    'a check that cannot run must not wear a severity colour');
  assert.match(dimmed[0].textContent, /Not available yet/);
});

test('boot: an empty Target is refused in the field, before anything is dispatched', async (t) => {
  const { doc, window, log } = bootAt('http://server.test/ui-preview/probes', { t, routes: SESSION('admin') });
  await settle();
  const before = log.length;
  doc.querySelector('#view .form-actions-ui .btn-primary').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const input = doc.getElementById('uip-target');
  assert.equal(input.getAttribute('aria-invalid'), 'true', 'the field is not marked invalid');
  assert.match(doc.querySelector('#view .f .field-error').textContent, /IP address or a DNS name/);
  assert.equal(log.length, before, 'a run was dispatched anyway');
});

test('boot: the preview toasts stack top right, and the error one stays', async (t) => {
  const { doc, window } = bootAt('http://server.test/ui-preview/probes', { t, routes: SESSION('admin') });
  await settle();
  doc.getElementById('uip-target').value = '10.24.8.19';
  doc.querySelector('#view .form-actions-ui .btn-primary').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const host = doc.getElementById('ui-toasts');
  assert.ok(host, 'no toast host');
  assert.equal(host.querySelectorAll('.ui-toast').length, 2, 'toasts do not stack');
  assert.ok(host.querySelector('.ui-toast.err'), 'the error toast is missing');
  host.querySelector('.ui-toast.err .btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(host.querySelectorAll('.ui-toast.err').length, 0, 'the error toast would not close');
});

test('boot: a non-admin asking for /ui-preview/* is told it is not theirs, not shown it', async (t) => {
  for (const role of ['viewer', 'operator']) {
    for (const p of ['/ui-preview/changes', '/ui-preview/probes']) {
      const { doc } = bootAt(`http://server.test${p}`, { t, role, routes: SESSION(role) });
      await settle();
      const view = doc.getElementById('view');
      assert.match(view.textContent, /403/, `${role} ${p}: no 403`);
      assert.match(view.textContent, /admin role/, `${role} ${p}: the required role is not named`);
      assert.equal(view.querySelector('.statstrip'), null, `${role} ${p}: the screen rendered anyway`);
      assert.equal(view.querySelector('table.dt'), null, `${role} ${p}: the data rendered anyway`);
      assert.ok(doc.querySelector('.sidebar'), `${role} ${p}: the way out is gone`);
    }
  }
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
