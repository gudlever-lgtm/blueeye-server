'use strict';

// public/views/license.js — License status, as a DashboardPage (template B)
// (docs/ui-contract.md).
//
// The migration this pins: sixteen figures in three undifferentiated .cards
// rows become four StatStrip numbers plus one Panel of key/values, and the
// licence's own state moves beside the title.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const STATUS = {
  status: 'valid', licensed: true, maxAgents: 50, serverId: 'srv-7f2a',
  verifiedAt: '2026-09-17T06:00:00.000Z', graceUntil: '2026-09-24T06:00:00.000Z',
  validUntil: '2027-03-01T00:00:00.000Z', mode: 'online',
  publicKeyTrust: { configured: true, source: 'embedded' },
};
const PLAN = {
  plan_name: 'Professional', is_trial: false, support_level: 'Business hours',
  limits: { max_agents: 50, max_test_paths: 200, history_days: 180 },
};
const USAGE = {
  agents: { used: 47, max: 50 }, test_paths: { used: 12, max: 200 },
  history_days: 180, lastValidation: '2026-09-17T06:00:00.000Z',
};
const MATRIX = {
  activePlan: 'professional',
  plans: [
    { plan_key: 'essential', plan_name: 'Essential', features: { flows: true, assurance: false, nis2: false } },
    { plan_key: 'professional', plan_name: 'Professional', features: { flows: true, assurance: true, nis2: false } },
    { plan_key: 'enterprise', plan_name: 'Enterprise', features: { flows: true, assurance: true, nis2: true } },
  ],
  features: [
    { key: 'flows', label: 'NetFlow / sFlow', status: 'shipped' },
    { key: 'assurance', label: 'Service Assurance', status: 'shipped' },
    { key: 'nis2', label: 'NIS2 reporting', status: 'roadmap' },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/license', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const all = Object.assign({
    'GET /me': { id: 1, email: 'x@y.dk', role, preferences: {} },
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    'GET /license/status': STATUS,
    'GET /license/plan': PLAN,
    'GET /license/usage': USAGE,
    'GET /license/matrix': MATRIX,
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
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors };
}
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];
const stats = (doc) => [...doc.querySelectorAll('#view .stat-card')];
const kv = (doc) => {
  const out = {};
  const dl = doc.querySelector('#view .kv-ui');
  if (!dl) return out;
  const dts = [...dl.querySelectorAll('dt')];
  const dds = [...dl.querySelectorAll('dd')];
  dts.forEach((d, i) => { out[d.textContent] = dds[i] ? dds[i].textContent : ''; });
  return out;
};

test('the licence state sits beside the title, not in a grid cell', async (t) => {
  const { doc, errors } = boot({ t });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  const h1 = doc.querySelector('#view .page-head h1');
  assert.match(h1.textContent, /License status/);
  const badge = h1.querySelector('.badge-ui');
  assert.ok(badge, 'the licence state is not in the status slot');
  assert.equal(badge.textContent, 'Valid');
  assert.ok(badge.classList.contains('ok'));
  assert.match(doc.querySelector('#view .page-head p').textContent, /Professional/);
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 1);
  assert.equal(doc.querySelectorAll('#view .section-head, #view .cards, #view .stat, #view table.matrix, #view .alert-banner').length, 0,
    'the old markup survived');
});

test('the four figures somebody acts on are a StatStrip', async (t) => {
  const { doc } = boot({ t });
  await settle();
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-l').textContent),
    ['Agents used', 'Active test paths', 'History (days)', 'Licence expires']);
  assert.equal(stats(doc)[0].querySelector('.stat-n').textContent, '47 / 50');
  // 94% of the agent limit is worth a colour; 6% of the path limit is not.
  assert.ok(stats(doc)[0].classList.contains('crit'));
  assert.equal(stats(doc)[1].classList.contains('crit'), false);
  assert.equal(stats(doc)[1].classList.contains('warn'), false);
  assert.equal(stats(doc)[2].querySelector('.stat-n').textContent, '180');
  // An expiry is a date; a minute on it would read as precision it lacks.
  assert.doesNotMatch(stats(doc)[3].querySelector('.stat-n').textContent, /\d{2}:\d{2}/);
  assert.match(stats(doc)[3].querySelector('.stat-n').textContent, /2027/);
  assert.equal(doc.querySelectorAll('#view .lic-bars .usagebar').length, 2);
});

test('the rest is one reference block, not three loose h3s', async (t) => {
  const { doc } = boot({ t });
  await settle();
  const pairs = kv(doc);
  assert.equal(pairs.Licensed, 'Yes');
  assert.equal(pairs.Plan, 'BlueEyes Professional');
  assert.equal(pairs['Support level'], 'Business hours');
  assert.equal(pairs['Server ID'], 'srv-7f2a');
  assert.equal(pairs['Max. agents'], '50');
  assert.match(pairs.Validation, /Online/);
  assert.ok(pairs['Grace expires'], 'grace is an online concept and this licence is online');
});

test('an offline licence reports its own evidence trail, not a grace window', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /license/status': Object.assign({}, STATUS, { mode: 'offline', organizationId: 'org-42' }) } });
  await settle();
  const pairs = kv(doc);
  assert.match(pairs.Validation, /Offline/);
  assert.equal(pairs['Grace expires'], undefined, 'an offline licence was given a grace window it does not have');
  assert.equal(pairs['Server ID'], undefined);
  assert.equal(pairs.Organization, 'org-42');
});

test('an offline licence that is not valid says it is restricted', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /license/status': Object.assign({}, STATUS, { mode: 'offline', licensed: false, status: 'invalid' }) } });
  await settle();
  const note = [...doc.querySelectorAll('#view .inline-note')].find((n) => /Restricted mode/.test(n.textContent));
  assert.ok(note, 'nothing says the server is restricted');
  assert.ok(doc.querySelector('#view .page-head h1 .badge-ui').classList.contains('crit'));
});

test('a misconfigured trust anchor is said outright, not left looking like a stuck refresh', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /license/status': Object.assign({}, STATUS, { publicKeyTrust: { configured: false, source: 'embedded' } }) } });
  await settle();
  const note = doc.querySelector('#view .inline-note.is-crit');
  assert.ok(note, 'the trust warning is missing');
  assert.match(note.textContent, /never reflect changes/);
  assert.match(note.textContent, /placeholder/);
  assert.equal(doc.querySelectorAll('#view .alert-banner').length, 0, 'the page-local banner survived');
});

test('the matrix is a DataTable: the current plan is named, unentitled rows are dimmed', async (t) => {
  const { doc } = boot({ t });
  await settle();
  const table = [...doc.querySelectorAll('#view table.dt')].pop();
  assert.deepEqual([...table.querySelectorAll('thead th')].map((h) => h.textContent.trim()),
    ['Feature', 'Essential', 'Professional', 'Enterprise']);
  // The current plan is named in the panel note, not spelled into a header
  // that clips at any plan name longer than a word.
  assert.match([...doc.querySelectorAll('#view .panel-head .meta-xs')].pop().textContent, /You are on Professional/);
  const rows = [...table.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 3);
  // NetFlow and Service Assurance are in this plan; NIS2 is not, and is roadmap.
  assert.equal(rows[0].classList.contains('is-dimmed'), false);
  assert.equal(rows[1].classList.contains('is-dimmed'), false);
  assert.ok(rows[2].classList.contains('is-dimmed'));
  // A tick is not a state; "Roadmap" is.
  assert.equal(rows[0].children[1].textContent, '✓');
  assert.equal(rows[0].querySelectorAll('.badge-ui').length, 0);
  assert.equal(rows[2].querySelector('.badge-ui').textContent, 'Roadmap');
  assert.equal(rows[1].children[1].textContent, '–', 'Essential does not include Service Assurance');
});

test('a server without the plan layer still renders the status it is named for', async (t) => {
  const { doc, errors } = boot({ t, routes: {
    'GET /license/plan': { status: 503, body: { error: 'nope' } },
    'GET /license/usage': { status: 404, body: { error: 'nope' } },
    'GET /license/matrix': { status: 500, body: { error: 'nope' } },
  } });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelector('#view .page-head h1 .badge-ui').textContent, 'Valid');
  assert.equal(kv(doc)['Max. agents'], '50', 'the status block lost the limit it carries itself');
  assert.equal(doc.querySelectorAll('#view table.dt').length, 0, 'a matrix was invented');
  // No usage read, but the status carries the agent limit itself — so the
  // strip says what is known and marks what is not, rather than vanishing.
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-l').textContent),
    ['Agents used', 'Licence expires']);
  assert.equal(stats(doc)[0].querySelector('.stat-n').textContent, '– / 50');
  assert.equal(doc.querySelectorAll('#view .lic-bars .usagebar').length, 0, 'a bar was drawn for a percentage nobody knows');
});

test('a viewer is offered no Re-validate', async (t) => {
  const { doc } = boot({ t, role: 'viewer', routes: { 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } } });
  await settle();
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 0);
  assert.ok(doc.querySelector('#view .kv-ui'), 'a viewer cannot read the licence either');
});

test('embedded in Settings, the page does not head itself twice', async (t) => {
  const { doc, errors } = boot({ t, url: 'http://server.test/settings/license' });
  await settle(700);
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelectorAll('#view .page-head').length, 1);
  assert.equal(doc.querySelector('#view .page-head h1').textContent.replace(/\?$/, ''), 'Settings');
  // The state comes with it, in the toolbar rather than a second heading.
  assert.ok([...doc.querySelectorAll('#view .toolbar-ui .badge-ui')].some((b) => b.textContent === 'Valid'));
  assert.ok(doc.querySelector('#view .kv-ui'), 'the licence block did not come with it');
});

test('a 500 on the status is an ErrorState with a Retry', async (t) => {
  const { doc, errors } = boot({ t, routes: { 'GET /license/status': { status: 500, body: { error: 'boom' } } } });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed read is not an ErrorState');
  assert.ok([...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
  assert.equal(doc.querySelectorAll('#view .page-head h1').length, 1, 'the page went down with the read');
  assert.doesNotMatch(doc.querySelector('#view').textContent, /\bnull\b/, 'replaceChildren stringified a null again');
});

test('a 404 on the status is an ErrorState too', async (t) => {
  const { doc, errors } = boot({ t, routes: { 'GET /license/status': { status: 404, body: { error: 'Not Found' } } } });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .state.is-error'));
});
