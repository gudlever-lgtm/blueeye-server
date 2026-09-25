'use strict';

// public/views/docs.js — Documentation, as a ListPage (template A)
// (docs/ui-contract.md). A shell migration: the twenty-four article bodies
// stay in app.js.
//
// The migration this pins: twenty-three `.small ghost` buttons in a left rail
// become two levels of SubTabs, and an article gets an address it never had.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const Routes = require('../public/routes.js');

function boot({ t, url = 'http://server.test/docs', role = 'admin', locale = null } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const routes = {
    'GET /me': { id: 1, email: 'x@y.dk', role, preferences: locale ? { locale } : {} },
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
  };
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const status = hit === undefined ? 404 : 200;
    const body = hit === undefined ? { error: 'Not Found' } : hit;
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
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const strips = (doc) => [...doc.querySelectorAll('#view .subtabs')];
const tabsOf = (strip) => [...strip.querySelectorAll('[role="tab"]')];

// The article ids app.js actually ships, read out of the source — the same
// list routes.js has to carry.
function docsIds() {
  const seg = appJs.slice(appJs.indexOf('const DOCS = ['), appJs.indexOf('// ---- Documentation (SHELL MIGRATED'));
  // A title is a literal, or a getter over t() for an article that has been
  // moved into the catalogue (agent-offline).
  return [...seg.matchAll(/^ {8}id: '([^']+)', (?:title: '[^']+'|get title\(\) \{ return t\('[^']+'\); \})/gm)].map((m) => m[1]);
}

test('every article has a route — a new one without an address fails here', () => {
  // An article with no entry in routes.js is unlinkable and `/docs/<it>` is a
  // 404, which is exactly the bug the addressing was added to fix.
  assert.deepEqual(Routes.VIEWS.docs.tabs, docsIds());
  assert.equal(Routes.VIEWS.docs.tabKey, 'docsTopic');
});

test('Documentation is a ListPage, and the rail of buttons is gone', async (t) => {
  const { doc, errors } = boot({ t });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace(/\?$/, ''), 'Documentation');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading row survived');
  assert.equal(doc.querySelectorAll('#view .settings-nav, #view .docs-nav, #view .docs-navlist').length, 0,
    'the left rail of buttons survived');
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner survived');
});

test('the three sections and the articles of one are two tab strips', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.equal(strips(doc).length, 2, 'two levels of SubTabs — see the recorded deviation');
  assert.deepEqual(tabsOf(strips(doc)[0]).map((b) => b.textContent),
    ['Getting started', 'Troubleshooting how-tos', 'Administration & setup']);
  assert.equal(tabsOf(strips(doc)[0])[0].getAttribute('aria-selected'), 'true');
  // The first article of the first section is what /docs opens.
  assert.equal(tabsOf(strips(doc)[1])[0].getAttribute('aria-selected'), 'true');
  assert.match(doc.querySelector('#view .panel-head h2').textContent, /What BlueEyes does/);
  assert.ok(doc.querySelector('#view .docs-article'), 'the article body is not drawn');
});

test('an article has an address, and the address opens it', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/docs/sso' });
  await settle();
  // …with the section it belongs to selected above it.
  assert.equal(tabsOf(strips(doc)[0])[2].getAttribute('aria-selected'), 'true');
  const picked = tabsOf(strips(doc)[1]).find((b) => b.getAttribute('aria-selected') === 'true');
  assert.match(picked.textContent, /SSO|single sign|LDAP|AD/i);
  assert.match(doc.querySelector('#view .panel-head h2').textContent, /SSO|single sign|LDAP|AD/i);
});

test('picking an article writes it into the address', async (t) => {
  const { doc, window } = boot({ t });
  await settle();
  // "Getting started" is two articles, so the second one is the move.
  const target = tabsOf(strips(doc)[1])[1];
  const id = target.dataset.tab || target.getAttribute('data-tab');
  target.click();
  await settle(150);
  assert.equal(window.location.pathname, `/docs/${id}`);
  assert.equal(tabsOf(strips(doc)[1])[1].getAttribute('aria-selected'), 'true');
});

test('moving section opens that section’s first article, never an empty strip', async (t) => {
  const { doc, window } = boot({ t });
  await settle();
  tabsOf(strips(doc)[0])[1].click();
  await settle(150);
  const first = tabsOf(strips(doc)[1])[0];
  assert.equal(first.getAttribute('aria-selected'), 'true');
  assert.equal(window.location.pathname, `/docs/${first.dataset.tab}`);
  assert.equal(doc.querySelector('#view .panel-head h2').textContent, first.textContent);
});

test('a bare /docs still opens the first article, so old links keep working', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/docs' });
  await settle();
  assert.match(doc.querySelector('#view .panel-head h2').textContent, /What BlueEyes does/);
});

test('a non-admin is not offered the admin-only section', async (t) => {
  const { doc, errors } = boot({ t, role: 'viewer' });
  await settle();
  assert.deepEqual(errors, []);
  assert.deepEqual(tabsOf(strips(doc)[0]).map((b) => b.textContent),
    ['Getting started', 'Troubleshooting how-tos']);
});

test('an admin-only article addressed by a viewer falls back, it does not blank the page', async (t) => {
  const { doc, errors } = boot({ t, role: 'viewer', url: 'http://server.test/docs/sso' });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .panel-head h2'), 'the page went blank');
  assert.match(doc.querySelector('#view .panel-head h2').textContent, /What BlueEyes does/);
  assert.equal(doc.querySelectorAll('#view .subtabs').length, 2);
});

test('/docs/does-not-exist is the not-found page, not a blank Documentation', async (t) => {
  const { doc, errors } = boot({ t, url: 'http://server.test/docs/does-not-exist' });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(Routes.match('/docs/does-not-exist'), null);
  assert.ok(!doc.querySelector('#view .docs-article'), 'an unknown article rendered as Documentation');
});

test('every article in every section actually builds', async (t) => {
  // The bodies are the unmigrated half; a throw in one of them used to paint a
  // red box over the page, so the page is where it has to be caught.
  const { doc, errors } = boot({ t });
  await settle();
  for (const id of docsIds()) {
    const tab = [...doc.querySelectorAll('#view .subtabs [role="tab"]')].find((b) => b.dataset.tab === id);
    if (!tab) {
      // Admin-only articles live under the third section — select it first.
      tabsOf(strips(doc)[0])[2].click();
      await settle(120);
    }
    const t2 = [...doc.querySelectorAll('#view .subtabs [role="tab"]')].find((b) => b.dataset.tab === id);
    if (!t2) continue;
    t2.click();
    await settle(60);
    assert.ok(doc.querySelector('#view .docs-article'), `${id}: no body`);
    assert.equal(doc.querySelectorAll('#view .state.is-error').length, 0, `${id}: the body threw`);
  }
  assert.deepEqual(errors, []);
});

test('the article panel is the only frame — no box inside a box', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.equal(doc.querySelectorAll('#view .panel-ui').length, 1);
  assert.equal(doc.querySelectorAll('#view .empty.error, #view .data-card, #view .settings-card').length, 0);
});

// The agent-offline article went through the catalogue (docs.ao.*): the page
// somebody reads with an agent down is the last one to leave in one language.
test('the agent-offline article reads in the reader\'s language, title and all', async (t) => {
  const en = boot({ t, url: 'http://server.test/docs/agent-offline' });
  await settle();
  assert.deepEqual(en.errors, []);
  assert.match(en.doc.querySelector('#view').textContent, /Work from the server outward/);
  assert.match(en.doc.querySelector('#view').textContent, /What to expect/);

  const da = boot({ t, url: 'http://server.test/docs/agent-offline', locale: 'da' });
  await settle();
  const text = da.doc.querySelector('#view').textContent;
  assert.match(text, /Arbejd fra serveren og udad/);
  assert.match(text, /Hvad du kan forvente/);
  assert.match(text, /En agent er offline/);
  assert.doesNotMatch(text, /Work from the server outward|docs\.ao\./);
});
