'use strict';

// The incident detail view, driven in a real DOM.
//
// Migration 090 gave incidents three more states, a timeline and an impact
// assessment, and the screen showed none of them — the Health tab listed open
// incidents with a Resolve button and nothing else. An incident somebody had
// picked up disappeared from it entirely, because the list asked for
// `?status=open`.

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

const BASE_ROUTES = {
  'GET /me': { id: 1, email: 'op@blueeye.local', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': { service_tests: true },
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
};

function recordingFetch(routes, calls) {
  return async (url, opts = {}) => {
    const full = String(url);
    const p = full.split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ method, path: p, url: full, body });
    // Query strings matter here: the Health tab asks for each active state
    // separately, and a harness that ignored them could not tell whether it did.
    const hit = routes[`${method} ${full}`] !== undefined ? routes[`${method} ${full}`] : routes[`${method} ${p}`];
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

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

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

const INCIDENT = {
  id: 9, application_id: 1, subject_type: 'test', subject_key: 'test:1',
  subject_label: 'Customer search', kind: 'http_500', severity: 'CRIT',
  status: 'open', summary: 'HTTP 500 from /api/customer/search',
  likely_cause: 'the application', correlated_layer: 'api', confidence: 68,
  impact: 'high', impact_reason: 'A critical journey cannot complete.',
  affected_journeys: [], explanation: 'x', evidence: ['HTTP 500'], occurrences: 4,
  opened_at: '2026-09-12T09:00:00Z', last_seen_at: '2026-09-12T09:40:00Z',
  resolved_at: null, acknowledged_at: null, original_severity: null,
};

const DETAIL = {
  ...INCIDENT,
  reference: 'INC-2026-00009',
  duration: { ms: 2400000, minutes: 40, ongoing: true },
  impact: { level: 'high', reason: 'A critical journey cannot complete.', affected_users: 'unknown' },
  can_move_to: ['investigating', 'identified', 'resolved'],
  timeline: [
    { id: 1, kind: 'opened', summary: 'Customer search started failing', source: 'run', occurred_at: '2026-09-12T09:00:00Z', detail: null },
    { id: 2, kind: 'correlated', summary: 'Likely an application or API problem', source: 'correlation', occurred_at: '2026-09-12T09:01:00Z', detail: null },
    { id: 3, kind: 'status_investigating', summary: 'looking at the auth service', source: 'person', occurred_at: '2026-09-12T09:20:00Z', detail: null },
  ],
};

const healthRoutes = (over = {}) => ({
  [`GET ${SA}/assurance/incidents?status=open`]: [INCIDENT],
  [`GET ${SA}/assurance/incidents?status=investigating`]: [],
  [`GET ${SA}/assurance/incidents?status=identified`]: [],
  [`GET ${SA}/assurance/certificates`]: [],
  [`GET ${SA}/assurance/summary`]: { open: { CRIT: 1, WARN: 0, INFO: 0 }, certificates: { total: 0, expiring: 0 } },
  [`GET ${SA}/assurance/top-applications`]: [],
  [`GET ${SA}/assurance/incidents/9`]: DETAIL,
  [`GET ${SA}/analysis/incidents/9/recurrence`]: { incident_id: 9, recurrence: null, looked_at: 0 },
  ...over,
});

async function openHealth(doc) {
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="health"]');
  assert.ok(nav, 'no Health nav button');
  await click(nav, 400);
}

async function openIncident(doc) {
  await openHealth(doc);
  const open = byText(doc, '#view button', 'Open');
  assert.ok(open, 'no way to open an incident');
  await click(open, 400);
  const dialog = doc.querySelector('.sa-modal');
  assert.ok(dialog, 'the incident did not open');
  return dialog;
}

// ------------------------------------------------------------- the listing
test('the Health tab shows incidents in every active state, not only open ones', async (t) => {
  // An incident somebody picked up is still wrong, and it is the one most
  // likely to be looked at next. Asking only for `?status=open` made it vanish.
  const picked = { ...INCIDENT, id: 10, status: 'investigating', subject_label: 'Sign in' };
  const { doc, calls, errors } = await boot(t, healthRoutes({
    [`GET ${SA}/assurance/incidents?status=investigating`]: [picked],
  }));
  await openHealth(doc);

  for (const status of ['open', 'investigating', 'identified']) {
    assert.ok(calls.some((c) => c.url.includes(`status=${status}`)), `it never asked for ${status}`);
  }
  assert.match(doc.querySelector('#view').textContent, /Sign in/, 'the incident under investigation is not on screen');
  assert.deepEqual(errors, []);
});

// -------------------------------------------------------------- the detail
test('an incident opens with its reference, duration, impact and conclusion', async (t) => {
  const { doc, errors } = await boot(t, healthRoutes());
  const dialog = await openIncident(doc);

  assert.match(dialog.textContent, /INC-2026-00009/);
  assert.match(dialog.textContent, /40 min, still going/);
  assert.match(dialog.textContent, /A critical journey cannot complete/);
  assert.match(dialog.textContent, /api/, 'what it was traced to');
  assert.match(dialog.textContent, /68%/);
  assert.deepEqual(errors, []);
});

test('affected users reads Unknown rather than a number nobody counted', async (t) => {
  const { doc } = await boot(t, healthRoutes());
  const dialog = await openIncident(doc);
  // Asserted on the stat itself, not the whole dialog — a looser pattern
  // reaches across to the confidence percentage and the duration.
  const stat = [...dialog.querySelectorAll('.sa-stat')]
    .find((n) => /Affected users/.test(n.textContent));
  assert.ok(stat, 'affected users is not on the screen at all');
  assert.match(stat.querySelector('.sa-stat-value').textContent, /^Unknown$/);
});

test('the timeline is shown in order, and says what caused each entry', async (t) => {
  // A person acknowledging an incident and a sweep observing a recovery are
  // both real events, and presenting one as the other makes it unreadable.
  const { doc } = await boot(t, healthRoutes());
  const dialog = await openIncident(doc);

  const events = dialog.querySelectorAll('.sa-timeline-event');
  assert.equal(events.length, 3);
  assert.match(events[0].textContent, /started failing/);
  assert.match(events[2].textContent, /looking at the auth service/);
  assert.ok(events[2].classList.contains('sa-source-person'), 'a person’s action is not marked as one');
  assert.match(events[2].textContent, /a person/);
  assert.match(events[1].textContent, /analysis/);
});

test('an incident with no recorded events says so rather than inventing a history', async (t) => {
  const { doc } = await boot(t, healthRoutes({
    [`GET ${SA}/assurance/incidents/9`]: { ...DETAIL, timeline: [] },
  }));
  const dialog = await openIncident(doc);
  assert.match(dialog.textContent, /Nothing was recorded against this incident/);
  assert.equal(dialog.querySelectorAll('.sa-timeline-event').length, 0);
});

test('a recurrence is shown when there is one, and nothing when there is not', async (t) => {
  const quiet = await boot(t, healthRoutes());
  const noRecurrence = await openIncident(quiet.doc);
  assert.ok(!/Has this happened before/.test(noRecurrence.textContent));

  const loud = await boot(t, healthRoutes({
    [`GET ${SA}/analysis/incidents/9/recurrence`]: {
      incident_id: 9,
      recurrence: {
        summary: 'Similar incidents detected. Customer search, http_500. 12 occurrences.',
        rhythm: { kind: 'weekly', detail: 'every Monday around 09:00 UTC', confident: true },
      },
      looked_at: 40,
    },
  }));
  const dialog = await openIncident(loud.doc);
  assert.match(dialog.textContent, /12 occurrences/);
  assert.match(dialog.textContent, /every Monday around 09:00 UTC/);
});

// ------------------------------------------------------------- the moves
test('exactly the moves the API will accept are offered', async (t) => {
  // A button that comes back refused is worse than no button.
  const { doc } = await boot(t, healthRoutes());
  const dialog = await openIncident(doc);
  const actions = dialog.querySelector('.sa-incident-actions');
  assert.ok(actions, 'no way to move the incident at all');
  const labels = [...actions.querySelectorAll('button')].map((b) => b.textContent.trim());
  assert.deepEqual(labels, ['Investigating', 'Identified', 'Resolved']);
});

test('an incident that can go nowhere is offered nothing', async (t) => {
  const { doc } = await boot(t, healthRoutes({
    [`GET ${SA}/assurance/incidents/9`]: { ...DETAIL, status: 'closed', can_move_to: [] },
  }));
  const dialog = await openIncident(doc);
  assert.equal(dialog.querySelector('.sa-incident-actions'), null);
});

test('picking one up posts the move and reloads', async (t) => {
  const { doc, calls } = await boot(t, healthRoutes({
    [`POST ${SA}/assurance/incidents/9/status`]: { ...DETAIL, status: 'investigating', can_move_to: ['identified', 'resolved', 'open'] },
  }));
  const dialog = await openIncident(doc);
  await click(byText(dialog, 'button', 'Investigating'), 400);

  const posted = calls.find((c) => c.method === 'POST' && c.path.endsWith('/incidents/9/status'));
  assert.ok(posted, 'the button called nothing');
  assert.equal(posted.body.status, 'investigating');
});

test('the whole module is operator+, so there is no read-only incident view to guard', async (t) => {
  // A viewer never reaches this screen: the nav entry is operator-gated, as the
  // whole of Service Assurance is. Worth pinning, because the alternative
  // reading — that a viewer sees incidents and must be denied the buttons — is
  // the one somebody would write a guard for that protects nothing.
  const { doc } = await boot(t, healthRoutes(), 'viewer');
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="health"]');
  assert.ok(nav, 'the nav entry is gone from the markup, so this spec tests nothing');
  await click(nav, 400);
  assert.equal(byText(doc, '#view button', 'Open'), null, 'a viewer got as far as an incident');
});

test('an incident that will not load says so rather than sitting on Loading', async (t) => {
  const { doc, errors } = await boot(t, healthRoutes({
    [`GET ${SA}/assurance/incidents/9`]: { status: 500, body: { error: 'boom' } },
  }));
  const dialog = await openIncident(doc);
  assert.ok(dialog.querySelector('.sa-error'), 'it is still loading');
  assert.deepEqual(errors, []);
});
