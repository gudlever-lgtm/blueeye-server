'use strict';

// The Logs split, driven in a real DOM.
//
// The server side is covered by test/auditUserLogs.test.js and the rules by
// test/userActivity.test.js. This is the half neither can claim: that the menu
// actually has two entries, that each opens its own view, and that a flagged
// row reaches the screen with its reason attached — a flag nobody can read is
// the one thing this feature must not ship.

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
  'GET /license/features': {},
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
};

const USER_ROW = {
  id: 'events:1',
  source: 'events',
  ts: '2026-09-13T10:00:00.000Z',
  userId: 7,
  name: 'Lars Hansen',
  email: 'lars@example.dk',
  role: 'admin',
  deletedUser: false,
  category: 'agent',
  action: 'agent.delete',
  actionLabel: 'Deleted agent',
  outcome: 'success',
  target: 'srv-01',
  targetType: 'agent',
  method: 'DELETE',
  path: '/agents/3',
  status: 200,
  ip: '10.0.0.5',
  detail: null,
  occurrences: 1,
  flagLevel: 'notice',
  flags: [{ code: 'destructive', level: 'notice', message: 'Irreversible: this removed or reset something and cannot be undone from here.' }],
};

const userLogRoutes = (over = {}) => ({
  'GET /api/audit/users': {
    entries: [USER_ROW],
    summary: { total: 1, critical: 0, warn: 0, notice: 1, flagged: 1, users: 1 },
    total: 1,
    auditLogLicensed: true,
    ...over,
  },
  'GET /users': [{ id: 7, email: 'lars@example.dk', name: 'Lars Hansen', role: 'admin' }],
});

function recordingFetch(routes, calls) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, path: p, url: String(url) });
    const hit = routes[`${method} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
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
const navButton = (doc, view) => doc.querySelector(`.tabs button[data-view="${view}"]`);

// ---------------------------------------------------------------------------

test('the Logs menu has two entries, both admin-only, and they are different views', async (t) => {
  const { doc } = await boot(t);
  const system = navButton(doc, 'logs');
  const user = navButton(doc, 'userLogs');
  assert.ok(system, 'System Logs is missing from the nav');
  assert.ok(user, 'User Logs is missing from the nav');
  assert.equal(system.textContent.trim(), 'System Logs');
  assert.equal(user.textContent.trim(), 'User Logs');
  assert.equal(system.dataset.minRole, 'admin');
  assert.equal(user.dataset.minRole, 'admin');
});

test('an operator sees neither Logs entry', async (t) => {
  const { doc } = await boot(t, {}, 'operator');
  for (const view of ['logs', 'userLogs']) {
    assert.equal(navButton(doc, view).classList.contains('role-hidden'), true, view);
  }
});

test('System Logs reads the server stream; User Logs reads the audit trail', async (t) => {
  const { doc, calls, errors } = await boot(t, { ...userLogRoutes(), 'GET /api/logs': { entries: [], size: 0, capacity: 1000 } });

  await click(navButton(doc, 'logs'), 200);
  assert.deepEqual(errors, []);
  assert.ok(calls.some((c) => c.path === '/api/logs'), 'System Logs did not read /api/logs');
  assert.equal(calls.some((c) => c.path === '/api/audit/users'), false, 'System Logs must not read the audit trail');

  await click(navButton(doc, 'userLogs'), 200);
  assert.deepEqual(errors, []);
  assert.ok(calls.some((c) => c.path === '/api/audit/users'), 'User Logs did not read /api/audit/users');
});

test('a user-log row shows the id, the name, the action and its flag reason', async (t) => {
  const { doc, errors } = await boot(t, userLogRoutes());
  await click(navButton(doc, 'userLogs'), 250);
  assert.deepEqual(errors, []);

  const row = doc.querySelector('#view tbody tr');
  assert.ok(row, 'the user log table did not render');
  const text = row.textContent;
  assert.match(text, /#7/);
  assert.match(text, /Lars Hansen/);
  assert.match(text, /lars@example\.dk/);
  assert.match(text, /Deleted agent/);
  assert.match(text, /Irreversible/, 'the flag reason is not on the row');
  assert.ok(row.querySelector('.badge'), 'the flag badge is missing');
});

test('a clean row carries no flag badge', async (t) => {
  const clean = { ...USER_ROW, flagLevel: 'none', flags: [] };
  const { doc } = await boot(t, userLogRoutes({ entries: [clean], summary: { total: 1, critical: 0, warn: 0, notice: 0, flagged: 0, users: 1 } }));
  await click(navButton(doc, 'userLogs'), 250);
  const row = doc.querySelector('#view tbody tr');
  assert.equal(row.querySelector('.badge'), null);
});

test('"flagged only" is sent to the server, not filtered away in the browser', async (t) => {
  const { doc, calls } = await boot(t, userLogRoutes());
  await click(navButton(doc, 'userLogs'), 250);
  const box = doc.querySelector('#view input[type="checkbox"]');
  assert.ok(box, 'the flagged-only checkbox is missing');
  box.checked = true;
  box.dispatchEvent(new doc.defaultView.Event('change'));
  await tick(150);
  assert.ok(calls.some((c) => c.path === '/api/audit/users' && c.url.includes('flagged=1')));
});

test('an unlicensed audit_log is said out loud, not hidden', async (t) => {
  const { doc } = await boot(t, userLogRoutes({ auditLogLicensed: false }));
  await click(navButton(doc, 'userLogs'), 250);
  assert.match(doc.querySelector('#view').textContent, /Professional plan/);
});

test('a failing audit endpoint shows the error instead of an empty page', async (t) => {
  const { doc, errors } = await boot(t, {
    'GET /users': [],
    'GET /api/audit/users': { status: 500, body: { error: 'audit store unreachable' } },
  });
  await click(navButton(doc, 'userLogs'), 250);
  assert.deepEqual(errors, []);
  assert.match(doc.querySelector('#view').textContent, /Could not load the user log/);
});

test('server-supplied names and flag reasons are never parsed as HTML', async (t) => {
  const XSS = '<img src=x onerror="window.__pwned=1">';
  const evil = { ...USER_ROW, name: XSS, email: XSS, actionLabel: XSS, flags: [{ code: 'destructive', level: 'notice', message: XSS }] };
  const { doc, window } = await boot(t, userLogRoutes({ entries: [evil] }));
  await click(navButton(doc, 'userLogs'), 250);
  assert.equal(window.__pwned, undefined);
  assert.equal(doc.querySelector('#view img[src="x"]'), null, 'payload was parsed as markup');
});
