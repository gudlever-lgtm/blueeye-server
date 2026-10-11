'use strict';

// public/views/systemHealth.js — the screen about the monitoring system.
//
// What must hold: UNKNOWN is never drawn as good news. That is the whole
// screen. A page that shows eight green and leaves three unread signals out,
// or paints them the same colour as the healthy ones, says "all well" about a
// system it can only partly see.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const SELF = (over = {}) => Object.assign({
  checkedAt: '2026-10-11T09:00:00.000Z',
  state: 'unknown',
  counts: { ok: 2, failing: 0, unknown: 1 },
  signals: [
    { id: 'database', state: 'ok', reason: 'reachable', detail: 'The database answered.' },
    { id: 'agents', state: 'ok', reason: 'all_reporting', detail: 'All 4 agents are reporting.' },
    { id: 'storage', state: 'unknown', reason: 'unreadable', detail: 'The disk usage could not be read.' },
  ],
}, over);

function boot({ t, routes = {}, url = 'http://server.test/system-health', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push(key);
    const hit = routes[key];
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
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /system/self': SELF(),
}, over);

// The table carries no id per row, so a row is found by the signal's own label
// — which is what a reader looks for too.
const rowFor = (doc, label) => [...doc.querySelectorAll('#view table.dt tbody tr')]
  .find((tr) => new RegExp(label).test(tr.textContent)) || null;

test('/system-health opens the screen and lists every signal', async (t) => {
  const { doc, errors, log, window } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(window.location.pathname, '/system-health');
  assert.ok(log.includes('GET /system/self'), 'the screen did not read its own endpoint');

  const view = doc.querySelector('#view');
  assert.equal(view.querySelector('h1').textContent.replace('?', '').trim(), 'System health');
  const rows = [...view.querySelectorAll('table.dt tbody tr')];
  assert.equal(rows.length, 3);
  assert.match(view.textContent, /The disk usage could not be read/);
  assert.doesNotMatch(view.textContent, /self\.(sig|state|count|col|verdict)\./, 'a raw catalogue key reached the screen');
});

test('an unread signal is not green, and the verdict says what that means', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const view = doc.querySelector('#view');

  // The row itself.
  const badges = [...view.querySelectorAll('table.dt tbody tr .badge-ui')].map((b) => ({ text: b.textContent, cls: b.className }));
  const unknown = badges.find((b) => /UNKNOWN/.test(b.text));
  assert.ok(unknown, badges.map((b) => b.text).join(', '));
  assert.doesNotMatch(unknown.cls, /\bok\b/, 'an unread signal was painted as healthy');

  // The count card: never toned as good news, whatever the number.
  const cards = [...view.querySelectorAll('.stat-card')];
  const blind = cards.find((c) => /Could not read/.test(c.textContent));
  assert.ok(blind);
  assert.doesNotMatch(blind.className, /\bok\b/);

  // And the sentence at the top refuses to call it healthy.
  const note = view.querySelector('.inline-note');
  assert.ok(note);
  assert.match(note.textContent, /not the same as being healthy/);
});

test('all-OK says so plainly, and only then', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /system/self': SELF({
        state: 'ok',
        counts: { ok: 3, failing: 0, unknown: 0 },
        signals: SELF().signals.map((s) => ({ ...s, state: 'ok', detail: 'fine' })),
      }),
    }),
  });
  await settle();
  const note = doc.querySelector('#view .inline-note');
  assert.match(note.textContent, /every one of them is fine/);
});

test('a failure points at the rows that were measured and came back bad', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /system/self': SELF({
        state: 'failing',
        counts: { ok: 1, failing: 1, unknown: 1 },
        signals: [
          { id: 'database', state: 'ok', detail: 'The database answered.' },
          { id: 'signing', state: 'failing', detail: 'The command key cannot be decrypted.' },
          { id: 'telemetry', state: 'unknown', detail: 'Not switched on here.' },
        ],
      }),
    }),
  });
  await settle();
  const view = doc.querySelector('#view');
  assert.match(view.querySelector('.inline-note').textContent, /start there/i);
  const signing = rowFor(doc, 'Signing keys');
  assert.ok(signing);
  assert.match(signing.textContent, /FAILING/);
  assert.match(signing.textContent, /command key cannot be decrypted/);
});

test('the endpoint failing takes the screen down honestly, with a retry', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /system/self': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a health screen that cannot read itself must say so');
  assert.match(err.querySelector('code').textContent, /GET \/system\/self/);
  assert.ok([...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
});

test('the rail marks it, and it is reachable by a viewer', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), role: 'viewer' });
  await settle();
  const marked = doc.querySelector('.tabs button.active');
  assert.ok(marked);
  assert.equal(marked.dataset.view, 'systemHealth');
  // "Can the monitoring system see anything" is the first thing anybody
  // reading a number on another screen needs, so it is not admin-only.
  assert.ok(!marked.classList.contains('role-hidden'));
  assert.match(doc.querySelector('#crumb').textContent, /Administration.*System health/);
});
