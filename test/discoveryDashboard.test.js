'use strict';

// Authenticated discovery, driven in a real DOM.
//
// The server side is covered by src/serviceTests/api/__tests__/api.test.js and
// the worker side by src/serviceTests/scheduler/__tests__/workerSignIn.test.js.
// This is the half neither of those can claim: that a person can reach it. The
// feature shipped API-only — the record grew four fields and the screen showed
// none of them, and there was no way to pick a login at all.
//
// Two things are pinned here, and they are the two that matter:
//   1. the dialog sends the route the operator picked, and never both;
//   2. a discovery that could NOT sign in says so on the screen, because the
//      result is then a map of the public site and nothing downstream can tell.

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

const APP_ROW = { id: 1, name: 'Kundeportal', base_url: 'https://portal.kunde.dk', enabled: true, test_count: 2 };

function appDetail(over = {}) {
  return {
    ...APP_ROW,
    environments: [{ id: 7, name: 'Production', type: 'production', base_url: 'https://portal.kunde.dk' }],
    credentials: [{ id: 3, label: 'Test user', username: 'svc-test', has_secret: true }],
    allowed_hosts: [],
    last_discovery: null,
    login_form_found: false,
    login_tests: [],
    ...over,
  };
}

const appRoutes = (detail) => ({
  [`GET ${SA}/applications`]: [APP_ROW],
  [`GET ${SA}/applications/1`]: detail,
  [`GET ${SA}/tests`]: [],
});

// Navigates: Service Assurance → Applications → the application itself.
async function openApplication(doc, extraTicks = 200) {
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="applications"]');
  assert.ok(nav, 'no Applications nav button');
  await click(nav, extraTicks);
  const row = byText(doc, '#view td', 'Kundeportal') || doc.querySelector('#view tbody tr');
  assert.ok(row, 'the application list did not render');
  await click(row, extraTicks);
  assert.ok(byText(doc, '#view button', 'Discover'), 'the application detail did not render');
}

async function openDiscoverDialog(doc) {
  await click(byText(doc, '#view button', 'Discover'), 120);
  const dialog = doc.querySelector('.sa-modal');
  assert.ok(dialog, 'Discover opened no dialog');
  return dialog;
}

const segment = (dialog, label) => byText(dialog, '.sa-segment', label);
const saveButton = (dialog) => [...dialog.querySelectorAll('.sa-modal-foot button')].pop();

// ------------------------------------------------------------- the dialog
test('Discover opens a dialog offering both ways to sign in', async (t) => {
  const { doc, errors } = await boot(t, appRoutes(appDetail()));
  await openApplication(doc);
  const dialog = await openDiscoverDialog(doc);

  assert.ok(segment(dialog, 'No'), 'no anonymous option');
  assert.ok(segment(dialog, 'Use a login test'), 'no login-test option');
  assert.ok(segment(dialog, 'Use a stored login'), 'no stored-login option');
  assert.deepEqual(errors, []);
});

test('the default is an anonymous crawl, and it posts nothing about signing in', async (t) => {
  const routes = appRoutes(appDetail());
  routes[`POST ${SA}/discovery`] = { status: 202, body: { discovery_id: 5, status: 'queued', worker: { connected: true } } };
  const { doc, calls, errors } = await boot(t, routes);
  await openApplication(doc);
  const dialog = await openDiscoverDialog(doc);
  await click(saveButton(dialog), 150);

  const post = calls.find((c) => c.method === 'POST' && c.path === `${SA}/discovery`);
  assert.ok(post, 'the dialog never called the API');
  assert.equal(post.body.application_id, 1);
  assert.equal(post.body.login_test_id, undefined);
  assert.equal(post.body.credential_id, undefined);
  assert.deepEqual(errors, []);
});

test('picking a login test sends that test and no credential', async (t) => {
  const routes = appRoutes(appDetail({ login_tests: [{ id: 9, name: 'Customer Login' }] }));
  routes[`POST ${SA}/discovery`] = { status: 202, body: { discovery_id: 6, status: 'queued', worker: { connected: true } } };
  const { doc, calls, errors } = await boot(t, routes);
  await openApplication(doc);
  const dialog = await openDiscoverDialog(doc);

  await click(segment(dialog, 'Use a login test'), 80);
  const select = dialog.querySelector('.sa-modal-body select:last-of-type');
  assert.ok(byText(dialog, 'option', 'Customer Login'), 'the usable login test was not offered');
  await click(saveButton(dialog), 150);

  const post = calls.find((c) => c.method === 'POST' && c.path === `${SA}/discovery`);
  assert.equal(post.body.login_test_id, 9);
  assert.equal(post.body.credential_id, undefined, 'the server refuses both, and so must the dialog');
  assert.ok(select, 'no picker rendered');
  assert.deepEqual(errors, []);
});

test('picking a stored login sends that credential and no test', async (t) => {
  const routes = appRoutes(appDetail({ login_form_found: true }));
  routes[`POST ${SA}/discovery`] = { status: 202, body: { discovery_id: 7, status: 'queued', worker: { connected: true } } };
  const { doc, calls, errors } = await boot(t, routes);
  await openApplication(doc);
  const dialog = await openDiscoverDialog(doc);

  await click(segment(dialog, 'Use a stored login'), 80);
  assert.ok(byText(dialog, 'option', 'Test user (svc-test)'), 'the stored login was not offered');
  await click(saveButton(dialog), 150);

  const post = calls.find((c) => c.method === 'POST' && c.path === `${SA}/discovery`);
  assert.equal(post.body.credential_id, 3);
  assert.equal(post.body.login_test_id, undefined);
  assert.deepEqual(errors, []);
});

test('with no login form on record the stored-login route explains itself instead of failing later', async (t) => {
  // The common first-run case. The server refuses this combination with the same
  // sentence; saying it in the dialog is the difference between a fix now and a
  // public-site map half an hour later.
  const { doc, errors } = await boot(t, appRoutes(appDetail({ login_form_found: false })));
  await openApplication(doc);
  const dialog = await openDiscoverDialog(doc);

  await click(segment(dialog, 'Use a stored login'), 80);
  assert.match(dialog.textContent, /No login form has been found/);
  assert.equal(dialog.querySelectorAll('.sa-modal-body select').length, 1, 'only the environment picker');
  assert.deepEqual(errors, []);
});

test('with no login test on the application, the login-test route says so', async (t) => {
  const { doc, errors } = await boot(t, appRoutes(appDetail({ login_tests: [] })));
  await openApplication(doc);
  const dialog = await openDiscoverDialog(doc);

  await click(segment(dialog, 'Use a login test'), 80);
  assert.match(dialog.textContent, /No test on this application signs in/);
  assert.deepEqual(errors, []);
});

test('a server refusal lands on the field it is about rather than as a toast', async (t) => {
  const routes = appRoutes(appDetail({ login_tests: [{ id: 9, name: 'Customer Login' }] }));
  routes[`POST ${SA}/discovery`] = {
    status: 400,
    body: { error: 'Validation failed', details: { login_test_id: 'that test does more than sign in' } },
  };
  const { doc, errors } = await boot(t, routes);
  await openApplication(doc);
  const dialog = await openDiscoverDialog(doc);
  await click(segment(dialog, 'Use a login test'), 80);
  await click(saveButton(dialog), 150);

  assert.ok(doc.querySelector('.sa-modal'), 'the dialog closed on a refusal, losing what was typed');
  assert.match(doc.querySelector('.sa-modal').textContent, /does more than sign in/);
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------- reading the result
test('a discovery that signed in says so on the screen', async (t) => {
  const detail = appDetail({
    last_discovery: {
      id: 12, status: 'complete', page_count: 24, form_count: 3, login_count: 1, element_count: 80,
      authenticated: true, authenticated_page_count: 19, session_lost_at_page: null,
      auth_note: 'Signed in. 19 of 24 pages were only reachable once signed in.',
    },
  });
  const { doc, errors } = await boot(t, appRoutes(detail));
  await openApplication(doc);

  const note = doc.querySelector('#view .sa-auth-note');
  assert.ok(note, 'the sign-in outcome is not on the screen at all');
  assert.match(note.textContent, /19 of 24 pages/);
  assert.ok(note.classList.contains('ok'));
  assert.deepEqual(errors, []);
});

test('a discovery that could NOT sign in is marked as a warning, not as a caption', async (t) => {
  // The one that has to be visible. The counts look like a successful crawl —
  // they are the PUBLIC site, and only this note says so.
  const detail = appDetail({
    last_discovery: {
      id: 13, status: 'complete', page_count: 6, form_count: 1, login_count: 1, element_count: 20,
      authenticated: false, authenticated_page_count: 0, session_lost_at_page: null,
      auth_note: 'Could not sign in, so this is the public site only — that test is turned off',
    },
  });
  const { doc, errors } = await boot(t, appRoutes(detail));
  await openApplication(doc);

  const note = doc.querySelector('#view .sa-auth-note');
  assert.ok(note, 'a public-site map was shown as if it were the authenticated one');
  assert.ok(note.classList.contains('warn'), 'it did not read as a warning');
  assert.match(note.textContent, /public site only/);
  assert.deepEqual(errors, []);
});

test('a lost session reads as a warning even though it did sign in', async (t) => {
  const detail = appDetail({
    last_discovery: {
      id: 14, status: 'complete', page_count: 9, form_count: 1, login_count: 1, element_count: 30,
      authenticated: true, authenticated_page_count: 4, session_lost_at_page: 4,
      auth_note: 'Signed in, but the session was lost after 4 pages. 4 of 9 pages were seen while signed in — the rest are the public site.',
    },
  });
  const { doc } = await boot(t, appRoutes(detail));
  await openApplication(doc);
  const note = doc.querySelector('#view .sa-auth-note');
  assert.ok(note.classList.contains('warn'), 'half a private map must not read as a whole one');
});

test('a discovery that never asked to sign in shows no note at all', async (t) => {
  const detail = appDetail({
    last_discovery: {
      id: 15, status: 'complete', page_count: 6, form_count: 1, login_count: 1, element_count: 20,
      authenticated: false, authenticated_page_count: 0, session_lost_at_page: null, auth_note: null,
    },
  });
  const { doc } = await boot(t, appRoutes(detail));
  await openApplication(doc);
  assert.equal(doc.querySelector('#view .sa-auth-note'), null, 'silence, not a reassurance nobody asked for');
});

// ------------------------------------------------------------------- RBAC
test('a viewer never reaches the screen at all — the whole module is operator+', async (t) => {
  const { doc } = await boot(t, appRoutes(appDetail()), 'viewer');
  const nav = doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="applications"]');
  assert.ok(nav, 'the nav entry is gone from the markup, so this spec is testing nothing');
  await click(nav, 200);
  assert.ok(!doc.querySelector('#view button.primary, #view .sa-panel')
    || byText(doc, '#view button', 'Discover') === null,
  'a viewer got as far as a Discover button');
});

test('an operator, who cannot manage logins, can still start an authenticated discovery', async (t) => {
  // The two permissions are different questions. Managing stored logins is an
  // administrator's job; USING one to run a read-only crawl is the operator's,
  // and the discovery route says so — so the dialog must not be narrower.
  const routes = appRoutes(appDetail({ login_form_found: true }));
  routes[`POST ${SA}/discovery`] = { status: 202, body: { discovery_id: 8, status: 'queued', worker: { connected: true } } };
  const { doc, calls, errors } = await boot(t, routes, 'operator');
  await openApplication(doc);

  assert.equal(byText(doc, '#view button', 'Edit'), null, 'an operator was offered an admin action');
  const dialog = await openDiscoverDialog(doc);
  await click(segment(dialog, 'Use a stored login'), 80);
  await click(saveButton(dialog), 150);

  const post = calls.find((c) => c.method === 'POST' && c.path === `${SA}/discovery`);
  assert.equal(post.body.credential_id, 3);
  assert.deepEqual(errors, []);
});
