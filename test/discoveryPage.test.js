'use strict';

// public/views/discovery.js — Discovery on the UI contract
// (docs/ui-contract.md).
//
// The migration this pins: the page-local form framework becomes a FormSection,
// the counts line becomes the filter, Promote/Dismiss stop being two buttons in
// a row, status stops being the server's word as a CSS class, and each of the
// four panels fails on its own.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CFG = {
  enabled: true, scopeConfigured: true, editable: true,
  cidrs: ['10.0.0.0/24'], ports: [22, 161], rateLimit: 50, addressCap: 65536, intervalMinutes: 360,
};
const CANDS = {
  counts: { discovered: 2, promoted: 1, ignored: 9 },
  candidates: [
    { id: 1, ip: '10.0.0.14', hostname: 'sw-core-01', openPorts: [22, 161], foundByAgentId: 7, status: 'discovered' },
    { id: 2, ip: '10.0.0.31', hostname: null, openPorts: [80], foundByAgentId: null, status: 'discovered' },
    { id: 3, ip: '10.0.0.9', hostname: 'ap-2', openPorts: [443], foundByAgentId: 7, status: 'promoted', promotedAgentId: 12 },
  ],
};
const SWEEPS = {
  sweeps: [
    { createdAt: '2026-09-17T09:10:00.000Z', action: 'discovery_sweep', detail: '512 addresses' },
    { createdAt: '2026-09-17T03:10:00.000Z', action: 'discovery_sweep_refused', detail: 'address cap exceeded' },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/discovery', role = 'admin' } = {}) {
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
  window.confirm = () => true;
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
  'GET /agents': [
    { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01', status: 'online' },
    { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02', status: 'offline' },
  ],
  'GET /api/discovery/config': CFG,
  'GET /api/discovery/candidates': CANDS,
  'GET /api/discovery/sweeps': SWEEPS,
}, over);

const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];
const panelBy = (doc, re) => panels(doc).find((p) => re.test((p.querySelector('h2') || {}).textContent || ''));
const candRows = (doc) => [...panelBy(doc, /Candidates/).querySelectorAll('table.dt tbody tr')];
const stats = (doc) => [...panelBy(doc, /Candidates/).querySelectorAll('.stat-card')];

test('Discovery is a DashboardPage of four panels', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Discovery/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.deepEqual(panels(doc).map((p) => p.querySelector('h2').textContent),
    ['Scan scope', 'Manual sweep', 'Candidates', 'Sweep history']);
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading block survived');
  assert.equal(doc.querySelectorAll('#view .discovery-form, #view .discovery-form-row').length, 0,
    'the page-local form framework survived');
});

test('the scope is a FormSection with the server\'s values in it', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const sec = panelBy(doc, /Scan scope/).querySelector('.form-sec');
  assert.ok(sec, 'the scope is not a FormSection');
  assert.deepEqual([...sec.querySelectorAll('.f > label')].map((l) => l.textContent),
    ['CIDR ranges', 'Ports', 'Rate (probes/sec)', 'Address cap', 'Sweep interval (min)']);
  assert.equal(sec.querySelector('textarea').value, '10.0.0.0/24');
  assert.equal(sec.querySelector('input[type=text]').value, '22, 161');
});

test('saving the scope sends what the form holds, and a 400 lands on the form', async (t) => {
  const { doc, window, log } = boot({
    t, routes: SESSION({ 'PUT /api/discovery/config': { status: 400, body: { details: { cidrs: 'not a CIDR' } } } }),
  });
  await settle();
  const scope = panelBy(doc, /Scan scope/);
  scope.querySelector('textarea').value = '10.1.0.0/24\n10.2.0.0/24';
  scope.querySelector('.form-actions-ui .btn-primary').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const sent = JSON.parse(log.find((x) => x.key === 'PUT /api/discovery/config').body);
  assert.deepEqual(sent.cidrs, ['10.1.0.0/24', '10.2.0.0/24']);
  assert.equal(sent.rateLimit, 50);
  // The per-field message from the server, next to the button that failed —
  // not a toast that is gone before the reader looks back at the form.
  assert.match(scope.querySelector('.field-error').textContent, /cidrs: not a CIDR/);
  assert.equal(scope.querySelector('.form-actions-ui .btn-primary').disabled, false, 'the button stayed dead after a failure');
});

test('an env-managed scope shows its values and offers no form', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /api/discovery/config': Object.assign({}, CFG, { editable: false }) }),
  });
  await settle();
  const scope = panelBy(doc, /Scan scope/);
  assert.equal(scope.querySelectorAll('.form-sec').length, 0, 'a form that cannot save is still offered');
  assert.ok(scope.querySelector('.inline-note'), 'nothing said why there is no form');
  assert.match(scope.querySelector('.kv-ui').textContent, /10\.0\.0\.0\/24/);
});

test('an unconfigured scope says the sweeps will refuse', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /api/discovery/config': Object.assign({}, CFG, { scopeConfigured: false }) }),
  });
  await settle();
  const badges = [...panelBy(doc, /Scan scope/).querySelectorAll('.panel-actions .badge-ui')];
  assert.ok(badges.some((b) => /refuse/.test(b.textContent)), 'nothing warned that sweeps cannot run');
  assert.ok(badges.some((b) => b.classList.contains('warn')));
});

test('only connected agents are offered as a sweep vantage', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const sel = panelBy(doc, /Manual sweep/).querySelector('select');
  // cph-core-02 is offline, so sending it a command would only answer 409.
  assert.deepEqual([...sel.options].map((o) => o.textContent),
    ['Server (default vantage)', 'Agent · oslo-edge-01']);
});

test('a sweep reports what it swept, and a refusal is not a success', async (t) => {
  const { doc, window } = boot({
    t, routes: SESSION({ 'POST /api/discovery/scan': { addresses: 512, found: 3 } }),
  });
  await settle();
  const sweep = panelBy(doc, /Manual sweep/);
  sweep.querySelector('.btn-primary').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(sweep.textContent, /Swept 512 addresses · 3 candidate/);

  const ref = boot({ t, routes: SESSION({ 'POST /api/discovery/scan': { refused: true, reason: 'no scope' } }) });
  await settle();
  const p2 = panelBy(ref.doc, /Manual sweep/);
  p2.querySelector('.btn-primary').dispatchEvent(new ref.window.Event('click', { bubbles: true }));
  await settle();
  const note = p2.querySelector('.inline-note.is-warn');
  assert.ok(note, 'a refused sweep read like a successful one');
  assert.match(note.textContent, /Refused: no scope/);
});

test('a 409 on the sweep says the agent is not connected', async (t) => {
  const { doc, window } = boot({
    t, routes: SESSION({ 'POST /api/discovery/scan': { status: 409, body: { error: 'not connected' } } }),
  });
  await settle();
  const sweep = panelBy(doc, /Manual sweep/);
  sweep.querySelector('.btn-primary').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(sweep.querySelector('.inline-note.is-crit').textContent, /not connected right now/);
});

test('the counts are the filter', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(stats(doc).map((c) => c.querySelector('.stat-n').textContent), ['2', '1', '9']);
  assert.deepEqual(stats(doc).map((c) => c.getAttribute('aria-pressed')), ['false', 'false', 'false']);
  assert.equal(doc.querySelectorAll('#view .discovery-cand-head').length, 0, 'the old counts line survived');

  stats(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.match(log.filter((x) => x.key === 'GET /api/discovery/candidates').pop().url, /status=promoted/);
  assert.equal(stats(doc)[1].getAttribute('aria-pressed'), 'true');

  // Clicking the pressed one clears it.
  stats(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(!/status=/.test(log.filter((x) => x.key === 'GET /api/discovery/candidates').pop().url));
});

test('status is a Badge on a tone, not the server\'s word as a class', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const badges = candRows(doc).map((r) => r.querySelectorAll('.badge-ui')[0]);
  assert.ok(badges[0].classList.contains('warn'), 'discovered is not on the warn tone');
  assert.ok(badges[2].classList.contains('ok'), 'promoted is not on the ok tone');
  assert.equal(doc.querySelectorAll('#view .badge.discovered, #view .badge.online').length, 0,
    'the raw-status class survived');
});

test('Promote is the row action and Dismiss is behind the menu', async (t) => {
  const { doc, window, log } = boot({
    t, routes: SESSION({ 'POST /api/discovery/candidates/1/promote': { agentId: 44 } }),
  });
  await settle();
  const act = candRows(doc)[0].querySelector('.row-act');
  assert.equal(act.querySelectorAll('button').length, 2, 'the row still carries two loose buttons');
  assert.match(act.querySelector('button.on-hover').textContent, /Promote/);
  assert.equal(doc.querySelectorAll('#view .row-actions').length, 0, 'the old button row survived');

  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual([...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent), ['Dismiss']);

  act.querySelector('button.on-hover').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.some((x) => x.key === 'POST /api/discovery/candidates/1/promote'), 'Promote did not promote');
});

test('a promoted candidate offers no actions, only the agent it became', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /agents/12': { id: 12, hostname: 'ap-2' } }) });
  await settle();
  const row = candRows(doc)[2];
  assert.equal(row.querySelectorAll('.row-act').length, 0, 'a promoted candidate is offered Promote again');
  assert.match(row.textContent, /agent 12/);
});

test('an empty result says which of the two it is', async (t) => {
  const { doc } = boot({
    t, routes: SESSION({ 'GET /api/discovery/candidates': { counts: {}, candidates: [] } }),
  });
  await settle();
  const state = panelBy(doc, /Candidates/).querySelector('.state');
  assert.match(state.textContent, /Nothing found yet/);
  assert.equal(state.querySelectorAll('button').length, 0, 'nothing to clear, but a Clear is offered');
});

test('a filter that matches nothing offers the Clear', async (t) => {
  const { doc, window } = boot({
    t, routes: SESSION({ 'GET /api/discovery/candidates': { counts: { discovered: 2, promoted: 0, ignored: 0 }, candidates: [] } }),
  });
  await settle();
  stats(doc)[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const state = panelBy(doc, /Candidates/).querySelector('.state');
  assert.match(state.textContent, /No candidates are Promoted/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Clear/.test(b.textContent)));
});

test('a 500 on the candidates leaves the other three panels standing', async (t) => {
  const { doc, errors, window, log } = boot({
    t, routes: SESSION({ 'GET /api/discovery/candidates': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(panels(doc).length, 4, 'one failing call took the page with it');
  assert.ok(panelBy(doc, /Scan scope/).querySelector('.form-sec'), 'the scope went down with the candidates');
  assert.ok(panelBy(doc, /Sweep history/).querySelector('table.dt'), 'the history went down with the candidates');
  const err = panelBy(doc, /Candidates/).querySelector('.state.is-error');
  assert.ok(err, 'a failed load is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/api\/discovery\/candidates/);

  const before = log.filter((x) => x.key === 'GET /api/discovery/candidates').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/discovery/candidates').length > before, 'Retry did not retry');
});

test('a 404 on the sweeps is reported, not drawn as "no sweeps yet"', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /api/discovery/sweeps': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = panelBy(doc, /Sweep history/).querySelector('.state.is-error');
  assert.ok(err, 'a 404 was drawn as an empty history');
  assert.match(err.textContent, /Not Found|404/i);
  assert.ok(panelBy(doc, /Candidates/).querySelector('table.dt'), 'the candidates went with the history');
});

test('a 403 on the config is not reported as a failure', async (t) => {
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /api/discovery/config': { status: 403, body: { error: 'Forbidden' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const state = panelBy(doc, /Scan scope/).querySelector('.state');
  assert.ok(state, 'nothing was said at all');
  assert.ok(!state.classList.contains('is-error'), 'a role boundary was drawn as a server failure');
  assert.match(state.textContent, /administrators/);
  // Nothing else is drawn: without the config there is nothing to configure.
  assert.equal(panels(doc).length, 1);
});
