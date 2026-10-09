'use strict';

// The Patterns screen (Settings → Patterns), driven in a real DOM.
//
// The server side is test/eventPatterns.test.js. This is the other half: that
// the dashboard reaches it. The dashboard is dependency-free vanilla JS with no
// build step, so nothing but a browser catches a screen that renders blank, a
// button wired to nothing, or a form that posts the wrong shape.
//
// Everything happens through the UI — nav button, sub-tab, form — because a test
// that called the view function directly would pass with the button unwired.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const ME = { id: 1, email: 'admin@blueeye.local', role: 'admin', preferences: {} };
const BASE_ROUTES = {
  'GET /me': ME,
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': { analysis: true, alerting: true, service_tests: true },
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
  'GET /api/alerting/config': {
    enabled: true,
    channels: {
      email: { enabled: true, minSeverity: 'WARN', available: true },
      matrix: { enabled: false, minSeverity: 'WARN' },
    },
  },
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

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, errors, calls };
}

const click = async (node, ms) => { node.click(); await tick(ms); };
const byText = (doc, selector, text) =>
  [...doc.querySelectorAll(selector)].find((n) => n.textContent.trim() === text) || null;
const textOf = (doc, selector) => [...doc.querySelectorAll(selector)].map((n) => n.textContent.trim());

async function openPatterns(doc) {
  const settings = doc.querySelector('.tabs button[data-view="settings"]');
  assert.ok(settings, 'the Settings nav button is missing');
  await click(settings, 120);
  const group = byText(doc, '#view .subtab', 'Detection & alerts');
  assert.ok(group, `no "Detection & alerts" group — found: ${textOf(doc, '#view .subtab').join(' | ')}`);
  await click(group, 120);
  const tab = byText(doc, '#view .subtab', 'Patterns');
  assert.ok(tab, `no "Patterns" tab — found: ${textOf(doc, '#view .subtab').join(' | ')}`);
  await click(tab, 140);
  return tab;
}

const PATTERN = {
  id: 3,
  name: 'Warehouse links',
  source: 'finding',
  match_metric: 'packet_loss',
  match_kind: null,
  match_host_id: null,
  match_application_id: null,
  reason: 'wifi, not an SLA',
  enabled: true,
  rule_count: 2,
  route: {
    id: 1, pattern_id: 3, channels: 'matrix', channel_list: ['matrix'],
    min_severity: 'WARN', cooldown_ms: 600000, enabled: true, reason: 'the NOC room',
    matched_count: 4, last_matched_at: null,
  },
};

test('the screen reaches the API and says what each pattern matches and where it alerts', async (t) => {
  const { doc, errors, calls } = await boot(t, { 'GET /api/event-patterns': [PATTERN] });
  await openPatterns(doc);

  assert.deepEqual(errors, [], 'the screen threw while rendering');
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/api/event-patterns'), 'the screen never asked for the patterns');

  const row = doc.querySelector('#view .tablewrap table tbody tr');
  assert.ok(row, 'the patterns table did not render');
  assert.match(row.textContent, /Warehouse links/);
  assert.match(row.textContent, /packet_loss/);
  assert.match(row.textContent, /matrix/);
  assert.match(row.textContent, /from WARN/);
  assert.match(row.textContent, /10 min/, 'the cooldown is said in minutes, not milliseconds');
  assert.match(row.textContent, /2 rule/);
});

test('a pattern with no route says so, rather than looking unconfigured', async (t) => {
  const { doc } = await boot(t, { 'GET /api/event-patterns': [{ ...PATTERN, route: null, rule_count: 0 }] });
  await openPatterns(doc);
  const row = doc.querySelector('#view .tablewrap table tbody tr');
  assert.match(row.textContent, /every enabled channel \(default\)/);
});

test('the empty screen explains what happens without patterns', async (t) => {
  const { doc } = await boot(t, { 'GET /api/event-patterns': [] });
  await openPatterns(doc);
  const empty = doc.querySelector('#view .empty');
  assert.ok(empty, 'no empty state rendered');
  assert.match(empty.textContent, /carry their own match/);
});

test('creating a pattern posts the shape the API documents', async (t) => {
  const { doc, calls, errors } = await boot(t, {
    'GET /api/event-patterns': [],
    'POST /api/event-patterns': { status: 201, body: PATTERN },
  });
  await openPatterns(doc);
  const newBtn = byText(doc, '#view button', '+ New pattern');
  assert.ok(newBtn, 'no "+ New pattern" button');
  await click(newBtn, 60);

  const form = doc.querySelector('#modal-card form');
  assert.ok(form, 'the new-pattern form did not open');
  const inputs = [...form.querySelectorAll('input, select, textarea')];
  // name, source, metric, kind, agent, reason, enabled
  assert.equal(inputs.length, 7, `unexpected field count: ${inputs.length}`);
  inputs[0].value = 'Warehouse links';
  inputs[2].value = 'packet_loss';
  inputs[5].value = 'wifi, not an SLA';
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(80);

  assert.deepEqual(errors, []);
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/event-patterns');
  assert.ok(post, 'the form never posted');
  assert.deepEqual(post.body, {
    name: 'Warehouse links',
    source: 'finding',
    reason: 'wifi, not an SLA',
    enabled: true,
    match_metric: 'packet_loss',
    // Blank means "any", which the API spells as null.
    match_kind: null,
    match_host_id: null,
  });
});

test('Count open events asks for the draft\'s match count without saving it', async (t) => {
  const { doc, calls, errors } = await boot(t, {
    'GET /api/event-patterns': [],
    'POST /api/event-patterns/preview': { matched: 12, source: 'finding' },
  });
  await openPatterns(doc);
  await click(byText(doc, '#view button', '+ New pattern'), 60);

  const form = doc.querySelector('#modal-card form');
  const inputs = [...form.querySelectorAll('input, select, textarea')];
  inputs[0].value = 'Loss';
  inputs[2].value = 'packet_loss';
  inputs[5].value = 'r';
  await click(byText(doc, '#modal-card button', 'Count open events'), 80);

  assert.deepEqual(errors, []);
  const preview = calls.find((c) => c.path === '/api/event-patterns/preview');
  assert.ok(preview, 'Count never asked the server');
  assert.equal(preview.body.match_metric, 'packet_loss');
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/api/event-patterns'), 'counting must not save');
  assert.match(doc.querySelector('#modal-card [role="status"]').textContent, /12 open event/);
});

test('the route form posts the channels it was given, and says which ones are off', async (t) => {
  const { doc, calls, errors } = await boot(t, {
    'GET /api/event-patterns': [{ ...PATTERN, route: null }],
    'PUT /api/event-patterns/3/route': PATTERN.route,
  });
  await openPatterns(doc);
  await click(byText(doc, '#view button', 'Alert route…'), 80);

  const form = doc.querySelector('#modal-card form');
  assert.ok(form, 'the route form did not open');
  // A channel that is switched off in Settings → Alerting is still offered —
  // an admin may be setting up in either order — but it says so.
  assert.match(form.textContent, /switched off in Settings/);

  const inputs = [...form.querySelectorAll('input, select, textarea')];
  // email, webhook, matrix, syslog, min_severity, cooldown, reason, enabled
  assert.equal(inputs.length, 8, `unexpected field count: ${inputs.length}`);
  inputs[2].value = 'true'; // matrix
  inputs[4].value = 'WARN';
  inputs[5].value = '10';
  inputs[6].value = 'the NOC room';
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(80);

  assert.deepEqual(errors, []);
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/event-patterns/3/route');
  assert.ok(put, 'the route form never posted');
  assert.deepEqual(put.body, {
    channels: ['matrix'],
    min_severity: 'WARN',
    cooldown_ms: 600000,
    reason: 'the NOC room',
    enabled: true,
  });
});

test('a route with no channel is refused by the form — it would be a mute button', async (t) => {
  const { doc, calls } = await boot(t, { 'GET /api/event-patterns': [{ ...PATTERN, route: null }] });
  await openPatterns(doc);
  await click(byText(doc, '#view button', 'Alert route…'), 80);

  const form = doc.querySelector('#modal-card form');
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(80);

  assert.ok(!calls.some((c) => c.method === 'PUT' && c.path.endsWith('/route')), 'an empty route was posted');
  assert.match(form.querySelector('p.error').textContent, /at least one channel/);
});

test('deleting a pattern says how many severity rules go with it', async (t) => {
  const asked = [];
  const { doc, calls, window } = await boot(t, {
    'GET /api/event-patterns': [PATTERN],
    'DELETE /api/event-patterns/3': { deleted: true, severity_rules_deleted: 2, route_deleted: true },
  });
  window.confirm = (msg) => { asked.push(msg); return true; };
  await openPatterns(doc);
  await click(byText(doc, '#view button', 'Delete'), 80);

  assert.equal(asked.length, 1, 'deleting did not ask');
  assert.match(asked[0], /2 severity rule/);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/event-patterns/3'));
});

// Settings → Detection & alerts is an admin group, so the screen is not on a
// viewer's Settings page at all. The API still allows a viewer to READ patterns
// (a route's channels are not a secret) — this pins that the dashboard does not
// offer a screen whose every button would 403.
test('a viewer is not offered the Patterns screen', async (t) => {
  const { doc } = await boot(t, { 'GET /api/event-patterns': [PATTERN] }, 'viewer');
  const settings = doc.querySelector('.tabs button[data-view="settings"]');
  await click(settings, 120);
  assert.equal(byText(doc, '#view .subtab', 'Detection & alerts'), null);
  assert.equal(byText(doc, '#view .subtab', 'Patterns'), null);
});
