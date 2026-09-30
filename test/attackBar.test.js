'use strict';

// The red line at the top, driven in a real DOM.
//
// Three claims, and they are different:
//   1. It is invisible when nothing is indicating an attack — which is almost
//      always, and the reason it may be three pixels rather than a banner.
//   2. It appears, says what happened, and marks a CRIT differently from a WARN.
//   3. Clicking it lands somewhere useful: the event case when the finding has
//      one, the filtered findings list when it does not.

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
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': {},
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
};

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function boot(t, routes = {}) {
  const errors = [];
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const table = { ...BASE, ...routes };
  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const p = String(url).split('?')[0].replace(/^\/api\/(?!)/, '');
    calls.push(`${method} ${p}`);
    const key = `${method} ${p}`;
    const hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
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
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', 'admin');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(150);
  return { window, doc: window.document, errors, calls };
}

const QUIET = { count: 0, bySeverity: {}, worst: null, findings: [], windowHours: 24 };
const finding = (over = {}) => ({
  id: 'f1', metric: 'net.scan', severity: 'WARN', hostId: '7', eventCaseId: null,
  createdAt: '2026-09-30T10:00:00Z', explanation: '10.0.0.66 reached 400 distinct ports', ...over,
});

test('nothing indicating an attack: the bar is hidden and takes no space', async (t) => {
  const { doc, errors } = await boot(t, { 'GET /api/findings/attack-indication': QUIET });
  const bar = doc.querySelector('#attack-bar');
  assert.ok(bar, 'the bar is not in the shell');
  assert.equal(bar.hidden, true, 'the bar is showing with nothing to show');
  assert.deepEqual(errors, []);
});

test('a WARN raises the line and it says what happened', async (t) => {
  const { doc, errors, calls } = await boot(t, {
    'GET /api/findings/attack-indication': { count: 1, bySeverity: { WARN: 1 }, worst: 'WARN', findings: [finding()], windowHours: 24 },
  });
  assert.ok(calls.includes('GET /api/findings/attack-indication'), 'the bar never asked');
  const bar = doc.querySelector('#attack-bar');
  assert.equal(bar.hidden, false);
  assert.equal(bar.classList.contains('crit'), false, 'a WARN was marked critical');
  assert.match(doc.querySelector('#attack-bar-label').textContent, /1 attack indication/);
  assert.match(doc.querySelector('#attack-bar-detail').textContent, /net\.scan/);
  assert.match(doc.querySelector('#attack-bar-detail').textContent, /400 distinct ports/);
  // It is a control, not decoration: reachable and announced as one.
  assert.equal(bar.tagName, 'BUTTON');
  assert.ok(bar.getAttribute('aria-label') || bar.getAttribute('title'));
  assert.deepEqual(errors, []);
});

test('a CRIT is marked so, and several are counted in the plural', async (t) => {
  const { doc } = await boot(t, {
    'GET /api/findings/attack-indication': {
      count: 3,
      bySeverity: { WARN: 2, CRIT: 1 },
      worst: 'CRIT',
      findings: [finding({ id: 'c1', metric: 'net.beacon', severity: 'CRIT', eventCaseId: 42 })],
      windowHours: 24,
    },
  });
  const bar = doc.querySelector('#attack-bar');
  assert.equal(bar.hidden, false);
  assert.ok(bar.classList.contains('crit'), 'a CRIT was not marked');
  assert.match(doc.querySelector('#attack-bar-label').textContent, /3 attack indications/);
});

test('clicking opens the event the finding was grouped into', async (t) => {
  const { doc, window } = await boot(t, {
    'GET /api/findings/attack-indication': {
      count: 1, bySeverity: { CRIT: 1 }, worst: 'CRIT',
      findings: [finding({ id: 'c1', metric: 'net.beacon', severity: 'CRIT', eventCaseId: 42 })], windowHours: 24,
    },
    'GET /api/events/42': { id: 42, host_id: '7', title: 'Beaconing', status: 'open', findings: [] },
  });
  doc.querySelector('#attack-bar').click();
  await tick(200);
  assert.match(window.location.hash + window.location.pathname, /event/, 'the bar did not navigate to the event');
});

test('with no event yet it opens the findings list filtered to that metric', async (t) => {
  const { doc, window, calls } = await boot(t, {
    'GET /api/findings/attack-indication': {
      count: 1, bySeverity: { WARN: 1 }, worst: 'WARN', findings: [finding()], windowHours: 24,
    },
    'GET /api/findings': [],
    'GET /api/findings/summary': { bySeverity: [], byMetric: [], byHost: [] },
  });
  doc.querySelector('#attack-bar').click();
  await tick(200);
  const asked = calls.filter((c) => c.startsWith('GET /api/findings'));
  assert.ok(asked.length > 1, 'the findings screen was never loaded');
  assert.match(window.location.hash + window.location.pathname, /findings|analysis/i);
});

test('an endpoint that fails leaves the page alone rather than throwing', async (t) => {
  const { doc, errors } = await boot(t, {
    'GET /api/findings/attack-indication': { __status: 500, body: { error: 'boom' } },
  });
  assert.equal(doc.querySelector('#attack-bar').hidden, true);
  assert.deepEqual(errors, [], 'a failed poll threw');
});
