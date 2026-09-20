'use strict';

// public/views/investigate.js — Investigate on the UI contract
// (docs/ui-contract.md).
//
// The page was three loose labels, a grey status sentence that served as both
// validation and error reporting, and a history that stacked full result cards
// one after another. It is a FormPage now: a FormSection, one primary action, a
// result Panel, and a history DataTable whose rows open the Drawer. These tests
// hold what had to survive: the same POST body, the same classification, and a
// validation problem that lands on the field it is about.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const AGENTS = [
  { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' },
  { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02' },
];
const LOCATIONS = [{ id: 1, name: 'Oslo' }, { id: 2, name: 'Copenhagen' }];
const RESULT = {
  classification: 'UPSTREAM',
  confidence: 0.82,
  explanation: 'Loss starts at the first public hop and every internal probe is clean.',
  createdAt: '2026-09-12T14:02:00.000Z',
  locationRef: { type: 'agent', value: '7' },
  window: { to: '2026-09-12T14:02:00.000Z' },
  suspectedSegment: { from: '10.0.0.1', to: '81.19.2.1' },
  evidence: [
    { ref: 'probe.loss', observed: 12.4, baseline: 0.2, deviation: 6.1, ts: '2026-09-12T14:00:00.000Z' },
    { ref: 'probe.rtt', observed: 141, baseline: 22, deviation: 4.4, ts: '2026-09-12T14:00:00.000Z' },
  ],
  workaroundHints: ['Fail the site over to the secondary uplink'],
};
const HISTORY = [
  RESULT,
  Object.assign({}, RESULT, {
    classification: 'LOCAL', confidence: 0.4, createdAt: '2026-09-11T09:00:00.000Z',
    locationRef: { type: 'site', value: '2' }, explanation: 'One switch port is discarding.',
  }),
];

function boot({ t, routes = {}, url = 'http://server.test/investigate', role = 'operator' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u), body: opts.body });
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
const settle = () => new Promise((r) => setTimeout(r, 160));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': AGENTS,
  'GET /locations': LOCATIONS,
  'GET /api/investigation': HISTORY,
  'POST /api/investigation/run': RESULT,
}, over);

const fields = (doc) => [...doc.querySelectorAll('#view .form-sec .f')];
const runBtn = (doc) => [...doc.querySelectorAll('#view .form-actions-ui .btn')].find((b) => /Investigate/i.test(b.textContent));
const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];

test('Investigate is a FormPage: PageHeader, FormSection, one primary, a history table', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .inv-form').length, 0, 'the old form survived');
  assert.equal(doc.querySelectorAll('#view .inv-form-row').length, 0, 'the old form row survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old section head survived');
  // The title is the page's own name; "Troubleshooting" is a different screen.
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace('?', '').trim(), 'Investigate');
  assert.equal(fields(doc).length, 3);
  assert.equal(doc.querySelectorAll('#view .form-actions-ui .btn-primary').length, 1);
  assert.equal(rows(doc).length, 2, 'the history is not a DataTable');
});

test('the target control follows the target type', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  // Agent: a list of the agents.
  let value = doc.querySelector('#inv-value');
  assert.equal(value.tagName, 'SELECT');
  assert.ok([...value.options].some((o) => /oslo-edge-01/.test(o.textContent)));

  const type = doc.querySelector('#inv-type');
  type.value = 'site';
  type.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  value = doc.querySelector('#inv-value');
  assert.equal(value.tagName, 'SELECT');
  assert.ok([...value.options].some((o) => /Copenhagen/.test(o.textContent)));

  // Subnet: free text, because the server cannot list the options. The form is
  // rebuilt on each type change, so the control has to be looked up again.
  const type2 = doc.querySelector('#inv-type');
  type2.value = 'subnet';
  type2.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  value = doc.querySelector('#inv-value');
  assert.equal(value.tagName, 'INPUT');
  assert.match(value.getAttribute('placeholder'), /10\.0\.1\.0\/24/);
});

test('running with no target is a field error, and never reaches the server', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  runBtn(doc).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const err = doc.querySelector('#view .form-sec .field-error');
  assert.ok(err, 'no error on the field');
  assert.match(err.textContent, /target/i);
  assert.equal(log.filter((x) => x.key === 'POST /api/investigation/run').length, 0, 'an empty run was sent');
  // And it clears as soon as the field is filled.
  const value = doc.querySelector('#inv-value');
  value.value = '7';
  value.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(doc.querySelectorAll('#view .form-sec .field-error').length, 0, 'the error outlived the fix');
});

test('a run posts the same body and shows the verdict', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const value = doc.querySelector('#inv-value');
  value.value = '7';
  value.dispatchEvent(new window.Event('change', { bubbles: true }));
  runBtn(doc).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const post = log.find((x) => x.key === 'POST /api/investigation/run');
  assert.ok(post, 'nothing was posted');
  const body = typeof post.body === 'string' ? JSON.parse(post.body) : post.body;
  assert.deepEqual(body, { locationRef: { type: 'agent', value: '7' }, windowMinutes: 30 });
  const result = [...doc.querySelectorAll('#view .panel-ui')].find((p) => /Result/.test(p.textContent));
  assert.ok(result, 'no result panel');
  assert.match(result.textContent, /UPSTREAM/);
  assert.match(result.textContent, /first public hop/);
});

test('a failed run is an ErrorState that names the call', async (t) => {
  const { doc, window, errors } = boot({ t, routes: SESSION({ 'POST /api/investigation/run': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  const value = doc.querySelector('#inv-value');
  value.value = '7';
  value.dispatchEvent(new window.Event('change', { bubbles: true }));
  runBtn(doc).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /POST \/api\/investigation\/run/);
  assert.ok(runBtn(doc) && !runBtn(doc).disabled, 'the button stayed disabled after a failure');
});

test('the history names the target and opens the run in the Drawer', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const cells = rows(doc).map((r) => r.children[1].textContent.trim());
  // An agent id and a site id both resolve to the name they stand for.
  assert.deepEqual(cells, ['oslo-edge-01', 'Copenhagen']);
  assert.match(rows(doc)[0].children[2].textContent, /Upstream/i);

  rows(doc)[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const d = doc.querySelector('.ui-drawer');
  assert.ok(d, 'no Drawer');
  assert.match(d.textContent, /first public hop/);
  assert.match(d.textContent, /probe\.loss/, 'the evidence did not come with it');
});

test('a 404 history is an EmptyState, not a broken page', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/investigation': { status: 404, body: { error: 'Not Found' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .state'), 'no state for a missing history');
  assert.ok(runBtn(doc), 'the form went down with the history');
});

test('an empty history reads as "nothing yet", not as a failure', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/investigation': [] }) });
  await settle();
  assert.match(doc.querySelector('#view .state').textContent, /Nothing investigated yet/i);
  assert.equal(doc.querySelectorAll('#view .state.is-error').length, 0);
});
