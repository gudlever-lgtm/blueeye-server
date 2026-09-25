'use strict';

// The Repeat dialog and the run controls, on the three screens that grew them
// alongside the Connection test: the test-package editor (a calendar schedule
// instead of only an interval), the Run-a-probe tab (rounds · Stop · Repeat)
// and the per-agent speed test (Repeat).
//
// Same harness as the other view suites — jsdom's fetch wired into the real
// Express app — so a saved schedule is one the server actually accepted.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');

const { makeApp, tokenFor, makeAgentsRepo, makeTestPackagesRepo } = require('../test-support/fakes');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const AGENTS = [{ id: 1, hostname: 'probe-01', display_name: 'probe-01', status: 'online', capabilities: {}, meta: {}, monitor_config: {} }];

function appWith({ sent = [], packages = [], existing = [] } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => AGENTS,
      findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
    }),
    agentCommander: { sendCommand: (id, cmd) => { sent.push(cmd); return 1; } },
    testPackagesRepo: makeTestPackagesRepo({
      findAll: async () => existing,
      findById: async (id) => existing.find((p) => p.id === Number(id)) || null,
      create: async (p) => { const row = { id: packages.length + 100, ...p }; packages.push(row); return row; },
      update: async (id, p) => { packages.push({ id, ...p }); return { id, ...p }; },
    }),
    probeResultsRepo: { latestByAgent: async () => [], findByAgent: async () => [], fleetHealth: async () => [] },
    speedtestResultsRepo: { findByAgent: async () => [], latestPerAgent: async () => [], create: async () => 1 },
  });
}

async function boot(t, { role = 'operator', app = appWith() } = {}) {
  const token = tokenFor(role, { id: 1, email: 'op@blueeye.local' });
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    let req = request(app)[method.toLowerCase()](String(url)).set('Authorization', `Bearer ${token}`);
    if (opts.body) req = req.set('Content-Type', 'application/json').send(JSON.parse(opts.body));
    const res = await req;
    return {
      ok: res.status < 300,
      status: res.status,
      headers: { get: (h) => res.headers[String(h).toLowerCase()] },
      json: async () => res.body,
      text: async () => res.text,
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', token);
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(250);
  return { window, doc: window.document, errors };
}

const byText = (doc, sel, re) => [...doc.querySelectorAll(sel)].find((e) => re.test(e.textContent || ''));
const fire = (window, node, type = 'change') => node.dispatchEvent(new window.Event(type, { bubbles: true }));

async function openProbes(doc, subtab) {
  doc.querySelector('.tabs button[data-view="probes"]').click();
  await tick(250);
  if (subtab) { byText(doc, '.subtabs button', subtab).click(); await tick(300); }
}

// ---------------------------------------------------------------- packages
test('the test-package editor can schedule on the calendar, not only on an interval', async (t) => {
  const packages = [];
  const { doc, window } = await boot(t, { app: appWith({ packages }) });
  await openProbes(doc, /Test packages/);
  byText(doc, 'button', /New test package/).click();
  await tick(150);

  const card = doc.querySelector('#modal-card');
  const scheduleSel = [...card.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'calendar'));
  assert.ok(scheduleSel, 'the schedule select does not offer a calendar');
  assert.equal(card.querySelector('.pkg-recurrence').hidden, true, 'the recurrence fields are shown for an interval schedule');

  scheduleSel.value = 'calendar';
  fire(window, scheduleSel);
  await tick(80);
  assert.equal(card.querySelector('.pkg-recurrence').hidden, false, 'choosing the calendar did not reveal the fields');

  const periodSel = card.querySelector('.repeat-fields select');
  periodSel.value = 'weekly';
  fire(window, periodSel);
  await tick(80);
  const weekday = [...card.querySelectorAll('.repeat-fields label')].find((l) => /Day of week/.test(l.textContent));
  assert.equal(weekday.hidden, false, 'a weekly schedule does not ask which day');

  // Name it, give it one test, and save.
  card.querySelector('input[type=text]').value = 'Weekly reachability';
  byText(doc, '#modal-card button', /Custom test/).click();
  await tick(80);
  const hostInput = [...card.querySelectorAll('.tc-list input[type=text]')][0];
  assert.ok(hostInput, 'no test row to fill in');
  hostInput.value = '1.1.1.1';
  byText(doc, '#modal-card .form-actions button', /^Create$/).click();
  await tick(400);

  assert.equal(packages.length, 1, `no package was saved (${JSON.stringify(packages)})`);
  assert.equal(packages[0].schedule_ms, 0, 'a calendar schedule must not leave an interval running beside it');
  assert.equal(packages[0].schedule_spec.period, 'weekly');
  assert.ok(packages[0].schedule_spec.weekday >= 1 && packages[0].schedule_spec.weekday <= 7);
});

test('the Schedule column reads a calendar recurrence back in words', async (t) => {
  const existing = [{
    id: 4, name: 'Weekly reachability', enabled: true, schedule_ms: 0,
    schedule_spec: { period: 'weekly', every: 1, at: '07:30', weekday: 1 },
    targets: { mode: 'all', agentIds: [], locationIds: [] },
    items: [{ type: 'probe', probe: { type: 'ping', host: '1.1.1.1' } }],
  }];
  const { doc } = await boot(t, { app: appWith({ existing }) });
  await openProbes(doc, /Test packages/);
  const row = doc.querySelector('.tests-table tbody tr');
  assert.ok(row, 'no package row');
  assert.match(row.textContent, /Monday at 07:30/);
});

// ---------------------------------------------------------------- probe tab
test('Run-a-probe repeats the probe for as many rounds as asked, and Stop ends it', async (t) => {
  const sent = [];
  const { doc } = await boot(t, { app: appWith({ sent }) });
  await openProbes(doc);
  const view = doc.querySelector('.probes');
  view.querySelector('.history-controls input[type=text]').value = '1.1.1.1';
  const rounds = doc.querySelector('.run-btn .run-count');
  assert.ok(rounds, 'the probe tab has no round count');
  rounds.value = '3';
  doc.querySelector('.run-btn').click();
  await tick(300);
  assert.equal(sent.length, 1, 'rounds are fired back to back rather than spaced');
  byText(doc, '.probes button', /^Stop$/).click();
  await tick(3600);
  assert.equal(sent.length, 1, 'a round was dispatched after Stop');
  assert.match(doc.querySelector('.probes .probe-status').textContent, /Stopped/);
});

test('Run-a-probe: Repeat saves the probe on screen as a scheduled package', async (t) => {
  const packages = [];
  const { doc, window } = await boot(t, { app: appWith({ packages }) });
  await openProbes(doc);
  doc.querySelector('.probes .history-controls input[type=text]').value = 'example.com';
  byText(doc, '.probes button', /^Repeat$/).click();
  await tick(150);

  const card = doc.querySelector('#modal-card');
  assert.match(card.querySelector('h3').textContent, /ping to example\.com/);
  const periodSel = card.querySelector('.repeat-fields select');
  periodSel.value = 'hourly';
  fire(window, periodSel);
  await tick(80);
  // An hourly period has no time of day — the hour is the period.
  const at = [...card.querySelectorAll('.repeat-fields label')].find((l) => /^Time/.test(l.textContent));
  assert.equal(at.hidden, true);
  byText(doc, '#modal-card .form-actions button', /Save repeat/).click();
  await tick(400);

  assert.equal(packages.length, 1, 'no package was saved');
  const pkg = packages[0];
  assert.equal(pkg.schedule_spec.period, 'hourly');
  assert.equal(pkg.schedule_spec.at, null, 'an hourly recurrence must not carry a time of day');
  assert.deepEqual(pkg.targets, { mode: 'agents', agentIds: [1], locationIds: [] });
  assert.equal(pkg.items.length, 1);
  assert.deepEqual(pkg.items[0].probe.type, 'ping');
  assert.equal(pkg.items[0].probe.host, 'example.com');
  assert.match(doc.querySelector('.probes .ct-chip').textContent, /Every hour/);
});

test('Run-a-probe: Repeat refuses to schedule a probe with no target', async (t) => {
  const packages = [];
  const { doc } = await boot(t, { app: appWith({ packages }) });
  await openProbes(doc);
  byText(doc, '.probes button', /^Repeat$/).click();
  await tick(150);
  assert.equal(doc.querySelector('#modal').classList.contains('hidden'), true, 'the dialog opened for an empty target');
  assert.match(doc.querySelector('.probes .probe-status').textContent, /Enter a target/);
  assert.equal(packages.length, 0);
});

test('a viewer gets neither Repeat nor a round count on the probe tab', async (t) => {
  const { doc } = await boot(t, { role: 'viewer' });
  await openProbes(doc);
  assert.equal(byText(doc, '.probes button', /^Repeat$/), undefined);
});

// ---------------------------------------------------------------- speed test
test('the speed-test dialog can put the same test on a schedule', async (t) => {
  const packages = [];
  const { doc } = await boot(t, { app: appWith({ packages }) });
  // The agent list is the Fleet screen's Drift column set
  // (docs/fleet-and-sites-consolidation.md).
  doc.querySelector('.tabs button[data-view="fleet"]').click();
  await tick(300);
  byText(doc, '#view .subtabs button', /^Drift$/).dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  await tick(300);
  // The speed test is a ⋯ menu entry, with the other per-agent checks.
  doc.querySelector('#view .row-act [aria-haspopup="menu"]')
    .dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  const speedBtn = byText(doc, '.ui-rowmenu button', /^Speed test$/);
  assert.ok(speedBtn, 'no speed-test entry on the agents page');
  speedBtn.click();
  await tick(300);
  byText(doc, '#modal-card button', /^Repeat$/).click();
  await tick(150);
  assert.match(doc.querySelector('#modal-card h3').textContent, /Speed test · probe-01/);
  byText(doc, '#modal-card .form-actions button', /Save repeat/).click();
  await tick(400);
  assert.equal(packages.length, 1, 'no package was saved');
  assert.deepEqual(packages[0].items, [{ type: 'speedtest' }]);
  assert.equal(packages[0].schedule_spec.period, 'daily');
});

// ---------------------------------------------------------------- scheduled reports
test('Reporting → Scheduled reports creates a mailed, recurring report', async (t) => {
  const created = [];
  const app = makeApp({
    reportSchedulesRepo: require('../test-support/fakes').makeReportSchedulesRepo({
      findAll: async () => created.map((c, i) => ({ id: i + 1, last_run_at: null, last_run_status: null, ...c })),
      create: async (r) => { created.push(r); return { id: created.length, ...r }; },
    }),
  });
  const { doc, window } = await boot(t, { role: 'admin', app });
  doc.querySelector('.tabs button[data-view="reporting"]').click();
  await tick(300);
  byText(doc, '[role="tablist"][aria-label="Reporting"] .subtab', /Scheduled reports/).click();
  await tick(300);
  assert.ok(doc.querySelector('.rs'), 'the scheduled-reports panel did not render');

  byText(doc, '.rs button', /New schedule/).click();
  await tick(150);
  const card = doc.querySelector('#modal-card');
  card.querySelector('input[type=text]').value = 'Monthly SLA';
  card.querySelector('textarea').value = 'service@customer.dk\nops@acme.dk';
  const [reportSel, formatSel] = card.querySelectorAll('select');
  reportSel.value = 'probe_outages';
  fire(window, reportSel);
  await tick(80);
  // The severity filter belongs to the outage report and only appears with it.
  const severity = [...card.querySelectorAll('label')].find((l) => /^Severity/.test(l.textContent));
  assert.equal(severity.hidden, false);
  reportSel.value = 'availability';
  fire(window, reportSel);
  await tick(80);
  assert.equal(severity.hidden, true, 'a severity filter is offered for a report that has no severity');
  formatSel.value = 'csv';

  const periodSel = card.querySelector('.repeat-fields select');
  periodSel.value = 'monthly';
  fire(window, periodSel);
  await tick(80);
  byText(doc, '#modal-card .form-actions button', /^Save$/).click();
  await tick(400);

  assert.equal(created.length, 1, 'no schedule was created');
  assert.equal(created[0].name, 'Monthly SLA');
  assert.equal(created[0].report, 'availability');
  assert.deepEqual(created[0].recipients, ['service@customer.dk', 'ops@acme.dk']);
  assert.equal(created[0].schedule_spec.period, 'monthly');
  assert.equal(created[0].window_days, 7);
});

test('a scheduled report that has been failing says so in its row', async (t) => {
  const rows = [{
    id: 1, name: 'Monthly SLA', report: 'availability', format: 'csv', window_days: 30,
    params: {}, recipients: ['a@b.dk'], schedule_spec: { period: 'monthly', every: 1, at: '06:00', dayOfMonth: 1 },
    enabled: true, last_run_at: '2026-09-01T06:00:00.000Z', last_run_status: 'failed — mail failed: connect ECONNREFUSED',
  }];
  const app = makeApp({
    reportSchedulesRepo: require('../test-support/fakes').makeReportSchedulesRepo({ findAll: async () => rows }),
  });
  const { doc } = await boot(t, { role: 'admin', app });
  doc.querySelector('.tabs button[data-view="reporting"]').click();
  await tick(300);
  byText(doc, '[role="tablist"][aria-label="Reporting"] .subtab', /Scheduled reports/).click();
  await tick(300);
  const row = doc.querySelector('.rs-table tbody tr');
  assert.ok(row, 'no schedule row');
  assert.match(row.textContent, /Day 1 at 06:00/);
  assert.match(row.textContent, /ECONNREFUSED/);
  assert.ok(row.querySelector('.error'), 'a failing schedule is not marked as failing');
});

test('a viewer may read the schedules but is offered neither New nor Delete', async (t) => {
  const rows = [{
    id: 1, name: 'Monthly SLA', report: 'availability', format: 'csv', window_days: 30, params: {},
    recipients: ['a@b.dk'], schedule_spec: { period: 'monthly', every: 1, at: '06:00', dayOfMonth: 1 },
    enabled: true, last_run_at: null, last_run_status: null,
  }];
  const app = makeApp({
    reportSchedulesRepo: require('../test-support/fakes').makeReportSchedulesRepo({ findAll: async () => rows }),
  });
  const { doc } = await boot(t, { role: 'viewer', app });
  doc.querySelector('.tabs button[data-view="reporting"]').click();
  await tick(300);
  byText(doc, '[role="tablist"][aria-label="Reporting"] .subtab', /Scheduled reports/).click();
  await tick(300);
  assert.ok(doc.querySelector('.rs-table'), 'a viewer must still see the schedules');
  assert.equal(byText(doc, '.rs button', /New schedule/), undefined);
  assert.equal(byText(doc, '.rs button', /^Delete$/), undefined);
  assert.equal(byText(doc, '.rs button', /Send now/), undefined, 'a viewer was offered Send now');
});
