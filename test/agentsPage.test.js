'use strict';

// public/views/agents.js — Agents on the UI contract (docs/ui-contract.md).
//
// The migration this pins: nine buttons in a row become one action and a
// grouped ⋯ menu, a hand-rolled sortable table becomes a DataTable, and eight
// columns that overflowed the panel at 1280 become six that do not.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const NOW = Date.now();
const AGENTS = [
  { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01.lan', platform: 'linux', arch: 'amd64', status: 'online', location_name: 'Oslo HQ', last_report_at: new Date(NOW - 60 * 1000).toISOString(), monitor_config: { source: 'sflow' }, capabilities: { agentVersion: '0.42.0', sources: ['proc', 'sflow'], managed: 'systemd' } },
  { id: 8, display_name: null, hostname: 'cph-core-02', platform: 'linux', arch: 'arm64', status: 'online', location_name: 'Copenhagen DC', last_report_at: new Date(NOW - 60 * 60 * 1000).toISOString(), monitor_config: { source: 'snmp', snmp: { host: '10.0.0.3' } }, capabilities: { agentVersion: '0.40.0', sources: ['snmp'], managed: 'systemd' } },
  { id: 9, display_name: 'sto-branch-07', hostname: 'sto-branch-07', platform: 'windows', arch: 'amd64', status: 'offline', location_name: null, last_report_at: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(), monitor_config: { source: 'proc' }, capabilities: { agentVersion: '0.39.0', sources: ['proc'] } },
];

function boot({ t, routes = {}, url = 'http://server.test/agents', role = 'admin' } = {}) {
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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /locations': [{ id: 1, name: 'Oslo HQ' }],
  'GET /agents': AGENTS,
  'GET /system/version': { version: '0.165.0', agent: '0.42.0', agentSource: '0.42.0' },
}, over);

const rows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];
const heads = (doc) => [...doc.querySelectorAll('#view table.dt thead th')].map((h) => h.textContent.replace(/[↕↑↓]/g, '').trim());
const cells = (tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
const headBtns = (doc) => [...doc.querySelectorAll('#view .page-head button')];
const menu = (doc) => [...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent);

test('Agents is a ListPage with a Toolbar and one primary', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'), 'the page is not on the contract');
  assert.match(doc.querySelector('#view .page-head h1').textContent, /Agents/);
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .page-head .btn-primary').length, 1, 'more than one primary');
  assert.ok(doc.querySelector('#view .toolbar-ui'), 'the search is not a Toolbar');
  assert.equal(doc.querySelectorAll('#view .table-toolbar, #view .section-head').length, 0,
    'the old heading and toolbar survived');
  assert.equal(rows(doc).length, 3);
});

test('six columns, and none of them a second copy of another', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // Status went: Health is derived from it — `status !== 'online'` IS `down` —
  // so the two columns said the same thing, one of them less precisely. ID went
  // with it: the row opens the agent, and the id is in that address.
  assert.deepEqual(heads(doc), ['Agent', 'Version', 'Health', 'Source', 'Location', 'Last reported', '']);
});

test('health is derived from the last report, not from the socket alone', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // The Health cell, not just the row's first badge — the version cell carries
  // one too.
  const by = {};
  for (const tr of rows(doc)) by[cells(tr)[0]] = tr.querySelectorAll('td')[2].textContent.trim();
  // Online and fresh; online but an hour stale; offline.
  assert.equal(by['oslo-edge-01'], 'healthy');
  assert.equal(by['cph-core-02'], 'delayed', 'an agent that is connected but has gone quiet reads as fine');
  assert.equal(by['sto-branch-07'], 'down');
});

test('an agent with no display name is listed by its hostname', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(rows(doc).some((tr) => cells(tr)[0] === 'cph-core-02'));
});

test('the version column says whether an update is one click or an installer job', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  const ver = {};
  for (const tr of rows(doc)) ver[cells(tr)[0]] = cells(tr)[1];
  assert.equal(ver['oslo-edge-01'], 'v0.42.0', 'an up-to-date agent is badged anyway');
  assert.match(ver['cph-core-02'], /v0\.40\.0\s*update/);
  // A systemd agent's badge is amber — something here will do it. Checked via
  // the tone rather than the word, which is translated.
  const behind = rows(doc).find((tr) => cells(tr)[0] === 'cph-core-02');
  assert.ok([...behind.querySelectorAll('.badge-ui')].some((b) => b.classList.contains('warn')));
});

test('an installer-only agent behind the build gets a grey badge, not an amber one', async (t) => {
  const unmanaged = Object.assign({}, AGENTS[1], {
    id: 20, display_name: 'docker-01', platform: 'linux',
    capabilities: { agentVersion: '0.30.0', sources: ['proc'], managed: 'docker' },
  });
  const { doc } = boot({ t, routes: SESSION({ 'GET /agents': [unmanaged] }) });
  await settle();
  const badge = rows(doc)[0].querySelectorAll('td')[1].querySelector('.badge-ui');
  assert.ok(badge.classList.contains('neutral'),
    'an agent nothing here can update is flagged as if one click would fix it');
});

test('nine row buttons become one action and a grouped menu', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  // oslo-edge-01 is on sflow and up to date, so its menu is the full read set
  // plus Edit and the plain rebuild.
  const act = rows(doc).find((tr) => cells(tr)[0] === 'oslo-edge-01').querySelector('.row-act');
  assert.equal(act.querySelectorAll('button').length, 2, 'the row still carries a stack of buttons');
  assert.match(act.querySelector('button.on-hover').textContent, /Run test/);
  assert.equal(doc.querySelectorAll('#view .row-actions').length, 0, 'the old button row survived');

  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  // The checks that only look, then the ones that change something, then Delete.
  assert.deepEqual(menu(doc), [
    'Traffic', 'Flows', 'Why online / offline', 'Ping', 'Flow-pipeline self-check', 'Speed test',
    'Edit', 'Rebuild from the server source', 'Delete agent',
  ]);
  const items = [...doc.querySelectorAll('.ui-rowmenu button')];
  assert.ok(items[items.length - 1].classList.contains('danger'), 'Delete is not marked destructive');
  assert.equal(doc.querySelectorAll('.ui-rowmenu hr').length, 2, 'the menu is one undifferentiated run');
});

test('Flows is offered only to an agent that has them', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  // sto-branch-07 is on `proc`, so a flows panel would have nothing to show.
  const proc = rows(doc).find((tr) => cells(tr)[0] === 'sto-branch-07');
  proc.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.ok(!menu(doc).includes('Flows'));
});

test('a viewer is offered no action that changes anything', async (t) => {
  const { doc, window } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  assert.equal(headBtns(doc).filter((b) => /New agent|Update outdated/.test(b.textContent)).length, 0);
  const act = rows(doc).find((tr) => cells(tr)[0] === 'oslo-edge-01').querySelector('.row-act');
  assert.equal(act.querySelectorAll('button.on-hover').length, 0, 'a viewer is offered Run test');
  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(menu(doc), ['Traffic', 'Flows', 'Why online / offline', 'Ping', 'Flow-pipeline self-check', 'Speed test']);
});

test('"Update outdated" counts only the agents it can actually update', async (t) => {
  const { doc } = boot({ t, routes: SESSION() });
  await settle();
  // cph-core-02 is systemd and behind. sto-branch-07 is behind too, but Windows
  // — a bulk rebuild would just be declined, so it is not counted.
  const btn = headBtns(doc).find((b) => /Update outdated/.test(b.textContent));
  assert.ok(btn, 'nothing offered to update the stragglers');
  assert.match(btn.textContent, /\(1\)/);
});

test('the table sorts itself instead of rewriting its own headers', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const th = (label) => [...doc.querySelectorAll('#view table.dt thead th')]
    .find((h) => h.textContent.replace(/[↕↑↓]/g, '').trim() === label);
  // Default: by name, ascending.
  assert.equal(th('Agent').getAttribute('aria-sort'), 'ascending');
  assert.deepEqual(rows(doc).map((tr) => cells(tr)[0]), ['cph-core-02', 'oslo-edge-01', 'sto-branch-07']);

  th('Health').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(50);
  // healthy < delayed < down, so ascending puts the working ones first.
  assert.deepEqual(rows(doc).map((tr) => cells(tr)[0]), ['oslo-edge-01', 'cph-core-02', 'sto-branch-07']);
  assert.equal(th('Health').getAttribute('aria-sort'), 'ascending');
  assert.equal(th('Agent').getAttribute('aria-sort'), null, 'two columns claim to be the sort');

  th('Health').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(50);
  assert.deepEqual(rows(doc).map((tr) => cells(tr)[0]), ['sto-branch-07', 'cph-core-02', 'oslo-edge-01']);
  assert.equal(th('Health').getAttribute('aria-sort'), 'descending');
});

test('sorting by version puts the stragglers first', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  [...doc.querySelectorAll('#view table.dt thead th')]
    .find((h) => /Version/.test(h.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(50);
  // The reason to sort by version is to find what is behind, so behind sorts
  // first regardless of the version string.
  assert.deepEqual(rows(doc).map((tr) => cells(tr)[0]).slice(0, 2), ['sto-branch-07', 'cph-core-02']);
});

test('the filter matches the platform even though it is not a column', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const q = doc.querySelector('#view .toolbar-ui input[type=search]');
  q.value = 'windows';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(50);
  assert.deepEqual(rows(doc).map((tr) => cells(tr)[0]), ['sto-branch-07']);
  assert.match(doc.querySelector('#view .panel-head .meta-xs').textContent, /1 of 3/);
  // …and the caret stays where it was, because the field is not rebuilt.
  assert.equal(doc.querySelector('#view .toolbar-ui input[type=search]'), q);
});

test('an empty estate and a filter that matches nothing are different', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const q = doc.querySelector('#view .toolbar-ui input[type=search]');
  q.value = 'zzzz';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(50);
  let state = doc.querySelector('#view .state');
  assert.match(state.textContent, /No agents match/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /Clear/.test(b.textContent)));

  const bare = boot({ t, routes: SESSION({ 'GET /agents': [] }) });
  await settle();
  state = bare.doc.querySelector('#view .state');
  assert.match(state.textContent, /No agents yet/);
  assert.ok([...state.querySelectorAll('button')].some((b) => /New agent/.test(b.textContent)),
    'an empty estate offers no way to fill it');
  assert.equal(bare.doc.querySelectorAll('#view .empty').length, 0, 'the old grey sentence survived');
});

test('the row opens the agent', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /agents/7': AGENTS[0] }) });
  await settle();
  rows(doc).find((tr) => cells(tr)[0] === 'oslo-edge-01')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/agents/7');
});

test('a 500 is an ErrorState naming the call, with a Retry', async (t) => {
  const { doc, errors, window, log } = boot({
    t, routes: SESSION({ 'GET /agents': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .page-head h1'), 'the page went down with the load');
  assert.ok(doc.querySelector('.sidebar'), 'the shell did not survive');
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a failed load is not an ErrorState');
  assert.match(err.textContent, /boom/);
  assert.match(err.querySelector('code').textContent, /GET \/agents/);

  const before = log.filter((x) => x.key === 'GET /agents').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /agents').length > before, 'Retry did not retry');
});

test('a 404 on the list is reported, not drawn as an empty estate', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION({ 'GET /agents': undefined }) });
  await settle();
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'a 404 was drawn as "no agents yet"');
  assert.match(err.textContent, /Not Found|404/i);
});

test('a 500 on the served version costs the update badges, never the list', async (t) => {
  const { doc, errors } = boot({
    t, routes: SESSION({ 'GET /system/version': { status: 500, body: { error: 'boom' } } }),
  });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(rows(doc).length, 3, 'the agents went with the version lookup');
  // With nothing to compare against, nothing is claimed to be behind.
  assert.equal(doc.querySelectorAll('#view table.dt .badge-ui.warn.is-update').length, 0);
});

// The dead-agent vs network-down verdict (src/health/agentOfflineMonitor.js)
// rides on the agent.offline finding; the connection modal of an OFFLINE agent
// reads it and shows it next to the connection diagnosis.
test('"Why online / offline" on an offline agent shows the offline verdict and its checks', async (t) => {
  const finding = {
    id: 'f1', hostId: '9', metric: 'agent.offline', createdAt: new Date(NOW).toISOString(),
    evidence: [{
      verdict: 'switch_port_down', confidence: 'high', offlineSince: new Date(NOW - 10 * 60 * 1000).toISOString(),
      checks: [{ check: 'switch_port', result: 'down', detail: 'Switch port sw-a/Gi1/0/7 is down.' }],
    }],
  };
  const { doc, window, log } = boot({
    t,
    routes: SESSION({
      'GET /agents/9/connection': { connected: false, state: 'unreachable', explanation: 'The agent has been offline.', hints: [], evidence: [] },
      'GET /api/findings': [finding],
    }),
  });
  await settle();
  const act = rows(doc).find((tr) => cells(tr)[0] === 'sto-branch-07').querySelector('.row-act');
  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => b.textContent === 'Why online / offline').click();
  await settle();
  const q = log.find((l) => l.key === 'GET /api/findings');
  assert.ok(q, 'the offline finding was never asked for');
  assert.match(q.url, /hostId=9/);
  assert.match(q.url, /metric=agent\.offline/);
  const text = doc.querySelector('#modal-card').textContent;
  assert.match(text, /Why is it offline\?/);
  assert.match(text, /The switch port the host is plugged into is down/);
  assert.match(text, /strong evidence/);
  assert.match(text, /Switch port: Switch port sw-a\/Gi1\/0\/7 is down\./);
});

test('a connected agent\'s modal does not look for an offline verdict', async (t) => {
  const { doc, window, log } = boot({
    t,
    routes: SESSION({ 'GET /agents/7/connection': { connected: true, state: 'connected', explanation: 'Live.', hints: [], evidence: [] } }),
  });
  await settle();
  const act = rows(doc).find((tr) => cells(tr)[0] === 'oslo-edge-01').querySelector('.row-act');
  act.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => b.textContent === 'Why online / offline').click();
  await settle();
  assert.ok(!log.some((l) => l.key === 'GET /api/findings'));
  assert.doesNotMatch(doc.querySelector('#modal-card').textContent, /Why is it offline/);
});
