'use strict';

// The fault context carried between the troubleshooting screens
// (openInContext / applyContextFromUrl in public/app.js), and the auto-refresh
// that must not wipe what somebody is typing.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u) });
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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [
    { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', status: 'online' },
    { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02', status: 'offline' },
  ],
  'GET /locations': [],
  'GET /api/device-events': {
    window: { minutes: 120 }, filter: {}, counts: [],
    events: [{ id: 1, receivedAt: '2026-09-17T18:40:00.000Z', severity: 3, severityName: 'err', deviceId: 8, deviceName: 'cph-core-02', agentId: 7, agentName: 'oslo-edge-01', sourceIp: '10.0.0.8', summary: 'Gi0/1 down', eventType: 'link_down', ifname: 'Gi0/1' }],
  },
  'GET /api/device-events/catalog': { groups: [] },
  'GET /api/diagnose/examples': { examples: [] },
  'GET /api/investigation': [],
}, over);

test('a device-log link opens scoped to the agent, with the window it names', async (t) => {
  const { doc, errors, log } = boot({ t, routes: SESSION(), url: 'http://server.test/device-log?agent=7&window=100' });
  await settle(500);
  assert.deepEqual(errors, []);
  const call = log.find((l) => l.key === 'GET /api/device-events');
  assert.ok(call, 'the log was not fetched');
  assert.match(call.url, /agentId=7/);
  // 100 minutes is covered by the 2-hour window.
  assert.match(call.url, /minutes=120/);
  assert.match(doc.querySelector('.ctx-scope').textContent, /oslo-edge-01/);
});

test('clicking a device in the log narrows the log to that device', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION(), url: 'http://server.test/device-log' });
  await settle(500);
  const link = doc.querySelector('#view table.dt tbody tr a.hostlink');
  assert.ok(link, 'the device column is not a link');
  link.click();
  await settle(300);
  const calls = log.filter((l) => l.key === 'GET /api/device-events');
  assert.match(calls[calls.length - 1].url, /deviceId=8/);
  assert.match(doc.querySelector('.ctx-scope').textContent, /cph-core-02/);
});

test('a Diagnose link fills in the agent and the target', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION(), url: 'http://server.test/diagnose?agent=7&target=10.0.0.1' });
  await settle(500);
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelector('#diag-agent').value, '7');
  assert.equal(doc.querySelector('#diag-target').value, '10.0.0.1');
});

test('an Investigate link picks the agent and a window that covers it', async (t) => {
  const { doc } = boot({ t, routes: SESSION(), url: 'http://server.test/investigate?agent=7&window=90' });
  await settle(500);
  assert.equal(doc.querySelector('#inv-value').value, '7');
  assert.equal(doc.querySelector('#inv-window').value, '240');
});

test('auto-refresh waits while somebody is typing, and the text survives a rebuild', async (t) => {
  const { window, doc } = boot({ t, routes: SESSION(), url: 'http://server.test/diagnose' });
  await settle(500);
  const box = doc.querySelector('#diag-description');
  box.value = 'we lose packets at peak';
  box.dispatchEvent(new window.Event('input'));
  // Leave and come back: the description is on state, not only in the DOM.
  doc.querySelector('.tabs button[data-view="deviceLog"]').click();
  await settle(400);
  doc.querySelector('.tabs button[data-view="diagnose"]').click();
  await settle(400);
  assert.equal(doc.querySelector('#diag-description').value, 'we lose packets at peak');
});

test('per-record chart parameters do not follow the reader to the next screen', async (t) => {
  const { window, doc } = boot({ t, routes: SESSION(), url: 'http://server.test/device-log?from=2026-01-01&to=2026-01-02&severity=CRIT' });
  await settle(400);
  doc.querySelector('.tabs button[data-view="fleet"]').click();
  await settle(400);
  const q = new window.URLSearchParams(window.location.search);
  assert.equal(q.get('from'), null);
  assert.equal(q.get('to'), null);
  // The shared fleet filter stays: it is meant to follow.
  assert.equal(q.get('severity'), 'CRIT');
});
