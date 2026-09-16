'use strict';

// The path-MTU dashboard panel, rendered under jsdom against a fake API.
//
// The thing worth testing here is not that it renders. It is that the three
// verdicts LOOK different to a reader: a blackhole has to say it is a fault and
// give the MSS to clamp to, a reduced path has to say it is expected, and a
// silent hop has to say it was not measured rather than showing a zero-length
// bar that reads as "no MTU". A panel that renders all three the same way is
// worse than no panel, because it would be believed.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const ME = { id: 1, email: 'op@blueeye.local', role: 'operator', preferences: {} };
const AGENTS = [{ id: 9, hostname: 'h1', display_name: 'Branch agent' }];

const mtuRow = (over = {}) => ({
  id: 1,
  ts: new Date().toISOString(),
  type: 'path_mtu',
  target: '10.20.30.40',
  ok: true,
  hops: [
    { hop: 1, ip: '192.0.2.1', maxMtu: 1500, status: 'ok' },
    { hop: 2, ip: null, maxMtu: null, status: 'no_response' },
    { hop: 3, ip: '198.51.100.7', maxMtu: 1420, status: 'blackhole' },
  ],
  mtu: {
    ipVersion: 4,
    pathMtu: 1420,
    blackholeDetected: true,
    icmpFragNeededSeen: false,
    mtuDropAtHop: 3,
    mssSupported: true,
    mssObserved: 1460,
    recommendedMss: 1380,
    durationMs: 8421,
  },
  ...over,
});

function fakeFetch(routes, calls) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
    calls.push({ method, path: p, body });
    const hit = routes[`${method} ${p}`];
    const status = hit === undefined ? 404 : 200;
    const payload = hit === undefined ? { error: 'Not Found' } : hit;
    return {
      ok: status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function boot(t, routes = {}, role = 'operator') {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const calls = [];
  window.fetch = fakeFetch({
    'GET /me': { ...ME, role },
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    'GET /license/features': {},
    'GET /license/plan': { plan: 'professional', plan_name: 'Professional', features: {}, modules: {} },
    'GET /agents': AGENTS,
    ...routes,
  }, calls);
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

// Opens Probes & Tests and clicks the detail button on the single result row.
async function openMtuDetail(t, row, role = 'operator') {
  const ctx = await boot(t, { 'GET /api/probes/latest': { agentId: 9, results: [row] } }, role);
  ctx.doc.querySelector('button[data-view="probes"]').click();
  await tick(250);
  const btn = [...ctx.doc.querySelectorAll('.probe-latest button')].find((b) => /path mtu/i.test(b.textContent));
  assert.ok(btn, `no detail button: ${ctx.doc.querySelector('.probe-latest').textContent}`);
  btn.click();
  await tick(200);
  return ctx;
}

// ---------------------------------------------------------------- blackhole
test('a blackhole panel names the fault, the hop and the MSS to clamp to', async (t) => {
  const { doc, errors } = await openMtuDetail(t, mtuRow());
  const panel = doc.querySelector('.mtu-verdict');
  assert.ok(panel, 'no verdict panel');
  assert.ok(panel.classList.contains('bad'), `verdict is "${panel.className}"`);
  const text = panel.textContent;
  assert.match(text, /blackhole/i);
  assert.match(text, /stall/i, 'says what the operator is actually seeing');
  assert.match(text, /hop 3 \(198\.51\.100\.7\)/);
  assert.match(text, /1380/, 'the MSS to clamp to');
  assert.match(text, /type 3 code 4/);
  assert.deepEqual(errors, []);
});

test('the hop where the path narrows is marked in text, not only in colour', async (t) => {
  const { doc } = await openMtuDetail(t, mtuRow());
  const dropRow = doc.querySelector('.mtu-hops tr.mtu-drop');
  assert.ok(dropRow, 'the drop hop is not marked');
  assert.match(dropRow.textContent, /198\.51\.100\.7/);
  assert.ok(dropRow.querySelector('.mtu-drop-marker'), 'colour is the only signal');
});

test('a hop with no ICMP reply says so instead of rendering an empty bar', async (t) => {
  const { doc } = await openMtuDetail(t, mtuRow());
  const rows = [...doc.querySelectorAll('.mtu-hops tbody tr')];
  assert.equal(rows.length, 3);
  const silent = rows[1];
  assert.match(silent.textContent, /no ICMP reply/i);
  assert.match(silent.textContent, /\* \* \*/, 'an unknown address is not blank');
  assert.doesNotMatch(silent.textContent, /\b0 B\b/, 'a silent hop must not read as an MTU of zero');
});

test('an MSS above the path is called out as a missing clamp', async (t) => {
  const { doc } = await openMtuDetail(t, mtuRow());
  const warns = [...doc.querySelectorAll('.mtu-verdict.warn')].map((n) => n.textContent).join(' ');
  assert.match(warns, /1460/);
  assert.match(warns, /clamping is missing/i);
});

// ------------------------------------------------------------------ reduced
test('a reduced path reads as expected behaviour, not as a fault', async (t) => {
  const row = mtuRow({
    hops: [
      { hop: 1, ip: '192.0.2.1', maxMtu: 1500, status: 'ok' },
      { hop: 3, ip: '198.51.100.7', maxMtu: 1420, status: 'reduced' },
    ],
    mtu: { ...mtuRow().mtu, blackholeDetected: false, icmpFragNeededSeen: true, mssObserved: 1380 },
  });
  const { doc } = await openMtuDetail(t, row);
  const panel = doc.querySelector('.mtu-verdict');
  assert.ok(panel.classList.contains('warn'), `verdict is "${panel.className}"`);
  assert.match(panel.textContent, /expected on a tunnelled path/i);
  assert.match(panel.textContent, /IPsec, GRE, PPPoE/);
  assert.doesNotMatch(doc.querySelector('.mtu-hops').textContent, /blackhole/i);
});

// ----------------------------------------------------------------------- ok
test('a clean path reads as clean, with no warning colour anywhere', async (t) => {
  const row = mtuRow({
    hops: [{ hop: 1, ip: '192.0.2.1', maxMtu: 1500, status: 'ok' }],
    mtu: {
      ipVersion: 4, pathMtu: 1500, blackholeDetected: false, icmpFragNeededSeen: false,
      mtuDropAtHop: null, mssSupported: true, mssObserved: 1460, recommendedMss: 1460, durationMs: 900,
    },
  });
  const { doc } = await openMtuDetail(t, row);
  assert.ok(doc.querySelector('.mtu-verdict').classList.contains('good'));
  assert.equal(doc.querySelectorAll('.mtu-verdict.bad, .mtu-verdict.warn').length, 0);
  assert.match(doc.querySelector('.mtu-stats').textContent, /1500 B/);
});

test('a non-Linux agent shows the MSS as unavailable, not as zero', async (t) => {
  const row = mtuRow({ mtu: { ...mtuRow().mtu, mssSupported: false, mssObserved: null } });
  const { doc } = await openMtuDetail(t, row);
  // The negotiated-MSS stat specifically — a dash with the reason on hover,
  // never a number the agent could not have measured.
  const stat = [...doc.querySelectorAll('.mtu-stat')].find((n) => /negotiated mss/i.test(n.querySelector('.k').textContent));
  assert.ok(stat, 'no negotiated-MSS stat');
  assert.equal(stat.querySelector('.v').textContent.trim(), '–');
  assert.match(stat.querySelector('.v span').getAttribute('title'), /Linux only/i);
  assert.equal(doc.querySelectorAll('.mtu-verdict.warn').length, 0, 'no clamp warning without a reading');
});

// ------------------------------------------------------------- not measured
test('a run that measured nothing says so, instead of announcing a clean path', async (t) => {
  // The bug this pins: with no path MTU the panel fell through to the good
  // branch and rendered "No MTU restriction found ... ? bytes" — the most
  // confident possible way to say nothing was learned.
  const row = mtuRow({
    detail: 'ping failed: socket: Operation not permitted',
    hops: [],
    mtu: {
      ipVersion: 4, pathMtu: null, blackholeDetected: false, icmpFragNeededSeen: false,
      mtuDropAtHop: null, mssSupported: false, mssObserved: null, recommendedMss: null, durationMs: 40,
    },
  });
  const { doc } = await openMtuDetail(t, row);
  const panel = doc.querySelector('.mtu-verdict');
  assert.ok(panel.classList.contains('unknown'), `verdict is "${panel.className}"`);
  assert.match(panel.textContent, /not measured/i);
  assert.match(panel.textContent, /Operation not permitted/, 'the reason the agent gave is shown');
  assert.doesNotMatch(panel.textContent, /No MTU restriction found/i);
  assert.equal(doc.querySelectorAll('.mtu-verdict.good').length, 0);
});

test('with no reason from the agent it still refuses to claim a clean path', async (t) => {
  const row = mtuRow({
    detail: null,
    hops: [],
    mtu: { ...mtuRow().mtu, pathMtu: null, blackholeDetected: false, icmpFragNeededSeen: false, mtuDropAtHop: null, recommendedMss: null },
  });
  const { doc } = await openMtuDetail(t, row);
  assert.ok(doc.querySelector('.mtu-verdict').classList.contains('unknown'));
  assert.match(doc.querySelector('.mtu-verdict').textContent, /No size got an answer/i);
});

// ---------------------------------------------------------------- the form
test('Path MTU is offered in the probe form and posts the size window', async (t) => {
  const ctx = await boot(t, { 'GET /api/probes/latest': { agentId: 9, results: [] }, 'POST /agents/9/probe': { delivered: 1 } });
  ctx.doc.querySelector('button[data-view="probes"]').click();
  await tick(250);

  const typeSel = [...ctx.doc.querySelectorAll('.probes select')].find((s) => [...s.options].some((o) => o.value === 'path_mtu'));
  assert.ok(typeSel, 'path_mtu is not offered');
  typeSel.value = 'path_mtu';
  typeSel.dispatchEvent(new ctx.window.Event('change'));
  await tick(50);

  const inputs = ctx.doc.querySelector('.mtu-inputs');
  assert.ok(inputs, 'the size inputs are not rendered');
  assert.notEqual(inputs.style.display, 'none', 'the size inputs stay hidden for path_mtu');

  const target = [...ctx.doc.querySelectorAll('.probes input[type="text"]')][0];
  target.value = '10.20.30.40';
  [...ctx.doc.querySelectorAll('.probes button')].find((b) => /run probe/i.test(b.textContent)).click();
  await tick(150);

  const post = ctx.calls.find((c) => c.method === 'POST' && c.path === '/agents/9/probe');
  assert.ok(post, `no probe request: ${JSON.stringify(ctx.calls.slice(-4))}`);
  assert.equal(post.body.type, 'path_mtu');
  assert.equal(post.body.host, '10.20.30.40');
  assert.equal(post.body.min_size, 576);
  assert.equal(post.body.max_size, 1500);
  assert.equal(post.body.per_hop, true);
  assert.deepEqual(ctx.errors, []);
});

test('the size inputs are hidden again when another probe type is chosen', async (t) => {
  const ctx = await boot(t, { 'GET /api/probes/latest': { agentId: 9, results: [] } });
  ctx.doc.querySelector('button[data-view="probes"]').click();
  await tick(250);
  const typeSel = [...ctx.doc.querySelectorAll('.probes select')].find((s) => [...s.options].some((o) => o.value === 'path_mtu'));
  typeSel.value = 'path_mtu';
  typeSel.dispatchEvent(new ctx.window.Event('change'));
  await tick(30);
  typeSel.value = 'ping';
  typeSel.dispatchEvent(new ctx.window.Event('change'));
  await tick(30);
  assert.equal(ctx.doc.querySelector('.mtu-inputs').style.display, 'none');
});

// ------------------------------------------------------------- results table
test('the results row shows the measured MTU rather than three empty metrics', async (t) => {
  const ctx = await boot(t, { 'GET /api/probes/latest': { agentId: 9, results: [mtuRow()] } });
  ctx.doc.querySelector('button[data-view="probes"]').click();
  await tick(250);
  const row = ctx.doc.querySelector('.probe-latest tbody tr').textContent;
  assert.match(row, /1420 B/);
  assert.match(row, /blackhole/i);
});
