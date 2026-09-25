'use strict';

// "I clicked Update and OK, and the overview still shows the old version."
//
// The dashboard said "update sent — rebuilding and restarting" and then went
// quiet, whatever happened next. The agent rebuilds, restarts and echoes the
// outcome back into its action-audit row, but that row only existed behind the
// connection modal — so a rebuild that FAILED looked exactly like one that
// worked, and an unsigned push that a key-pinned agent would refuse looked like
// a success too. The click now follows its own action to a verdict.
//
// Same harness as the other view suites — jsdom's fetch wired into the real
// Express app — so the audit row the poll reads is one the server wrote.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');

const {
  makeApp, tokenFor, makeAgentsRepo, makeAuditRepo, makeSourceStore,
  makeReleaseStore, makeReleaseKeyService,
} = require('../test-support/fakes');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const AGENTS = [{
  id: 1, hostname: 'probe-01', display_name: 'probe-01', status: 'online',
  platform: 'linux', arch: 'x64',
  capabilities: { agentVersion: '0.24.0', managed: 'systemd' }, meta: {}, monitor_config: {},
}];

function appWith({ auditRepo, signing = true, verifyOnly = false } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => AGENTS,
      findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
    }),
    auditRepo,
    agentCommander: {
      sendCommand: () => 1,
      sendCommandAndWait: async () => ({ delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }),
    },
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.27.0' }),
    releaseStore: makeReleaseStore(),
    releaseKeyService: makeReleaseKeyService({ configured: signing, verifyOnly }),
    probeResultsRepo: { latestByAgent: async () => [], findByAgent: async () => [] },
    speedtestResultsRepo: { findByAgent: async () => [], latestPerAgent: async () => [], create: async () => 1 },
  });
}

async function boot(t, app) {
  const token = tokenFor('admin', { id: 1, email: 'admin@blueeye.local' });
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
      ok: res.status < 300, status: res.status,
      headers: { get: (h) => res.headers[String(h).toLowerCase()] },
      json: async () => res.body, text: async () => res.text,
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  if (t) t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', token);
  window.localStorage.setItem('blueeye.server.role', 'admin');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(350);
  return { window, doc: window.document, errors };
}

const toastText = (doc) => (doc.querySelector('#toast') || {}).textContent || '';

// Waits for a condition instead of guessing how long a render takes. A fixed
// delay here failed intermittently under a loaded full suite: the agents view had
// not replaced the previous one yet, so the ⋯ menu found below was the Changes
// page's (Open details / Open host / Mute this rule) and the assertion read as
// "Update is missing" when the view simply had not arrived.
async function waitFor(pred, ms, message) {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(message);
    // eslint-disable-next-line no-await-in-loop
    await tick(25);
  }
  return pred();
}

async function clickUpdate(doc) {
  doc.querySelector('.tabs button[data-view="agents"]').click();
  // Update is a ⋯ menu entry now, with the other actions that change the agent
  // (see public/views/agents.js) — it used to be one of nine buttons in the row.
  // Wait for the AGENTS page, by its own heading — not for "a row menu exists",
  // which the page we came from also has.
  await waitFor(
    () => /Agents/.test((doc.querySelector('#view h1') || {}).textContent || ''),
    5000,
    `the agents view never rendered — #view h1 is "${(doc.querySelector('#view h1') || {}).textContent || ''}"`
  );
  const more = await waitFor(
    () => doc.querySelector('#view .row-act [aria-haspopup="menu"]'),
    5000,
    'the agents view rendered no row with a ⋯ menu'
  );
  assert.ok(more, 'the agents row has no ⋯ menu');
  more.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  const item = await waitFor(
    () => [...doc.querySelectorAll('.ui-rowmenu button')].find((b) => /^Update to v/.test(b.textContent.trim())),
    2000,
    `no Update entry — found: ${[...doc.querySelectorAll('.ui-rowmenu button')].map((b) => b.textContent).join(' | ')}`
  );
  assert.ok(item, 'the ⋯ menu has no Update entry');
  item.click();
  await tick(350);
}

test('an update that FAILS on the host says so, instead of "rebuilding and restarting"', async (t) => {
  const auditRepo = makeAuditRepo();
  const { doc } = await boot(t, appWith({ auditRepo }));
  await clickUpdate(doc);

  assert.match(toastText(doc), /update sent/i, 'the immediate acknowledgement is missing');

  // The agent rebuilt, the rebuild failed, and it echoed that back — which is
  // what agentSocket does with an `action-result` frame.
  const row = auditRepo.rows.find((r) => r.action === 'upgrade');
  assert.ok(row, 'the upgrade was not audited');
  await auditRepo.complete(row.id, { state: 'failed', resultDetail: 'npm ci exited 1' });

  await tick(6500);
  assert.match(toastText(doc), /FAILED/i, 'a failed rebuild still reads as a success');
  assert.match(toastText(doc), /npm ci exited 1/, "the agent's own reason is not shown");
});

test('an update that lands reports the version it landed on', async (t) => {
  const auditRepo = makeAuditRepo();
  const { doc } = await boot(t, appWith({ auditRepo }));
  await clickUpdate(doc);

  const row = auditRepo.rows.find((r) => r.action === 'upgrade');
  await auditRepo.complete(row.id, { state: 'completed', resultDetail: null });

  await tick(6500);
  assert.match(toastText(doc), /updated/i);
  assert.match(toastText(doc), /0\.27\.0/, 'the version it reached is the whole point');
});

test('a refusal over the pinned release key offers the re-pin command', async (t) => {
  // The agent accepted the command and then refused the payload, because the key
  // it pinned at install time is not the key this server signs with. That has one
  // fix and the operator cannot guess it, so the dashboard hands it over.
  const auditRepo = makeAuditRepo();
  // A key IS pinned on both sides — this server just cannot sign with it.
  const { doc } = await boot(t, appWith({ auditRepo, verifyOnly: true }));
  await clickUpdate(doc);
  const row = auditRepo.rows.find((r) => r.action === 'upgrade');
  await auditRepo.complete(row.id, {
    state: 'failed',
    resultDetail: 'refusing unsigned update: a release public key is pinned or signed updates are required (possible signature downgrade)',
  });

  await tick(6500);
  const modal = doc.querySelector('#modal');
  assert.ok(modal && !modal.classList.contains('hidden'), 'no re-pin modal appeared');
  assert.match(doc.querySelector('#modal-card').textContent, /repin\.sh/, 'the re-pin one-liner is missing');
});

test('an UNSIGNED push warns at the click, not only in the trail', async (t) => {
  // No signing key: the server falls back to the unsigned source bundle, which
  // an agent pinned to a release key refuses AFTER accepting the command.
  const auditRepo = makeAuditRepo();
  const { doc } = await boot(t, appWith({ auditRepo, signing: false }));
  await clickUpdate(doc);
  assert.match(toastText(doc), /UNSIGNED/, 'an unsigned push looked identical to a signed one');
  assert.match(toastText(doc), /signing key/i, 'it must say what to do about it');
});
