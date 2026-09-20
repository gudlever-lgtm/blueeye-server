'use strict';

// The Schedules screen, driven in a real DOM.
//
// It answers one question — "what runs automatically, and when next" — and it
// used to answer it badly: a row said "Availability" and nothing else, which is
// four different things in an estate with four applications. And a monitor,
// which carries its own interval rather than a schedule row, appeared nowhere on
// the one screen somebody would look for it, so "where do I schedule a monitor"
// had no findable answer.
//
// The server side is covered by the schedules and monitors API specs. This is
// the other half: that a person can read the screen.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const SA = '/api/service-tests';

const ME = { id: 1, email: 'op@blueeye.local', role: 'admin', preferences: {} };
const BASE_ROUTES = {
  'GET /me': ME,
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': { service_tests: true },
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
};

function recordingFetch(routes, calls) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ method, path: p, body });
    const hit = routes[`${method} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const payload = hit === undefined ? { error: 'Not Found', path: p } : (hit.body !== undefined ? hit.body : hit);
    return {
      ok: status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function boot(t, routes = {}, role = 'admin') {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const calls = [];
  window.fetch = recordingFetch({ ...BASE_ROUTES, ...routes }, calls);
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, errors, calls };
}

const click = async (node, ms) => { node.click(); await tick(ms); };

// Two applications, and a test called "Login" in each — the case a bare name
// cannot tell apart.
const TESTS = [
  { id: 1, application_id: 1, application_name: 'Customer Portal', name: 'Login', description: 'Sign in and land on the dashboard', enabled: true },
  { id: 2, application_id: 2, application_name: 'Partner Portal', name: 'Login', enabled: true },
  { id: 3, application_id: 1, application_name: 'Customer Portal', name: 'Availability', enabled: true },
];

const SCHEDULES = [
  { id: 1, test_id: 3, interval_sec: 86400, timezone: 'Europe/Copenhagen', description: 'Daily', next_run_at: '2026-09-16T17:42:00.000Z', missed_intervals: 0 },
  { id: 2, test_id: 2, interval_sec: 3600, timezone: 'Europe/Copenhagen', description: 'Hourly', next_run_at: '2026-09-15T19:00:00.000Z', missed_intervals: 0 },
];

const MONITORS = [
  {
    id: 7, name: 'Customer mail', type: 'mail', target: 'smtp.example.dk', interval_sec: 900,
    enabled: true, pending: false, activated_at: '2026-09-15T10:00:00.000Z',
    last_run_at: '2026-09-15T17:30:00.000Z', last_status: 'ok', has_secrets: {}, config: {},
  },
  {
    id: 8, name: 'SPF for example.dk', type: 'dns_record', target: 'example.dk', interval_sec: 3600,
    enabled: true, pending: true, activated_at: null,
    last_run_at: null, last_status: null, has_secrets: {}, config: {},
  },
];

const TYPES = {
  types: [
    { type: 'mail', label: 'Mail delivery', category: 'mail', target: 'smtp_host', default_interval_sec: 900, measures: { unit: 'ms', label: 'Delivery time' }, secrets: [], fields: [] },
    { type: 'dns_record', label: 'DNS record', category: 'dns', target: 'domain', default_interval_sec: 3600, measures: { unit: 'ms', label: 'Lookup time' }, secrets: [], fields: [] },
  ],
};

const routes = (over = {}) => ({
  [`GET ${SA}/schedules`]: SCHEDULES,
  [`GET ${SA}/tests`]: TESTS,
  [`GET ${SA}/monitors`]: MONITORS,
  [`GET ${SA}/monitors/types`]: TYPES,
  [`GET ${SA}/schedules/intervals`]: { intervals: [{ seconds: 60, en: 'Every minute', da: 'Hvert minut' }, { seconds: 3600, en: 'Hourly', da: 'Hver time' }] },
  ...over,
});

async function openSchedules(t, over = {}) {
  const ctx = await boot(t, routes(over));
  const nav = ctx.doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="schedules"]');
  assert.ok(nav, 'no Schedules nav button');
  await click(nav, 250);
  return ctx;
}

const rowsOf = (table) => [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()));

test('a scheduled test is named with the application it belongs to', async (t) => {
  const { doc, errors } = await openSchedules(t);
  assert.deepEqual(errors, []);

  const table = doc.querySelector('#view table.data-table');
  assert.ok(table, 'the schedule table did not render');
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  assert.ok(headers.includes('Application'), `no application column: ${headers.join(' | ')}`);

  const rows = rowsOf(table);
  // "Availability" on its own is four different things in a four-application
  // estate; the row now says which one.
  const availability = rows.find((r) => r[0].startsWith('Availability'));
  assert.ok(availability, `no Availability row: ${JSON.stringify(rows)}`);
  assert.equal(availability[1], 'Customer Portal');
  assert.equal(availability[2], 'Daily');

  const partner = rows.find((r) => r[1] === 'Partner Portal');
  assert.ok(partner, 'the Partner Portal schedule lost its application');
  assert.ok(partner[0].startsWith('Login'));
});

test('a test whose application is unknown still lists, rather than vanishing', async (t) => {
  const { doc } = await openSchedules(t, {
    [`GET ${SA}/tests`]: [{ id: 3, name: 'Availability', enabled: true }],
  });
  const rows = rowsOf(doc.querySelector('#view table.data-table'));
  const row = rows.find((r) => r[0].startsWith('Availability'));
  assert.ok(row, 'the row disappeared with its application');
  assert.equal(row[1], '—');
});

test('the monitors are listed with their own interval, and say so', async (t) => {
  const { doc } = await openSchedules(t);
  const tables = [...doc.querySelectorAll('#view table.data-table')];
  assert.equal(tables.length, 2, 'the monitor cadences are not on the screen');

  const text = doc.querySelector('#view').textContent;
  // The screen says out loud that a monitor is not scheduled here, because
  // "where do I schedule a monitor" is the question this table exists to stop.
  assert.match(text, /Monitors run on their own interval/);
  assert.match(text, /not scheduled here/);

  const rows = rowsOf(tables[1]);
  const mail = rows.find((r) => r[0] === 'Customer mail');
  assert.ok(mail, `no mail monitor row: ${JSON.stringify(rows)}`);
  assert.equal(mail[1], 'Mail delivery', 'the type is shown as its raw key rather than its label');
  assert.equal(mail[2], 'smtp.example.dk');
  assert.equal(mail[3], '900 s');

  // A pending monitor has no next run — it is not running yet, and showing a
  // time would promise something that will not happen.
  const dns = rows.find((r) => r[0] === 'SPF for example.dk');
  assert.equal(dns[4], 'Awaiting first check');
});

test('clicking a monitor row opens that monitor', async (t) => {
  const { doc } = await openSchedules(t, {
    [`GET ${SA}/monitors/7`]: { ...MONITORS[0], recent: [], summary: { checks: 0, ok: 0, slow: 0, bad: 0, availability: null, avg_value: null, max_value: null, since: null } },
  });
  const monitorRow = [...doc.querySelectorAll('#view table.data-table')][1].querySelector('tbody tr');
  await click(monitorRow, 250);
  assert.match(doc.querySelector('#view').textContent, /Customer mail/);
  assert.ok(doc.querySelector('#view .sa-actions'), 'the monitor detail did not open');
});

test('the schedule dialog groups the tests by application and names both', async (t) => {
  const { doc } = await openSchedules(t);
  // Not just any button saying "Schedule" — the sub-tab strip has one of those.
  const add = [...doc.querySelectorAll('#view button')].find((b) => b.textContent.trim() === '+ Schedule');
  assert.ok(add, 'no add button');
  await click(add, 200);

  const dialog = doc.querySelector('.sa-modal');
  assert.ok(dialog, 'the dialog did not open');
  const select = dialog.querySelector('select');
  const groups = [...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
  assert.deepEqual(groups, ['Customer Portal', 'Partner Portal'], 'the picker is not grouped by application');

  const options = [...select.querySelectorAll('option')].map((o) => o.textContent.trim());
  // Two tests called "Login" must not be two identical options.
  assert.ok(options.includes('Customer Portal — Login'), options.join(' | '));
  assert.ok(options.includes('Partner Portal — Login'), options.join(' | '));
  assert.equal(new Set(options).size, options.length, 'two options read identically');
});

test('with no monitors at all, the screen is the schedule table and nothing else', async (t) => {
  const { doc, errors } = await openSchedules(t, { [`GET ${SA}/monitors`]: [] });
  assert.deepEqual(errors, []);
  assert.equal(doc.querySelectorAll('#view table.data-table').length, 1);
});

test('a monitors endpoint that fails leaves the schedules readable', async (t) => {
  // A viewer on an unlicensed-for-monitors install, or a 500: the screen this
  // spec is about is the SCHEDULES, and it must not go blank over a second list.
  const { doc, errors } = await openSchedules(t, { [`GET ${SA}/monitors`]: { status: 500, body: { error: 'boom' } } });
  assert.deepEqual(errors, []);
  const table = doc.querySelector('#view table.data-table');
  assert.ok(table, 'the schedule table vanished with the monitors');
  assert.ok(rowsOf(table).length >= 1);
});
