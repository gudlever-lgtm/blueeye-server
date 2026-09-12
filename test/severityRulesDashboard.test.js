'use strict';

// The severity-rules screen, driven in a real DOM.
//
// The server side is covered by test/severityRules.test.js. This is the other
// half: that the dashboard actually reaches it. The dashboard is dependency-free
// vanilla JS with no build step, so nothing but a browser catches a screen that
// renders blank, a button wired to nothing, or a form that posts the wrong shape
// — and "the API works" has never been the same claim as "a person can use it".
//
// Everything here happens through the UI: click the nav button, click the
// sub-tab, fill the form, submit it. No calling app.js internals, because a test
// that calls the function directly would pass with the button unwired.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const ME = { id: 1, email: 'admin@blueeye.local', role: 'admin', preferences: {} };
const BASE_ROUTES = {
  'GET /me': ME,
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /license/features': { analysis: true, alerting: true, service_tests: true },
  'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
};

// Records the BODY as well as the path: the point of most of these tests is what
// the browser sends, not merely that it sent something.
function recordingFetch(routes, calls) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
    calls.push({ method, path: p, body });
    const hit = routes[`${method} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const payload = hit === undefined
      ? { error: 'Not Found', path: p }
      : (hit.body !== undefined ? hit.body : hit);
    return {
      ok: status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
    if (s.startsWith('/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, errors, calls };
}

const click = async (node, ms) => { node.click(); await tick(ms); };
const byText = (doc, selector, text) =>
  [...doc.querySelectorAll(selector)].find((n) => n.textContent.trim() === text) || null;
const textOf = (doc, selector) => [...doc.querySelectorAll(selector)].map((n) => n.textContent.trim());

// Walks the nav to Settings → Severity rules the way a person does.
async function openSeverityRules(doc) {
  const settings = doc.querySelector('.tabs button[data-view="settings"]');
  assert.ok(settings, 'the Settings nav button is missing');
  await click(settings, 120);
  const tab = byText(doc, '.settings-nav button', 'Severity rules');
  assert.ok(tab, `no "Severity rules" tab — found: ${textOf(doc, '.settings-nav button').join(' | ')}`);
  await click(tab, 120);
  return tab;
}

const RULE = {
  id: 7,
  source: 'finding',
  match_metric: 'packet_loss',
  match_kind: null,
  match_host_id: 'gw-core',
  match_application_id: null,
  severity: 'WARN',
  reason: 'noisy warehouse wifi',
  enabled: true,
  applied_count: 12,
  last_applied_at: '2026-09-11T20:40:28.000Z',
};

test('the screen reaches the API and shows what each rule does', async (t) => {
  const { doc, errors, calls } = await boot(t, { 'GET /api/severity-rules': [RULE] });
  await openSeverityRules(doc);

  assert.deepEqual(errors, [], 'the screen threw while rendering');
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/api/severity-rules'), 'the screen never asked for the rules');

  const table = doc.querySelector('#view .tablewrap table');
  assert.ok(table, 'the rules table did not render');
  const row = table.querySelector('tbody tr').textContent;
  // Each column earns its place: what it applies to, what it matches, what it
  // stores, why it exists, and whether it has ever actually fired.
  assert.match(row, /Analysis findings/);
  assert.match(row, /metric packet_loss/);
  assert.match(row, /agent gw-core/);
  assert.match(row, /WARN/);
  assert.match(row, /noisy warehouse wifi/);
  assert.match(row, /12×/, 'a rule that has fired must say so — one nobody can tell is dead is one nobody dares delete');
});

test('a rule that has never matched says so rather than showing a blank', async (t) => {
  const { doc } = await boot(t, {
    'GET /api/severity-rules': [{ ...RULE, applied_count: 0, last_applied_at: null }],
  });
  await openSeverityRules(doc);
  assert.match(doc.querySelector('#view tbody tr').textContent, /never matched/);
});

test('with no rules the screen says what that means, not just "empty"', async (t) => {
  const { doc } = await boot(t, { 'GET /api/severity-rules': [] });
  await openSeverityRules(doc);
  const empty = doc.querySelector('#view .empty');
  assert.ok(empty, 'no empty state rendered');
  assert.match(empty.textContent, /keeps the severity it was detected with/);
});

test('creating a rule posts the shape the API documents', async (t) => {
  const { doc, calls, errors } = await boot(t, {
    'GET /api/severity-rules': [],
    'POST /api/severity-rules': { status: 201, body: RULE },
  });
  await openSeverityRules(doc);

  const newBtn = byText(doc, '#view button', '+ New rule');
  assert.ok(newBtn, 'no "+ New rule" button');
  await click(newBtn, 40);

  const form = doc.querySelector('#modal-card form');
  assert.ok(form, 'the new-rule form did not open');
  const inputs = [...form.querySelectorAll('input, select, textarea')];
  const at = (i) => inputs[i];
  // finding fields: source, metric, kind, agent, severity, reason, enabled
  assert.equal(inputs.length, 7, `unexpected field count: ${inputs.length}`);
  at(1).value = 'packet_loss';
  at(3).value = 'gw-core';
  at(4).value = 'WARN';
  at(5).value = 'noisy warehouse wifi';
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(80);

  assert.deepEqual(errors, []);
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/severity-rules');
  assert.ok(post, 'the form never posted');
  assert.deepEqual(post.body, {
    source: 'finding',
    severity: 'WARN',
    reason: 'noisy warehouse wifi',
    enabled: true,
    match_metric: 'packet_loss',
    // A blank box means "any", which the API spells as null. Sending '' would be
    // a rule matching the empty string, and therefore nothing.
    match_kind: null,
    match_host_id: 'gw-core',
  });
});

test('a Service Assurance rule offers only the fields that source has', async (t) => {
  const { doc, calls } = await boot(t, {
    'GET /api/severity-rules': [],
    'POST /api/severity-rules': { status: 201, body: { ...RULE, source: 'service_assurance' } },
  });
  await openSeverityRules(doc);
  await click(byText(doc, '#view button', '+ New rule'), 40);

  // Switching the source re-opens the form with that source's fields. Offering
  // match_host_id on a Service Assurance rule would let someone write one that
  // matches far more than they believe — the server refuses it, and the form
  // must not be able to ask for it in the first place.
  const source = doc.querySelector('#modal-card select');
  source.value = 'service_assurance';
  source.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  await tick(40);

  const labels = [...doc.querySelectorAll('#modal-card label')].map((l) => l.textContent);
  assert.ok(!labels.some((l) => /Agent id/.test(l)), 'a service-assurance rule was offered an agent field');
  assert.ok(labels.some((l) => /Application id/.test(l)), 'no application field on a service-assurance rule');

  const form = doc.querySelector('#modal-card form');
  const inputs = [...form.querySelectorAll('input, select, textarea')];
  inputs[1].value = 'http_5xx';
  inputs[2].value = '4';
  inputs[3].value = 'CRIT';
  inputs[4].value = 'checkout is the business';
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(80);

  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/severity-rules');
  assert.ok(post, 'the form never posted');
  assert.equal(post.body.source, 'service_assurance');
  assert.equal(post.body.match_kind, 'http_5xx');
  assert.equal(post.body.match_application_id, '4');
  assert.ok(!('match_host_id' in post.body), 'a foreign match field leaked into the body');
});

test('the server\'s validation message is shown in the form, not swallowed', async (t) => {
  const { doc } = await boot(t, {
    'GET /api/severity-rules': [],
    'POST /api/severity-rules': {
      status: 400,
      body: { error: 'Validation failed', details: { reason: 'say why this rule exists' } },
    },
  });
  await openSeverityRules(doc);
  await click(byText(doc, '#view button', '+ New rule'), 40);
  const form = doc.querySelector('#modal-card form');
  form.querySelectorAll('input')[0].value = 'packet_loss';
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(80);
  assert.match(doc.querySelector('#modal-card .error').textContent, /say why this rule exists/);
  assert.ok(doc.querySelector('#modal-card form'), 'the form closed on a rejected save');
});

test('editing a rule sends a PUT and keeps the source it was created with', async (t) => {
  const { doc, calls } = await boot(t, {
    'GET /api/severity-rules': [RULE],
    'PUT /api/severity-rules/7': { ...RULE, severity: 'INFO' },
  });
  await openSeverityRules(doc);
  await click(byText(doc, '#view button', 'Edit'), 40);

  const form = doc.querySelector('#modal-card form');
  const inputs = [...form.querySelectorAll('input, select, textarea')];
  // No source picker on an edit: the fields below belong to it, and changing it
  // would orphan the ones already filled in.
  assert.equal(inputs.length, 6, `edit should not offer a source picker (${inputs.length} fields)`);
  assert.equal(inputs[0].value, 'packet_loss', 'the form did not load the rule it is editing');
  inputs[3].value = 'INFO';
  form.dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await tick(80);

  const put = calls.find((c) => c.method === 'PUT' && c.path === '/api/severity-rules/7');
  assert.ok(put, 'the edit never sent a PUT');
  assert.equal(put.body.severity, 'INFO');
  assert.equal(put.body.source, 'finding');
});

test('the back-fill counts before it changes anything', async (t) => {
  const asked = [];
  const { doc, calls, window } = await boot(t, {
    'GET /api/severity-rules': [RULE],
    'POST /api/severity-rules/7/apply-to-open': {
      matched: 412, changed: 412, dry_run: true,
      note: '412 open events would be set to WARN. Send { "confirm": true } to apply.',
    },
  });
  window.confirm = (msg) => { asked.push(msg); return false; };
  await openSeverityRules(doc);
  await click(byText(doc, '#view button', 'Apply to open events'), 80);

  const posts = calls.filter((c) => c.path === '/api/severity-rules/7/apply-to-open');
  assert.equal(posts.length, 1, 'it should count once and stop when the answer is no');
  assert.deepEqual(posts[0].body, {}, 'the first call must be the dry run');
  assert.equal(asked.length, 1, 'nothing was confirmed with the operator');
  assert.match(asked[0], /412 open events would be set to WARN/,
    'the confirm must say how many events it is about to change');
});

test('confirming the back-fill sends confirm:true', async (t) => {
  const { doc, calls, window } = await boot(t, {
    'GET /api/severity-rules': [RULE],
    'POST /api/severity-rules/7/apply-to-open': {
      matched: 412, changed: 412, dry_run: true, note: '412 open events would be set to WARN.',
    },
  });
  window.confirm = () => true;
  await openSeverityRules(doc);
  await click(byText(doc, '#view button', 'Apply to open events'), 120);

  const posts = calls.filter((c) => c.path === '/api/severity-rules/7/apply-to-open');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, { confirm: true });
});

test('deleting says plainly that it does not put the changed events back', async (t) => {
  const asked = [];
  const { doc, calls, window } = await boot(t, {
    'GET /api/severity-rules': [RULE],
    'DELETE /api/severity-rules/7': { status: 204, body: {} },
  });
  window.confirm = (msg) => { asked.push(msg); return true; };
  await openSeverityRules(doc);
  await click(byText(doc, '#view button', 'Delete'), 80);

  assert.match(asked[0], /does not put them back/);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/api/severity-rules/7'));
});

// ------------------------------------------------------------------ findings
const FINDING = {
  id: 'f1', hostId: '1', metric: 'packet_loss', severity: 'WARN',
  originalSeverity: 'CRIT', severityRuleId: 7, kind: 'ANOMALY', deviation: 8,
  explanation: 'packet_loss at 4% deviated 8.0σ from baseline', evidence: [],
  correlatedWith: [], createdAt: '2026-09-11T20:40:28.000Z', acked: false,
};

async function openFindings(doc) {
  const nav = doc.querySelector('.tabs button[data-view="findings"]');
  assert.ok(nav, 'no Findings nav button');
  await click(nav, 150);
}

test('a downgraded finding says on screen that it was downgraded', async (t) => {
  const { doc } = await boot(t, {
    'GET /agents': [{ id: 1, hostname: 'gw-core', display_name: 'gw-core' }],
    'GET /api/findings': [FINDING],
    'GET /api/findings/summary': { total: 1, bySeverity: { CRIT: 0, WARN: 1, INFO: 0 }, byMetric: [], byHost: [] },
  });
  await openFindings(doc);
  const row = [...doc.querySelectorAll('#view table.findings tbody tr')][0];
  assert.ok(row, 'no finding row rendered');
  // Without this the row is indistinguishable from a warning the detector
  // itself raised — which is exactly the event nobody ever looks at again.
  assert.match(row.textContent, /was CRIT/);
});

test('a finding the detector judged on its own claims no rule', async (t) => {
  const { doc } = await boot(t, {
    'GET /agents': [{ id: 1, hostname: 'gw-core', display_name: 'gw-core' }],
    'GET /api/findings': [{ ...FINDING, severity: 'CRIT', originalSeverity: null, severityRuleId: null }],
    'GET /api/findings/summary': { total: 1, bySeverity: { CRIT: 1, WARN: 0, INFO: 0 }, byMetric: [], byHost: [] },
  });
  await openFindings(doc);
  const row = [...doc.querySelectorAll('#view table.findings tbody tr')][0];
  assert.ok(!/\bwas\b/.test(row.textContent), 'an untouched finding must not claim a rule changed it');
});

test('the button on a finding opens a rule already describing that finding', async (t) => {
  const { doc } = await boot(t, {
    'GET /agents': [{ id: 1, hostname: 'gw-core', display_name: 'gw-core' }],
    'GET /api/findings': [FINDING],
    'GET /api/findings/summary': { total: 1, bySeverity: { CRIT: 0, WARN: 1, INFO: 0 }, byMetric: [], byHost: [] },
  });
  await openFindings(doc);
  const btn = byText(doc, '#view table.findings button', 'Severity rule…');
  assert.ok(btn, 'no per-finding severity-rule button');
  await click(btn, 60);

  const inputs = [...doc.querySelectorAll('#modal-card form input, #modal-card form select, #modal-card form textarea')];
  assert.ok(inputs.length, 'the form did not open from the finding');
  // Pre-filled from the event, because the thought "this should be a warning for
  // us" happens while looking at it, not in Settings an hour later.
  assert.equal(inputs[0].value, 'finding');
  assert.equal(inputs[1].value, 'packet_loss');
  assert.equal(inputs[2].value, 'ANOMALY');
  assert.equal(inputs[3].value, '1');
});

test('a viewer is never shown a control that writes a rule', async (t) => {
  const { doc } = await boot(t, {
    'GET /me': { ...ME, role: 'viewer' },
    'GET /agents': [{ id: 1, hostname: 'gw-core', display_name: 'gw-core' }],
    'GET /api/findings': [FINDING],
    'GET /api/findings/summary': { total: 1, bySeverity: { CRIT: 0, WARN: 1, INFO: 0 }, byMetric: [], byHost: [] },
  }, 'viewer');
  await openFindings(doc);
  assert.equal(byText(doc, '#view table.findings button', 'Severity rule…'), null);
  // The provenance is not a privilege — a viewer must still see that the
  // severity in front of them was changed by a person.
  assert.match(doc.querySelector('#view table.findings tbody tr').textContent, /was CRIT/);
});
