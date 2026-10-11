'use strict';

// Work focus (DEL 5.4) — three jobs, one dashboard. Focus decides what reads
// loudest in the nav; the role and the licence still decide what can be opened.
//
// The two things this test is here to keep true:
//
//   * focus DIMS, it never hides. A screen you were told to open on the phone
//     is always still in the rail.
//   * focus never GRANTS. A viewer with the NOC focus still cannot open the
//     operator-only screens that focus claims.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
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
  return { window, doc: window.document, errors };
}
const settle = () => new Promise((r) => setTimeout(r, 220));

const SESSION = (focus, role = 'admin') => ({
  'GET /me': { id: 1, email: 'x@y.dk', role, preferences: focus ? { focus } : {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/settings/maintenance': { windows: [] },
});

const navBtn = (doc, view) => doc.querySelector(`.tabs button[data-view="${view}"]`);

test('the NOC focus quietens the engineer screens and leaves its own at full weight', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION('noc') });
  await settle();
  assert.deepEqual(errors, []);
  for (const v of ['events', 'clusters', 'troubleshooting', 'home']) {
    assert.ok(!navBtn(doc, v).classList.contains('off-focus'), `${v} belongs to the NOC focus`);
  }
  for (const v of ['flows', 'topology', 'geo', 'nicInventory']) {
    assert.ok(navBtn(doc, v).classList.contains('off-focus'), `${v} belongs to another job`);
  }
});

test('focus dims but never hides — every nav entry is still in the rail and still clickable', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION('manager') });
  await settle();
  const dimmed = [...doc.querySelectorAll('.tabs button.off-focus')];
  assert.ok(dimmed.length > 0, 'the manager focus claims less than everything');
  for (const b of dimmed) {
    assert.ok(!b.classList.contains('role-hidden'), `${b.dataset.view} must not be hidden by focus`);
    assert.ok(!b.classList.contains('hidden'), `${b.dataset.view} must not be hidden by focus`);
    assert.ok(!b.disabled, `${b.dataset.view} must stay clickable`);
  }
  // And the dim is opacity only, so the rail cannot shift under somebody who
  // changes focus mid-call.
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  const rule = css.match(/\.tabs button\.off-focus \{([^}]*)\}/);
  assert.ok(rule, 'the off-focus rule exists');
  assert.doesNotMatch(rule[1], /display|visibility|width|height|margin|padding/);
  window.close();
});

test('a focus never grants: a viewer with the NOC focus still cannot open the operator screens it claims', async (t) => {
  const { doc, errors } = boot({ t, role: 'viewer', routes: SESSION('noc', 'viewer') });
  await settle();
  assert.deepEqual(errors, []);
  // `investigation` is in the NOC set AND operator-only. Role wins.
  const inv = navBtn(doc, 'investigation');
  assert.equal(inv.dataset.minRole, 'operator');
  assert.ok(inv.classList.contains('role-hidden'), 'role visibility still applies under a focus');
});

test('no focus (the default) dims nothing', async (t) => {
  const { doc } = boot({ t, routes: SESSION(null) });
  await settle();
  assert.equal(doc.querySelectorAll('.tabs button.off-focus').length, 0);
});

test('every view a focus claims is a real nav entry', async (t) => {
  // A typo in a focus set would silently drop a screen out of the job that
  // owns it, with nothing to show for it.
  const { doc } = boot({ t, routes: SESSION(null) });
  await settle();
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const block = app.match(/const FOCUS_VIEWS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'public/app.js must declare FOCUS_VIEWS');
  const claimed = [...new Set(block[1].match(/'([a-zA-Z]+)'/g).map((x) => x.replace(/'/g, '')))];
  assert.ok(claimed.length > 10, `expected the focus sets to be populated, got ${claimed.length}`);
  for (const v of claimed) assert.ok(navBtn(doc, v), `focus claims "${v}" but there is no nav entry for it`);
});
