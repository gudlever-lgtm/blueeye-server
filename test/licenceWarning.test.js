'use strict';

// "Could not read the licence. Some modules may look unavailable until this is
// fixed." — a warning that was showing on a perfectly licensed server.
//
// The trigger was an EXPIRED token at page load: render() asks /me, gets 401,
// logs the session out (loadProfile swallows the error), and then carried on to
// fetch /license/features and /license/plan with no token at all. Two more 401s,
// and the licence was marked unreadable — on the login screen, where no licence
// had been read in the first place.
//
// Three claims:
//   1. An expired session shows the login screen and NO licence warning.
//   2. A real failure (500 on the licence routes) still warns.
//   3. The licence routes are not called once the session is gone.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const BASE = {
  'GET /me': { id: 1, email: 'op@blueeye.local', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license/features': { analysis: true, assistant: true, alerting: true, geo: true },
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
};

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function boot(t, routes = {}) {
  const calls = [];
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const table = { ...BASE, ...routes };
  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const p = String(url).split('?')[0];
    calls.push(`${method} ${p}`);
    const hit = Object.prototype.hasOwnProperty.call(table, `${method} ${p}`) ? table[`${method} ${p}`] : null;
    const status = hit && hit.__status ? hit.__status : 200;
    const payload = hit && hit.__status ? (hit.body ?? {}) : (hit ?? {});
    return {
      ok: status < 300, status,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', 'admin');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, calls };
}

const toastText = (doc) => {
  const el = doc.querySelector('#toast');
  return el && !el.classList.contains('hidden') ? el.textContent : '';
};

test('an expired session lands on the login screen without the licence warning', async (t) => {
  const { doc, calls } = await boot(t, { 'GET /me': { __status: 401, body: { error: 'Unauthorized' } } });
  assert.equal(doc.querySelector('#login').classList.contains('hidden'), false, 'the login screen is not showing');
  assert.doesNotMatch(toastText(doc), /licen/i, `the licence warning showed on the login screen: "${toastText(doc)}"`);
  // ...and nothing asked about the licence once the session was gone.
  assert.equal(calls.filter((c) => c.includes('/license/')).length, 0, `licence routes were called after logout: ${calls.join(', ')}`);
});

test('a licence route that really fails (500) still warns', async (t) => {
  const { doc } = await boot(t, { 'GET /license/features': { __status: 500, body: { error: 'boom' } } });
  assert.match(toastText(doc), /licen/i, 'a failed licence read said nothing');
});

test('a licence route that 404s warns too', async (t) => {
  const { doc } = await boot(t, { 'GET /license/plan': { __status: 404, body: { error: 'not found' } } });
  assert.match(toastText(doc), /licen/i, 'a missing licence route said nothing');
});

test('a readable licence warns about nothing', async (t) => {
  const { doc } = await boot(t);
  assert.doesNotMatch(toastText(doc), /licen/i, `warned on a healthy licence: "${toastText(doc)}"`);
});
