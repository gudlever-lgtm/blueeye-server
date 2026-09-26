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
// Waits for a condition instead of a fixed pause: the dashboard loads more
// scripts than it used to, and under a loaded CI runner a fixed 250-300 ms was
// not always enough for the view to render. Polls up to `ms`, then returns.
async function until(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (pred()) return true; } catch { /* not there yet */ }
    await tick(25); // eslint-disable-line no-await-in-loop
  }
  return false;
}

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
    if (s.startsWith('/') && !s.startsWith('/vendor/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(250);
  return { window, doc: window.document, errors };
}

const byText = (doc, sel, re) => [...doc.querySelectorAll(sel)].find((e) => re.test(e.textContent || ''));

// Probes & Tests → the Connection test sub-tab.
async function open(doc) {
  await until(() => doc.querySelector('.tabs button[data-view="probes"]'));
  doc.querySelector('.tabs button[data-view="probes"]').click();
  await until(() => byText(doc, '.subtabs button', /Connection test/));
  const tab = byText(doc, '.subtabs button', /Connection test/);
  assert.ok(tab, 'no Connection test sub-tab');
  tab.click();
  await until(() => doc.querySelector('.connection-test .ct-target input') && doc.querySelector('.ct-actions button'));
  await tick(50);
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
  // Every dispatched check addresses the destination that was typed. The http
  // check is the one that addresses the SERVICE rather than the address, so it
  // carries a URL — the same destination, said the way an http probe needs it.
  assert.ok(sent.every((c) => c.probe.host === 'example.com' || c.probe.url === 'https://example.com/'),
    `dispatched to: ${sent.map((c) => c.probe.host || c.probe.url).join(', ')}`);
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

// ----------------------------------------------------------------- the ladder

// A destination that answers ping and drops TCP/443 — the case the ladder
// exists for. Shaped the way probe_results hands rows to the screen.
const FILTERED_ROWS = [
  { id: 1, type: 'dns', target: 'example.com', ok: true, rttMs: 7, ts: new Date().toISOString() },
  { id: 2, type: 'ping', target: 'example.com', ok: true, lossPct: 0, rttMs: 12, ts: new Date().toISOString() },
  { id: 3, type: 'tcp', target: 'example.com:443', ok: false, failure: 'timeout', ts: new Date().toISOString() },
  { id: 4, type: 'tcp', target: 'example.com:80', ok: true, rttMs: 9, ts: new Date().toISOString() },
  { id: 5, type: 'traceroute', target: 'example.com', ok: true, ts: new Date().toISOString(), hops: [{ hop: 1, ip: '10.0.0.1', lossPct: 0 }, { hop: 2, ip: '93.184.216.34', lossPct: 0 }] },
];

test('an operator can say what is wrong and get the rung it stops at', async (t) => {
  const sent = [];
  const { doc, errors } = await boot(t, { app: appWith({ sent, probeRows: FILTERED_ROWS }) });
  await open(doc);
  await setTarget(doc, 'example.com');

  const symptom = doc.querySelector('.connection-test .ct-symptom');
  assert.ok(symptom, 'no symptom field');
  symptom.value = 'the site loads for nobody since this morning';

  const btn = byText(doc, '.ct-symptom-row button', /Find where it stops/);
  assert.ok(btn, 'no ladder button');
  btn.click();

  // The whole catalogue goes out, not a selection. (The panel itself may
  // already be on screen: typing a target renders whatever was last measured,
  // so waiting on the panel would not prove the dispatch happened.)
  assert.ok(await until(() => sent.length >= 9, 20000), `only ${sent.length} checks dispatched`);
  assert.ok(sent.every((c) => c.name === 'run-probe'));

  const ok = await until(() => !doc.querySelector('.ct-ladder').hidden && doc.querySelector('.ct-verdict'), 20000);
  assert.ok(ok, 'the ladder panel never rendered');

  const verdict = doc.querySelector('.ct-verdict');
  assert.ok(verdict.classList.contains('stops'), `verdict was ${verdict.className}`);
  assert.match(verdict.textContent, /stops here/i);
  assert.match(verdict.textContent, /firewall/i);
  // The operator's own words come back next to the answer.
  assert.match(verdict.textContent, /the site loads for nobody since this morning/);

  const rungs = [...doc.querySelectorAll('.ct-rung')];
  assert.equal(rungs.length, 8, `${rungs.length} rungs rendered`);
  const firewall = rungs.find((r) => /Firewall/.test(r.textContent));
  assert.ok(firewall.classList.contains('failed'), 'the firewall rung is not the one marked');
  // Every rung says why, on the rung.
  for (const r of rungs) assert.ok(r.querySelector('.ct-rung-because').textContent.length > 10, r.textContent);
  // The rung above the break is not green.
  assert.ok(rungs.find((r) => /TCP handshake/.test(r.textContent)).classList.contains('unreached'));

  assert.deepEqual(errors, []);
});

test('a viewer reads the verdict but is offered nothing that dispatches', async (t) => {
  const { doc, errors } = await boot(t, { role: 'viewer', app: appWith({ probeRows: FILTERED_ROWS }) });
  await open(doc);
  assert.equal(doc.querySelector('.connection-test .ct-symptom'), null, 'a viewer was offered a field that dispatches commands');
  // The verdict is computed from results that are already stored, so typing a
  // target is enough to read where it last stopped.
  await setTarget(doc, 'example.com');
  const ok = await until(() => !doc.querySelector('.ct-ladder').hidden && doc.querySelector('.ct-verdict'), 10000);
  assert.ok(ok, 'a viewer got no verdict for a destination the fleet has measured');
  assert.match(doc.querySelector('.ct-verdict').textContent, /firewall/i);
  assert.deepEqual(errors, []);
});

test('the screen offers every ladder the server can walk, and asks for what each needs', async (t) => {
  const { doc, errors } = await boot(t, { app: appWith({ probeRows: FILTERED_ROWS }) });
  await open(doc);
  const pick = doc.querySelector('.ct-ladder-pick');
  assert.ok(pick, 'no ladder picker');
  assert.deepEqual([...pick.options].map((o) => o.value),
    ['reachability', 'two_way', 'local_host', 'device_location']);

  const peer = doc.querySelector('.ct-peer');
  const device = doc.querySelector('.ct-device');
  const target = doc.querySelector('.connection-test .ct-target');
  const choose = async (id) => {
    pick.value = id;
    pick.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    await tick(150);
  };

  // Reaching a destination: a target, and nothing else.
  assert.equal(target.hidden, false);
  assert.equal(peer.hidden, true);
  assert.equal(device.hidden, true);

  // Between two agents: a far end, and no destination to type.
  await choose('two_way');
  assert.equal(peer.hidden, false, 'no far-end picker for a two-way test');
  assert.equal(target.hidden, true, 'a two-way test asked for a destination it does not use');

  // This host itself: neither.
  await choose('local_host');
  assert.equal(peer.hidden, true);
  assert.equal(target.hidden, true);
  assert.equal(device.hidden, true);

  // Where a device is plugged in: a device, and a button that says it only
  // reads — the ladder dispatches nothing.
  await choose('device_location');
  assert.equal(device.hidden, false);
  assert.match(doc.querySelector('.ct-symptom-row button').textContent, /Read what is known/);

  assert.deepEqual(errors, []);
});

test('a two-way diagnosis runs from both ends and names the direction', async (t) => {
  const sent = [];
  const AGENTS2 = [
    { id: 1, hostname: 'probe-01', display_name: 'probe-01', status: 'online', capabilities: { ips: ['10.0.0.10'] }, meta: {}, monitor_config: {} },
    { id: 2, hostname: 'probe-02', display_name: 'probe-02', status: 'online', capabilities: { ips: ['10.9.0.20'] }, meta: {}, monitor_config: {} },
  ];
  const rows = {
    1: [{ id: 1, type: 'ping', target: '10.9.0.20', ok: true, lossPct: 0, rttMs: 12, ts: new Date().toISOString() }],
    2: [{ id: 2, type: 'ping', target: '10.0.0.10', ok: true, lossPct: 40, rttMs: 13, ts: new Date().toISOString() }],
  };
  const app = makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => AGENTS2,
      findById: async (id) => AGENTS2.find((a) => a.id === Number(id)) || null,
    }),
    agentCommander: { sendCommand: (id, cmd) => { sent.push({ id, cmd }); return 1; } },
    probeResultsRepo: { latestByAgent: async (id) => rows[Number(id)] || [], findByAgent: async () => [] },
  });
  const { doc, errors } = await boot(t, { app });
  await open(doc);

  const pick = doc.querySelector('.ct-ladder-pick');
  pick.value = 'two_way';
  pick.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick(150);
  // The far end has to be a different agent from the near one.
  const peerSel = doc.querySelector('.ct-peer select');
  peerSel.value = '2';
  peerSel.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));

  doc.querySelector('.ct-symptom-row button').click();
  assert.ok(await until(() => sent.length >= 6, 20000), `only ${sent.length} probes dispatched`);
  // Each end probes the other's address.
  assert.ok(sent.filter((x) => x.id === 1).every((x) => x.cmd.probe.host === '10.9.0.20'));
  assert.ok(sent.filter((x) => x.id === 2).every((x) => x.cmd.probe.host === '10.0.0.10'));

  assert.ok(await until(() => doc.querySelector('.ct-verdict'), 20000), 'no verdict rendered');
  const verdict = doc.querySelector('.ct-verdict');
  assert.match(verdict.textContent, /probe-02 → probe-01/);
  assert.match(verdict.textContent, /return path/i);
  // Six rungs, named in the screen's own language.
  const rungs = [...doc.querySelectorAll('.ct-rung')];
  assert.equal(rungs.length, 6);
  assert.ok(rungs.some((r) => /Direction of loss/.test(r.textContent)));
  assert.deepEqual(errors, []);
});

test('the verdict offers the playbook that explains the rung, and opens it in place', async (t) => {
  const { doc, errors } = await boot(t, { app: appWith({ probeRows: FILTERED_ROWS }) });
  await open(doc);
  await setTarget(doc, 'example.com');
  assert.ok(await until(() => doc.querySelector('.ct-verdict'), 15000), 'no verdict');

  const head = doc.querySelector('.ct-playbook-head');
  assert.ok(head, 'the verdict offered nothing to read');
  assert.match(head.textContent, /Why this happens/);
  assert.match(head.textContent, /firewall or ACL/i);

  // Closed until asked: a verdict that offers three playbooks must not fetch
  // three bodies nobody reads.
  assert.equal(doc.querySelector('.ct-playbook-body').hidden, true);
  head.click();
  assert.ok(await until(() => doc.querySelector('.ct-playbook-fixes'), 15000), 'the playbook body never loaded');
  const body = doc.querySelector('.ct-playbook-body');
  assert.equal(body.hidden, false);
  assert.match(body.textContent, /ICMP and TCP are different traffic/);
  assert.ok(body.querySelectorAll('.ct-playbook-fixes li').length >= 3, 'no fixes listed');

  // And it closes again without re-fetching.
  head.click();
  assert.equal(doc.querySelector('.ct-playbook-body').hidden, true);
  assert.deepEqual(errors, []);
});
