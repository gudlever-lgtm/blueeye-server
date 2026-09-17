'use strict';

// The Connection test screen, driven the way a person drives it: type an
// address, open the list, clear a check, press Run, press Stop, save a Repeat.
//
// Same harness as diagnoseView/dashboardSmoke — jsdom's fetch wired into the
// real Express app — so what is asserted is the whole path: the catalogue the
// server serves, the dispatch it accepts, and the package it writes.

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

function appWith({ sent = [], packages = [], sendCommand = null, probeRows = [] } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => AGENTS,
      findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
    }),
    agentCommander: { sendCommand: sendCommand || ((id, cmd) => { sent.push(cmd); return 1; }) },
    testPackagesRepo: makeTestPackagesRepo({
      create: async (p) => { const row = { id: packages.length + 1, ...p }; packages.push(row); return row; },
    }),
    probeResultsRepo: { latestByAgent: async () => probeRows, findByAgent: async () => [] },
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
    if (s.startsWith('/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(250);
  return { window, doc: window.document, errors };
}

const byText = (doc, sel, re) => [...doc.querySelectorAll(sel)].find((e) => re.test(e.textContent || ''));

// Probes & Tests → the Connection test sub-tab.
async function open(doc) {
  doc.querySelector('.tabs button[data-view="probes"]').click();
  await tick(250);
  const tab = byText(doc, '.subtabs button', /Connection test/);
  assert.ok(tab, 'no Connection test sub-tab');
  tab.click();
  await tick(300);
  return tab;
}

const setTarget = async (doc, host) => {
  const input = doc.querySelector('.connection-test .ct-target input');
  input.value = host;
  input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick(200);
  return input;
};

test('the sub-tab opens a form with a target field and the three buttons', async (t) => {
  const { doc, errors } = await boot(t);
  await open(doc);
  const view = doc.querySelector('.connection-test');
  assert.ok(view, 'the connection test view did not render');
  assert.ok(doc.querySelector('.connection-test .ct-target input').placeholder.includes('DNS'));
  assert.ok(doc.querySelector('.run-btn .run-count'), 'the run count is not inside the Run button');
  assert.equal(doc.querySelector('.run-btn .run-count').value, '1', 'the run count does not default to 1');
  assert.ok(byText(doc, '.ct-actions button', /^Stop$/), 'no Stop button');
  assert.ok(byText(doc, '.ct-actions button', /^Repeat$/), 'no Repeat button');
  assert.equal(byText(doc, '.ct-actions button', /^Stop$/).disabled, true, 'Stop is live before anything runs');
  assert.deepEqual(errors, []);
});

test('the arrow discloses the check list: everything runnable is on by default', async (t) => {
  const { doc } = await boot(t);
  await open(doc);
  const toggle = doc.querySelector('.ct-toggle');
  assert.equal(doc.querySelector('.ct-list').hidden, true, 'the list starts open');
  toggle.click();
  await tick(100);
  assert.equal(doc.querySelector('.ct-list').hidden, false);
  const boxes = [...doc.querySelectorAll('.ct-row input[type=checkbox]')];
  assert.ok(boxes.length >= 9, `only ${boxes.length} checks listed`);
  const runnable = boxes.filter((b) => !b.disabled);
  assert.ok(runnable.every((b) => b.checked), 'a runnable check was not selected by default');
  // Everything in the catalogue can run against a hostname now that the agent
  // has the TLS and reverse-DNS probes (0.27), so nothing is blocked here — the
  // blocked case is the target-specific one, covered by the IP test below.
  assert.deepEqual([...doc.querySelectorAll('.ct-row.blocked')], []);
  assert.match(doc.querySelector('.ct-toggle-row .muted').textContent, /of \d+ selected$/);
});

test('an IP target greys out the DNS lookup, and a name brings it back', async (t) => {
  const { doc } = await boot(t);
  await open(doc);
  doc.querySelector('.ct-toggle').click();
  const dnsRow = () => [...doc.querySelectorAll('.ct-row')].find((r) => /DNS lookup/.test(r.textContent));
  await setTarget(doc, '1.1.1.1');
  assert.ok(dnsRow().classList.contains('blocked'), 'a DNS lookup of an IP literal is still offered');
  assert.match(dnsRow().textContent, /Nothing to look up/);
  await setTarget(doc, 'example.com');
  assert.equal(dnsRow().classList.contains('blocked'), false);
});

test('Run dispatches the selected checks, and a cleared check is not dispatched', async (t) => {
  const sent = [];
  const { doc, errors } = await boot(t, { app: appWith({ sent }) });
  await open(doc);
  doc.querySelector('.ct-toggle').click();
  await setTarget(doc, 'example.com');

  // Clear the path-MTU row; everything else stays on.
  const mtuBox = [...doc.querySelectorAll('.ct-row')].find((r) => /Path MTU/.test(r.textContent)).querySelector('input');
  mtuBox.checked = false;
  mtuBox.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));

  doc.querySelector('.run-btn').click();
  await tick(600);
  assert.ok(sent.length > 0, 'nothing was dispatched');
  assert.ok(sent.every((c) => c.name === 'run-probe'), 'something other than a probe was pushed');
  assert.ok(sent.every((c) => c.probe.host === 'example.com'));
  const types = sent.map((c) => c.probe.type);
  assert.ok(types.includes('ping') && types.includes('dns'), `dispatched: ${types.join(', ')}`);
  assert.ok(!types.includes('path_mtu'), 'a cleared check was dispatched anyway');
  assert.deepEqual(errors, []);
});

test('Run without a target says so and dispatches nothing', async (t) => {
  const sent = [];
  const { doc } = await boot(t, { app: appWith({ sent }) });
  await open(doc);
  doc.querySelector('.run-btn').click();
  await tick(200);
  assert.equal(sent.length, 0);
  assert.match(doc.querySelector('.ct-actions .error').textContent, /Enter an IP address or a DNS name/);
});

test('a disconnected agent is reported, not swallowed', async (t) => {
  const { doc } = await boot(t, { app: appWith({ sendCommand: () => 0 }) });
  await open(doc);
  await setTarget(doc, 'example.com');
  doc.querySelector('.run-btn').click();
  await tick(400);
  assert.match(doc.querySelector('.ct-actions .error').textContent, /not connected/);
});

test('Stop ends the run: the remaining rounds are never sent', async (t) => {
  const sent = [];
  const { doc } = await boot(t, { app: appWith({ sent }) });
  await open(doc);
  await setTarget(doc, 'example.com');
  doc.querySelector('.run-btn .run-count').value = '5';
  doc.querySelector('.run-btn').click();
  await tick(300);
  const afterFirstRound = sent.length;
  assert.ok(afterFirstRound > 0, 'the first round never went out');
  byText(doc, '.ct-actions button', /^Stop$/).click();
  await tick(1200);
  assert.equal(sent.length, afterFirstRound, 'a round was sent after Stop');
  assert.match(doc.querySelector('.ct-actions .muted').textContent, /Stopped/);
});

test('a result that comes back is shown on its own row', async (t) => {
  const rows = [
    { id: 1, type: 'ping', target: 'example.com', ok: 1, rttMs: 12, ts: new Date(Date.now() + 5000).toISOString() },
    { id: 2, type: 'tcp', target: 'example.com:443', ok: 0, ts: new Date(Date.now() + 5000).toISOString() },
  ];
  const { doc } = await boot(t, { app: appWith({ probeRows: rows }) });
  await open(doc);
  await setTarget(doc, 'example.com');
  doc.querySelector('.run-btn').click();
  await tick(3000);
  const row = (re) => [...doc.querySelectorAll('.ct-row')].find((r) => re.test(r.textContent));
  assert.match(row(/Ping/).querySelector('.ct-state').textContent, /12 ms/);
  assert.match(row(/port 443/).querySelector('.ct-state').textContent, /failed/i);
  // The row for port 80 must not borrow the :443 result.
  assert.ok(!/failed/i.test(row(/port 80/).querySelector('.ct-state').textContent), 'the :80 row took the :443 measurement');
});

test('a result row opens its full detail in place, the same renderer the probe tab uses', async (t) => {
  const ts = new Date(Date.now() + 5000).toISOString();
  const rows = [{ id: 1, type: 'ping', target: 'example.com', ok: 1, rttMs: 12, lossPct: 0, ts }];
  const { doc } = await boot(t, { app: appWith({ probeRows: rows }) });
  await open(doc);
  await setTarget(doc, 'example.com');
  doc.querySelector('.run-btn').click();
  await tick(3000);

  const pingRow = [...doc.querySelectorAll('.ct-row')].find((r) => /Ping/.test(r.textContent));
  assert.equal(pingRow.querySelector('.ct-caret').hidden, false, 'a row with a result does not offer to open');
  assert.match(pingRow.getAttribute('title') || '', /Open this result/);
  pingRow.click();
  await tick(400);
  const detail = pingRow.nextSibling;
  assert.equal(detail.hidden, false, 'the detail did not open');
  assert.match(detail.textContent, /RTT history|No history yet/, `detail was: ${detail.textContent.slice(0, 120)}`);
  // One at a time, and clicking again closes it.
  pingRow.click();
  await tick(100);
  assert.equal(detail.hidden, true, 'the detail did not close again');
});

test('a failed check says WHY, in the agent\'s own words, and offers the missing tool', async (t) => {
  const ts = new Date(Date.now() + 5000).toISOString();
  const rows = [
    { id: 1, type: 'traceroute', target: 'example.com', ok: 0, detail: 'traceroute not installed', ts },
    { id: 2, type: 'ping', target: 'example.com', ok: 0, lossPct: 100, ts },
    { id: 3, type: 'tcp', target: 'example.com:80', ok: 0, detail: 'connect ECONNREFUSED 93.184.216.34:80', ts },
  ];
  const { doc } = await boot(t, { app: appWith({ probeRows: rows }) });
  await open(doc);
  await setTarget(doc, 'example.com');
  doc.querySelector('.run-btn').click();
  await tick(3000);
  const row = (re) => [...doc.querySelectorAll('.ct-row')].find((r) => re.test(r.textContent));

  // A missing tool is named in the pill and installable from the row.
  const trace = row(/^Traceroute/m);
  assert.match(trace.querySelector('.ct-state').textContent, /traceroute missing/);
  assert.match(trace.querySelector('.ct-reason').textContent, /traceroute not installed/);
  assert.ok(byText(doc, '.ct-tools button', /Install traceroute/), 'no install button for a missing tool');

  // 100% loss with no words from the agent is the one unambiguous reading.
  assert.match(row(/Ping/).querySelector('.ct-state').textContent, /no reply/);
  assert.match(row(/Ping/).querySelector('.ct-reason').textContent, /100%/);

  // The agent's error is read for the word, and shown in full underneath.
  assert.match(row(/port 80/).querySelector('.ct-state').textContent, /refused/);
  assert.match(row(/port 80/).querySelector('.ct-reason').textContent, /ECONNREFUSED/);
});

test('a skipped check says which kind of skipped it is', async (t) => {
  const { doc, window } = await boot(t);
  await open(doc);
  doc.querySelector('.ct-toggle').click();
  await setTarget(doc, '1.1.1.1');

  const row = (re) => [...doc.querySelectorAll('.ct-row')].find((r) => re.test(r.textContent));
  // Before anything runs: the check this target cannot answer already says so.
  assert.match(row(/DNS lookup/).querySelector('.ct-state').textContent, /n\/a/);
  assert.match(row(/DNS lookup/).querySelector('.ct-reason').textContent, /Nothing to look up/);
  // Reverse DNS is the opposite case — an address is exactly what it wants.
  assert.equal(row(/Reverse DNS/).classList.contains('blocked'), false);

  // A check cleared by hand is a different kind of skipped.
  const mtu = row(/Path MTU/);
  const box = mtu.querySelector('input');
  box.checked = false;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('.run-btn').click();
  await tick(400);
  assert.match(mtu.querySelector('.ct-state').textContent, /not selected/);
  assert.match(mtu.querySelector('.ct-reason').textContent, /Cleared for this run/);
});

test('Repeat saves a recurring test package and says what it saved', async (t) => {
  const packages = [];
  const { doc, window } = await boot(t, { app: appWith({ packages }) });
  await open(doc);
  await setTarget(doc, 'example.com');
  byText(doc, '.ct-actions button', /^Repeat$/).click();
  await tick(150);

  const card = doc.querySelector('#modal-card');
  assert.equal(doc.querySelector('#modal').classList.contains('hidden'), false, 'the repeat dialog did not open');
  const selects = card.querySelectorAll('select');
  const period = selects[0];
  const within = selects[1];
  assert.equal(period.value, 'daily');
  // The within options are rendered as the GAP they produce, per period.
  assert.ok([...within.options].some((o) => /Every 4 hours/.test(o.textContent)), [...within.options].map((o) => o.textContent).join(' | '));
  // Weekly reveals the weekday field and relabels the repetitions.
  period.value = 'weekly';
  period.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(80);
  assert.equal([...card.querySelectorAll('label')].find((l) => /Day of week/.test(l.textContent)).hidden, false);
  assert.ok([...within.options].some((o) => /Once a week/.test(o.textContent)));

  period.value = 'daily';
  period.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(80);
  within.value = '6';
  within.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(50);
  assert.match(card.querySelector('.ct-summary').textContent, /Daily from 08:00 · Every 4 hours · 1 test per run/);

  byText(doc, '#modal-card .form-actions button', /Save repeat/).click();
  await tick(400);
  assert.equal(packages.length, 1, 'no package was created');
  const pkg = packages[0];
  assert.equal(pkg.name, 'Connection test — example.com');
  assert.deepEqual(pkg.schedule_spec, { period: 'daily', every: 6, at: '08:00' });
  assert.deepEqual(pkg.targets, { mode: 'agents', agentIds: [1], locationIds: [] });
  assert.ok(pkg.items.length >= 5, `only ${pkg.items.length} items`);
  assert.equal(doc.querySelector('#modal').classList.contains('hidden'), true, 'the dialog stayed open');
  assert.match(doc.querySelector('.ct-chip').textContent, /Daily from 08:00/);
});

test('a viewer sees the screen but is not offered Repeat', async (t) => {
  const { doc } = await boot(t, { role: 'viewer' });
  await open(doc);
  assert.ok(doc.querySelector('.connection-test'));
  assert.equal(byText(doc, '.ct-actions button', /^Repeat$/), undefined, 'a viewer was offered Repeat');
});

test('the screen is fully translated — no raw keys in either language', async (t) => {
  const { doc, window } = await boot(t);
  await open(doc);
  doc.querySelector('.ct-toggle').click();
  await tick(100);
  const text = () => doc.querySelector('.connection-test').textContent;
  assert.ok(!/\bct\.[a-z]/i.test(text()), `untranslated key on screen: ${text().slice(0, 200)}`);
  window.I18n.setLocale('da');
  doc.querySelector('.tabs button[data-view="probes"]').click();
  await tick(250);
  byText(doc, '.subtabs button', /Forbindelsestest/).click();
  await tick(300);
  doc.querySelector('.ct-toggle').click();
  await tick(100);
  assert.ok(!/\bct\.[a-z]/i.test(text()), 'untranslated key in Danish');
  assert.match(text(), /Kør/, 'the Danish screen still reads English');
});
