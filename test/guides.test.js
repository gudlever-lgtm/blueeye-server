'use strict';

// The five in-app guides, driven in a real DOM.
//
// Two things are being checked, and they are different claims:
//
//   1. They work as walkthroughs — each nav entry mounts its own guide, every
//      one of its steps renders, Next and Back move between them, and the
//      live-state lines say what the API actually answered.
//   2. It is TRUE — the numbers it quotes are the code's numbers. A guide is
//      worth having only while it is true (the same reason
//      test/guideAccuracy.test.js exists for the written one), except that this
//      one is on screen, where being wrong costs an operator an afternoon.
//
// And the case that matters most in a read-only guide: when the state probes
// fail — 403 without the licence, 404 for an endpoint that moved, 500 — the
// guidance must survive. The garnish can fail; the document cannot.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const { SCORE_WEIGHTS } = require('../src/serviceTests/health/serviceHealth');
const {
  NUMBER_BOUNDS, BOOLEAN_FIELDS, ENUM_FIELDS, allDefaults, defaultsFor,
} = require('../src/serviceTests/settings/defaults');
const I18n = require('../public/i18n');

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

// Effective settings + defaults, the shape GET /settings returns.
function settingsPayload(overrides = {}) {
  // The module's own defaults, rather than three of its four tables rebuilt
  // here: a settings section can also carry a text field (the mail-probe
  // recipient allowlist is one), and a fixture that silently lacks it makes the
  // guide's "Yours" column read as unset for a setting the server does send.
  const defaults = allDefaults();
  const settings = JSON.parse(JSON.stringify(defaults));
  for (const [section, fields] of Object.entries(overrides)) {
    settings[section] = { ...(settings[section] || {}), ...fields };
  }
  return { settings, defaults };
}

function fullRoutes(over = {}) {
  return {
    [`GET ${SA}/runs/worker-status`]: { connected: true, worker_count: 2, queued: 0, last_seen_at: null },
    [`GET ${SA}/applications`]: [
      { id: 1, name: 'Selvbetjening', base_url: 'https://app.example.dk', test_count: 2, environment_count: 1, last_discovery: { id: 3, ended_at: '2026-01-01T10:00:00Z' } },
    ],
    [`GET ${SA}/applications/1`]: { id: 1, name: 'Selvbetjening', allowed_hosts: [{ id: 1, entry_type: 'host', value: 'api.example.dk' }] },
    [`GET ${SA}/tests`]: [{ id: 1, name: 'Login', application_id: 1, enabled: true }],
    [`GET ${SA}/tests/step-types`]: { categories: [{ category: 'navigation', steps: [{ type: 'open' }, { type: 'click' }] }, { category: 'assert', steps: [{ type: 'assert_text_contains' }] }] },
    [`GET ${SA}/journeys`]: { journeys: [{ id: 4, name: 'Find a customer' }], summary: { status: 'healthy', total: 1 } },
    [`GET ${SA}/schedules`]: [{ id: 7, test_id: 1, interval_sec: 300, enabled: true }],
    [`GET ${SA}/runs`]: [{ id: 11, test_id: 1, status: 'pass' }],
    [`GET ${SA}/settings`]: settingsPayload(),
    [`GET ${SA}/assurance/summary`]: { open: { crit: 0, warn: 0, info: 0 }, certificates: { total: 1, expiring: 0, broken: 0 } },
    ...over,
  };
}

function recordingFetch(routes, calls, bodies = {}) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    calls.push(`${method} ${p}`);
    // What was SENT, not only that something was: an action card that posts the
    // wrong shape still records the call, and "it called the endpoint" is not
    // the thing worth asserting about a card that writes.
    if (opts.body !== undefined && opts.body !== null) {
      try { bodies[`${method} ${p}`] = JSON.parse(String(opts.body)); } catch { bodies[`${method} ${p}`] = String(opts.body); }
    }
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
  const bodies = {};
  window.fetch = recordingFetch({ ...BASE_ROUTES, ...routes }, calls, bodies);
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
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, errors, calls, bodies };
}

const click = async (node, ms) => { node.click(); await tick(ms); };

async function openGuide(doc, track = 'assurance') {
  const nav = doc.querySelector(`.tabs button[data-view="guide"][data-guide="${track}"]`);
  assert.ok(nav, `no nav button for the ${track} guide`);
  await click(nav, 200);
  const guide = doc.querySelector('#view .guide');
  assert.ok(guide, `the ${track} guide did not render`);
  return guide;
}

// Walks a guide end to end, returning its step titles.
async function walk(doc) {
  const total = doc.querySelectorAll('#view .guide-stepper-btn').length;
  const titles = [];
  for (let i = 0; i < total; i += 1) {
    const title = stepTitle(doc);
    assert.ok(title.trim(), `step ${i + 1} rendered without a title`);
    titles.push(title);
    if (i < total - 1) await click(nextBtn(doc), 50);
  }
  return titles;
}

// What the non-assurance guides read: the agents, the sites, and (for an admin)
// the server settings.
const GENERAL_ROUTES = {
  // Shaped like agentsRepository.mapRow: there is no `version` column — the
  // version an agent reports arrives inside its capabilities payload.
  'GET /agents': [
    { id: 1, hostname: 'core-sw', display_name: 'core-sw', status: 'online', location_id: 1, location_name: 'Copenhagen HQ', capabilities: { agentVersion: '1.4.0', sources: ['proc'] }, monitor_config: { source: 'netflow' } },
    { id: 2, hostname: 'branch-01', display_name: 'branch-01', status: 'offline', location_id: null, location_name: null, capabilities: { agentVersion: '1.3.0', sources: ['proc'] }, monitor_config: { source: 'proc' } },
  ],
  'GET /locations': [{ id: 1, name: 'Copenhagen HQ', latitude: 55.6, longitude: 12.5 }],
  'GET /api/settings': {
    analysis: { ...require('../src/services/settings').ANALYSIS_DEFAULTS, warnSigma: 5 },
    retention: { ...require('../src/services/settings').RETENTION_DEFAULTS },
  },
};

const stepTitle = (doc) => (doc.querySelector('#view .guide-step-title') || {}).textContent || '';
// The Back/Next row and the heading belong to the page now (the contract's
// form-actions row and PageHeader); the stepper and the steps are still the
// module's. See public/views/guides.js.
const foot = (doc) => doc.querySelector('#view .ui-page .form-actions-ui');
const nextBtn = (doc) => doc.querySelector('#view .ui-page .form-actions-ui button.btn-primary');
const backBtn = (doc) => doc.querySelector('#view .ui-page .form-actions-ui button.btn-secondary');

// --------------------------------------------------------------- walkthrough
test('the nav entry mounts the guide, and Next walks every step without throwing', async (t) => {
  const { doc, errors } = await boot(t, fullRoutes());
  await openGuide(doc);

  const total = doc.querySelectorAll('#view .guide-stepper-btn').length;
  assert.ok(total >= 10, `only ${total} steps`);

  const titles = [];
  for (let i = 0; i < total; i += 1) {
    const title = stepTitle(doc);
    assert.ok(title.trim(), `step ${i + 1} rendered without a title`);
    titles.push(title);
    assert.match(foot(doc).textContent, new RegExp(`${i + 1}`), `step counter at ${i + 1}`);
    if (i < total - 1) await click(nextBtn(doc), 60);
  }
  assert.equal(new Set(titles).size, total, 'two steps share a title');
  assert.deepEqual(errors, [], 'an uncaught error while walking the guide');

  // The last step restarts rather than dead-ending.
  await click(nextBtn(doc), 60);
  assert.equal(stepTitle(doc), titles[0]);
});

test('Back returns to the previous step, and the rail jumps straight to one', async (t) => {
  const { doc } = await boot(t, fullRoutes());
  await openGuide(doc);
  const first = stepTitle(doc);
  await click(nextBtn(doc), 60);
  const second = stepTitle(doc);
  assert.notEqual(second, first);
  await click(backBtn(doc), 60);
  assert.equal(stepTitle(doc), first);

  const rail = [...doc.querySelectorAll('#view .guide-stepper-btn')];
  await click(rail[rail.length - 1], 60);
  assert.equal(doc.querySelector('#view .guide-stepper-btn.active'),
    doc.querySelectorAll('#view .guide-stepper-btn')[rail.length - 1]);
});

// -------------------------------------------------------------- live state
test('the live-state lines report what the API answered', async (t) => {
  const { doc } = await boot(t, fullRoutes());
  await openGuide(doc);
  await click(nextBtn(doc), 120); // → Before you start

  const text = doc.querySelector('#view .guide-step').textContent;
  assert.match(text, /2/, 'the connected worker count is not on the page');
  assert.ok(doc.querySelector('#view .guide-pill-done'), 'a connected worker did not read as done');
});

test('no worker, no applications: the steps say so rather than looking finished', async (t) => {
  const { doc } = await boot(t, fullRoutes({
    [`GET ${SA}/runs/worker-status`]: { connected: false, worker_count: 0, queued: 3 },
    [`GET ${SA}/applications`]: [],
  }));
  await openGuide(doc);
  await click(nextBtn(doc), 120);
  assert.ok(doc.querySelector('#view .guide-pill-warn'), 'a missing worker did not raise a warning');

  await click(nextBtn(doc), 60); // → Register the application
  assert.ok(doc.querySelector('#view .guide-pill-todo'), 'an empty install did not read as "to do"');
});

test('an application with an empty allowlist is named — the step people skip', async (t) => {
  const { doc } = await boot(t, fullRoutes({
    [`GET ${SA}/applications/1`]: { id: 1, name: 'Selvbetjening', allowed_hosts: [] },
  }));
  await openGuide(doc);
  const rail = [...doc.querySelectorAll('#view .guide-stepper-btn')];
  await click(rail[3], 150); // → Allow the addresses
  const text = doc.querySelector('#view .guide-step').textContent;
  assert.match(text, /Selvbetjening/, 'the application with no allowed hosts is not named');
  assert.ok(doc.querySelector('#view .guide-pill-warn'));
});

test('a changed setting is shown against its default, and marked', async (t) => {
  const { doc } = await boot(t, fullRoutes({
    [`GET ${SA}/settings`]: settingsPayload({ assurance: { failureStreak: 5, notify: false } }),
  }));
  await openGuide(doc);
  const rail = [...doc.querySelectorAll('#view .guide-stepper-btn')];
  await click(rail[rail.length - 2], 150); // → The values, in one place

  const marked = [...doc.querySelectorAll('#view .guide-changed')].map((n) => n.textContent.trim());
  assert.ok(marked.includes('5'), `the changed failureStreak is not marked (${marked.join(', ')})`);
  const body = doc.querySelector('#view .guide-step').textContent;
  assert.match(body, /assurance\.failureStreak/);
  assert.match(body, new RegExp(String(NUMBER_BOUNDS.assurance.failureStreak[0])), 'the default is not shown beside it');
});

// ------------------------------------------------------- failure resilience
for (const status of [403, 404, 500]) {
  test(`every state probe answering ${status} leaves the guidance intact`, async (t) => {
    const dead = {};
    for (const key of Object.keys({ ...fullRoutes(), ...GENERAL_ROUTES })) dead[key] = { status, body: { error: `HTTP ${status}` } };
    const { doc, errors } = await boot(t, dead);
    await openGuide(doc);
    await tick(120);

    assert.deepEqual(errors, [], 'a failed probe threw');
    assert.ok(doc.querySelector('#view .inline-note'), 'nothing said the state could not be read');

    // Every step still renders, and the values tables are still there — they are
    // the reason somebody opened this.
    const total = doc.querySelectorAll('#view .guide-stepper-btn').length;
    let tables = 0;
    for (let i = 0; i < total; i += 1) {
      assert.ok(stepTitle(doc).trim(), `step ${i + 1} did not render on ${status}`);
      tables += doc.querySelectorAll('#view .guide-table').length;
      if (i < total - 1) await click(nextBtn(doc), 40);
    }
    assert.ok(tables >= 8, `only ${tables} tables survived a ${status}`);
  });
}

test('a viewer may read every guide, and is told where their role stops', async (t) => {
  // Reading how a thing works is not the same permission as doing it. The
  // guides are viewer+; the Service Assurance one still follows the licence,
  // because a guide to a module you have not bought is a sales brochure.
  const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES }, 'viewer');
  const nav = [...doc.querySelectorAll('.tabs button[data-view="guide"]')];
  assert.equal(nav.length, 5, 'the nav lost a guide');
  for (const b of nav) {
    assert.ok(!b.classList.contains('role-hidden'), `a viewer cannot see the ${b.dataset.guide} guide`);
  }
  assert.equal(nav.find((b) => b.dataset.guide === 'assurance').dataset.feature, 'service_tests');

  await openGuide(doc, 'assurance');
  await click(nextBtn(doc), 120); // → Before you start
  assert.ok(doc.querySelector('#view .guide-pill-warn'), 'a viewer was not told their role cannot create anything');
});

// ------------------------------------------------------------- it is TRUE

test('the guide module quotes the code’s own numbers', async (t) => {
  const { window, doc } = await boot(t, fullRoutes());
  await openGuide(doc);
  const mod = window.Guides;
  assert.ok(mod, 'the module did not publish itself');

  // Health weights: what the table prints has to be what the score computes.
  const weights = Object.fromEntries(mod.HEALTH_WEIGHTS);
  for (const [part, weight] of Object.entries(SCORE_WEIGHTS)) {
    assert.equal(weights[part], `${Math.round(weight * 100)}%`, `the guide shows ${part} at ${weights[part]}`);
  }
  assert.equal(Object.keys(weights).length, Object.keys(SCORE_WEIGHTS).length, 'a part is missing from the guide table');

  // Every settings row names a real section and field, so the "Yours" column can
  // never be silently empty.
  for (const [section, field, why] of mod.VALUE_ROWS) {
    // Read through defaultsFor, which is the union of every field kind the
    // settings catalogue has — numbers, enums, booleans AND text.
    const known = Object.prototype.hasOwnProperty.call(defaultsFor(section), field);
    assert.ok(known, `${section}.${field} is in the guide and not in the settings catalogue`);
    for (const locale of I18n.LOCALES) assert.ok(I18n.has(why, locale), `${why} missing from the ${locale} catalogue`);
  }
});

test('the step titles and the shell exist in both catalogues', () => {
  // The module builds no keys, so the gate sweep covers the rest; these are the
  // ones the gate cannot see because they are reached through a lookup.
  const src = fs.readFileSync(path.join(PUBLIC, 'guides.js'), 'utf8');
  const keys = [...src.matchAll(/t\('(guide\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 100, `only ${keys.length} guide keys used`);
  for (const key of new Set(keys)) {
    for (const locale of I18n.LOCALES) assert.ok(I18n.has(key, locale), `${key} missing from ${locale}`);
  }
  assert.ok(!/t\('guide\.[a-zA-Z0-9_.]*' *\+/.test(src), 'a catalogue key is being built by concatenation');
});


// --------------------------------------------------------------- every guide
const TRACKS = ['monitoring', 'fleet', 'diagnostics', 'assurance', 'insights'];

test('the Guides nav group has one entry per guide, and each mounts its own', async (t) => {
  const { doc, errors } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES });
  const nav = [...doc.querySelectorAll('.tabs button[data-view="guide"]')].map((b) => b.dataset.guide);
  assert.deepEqual(nav, TRACKS, 'the nav does not list the five guides in order');

  const seen = new Set();
  for (const track of TRACKS) {
    await openGuide(doc, track);
    const titles = await walk(doc);
    assert.ok(titles.length >= 5, `${track}: only ${titles.length} steps`);
    assert.equal(new Set(titles).size, titles.length, `${track}: two steps share a title`);
    const heading = doc.querySelector('#view .page-head h1').textContent;
    assert.ok(heading.trim(), `${track}: no heading`);
    assert.ok(!seen.has(heading), `${track}: reuses the heading "${heading}"`);
    seen.add(heading);
  }
  assert.deepEqual(errors, [], 'an uncaught error while walking the guides');
});

test('each guide remembers its own position', async (t) => {
  const { doc, window } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES });
  await openGuide(doc, 'monitoring');
  await click(nextBtn(doc), 60);
  await click(nextBtn(doc), 60);
  const monitoringStep = foot(doc).textContent;

  await openGuide(doc, 'insights');
  assert.match(foot(doc).textContent, /\b1\b/, 'a fresh guide did not start at step 1');

  await openGuide(doc, 'monitoring');
  assert.equal(foot(doc).textContent, monitoringStep, 'the monitoring guide lost its place');
  assert.ok(window.localStorage.getItem('blueeye.guide.step.monitoring'), 'the position is not persisted per track');
});

test('the general guides read the fleet and say what they found', async (t) => {
  const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES });
  await openGuide(doc, 'monitoring');
  const rail = [...doc.querySelectorAll('#view .guide-stepper-btn')];
  await click(rail[2], 150); // → the Overview step
  const text = doc.querySelector('#view .guide-step').textContent;
  assert.match(text, /1(?!\d)/, 'the offline agent count is not on the page');
  assert.ok(doc.querySelector('#view .guide-pill-warn'), 'an offline agent did not raise a warning');
});

test('an admin sees the live analysis settings; everyone else is told why not', async (t) => {
  const admin = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES }, 'admin');
  await openGuide(admin.doc, 'insights');
  await click(admin.doc.querySelectorAll('#view .guide-stepper-btn')[1], 150);
  const shown = admin.doc.querySelector('#view .guide-step').textContent;
  assert.match(shown, /analysis\.warnSigma/);
  assert.ok(admin.doc.querySelector('#view .guide-changed'), 'a changed sigma is not marked');

  const viewer = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES }, 'viewer');
  await openGuide(viewer.doc, 'insights');
  await click(viewer.doc.querySelectorAll('#view .guide-stepper-btn')[1], 150);
  const text = viewer.doc.querySelector('#view .guide-step').textContent;
  assert.match(text, /analysis\.warnSigma/, 'a viewer lost the values table');
  assert.equal(viewer.doc.querySelectorAll('#view .guide-changed').length, 0, 'a viewer was shown live settings');
  assert.ok(!viewer.calls.includes('GET /api/settings'), 'a viewer was made to call an admin-only endpoint');
});

test('the values the general guides quote are the code’s values', async (t) => {
  const { window } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES });
  const mod = window.Guides;
  const { ANALYSIS_DEFAULTS, RETENTION_DEFAULTS } = require('../src/services/settings');
  const { THRESHOLDS } = require('../src/health/probeHealth');

  for (const [field, shown] of mod.ANALYSIS_VALUES.map((r) => [r[0], r[1]])) {
    assert.equal(shown, String(ANALYSIS_DEFAULTS[field]), `analysis.${field} is quoted as ${shown}`);
  }
  for (const [field, shown] of mod.RETENTION_VALUES.map((r) => [r[0], r[1]])) {
    assert.equal(shown, String(RETENTION_DEFAULTS[field]), `retention.${field} is quoted as ${shown}`);
  }
  const th = mod.HEALTH_THRESHOLDS;
  assert.equal(th.LOSS_WARN, String(THRESHOLDS.LOSS_WARN));
  assert.equal(th.LOSS_BAD, String(THRESHOLDS.LOSS_BAD));
  assert.equal(th.JITTER_WARN, String(THRESHOLDS.JITTER_WARN));
  assert.equal(th.JITTER_BAD, String(THRESHOLDS.JITTER_BAD));
  assert.equal(th.Z_WARN, String(THRESHOLDS.Z_WARN));
  assert.equal(th.Z_BAD, undefined, 'latency has no bad tier');
  assert.equal(th.MIN_BASELINE, String(THRESHOLDS.MIN_BASELINE));
  assert.equal(th.STALE_MIN, String(THRESHOLDS.STALE_MS / 60000));

  // The interface verdicts are computed inline rather than from a named export,
  // so the guide's two percentages are pinned to the rule itself.
  const iface = fs.readFileSync(path.join(__dirname, '..', 'src', 'health', 'interfaceHealth.js'), 'utf8');
  assert.ok(iface.includes(`utilPct >= ${th.IFACE_UTIL_BAD}`), `an interface is "bad" at some other utilization than ${th.IFACE_UTIL_BAD}%`);
  assert.ok(iface.includes(`utilPct >= ${th.IFACE_UTIL_WARN}`), `an interface is "warn" at some other utilization than ${th.IFACE_UTIL_WARN}%`);
});


// ------------------------------------------------- the audit pass (v0.144)
test('the version line reads the version agents actually report', async (t) => {
  // agentsRepository has no version column; `capabilities.agentVersion` is
  // where it lives. Reading the wrong field made this line dead on every
  // install — and dead in a way nothing but a real payload would show.
  const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES });
  await openGuide(doc, 'fleet');
  const rail = [...doc.querySelectorAll('#view .guide-stepper-btn')];
  await click(rail[5], 150); // → Keeping agents current
  const text = doc.querySelector('#view .guide-step').textContent;
  assert.match(text, /1\.4\.0/, 'the reported agent version is not on the page');
  assert.match(text, /1\.3\.0/, 'the second version is not named');
  assert.ok(doc.querySelector('#view .guide-pill-warn'), 'two versions did not raise a warning');
});

test('one version across the fleet reads as done', async (t) => {
  const same = GENERAL_ROUTES['GET /agents'].map((a) => ({ ...a, status: 'online', capabilities: { agentVersion: '1.4.0' } }));
  const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES, 'GET /agents': same });
  await openGuide(doc, 'fleet');
  await click([...doc.querySelectorAll('#view .guide-stepper-btn')][5], 150);
  const text = doc.querySelector('#view .guide-step').textContent;
  assert.match(text, /1\.4\.0/);
  assert.equal(doc.querySelectorAll('#view .guide-pill-warn').length, 0, 'a uniform fleet raised a warning');
});

test('a step never offers a screen the reader cannot open', async (t) => {
  // Enrollment, Investigate and Topology delta are operator+. A viewer gets the
  // screen named and greyed with the reason, not a button that would land them
  // somewhere else. Troubleshooting is open to viewers (with the operator-only
  // panels left out), so it IS offered.
  const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES }, 'viewer');

  await openGuide(doc, 'fleet');
  await click([...doc.querySelectorAll('#view .guide-stepper-btn')][1], 150); // → Add an agent
  let labels = [...doc.querySelectorAll('#view .guide-actions button')].map((b) => b.textContent);
  assert.ok(!labels.some((l) => /Enrollment/.test(l)), `a viewer was offered Enrollment: ${labels.join(' | ')}`);
  assert.ok([...doc.querySelectorAll('#view .guide-unavailable')].some((n) => /Enrollment/.test(n.textContent)),
    'Enrollment is not named at all for a viewer');
  assert.equal(doc.querySelectorAll('#view .guide-actions button').length, 0, 'a viewer was offered an admin Settings tab');

  await openGuide(doc, 'diagnostics');
  await click([...doc.querySelectorAll('#view .guide-stepper-btn')][4], 150); // → When it is a real outage
  labels = [...doc.querySelectorAll('#view .guide-actions button')].map((b) => b.textContent);
  assert.deepEqual(labels, ['Open Troubleshooting'], `a viewer was offered an operator-only screen: ${labels.join(' | ')}`);
  const refused = [...doc.querySelectorAll('#view .guide-unavailable')].map((n) => n.textContent);
  assert.equal(refused.length, 1, 'Investigate is not named as operator-only');
  assert.match(refused[0], /Investigate/);
});

test('an admin is offered those same screens as buttons', async (t) => {
  const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES }, 'admin');
  await openGuide(doc, 'diagnostics');
  await click([...doc.querySelectorAll('#view .guide-stepper-btn')][4], 150);
  assert.equal(doc.querySelectorAll('#view .guide-unavailable').length, 0, 'an admin was refused a screen');
  assert.equal(doc.querySelectorAll('#view .guide-actions button').length, 2);
});

test('the Overview guide lists every verdict the health code can produce', async (t) => {
  // A table of colours that omits one is a reader who meets an undocumented
  // state during an outage.
  const { TIER } = (() => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'health', 'probeHealth.js'), 'utf8');
    const m = /const TIER = \{([^}]+)\}/.exec(src);
    assert.ok(m, 'probeHealth no longer declares TIER');
    return { TIER: m[1].split(',').map((p) => p.split(':')[0].trim()).filter(Boolean) };
  })();

  const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES });
  await openGuide(doc, 'monitoring');
  await click([...doc.querySelectorAll('#view .guide-stepper-btn')][2], 150);
  const codes = [...doc.querySelectorAll('#view .guide-table code')].map((n) => n.textContent);
  for (const status of TIER) {
    assert.ok(codes.includes(status), `the guide does not explain the "${status}" verdict`);
  }
});

test('the counted lines read right for exactly one of a thing', async (t) => {
  // "1 test(s) exist" is the shape this catches. Every counted line in the
  // guides goes through plural(), including the keys handed to countStatus as
  // plain strings — which the gate's sweep cannot see.
  const src = fs.readFileSync(path.join(PUBLIC, 'guides.js'), 'utf8');
  const handed = [...src.matchAll(/countStatus\([^,]+,\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(handed.length >= 2, `only ${handed.length} countStatus keys found`);
  for (const key of handed) {
    for (const form of ['one', 'other']) {
      for (const locale of I18n.LOCALES) {
        assert.ok(I18n.has(`${key}.${form}`, locale), `${key}.${form} missing from ${locale}`);
      }
    }
  }

  // And the rendering: one application, one test, one journey, one run.
  const one = fullRoutes({
    [`GET ${SA}/journeys`]: { journeys: [{ id: 4, name: 'Find a customer' }], summary: {} },
  });
  const { doc } = await boot(t, { ...one, ...GENERAL_ROUTES });
  await openGuide(doc, 'assurance');
  const seen = [];
  const rail = [...doc.querySelectorAll('#view .guide-stepper-btn')];
  for (let i = 0; i < rail.length; i += 1) {
    await click([...doc.querySelectorAll('#view .guide-stepper-btn')][i], 40);
    for (const n of doc.querySelectorAll('#view .guide-status-text')) seen.push(n.textContent);
  }
  const joined = seen.join(' | ');
  assert.ok(!/\(s\)/.test(joined), `a counted line still carries "(s)": ${joined}`);
  assert.ok(/One application registered\./.test(joined), `the singular application line is wrong: ${joined}`);
  assert.ok(/One test exists\./.test(joined), `the singular test line is wrong: ${joined}`);
  assert.ok(/One journey defined\./.test(joined), `the singular journey line is wrong: ${joined}`);
});

test('no guide line ships an unfilled {placeholder}', async (t) => {
  // A parameter passed to the wrong cell renders as "{samples} samples" and
  // nothing but reading every step catches it.
  for (const track of TRACKS) {
    const { doc } = await boot(t, { ...fullRoutes(), ...GENERAL_ROUTES });
    await openGuide(doc, track);
    const total = doc.querySelectorAll('#view .guide-stepper-btn').length;
    for (let i = 0; i < total; i += 1) {
      await click([...doc.querySelectorAll('#view .guide-stepper-btn')][i], 40);
      const text = doc.querySelector('#view .guide-step').textContent;
      const stray = text.match(/\{[a-zA-Z]+\}/g);
      assert.equal(stray, null, `${track} step ${i + 1} shows ${stray && stray.join(', ')}`);
    }
  }
});


// =================================================== guided actions (v0.145)
// A step that does the thing has to be held to more than "it renders": it
// writes to a production system, so what it sends, what it refuses to send,
// and what it does with a 400 are all part of the contract.

const withAction = (over = {}) => ({ ...fullRoutes(), ...GENERAL_ROUTES, ...over });

// Walks to the step carrying an action card and returns its pieces.
async function openAction(doc, track, stepIndex) {
  await openGuide(doc, track);
  await click([...doc.querySelectorAll('#view .guide-stepper-btn')][stepIndex], 150);
  const card = doc.querySelector('#view .guide-action');
  assert.ok(card, `${track} step ${stepIndex + 1} has no action card`);
  return {
    card,
    button: card.querySelector('.guide-action-go'),
    inputs: [...card.querySelectorAll('.guide-action-input')],
    result: card.querySelector('.guide-action-result'),
    failure: card.querySelector('.guide-action-failure'),
    errors: [...card.querySelectorAll('.guide-action-error')],
  };
}

test('the Sites step creates a site through the same endpoint the screen uses', async (t) => {
  const { doc, calls } = await boot(t, withAction({
    'POST /locations': { status: 201, body: { id: 9, name: 'Aarhus', address: 'Åboulevarden 1' } },
  }));
  const a = await openAction(doc, 'monitoring', 4);
  a.inputs[0].value = 'Aarhus';
  a.inputs[1].value = 'Åboulevarden 1';
  await click(a.button, 150);

  const post = calls.find((c) => c === 'POST /locations');
  assert.ok(post, `no POST went out: ${calls.join(' | ')}`);
  assert.equal(a.result.hidden, false, 'nothing confirmed the site was created');
  assert.match(a.result.textContent, /Aarhus/);
  assert.equal(a.failure.hidden, true);
  // The live state is re-read, so the status line above stops saying "not yet".
  assert.ok(calls.filter((c) => c === 'GET /locations').length >= 2, 'the state was not re-read after the write');
});

test('a 400 lands on the field that caused it, with the server’s own message', async (t) => {
  const { doc } = await boot(t, withAction({
    'POST /locations': { status: 400, body: { error: 'Validation failed', details: { name: 'name is required' } } },
  }));
  const a = await openAction(doc, 'monitoring', 4);
  await click(a.button, 150);
  assert.equal(a.errors[0].hidden, false, 'the field error is not shown');
  assert.equal(a.errors[0].textContent, 'name is required', 'the server message was replaced');
  assert.equal(a.result.hidden, true, 'a failed write reported success');
  assert.equal(a.button.disabled, false, 'the button stayed disabled after a failure');
});

test('a validation error on a field the card does not have still reaches the reader', async (t) => {
  const { doc } = await boot(t, withAction({
    'POST /locations': { status: 400, body: { error: 'Validation failed', details: { latitude: 'latitude is out of range' } } },
  }));
  const a = await openAction(doc, 'monitoring', 4);
  await click(a.button, 150);
  assert.equal(a.failure.hidden, false);
  assert.match(a.failure.textContent, /latitude is out of range/);
});

test('a 500 is reported on the card rather than thrown', async (t) => {
  const { doc, errors } = await boot(t, withAction({
    'POST /locations': { status: 500, body: { error: 'Internal error' } },
  }));
  const a = await openAction(doc, 'monitoring', 4);
  a.inputs[0].value = 'Aarhus';
  await click(a.button, 150);
  assert.deepEqual(errors, [], 'a failed write threw');
  assert.equal(a.failure.hidden, false);
  assert.match(a.failure.textContent, /Internal error/);
});

test('the Fleet step generates an enrollment code and shows it', async (t) => {
  const { doc, calls } = await boot(t, withAction({
    'POST /enrollment-codes': { status: 201, body: { id: 3, code: 'ABC-123', expires_at: '2026-09-13T13:00:00Z' } },
  }));
  const a = await openAction(doc, 'fleet', 1);
  await click(a.button, 150);
  assert.ok(calls.includes('POST /enrollment-codes'));
  assert.match(a.result.textContent, /ABC-123/);
});

test('the Diagnostics step runs a ping from the agent the reader picks', async (t) => {
  const { doc, calls } = await boot(t, withAction({
    'POST /agents/2/probe': { status: 202, body: { queued: true } },
  }));
  const a = await openAction(doc, 'diagnostics', 1);
  a.inputs[0].value = '2';          // the offline agent, deliberately: the picker offers every agent
  a.inputs[1].value = '1.1.1.1';
  await click(a.button, 150);
  assert.ok(calls.includes('POST /agents/2/probe'), `no probe was queued: ${calls.join(' | ')}`);
  assert.equal(a.failure.hidden, true);
});

test('with no agents at all, the probe card says so instead of offering an empty picker', async (t) => {
  const { doc } = await boot(t, withAction({ 'GET /agents': [] }));
  await openGuide(doc, 'diagnostics');
  await click([...doc.querySelectorAll('#view .guide-stepper-btn')][1], 150);
  const card = doc.querySelector('#view .guide-action-blocked');
  assert.ok(card, 'no card at all');
  assert.equal(card.querySelector('.guide-action-go'), null, 'an empty picker was offered anyway');
});

test('Service Assurance: the application and the allowlist entry are created from the guide', async (t) => {
  const { doc, calls } = await boot(t, withAction({
    [`POST ${SA}/applications`]: { status: 201, body: { id: 7, name: 'Selvbetjening' } },
    [`POST ${SA}/applications/1/allowed-hosts`]: { status: 201, body: { id: 2, value: 'api.example.dk' } },
  }));
  const app = await openAction(doc, 'assurance', 2);
  app.inputs[0].value = 'Selvbetjening';
  app.inputs[1].value = 'https://app.example.dk';
  await click(app.button, 150);
  assert.ok(calls.includes(`POST ${SA}/applications`));
  assert.match(app.result.textContent, /Selvbetjening/);

  const allow = await openAction(doc, 'assurance', 3);
  allow.inputs[1].value = 'api.example.dk';
  await click(allow.button, 150);
  assert.ok(calls.includes(`POST ${SA}/applications/1/allowed-hosts`), `no allowlist write: ${calls.join(' | ')}`);
  assert.match(allow.result.textContent, /api\.example\.dk/);
});

test('Service Assurance: the mail check is created from the guide, as an operator', async (t) => {
  const { doc, calls, bodies } = await boot(t, withAction({
    [`POST ${SA}/monitors`]: { status: 201, body: { id: 3, name: 'Kundemail', type: 'mail' } },
  }), 'operator');
  // The monitors step sits after incidents: index 11 of the assurance track.
  const card = await openAction(doc, 'assurance', 11);
  assert.ok(card.button, 'an operator was not offered the monitor card');
  card.inputs[0].value = 'Kundemail';
  card.inputs[1].value = 'smtp.example.dk';
  card.inputs[2].value = 'assurance@example.dk';
  card.inputs[3].value = 'mailprobe@example.dk';
  await click(card.button, 150);

  assert.ok(calls.includes(`POST ${SA}/monitors`), `no monitor write: ${calls.join(' | ')}`);
  // The guide creates the send-only depth through the same endpoint the screen
  // uses, with the config shape the server validates.
  const sent = bodies[`POST ${SA}/monitors`];
  assert.ok(sent, 'the card posted nothing');
  assert.equal(sent.type, 'mail');
  assert.equal(sent.config.smtp_host, 'smtp.example.dk');
  assert.equal(sent.config.from_address, 'assurance@example.dk');
  assert.equal(sent.config.to_address, 'mailprobe@example.dk');
  assert.match(card.result.textContent, /Kundemail/);
});

test('an action never offers a button the reader’s role cannot press', async (t) => {
  // Sites and the probe are operator+; the Service Assurance writes are admin.
  const viewer = await boot(t, withAction(), 'viewer');
  for (const [track, step] of [['monitoring', 4], ['fleet', 1], ['diagnostics', 1], ['assurance', 2], ['assurance', 3]]) {
    await openGuide(viewer.doc, track);
    await click([...viewer.doc.querySelectorAll('#view .guide-stepper-btn')][step], 120);
    const go = viewer.doc.querySelector('#view .guide-action-go');
    assert.equal(go, null, `a viewer was offered the ${track} action on step ${step + 1}`);
    assert.ok(viewer.doc.querySelector('#view .guide-action-blocked'), `${track}: the action vanished instead of explaining itself`);
  }

  const operator = await boot(t, withAction(), 'operator');
  await openGuide(operator.doc, 'assurance');
  await click([...operator.doc.querySelectorAll('#view .guide-stepper-btn')][2], 120);
  assert.equal(operator.doc.querySelector('#view .guide-action-go'), null, 'an operator was offered an admin-only write');
  assert.ok(/admin/i.test(operator.doc.querySelector('#view .guide-action-blocked').textContent));

  // And the admin gets all five.
  const admin = await boot(t, withAction(), 'admin');
  let offered = 0;
  for (const [track, step] of [['monitoring', 4], ['fleet', 1], ['diagnostics', 1], ['assurance', 2], ['assurance', 3]]) {
    await openGuide(admin.doc, track);
    await click([...admin.doc.querySelectorAll('#view .guide-stepper-btn')][step], 120);
    if (admin.doc.querySelector('#view .guide-action-go')) offered += 1;
  }
  assert.equal(offered, 5, 'an admin was refused an action');
});

test('every endpoint the guides call is mounted on the server', async () => {
  // The gate sweeps app.js for this; guides.js is its own file and was not
  // covered, which is how a guide could ship a button that answers 404.
  const routesIndex = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'index.js'), 'utf8');
  // Service Assurance is mounted across several lines (requireAuth and the
  // licence gate sit between), so the path is not on the router.use( line.
  const mounted = [...routesIndex.matchAll(/router\.use\(\s*'(\/[\w/-]+)'/g)].map((m) => m[1]);
  const src = fs.readFileSync(path.join(PUBLIC, 'guides.js'), 'utf8');
  const called = [...new Set([...src.matchAll(/api\((?:API \+ )?'(\/[a-zA-Z0-9/_-]*)/g)].map((m) => m[1]))];
  assert.ok(called.length >= 5, `only ${called.length} api() calls found`);
  for (const raw of called) {
    const full = raw.startsWith('/api/') || raw.startsWith('/agents') || raw.startsWith('/locations')
      || raw.startsWith('/enrollment') ? raw : `/api/service-tests${raw}`;
    assert.ok(mounted.some((m) => full === m || full.startsWith(`${m}/`)), `${full} is not mounted`);
  }
});
