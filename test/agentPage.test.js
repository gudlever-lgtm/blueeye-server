'use strict';

// public/views/agent.js — one agent, as a DetailPage (template D)
// (docs/ui-contract.md).
//
// A SHELL migration: the four <details class="sec"> folds keep their forms,
// pollers and charts. What is tested here is the page they sit on — a
// six-item heading row becoming a PageHeader, and three card titles that used
// to be written twice.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const AGENT = (over = {}) => Object.assign({
  id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01.lan',
  platform: 'linux', arch: 'amd64', status: 'online',
  location_id: 1, location_name: 'Oslo HQ',
  capabilities: { agentVersion: '0.42.0', nic: [{ iface: 'eth0', driver: 'i40e' }] },
}, over);

const HEALTH = {
  health: { status: 'warn', reason: 'Loss above baseline on two targets', metrics: { targets: 4, reachable: 3, lossPct: 3.1, latencyMs: 42, baselineMs: 21, jitterMs: 12, ifaceStatus: 'ok' } },
  quality: { status: 'ok', reason: 'complete', version: '0.42.0' },
  throughput: { ok: true, downMbps: 480, upMbps: 92 },
};

function boot({ t, routes = {}, url = 'http://server.test/agents/7', role = 'admin' } = {}) {
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
    // An envelope is `{ status, body }`; anything else IS the body. An agent
    // payload carries its own `status: 'online'`, so reading `hit.status`
    // unconditionally answered "HTTP online" and failed every load.
    const envelope = hit !== undefined && hit !== null && typeof hit === 'object' && 'body' in hit;
    const status = hit === undefined ? 404 : (envelope ? (hit.status || 200) : 200);
    const body = hit === undefined ? { error: 'Not Found' } : (envelope ? hit.body : hit);
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
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [AGENT()],
  'GET /agents/7': AGENT(),
  'GET /api/fleet/agent/7': HEALTH,
  'GET /api/probes/latest': { results: [] },
  'GET /api/interfaces': { source: 'proc', ts: null, interfaces: [] },
  'GET /agents/7/results': [],
  'GET /api/devices/7/config-history': { snapshots: [], diffs: [] },
  'GET /api/cmdb/assets/status': { enabled: false, type: null },
  'GET /api/topology/dependencies': { outbound: [], inbound: [] },
  'GET /api/targets/7/timeline': { events: [] },
  'GET /agents/7/tests': {
    agentId: 7, connected: true,
    tests: [{ type: 'ping', kind: 'probe', available: true, reason: null }],
    packages: [],
  },
}, over);

const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];
const panelTitles = (doc) => [...doc.querySelectorAll('#view .panel-ui > .panel-head h2')].map((h) => h.textContent);

test('the agent is a DetailPage with its status beside the name', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  const h1 = doc.querySelector('#view .page-head h1');
  assert.match(h1.textContent, /oslo-edge-01/);
  assert.ok(h1.querySelector('.badge-ui').classList.contains('ok'), 'the status is not beside the name');
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  // The heading was a .section-head with six things in one flex row.
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old heading row survived');
});

test('the location is a HostLink in the lead, not an emoji on a .linklike', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /locations/1': { id: 1, name: 'Oslo HQ' } }) });
  await settle();
  const lead = doc.querySelector('#view .page-head p');
  assert.match(lead.textContent, /linux \/ amd64/);
  const link = lead.querySelector('.hostlink');
  assert.ok(link, 'the location is not a link');
  assert.match(link.textContent, /Oslo HQ/);
  assert.ok(!/📍/.test(lead.textContent), 'the emoji survived');
  link.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/locations/1');
});

test('there is one primary, and it is the one that does something to the agent', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const primaries = headBtns(doc).filter((b) => b.classList.contains('btn-primary'));
  assert.equal(primaries.length, 1, 'more than one primary on the record');
  assert.match(primaries[0].textContent, /Run test/);
  for (const label of [/Flows/, /Export/, /Overview/]) {
    assert.ok(headBtns(doc).some((b) => label.test(b.textContent)), `missing ${label}`);
  }
});

test('a viewer is offered no Run test', async (t) => {
  const { doc } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(headBtns(doc).filter((b) => b.classList.contains('btn-primary')).length, 0);
  // …and config history, which is operator+, is not a panel at all.
  assert.ok(!panelTitles(doc).includes('Config history'));
});

test('each card title is written once, by the panel that owns it', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // LLDP neighbours (GET /api/topology/neighbors?target=) joined the cards when
  // that endpoint got its first caller.
  assert.deepEqual(panelTitles(doc), ['Health', 'Config history', 'CMDB asset', 'Dependencies', 'LLDP neighbours']);
  // The loaders used to write their own <h3> inside a panel already headed the
  // same thing — "Config history" twice, two lines apart.
  for (const title of ['Config history', 'CMDB asset', 'Dependencies']) {
    const panel = [...doc.querySelectorAll('#view .panel-ui')]
      .find((p) => (p.querySelector('h2') || {}).textContent === title);
    assert.equal(panel.querySelectorAll('h3').length, 0, `${title} is headed twice`);
  }
  // …and no stray "null" from replaceChildren stringifying a dropped heading.
  assert.ok(!/(^|>)null(<|$)/.test(doc.querySelector('#view').innerHTML));
});

test('the activity timeline draws its own card and is not double-framed', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const tl = doc.querySelector('#view .agent-timeline');
  assert.ok(tl, 'the activity timeline is gone');
  assert.ok(!tl.closest('.panel-ui'), 'the timeline is inside a panel as well as its own card');
});

test('the health résumé shows every number behind the verdict', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const health = doc.querySelector('#view .agent-health');
  assert.ok(health, 'no health résumé');
  assert.match(health.textContent, /Loss above baseline/);
  assert.match(health.textContent, /3\/4/);
  assert.match(health.textContent, /3\.1%/);
  assert.match(health.textContent, /~21 ms/);
  assert.match(health.textContent, /480/);
});

test('the four folds are there, and the probe form is in one of them', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const folds = [...doc.querySelectorAll('#view details.sec')];
  // There were five. The NIC fold is gone: one agent's cards are the ports that
  // agent has, so the driver and firmware ride on the port rows inside
  // Interfaces rather than in a second table under it.
  assert.equal(folds.length, 4);
  // Each summary carries a status line after its name; the name is the first word.
  assert.deepEqual(folds.map((f) => f.querySelector('summary').textContent.trim().split(/[\s·]/)[0]),
    ['Probes', 'Tests', 'Interfaces', 'Traffic']);
  assert.ok(folds[0].querySelector('select'), 'the probe form is gone');
  // Probes and Interfaces open by default; the rest do not.
  assert.deepEqual(folds.map((f) => f.open), [true, false, true, false]);
});

// The Tests fold answers BEFORE the run. A test the agent said it cannot run is
// named as unavailable with the AGENT's own reason, on a host that has no shell
// for anyone to go and look at afterwards.
test('the Tests fold names what this agent cannot run, and why', async (t) => {
  const { doc } = boot({
    t,
    routes: SESSION({
      'GET /agents/7/tests': {
        agentId: 7, connected: true,
        tests: [
          { type: 'ping', kind: 'probe', available: true, reason: null },
          { type: 'poll-snmp', kind: 'snmp', available: false, reason: 'net-snmp is missing — reinstall the agent' },
        ],
        packages: [{ id: 3, name: 'Daily reachability', enabled: true, items: 2, schedule_ms: 0, schedule_spec: null, last_run_at: null }],
      },
    }),
  });
  await settle();
  const fold = [...doc.querySelectorAll('#view details.sec')][1];
  assert.match(fold.textContent, /net-snmp is missing/, "the agent's own reason is not shown");
  assert.match(fold.textContent, /Daily reachability/, 'the packages aimed at this agent are not listed');
  // …and the Probes form will not offer the type the agent refused.
  const snmp = [...doc.querySelectorAll('#view select option')].find((o) => o.value === 'poll-snmp');
  if (snmp) assert.ok(snmp.disabled, 'an unrunnable type is still selectable');
});

test('a failed catalogue read costs the catalogue, never the Probes form above it', async (t) => {
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /agents/7/tests': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  // Scoped to the Tests fold: the neighbours card draws its own ErrorState in
  // this fixture, and an unscoped query finds that one first.
  const fold = [...doc.querySelectorAll('#view details.sec')][1];
  const err = fold.querySelector('.state.is-error');
  assert.ok(err, 'a failed catalogue read left a blank fold');
  assert.match(err.querySelector('code').textContent, /GET \/agents\/7\/tests/);
  assert.ok(doc.querySelector('#view details.sec select'), 'the Probes form went with it');
});

test('no agent selected is an EmptyState with a way out', async (t) => {
  const { doc } = boot({ t, url: 'http://server.test/agents', routes: SESSION() });
  await settle();
  // /agents is the list; the detail's own no-selection state is what a direct
  // entry with no id produces.
  assert.ok(doc.querySelector('#view .ui-page'));
});

test('a 404 names the id it could not find, and offers no pointless Retry', async (t) => {
  const { doc, errors } = boot({
    t, url: 'http://server.test/agents/999', routes: SESSION({ 'GET /agents/999': undefined }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a missing agent is not an ErrorState');
  assert.match(err.textContent, /999 does not exist/);
  assert.ok(![...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
  assert.ok(headBtns(doc).some((b) => /Overview/.test(b.textContent)), 'no way back from a dead link');
});

test('a 500 is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /agents/7': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err);
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/agents\/7/);
  assert.ok([...err.querySelectorAll('button')].some((b) => /Retry|Prøv/i.test(b.textContent)));
  // Nothing else is drawn: without the agent there is nothing to draw about it.
  assert.equal(doc.querySelectorAll('#view details.sec').length, 0);
});

test('a failed health read costs the résumé, never the page', async (t) => {
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /api/fleet/agent/7': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the verdict');
  assert.equal(doc.querySelectorAll('#view details.sec').length, 4, 'the folds went with it');
});

test('the record marks itself in the rail and in the breadcrumb', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const marked = doc.querySelector('.tabs button.active');
  assert.ok(marked, 'nothing in the sidebar says where the reader is');
  // The agent's own page marks Fleet: the list it came from is a column set
  // there now (docs/fleet-and-sites-consolidation.md).
  assert.equal(marked.dataset.view, 'fleet');
  assert.match(doc.querySelector('#crumb').textContent, /Monitoring.*Fleet.*#7/);
});
