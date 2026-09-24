'use strict';

// public/views/auditLog.js — the tamper-evident audit log (Administration →
// Audit log integrity) on the UI contract (docs/ui-contract.md).
//
// The behaviour that must survive: the hash-chained entries are listed with a
// category filter that goes to the server, "Verify chain" says INTACT with the
// count it checked, and a broken chain names the first broken entry AND says
// which check failed (edited vs removed) in words — a row number alone is not
// an explanation. A plan without `audit_log` sees "not in your plan", not an
// error.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const ENTRIES = [
  { id: 12, created_at: '2026-09-23T10:00:00.000Z', category: 'auth', action: 'login_success', outcome: 'success', actor_user_id: 1, actor_email: 'admin@x.dk', actor_role: 'admin', target: null, detail: null, ip: '10.0.0.5' },
  { id: 11, created_at: '2026-09-23T09:00:00.000Z', category: 'user', action: 'user_delete', outcome: 'success', actor_user_id: 1, actor_email: 'admin@x.dk', actor_role: 'admin', target: 'bob@x.dk', detail: 'role viewer', ip: '10.0.0.5' },
];

function boot({ t, routes = {}, url = 'http://server.test/audit-log', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const [p, q] = String(u).split('?');
    log.push(`${(opts.method || 'GET').toUpperCase()} ${p}${q ? `?${q}` : ''}`);
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  if (t) t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}
const settle = () => new Promise((r) => setTimeout(r, 250));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'admin@x.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/audit-log': ENTRIES,
  'GET /api/audit-log/categories': ['auth', 'user'],
  'GET /api/audit-log/verify': { ok: true, checked: 2, brokenAt: null },
}, over);

const button = (root, re) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));

test('the audit log is a contract page: header with help, a category filter, and the entries', async (t) => {
  const { doc, errors, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const view = doc.querySelector('#view');
  assert.equal(view.querySelector('h1').textContent.replace('?', '').trim(), 'Audit log integrity');
  assert.ok(view.querySelector('.page-head .help-btn'), 'help lives in the (?) popover');
  assert.ok(log.some((l) => l.startsWith('GET /api/audit-log?')), 'the entries are read');
  assert.ok(log.includes('GET /api/audit-log/categories'));
  const rows = [...view.querySelectorAll('table.dt tbody tr')];
  assert.equal(rows.length, 2);
  assert.match(rows[1].textContent, /user_delete/);
  assert.match(rows[1].textContent, /bob@x\.dk/);
  // A row opens the drawer with who / from where.
  rows[1].click();
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(drawer);
  assert.match(drawer.textContent, /Entry #11/);
  assert.match(drawer.textContent, /10\.0\.0\.5/);
});

test('the category filter goes to the server', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION() });
  await settle();
  const sel = doc.querySelector('#view .toolbar-ui select');
  assert.ok([...sel.options].some((o) => o.value === 'user'), 'categories come from /categories');
  sel.value = 'user';
  sel.dispatchEvent(new doc.defaultView.Event('change'));
  await settle();
  assert.ok(log.some((l) => /^GET \/api\/audit-log\?.*category=user/.test(l)), log.join('\n'));
});

test('Verify chain: an intact chain says so, with the count it checked', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION({ 'GET /api/audit-log/verify': { ok: true, checked: 812, brokenAt: null } }) });
  await settle();
  button(doc.querySelector('#view .page-head'), /Verify chain/).click();
  await settle();
  assert.ok(log.includes('GET /api/audit-log/verify'));
  const text = doc.querySelector('#view').textContent;
  assert.match(text, /Intact/);
  assert.match(text, /812 entries checked/);
});

test('Verify chain: a broken chain names the entry and explains which check failed', async (t) => {
  const edited = boot({ t, routes: SESSION({ 'GET /api/audit-log/verify': { ok: false, checked: 40, brokenAt: 11, reason: 'altered' } }) });
  await settle();
  button(edited.doc.querySelector('#view .page-head'), /Verify chain/).click();
  await settle();
  let text = edited.doc.querySelector('#view').textContent;
  assert.match(text, /Broken at entry #11/);
  assert.match(text, /one of its fields was changed afterwards/);
  assert.match(text, /The entries before #11 are intact/);

  const removed = boot({ t, routes: SESSION({ 'GET /api/audit-log/verify': { ok: false, checked: 40, brokenAt: 12, reason: 'unlinked' } }) });
  await settle();
  button(removed.doc.querySelector('#view .page-head'), /Verify chain/).click();
  await settle();
  text = removed.doc.querySelector('#view').textContent;
  assert.match(text, /Broken at entry #12/);
  assert.match(text, /an entry between them was deleted/);
  assert.doesNotMatch(text, /auditlog\./, 'no raw catalogue key reaches the screen');
});

test('a plan without audit_log is "not in your plan", not an error', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/audit-log': { status: 403, body: { error: 'feature_not_available', feature: 'audit_log' } } }) });
  await settle();
  const view = doc.querySelector('#view');
  assert.match(view.textContent, /Not included in your plan/);
  assert.equal(view.querySelector('.state.is-error'), null);
});

test('a failed load is an ErrorState that names the call', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/audit-log': { status: 500, body: { error: 'Internal Server Error' } } }) });
  await settle();
  const state = doc.querySelector('#view .state.is-error');
  assert.ok(state);
  assert.match(state.textContent, /GET \/api\/audit-log/);
});

test('the nav entry and the address are admin-only', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const btn = doc.querySelector('.tabs button[data-view="auditLog"]');
  assert.equal(btn.dataset.minRole, 'admin');
  assert.equal(btn.dataset.feature, 'audit_log');
  const routes = require('../public/routes.js');
  assert.equal(routes.pathFor('auditLog'), '/audit-log');
  assert.equal(routes.match('/audit-log').view, 'auditLog');
  assert.equal(routes.MIN_ROLE.auditLog, 'admin');
});
