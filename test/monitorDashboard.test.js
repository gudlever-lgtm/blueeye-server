'use strict';

// The monitor screen and its dialog, driven in a real DOM.
//
// Two complaints, both about the same thing — the screen not saying what it
// does:
//
//   1. "Check every (seconds)" is what makes a monitor run forever, and the
//      form said nothing about that. There was also no way to stop one short of
//      deleting it, which throws the history away with it.
//   2. Typing 50 into that field and pressing Save produced a disabled button
//      for a moment and no visible reason. The reason WAS rendered — at the
//      bottom of a dialog that scrolls for two screens, where nobody was
//      looking.
//
// So this suite is about the explanation, not the plumbing: the field that was
// rejected is marked where it stands, and pausing exists.

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
    const resolved = typeof hit === 'function' ? hit(body) : hit;
    const status = resolved === undefined ? 404 : (resolved.status || 200);
    const payload = resolved === undefined
      ? { error: 'Not Found', path: p }
      : (resolved.body !== undefined ? resolved.body : resolved);
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
    if (s.startsWith('/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, errors, calls };
}

const click = async (node, ms) => { node.click(); await tick(ms); };

const MONITOR = {
  id: 7,
  name: 'Customer mail',
  type: 'tcp_port',
  target: 'mail.example.dk',
  interval_sec: 900,
  warn_ms: null,
  crit_ms: null,
  enabled: true,
  pending: false,
  activated_at: '2026-09-15T10:00:00.000Z',
  last_run_at: '2026-09-15T17:30:00.000Z',
  last_status: 'ok',
  has_secrets: {},
  config: { host: 'mail.example.dk', port: 25 },
  recent: [],
  summary: { checks: 4, ok: 4, slow: 0, bad: 0, availability: 1, avg_value: 42, max_value: 80, since: null },
};

const TYPES = {
  types: [{
    type: 'tcp_port',
    label: 'TCP port',
    category: 'network',
    target: 'host',
    default_interval_sec: 300,
    measures: { unit: 'ms', label: 'Connect time' },
    secrets: [],
    fields: [
      { field: 'host', type: 'host', required: true, default: null, show_when: null },
      { field: 'port', type: 'int', required: true, default: 25, min: 1, max: 65535, show_when: null },
    ],
  }],
  // The floor an operator will be judged against, raised above the built-in 60
  // so the spec can tell "the form was told" from "the form guessed".
  limits: { min_interval_sec: 120, max_interval_sec: 86400, max_ms: 3600000, max_monitors: 200, recipient_domains: [] },
};

const routes = (over = {}) => ({
  [`GET ${SA}/monitors`]: [MONITOR],
  [`GET ${SA}/monitors/types`]: TYPES,
  [`GET ${SA}/monitors/7`]: MONITOR,
  [`GET ${SA}/monitors/7/series`]: {
    monitor_id: 7, period: 'day', bucket: 'hour', unit: 'ms', buckets: [], total: { checks: 0, availability: null },
  },
  [`GET ${SA}/monitors/7/results`]: { results: [] },
  ...over,
});

async function openMonitor(t, over = {}) {
  const ctx = await boot(t, routes(over));
  const nav = ctx.doc.querySelector('.tabs button[data-view="serviceAssurance"][data-sa-tab="monitors"]');
  assert.ok(nav, 'no Monitors nav button');
  await click(nav, 250);
  const row = ctx.doc.querySelector('#view table.data-table tbody tr');
  assert.ok(row, 'no monitor row');
  await click(row, 300);
  return ctx;
}

const buttonSaying = (doc, text) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

// ------------------------------------------------------- what the field means
test('the interval field says it runs forever, and carries the real bounds', async (t) => {
  const { doc } = await openMonitor(t);
  await click(buttonSaying(doc, 'Edit'), 250);

  const interval = doc.querySelector('.sa-modal [data-field="interval_sec"]');
  assert.ok(interval, 'the interval field is not identified');
  const help = interval.querySelector('.sa-help').textContent;
  assert.match(help, /repeats forever/, `the field does not say what it does: ${help}`);
  assert.match(help, /pause or delete/);
  // The floor is the SERVER's, not a number typed into the dialog.
  assert.match(help, /120/, `the form invented its own minimum: ${help}`);
  assert.equal(interval.querySelector('input').getAttribute('min'), '120');
});

test('the detail says the monitor is watching and will keep going', async (t) => {
  const { doc } = await openMonitor(t);
  assert.match(doc.querySelector('#view').textContent, /keeps going until you pause or delete it/);
});

// -------------------------------------------------------------- the rejection
test('a rejected field is marked where it stands, not only listed at the bottom', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: {
      status: 400,
      body: { error: 'Validation failed', details: { interval_sec: 'must be at least 120 seconds' } },
    },
  });
  await click(buttonSaying(doc, 'Edit'), 250);

  const dialog = doc.querySelector('.sa-modal');
  const input = dialog.querySelector('[data-field="interval_sec"] input');
  input.value = '50';
  await click(buttonSaying(doc, 'Save'), 200);

  const marked = dialog.querySelector('[data-field="interval_sec"].sa-field-invalid');
  assert.ok(marked, 'the field that was rejected looks exactly like the ones that were not');
  assert.match(marked.querySelector('.sa-field-error').textContent, /at least 120 seconds/);

  // The summary names the field in the words the LABEL uses, rather than
  // printing the wire key at somebody.
  const box = dialog.querySelector('.sa-form-errors');
  assert.match(box.textContent, /Not saved/);
  assert.match(box.textContent, /Check every \(seconds\)/, box.textContent);
  assert.equal(box.getAttribute('role'), 'alert');

  // And Save works again — a rejection is not a dead dialog.
  assert.equal(buttonSaying(doc, 'Save').disabled, false);
});

test('fixing the field clears the mark as you type', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 400, body: { error: 'Validation failed', details: { interval_sec: 'must be at least 120 seconds' } } },
  });
  await click(buttonSaying(doc, 'Edit'), 250);
  const dialog = doc.querySelector('.sa-modal');
  await click(buttonSaying(doc, 'Save'), 200);
  assert.ok(dialog.querySelector('.sa-field-invalid'), 'nothing was marked');

  const input = dialog.querySelector('[data-field="interval_sec"] input');
  input.value = '300';
  input.dispatchEvent(new dialog.ownerDocument.defaultView.Event('input'));
  assert.equal(dialog.querySelector('[data-field="interval_sec"].sa-field-invalid'), null, 'the mark outlived the mistake');
});

test('a config field is marked too — the dialog is mostly config fields', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 400, body: { error: 'Validation failed', details: { 'config.port': 'must be at most 65535' } } },
  });
  await click(buttonSaying(doc, 'Edit'), 250);
  const dialog = doc.querySelector('.sa-modal');
  await click(buttonSaying(doc, 'Save'), 200);
  const marked = dialog.querySelector('[data-field="config.port"].sa-field-invalid');
  assert.ok(marked, 'a config field cannot be marked');
  assert.match(marked.querySelector('.sa-field-error').textContent, /at most 65535/);
});

test('an error with no field detail still says something, rather than flickering', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 500, body: { error: 'Something failed' } },
  });
  await click(buttonSaying(doc, 'Edit'), 250);
  const dialog = doc.querySelector('.sa-modal');
  await click(buttonSaying(doc, 'Save'), 200);
  const box = dialog.querySelector('.sa-form-errors');
  assert.match(box.textContent, /Not saved/);
  assert.match(box.textContent, /Something failed/);
  assert.equal(buttonSaying(doc, 'Save').disabled, false);
});

// ------------------------------------------------------------- the stop button
test('a running monitor can be paused, and says what pausing does', async (t) => {
  const paused = { ...MONITOR, enabled: false };
  let saved = null;
  const { doc, calls } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: (body) => { saved = body; return paused; },
    [`GET ${SA}/monitors/7`]: () => (saved ? paused : MONITOR),
    [`GET ${SA}/monitors`]: () => [saved ? paused : MONITOR],
  });

  const pause = buttonSaying(doc, 'Pause');
  assert.ok(pause, 'there is no way to stop a monitor short of deleting it');
  assert.match(pause.getAttribute('title'), /Everything is kept/);

  await click(pause, 300);
  assert.deepEqual(saved, { enabled: false }, `pause sent ${JSON.stringify(saved)}`);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);

  const text = doc.querySelector('#view').textContent;
  assert.match(text, /Paused\./);
  assert.match(text, /automatic checks are stopped/);
  assert.ok(buttonSaying(doc, 'Resume'), 'a paused monitor cannot be started again');
});

test('resuming sends the opposite, and only that', async (t) => {
  let saved = null;
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: { ...MONITOR, enabled: false },
    [`GET ${SA}/monitors`]: [{ ...MONITOR, enabled: false }],
    [`PATCH ${SA}/monitors/7`]: (body) => { saved = body; return { ...MONITOR, enabled: true }; },
  });
  await click(buttonSaying(doc, 'Resume'), 300);
  assert.deepEqual(saved, { enabled: true });
});

test('a pause that fails leaves the button usable and says why', async (t) => {
  const { doc } = await openMonitor(t, {
    [`PATCH ${SA}/monitors/7`]: { status: 500, body: { error: 'database is on fire' } },
  });
  const pause = buttonSaying(doc, 'Pause');
  await click(pause, 250);
  assert.equal(pause.disabled, false, 'a failed pause left the button dead');
  assert.match(doc.body.textContent, /database is on fire/);
});

// ------------------------------------------------------------------ the trace
//
// "auth 16 ms · data 4.2 s · total 4.4 s · connect 133 ms" is six numbers in no
// order, and the one that matters is buried in the middle. Clicking the row
// opens what the check actually recorded: which leg spent the time, what the
// server answered, and — for a round trip — the route the message took.
const TRACED = {
  id: 91,
  status: 'failed',
  kind: 'mail_rejected',
  summary: 'The mail server refused the message (550): 5.7.1 sender address rejected',
  value: null,
  unit: 'ms',
  duration_ms: 240,
  checked_at: '2026-09-15T19:14:38.000Z',
  error_message: '550 5.7.1 sender address rejected: not allowed',
  timings: { connect: 133, greeting: 14, auth: 16, envelope: 29, total: 240 },
  detail: {
    phase: 'envelope',
    code: 550,
    queue_id: null,
    transcript: [
      { phase: 'connect', command: 'tcp://smtp.migadu.com:587', ms: 133 },
      { phase: 'greeting', code: 220, response: 'smtp.migadu.com ESMTP ready', ms: 14 },
      { phase: 'auth', command: 'AUTH PLAIN ***', code: 235, response: '2.7.0 Authentication successful', ms: 16 },
      { phase: 'envelope', command: 'MAIL FROM:<lars@gnf.dk>', code: 550, response: '5.7.1 sender address rejected: not allowed', ms: 29 },
    ],
  },
};

const DELIVERED = {
  id: 92,
  status: 'ok',
  summary: 'Delivered to gud@dulmens.dk in 4.5 s (accepted in 142 ms).',
  value: 4546,
  unit: 'ms',
  duration_ms: 4546,
  checked_at: '2026-09-15T19:17:37.000Z',
  error_message: null,
  timings: { connect: 59, greeting: 16, auth: 17, envelope: 37, data: 4200, delivery: 4546, total: 4300 },
  detail: {
    measured: 'delivery',
    queue_id: '4bXk2Z',
    mailbox: 'INBOX',
    polls: [{ at: 0, found: false }, { at: 5, found: true, ms: 120 }],
    hops: [
      { from: 'assurance.local', by: 'smtp.migadu.com', with: 'ESMTPSA', id: 'AAA', at: '2026-09-15T19:17:33.000Z', ms: null, raw: '…' },
      { from: 'smtp.migadu.com', by: 'mx.dulmens.dk', with: 'ESMTPS', id: 'BBB', at: '2026-09-15T19:17:37.000Z', ms: 4000, raw: '…' },
    ],
  },
};

const traced = (recent) => ({ ...MONITOR, type: 'mail', recent });

test('a check opens in place to show which leg of the exchange spent the time', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([DELIVERED]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });

  const row = [...doc.querySelectorAll('.sa-result-row')][0];
  assert.ok(row, 'no result row');
  // An OK check opens on demand — nothing is hidden, and nothing is forced open.
  const trace = row.nextElementSibling;
  assert.equal(trace.hidden, true, 'a healthy check opened itself at somebody');
  await click(row, 60);
  assert.equal(trace.hidden, false);

  // The waterfall: one bar per step, in the order the exchange happens, not
  // alphabetically and not by size.
  const names = [...trace.querySelectorAll('.sa-wf-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['connect', 'greeting', 'auth', 'envelope', 'data', 'delivery']);
  assert.equal(trace.querySelectorAll('.sa-wf-bar').length, 6);
  // `total` is the ruler, not a bar the length of all the others put together.
  assert.ok(!names.includes('total'));
});

test('the route the message took is drawn oldest hop first, with what each leg cost', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([DELIVERED]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });
  await click(doc.querySelector('.sa-result-row'), 60);
  const hops = [...doc.querySelectorAll('.sa-hops li')];
  assert.equal(hops.length, 2);
  assert.match(hops[0].textContent, /smtp\.migadu\.com/);
  assert.match(hops[1].textContent, /mx\.dulmens\.dk/);
  assert.match(hops[1].textContent, /\+4\.0 s/, `the leg cost is missing: ${hops[1].textContent}`);
  // Every look in the mailbox, so "found at once" and "found after four minutes"
  // are not the same row.
  assert.equal(doc.querySelectorAll('.sa-poll-dot').length, 2);
  assert.equal(doc.querySelectorAll('.sa-poll-dot.found').length, 1);
});

test('the newest failure opens itself, with what the server actually said', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([TRACED, DELIVERED]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });
  const rows = [...doc.querySelectorAll('.sa-result-row')];
  assert.equal(rows[0].nextElementSibling.hidden, false, 'the failure somebody came to look at is closed');
  assert.equal(rows[1].nextElementSibling.hidden, true, 'everything opened at once');

  const trace = rows[0].nextElementSibling;
  const steps = [...trace.querySelectorAll('.sa-transcript tbody tr')];
  assert.equal(steps.length, 4);
  // The refusal is the last line, which is what makes it readable as "it got
  // this far".
  const last = steps[3];
  assert.match(last.textContent, /MAIL FROM:<lars@gnf\.dk>/);
  assert.match(last.textContent, /550 5\.7\.1 sender address rejected/);
  assert.ok(last.classList.contains('sa-trace-bad'), 'the line that failed looks like the ones that did not');
});

test('a password never reaches the screen, whatever the check recorded', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([TRACED]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });
  const text = doc.querySelector('#view').textContent;
  assert.match(text, /AUTH PLAIN \*\*\*/);
  assert.doesNotMatch(text, /hunter/i);
});

test('a check with nothing recorded says so rather than opening empty', async (t) => {
  const bare = { id: 5, status: 'ok', summary: 'Connected in 12 ms.', value: 12, unit: 'ms', checked_at: '2026-09-15T19:00:00.000Z', timings: null, detail: null, error_message: null };
  const { doc } = await openMonitor(t, { [`GET ${SA}/monitors/7`]: { ...MONITOR, recent: [bare] } });
  await click(doc.querySelector('.sa-result-row'), 60);
  assert.match(doc.querySelector('.sa-trace-row').textContent, /recorded no detail/);
});

// ------------------------------------------------- the phases, side by side
test('the phases are charted against each other, one coloured line each', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([TRACED, DELIVERED, { ...DELIVERED, id: 93, checked_at: '2026-09-15T19:01:37.000Z' }]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });
  const view = doc.querySelector('#view');
  assert.match(view.textContent, /Where the time goes, check by check/);

  const lines = [...view.querySelectorAll('.sa-phase-line')];
  assert.ok(lines.length >= 4, `only ${lines.length} phases charted`);
  // Each line is its own colour, or they are one unreadable tangle.
  const colours = new Set(lines.map((l) => l.getAttribute('stroke')));
  assert.equal(colours.size, lines.length);

  // And the colour a phase has in the chart is the colour it has in the bar.
  await click([...doc.querySelectorAll('.sa-result-row')][1], 60);
  const connectBar = [...doc.querySelectorAll('.sa-wf-row')]
    .find((r) => r.querySelector('.sa-wf-name').textContent === 'connect')
    .querySelector('.sa-wf-bar').getAttribute('style');
  const connectDot = [...doc.querySelectorAll('.sa-phase-key')]
    .find((b) => b.textContent.trim() === 'connect')
    .querySelector('.sa-phase-dot').getAttribute('style');
  assert.equal(connectBar.split('background:')[1], connectDot.split('background:')[1]);
});

test('the scale is the reader\'s choice — a 15 ms step is a flat line next to a 4.5 s one', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([TRACED, DELIVERED]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });
  const picker = [...doc.querySelectorAll('.sa-segment')].filter((b) => /Logarithmic|Linear/.test(b.textContent));
  assert.equal(picker.length, 2, 'there is no way to change the scale');
  const log = picker.find((b) => /Logarithmic/.test(b.textContent));
  assert.equal(log.getAttribute('aria-pressed'), 'true', 'the default buries every small step');

  const before = doc.querySelector('.sa-phase-line').getAttribute('d');
  await click(picker.find((b) => /Linear/.test(b.textContent)), 80);
  const after = doc.querySelector('.sa-phase-line').getAttribute('d');
  assert.notEqual(before, after, 'the chart did not change with the scale');
});

test('a phase can be hidden, and the chart redraws without it', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([TRACED, DELIVERED]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });
  const before = doc.querySelectorAll('.sa-phase-line').length;
  const key = [...doc.querySelectorAll('.sa-phase-key')].find((b) => b.textContent.trim() === 'connect');
  await click(key, 80);
  assert.equal(key.getAttribute('aria-pressed'), 'false');
  assert.equal(doc.querySelectorAll('.sa-phase-line').length, before - 1);
});

test('one check is not a chart, and does not pretend to be', async (t) => {
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors/7`]: traced([DELIVERED]),
    [`GET ${SA}/monitors`]: [{ ...MONITOR, type: 'mail' }],
  });
  assert.equal(doc.querySelectorAll('.sa-phase-line').length, 0);
  assert.doesNotMatch(doc.querySelector('#view').textContent, /Where the time goes/);
});

// The whole module is operator+ in the sidebar (`data-min-role="operator"` on
// every Service Assurance tab), so there is no viewer to test the buttons
// against — the role gate is one screen further out. What IS worth pinning is
// that the two "not running" states never claim to be each other.
test('a pending monitor says it is not watching yet, and never that it keeps going', async (t) => {
  const pending = { ...MONITOR, pending: true, activated_at: null, last_run_at: null, last_status: null };
  const { doc } = await openMonitor(t, {
    [`GET ${SA}/monitors`]: [pending],
    [`GET ${SA}/monitors/7`]: pending,
  });
  const text = doc.querySelector('#view').textContent;
  assert.match(text, /starts running on its schedule once one check has worked/);
  assert.doesNotMatch(text, /keeps going until you pause/);
  assert.doesNotMatch(text, /automatic checks are stopped/);
});
