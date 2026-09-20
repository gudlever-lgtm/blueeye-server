'use strict';

// public/views/enrollment.js — Enrollment on the UI contract
// (docs/ui-contract.md).
//
// The migration this pins: the wizard as a FormSection with one primary, the
// missing signing key as a state that says who can fix it, status as a Badge on
// a tone rather than the raw server word, and Delete out of the row.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CODES = [
  { id: 12, status: 'active', max_uses: 5, uses_remaining: 3, agents: [{ id: 7, name: 'oslo-edge-01', online: true }], location_name: 'Oslo HQ', expires_at: '2026-09-18T09:00:00.000Z', created_at: '2026-09-17T09:00:00.000Z' },
  { id: 10, status: 'expired', max_uses: 1, uses_remaining: 1, agents: [], location_name: null, expires_at: '2026-09-16T10:00:00.000Z', created_at: '2026-09-16T09:00:00.000Z' },
];

function boot({ t, routes = {}, url = 'http://server.test/enrollment', role = 'admin' } = {}) {
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
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /locations': [{ id: 1, name: 'Oslo HQ' }],
  'GET /enroll/config': { serverUrl: 'https://b.example', certFingerprint: null, releasePublicKey: 'ed25519:AAAA' },
  'GET /enrollment-codes': CODES,
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];

test('Enrollment is a FormPage with the wizard as a FormSection', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Enrollment/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading block survived');

  const sec = doc.querySelector('#view .form-sec');
  assert.ok(sec, 'the wizard is not a FormSection');
  const labels = [...sec.querySelectorAll('.f > label')].map((l) => l.textContent);
  assert.deepEqual(labels, ['Platform', 'Number of machines', 'Lifetime (min)', 'Location']);
  assert.equal(doc.querySelectorAll('#view .enroll-form').length, 0, 'the loose label row survived');
  // One primary on the form, and one on the page.
  assert.equal(doc.querySelectorAll('#view .form-actions-ui .btn-primary').length, 1);
});

test('the location list comes from the server, with a no-location option first', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const sel = [...doc.querySelectorAll('#view .form-sec select')].pop();
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['(no location)', 'Oslo HQ']);
});

test('generating a code asks for the values the form holds', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION({ 'GET /api/enroll/command': { oneLiner: 'curl … | sh', manual: { downloadUrl: 'https://b.example/a', checksum: 'abc', command: './install.sh' } } }) });
  await settle();
  const sec = doc.querySelector('#view .form-sec');
  const [count, ttl] = [...sec.querySelectorAll('input[type=number]')];
  count.value = '3';
  ttl.value = '15';
  doc.querySelector('#view .form-actions-ui .btn-primary').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const call = log.find((x) => x.key === 'GET /api/enroll/command');
  assert.ok(call, 'the form asked for nothing');
  assert.match(call.url, /maxUses=3/);
  assert.match(call.url, /ttlMinutes=15/);
  assert.match(call.url, /platform=linux-amd64/);
  assert.match(doc.querySelector('#view .enroll-cmd').textContent, /curl/);
});

test('no signing key: no wizard, and it says who can fix it', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /enroll/config': { serverUrl: 'https://b.example', certFingerprint: null } }) });
  await settle();
  assert.equal(doc.querySelectorAll('#view .form-sec').length, 0, 'a form that can only error is still offered');
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'nothing said why there is no form');
  assert.match(state.textContent, /No agent signing key/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Agent key/.test(b.textContent)),
    'an admin is told what is missing but not where to fix it');
  assert.equal(doc.querySelectorAll('#view .empty.error').length, 0, 'the old red box survived');
});

test('a non-admin is told who has to generate the key, not sent somewhere they cannot go', async (t) => {
  const { doc } = boot({
    t, role: 'operator',
    routes: SESSION({
      'GET /me': { id: 3, email: 'o@y.dk', role: 'operator', preferences: {} },
      'GET /enroll/config': { serverUrl: 'https://b.example', certFingerprint: null },
    }),
  });
  await settle();
  const state = doc.querySelector('#view .state');
  assert.match(state.textContent, /An administrator must generate it/);
  assert.equal(state.querySelectorAll('button').length, 0, 'an operator is offered a screen they cannot open');
});

test('status is a Badge on a tone, not the raw server word as a class', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.equal(rows(doc).length, 2);
  const badges = rows(doc).map((r) => r.querySelector('.badge-ui'));
  assert.ok(badges[0].classList.contains('ok'), 'active is not on the ok tone');
  assert.ok(badges[1].classList.contains('warn'), 'expired is not on the warn tone');
  assert.equal(doc.querySelectorAll('#view table.dt .badge.active, #view table.dt .badge.expired').length, 0,
    'the raw-status class survived');
});

test('Delete moves out of the row into the ⋯ menu, marked destructive', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const act = rows(doc)[0].querySelector('.row-act');
  assert.ok(act, 'no row actions');
  assert.equal(act.querySelectorAll('button.on-hover').length, 0, 'a code has no primary action — it is not a page');
  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const items = [...doc.querySelectorAll('.ui-rowmenu button')];
  assert.deepEqual(items.map((b) => b.textContent), ['Delete code']);
  assert.ok(items[0].classList.contains('danger'));
});

test('"Delete all expired" is offered only when there is something to clear', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const head = doc.querySelectorAll('#view .panel-actions button');
  assert.ok([...head].some((b) => /Delete all expired \(1\)/.test(b.textContent)));

  const clean = boot({ t, routes: SESSION({ 'GET /enrollment-codes': [CODES[0]] }) });
  await settle();
  assert.ok(![...clean.doc.querySelectorAll('#view .panel-actions button')]
    .some((b) => /Delete all expired/.test(b.textContent)), 'offered with nothing to clear');
});

test('an operator gets the wizard but nothing destructive', async (t) => {
  // The page itself is operator+ (a viewer never reaches it), so the read-only
  // case here is the operator who may enrol but may not delete.
  const { doc } = boot({
    t, role: 'operator',
    routes: SESSION({ 'GET /me': { id: 3, email: 'o@y.dk', role: 'operator', preferences: {} } }),
  });
  await settle();
  assert.ok(doc.querySelector('#view .form-sec'), 'an operator is not offered the wizard');
  assert.ok([...doc.querySelectorAll('#view .panel-actions button')].some((b) => /New code/.test(b.textContent)));
  assert.equal(doc.querySelectorAll('#view .row-act').length, 0, 'an operator is offered Delete');
  assert.ok(![...doc.querySelectorAll('#view .panel-actions button')].some((b) => /Delete all expired/.test(b.textContent)));
  assert.equal(rows(doc).length, 2);
});

test('a viewer typing the address gets the forbidden screen, not the page', async (t) => {
  const { doc } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(doc.querySelectorAll('#view .form-sec').length, 0, 'a viewer reached the wizard');
  assert.equal(rows(doc).length, 0, 'a viewer read the codes');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  assert.match(doc.querySelector('#view').textContent, /operator|adgang|permission|not allowed/i);
});

test('no codes yet is an EmptyState that says what to do', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /enrollment-codes': [] }) });
  await settle();
  const state = doc.querySelector('#view .panel-ui:last-child .state');
  assert.ok(state, 'no EmptyState');
  assert.match(state.textContent, /No codes yet/);
  assert.match(state.textContent, /Add agent/);
  assert.equal(doc.querySelectorAll('#view .empty').length, 0, 'the old grey sentence survived');
});

test('a 500 on the codes is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors, window, log } = boot({
    t, routes: SESSION({ 'GET /enrollment-codes': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the load');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed load is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/enrollment-codes/);
  // A failed list must not leave a wizard hanging above an error.
  assert.equal(doc.querySelectorAll('#view .form-sec').length, 0);

  const before = log.filter((x) => x.key === 'GET /enrollment-codes').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /enrollment-codes').length > before, 'Retry did not retry');
});

test('a 404 on the codes is reported, not drawn as "no codes yet"', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /enrollment-codes': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 was drawn as an empty list');
  assert.match(err.textContent, /Not Found|404/i);
});

test('a 404 on the locations costs the picker its options, never the page', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /locations': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const sel = [...doc.querySelectorAll('#view .form-sec select')].pop();
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['(no location)']);
  assert.equal(rows(doc).length, 2, 'the codes went with the locations');
});
