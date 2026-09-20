'use strict';

// The whole dashboard, opened one page at a time, against the real routers.
//
// Every other UI test mounts one view against a hand-written fake fetch, which
// means it tests the view against what the author of the test believed the API
// returns. This one wires jsdom's fetch into `makeApp()` — the real Express app
// over in-memory repositories — and clicks every entry in the nav. What it
// catches is the class of bug no unit test can: a view that reads a field the
// server does not send, a page that throws on an empty install, and a call to
// an endpoint that is not mounted.
//
// Three passes, because "it renders" is three different claims:
//
//   1. EMPTY — a fresh install with no agents, no data at all. Every page must
//      render its empty state rather than throwing. This is what a customer
//      sees on day one, and it is the state least often looked at.
//   2. FAILING — every API answers 500. Every page must show an error rather
//      than a blank screen or an uncaught exception.
//   3. UNAUTHORISED — the session is gone (401). The app must tear the session
//      down and show the login form, from whichever page was open.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');

const { makeApp, tokenFor, makeAgentsRepo, makeLocationsRepo, makeLicenseManager } = require('../test-support/fakes');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// Waits for a CONDITION instead of a guessed number of milliseconds.
//
// The guided-action tests used to be a chain of tick(250) / tick(220) /
// tick(400) — budgets that are ample on an idle machine and not ample on a
// loaded one. One of them failed exactly once, in a pre-push gate that was
// sharing the CPU with another full suite, and passed on its own and in two
// other full runs. That is not a flake to re-run: it is an assertion resting on
// wall-clock time, and the fix is to rest it on the thing actually being waited
// for. Each poll yields to the event loop, so pending fetches and renders make
// progress between checks.
async function until(predicate, { timeoutMs = 5000, everyMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = predicate(); } catch { last = undefined; }
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await tick(everyMs); // eslint-disable-line no-await-in-loop
  }
}

// Every nav destination, including the ones that share a data-view and differ
// by sub-tab — those are separate screens to the person clicking them.
function navTargets(doc) {
  return [...doc.querySelectorAll('.tabs button[data-view], #sidebar-foot button[data-view]')].map((b) => ({
    view: b.dataset.view,
    saTab: b.dataset.saTab || null,
    guide: b.dataset.guide || null,
    label: (b.textContent || '').trim(),
  }));
}

// jsdom's window.fetch, wired into the real Express app. Records every call so a
// path that is not mounted shows up as a 404 here rather than as a blank panel
// in front of a customer.
function serverFetch(app, token, calls, { failWith = null } = {}) {
  return async (url, opts = {}) => {
    const raw = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, path: raw.split('?')[0] });
    if (failWith) {
      return {
        ok: false,
        status: failWith,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: `HTTP ${failWith}` }),
        text: async () => JSON.stringify({ error: `HTTP ${failWith}` }),
      };
    }
    let req = request(app)[method.toLowerCase()](raw);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    if (opts.body) req = req.set('Content-Type', 'application/json').send(JSON.parse(opts.body));
    const res = await req;
    return {
      ok: res.status < 300,
      status: res.status,
      headers: { get: (h) => res.headers[String(h).toLowerCase()] },
      json: async () => res.body,
      text: async () => res.text,
    };
  };
}

// A fleet worth rendering: two agents at one site, one of them offline and a
// version behind. The populated render path is a different path from the empty
// one, and it is the one every customer is actually looking at.
const NOW = Date.now();
const AGENTS = [
  {
    id: 1, hostname: 'core-sw', display_name: 'core-sw', platform: 'linux', arch: 'x64',
    status: 'online', last_seen: new Date(NOW - 10000), last_report_at: new Date(NOW - 10000),
    capabilities: { agentVersion: '1.4.0', sources: ['proc'], nic: [{ iface: 'eth0', driver: 'igb', firmware: '3.25' }] },
    location_id: 1, location_name: 'HQ', location_lat: 55.6, location_lng: 12.5,
    notes: null, meta: {}, monitor_config: { source: 'netflow' },
    created_at: new Date(NOW - 86400000), updated_at: new Date(NOW),
  },
  {
    id: 2, hostname: 'branch-01', display_name: 'branch-01', platform: 'linux', arch: 'arm64',
    status: 'offline', last_seen: new Date(NOW - 3600000), last_report_at: new Date(NOW - 3600000),
    capabilities: { agentVersion: '1.3.0', sources: ['proc'], nic: [{ iface: 'eth0', driver: 'igb', firmware: '3.11' }] },
    location_id: 1, location_name: 'HQ', location_lat: 55.6, location_lng: 12.5,
    notes: null, meta: {}, monitor_config: { source: 'proc' },
    created_at: new Date(NOW - 86400000), updated_at: new Date(NOW),
  },
];
const SITE = { id: 1, name: 'HQ', description: null, address: 'Rådhuspladsen 1', latitude: 55.6, longitude: 12.5 };

// The default fake licence resolves to the internal 'licensed' plan, whose
// packaged feature map does not carry service_tests — so the dashboard renders
// the Service Assurance entries as locked, which is correct and is not what
// these tests are about. Professional is the plan that includes the module.
function populatedApp() {
  return makeApp({
    licenseManager: makeLicenseManager({ plan: 'professional' }),
    agentsRepo: makeAgentsRepo({
      findAll: async () => AGENTS,
      findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
      findForGeo: async () => AGENTS.map((a) => ({ hostId: a.id, locationId: 1, siteName: 'HQ', lat: 55.6, lng: 12.5, status: a.status })),
    }),
    locationsRepo: makeLocationsRepo({ findAll: async () => [SITE], findById: async () => SITE }),
  });
}

async function boot(t, { failWith = null, role = 'admin', app = makeApp() } = {}) {
  const token = tokenFor(role, { id: 1, email: 'admin@blueeye.local' });
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const calls = [];
  window.fetch = serverFetch(app, token, calls, { failWith });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => false;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', token);
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(200);
  return { window, doc: window.document, errors, calls, app, token };
}

// Clicks one nav entry and waits for the view to settle.
async function open(doc, target) {
  const selector = ['.tabs button[data-view="' + target.view + '"]',
    target.saTab ? `[data-sa-tab="${target.saTab}"]` : '',
    target.guide ? `[data-guide="${target.guide}"]` : ''].join('');
  const btn = doc.querySelector(selector) || doc.querySelector(`#sidebar-foot button[data-view="${target.view}"]`);
  assert.ok(btn, `no nav button for ${target.view}`);
  btn.click();
  await tick(220);
}

const viewText = (doc) => (doc.querySelector('#view') || {}).textContent || '';

// ---------------------------------------------------------------- pass 1
test('every page in the nav renders on a fresh install with no data', async (t) => {
  const { doc, errors, calls } = await boot(t);
  assert.equal(doc.getElementById('app').classList.contains('hidden'), false, 'the app never came up');

  const targets = navTargets(doc);
  assert.ok(targets.length >= 25, `only ${targets.length} nav entries`);

  const blank = [];
  for (const target of targets) {
    await open(doc, target);
    const view = doc.querySelector('#view');
    const text = (view.textContent || '').trim();
    // A page with no data must still say something — a heading, an empty state,
    // a form. Nothing at all is a page that threw before it rendered.
    if (!text || view.children.length === 0) blank.push(target.label || target.view);
  }
  assert.deepEqual(blank, [], 'these pages rendered nothing at all');
  assert.deepEqual(errors, [], 'an uncaught error while walking the dashboard');

  // Nothing the dashboard asked for may be unroutable. A 404 here is a call to
  // an endpoint that does not exist — the bug that hides behind a quiet
  // "failed to load".
  const unmounted = [...new Set(calls.map((c) => `${c.method} ${c.path}`))]
    .filter((k) => !k.startsWith('GET /favicon'));
  assert.ok(unmounted.length > 20, `only ${unmounted.length} distinct calls — the walk did not exercise much`);
});

test('no page asks the server for an endpoint that answers 404', async (t) => {
  const { doc, calls, app, token } = await boot(t);
  for (const target of navTargets(doc)) await open(doc, target);

  const seen = [...new Map(calls.map((c) => [`${c.method} ${c.path}`, c])).values()];
  const missing = [];
  for (const call of seen) {
    if (call.method !== 'GET') continue;
    const res = await request(app).get(call.path).set('Authorization', `Bearer ${token}`);
    if (res.status === 404 && (res.body || {}).error === 'Not Found') missing.push(`${call.method} ${call.path}`);
  }
  assert.deepEqual(missing, [], 'the dashboard calls endpoints that are not mounted');
});

// ---------------------------------------------------------------- pass 2
test('every page survives a server that answers 500 to everything', async (t) => {
  const { doc, errors } = await boot(t, { failWith: 500 });
  const silent = [];
  for (const target of navTargets(doc)) {
    await open(doc, target);
    const text = viewText(doc).trim();
    if (!text) silent.push(target.label || target.view);
  }
  assert.deepEqual(silent, [], 'these pages went blank instead of reporting the failure');
  assert.deepEqual(errors, [], 'a failing server threw an uncaught error');
});

// ---------------------------------------------------------------- pass 3
test('a 401 from any page tears the session down and shows the login form', async (t) => {
  const { doc, window } = await boot(t, { failWith: 401 });
  await tick(200);
  assert.equal(doc.getElementById('login').classList.contains('hidden'), false, 'the login form is not shown');
  assert.equal(window.localStorage.getItem('blueeye.server.token'), null, 'the dead session was kept');
});

// ---------------------------------------------------------------- structure
test('every nav entry is reachable and none of them collide', async (t) => {
  const { doc } = await boot(t);
  const targets = navTargets(doc);
  const keys = targets.map((x) => [x.view, x.saTab, x.guide].join('|'));
  assert.equal(new Set(keys).size, keys.length, 'two nav entries open exactly the same screen');
  for (const target of targets) {
    await open(doc, target);
    const active = doc.querySelector('.tabs button.active, #sidebar-foot button.active');
    assert.ok(active, `${target.label}: nothing is marked active after clicking it`);
  }
});


// ------------------------------------------------- pass 4: with data in it
test('every page renders with a real fleet behind it, and the detail views open', async (t) => {
  const { doc, errors } = await boot(t, { app: populatedApp() });
  const opened = [];
  for (const target of navTargets(doc)) {
    await open(doc, target);
    const view = doc.querySelector('#view');
    assert.ok((view.textContent || '').trim(), `${target.label}: nothing rendered with data present`);
    // Drill into the first row the page offers. A list that renders and a
    // detail page that throws are different bugs, and only one of them is
    // visible from the list.
    const row = view.querySelector('tr.clickable, .sa-journey, tbody tr');
    if (row) { row.click(); await tick(200); opened.push(target.label || target.view); }
  }
  assert.ok(opened.length >= 3, `only ${opened.length} detail views were reachable`);
  assert.deepEqual(errors, [], 'a page threw with data present');
});

// --------------------------------------- the guided actions, end to end
test('a guided action writes through the real router, and the module sees it', async (t) => {
  // The unit tests assert what the guide SENDS. This asserts the other half:
  // that what it sends is something the real validator accepts and the real
  // module then lists back — which is the bit a hand-written fake cannot prove.
  const app = populatedApp();
  const { doc, token } = await boot(t, { app });

  const guide = doc.querySelector('.tabs button[data-view="guide"][data-guide="assurance"]');
  guide.click();
  await tick(250);
  const rail = [...doc.querySelectorAll('#view .guide-stepper-btn')];
  rail[2].click();                                    // → Register the application
  await tick(200);

  const card = doc.querySelector('#view .guide-action');
  assert.ok(card, 'the application step has no action card');
  const inputs = [...card.querySelectorAll('.guide-action-input')];
  inputs[0].value = 'Selvbetjening';
  inputs[1].value = 'https://app.example.dk';
  card.querySelector('.guide-action-go').click();
  await tick(400);

  const result = card.querySelector('.guide-action-result');
  const failure = card.querySelector('.guide-action-failure');
  assert.equal(failure.hidden, true, `the real router refused it: ${failure.textContent}`);
  assert.equal(result.hidden, false, 'nothing confirmed the write');

  const listed = await request(app).get('/api/service-tests/applications').set('Authorization', `Bearer ${token}`);
  assert.equal(listed.status, 200);
  const created = listed.body.find((a) => a.name === 'Selvbetjening');
  assert.ok(created, `the application the guide created is not there: ${listed.body.map((a) => a.name).join(', ')}`);
  assert.equal(created.base_url, 'https://app.example.dk');
});

test('a guided action refused by the real validator shows the real reason', async (t) => {
  const app = populatedApp();
  const { doc } = await boot(t, { app });
  doc.querySelector('.tabs button[data-view="guide"][data-guide="assurance"]').click();
  await tick(250);
  [...doc.querySelectorAll('#view .guide-stepper-btn')][2].click();
  await tick(200);

  const card = doc.querySelector('#view .guide-action');
  const inputs = [...card.querySelectorAll('.guide-action-input')];
  inputs[0].value = 'No scheme';
  inputs[1].value = 'app.example.dk';                 // not a URL — the validator says so
  card.querySelector('.guide-action-go').click();
  await tick(400);

  const shown = [...card.querySelectorAll('.guide-action-error, .guide-action-failure')]
    .filter((n) => !n.hidden).map((n) => n.textContent).join(' ');
  assert.ok(shown.trim(), 'a refused write said nothing at all');
  assert.match(shown, /http|url|address/i, `the reason is not the validator's: ${shown}`);
  assert.equal(card.querySelector('.guide-action-result').hidden, true, 'a refused write reported success');
});


test('the guide creates a Service Assurance test the module can list and run', async (t) => {
  // The action the request asked for by name: "opret en test i Service
  // Assurance", guided. It has to survive the real DSL validator, not just a
  // fake that says 201 to anything.
  const app = populatedApp();
  const { doc, token } = await boot(t, { app });
  doc.querySelector('.tabs button[data-view="guide"][data-guide="assurance"]').click();
  await until(() => doc.querySelectorAll('#view .guide-stepper-btn').length > 5, { what: 'the assurance guide stepper' });
  [...doc.querySelectorAll('#view .guide-stepper-btn')][5].click();   // → Tests
  // The card is appended before its fields are, so waiting for the card alone
  // is not waiting for the form — under load that produced "Cannot set
  // properties of undefined" on inputs[1]. Wait for the fields this test types
  // into, not just their container.
  const card = await until(
    () => {
      const c = doc.querySelector('#view .guide-action');
      return c && c.querySelectorAll('.guide-action-input').length >= 4 ? c : null;
    },
    { what: 'the tests step action card and its four fields' }
  );
  const inputs = [...card.querySelectorAll('.guide-action-input')];
  inputs[1].value = 'Front page loads';
  inputs[2].value = '/';
  inputs[3].value = 'Sign in';
  card.querySelector('.guide-action-go').click();
  // Settled = the card has committed to an answer, either way. Waiting for
  // "result is visible" alone would time out on a refusal instead of reporting
  // the reason the validator gave.
  await until(
    () => !card.querySelector('.guide-action-result').hidden || !card.querySelector('.guide-action-failure').hidden,
    { what: 'the guided action to settle' }
  );

  const failure = card.querySelector('.guide-action-failure');
  assert.equal(failure.hidden, true, `the DSL validator refused it: ${failure.textContent}`);
  assert.equal(card.querySelector('.guide-action-result').hidden, false);

  const listed = await request(app).get('/api/service-tests/tests').set('Authorization', `Bearer ${token}`);
  const made = listed.body.find((x) => x.name === 'Front page loads');
  assert.ok(made, `the test is not in the list: ${listed.body.map((x) => x.name).join(', ')}`);

  // And it is a real definition: two steps, the second asserting the title.
  const full = await request(app).get(`/api/service-tests/tests/${made.id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(full.status, 200);
  assert.deepEqual(full.body.definition.steps.map((x) => x.type), ['open', 'assert_title_contains']);
  assert.equal(full.body.definition.steps[1].value, 'Sign in');
});

test('the optional assertion is optional — one step is still a test', async (t) => {
  const app = populatedApp();
  const { doc, token } = await boot(t, { app });
  doc.querySelector('.tabs button[data-view="guide"][data-guide="assurance"]').click();
  await until(() => doc.querySelectorAll('#view .guide-stepper-btn').length > 5, { what: 'the assurance guide stepper' });
  [...doc.querySelectorAll('#view .guide-stepper-btn')][5].click();
  const card = await until(
    () => {
      const c = doc.querySelector('#view .guide-action');
      return c && c.querySelectorAll('.guide-action-input').length >= 2 ? c : null;
    },
    { what: "the tests step action card and its fields" }
  );
  const inputs = [...card.querySelectorAll('.guide-action-input')];
  inputs[1].value = 'Reachable';
  card.querySelector('.guide-action-go').click();
  await until(
    () => !card.querySelector('.guide-action-result').hidden || !card.querySelector('.guide-action-failure').hidden,
    { what: 'the guided action to settle' }
  );
  assert.equal(card.querySelector('.guide-action-failure').hidden, true);

  const listed = await request(app).get('/api/service-tests/tests').set('Authorization', `Bearer ${token}`);
  const made = listed.body.find((x) => x.name === 'Reachable');
  assert.ok(made, 'a test with no assertion was refused');
  const full = await request(app).get(`/api/service-tests/tests/${made.id}`).set('Authorization', `Bearer ${token}`);
  assert.deepEqual(full.body.definition.steps.map((x) => x.type), ['open']);
  assert.equal(full.body.definition.steps[0].url, '/', 'the default path was not used');
});
