'use strict';

// The banner that says the server is handing agents an address it does not
// answer on, driven in a real DOM.
//
// It exists because of one incident: a proxy began redirecting http to https,
// the address agents had been given still said http, and a WebSocket handshake
// does not follow redirects. Every agent logged the failure, hundreds of times.
// The dashboard — reached over https by the same people, on the same day — said
// nothing at all. The dashboard is the one place that CAN tell: it knows the
// address it was itself loaded from.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const SETTINGS = (publicUrl) => ({
  agents: {}, events: {}, alerting: {}, retention: {}, map: {}, geoip: {},
  publicUrl,
});

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

async function boot(t, { url, settings, role = 'admin' }) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const table = {
    'GET /me': { id: 1, email: 'op@blueeye.local', role, preferences: {} },
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    'GET /license/features': {},
    'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
    'GET /api/settings': SETTINGS(settings),
    'GET /api/findings/attack-indication': { count: 0, bySeverity: {}, worst: null, findings: [] },
    'GET /system/trust-keys': { available: false, keys: {} },
  };
  window.fetch = async (u, opts = {}) => {
    const key = `${(opts.method || 'GET').toUpperCase()} ${String(u).split('?')[0]}`;
    const hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : {};
    return {
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => hit, text: async () => JSON.stringify(hit),
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(200);
  return { window, doc: window.document, errors };
}

const banner = (doc) => doc.querySelector('#public-url-banner');
const shown = (doc) => banner(doc) && !banner(doc).classList.contains('hidden');

test('the address matches the one the dashboard was loaded from: nothing is said', async (t) => {
  const { doc, errors } = await boot(t, {
    url: 'https://blueeye.kunde.dk/',
    settings: { publicUrl: 'https://blueeye.kunde.dk', effective: 'https://blueeye.kunde.dk', allowHttp: false },
  });
  assert.equal(shown(doc), false, 'a correct deployment must not be nagged');
  assert.deepEqual(errors, []);
});

test('THE INCIDENT: agents told http, dashboard reached over https', async (t) => {
  const { doc } = await boot(t, {
    url: 'https://blueeye-server.gnf.dk/',
    settings: { publicUrl: '', envPublicUrl: 'http://blueeye-server.gnf.dk', effective: 'http://blueeye-server.gnf.dk', allowHttp: false },
  });
  assert.equal(shown(doc), true, 'the one case this exists for went unreported');
  const text = banner(doc).textContent;
  assert.match(text, /http:\/\/blueeye-server\.gnf\.dk/, 'it names the address agents were given');
  assert.match(text, /https:\/\/blueeye-server\.gnf\.dk/, 'and the address this page answers on');
  assert.match(text, /does not follow redirects/i, 'and why that is fatal rather than cosmetic');
});

test('a different host is reported too, not just a different scheme', async (t) => {
  const { doc } = await boot(t, {
    url: 'https://new-name.kunde.dk/',
    settings: { publicUrl: 'https://old-name.kunde.dk', effective: 'https://old-name.kunde.dk', allowHttp: false },
  });
  assert.equal(shown(doc), true);
  assert.match(banner(doc).textContent, /old-name\.kunde\.dk/);
});

test('plain http that an admin called deliberate is left alone', async (t) => {
  const { doc } = await boot(t, {
    url: 'http://blueeye.intern/',
    settings: { publicUrl: 'http://blueeye.intern', effective: 'http://blueeye.intern', allowHttp: true },
  });
  assert.equal(shown(doc), false, 'a deployment that said so is not a mistake');
});

test('nothing configured at all is its own warning', async (t) => {
  const { doc } = await boot(t, {
    url: 'https://blueeye.kunde.dk/',
    settings: { publicUrl: '', envPublicUrl: '', effective: '', allowHttp: false },
  });
  assert.equal(shown(doc), true);
  assert.match(banner(doc).textContent, /whatever address the enrolling host/i);
});

test('localhost is the dev server, and never warned about', async (t) => {
  const { doc } = await boot(t, {
    url: 'http://localhost:3000/',
    settings: { publicUrl: '', envPublicUrl: '', effective: '', allowHttp: false },
  });
  assert.equal(shown(doc), false);
});

test('a viewer is not shown a warning they cannot act on', async (t) => {
  const { doc } = await boot(t, {
    url: 'https://blueeye.kunde.dk/',
    settings: { publicUrl: 'http://blueeye.kunde.dk', effective: 'http://blueeye.kunde.dk', allowHttp: false },
    role: 'viewer',
  });
  assert.equal(shown(doc), false, 'only an admin can change it');
});
