'use strict';

// The V3 intelligence layer, driven in a real DOM.
//
// The API specs cover the routes and the pure specs cover the reasoning. This is
// the third thing neither can claim: that a person looking at a failed run is
// actually shown why, and — more importantly — is shown the difference between
// what BlueEyes SAW and what it is only supposing.
//
// That distinction is the whole feature. A watched TLS failure and a supposed
// database sit at the same percentage and are not the same kind of claim. If the
// screen renders them identically, the pure module's honesty was for nothing.

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
    calls.push({ method, path: p });
    const hit = routes[`${method} ${p}`];
    // `hit.status` is the HTTP status ONLY when it is a number. These payloads
    // carry a `status` of their own — a run is 'fail', a service is 'DEGRADED' —
    // and reading that as the HTTP status turned every successful response into
    // a failed fetch. Silently: the screen showed its "could not be loaded"
    // branch, which looks like a rendering bug and is a fixture bug.
    const status = (hit && typeof hit.status === 'number') ? hit.status : (hit === undefined ? 404 : 200);
    const payload = hit === undefined ? { error: 'Not Found', path: p } : (hit.body !== undefined ? hit.body : hit);
    return {
      ok: status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

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

// ------------------------------------------------------------ the fixtures
const RUN = {
  id: 21, test_id: 1, test_name: 'Customer search', status: 'fail',
  duration_ms: 4200, failure_kind: 'http_500', error_message: 'HTTP 500',
  steps: [{ position: 0, label: 'Search', status: 'fail', duration_ms: 4000, message: 'HTTP 500', detail: {} }],
  console_errors: [], network_errors: [], api_calls: [],
};

const ANALYSIS = {
  run: { id: 21, test_id: 1, status: 'fail', ended_at: null },
  observations: [],
  layers: {},
  correlation: {
    layer: 'api',
    conclusion: 'Likely an application or API problem',
    confidence: 68,
    chain: [
      { step: 'Search failed', layer: 'browser', outcome: 'bad', detail: null },
      { step: 'GET /api/search → HTTP 500', layer: 'api', outcome: 'bad', detail: null },
      { step: 'network reachable — /api/me answered', layer: 'network', outcome: 'ok', detail: null },
      { step: 'infrastructure was not checked', layer: 'infrastructure', outcome: 'unknown', detail: null },
    ],
    failed: ['api'], ruled_out: ['network'], not_checked: ['infrastructure'],
    evidence: [], source: 'rules',
  },
  correlation_summary: 'Likely an application or API problem (68% confident). infrastructure was not checked.',
  root_cause: {
    candidates: [
      {
        cause: 'api', label: 'One API endpoint', layer: 'api', basis: 'observed',
        likelihood: 48, capped: false,
        why: ['1 call failed while 2 others answered normally'],
        next_step: 'Look at that endpoint alone. Its neighbours answered.',
      },
      {
        cause: 'database', label: 'The database behind the application', layer: 'application',
        basis: 'unobservable', likelihood: 25, capped: false,
        why: ['a 500 alongside a timeout is often a slow query, but nothing here observed one'],
        next_step: 'BlueEyes cannot see a database from a browser — this is a place to look, not a finding.',
      },
    ],
    top: null, runner_up: null, gap: 23, decisive: true,
    summary: 'Most likely one api endpoint (48% — an assessment, not a fact). infrastructure was not checked.',
    supposed: ['database'], not_checked: ['infrastructure'], source: 'rules',
  },
  observations_from: 'stored',
};
ANALYSIS.root_cause.top = ANALYSIS.root_cause.candidates[0];
ANALYSIS.root_cause.runner_up = ANALYSIS.root_cause.candidates[1];

const runRoutes = (over = {}) => ({
  [`GET ${SA}/runs`]: [RUN],
  [`GET ${SA}/runs/worker-status`]: { connected: true, queued: 0, last_claim_at: null },
  [`GET ${SA}/runs/21`]: RUN,
  [`GET ${SA}/analysis/runs/21`]: ANALYSIS,
  ...over,
});

async function openRun(doc) {
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="runs"]');
  assert.ok(nav, 'no Runs nav button');
  await click(nav, 300);
  const row = doc.querySelector('#view tbody tr');
  assert.ok(row, 'the runs list did not render');
  await click(row, 500);
}

// -------------------------------------------------------- why it failed
test('a failed run shows the chain, including what nobody checked', async (t) => {
  const { doc, errors } = await boot(t, runRoutes());
  await openRun(doc);

  const panel = doc.querySelector('#view .sa-why');
  assert.ok(panel, 'no "why did this fail?" panel');
  assert.match(panel.textContent, /Likely an application or API problem/);

  const links = panel.querySelectorAll('.sa-chain-link');
  assert.equal(links.length, 4);
  // The three outcomes have to be tellable apart. A conclusion drawn while the
  // network was never checked has a hole in it, and the hole belongs on screen.
  assert.equal(panel.querySelectorAll('.sa-chain-bad').length, 2);
  assert.equal(panel.querySelectorAll('.sa-chain-ok').length, 1);
  assert.equal(panel.querySelectorAll('.sa-chain-unknown').length, 1);
  assert.match(panel.querySelector('.sa-chain-unknown').textContent, /was not checked/);
  assert.deepEqual(errors, []);
});

test('a supposed cause is marked differently from one that was seen', async (t) => {
  // The point of the whole layer. Rendering both as "25%" and "48%" with nothing
  // else to separate them says they are the same kind of claim.
  const { doc, errors } = await boot(t, runRoutes());
  await openRun(doc);

  const causes = doc.querySelectorAll('#view .sa-cause');
  assert.equal(causes.length, 2);
  assert.ok(causes[0].querySelector('.sa-basis-observed'), 'the seen cause is not marked as seen');
  assert.ok(causes[1].querySelector('.sa-basis-unobservable'), 'the supposed cause is not marked as supposed');
  assert.match(causes[1].textContent, /not visible to BlueEyes/);
  assert.match(causes[1].textContent, /a place to look, not a finding/);
  assert.deepEqual(errors, []);
});

test('every cause shows its evidence and what to check next', async (t) => {
  const { doc } = await boot(t, runRoutes());
  await openRun(doc);
  for (const cause of doc.querySelectorAll('#view .sa-cause')) {
    assert.ok(cause.querySelector('.sa-cause-why li'), 'a ranking with no evidence is a number to argue with');
    assert.ok(cause.querySelector('.sa-cause-next').textContent.length > 20, 'nothing to do about it');
  }
});

test('a passing run is not offered an explanation it does not need', async (t) => {
  const passing = { ...RUN, status: 'pass', steps: [{ position: 0, label: 'Search', status: 'pass', duration_ms: 900, detail: {} }] };
  const { doc, calls } = await boot(t, {
    ...runRoutes(),
    [`GET ${SA}/runs`]: [passing],
    [`GET ${SA}/runs/21`]: passing,
  });
  await openRun(doc);
  assert.equal(doc.querySelector('#view .sa-why'), null);
  assert.ok(!calls.some((c) => c.path.includes('/analysis/runs/')), 'it asked anyway');
});

test('an analysis that will not load leaves the run readable', async (t) => {
  // The run's own result, steps and failure are what the operator came for. A
  // second request failing must not take them off the screen.
  const { doc, errors } = await boot(t, runRoutes({ [`GET ${SA}/analysis/runs/21`]: { status: 500, body: { error: 'boom' } } }));
  await openRun(doc);
  assert.ok(doc.querySelector('#view .sa-why'), 'the panel vanished instead of saying so');
  assert.match(doc.querySelector('#view .sa-why').textContent, /could not be loaded/);
  assert.ok(doc.querySelectorAll('#view table.data-table tbody tr').length, 'the steps went with it');
  assert.deepEqual(errors, []);
});

test('a run with nothing underneath it says so rather than showing an empty panel', async (t) => {
  const { doc } = await boot(t, runRoutes({
    [`GET ${SA}/analysis/runs/21`]: { ...ANALYSIS, correlation: null, root_cause: null },
  }));
  await openRun(doc);
  assert.match(doc.querySelector('#view .sa-why').textContent, /nothing to conclude from/);
});

test('an analysis rebuilt from the stored run says which it is', async (t) => {
  const { doc } = await boot(t, runRoutes({
    [`GET ${SA}/analysis/runs/21`]: { ...ANALYSIS, observations_from: 'derived' },
  }));
  await openRun(doc);
  assert.match(doc.querySelector('#view .sa-why').textContent, /Worked out from the stored run/);
});

// ------------------------------------------------------------ health score
const APP = {
  id: 1, name: 'Kundeportal', base_url: 'https://portal.kunde.dk', enabled: true,
  environments: [], credentials: [], allowed_hosts: [], last_discovery: null,
  login_form_found: false, login_tests: [],
};

const HEALTH = {
  application: { id: 1, name: 'Kundeportal' },
  status: 'DEGRADED', score: 74,
  reason: 'Find customer is failing.',
  reasons: ['Find customer is failing.'],
  parts: {
    functional: { status: 'DEGRADED', reason: 'Find customer is failing.', score: 60 },
    availability: { status: 'HEALTHY', reason: 'The service is reachable.', score: 100 },
    api: { status: 'DEGRADED', reason: 'An API call failed.', score: 60 },
    // The one that matters: nobody measured it, and it must not read as zero.
    performance: { status: 'UNKNOWN', reason: 'No timings yet.', score: null },
  },
  weights: { functional: 0.45, availability: 0.25, api: 0.2, performance: 0.1 },
  layers: {}, open_incidents: 2,
  observed_from: { window_hours: 24, observations: 12, journeys: 1, note: 'x' },
};

const DEPS = {
  application: { id: 1, name: 'Kundeportal' },
  shared: [{
    endpoint: 'endpoint:portal.kunde.dk/api/auth', label: '/api/auth', host: 'portal.kunde.dk',
    third_party: false, methods: ['POST'], journeys: [], journey_count: 3, share: 1,
    blast_weight: 9, blast: 'critical', observations: 6, failures: 2, failure_rate: 0.33,
    status: 'failing', summary: '3 journeys depend on /api/auth. It has failed 2 times.',
  }],
  failing: [], unobserved_journeys: [{ id: 4, label: 'Refund', criticality: 'high' }],
  counts: { journeys: 4, journeys_observed: 3, endpoints: 5, shared: 1, failing: 1 },
  summary: 'Multiple journeys affected by the same dependency. /api/auth is failing and 3 journeys depend on it.',
  source: 'rules',
};

const appRoutes = (over = {}) => ({
  [`GET ${SA}/applications`]: [{ id: 1, name: 'Kundeportal', base_url: 'https://portal.kunde.dk', enabled: true, test_count: 2 }],
  [`GET ${SA}/applications/1`]: APP,
  [`GET ${SA}/tests`]: [],
  [`GET ${SA}/analysis/applications/1/health`]: HEALTH,
  [`GET ${SA}/analysis/applications/1/dependencies`]: DEPS,
  ...over,
});

async function openApplication(doc) {
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="applications"]');
  await click(nav, 300);
  const row = doc.querySelector('#view tbody tr');
  assert.ok(row, 'the application list did not render');
  await click(row, 500);
}

test('the health score is shown with every part it is made of', async (t) => {
  // A black-box score is worse than no score: the operator has to be able to see
  // why it is 74.
  const { doc, errors } = await boot(t, appRoutes());
  await openApplication(doc);

  const score = doc.querySelector('#view .sa-health-number');
  assert.ok(score, 'no score at all');
  assert.equal(score.textContent, '74');
  const parts = doc.querySelectorAll('#view .sa-health-part');
  assert.equal(parts.length, 4, 'the parts are the feature');
  for (const part of parts) {
    assert.ok(part.querySelector('.sa-health-part-reason').textContent.length, 'a part with no reason');
    assert.match(part.querySelector('.sa-health-weight').textContent, /counts for \d+%/);
  }
  assert.deepEqual(errors, []);
});

test('a part nobody measured says so rather than showing a zero', async (t) => {
  // Zero is the bad end of the scale. An unmeasured part rendered as 0% is a
  // service reported as broken because nobody looked at it.
  const { doc } = await boot(t, appRoutes());
  await openApplication(doc);
  const parts = [...doc.querySelectorAll('#view .sa-health-part')];
  const performance = parts.find((p) => /Speed/.test(p.textContent));
  assert.ok(performance);
  // Asserted on the SCORE cell, not the whole row — the weight beside it reads
  // "counts for 10%", which a looser pattern matches.
  const cell = performance.querySelector('.sa-health-part-score').textContent;
  assert.match(cell, /not measured/);
  assert.ok(!/%/.test(cell), `an unmeasured part rendered a percentage: ${cell}`);
});

test('a service nothing has run against shows a dash, not a zero', async (t) => {
  const { doc } = await boot(t, appRoutes({
    [`GET ${SA}/analysis/applications/1/health`]: {
      ...HEALTH, status: 'UNKNOWN', score: null,
      reason: 'Nothing has run against this service yet.',
      parts: { functional: { status: 'UNKNOWN', reason: 'No journeys have run yet.', score: null } },
    },
  }));
  await openApplication(doc);
  assert.equal(doc.querySelector('#view .sa-health-number').textContent, '—');
  assert.match(doc.querySelector('#view .sa-health-reason').textContent, /Nothing has run/);
});

test('a health score that will not load leaves the rest of the screen', async (t) => {
  const { doc, errors } = await boot(t, appRoutes({
    [`GET ${SA}/analysis/applications/1/health`]: { status: 500, body: { error: 'boom' } },
  }));
  await openApplication(doc);
  assert.match(doc.querySelector('#view .sa-panel').textContent, /could not be loaded/);
  assert.ok(byText(doc, '#view button', 'Discover'), 'the rest of the application screen went with it');
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------------ dependencies
test('a shared dependency is shown with its reach, and a failing one is marked', async (t) => {
  const { doc, errors } = await boot(t, appRoutes());
  await openApplication(doc);

  const dep = doc.querySelector('#view .sa-dep');
  assert.ok(dep, 'no shared dependency on screen');
  assert.match(dep.textContent, /\/api\/auth/);
  assert.match(dep.textContent, /critical reach/);
  assert.ok(dep.classList.contains('sa-dep-failing'));
  assert.match(dep.textContent, /failing/);
  assert.deepEqual(errors, []);
});

test('journeys that never ran are named, so a short list is not read as a complete one', async (t) => {
  const { doc } = await boot(t, appRoutes());
  await openApplication(doc);
  const panel = [...doc.querySelectorAll('#view .sa-panel')].find((p) => /Shared dependencies/.test(p.textContent));
  assert.ok(panel);
  assert.match(panel.textContent, /Never run, so what they depend on is unknown: Refund/);
});

test('an address the application does not own is marked as not theirs', async (t) => {
  const { doc } = await boot(t, appRoutes({
    [`GET ${SA}/analysis/applications/1/dependencies`]: {
      ...DEPS,
      shared: [{ ...DEPS.shared[0], third_party: true, host: 'betaling.tredjepart.dk', label: '/charge' }],
    },
  }));
  await openApplication(doc);
  assert.match(doc.querySelector('#view .sa-dep').textContent, /not yours/);
});

test('with no base address nothing is claimed about who owns the host', async (t) => {
  // null is "we were not told", not "no". Rendering it as "yours" would be an
  // answer nobody gave.
  const { doc } = await boot(t, appRoutes({
    [`GET ${SA}/analysis/applications/1/dependencies`]: {
      ...DEPS, shared: [{ ...DEPS.shared[0], third_party: null }],
    },
  }));
  await openApplication(doc);
  assert.ok(!/not yours/.test(doc.querySelector('#view .sa-dep').textContent));
});
