'use strict';

// A silent auto-refresh must not land in the middle of a WRITE.
//
// Resolving forty situations is one request that runs for seconds. The 5s
// auto-refresh fired straight through it, re-rendering the screen from
// half-applied rows — on screen it looked like the page reloading once per
// situation. A write in flight now holds the tick off.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CLUSTERS = [
  { id: 21, confidence: 'high', status: 'open', memberFindingIds: [1, 2], suspectedCommonCause: 'Uplink saturation', createdAt: '2026-09-12T13:40:00.000Z', detectedAt: '2026-09-12T14:02:00.000Z' },
];
const ROUTES = {
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/event-clusters': { clusters: CLUSTERS },
};

function boot(t) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'http://server.test/situations', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = (u, opts = {}) => {
    const key = `${(opts.method || 'GET').toUpperCase()} ${String(u).split('?')[0]}`;
    log.push(key);
    // The bulk resolve never settles: the write stays in flight for the test.
    if (key === 'POST /api/event-clusters/bulk-resolve') return new Promise(() => {});
    const body = ROUTES[key] === undefined ? { error: 'Not Found' } : ROUTES[key];
    const status = ROUTES[key] === undefined ? 404 : 200;
    return Promise.resolve({ ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  // Hold the auto-refresh tick instead of waiting 5 real seconds for it.
  const ticks = [];
  const realInterval = window.setInterval;
  window.setInterval = (fn, ms) => {
    if (ms === 5000) { ticks.push(fn); return 0; }
    return realInterval(fn, ms);
  };
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', 'operator');
  window.localStorage.setItem('blueeye.server.autoRefresh', '1');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, log, tick: () => ticks.forEach((fn) => fn()) };
}
const settle = () => new Promise((r) => setTimeout(r, 180));
const reads = (log) => log.filter((k) => k === 'GET /api/event-clusters').length;

test('the auto-refresh skips a tick while a write is in flight', async (t) => {
  const { doc, window, log, tick } = boot(t);
  await settle();
  assert.ok(doc.querySelector('#view table.dt'), 'the situations table never rendered');

  // Control: with nothing in flight, a tick re-reads the list.
  const before = reads(log);
  tick();
  await settle();
  assert.ok(reads(log) > before, 'the auto-refresh tick did not refresh at all');

  // Start the bulk resolve, which never answers.
  doc.querySelector('#view table.dt tbody input.dt-check').click();
  await settle();
  const note = doc.querySelector('#view .toolbar-ui input[type="text"]');
  note.value = 'cable replaced';
  doc.querySelectorAll('#view .btn-primary').forEach((b) => { if (/Resolve/.test(b.textContent)) b.click(); });
  await settle();
  assert.ok(log.includes('POST /api/event-clusters/bulk-resolve'), 'the bulk resolve never went out');

  const during = reads(log);
  // Nothing has focus in the view, so only the in-flight write can hold it off.
  window.document.activeElement.blur();
  tick();
  tick();
  await settle();
  assert.equal(reads(log), during, 'the screen re-rendered under the running bulk resolve');
});
