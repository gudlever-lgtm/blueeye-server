'use strict';

// public/views/diagnose.js — Diagnose on the UI contract (docs/ui-contract.md).
//
// The page was a hand-built card with seven controls in a row and a bare <span>
// carrying both progress and failure. It is a FormPage now: two FormSections,
// one primary action, and the result as Panels. These tests hold what had to
// survive: the same POST body, the per-test selection carrying the STORED row
// ids, the rounds loop with Stop, and the evidence list that makes a verdict
// arguable rather than asserted.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const AGENTS = [
  { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01' },
  { id: 8, display_name: 'cph-core-02', hostname: 'cph-core-02' },
];
const PLAN = {
  sessionId: 42,
  usedAi: false,
  target: '8.8.8.8',
  causes: [
    {
      id: 'mtu-blackhole', title: 'MTU black hole', confidence: 0.7,
      explanation: 'Large packets are dropped while small ones get through.',
      views: [{ view: 'probes', look_for: 'a path MTU below 1500', params: { tab: 'run' } }],
      fixes: ['Clamp MSS on the tunnel'],
    },
    {
      id: 'upstream-loss', title: 'Upstream loss', confidence: 0.4,
      explanation: 'Loss appears beyond the first public hop.',
      views: [{ view: 'flows', look_for: 'retransmits to that destination' }],
      fixes: ['Raise it with the carrier'],
    },
  ],
  tests: [
    { probeType: 'path_mtu', target: '8.8.8.8', params: {}, why: 'Measures the largest packet that gets through', askedBy: ['MTU black hole'] },
    { probeType: 'ping', target: '8.8.8.8', params: { count: 20 }, direction: 'reverse', why: 'Loss from the far end', askedBy: ['Upstream loss'] },
  ],
};
const SESSION_ROWS = {
  session: {
    tests: [
      { id: 101, probeType: 'path_mtu', target: '8.8.8.8', params: {}, agentId: 7 },
      { id: 102, probeType: 'ping', target: '8.8.8.8', params: { count: 20 }, agentId: 8 },
    ],
  },
};
const EVALUATION = {
  counts: { confirmed: 1, ruled_out: 1, inconclusive: 0 },
  summary: { text: 'The tunnel is clamping nothing, so large packets die.' },
  causes: [
    {
      playbookId: 'mtu-blackhole', verdict: 'confirmed',
      evidence: [
        { when: 'path_mtu < 1500', result: true, because: 'measured 1400' },
        { when: 'ping loss > 5%', result: false, because: 'measured 0%' },
        { when: 'jitter > 30ms', result: null, because: 'never measured' },
      ],
      fixes: [{ text: 'Clamp MSS on the tunnel', complete: true }, { text: 'Or lower the MTU', complete: false }],
    },
    { playbookId: 'upstream-loss', verdict: 'ruled_out', reason: 'no_rule_matched', evidence: [], fixes: [] },
  ],
};


// The guided walk-through, as the server returns it: the measurements ordered
// cheapest-and-most-decisive first, then the screens, then the verdict.
const WALKTHROUGH = {
  sessionId: 42, target: '8.8.8.8', total: 4, position: 1, done: 0, stalled: false, verdict: null,
  steps: [
    {
      n: 1, id: 'measure-1', kind: 'measure', status: 'pending', probeType: 'ping', direction: 'forward',
      target: '8.8.8.8', params: { count: 20 }, testIds: [102], resultIds: [], measurements: [], causeIds: ['upstream-loss'],
      why: 'Does anything answer at all', outcome: 'waiting', decided: [], detail: null,
    },
    {
      n: 2, id: 'measure-2', kind: 'measure', status: 'pending', probeType: 'path_mtu', direction: 'forward',
      target: '8.8.8.8', params: {}, testIds: [101], resultIds: [], measurements: [], causeIds: ['mtu-blackhole'],
      why: 'How big a packet the path carries', outcome: 'waiting', decided: [], detail: null,
    },
    {
      n: 3, id: 'look-3', kind: 'look', status: 'pending', view: { view: 'probes', params: { tab: 'run' } },
      why: 'a path MTU below 1500', causeIds: ['mtu-blackhole'], testIds: [], outcome: null, decided: [], detail: null,
    },
    {
      n: 4, id: 'decide-4', kind: 'decide', status: 'pending', verdict: null, causeIds: [],
      why: null, testIds: [], outcome: null, decided: [], detail: null,
    },
  ],
};

function boot({ t, routes = {}, url = 'http://server.test/diagnose', role = 'operator' } = {}) {
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
const settle = () => new Promise((r) => setTimeout(r, 180));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'operator', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': AGENTS,
  'GET /api/playbooks': { playbooks: [{ symptoms: ['web is slow from the branch'] }, { symptoms: ['VPN drops every few minutes'] }] },
  'POST /api/diagnose': PLAN,
  'GET /api/diagnose/42': SESSION_ROWS,
  'POST /api/diagnose/42/run': { dispatched: 2, total: 2 },
  'POST /api/diagnose/42/evaluate': EVALUATION,
  'GET /api/diagnose/42/walkthrough': WALKTHROUGH,
}, over);

const askBtn = (doc) => [...doc.querySelectorAll('#view .form-actions-ui .btn-primary')][0];
const panels = (doc) => [...doc.querySelectorAll('#view .panel-ui')];
const testRows = (doc) => [...doc.querySelectorAll('#view table.dt tbody tr')];

async function askFor(doc, window, text) {
  const desc = doc.querySelector('#diag-description');
  desc.value = text;
  desc.dispatchEvent(new window.Event('input', { bubbles: true }));
  askBtn(doc).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
}

test('Diagnose is a FormPage: PageHeader, two FormSections, one primary', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(doc.querySelector('#view .ui.ui-page'));
  assert.ok(doc.querySelector('#view .page-head .help-btn'), 'no (?) help control');
  assert.equal(doc.querySelectorAll('#view .diag-ask').length, 0, 'the old card survived');
  assert.equal(doc.querySelectorAll('#view .diag-scope').length, 0, 'the old scope row survived');
  assert.equal(doc.querySelectorAll('#view .section-head').length, 0, 'the old section head survived');
  assert.equal(doc.querySelectorAll('#view .form-sec').length, 2);
  assert.equal(doc.querySelectorAll('#view .form-actions-ui .btn-primary').length, 1);
  assert.ok(doc.querySelector('#diag-description'), 'no description field');
});

test('the examples come from the catalogue and fill the field', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  const ex = [...doc.querySelectorAll('#view .diag-examples .btn')];
  assert.equal(ex.length, 2);
  assert.match(ex[0].textContent, /web is slow from the branch/);
  ex[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(doc.querySelector('#diag-description').value, 'web is slow from the branch');
});

test('asking with an empty description is a field error, and sends nothing', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  askBtn(doc).dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(doc.querySelector('#view .field-error'), 'no error on the field');
  assert.equal(log.filter((x) => x.key === 'POST /api/diagnose').length, 0, 'an empty question was sent');
});

test('asking posts the description and the scope, and lists the causes', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  doc.querySelector('#diag-agent').value = '7';
  doc.querySelector('#diag-target').value = '8.8.8.8';
  await askFor(doc, window, 'large downloads stall on the VPN');
  const post = log.find((x) => x.key === 'POST /api/diagnose');
  const body = typeof post.body === 'string' ? JSON.parse(post.body) : post.body;
  assert.equal(body.description, 'large downloads stall on the VPN');
  assert.equal(body.agentId, 7);
  assert.equal(body.target, '8.8.8.8');
  assert.ok(body.locale, 'the locale did not reach the matcher');

  const causes = panels(doc).find((p) => /MTU black hole/.test(p.textContent));
  assert.ok(causes, 'no causes panel');
  assert.match(causes.textContent, /Upstream loss/);
  assert.match(causes.querySelector('.panel-head .meta-xs').textContent, /keyword|Keyword/i,
    'the page does not say which matcher produced the plan');
});

test('the tests are a table, selectable by their STORED row ids', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  await askFor(doc, window, 'large downloads stall');
  await settle();
  assert.equal(testRows(doc).length, 2);
  const boxes = [...doc.querySelectorAll('#view table.dt tbody input[type="checkbox"]')];
  assert.equal(boxes.length, 2, 'the per-test selection is gone');
  assert.ok(boxes.every((b) => b.checked), 'the plan did not start fully selected');

  // Clear the first, run, and only the second id is dispatched.
  boxes[0].checked = false;
  boxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));
  const run = [...doc.querySelectorAll('#view .diag-run .btn-primary')][0];
  run.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const post = log.find((x) => x.key === 'POST /api/diagnose/42/run');
  const body = typeof post.body === 'string' ? JSON.parse(post.body) : post.body;
  assert.deepEqual(body, { testIds: [102] });
});

test('running with nothing selected says so instead of dispatching everything', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  await askFor(doc, window, 'large downloads stall');
  await settle();
  for (const b of [...doc.querySelectorAll('#view table.dt tbody input[type="checkbox"]')]) {
    b.checked = false;
    b.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  [...doc.querySelectorAll('#view .diag-run .btn-primary')][0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(log.filter((x) => x.key === 'POST /api/diagnose/42/run').length, 0, 'an empty run was dispatched');
  assert.ok(doc.querySelector('#view .diag-run .inline-note.is-warn'), 'nothing said why nothing ran');
});

test('evaluating shows a verdict per cause with the evidence behind it', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  await askFor(doc, window, 'large downloads stall');
  await settle();
  const evalBtn = [...doc.querySelectorAll('#view .diag-run .btn')].find((b) => /Evaluate/i.test(b.textContent));
  assert.ok(evalBtn, 'no evaluate control');
  evalBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  const badges = [...doc.querySelectorAll('#view .diag-cause-head .badge-ui')].map((b) => b.textContent);
  assert.equal(badges.length, 2);
  assert.ok(badges.some((b) => /confirm/i.test(b)), `no confirmed verdict: ${badges.join(', ')}`);
  assert.equal(doc.querySelectorAll('#view .pill').length, 0, 'the verdict is still a pill');

  // Three rules, three states — including the one that was never measured.
  const rules = [...doc.querySelectorAll('#view .diag-rule')];
  assert.equal(rules.length, 3);
  assert.match(rules[0].textContent, /path_mtu < 1500/);
  assert.match(rules[0].textContent, /measured 1400/);
  assert.equal(new Set(rules.map((r) => r.querySelector('.badge-ui').className)).size, 3,
    'the three rule states look the same');

  // A partial fix is called out rather than shown as a complete one.
  assert.ok(doc.querySelector('#view .diag-fixes .inline-note.is-warn'), 'a partial fix reads as complete');
});

test('a viewer gets the plan but no way to dispatch it', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /me': { id: 1, email: 'x@y.dk', role: 'viewer', preferences: {} } }), role: 'viewer' });
  await settle();
  await askFor(doc, window, 'large downloads stall');
  await settle();
  assert.equal(testRows(doc).length, 2, 'a viewer cannot see the plan');
  assert.equal(doc.querySelectorAll('#view .diag-run').length, 0, 'a viewer was offered the run controls');
  assert.equal(doc.querySelectorAll('#view table.dt tbody input[type="checkbox"]').length, 0);
});

test('a 500 on the match is an ErrorState that names the call', async (t) => {
  const { doc, window, errors } = boot({ t, routes: SESSION({ 'POST /api/diagnose': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  await askFor(doc, window, 'large downloads stall');
  assert.deepEqual(errors, []);
  const err = doc.querySelector('#view .state.is-error');
  assert.ok(err, 'no ErrorState');
  assert.match(err.textContent, /POST \/api\/diagnose/);
  assert.ok(!askBtn(doc).disabled, 'the button stayed disabled after a failure');
});

test('a plan with no causes is an EmptyState carrying the server message', async (t) => {
  const empty = { sessionId: 43, causes: [], tests: [], message: 'Nothing matched that description.' };
  const { doc, window } = boot({ t, routes: SESSION({ 'POST /api/diagnose': empty }) });
  await settle();
  await askFor(doc, window, 'the beige one is broken');
  const state = doc.querySelector('#view .state');
  assert.ok(state);
  assert.equal(doc.querySelectorAll('#view .state.is-error').length, 0, 'no match was reported as a failure');
  assert.match(state.textContent, /Nothing matched that description/);
});

test('"open this view" still navigates where the cause says to look', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  doc.querySelector('#diag-agent').value = '7';
  await askFor(doc, window, 'large downloads stall');
  await settle();
  const open = [...doc.querySelectorAll('#view .diag-view-row .btn')][0];
  assert.ok(open, 'no way through to the view');
  open.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.equal(window.location.pathname, '/probes/run', `went to ${window.location.pathname}`);
});

// ---------------------------------------------------------- the walk-through

const walkSteps = (doc) => [...doc.querySelectorAll('#view .diag-step')];

test('the walk-through comes first, and only the current step has controls', async (t) => {
  // "What do I do now" is the question the reader has; the plan answers "what
  // is this about". A list where every row has a button is the plan again.
  const { doc, window, errors } = boot({ t, routes: SESSION() });
  await settle();
  await askFor(doc, window, 'large transfers stall over the tunnel');
  await settle();
  assert.deepEqual(errors, []);

  const all = panels(doc);
  const walkIdx = all.findIndex(function (p) { return /Walk me through it/.test(p.textContent); });
  const causesIdx = all.findIndex(function (p) { return /MTU black hole/.test(p.textContent); });
  assert.ok(walkIdx !== -1, 'no walk-through panel');
  assert.ok(walkIdx < causesIdx, 'the plan came before the sequence');

  const steps = walkSteps(doc);
  assert.ok(steps.length >= 1, 'no steps rendered');
  // The server ordered ping before path_mtu; the screen must not reorder it.
  assert.match(steps[0].textContent, /ping/);
  assert.equal(doc.querySelectorAll('#view .diag-step-now').length, 1, 'exactly one step is "now"');
  assert.equal(doc.querySelectorAll('#view .diag-step-actions').length, 1, 'more than one step has buttons');
});

test('running the current step dispatches ONLY that step\'s tests', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  await askFor(doc, window, 'large transfers stall over the tunnel');
  await settle();

  const run = [...doc.querySelectorAll('#view .diag-step-actions .btn-primary')][0];
  assert.ok(run, 'the current step has no Run control');
  run.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();

  const posted = log.filter((x) => x.key === 'POST /api/diagnose/42/run');
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(posted[0].body), { testIds: [102] });
  // And it re-reads the walk-through afterwards, so the step's own answer is
  // what moves the sequence on rather than a guess made here.
  assert.ok(log.filter((x) => x.key === 'GET /api/diagnose/42/walkthrough').length >= 2);
});

test('a viewer sees the sequence and cannot press anything on it', async (t) => {
  const { doc, window } = boot({ t, role: 'viewer', routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }) });
  await settle();
  await askFor(doc, window, 'large transfers stall over the tunnel');
  await settle();
  assert.ok(walkSteps(doc).length >= 1, 'a viewer lost the walk-through entirely');
  assert.equal(doc.querySelectorAll('#view .diag-step-actions .btn-primary').length, 0);
});

test('a finished step shows the measurement beside the verdict', async (t) => {
  // A verdict nobody can check is an assertion. The size sweep in particular:
  // the row's own loss column describes the SMALLEST size, so "0% loss" is
  // exactly what a probe that found an MTU ceiling reports there.
  const done = JSON.parse(JSON.stringify(WALKTHROUGH));
  done.steps[0].status = 'done';
  done.steps[0].outcome = 'signal';
  done.steps[0].resultIds = [500];
  done.steps[0].measurements = [{
    id: 500, type: 'ping', target: '8.8.8.8', ts: '2026-01-01T00:00:00.000Z', ok: true,
    rttMs: 12.4,
    sizes: [
      { size: 64, lossPct: 0, measured: true, mtuHint: null },
      { size: 1472, lossPct: 100, measured: true, mtuHint: 1400 },
    ],
  }];
  done.steps[0].decided = [{ ruleId: 'loss_size_dependent', effect: 'confirm', because: 'Small packets pass and large ones do not.', result: true }];
  done.position = 2;
  const { doc, window, errors } = boot({ t, routes: SESSION({ 'GET /api/diagnose/42/walkthrough': done }) });
  await settle();
  await askFor(doc, window, 'large transfers stall over the tunnel');
  await settle();
  assert.deepEqual(errors, []);

  const step = walkSteps(doc)[0];
  assert.match(step.textContent, /Small packets pass and large ones do not/, 'the verdict is missing');
  assert.ok(step.querySelector('.kv-ui'), 'the measurement is not rendered');
  assert.match(step.textContent, /12\.4 ms/);
  assert.match(step.textContent, /Loss at 64 bytes/);
  assert.match(step.textContent, /Loss at 1472 bytes/);
  assert.match(step.textContent, /a router said 1400/);
});

test('a step with no measurement renders no empty measurement block', async (t) => {
  const { doc, window } = boot({ t, routes: SESSION() });
  await settle();
  await askFor(doc, window, 'large transfers stall over the tunnel');
  await settle();
  assert.equal(walkSteps(doc)[0].querySelectorAll('.kv-ui').length, 0);
});

test('a stalled walk-through says so instead of showing a spinner forever', async (t) => {
  const stalled = JSON.parse(JSON.stringify(WALKTHROUGH));
  stalled.stalled = true;
  stalled.steps[0].status = 'failed';
  stalled.steps[0].outcome = 'failed';
  stalled.steps[0].detail = 'agent is not connected';
  const { doc, window } = boot({ t, routes: SESSION({ 'GET /api/diagnose/42/walkthrough': stalled }) });
  await settle();
  await askFor(doc, window, 'large transfers stall over the tunnel');
  await settle();
  const walk = panels(doc).find(function (p) { return /Walk me through it/.test(p.textContent); });
  assert.ok(walk, 'no walk-through panel');
  assert.match(walk.textContent, /cannot move on its own/);
  assert.match(walk.textContent, /agent is not connected/);
});

test('a walk-through the server cannot build costs the sequence, never the plan', async (t) => {
  const { doc, window, errors } = boot({ t, routes: SESSION({ 'GET /api/diagnose/42/walkthrough': { status: 500, body: { error: 'boom' } } }) });
  await settle();
  await askFor(doc, window, 'large transfers stall over the tunnel');
  await settle();
  assert.deepEqual(errors, []);
  // The causes and the tests are still there — the plan does not depend on it.
  assert.ok(panels(doc).some((p) => /MTU black hole/.test(p.textContent)));
  assert.ok(testRows(doc).length >= 2);
});
