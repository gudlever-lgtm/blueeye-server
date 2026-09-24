'use strict';

// Reporting → Availability & outages (public/slaReports.js), booted inside the
// real dashboard.
//
// The behaviour that must survive: the two probe reports run for a period and
// render their rows; CSV and Print ask for the SAME query the screen ran; an
// outage row offers the NIS2 draft (GET /api/reports/nis2-draft/:id) and an
// investigation (POST /api/investigation/from-event) to operators, and a
// viewer gets the report without those; the schedules panel links here.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/reporting/sla', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push({ key, url: String(u), body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes[key];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return {
      ok: status < 300, status, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body), blob: async () => new window.Blob(['x']),
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
  window.open = () => null;
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

const OUTAGE = {
  id: 41, locationId: 4, locationName: 'Aarhus', agentId: 7, agentName: 'fw-aar', metric: 'latency',
  severity: 'critical', startedAt: '2026-09-22T10:00:00.000Z', resolvedAt: null, durationSeconds: null,
  affectedTarget: '8.8.8.8', status: 'active',
};
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /locations': [{ id: 4, name: 'Aarhus' }],
  'GET /agents': [],
  'GET /api/report-schedules': [],
  'GET /api/reports/availability': { from: 'x', to: 'y', locationId: null, agents: [
    { locationId: 4, locationName: 'Aarhus', agentId: 7, agentName: 'fw-aar', total: 200, up: 198, down: 2, uptimePct: 99 },
  ] },
  'GET /api/reports/probe-outages': { from: 'x', to: 'y', severity: null, locationId: null, probeOutages: [OUTAGE] },
  'GET /api/reports/nis2-draft/41': { probeOutageId: 41, probeOutage: OUTAGE, draft: 'NIS2 INCIDENT NOTIFICATION — DRAFT\nIncident reference: #41' },
  'POST /api/investigation/from-event': { eventId: 41, investigation: {
    id: 'inv-1', classification: 'UPSTREAM', confidence: 0.8, explanation: 'Upstream path degraded', evidence: [],
    locationRef: { type: 'site', value: '4' }, window: { from: 'x', to: 'y' },
  } },
}, over);

const view = (doc) => doc.querySelector('#view');
const reportSelect = (doc) => doc.querySelector('#sla-report');

test('availability runs for the period and shows uptime per agent', async (t) => {
  const { doc, errors, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  const call = log.find((l) => l.key === 'GET /api/reports/availability');
  assert.ok(call, 'the report was run');
  assert.match(call.url, /from=\d{4}-\d\d-\d\dT00%3A00%3A00\.000Z/);
  assert.match(call.url, /to=\d{4}-\d\d-\d\dT23%3A59%3A59\.999Z/, '"to" is the end of the day picked');
  const row = view(doc).querySelector('table.dt tbody tr');
  assert.match(row.textContent, /Aarhus/);
  assert.match(row.textContent, /fw-aar/);
  assert.match(row.textContent, /99 %/);
});

test('CSV asks for the same query the screen ran', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION({ 'GET /api/reports/availability.csv': { body: 'a,b' } }) });
  await settle();
  const run = log.find((l) => l.key === 'GET /api/reports/availability');
  [...view(doc).querySelectorAll('button')].find((b) => b.textContent === 'CSV').click();
  await settle();
  const csv = log.find((l) => l.key === 'GET /api/reports/availability.csv');
  assert.ok(csv, 'the CSV export was requested');
  assert.equal(csv.url.split('?')[1], run.url.split('?')[1]);
});

test('probe outages: an operator can open the NIS2 draft and run an investigation', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  reportSelect(doc).value = 'probe_outages';
  reportSelect(doc).dispatchEvent(new window.Event('change'));
  await settle();
  const row = view(doc).querySelector('table.dt tbody tr');
  assert.match(row.textContent, /8\.8\.8\.8/);
  assert.match(row.textContent, /Critical/);
  assert.match(row.textContent, /Ongoing/);

  // Investigate — the row's primary action.
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Investigate').click();
  await settle();
  const post = log.find((l) => l.key === 'POST /api/investigation/from-event');
  assert.deepEqual(post.body, { eventId: 41 });
  assert.match(doc.querySelector('.ui-drawer').textContent, /Investigation · outage #41/);

  // NIS2 draft — behind the row menu.
  row.querySelector('button[aria-haspopup="menu"]').click();
  [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => b.textContent === 'NIS2 draft').click();
  await settle();
  assert.ok(log.some((l) => l.key === 'GET /api/reports/nis2-draft/41'));
  const drawer = doc.querySelector('.ui-drawer');
  assert.match(drawer.querySelector('pre').textContent, /Incident reference: #41/);
});

test('a viewer gets the report without the operator actions', async (t) => {
  const { doc, window } = boot({ t, role: 'viewer', routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }) });
  await settle();
  reportSelect(doc).value = 'probe_outages';
  reportSelect(doc).dispatchEvent(new window.Event('change'));
  await settle();
  const row = view(doc).querySelector('table.dt tbody tr');
  assert.ok(row);
  assert.equal([...row.querySelectorAll('button')].filter((b) => /Investigate/.test(b.textContent)).length, 0);
});

test('an empty outage list points at the thresholds; a failed run names the call', async (t) => {
  const empty = boot({ t, routes: SESSION({ 'GET /api/reports/availability': { status: 400, body: { error: 'Validation failed', details: { range: 'from must be before to' } } } }) });
  await settle();
  const state = view(empty.doc).querySelector('.state.is-error');
  assert.ok(state);
  assert.match(state.textContent, /from must be before to/);
  assert.match(state.textContent, /GET \/api\/reports\/availability/);

  const none = boot({ t, routes: SESSION({ 'GET /api/reports/probe-outages': { from: 'x', to: 'y', probeOutages: [] } }) });
  await settle();
  reportSelect(none.doc).value = 'probe_outages';
  reportSelect(none.doc).dispatchEvent(new none.window.Event('change'));
  await settle();
  assert.match(view(none.doc).textContent, /Settings → Outage thresholds/);
});

test('the scheduled-reports panel links to the on-demand reports', async (t) => {
  const { doc, window } = boot({ t, url: 'http://server.test/reporting/schedules', routes: SESSION() });
  await settle();
  const link = [...view(doc).querySelectorAll('button')].find((b) => /Availability & outages/.test(b.textContent) && b.classList.contains('linklike'));
  assert.ok(link, 'no link from Scheduled reports');
  link.click();
  await settle();
  assert.equal(window.location.pathname, '/reporting/sla');
});
