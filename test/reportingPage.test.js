'use strict';

// public/views/reporting.js — Reporting's page shell on the UI contract
// (docs/ui-contract.md).
//
// A SHELL migration: the five section bodies (the findings report, NIS2, the
// report generator, the schedules and the audit trail) stay in public/app.js. What is tested here is
// the page they sit on — the PageHeader that used to be a heading with the tab
// strip wedged into it, the strip as the shared component under it, the section
// in the URL, and the two states that used to be the same grey `.empty` box.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/reporting', role = 'admin' } = {}) {
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
    // `hang` is a request that never answers — the only honest way to look at
    // a loading state, and it leaves no timer to fire after the test is over.
    if (hit && hit.hang) await new Promise(() => {});
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.print = () => {};
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

const DASH = {
  readinessScore: 42,
  totals: { risks: 2, controls: 3, events: 1 },
  openCriticalRisks: 1,
  openHighMediumFindings: 2,
  eventsLast30Days: 1,
  controlsWithoutEvidence: 0,
  categories: [
    { category: 'Governance', score: 50, status: 'partial', controlCount: 2 },
    { category: 'Risk Management', score: 80, status: 'good', controlCount: 1 },
  ],
  topActions: [],
};

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/nis2/dashboard': DASH,
  // Reporting now OPENS on the findings report, so its reads belong in every
  // session: a section that 404s draws an ErrorState, which would hide the
  // thing each of these tests is actually looking at.
  'GET /api/findings/summary': { total: 0, bySeverity: [], byMetric: [], byHost: [] },
  'GET /api/findings/trend': { bucket: 'day', points: [], filters: {} },
  'GET /agents': [],
  'GET /api/nis2/custom-reports/sources': { sources: [] },
  'GET /api/report-schedules': [],
  'GET /locations': [],
  'GET /api/audit': { entries: [], total: 0 },
  'GET /api/audit/actions': { actions: [] },
}, over);

// The NIS2 body draws a second strip of its own (Dashboard / Risks / …), so the
// shell's is named: aria-label is what tells the two tablists apart for a
// screen reader, and it does the same job here.
const strip = (doc) => doc.querySelector('#view [role="tablist"][aria-label="Reporting"]');
const tabs = (doc) => [...(strip(doc) ? strip(doc).querySelectorAll('.subtab') : [])];
const active = (doc) => (tabs(doc).find((b) => b.getAttribute('aria-selected') === 'true') || {}).dataset;

test('Reporting sits on a PageHeader, not a heading with the tabs inside it', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  const h1 = doc.querySelector('#view .page-head h1');
  assert.ok(h1, 'no PageHeader');
  assert.match(h1.textContent, /Reporting/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  // The old markup put the strip inside .section-head, next to the <h2>.
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the heading block survived');
  assert.equal(doc.querySelectorAll('#view .page-head [role="tablist"]').length, 0,
    'the tab strip is still inside the heading');
});

test('the sections are the shared tab strip, under the header', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const bar = strip(doc);
  assert.ok(bar, 'no tab strip under the header');
  assert.ok(bar.classList.contains('subtabs'), 'the strip is not the shared component');
  // Under the header, not inside it.
  const head = doc.querySelector('#view .page-head');
  assert.ok(head.compareDocumentPosition(bar) & 4, 'the strip does not follow the header');
  assert.ok(!head.contains(bar), 'the strip is inside the header');
  // Findings leads: it is the only section that answers something on a fresh
  // install, where NIS2 and the generator both need to be set up first.
  // `sla` (Availability & outages) follows it: the two reports the schedules
  // send, run on demand — they had seven endpoints and no screen.
  assert.deepEqual(tabs(doc).map((b) => b.dataset.tab), ['findings', 'sla', 'nis2', 'generator', 'schedules', 'audit']);
  assert.equal(active(doc).tab, 'findings');
  // One stop in the tab order; the arrows move within.
  assert.equal(tabs(doc).filter((b) => b.tabIndex === 0).length, 1);
});

test('audit is admin-only and a viewer is not offered it', async (t) => {
  const { doc } = boot({ t, role: 'viewer', routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }) });
  await settle();
  assert.deepEqual(tabs(doc).map((b) => b.dataset.tab), ['findings', 'sla', 'nis2', 'generator', 'schedules']);
});

test('a viewer deep-linking to /reporting/audit lands on a section they can read', async (t) => {
  const { doc, window } = boot({
    t, role: 'viewer', url: 'http://server.test/reporting/audit',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(active(doc).tab, 'findings', 'a section the reader cannot reach was drawn empty');
  // And the address follows, so a reload does not try it again.
  assert.equal(window.location.pathname, '/reporting/findings', 'the address still names a section they cannot open');
});

test('picking a section switches the body and puts the section in the URL', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const schedules = tabs(doc).find((b) => b.dataset.tab === 'schedules');
  schedules.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'GET /api/report-schedules'), 'the schedules section did not load');
  assert.equal(window.location.pathname, '/reporting/schedules');
  assert.ok(doc.querySelector('#view .rs'), 'the schedules body is not there');
});

test('a deep link opens on that section', async (t) => {
  const { doc, log } = boot({ t, url: 'http://server.test/reporting/generator', routes: SESSION() });
  await settle();
  assert.equal(active(doc).tab, 'generator');
  assert.ok(log.some((x) => x.key === 'GET /api/nis2/custom-reports/sources'));
  assert.ok(doc.querySelector('#view .rg'), 'the generator body is not there');
});

test('a 500 in a section is an ErrorState with a Retry — the shell survives', async (t) => {
  const { doc, errors, window, log } = boot({
    t, url: 'http://server.test/reporting/generator',
    routes: SESSION({ 'GET /api/nis2/custom-reports/sources': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the PageHeader went down with the body');
  assert.ok(strip(doc), 'the tab strip went down with the body');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed section is not an ErrorState');
  assert.match(err.textContent, /boom/, 'the ErrorState does not say what went wrong');
  assert.equal(doc.querySelectorAll('#view .empty.error').length, 0, 'the old grey error box is still drawn');

  const before = log.filter((x) => x.key === 'GET /api/nis2/custom-reports/sources').length;
  const retry = [...err.querySelectorAll('button')].find((b) => /retry|prøv/i.test(b.textContent));
  assert.ok(retry, 'no Retry on the ErrorState');
  retry.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/nis2/custom-reports/sources').length > before, 'Retry did not retry');
});

test('a 404 from a section body is reported, not left as a blank panel', async (t) => {
  const { doc, errors } = boot({
    t, url: 'http://server.test/reporting/schedules',
    routes: SESSION({ 'GET /api/report-schedules': undefined }),
  });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 section left the page silent');
  assert.match(err.textContent, /Not Found|404/i);
});

test('an unknown path under /reporting is a 404 view, not Reporting', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/reporting/nope', routes: SESSION() });
  await settle();
  assert.equal(doc.querySelectorAll('#view .page-head h1').length <= 1, true);
  assert.match(doc.querySelector('#view').textContent, /not found|findes ikke/i);
});

test('the wait is a skeleton, not the same grey box as the error', async (t) => {
  // "Loading…" and the failure used to be the same `.empty` div, so the reader
  // could not tell "wait" from "it broke" without reading the sentence.
  const { doc } = boot({
    t, url: 'http://server.test/reporting/schedules',
    routes: SESSION({ 'GET /api/report-schedules': { hang: true } }),
  });
  await settle();
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page did not draw while the section loaded');
  assert.ok(doc.querySelector('#view .skel-rows'), 'the wait is not a skeleton');
  assert.equal(doc.querySelectorAll('#view .state.is-error').length, 0, 'a section still loading reads as failed');
  assert.equal(doc.querySelectorAll('#view .empty').length, 0, 'the old "Loading…" box is still drawn');
});
