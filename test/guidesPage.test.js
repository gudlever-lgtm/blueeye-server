'use strict';

// public/views/guides.js — the Guides page shell on the UI contract
// (docs/ui-contract.md).
//
// A SHELL migration: the five walkthroughs stay in public/guides.js, which
// ships standalone. What is tested here is the page they sit on — the hero
// banner that is gone, the PageHeader that replaced three stacked lead lines,
// the state advisory, and the Back/Next row as contract buttons.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/guides/monitoring', role = 'operator' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 250));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [{ id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', status: 'online', location_id: 1 }],
  'GET /locations': [{ id: 1, name: 'Oslo', latitude: 59.9, longitude: 10.7 }],
}, over);

const foot = (doc) => doc.querySelector('#view .ui-page .form-actions-ui');
const btnText = (doc, re) => [...doc.querySelectorAll('#view .ui-page .form-actions-ui button')]
  .find((b) => re.test(b.textContent));

test('Guides is on the contract and the hero banner is gone', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  const h1 = doc.querySelector('#view .page-head h1');
  assert.ok(h1, 'no PageHeader');
  assert.match(h1.textContent, /Monitoring/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  // The banner explained what a guide is, above a lead that said it again.
  assert.equal(doc.querySelectorAll('#view .hero').length, 0, 'the info banner survived');
  assert.equal(doc.querySelectorAll('#view .guide-head').length, 0, 'the module still draws its own heading');
  // One lead, not three stacked lines — the footer already gives the count.
  assert.equal(doc.querySelectorAll('#view .page-head p').length, 1);
  assert.equal(doc.querySelectorAll('#view .guide-sub-count').length, 0);
});

test('the stepper and the step body are still the module\'s', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(doc.querySelector('#view .guide-layout'), 'the guide body is gone');
  assert.equal(doc.querySelectorAll('#view .guide-stepper-btn').length, 7);
  assert.match(doc.querySelector('#view .guide-step-title').textContent, /What this group answers/);
});

test('Back and Next are contract buttons, and Back is dead on the first step', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(foot(doc), 'no footer row');
  assert.equal(doc.querySelectorAll('#view .guide-foot').length, 0, 'the module still draws its own footer');
  const back = btnText(doc, /Back/);
  const next = btnText(doc, /Next/);
  assert.ok(back.classList.contains('btn') && back.classList.contains('btn-secondary'), 'Back is not a contract button');
  assert.ok(next.classList.contains('btn') && next.classList.contains('btn-primary'), 'Next is not a contract button');
  assert.ok(back.disabled, 'Back on step 1 goes nowhere and is offered anyway');
  assert.match(foot(doc).textContent, /Step 1 of 7/);
});

test('Next moves the step, the body and the footer together', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  btnText(doc, /Next/).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(doc.querySelector('#view .guide-step-title').textContent, /Changes/);
  assert.match(foot(doc).textContent, /Step 2 of 7/);
  assert.equal(btnText(doc, /Back/).disabled, false, 'Back is still dead on step 2');
  const on = doc.querySelector('#view .guide-stepper-btn.active');
  assert.match(on.textContent, /Changes/);
});

test('the last step offers Restart instead of a Next that goes nowhere', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const last = [...doc.querySelectorAll('#view .guide-stepper-btn')].pop();
  last.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(foot(doc).textContent, /Step 7 of 7/);
  assert.equal(btnText(doc, /Next/), undefined, 'the last step still offers Next');
  assert.ok(btnText(doc, /Start over|Start forfra/), 'the last step offers no way back to the top');
});

test('a 500 on the live state is an inline note, and the guide is still readable', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /agents': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  assert.deepEqual(errors, []);
  const note = doc.querySelector('#view .inline-note');
  assert.ok(note, 'a failed state read said nothing');
  assert.match(note.textContent, /boom/);
  assert.equal(doc.querySelectorAll('#view .guide-stale').length, 0, 'the callout in the document flow survived');
  // The guidance does not depend on the live state, so it is all still there.
  assert.equal(doc.querySelectorAll('#view .guide-stepper-btn').length, 7);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the state read');
});

test('a 404 on the live state costs the status lines, never the page', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /locations': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .inline-note'), 'a 404 state read said nothing');
  assert.ok(doc.querySelector('#view .guide-layout'), 'the guide went down with one endpoint');
});

test('each nav entry is its own guide, and the address names it', async (t) => {
  const { doc, window } = boot({ t, url: 'http://server.test/guides/diagnostics', routes: SESSION() });
  await settle();
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Diagnostics/);
  assert.equal(window.location.pathname, '/guides/diagnostics');
});

test('an unknown guide path is a 404 view in the same shell', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/guides/nope', routes: SESSION() });
  await settle();
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  assert.match(doc.querySelector('#view').textContent, /not found|findes ikke/i);
});

test('the standalone module still owns its own shell without the flag', async (t) => {
  // guides.js ships on its own, so `embedded` has to be opt-in.
  const src = fs.readFileSync(path.join(PUBLIC, 'guides.js'), 'utf8');
  assert.match(src, /var embedded = ctx\.mode === 'embedded';/);
  assert.match(src, /function footer\(\)/, 'the standalone footer was removed');
  assert.match(src, /class: 'guide-head'/, 'the standalone heading was removed');
  void t;
});
