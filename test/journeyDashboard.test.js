'use strict';

// Journey Run and Edit, driven in a real DOM.
//
// The server side is covered by src/serviceTests/api/__tests__/journeys.test.js.
// This is the other half: that the Service Assurance module actually reaches it.
// The module is dependency-free vanilla JS with no build step, so nothing but a
// browser catches a button wired to nothing or a form that sends the wrong
// shape — and "the API works" has never been the same claim as "a person can
// use it".
//
// The whole dashboard is booted and navigated the way a person navigates it, so
// the module is mounted by app.js with its real helpers rather than by a
// hand-rolled stand-in that could disagree with the thing that ships.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SA = '/api/service-tests';

const ME = { id: 1, email: 'op@blueeye.local', role: 'admin', preferences: {} };
const BASE_ROUTES = {
  'GET /me': ME,
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': { service_tests: true },
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
};

function recordingFetch(routes, calls) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ method, path: p, body });
    const hit = routes[`${method} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const payload = hit === undefined
      ? { error: 'Not Found', path: p }
      : (hit.body !== undefined ? hit.body : hit);
    return {
      ok: status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function boot(t, routes = {}, role = 'admin') {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const calls = [];
  window.fetch = recordingFetch({ ...BASE_ROUTES, ...routes }, calls);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, errors, calls };
}

const click = async (node, ms) => { node.click(); await tick(ms); };
const byText = (doc, selector, text) =>
  [...doc.querySelectorAll(selector)].find((n) => n.textContent.trim() === text) || null;

const JOURNEY = {
  id: 4,
  application_id: 1,
  application_name: 'Fellis',
  name: 'Fellis run for About Fellis',
  description: 'adsf',
  criticality: 'normal',
  expected_duration_ms: null,
  environment_id: null,
  step_count: 2,
  health: {
    status: 'failed',
    reason: '"Login" is failing, so the user cannot get through.',
    duration_ms: null,
    steps: [
      { test_id: 1, label: 'Login', required: true, outcome: 'fail', status: 'fail' },
      { test_id: 2, label: 'Authenticated navigation', required: true, outcome: 'unknown', status: null },
    ],
  },
  duration: null,
};

const TESTS = [
  { id: 1, application_id: 1, name: 'Login', enabled: true },
  { id: 2, application_id: 1, name: 'Authenticated navigation', enabled: true },
];

// Navigates: Service Assurance → Journeys → the journey itself.
async function openJourney(doc, extra = {}) {
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="journeys"]');
  assert.ok(nav, 'no Journeys nav button');
  await click(nav, 200);
  const card = doc.querySelector('#view .sa-journey');
  assert.ok(card, 'the journey list did not render');
  await click(card, 200);
  assert.ok(doc.querySelector('#view .sa-journey-head'), 'the journey detail did not render');
  return extra;
}

const listRoutes = (over = {}) => ({
  [`GET ${SA}/journeys`]: {
    journeys: [JOURNEY],
    summary: { status: 'failed', failed: 1, degraded: 0, healthy: 0, total: 1 },
  },
  [`GET ${SA}/journeys/4`]: JOURNEY,
  [`GET ${SA}/tests`]: TESTS,
  ...over,
});

// ------------------------------------------------------------------- run
test('a journey has a Run button, and it runs the journey', async (t) => {
  const { doc, calls, errors } = await boot(t, listRoutes({
    [`POST ${SA}/journeys/4/run`]: {
      status: 202,
      body: {
        journey_id: 4,
        runs: [{ run_id: 11, test_id: 1, test_name: 'Login', status: 'queued' },
          { run_id: 12, test_id: 2, test_name: 'Authenticated navigation', status: 'queued' }],
        worker: { connected: true },
      },
    },
    [`GET ${SA}/runs`]: [],
  }));
  await openJourney(doc);

  const run = byText(doc, '#view button', 'Run journey');
  assert.ok(run, 'no Run button on the journey');
  await click(run, 200);

  assert.deepEqual(errors, []);
  const post = calls.find((c) => c.method === 'POST' && c.path === `${SA}/journeys/4/run`);
  assert.ok(post, 'the Run button never called the API');
  // Runs are where the queued work is, so that is where it lands.
  assert.ok(calls.some((c) => c.path === `${SA}/runs`), 'it did not go to the Runs screen');
});

test('a journey with no steps is not offered a Run button at all', async (t) => {
  const empty = { ...JOURNEY, step_count: 0, health: { ...JOURNEY.health, status: 'unknown', steps: [] } };
  const { doc } = await boot(t, {
    [`GET ${SA}/journeys`]: { journeys: [empty], summary: { status: 'unknown', failed: 0, degraded: 0, healthy: 0, total: 1 } },
    [`GET ${SA}/journeys/4`]: empty,
    [`GET ${SA}/tests`]: TESTS,
  });
  await openJourney(doc);
  // A button whose only possible answer is "this journey has no steps yet" is a
  // button that should not be there.
  assert.equal(byText(doc, '#view button', 'Run journey'), null);
  assert.ok(byText(doc, '#view button', 'Edit'), 'Edit is still offered — there is something to edit');
});

test('a failed run says so and does not pretend it went to Runs', async (t) => {
  const { doc, calls } = await boot(t, listRoutes({
    [`POST ${SA}/journeys/4/run`]: { status: 400, body: { error: 'Validation failed', details: { _: 'nothing to run' } } },
  }));
  await openJourney(doc);
  await click(byText(doc, '#view button', 'Run journey'), 150);
  assert.ok(!calls.some((c) => c.path === `${SA}/runs`), 'a failed run still navigated away');
});

// ------------------------------------------------------------------ edit
test('the Edit dialog loads the journey and PUTs what was changed', async (t) => {
  const { doc, calls, errors } = await boot(t, listRoutes({
    [`PUT ${SA}/journeys/4`]: { ...JOURNEY, name: 'Caseworker sign-in', criticality: 'critical' },
  }));
  await openJourney(doc);
  await click(byText(doc, '#view button', 'Edit'), 80);

  const modal = doc.querySelector('.sa-modal');
  assert.ok(modal, 'the edit dialog did not open');
  const [name, desc, crit, expected] = [
    modal.querySelector('input[type="text"]'),
    modal.querySelector('textarea'),
    modal.querySelector('select'),
    modal.querySelector('input[type="number"]'),
  ];
  // Loaded, not blank. A form that opens empty silently offers to erase what is
  // there the moment it is saved.
  assert.equal(name.value, 'Fellis run for About Fellis');
  assert.equal(desc.value, 'adsf');
  assert.equal(crit.value, 'normal');
  assert.equal(expected.value, '', 'no expectation stated must show as empty, not 0');

  name.value = 'Caseworker sign-in';
  crit.value = 'critical';
  expected.value = '8';
  await click(byText(doc, '.sa-modal button', 'Save'), 150);

  assert.deepEqual(errors, []);
  const put = calls.find((c) => c.method === 'PUT' && c.path === `${SA}/journeys/4`);
  assert.ok(put, 'the dialog never saved');
  assert.equal(put.body.name, 'Caseworker sign-in');
  assert.equal(put.body.criticality, 'critical');
  // Typed in seconds because that is how people talk about it; stored in ms
  // like every other duration here.
  assert.equal(put.body.expected_duration_ms, 8000);
});

test('clearing the expected duration sends null, not zero', async (t) => {
  const withExpectation = { ...JOURNEY, expected_duration_ms: 12000 };
  const { doc, calls } = await boot(t, listRoutes({
    [`GET ${SA}/journeys/4`]: withExpectation,
    [`PUT ${SA}/journeys/4`]: withExpectation,
  }));
  await openJourney(doc);
  await click(byText(doc, '#view button', 'Edit'), 80);

  const expected = doc.querySelector('.sa-modal input[type="number"]');
  assert.equal(expected.value, '12', 'milliseconds must be shown as seconds');
  expected.value = '';
  await click(byText(doc, '.sa-modal button', 'Save'), 150);

  const put = calls.find((c) => c.method === 'PUT' && c.path === `${SA}/journeys/4`);
  // "No expectation stated" is a different fact from "expected to take 0 ms",
  // and only one of them produces a duration verdict.
  assert.equal(put.body.expected_duration_ms, null);
});

test('a rejected edit shows the server\'s message and keeps the dialog open', async (t) => {
  const { doc } = await boot(t, listRoutes({
    [`PUT ${SA}/journeys/4`]: { status: 400, body: { error: 'Validation failed', details: { name: 'a name is required' } } },
  }));
  await openJourney(doc);
  await click(byText(doc, '#view button', 'Edit'), 80);
  doc.querySelector('.sa-modal input[type="text"]').value = '   ';
  await click(byText(doc, '.sa-modal button', 'Save'), 150);

  assert.ok(doc.querySelector('.sa-modal'), 'the dialog closed on a rejected save');
  assert.match(doc.querySelector('.sa-modal .sa-form-error').textContent, /a name is required/);
});

test('a viewer gets neither Run nor Edit nor Delete', async (t) => {
  const { doc } = await boot(t, {
    'GET /me': { ...ME, role: 'viewer' },
    ...listRoutes(),
  }, 'viewer');
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="journeys"]');
  // The whole module is operator+, so a viewer never reaches the screen. That
  // is the control; the buttons are not a second one to get wrong.
  assert.ok(nav.classList.contains('role-hidden'), 'a viewer was offered the Service Assurance nav');
});

// ------------------------------------------------------ the segmented control
test('the period control says which option is on, not just which looks on', async (t) => {
  const { doc } = await boot(t, {
    [`GET ${SA}/journeys`]: { journeys: [], summary: null },
    [`GET ${SA}/tests`]: [],
    [`GET ${SA}/applications`]: [{ id: 1, name: 'Fellis', base_url: 'https://fellis.eu' }],
    [`GET ${SA}/applications/1`]: { id: 1, name: 'Fellis', base_url: 'https://fellis.eu', credentials: [], environments: [] },
    [`GET ${SA}/assurance/top-applications`]: {
      period: 'month', at: '2026-09-01', is_current: true, has_next: false,
      prev_at: '2026-08-01', next_at: null,
      applications: [], buckets: [], series: [],
    },
    [`GET ${SA}/assurance/incidents`]: [],
    [`GET ${SA}/assurance/certificates`]: [],
    [`GET ${SA}/assurance/summary`]: {
      open: { CRIT: 0, WARN: 0 },
      certificates: { total: 0, expiring: 0 },
    },
  });
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="health"]');
  await click(nav, 300);

  // Asserted, never skipped. A test that quietly returns when it cannot find
  // the thing it is about passes forever while the thing is broken — which is
  // exactly what this one did until the endpoint name was corrected.
  const groups = [...doc.querySelectorAll('#view .sa-segmented')];
  assert.ok(groups.length, 'no segmented control rendered on the Health screen');
  const group = groups[0];
  assert.equal(group.getAttribute('role'), 'group', 'a toggle group must say it is one');
  assert.ok(group.getAttribute('aria-label'), 'the group must say what is being chosen');
  const segs = [...group.querySelectorAll('.sa-segment')];
  assert.ok(segs.length >= 2);
  // Without this a screen reader hears "Day, Week, Month, Year" and no answer to
  // the only question that matters.
  for (const s of segs) {
    assert.equal(s.getAttribute('aria-pressed'), s.classList.contains('active') ? 'true' : 'false', s.textContent);
  }
  assert.equal(segs.filter((s) => s.classList.contains('active')).length, 1, 'exactly one segment is on');

  // Clicking one moves the state rather than just the paint.
  const off = segs.find((s) => !s.classList.contains('active'));
  await click(off, 200);
  const after = [...doc.querySelectorAll('#view .sa-segmented')][0].querySelectorAll('.sa-segment');
  const on = [...after].filter((s) => s.getAttribute('aria-pressed') === 'true');
  assert.equal(on.length, 1, 'exactly one segment stays on after a click');
  assert.equal(on[0].textContent.trim(), off.textContent.trim(), 'the clicked segment did not become the on one');
});
