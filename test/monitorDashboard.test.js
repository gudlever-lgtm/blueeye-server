'use strict';

// The monitor screen and its dialog, driven in a real DOM.
//
// Two complaints, both about the same thing — the screen not saying what it
// does:
//
//   1. "Check every (seconds)" is what makes a monitor run forever, and the
//      form said nothing about that. There was also no way to stop one short of
//      deleting it, which throws the history away with it.
//   2. Typing 50 into that field and pressing Save produced a disabled button
//      for a moment and no visible reason. The reason WAS rendered — at the
//      bottom of a dialog that scrolls for two screens, where nobody was
//      looking.
//
// So this suite is about the explanation, not the plumbing: the field that was
// rejected is marked where it stands, and pausing exists.

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
    const resolved = typeof hit === 'function' ? hit(body) : hit;
    const status = resolved === undefined ? 404 : (resolved.status || 200);
    const payload = resolved === undefined
      ? { error: 'Not Found', path: p }
      : (resolved.body !== undefined ? resolved.body : resolved);
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

const MONITOR = {
  id: 7,
  name: 'Customer mail',
  type: 'tcp_port',
  target: 'mail.example.dk',
  interval_sec: 900,
  warn_ms: null,
  crit_ms: null,
  enabled: true,
  pending: false,
  activated_at: '2026-09-15T10:00:00.000Z',
  last_run_at: '2026-09-15T17:30:00.000Z',
  last_status: 'ok',
  has_secrets: {},
  config: { host: 'mail.example.dk', port: 25 },
  recent: [],
  summary: { checks: 4, ok: 4, slow: 0, bad: 0, availability: 1, avg_value: 42, max_value: 80, since: null },
};

const TYPES = {
  types: [{
    type: 'tcp_port',
    label: 'TCP port',
    category: 'network',
    target: 'host',
    default_interval_sec: 300,
    measures: { unit: 'ms', label: 'Connect time' },
    secrets: [],
    fields: [
      { field: 'host', type: 'host', required: true, default: null, show_when: null },
      { field: 'port', type: 'int', required: true, default: 25, min: 1, max: 65535, show_when: null },
    ],
  }],
  // The floor an operator will be judged against, raised above the built-in 60
  // so the spec can tell "the form was told" from "the form guessed".
  limits: { min_interval_sec: 120, max_interval_sec: 86400, max_ms: 3600000, max_monitors: 200, recipient_domains: [] },
};

const routes = (over = {}) => ({
  [`GET ${SA}/monitors`]: [MONITOR],
  [`GET ${SA}/monitors/types`]: TYPES,
  [`GET ${SA}/monitors/7`]: MONITOR,
  [`GET ${SA}/monitors/7/series`]: {
    monitor_id: 7, period: 'day', bucket: 'hour', unit: 'ms', buckets: [], total: { checks: 0, availability: null },
  },
  [`GET ${SA}/monitors/7/results`]: { results: [] },
  ...over,
});

async function openMonitor(t, over = {}) {
  const ctx = await boot(t, routes(over));
  const nav = ctx.doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="monitors"]');
  assert.ok(nav, 'no Monitors nav button');
  await click(nav, 250);
  const row = ctx.doc.querySelector('#view table.data-table tbody tr');
  assert.ok(row, 'no monitor row');
  await click(row, 300);
  return ctx;
}

const buttonSaying = (doc, text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

// ------------------------------------------------------- what the field means
test('the interval field says it runs forever, and carries the real bounds', async (t) => {
  const { doc } = await openMonitor(t);
  await click(buttonSaying(doc, 'Edit'), 250);

  const interval = doc.querySelector('.sa-modal [data-field="interval_sec"]');
  assert.ok(interval, 'the interval field is not identified');
  const help = interval.querySelector('.sa-help').textContent;
  assert.match(help, /repeats forever/, `the field does not say what it does: ${help}`);
  assert.match(help, /pause or delete/);
  // The floor is the SERVER's, not a number typed into the dialog.
  assert.match(help, /120/, `the form invented its own minimum: ${help}`);
  assert.equal(interval.querySelector('input').getAttribute('min'), '120');
});

test('the detail says the monitor is watching and will keep going', async (t) => {
  const { doc } = await openMonitor(t);
  assert.match(doc.querySelector('#view').textContent, /keeps going until you pause or delete it/);
});

// -------------------------------------------------------------- the rejection
test('a rejected field is marked where it stands, not only listed at the bottom', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: {
      status: 400,
      body: { error: 'Validation failed', details: { interval_sec: 'must be at least 120 seconds' } },
    },
  });
  await click(buttonSaying(doc, 'Edit'), 250);

  const dialog = doc.querySelector('.sa-modal');
  const input = dialog.querySelector('[data-field="interval_sec"] input');
  input.value = '50';
  await click(buttonSaying(doc, 'Save'), 200);

  const marked = dialog.querySelector('[data-field="interval_sec"].sa-field-invalid');
  assert.ok(marked, 'the field that was rejected looks exactly like the ones that were not');
  assert.match(marked.querySelector('.sa-field-error').textContent, /at least 120 seconds/);

  // The summary names the field in the words the LABEL uses, rather than
  // printing the wire key at somebody.
  const box = dialog.querySelector('.sa-form-errors');
  assert.match(box.textContent, /Not saved/);
  assert.match(box.textContent, /Check every \(seconds\)/, box.textContent);
  assert.equal(box.getAttribute('role'), 'alert');

  // And Save works again — a rejection is not a dead dialog.
  assert.equal(buttonSaying(doc, 'Save').disabled, false);
});

test('fixing the field clears the mark as you type', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 400, body: { error: 'Validation failed', details: { interval_sec: 'must be at least 120 seconds' } } },
  });
  await click(buttonSaying(doc, 'Edit'), 250);
  const dialog = doc.querySelector('.sa-modal');
  await click(buttonSaying(doc, 'Save'), 200);
  assert.ok(dialog.querySelector('.sa-field-invalid'), 'nothing was marked');

  const input = dialog.querySelector('[data-field="interval_sec"] input');
  input.value = '300';
  input.dispatchEvent(new dialog.ownerDocument.defaultView.Event('input'));
  assert.equal(dialog.querySelector('[data-field="interval_sec"].sa-field-invalid'), null, 'the mark outlived the mistake');
});

test('a config field is marked too — the dialog is mostly config fields', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 400, body: { error: 'Validation failed', details: { 'config.port': 'must be at most 65535' } } },
  });
  await click(buttonSaying(doc, 'Edit'), 250);
  const dialog = doc.querySelector('.sa-modal');
  await click(buttonSaying(doc, 'Save'), 200);
  const marked = dialog.querySelector('[data-field="config.port"].sa-field-invalid');
  assert.ok(marked, 'a config field cannot be marked');
  assert.match(marked.querySelector('.sa-field-error').textContent, /at most 65535/);
});

test('an error with no field detail still says something, rather than flickering', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 500, body: { error: 'Something failed' } },
  });
  await click(buttonSaying(doc, 'Edit'), 250);
  const dialog = doc.querySelector('.sa-modal');
  await click(buttonSaying(doc, 'Save'), 200);
  const box = dialog.querySelector('.sa-form-errors');
  assert.match(box.textContent, /Not saved/);
  assert.match(box.textContent, /Something failed/);
  assert.equal(buttonSaying(doc, 'Save').disabled, false);
});

// ------------------------------------------------------------- the stop button
test('a running monitor can be paused, and says what pausing does', async (t) => {
  const paused = { ...MONITOR, enabled: false };
  let saved = null;
  const { doc, calls } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: (body) => { saved = body; return paused; },
    [`GET ${SA}/monitors/7`]: () => (saved ? paused : MONITOR),
    [`GET ${SA}/monitors`]: () => [saved ? paused : MONITOR],
  });

  const pause = buttonSaying(doc, 'Pause');
  assert.ok(pause, 'there is no way to stop a monitor short of deleting it');
  assert.match(pause.getAttribute('title'), /Everything is kept/);

  await click(pause, 300);
  assert.deepEqual(saved, { enabled: false }, `pause sent ${JSON.stringify(saved)}`);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);

  const text = doc.querySelector('#view').textContent;
  assert.match(text, /Paused\./);
  assert.match(text, /automatic checks are stopped/);
  assert.ok(buttonSaying(doc, 'Resume'), 'a paused monitor cannot be started again');
});

test('resuming sends the opposite, and only that', async (t) => {
  let saved = null;
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: { ...MONITOR, enabled: false },
    [`GET ${SA}/monitors`]: [{ ...MONITOR, enabled: false }],
    [`PATCH ${SA}/monitors/7`]: (body) => { saved = body; return { ...MONITOR, enabled: true }; },
  });
  await click(buttonSaying(doc, 'Resume'), 300);
  assert.deepEqual(saved, { enabled: true });
});

test('a pause that fails leaves the button usable and says why', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 500, body: { error: 'database is on fire' } },
  });
  const pause = buttonSaying(doc, 'Pause');
  await click(pause, 250);
  assert.equal(pause.disabled, false, 'a failed pause left the button dead');
  assert.match(doc.body.textContent, /database is on fire/);
});

// The whole module is operator+ in the sidebar (`data-min-role="operator"` on
// every Service Assurance tab), so there is no viewer to test the buttons
// against — the role gate is one screen further out. What IS worth pinning is
// that the two "not running" states never claim to be each other.
test('a pending monitor says it is not watching yet, and never that it keeps going', async (t) => {
  const pending = { ...MONITOR, pending: true, activated_at: null, last_run_at: null, last_status: null };
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors`]: [pending],
    [`GET ${SA}/monitors/7`]: pending,
  });
  const text = doc.querySelector('#view').textContent;
  assert.match(text, /starts running on its schedule once one check has worked/);
  assert.doesNotMatch(text, /keeps going until you pause/);
  assert.doesNotMatch(text, /automatic checks are stopped/);
});
