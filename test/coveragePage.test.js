'use strict';

// public/views/coverage.js — Coverage gaps on the UI contract
// (docs/ui-contract.md).
//
// The behaviour that must survive: gaps are grouped per kind with their
// evidence and next step in the reader's language, a scope card narrows the
// list, "Fix this" goes where the server said, and — the point of the screen —
// an empty list is never an unqualified all-clear: the checks it rests on are
// always listed, and a check that could not run says so.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CHECKS = [
  { key: 'siteAgents', status: 'ok', kinds: ['siteNoAgent'], missing: [], capped: [] },
  { key: 'agentHealth', status: 'ok', kinds: ['agentOffline'], missing: [], capped: [] },
  { key: 'subnets', status: 'skipped', kinds: ['subnetUncovered'], missing: ['arpSubnets'], capped: [] },
];
const REPORT = {
  generatedAt: '2026-09-23T12:00:00.000Z',
  summary: { total: 3, warn: 2, info: 1, byScope: { site: 1, agent: 1, device: 1, subnet: 0 }, byKind: { siteNoAgent: 1, agentOffline: 1, deviceNoLldp: 1 } },
  gaps: [
    { kind: 'siteNoAgent', severity: 'warn', scope: 'site', subject: { id: 2, label: 'Branch' }, evidence: { snmpDevices: 0 }, suggestion: 'enrollAgent', link: { view: 'enrollment' } },
    { kind: 'agentOffline', severity: 'warn', scope: 'agent', subject: { id: 7, label: 'hq-1' }, evidence: { status: 'offline', lastSeen: null, site: 'HQ' }, suggestion: 'checkAgent', link: { view: 'agent', id: 7 } },
    { kind: 'deviceNoLldp', severity: 'info', scope: 'device', subject: { id: 5, label: 'core-sw' }, evidence: { host: '10.0.0.2', inCollect: false, unsupported: false }, suggestion: 'enableCollect', link: { view: 'snmpDevice', id: 5 } },
  ],
  truncated: {},
  limit: 50,
  checks: CHECKS,
  windows: { flowHours: 24, staleReportMinutes: 30 },
};
const EMPTY = { ...REPORT, summary: { total: 0, warn: 0, info: 0, byScope: { site: 0, agent: 0, device: 0, subnet: 0 }, byKind: {} }, gaps: [] };

function boot({ t, routes = {}, url = 'http://server.test/coverage', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push(`${(opts.method || 'GET').toUpperCase()} ${p}`);
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
const settle = () => new Promise((r) => setTimeout(r, 250));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/coverage': REPORT,
}, over);

const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];
const panelBy = (doc, re) => panels(doc).find((p) => re.test((p.querySelector('h2') || {}).textContent || ''));

test('Coverage gaps is a contract page: header with help, a stat strip, one panel per kind, and the checks', async (t) => {
  const { doc, errors, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(log.includes('GET /api/coverage'));
  const view = doc.querySelector('#view');
  assert.equal(view.querySelector('h1').textContent.replace('?', '').trim(), 'Coverage gaps');
  assert.ok(view.querySelector('.page-head .help-btn'), 'help lives in the (?) popover');
  assert.ok(view.querySelector('.statstrip'));
  assert.ok(panelBy(doc, /^Sites with no agent/));
  assert.ok(panelBy(doc, /^Agents offline/));
  assert.ok(panelBy(doc, /^Switches without LLDP/));
  const checks = panelBy(doc, /^What was checked/);
  assert.ok(checks, 'the checks are always listed');
  assert.match(checks.textContent, /Not checked/);
  assert.match(checks.textContent, /Could not read: ARP tables/);
  // Evidence and the next step, in words rather than keys.
  const site = panelBy(doc, /^Sites with no agent/);
  assert.match(site.textContent, /No agent is placed at this site\. Switches polled here: 0\./);
  assert.match(site.textContent, /Enrol an agent at this site/);
  assert.doesNotMatch(view.textContent, /coverage\.(ev|suggest|kind)\./, 'no raw catalogue key reaches the screen');
  // One check was skipped: said above the list, not only in the table.
  assert.match(view.querySelector('.inline-note').textContent, /1 check\(s\) could not run/);
});

test('a scope card narrows the list, and clicking it again shows everything', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const card = [...doc.querySelectorAll('#view .stat-card')].find((c) => /Agents/.test(c.textContent));
  card.click();
  assert.equal(panelBy(doc, /^Sites with no agent/), undefined);
  assert.ok(panelBy(doc, /^Agents offline/));
  const again = [...doc.querySelectorAll('#view .stat-card')].find((c) => /Agents/.test(c.textContent));
  assert.equal(again.getAttribute('aria-pressed'), 'true');
  again.click();
  assert.ok(panelBy(doc, /^Sites with no agent/));
});

test('"Fix this" goes where the server said', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /agents/7': { id: 7, hostname: 'hq-1', status: 'offline' } }) });
  await settle();
  const row = panelBy(doc, /^Agents offline/).querySelector('tbody tr');
  const fix = [...row.querySelectorAll('button')].find((b) => /Fix this/.test(b.textContent));
  assert.ok(fix);
  fix.click();
  await settle();
  assert.match(doc.defaultView.location.pathname, /^\/agents\/7$/);
});

test('an empty list is qualified by the checks it rests on — never an unqualified all-clear', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/coverage': EMPTY }) });
  await settle();
  const view = doc.querySelector('#view');
  assert.match(view.textContent, /No coverage gaps found/);
  assert.match(view.textContent, /Based on the 2 of 3 checks that could run/);
  assert.ok(panelBy(doc, /^What was checked/));
});

test('a failed load is an ErrorState that names the call and retries', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/coverage': { status: 500, body: { error: 'Internal Server Error' } } }) });
  await settle();
  const state = doc.querySelector('#view .state.is-error');
  assert.ok(state);
  assert.match(state.textContent, /GET \/api\/coverage/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /retry/i.test(b.textContent)));
});

test('the nav entry is admin-only, and so is the address', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const btn = doc.querySelector('.tabs button[data-view="coverage"]');
  assert.equal(btn.dataset.minRole, 'admin');
  const routes = require('../public/routes.js');
  assert.equal(routes.pathFor('coverage'), '/coverage');
  assert.equal(routes.match('/coverage').view, 'coverage');
});
