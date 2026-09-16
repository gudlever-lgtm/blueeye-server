'use strict';

// The Diagnose screen, driven the way a person drives it: type the fault, read
// the plan, run it, read the verdicts.
//
// Same harness as dashboardSmoke — jsdom's fetch wired into the real Express
// app — because the thing worth testing here is the whole path. A unit test of
// the view against a hand-written fake would only prove the view agrees with
// whatever the test's author believed the API returns.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');

const { makeApp, tokenFor, makeAgentsRepo, makeDiagnoseSessionsRepo } = require('../test-support/fakes');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const F1 = 'Mail kan forbinde, men når der sendes data, mistes pakker eller forbindelsen afbrydes';
const AGENTS = [{ id: 1, hostname: 'fw-aarhus', display_name: 'fw-aarhus', status: 'online', capabilities: {}, meta: {}, monitor_config: {} }];

// The measurements an MTU blackhole actually produces, timestamped after the
// run so the session's correlation window picks them up.
function mtuProbeRows(atMs) {
  return [
    {
      id: 11, agent_id: 1, type: 'ping', target: 'mail.example.com', ts: new Date(atMs + 1000),
      ok: 1, loss_pct: 0, rtt_ms: 5,
      sizes: JSON.stringify([
        { bytes: 64, sent: 4, recv: 4, lossPct: 0, rttMs: 5, measured: true },
        { bytes: 1472, sent: 4, recv: 0, lossPct: 100, measured: true },
      ]),
    },
    {
      id: 12, agent_id: 1, type: 'path_mtu', target: 'mail.example.com', ts: new Date(atMs + 2000), ok: 1,
      mtu: JSON.stringify({ path_mtu: 1400, blackhole_detected: true, icmp_frag_needed_seen: false, recommended_mss: 1360, mtu_drop_at_hop: 3, ip_version: 4, mss_supported: true, mss_observed: 1460, hops: [] }),
    },
  ];
}

function appWith({ probeRows = [], assistant = null } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => AGENTS,
      findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
    }),
    agentCommander: { sendCommand: () => 1 },
    diagnoseSessionsRepo: makeDiagnoseSessionsRepo({ probeRows }),
    assistant,
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
    const raw = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    let req = request(app)[method.toLowerCase()](raw).set('Authorization', `Bearer ${token}`);
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
  return { window, doc: window.document, errors, app, token };
}

async function openDiagnose(doc) {
  const btn = doc.querySelector('.tabs button[data-view="diagnose"]');
  assert.ok(btn, 'no Diagnose entry in the nav');
  btn.click();
  await tick(250);
  return btn;
}

const byText = (doc, sel, re) => [...doc.querySelectorAll(sel)].find((e) => re.test(e.textContent || ''));

// Fills in the form and submits, returning once the plan is on screen.
async function ask(doc, { description = F1, agent = '1', target = 'mail.example.com' } = {}) {
  doc.querySelector('#diag-description').value = description;
  const selects = doc.querySelectorAll('.diag-scope select');
  if (agent) selects[0].value = agent;
  doc.querySelector('.diag-scope input').value = target;
  const submit = [...doc.querySelectorAll('.diag-ask .diag-actions button')][0];
  submit.click();
  await tick(400);
}

// --- the screen --------------------------------------------------------------

test('the Diagnose entry is in the nav, translated, and opens a page that asks the question', async (t) => {
  const { doc, errors } = await boot(t);
  const btn = await openDiagnose(doc);
  assert.equal(btn.textContent.trim(), 'Diagnose');
  assert.ok(!/^nav\./.test(btn.textContent), 'the nav label is an untranslated key');
  const field = doc.querySelector('#diag-description');
  assert.ok(field, 'no description field');
  assert.ok(field.placeholder.length > 10, 'the field does not say what to write in it');
  assert.equal(field.getAttribute('maxlength'), '1000');
  assert.deepEqual(errors, []);
});

test('the examples under the field come from the catalogue, and clicking one fills it in', async (t) => {
  const { doc } = await boot(t);
  await openDiagnose(doc);
  await tick(250);
  const examples = [...doc.querySelectorAll('.diag-examples button')];
  assert.ok(examples.length > 0, 'no examples — the catalogue call did not land');
  const text = examples[0].textContent;
  examples[0].click();
  assert.equal(doc.querySelector('#diag-description').value, text);
});

test('the Danish fixture produces a readable plan on screen', async (t) => {
  const { doc, errors } = await boot(t);
  await openDiagnose(doc);
  await ask(doc);

  const causes = doc.querySelector('.diag-causes');
  assert.ok(causes, 'no plan rendered');
  assert.match(causes.querySelector('.diag-cause-head strong').textContent, /MTU/i);

  // It says which matcher produced it, without being asked.
  assert.match(doc.querySelector('.diag-matched').textContent, /keyword|nøgleord/i);

  // The tests are listed with their parameters already filled in.
  const tests = [...doc.querySelectorAll('.diag-test code')].map((c) => c.textContent);
  assert.ok(tests.some((x) => /^ping mail\.example\.com/.test(x) && /sizes=\[64,1472\]/.test(x)), tests.join(' | '));
  assert.ok(tests.some((x) => /^path_mtu mail\.example\.com/.test(x)), tests.join(' | '));

  // Every view link says what to look for once you are there.
  const rows = [...doc.querySelectorAll('.diag-view-row')];
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.querySelector('button'), 'a "look here" row with no way to get there');
    assert.ok((r.querySelector('.muted').textContent || '').length > 10, 'a link with no "what am I looking at"');
  }

  // And a possible fix, before anything has run.
  assert.ok(doc.querySelectorAll('.diag-fix').length > 0);
  assert.deepEqual(errors, []);
});

test('a description that matches nothing says so instead of rendering an empty card', async (t) => {
  const { doc, errors } = await boot(t);
  await openDiagnose(doc);
  await ask(doc, { description: 'Hej, hvordan går det i dag?' });
  const empty = doc.querySelector('.diag-out .empty');
  assert.ok(empty, 'no message at all');
  assert.ok(empty.textContent.trim().length > 20);
  assert.equal(doc.querySelector('.diag-causes'), null);
  assert.deepEqual(errors, []);
});

// --- running and evaluating ---------------------------------------------------

test('an operator can run the plan and read a confirmed cause with its evidence and its numbers', async (t) => {
  // Stamped comfortably after the run will be dispatched: the correlation
  // window opens at dispatch and runs for ten minutes, so anything a little in
  // the future lands inside it no matter how long the render takes.
  const app = appWith({ probeRows: mtuProbeRows(Date.now() + 30_000) });
  const { doc, errors } = await boot(t, { app });
  await openDiagnose(doc);
  await ask(doc);

  const runBtn = byText(doc, '.diag-tests button', /Run all|Kør alle/);
  assert.ok(runBtn, 'no way to run the plan');
  runBtn.click();
  await tick(300);
  assert.match(doc.querySelector('.diag-tests .diag-actions .muted').textContent, /Sent \d+ of \d+|Sendte \d+ af \d+/);

  byText(doc, '.diag-tests button', /Evaluate|Vurdér/).click();
  await tick(400);

  // The verdict is on the cause, in words.
  const pill = doc.querySelector('.diag-cause-head .pill');
  assert.ok(pill, 'no verdict rendered');
  assert.match(pill.textContent, /Confirmed|Bekræftet/);
  assert.match(doc.querySelector('.diag-counts').textContent, /1 confirmed|1 bekræftet/);

  // The evidence is the rules themselves, marked.
  const fired = [...doc.querySelectorAll('.diag-rule.fired')];
  assert.ok(fired.length >= 1, 'no rule is shown as having matched');
  assert.ok(fired.some((r) => /size_1472/.test(r.querySelector('code').textContent)));
  for (const r of fired) assert.ok((r.querySelector('.small').textContent || '').length > 10, 'a rule with no reason');

  // The fix carries the measured numbers, not placeholders.
  const fixes = [...doc.querySelectorAll('.diag-fix')].map((f) => f.textContent);
  assert.ok(fixes.some((f) => f.includes('1360')), fixes.join(' | '));
  assert.ok(fixes.some((f) => f.includes('hop 3')), fixes.join(' | '));
  assert.ok(!fixes.some((f) => f.includes('{')), 'a placeholder reached the screen');
  assert.deepEqual(errors, []);
});

test('when the tests have not reported, the cause stays open and the screen says what it is waiting for', async (t) => {
  // No probe rows: the agents were asked and nothing has come back.
  const { doc, errors } = await boot(t, { app: appWith({ probeRows: [] }) });
  await openDiagnose(doc);
  await ask(doc);
  byText(doc, '.diag-tests button', /Run all|Kør alle/).click();
  await tick(300);
  byText(doc, '.diag-tests button', /Evaluate|Vurdér/).click();
  await tick(400);

  const pill = doc.querySelector('.diag-cause-head .pill');
  assert.match(pill.textContent, /Open|Uafklaret/);
  // And it names the measurement it needs, rather than just shrugging.
  const reason = doc.querySelector('.diag-cause-head .small');
  assert.ok(reason, 'no reason given for an open cause');
  assert.match(reason.textContent, /Waiting on|Mangler/);
  assert.match(reason.textContent, /ping\.|path_mtu\./);
  assert.deepEqual(errors, []);
});

test('a viewer sees the plan and is not offered the buttons that touch the network', async (t) => {
  const { doc, errors } = await boot(t, { role: 'viewer' });
  await openDiagnose(doc);
  await ask(doc);
  assert.ok(doc.querySelector('.diag-causes'), 'a viewer must still get the plan');
  assert.ok(doc.querySelectorAll('.diag-test').length > 0, 'a viewer must still see what to run');
  assert.equal(byText(doc, '.diag-tests button', /Run all|Kør alle/), undefined);
  assert.equal(byText(doc, '.diag-tests button', /Evaluate|Vurdér/), undefined);
  assert.deepEqual(errors, []);
});

test('a "look here" button actually navigates somewhere', async (t) => {
  const { doc, errors } = await boot(t);
  await openDiagnose(doc);
  await ask(doc);
  const link = doc.querySelector('.diag-view-row button');
  link.click();
  await tick(300);
  // We left Diagnose and landed on a page that rendered something.
  assert.equal(doc.querySelector('#diag-description'), null, 'the deep link did not navigate');
  const view = doc.querySelector('#view');
  assert.ok((view.textContent || '').trim().length > 0, 'the deep link landed on a blank page');
  assert.deepEqual(errors, []);
});

test('the page survives a server that is failing', async (t) => {
  const app = appWith();
  const { doc, errors } = await boot(t, { app });
  await openDiagnose(doc);
  // Break the API underneath the page, then ask.
  doc.defaultView.fetch = async () => ({
    ok: false, status: 500, headers: { get: () => 'application/json' },
    json: async () => ({ error: 'Internal Server Error' }), text: async () => '{}',
  });
  await ask(doc);
  const status = doc.querySelector('.diag-status');
  assert.match(status.textContent, /Internal Server Error/);
  assert.ok(status.classList.contains('error'));
  assert.deepEqual(errors, [], 'a failing server must not throw on the page');
});

test('the whole screen follows a language switch', async (t) => {
  const { doc, errors } = await boot(t);
  await openDiagnose(doc);
  const enPlaceholder = doc.querySelector('#diag-description').placeholder;
  assert.equal(doc.querySelector('.tabs button[data-view="diagnose"]').textContent.trim(), 'Diagnose');

  // Switched the way a person switches it — the picker in Settings → Appearance.
  // Calling the catalogue's setLocale directly would change the rendered text
  // but not the STATIC sidebar, and the untranslated-nav-label bug is exactly
  // the one this is here to catch.
  doc.querySelector('.tabs button[data-view="settings"]').click();
  await tick(300);
  const picker = doc.querySelector('#locale-select');
  assert.ok(picker, 'no language picker in Settings');
  picker.value = 'da';
  picker.dispatchEvent(new doc.defaultView.Event('change'));
  await tick(400);

  await openDiagnose(doc);
  const daPlaceholder = doc.querySelector('#diag-description').placeholder;
  assert.notEqual(daPlaceholder, enPlaceholder);
  assert.match(daPlaceholder, /mistes pakker/);
  // The sidebar is static markup render() never touches, so it only follows if
  // the nav entry carries a data-i18n key.
  assert.equal(doc.querySelector('.tabs button[data-view="diagnose"]').textContent.trim(), 'Diagnosticér');
  assert.deepEqual(errors, []);
});
