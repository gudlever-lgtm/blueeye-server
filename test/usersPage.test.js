'use strict';

// public/views/users.js — Users, as a ListPage (template A)
// (docs/ui-contract.md).
//
// The screen is reached twice: at /users, and as the Users section inside
// Settings. The second passes mode 'embedded' — the Settings strip already
// names the section, so the page must not head itself a second time.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const USERS = [
  { id: 1, email: 'root@blueeye.local', name: null, role: 'admin', protected: true, must_change_password: false, created_at: '2026-05-28T08:00:00.000Z' },
  { id: 4, email: 'ops@blueeye.local', name: 'Ops Nilsen', role: 'operator', protected: false, must_change_password: false, created_at: '2026-08-02T09:30:00.000Z' },
  { id: 9, email: 'new@blueeye.local', name: null, role: 'viewer', protected: false, must_change_password: true, temp_password_expires_at: '2026-09-20T09:30:00.000Z', created_at: '2026-09-17T09:30:00.000Z' },
];
const AVAIL = { available: true, ssoActive: false, mailerReady: true };

function boot({ t, routes = {}, url = 'http://server.test/users', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const all = Object.assign({
    'GET /me': { id: 1, email: 'x@y.dk', role, preferences: {} },
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    'GET /users': USERS,
    'GET /users/local-availability': AVAIL,
  }, routes);
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const hit = all[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const envelope = hit !== undefined && hit !== null && typeof hit === 'object' && 'body' in hit;
    const status = hit === undefined ? 404 : (envelope ? (hit.status || 200) : 200);
    const body = hit === undefined ? { error: 'Not Found' } : (envelope ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  if (t) t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors };
}
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];
const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const heads = (doc) => [...doc.querySelectorAll('#view table.dt thead th')].map((h) => h.textContent.trim());

test('Users is a ListPage with one primary', async (t) => {
  const { doc, errors } = boot({ t });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace(/\?$/, ''), 'Users');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading row survived');
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 1);
  assert.ok(headBtns(doc).some((b) => /New user/.test(b.textContent)));
  assert.ok(headBtns(doc).some((b) => /Invite/.test(b.textContent)));
});

test('the bare table is a DataTable, and the ID column went with it', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.deepEqual(heads(doc), ['Email', 'Name', 'Role', 'Status', 'Created', '']);
  assert.equal(rows(doc).length, 3);
  assert.equal(doc.querySelectorAll('#view .panel-ui').length, 1);
});

test('a role is metadata, not a state — only the login status is a Badge', async (t) => {
  const { doc } = boot({ t });
  await settle();
  // One badge per row: the account state. The role and "superadmin" are text.
  for (const tr of rows(doc)) {
    assert.equal(tr.querySelectorAll('.badge-ui').length, 1, `row has ${tr.querySelectorAll('.badge-ui').length} badges`);
  }
  const cells = (i, n) => rows(doc)[i].children[n].textContent;
  assert.match(cells(0, 2), /^admin/);
  assert.match(cells(0, 2), /superadmin/);
  assert.equal(rows(doc)[0].querySelector('.badge-ui').textContent, 'Active');
  assert.equal(rows(doc)[2].querySelector('.badge-ui').textContent, 'pending first login');
  assert.ok(rows(doc)[2].querySelector('.badge-ui').classList.contains('warn'));
});

test('an unnamed account says so rather than leaving the cell blank', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.equal(rows(doc)[0].children[1].textContent, '—');
  assert.equal(rows(doc)[1].children[1].textContent, 'Ops Nilsen');
});

test('the row actions are one on hover and the rest behind ⋯', async (t) => {
  const { doc, window } = boot({ t });
  await settle();
  // Every row's hover primary is Edit — a hidden button still holds its width,
  // and "Change password" widened the column enough to clip the email.
  const sup = rows(doc)[0].querySelector('.row-act');
  assert.match(sup.querySelector('.on-hover').textContent, /^Edit$/);
  assert.equal(sup.querySelector('[aria-haspopup="menu"]'), null, 'the superadmin was offered a menu it has no entries for');

  const pending = rows(doc)[2].querySelector('.row-act');
  assert.match(pending.querySelector('.on-hover').textContent, /^Edit$/);
  pending.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const items = [...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent);
  assert.deepEqual(items, ['Resend one-time password', 'Delete']);
  assert.ok(doc.querySelector('.ui-rowmenu button.danger'), 'Delete is not marked destructive');
});

test('a row opens the editor', async (t) => {
  const { doc, window } = boot({ t });
  await settle();
  rows(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(150);
  const modal = doc.querySelector('#modal');
  assert.ok(modal && !modal.classList.contains('hidden'), 'the row opened nothing');
  assert.match(doc.querySelector('#modal-card').textContent, /ops@blueeye\.local/);
});

test('SSO says why there is no invite, where the invite would be', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /users/local-availability': { available: false, ssoActive: true, mailerReady: true } } });
  await settle();
  assert.ok(!headBtns(doc).some((b) => /Invite/.test(b.textContent)), 'an invite that 403s was offered');
  const note = doc.querySelector('#view .inline-note');
  assert.ok(note, 'nothing says why');
  assert.match(note.textContent, /SSO\/LDAP is active/);
  assert.equal(doc.querySelectorAll('#view .page-head ~ p.muted').length, 0, 'the loose grey sentence survived');
});

test('no SMTP points at the screen that fixes it', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /users/local-availability': { available: false, ssoActive: false, mailerReady: false } } });
  await settle();
  const note = doc.querySelector('#view .inline-note');
  assert.match(note.textContent, /SMTP/);
  assert.ok(note.querySelector('a'), 'it names Settings → Alerting but does not link it');
});

test('an installation with only the built-in admin says what to do', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /users': [USERS[0]] } });
  await settle();
  // One account is a list, not an empty state — the empty state is for none.
  assert.equal(rows(doc).length, 1);

  const bare = boot({ t, routes: { 'GET /users': [] } });
  await settle();
  const state = bare.doc.querySelector('#view .state');
  assert.ok(state, 'no EmptyState');
  assert.match(state.textContent, /built-in administrator/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /New user/.test(b.textContent)));
});

test('embedded in Settings, the page does not head itself twice', async (t) => {
  const { doc, errors } = boot({ t, url: 'http://server.test/settings/users' });
  await settle(700);
  assert.deepEqual(errors, []);
  // Settings' own PageHeader is the only one; the section contributes a toolbar.
  assert.equal(doc.querySelectorAll('#view .page-head').length, 1);
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace(/\?$/, ''), 'Settings');
  assert.ok(doc.querySelector('#view .toolbar-right'), 'the actions went with the header');
  assert.ok([...doc.querySelectorAll('#view .toolbar-right button')].some((b) => /New user/.test(b.textContent)));
  assert.equal(rows(doc).length, 3, 'the list did not come with it');
});

test('a 500 on /users costs the list, never the page', async (t) => {
  const { doc, errors } = boot({ t, routes: { 'GET /users': { status: 500, body: { error: 'boom' } } } });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed read is not an ErrorState');
  assert.ok([...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)), 'no Retry on a read that could work next time');
  assert.equal(doc.querySelectorAll('#view .page-head h1').length, 1, 'the page went down with the read');
});

test('a 404 on /users is an ErrorState too, not a blank screen', async (t) => {
  const { doc, errors } = boot({ t, routes: { 'GET /users': { status: 404, body: { error: 'Not Found' } } } });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .state.is-error'));
});
