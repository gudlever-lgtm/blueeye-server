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
const { NUMBER_BOUNDS, BOOLEAN_FIELDS, ENUM_FIELDS } = require('../src/serviceTests/settings/defaults');
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
  const defaults = {};
  for (const [section, fields] of Object.entries(NUMBER_BOUNDS)) {
    defaults[section] = {};
    for (const [field, bounds] of Object.entries(fields)) defaults[section][field] = bounds[0];
  }
  for (const [section, fields] of Object.entries(BOOLEAN_FIELDS)) {
    defaults[section] = { ...(defaults[section] || {}) };
    for (const [field, value] of Object.entries(fields)) defaults[section][field] = value;
  }
  for (const [section, fields] of Object.entries(ENUM_FIELDS)) {
    defaults[section] = { ...(defaults[section] || {}) };
    for (const [field, spec] of Object.entries(fields)) defaults[section][field] = spec[0];
  }
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

function recordingFetch(routes, calls) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    calls.push(`${method} ${p}`);
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
  'GET /agents': [
    { id: 1, hostname: 'core-sw', status: 'online', version: '1.4.0', location_id: 1, monitor_config: { source: 'netflow' } },
    { id: 2, hostname: 'branch-01', status: 'offline', version: '1.3.0', location_id: null, monitor_config: { source: 'proc' } },
  ],
  'GET /locations': [{ id: 1, name: 'Copenhagen HQ', latitude: 55.6, longitude: 12.5 }],
  'GET /api/settings': {
    analysis: { ...require('../src/services/settings').ANALYSIS_DEFAULTS, warnSigma: 5 },
    retention: { ...require('../src/services/settings').RETENTION_DEFAULTS },
  },
};

const stepTitle = (doc) => (doc.querySelector('#view .guide-step-title') || {}).textContent || '';
const nextBtn = (doc) => doc.querySelector('#view .guide-foot button.primary');
const backBtn = (doc) => doc.querySelector('#view .guide-foot button.ghost');

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
    assert.match(doc.querySelector('#view .guide-count').textContent, new RegExp(`${i + 1}`), `step counter at ${i + 1}`);
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
    assert.ok(doc.querySelector('#view .guide-stale'), 'nothing said the state could not be read');

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
    const known = (NUMBER_BOUNDS[section] && NUMBER_BOUNDS[section][field] !== undefined)
      || (BOOLEAN_FIELDS[section] && BOOLEAN_FIELDS[section][field] !== undefined)
      || (ENUM_FIELDS[section] && ENUM_FIELDS[section][field] !== undefined);
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
    const heading = doc.querySelector('#view .guide-title').textContent;
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
  const monitoringStep = doc.querySelector('#view .guide-count').textContent;

  await openGuide(doc, 'insights');
  assert.match(doc.querySelector('#view .guide-count').textContent, /\b1\b/, 'a fresh guide did not start at step 1');

  await openGuide(doc, 'monitoring');
  assert.equal(doc.querySelector('#view .guide-count').textContent, monitoringStep, 'the monitoring guide lost its place');
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
  assert.equal(th.Z_BAD, String(THRESHOLDS.Z_BAD));
  assert.equal(th.MIN_BASELINE, String(THRESHOLDS.MIN_BASELINE));
  assert.equal(th.STALE_MIN, String(THRESHOLDS.STALE_MS / 60000));

  // The interface verdicts are computed inline rather than from a named export,
  // so the guide's two percentages are pinned to the rule itself.
  const iface = fs.readFileSync(path.join(__dirname, '..', 'src', 'health', 'interfaceHealth.js'), 'utf8');
  assert.ok(iface.includes(`utilPct >= ${th.IFACE_UTIL_BAD}`), `an interface is "bad" at some other utilization than ${th.IFACE_UTIL_BAD}%`);
  assert.ok(iface.includes(`utilPct >= ${th.IFACE_UTIL_WARN}`), `an interface is "warn" at some other utilization than ${th.IFACE_UTIL_WARN}%`);
});
