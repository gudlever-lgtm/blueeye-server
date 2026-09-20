'use strict';

// public/views/screening.js — Test Settings, as a ListPage (template A)
// (docs/ui-contract.md).
//
// The migration this pins: four counting badges become a StatStrip that
// filters, and a three-line .screen-row becomes one DataTable row with the
// per-check verdicts in the Drawer it opens.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const TARGETS = {
  groups: [{ label: 'Alerting' }, { label: 'Integrations' }],
  targets: [
    {
      id: 'alert:smtp', name: 'SMTP (mail)', group: 'Alerting', detail: 'smtp.example.dk:587',
      posture: 'ok', runnable: true, licensed: true,
      security: [{ label: 'TLS', status: 'ok', note: 'STARTTLS negotiated' }, { label: 'Auth', status: 'warn', note: 'Sends credentials in plain text' }],
    },
    {
      id: 'alert:webhook', name: 'Webhook', group: 'Alerting', detail: 'https://hooks.example.dk/x',
      posture: 'bad', runnable: true, licensed: true, security: [{ label: 'TLS', status: 'bad', note: 'Certificate expired' }],
    },
    {
      id: 'cmdb', name: 'CMDB', group: 'Integrations', detail: 'Not configured',
      posture: 'warn', runnable: false, licensed: true, security: [],
    },
    {
      id: 'assistant', name: 'AI assistant', group: 'Integrations', detail: 'mistral',
      posture: 'ok', runnable: true, licensed: false, security: [],
    },
  ],
};
const RUN = {
  summary: { ok: 1, warn: 0, bad: 1 },
  targets: [
    { id: 'alert:smtp', result: { severity: 'ok', ran: true, ok: true, detail: 'accepted (250)', durationMs: 84 } },
    { id: 'alert:webhook', result: { severity: 'bad', ran: true, ok: false, detail: 'certificate expired', durationMs: 1204 } },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/test-settings' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const all = Object.assign({
    'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    'GET /api/diagnostics/targets': TARGETS,
    'POST /api/diagnostics/run': RUN,
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
  window.localStorage.setItem('blueeye.server.role', 'admin');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors };
}
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];
const stats = (doc) => [...doc.querySelectorAll('#view .stat-card')];
const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];

test('Test Settings is a ListPage with one primary', async (t) => {
  const { doc, errors } = boot({ t });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace(/\?$/, ''), 'Test Settings');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 1);
  assert.equal(doc.querySelectorAll('#view .section-head, #view .screen-row, #view .screen-summary, #view .settings-card').length, 0,
    'the old markup survived');
});

test('the four counting badges are a StatStrip', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-l').textContent),
    ['Targets', 'OK', 'Warnings', 'Critical']);
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-n').textContent), ['4', '2', '1', '1']);
  assert.ok(stats(doc)[3].classList.contains('crit'));
  assert.ok(stats(doc)[2].classList.contains('warn'));
  // A count is not a state, so none of them is a Badge any more.
  assert.equal(doc.querySelectorAll('#view .statstrip .badge-ui').length, 0);
});

test('clicking Critical shows the critical ones, and clicking it again clears', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.equal(rows(doc).length, 4);
  stats(doc)[3].click();
  await settle(120);
  assert.equal(rows(doc).length, 1);
  assert.equal(rows(doc)[0].children[1].textContent, 'Webhook');
  assert.equal(stats(doc)[3].getAttribute('aria-pressed'), 'true');
  stats(doc)[3].click();
  await settle(120);
  assert.equal(rows(doc).length, 4);
});

test('a group is a Panel and a target is one row', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.deepEqual(panels(doc).map((p) => p.querySelector('.panel-head h2').textContent), ['Alerting', 'Integrations']);
  assert.deepEqual([...doc.querySelectorAll('#view table.dt thead th')].map((h) => h.textContent.trim()),
    ['Status', 'Target', 'Endpoint', 'Last result', '', 'Status', 'Target', 'Endpoint', 'Last result', '']);
  // One badge per row: the target's state. Nothing else on the row is a badge.
  for (const tr of rows(doc)) assert.equal(tr.querySelectorAll('.badge-ui').length, 1);
  assert.equal(doc.querySelectorAll('#view .screen-chip').length, 0, 'the check pills survived');
});

test('a target that cannot be tested live says so instead of looking untested', async (t) => {
  const { doc } = boot({ t });
  await settle();
  const cmdb = rows(doc).find((r) => r.children[1].textContent === 'CMDB');
  assert.match(cmdb.children[3].textContent, /No live test/);
  // The endpoint is on the row: two webhook targets are the same row without it.
  assert.equal(cmdb.children[2].textContent, 'Not configured');
  assert.equal(cmdb.querySelector('.row-act .on-hover'), null, 'a Run button was offered for something that cannot run');
  const smtp = rows(doc).find((r) => r.children[1].textContent === 'SMTP (mail)');
  assert.match(smtp.children[3].textContent, /Not tested yet/);
  assert.equal(smtp.children[2].textContent, 'smtp.example.dk:587');
  assert.match(smtp.querySelector('.row-act .on-hover').textContent, /^Run$/);
});

test('an unlicensed target is not offered a run it would be refused', async (t) => {
  const { doc } = boot({ t });
  await settle();
  const ai = rows(doc).find((r) => r.children[1].textContent === 'AI assistant');
  assert.equal(ai.querySelector('.row-act .on-hover'), null);
});

test('the row opens a drawer with the per-check verdicts and their notes', async (t) => {
  const { doc, window } = boot({ t });
  await settle();
  rows(doc)[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(120);
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(drawer, 'the row opened nothing');
  assert.equal(drawer.querySelector('.drawer-head h2').textContent, 'SMTP (mail)');
  const kv = [...drawer.querySelectorAll('.kv-ui dt')].map((d) => d.textContent);
  assert.ok(kv.includes('TLS') && kv.includes('Auth'), `checks missing — got ${kv.join(', ')}`);
  // The note was only ever a title= tooltip on the pill.
  assert.match(drawer.textContent, /Sends credentials in plain text/);
  assert.match(drawer.textContent, /STARTTLS negotiated/);
  // …and the drawer offers the run and the way to the screen that configures it.
  assert.ok([...drawer.querySelectorAll('.drawer-foot button')].some((b) => /^Run$/.test(b.textContent)));
  assert.ok(drawer.querySelector('.drawer-foot a'), 'no way to the screen that sets this up');
});

test('running the lot fills the results and moves the counts', async (t) => {
  const { doc } = boot({ t });
  await settle();
  const run = headBtns(doc).find((b) => /Run full screening/.test(b.textContent));
  run.click();
  await settle(300);
  const smtp = rows(doc).find((r) => r.children[1].textContent === 'SMTP (mail)');
  assert.match(smtp.children[3].textContent, /accepted \(250\)/);
  assert.match(smtp.children[3].textContent, /84 ms/);
  assert.match(smtp.children[3].textContent, /✓/);
  const hook = rows(doc).find((r) => r.children[1].textContent === 'Webhook');
  assert.match(hook.children[3].textContent, /✗/);
  assert.match(hook.children[3].textContent, /certificate expired/);
  assert.match(doc.querySelector('#toast').textContent, /1 critical/);
  assert.equal(run.textContent, 'Run full screening', 'the button never came back');
});

test('a filter that matches nothing says so and offers the way out', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /api/diagnostics/targets': { groups: [{ label: 'Alerting' }], targets: [
    { id: 'alert:smtp', name: 'SMTP (mail)', group: 'Alerting', detail: '', posture: 'ok', runnable: true, licensed: true, security: [] },
  ] } } });
  await settle();
  stats(doc)[3].click();
  await settle(120);
  const state = doc.querySelector('#view .state');
  assert.ok(state, 'no EmptyState');
  assert.match(state.textContent, /Nothing is Critical/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Show all targets/.test(b.textContent)));
});

test('embedded in Settings, the page does not head itself twice', async (t) => {
  const { doc, errors } = boot({ t, url: 'http://server.test/settings/screening' });
  await settle(700);
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelectorAll('#view .page-head').length, 1);
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace(/\?$/, ''), 'Settings');
  assert.ok([...doc.querySelectorAll('#view .toolbar-right button')].some((b) => /Run full screening/.test(b.textContent)));
  assert.equal(rows(doc).length, 4, 'the catalogue did not come with it');
});

test('a 500 on the catalogue is an ErrorState with a Retry, not red text', async (t) => {
  const { doc, errors } = boot({ t, routes: { 'GET /api/diagnostics/targets': { status: 500, body: { error: 'boom' } } } });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed read is not an ErrorState');
  assert.ok([...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
  assert.equal(doc.querySelectorAll('#view .empty.error').length, 0, 'the red box survived');
  assert.equal(doc.querySelectorAll('#view .page-head h1').length, 1, 'the page went down with the read');
});

test('a 404 on the catalogue is an ErrorState too', async (t) => {
  const { doc, errors } = boot({ t, routes: { 'GET /api/diagnostics/targets': { status: 404, body: { error: 'Not Found' } } } });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .state.is-error'));
});

test('a 500 on the run keeps the page and says what happened', async (t) => {
  const { doc, errors } = boot({ t, routes: { 'POST /api/diagnostics/run': { status: 500, body: { error: 'the worker is down' } } } });
  await settle();
  const run = headBtns(doc).find((b) => /Run full screening/.test(b.textContent));
  run.click();
  await settle(300);
  assert.deepEqual(errors, []);
  assert.equal(rows(doc).length, 4, 'a failed run took the catalogue with it');
  assert.match(doc.querySelector('#toast').textContent, /worker is down/);
  assert.equal(run.textContent, 'Run full screening', 'the button was left saying Running…');
});
