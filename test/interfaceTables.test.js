'use strict';

// public/views/interfaces.js — the port table and the capacity forecast, where
// they live now (docs/fleet-and-sites-consolidation.md).
//
// Interfaces used to be a fleet screen that could only ever show ONE agent,
// behind a dropdown. The per-agent summary is the Hardware column set on Fleet,
// the port table is a section of the Fleet drawer and a fold on the agent page,
// and the forecast is on the agent page — it reads two weeks of history, so it
// has no business opening on a click.
//
// What this pins is what had to survive the move: an idle virtual port does not
// sort above the port that is dropping frames, the status chip stays on the
// app's one severity vocabulary, the flow-source empty state keeps every word
// of its explanation, and a failed port read costs the ports section and
// nothing else.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const NOW = Date.now();
const iso = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

const IFACES = [
  { iface: 'eth0', status: 'warn', virtual: false, linkDown: false, speedMbps: 1000, operStatus: 'up', utilPct: 82, rxBytesPerSec: 94e6, txBytesPerSec: 12e6, errPerSec: 0, dropPerSec: 14 },
  { iface: 'eth1', status: 'bad', virtual: false, linkDown: false, speedMbps: 1000, operStatus: 'up', utilPct: 31, rxBytesPerSec: 3e6, txBytesPerSec: 8e5, errPerSec: 7, dropPerSec: 0 },
  { iface: 'eth2', status: 'ok', virtual: false, linkDown: false, speedMbps: 10000, operStatus: 'up', utilPct: 4, rxBytesPerSec: 4e5, txBytesPerSec: 12e4, errPerSec: 0, dropPerSec: 0 },
  { iface: 'docker0', status: 'down', virtual: true, linkDown: true, speedMbps: null, operStatus: 'down', utilPct: null, rxBytesPerSec: 0, txBytesPerSec: 0, errPerSec: 0, dropPerSec: 0 },
];

// What GET /api/forecast/interfaces answers: one entry per link, each carrying
// its own explanation from the forecast engine.
const FORECAST = {
  agentId: 7,
  windowDays: 14,
  horizonDays: 30,
  samples: 1200,
  capacity: { metric: 'utilPct', ceiling: 100, basis: 'negotiated link speed' },
  interfaces: [
    { iface: 'eth0', ok: true, direction: 'rising', slopePerDay: 4.2, current: 82, projected: 100, horizonDays: 30, daysUntilCapacity: 4.3, explanation: 'Trend rising +4.2/day (robust Theil-Sen over 300 samples).', evidence: { method: 'theil-sen' } },
    { iface: 'eth2', ok: true, direction: 'flat', slopePerDay: 0, current: 4, projected: 4, horizonDays: 30, daysUntilCapacity: null, explanation: 'No significant trend.', evidence: { method: 'theil-sen' } },
    { iface: 'eth1', ok: false, reason: 'insufficient_data', samples: 2, explanation: 'Not enough data to forecast (need at least 4 points, have 2).' },
  ],
};

const AGENT = (over = {}) => Object.assign({
  id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01.lan',
  platform: 'linux', arch: 'amd64', status: 'online',
  location_id: 1, location_name: 'Oslo HQ',
  monitor_config: { source: 'proc' },
  capabilities: { agentVersion: '0.42.0', nic: [] },
}, over);

const fleetAgent = (over = {}) => Object.assign({
  agentId: 7, displayName: 'oslo-edge-01', hostname: 'oslo-edge-01.lan', online: true,
  locationName: 'Oslo HQ', lastReportAt: iso(60000), throughput: null, quality: { status: 'ok' },
  health: {
    status: 'warn', score: 60, reason: 'Interface errors 7/s (eth1).', evidence: [],
    metrics: { lossPct: 0, rttMs: 12, jitterMs: 2, targets: 3, reachable: 3, lastTs: iso(60000), ifaceStatus: 'bad', ifaceCount: 4, ifaceIssues: 3, worstIface: 'eth1' },
  },
}, over);

function boot({ t, routes = {}, url = 'http://server.test/fleet/hardware', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    log.push({ key: `${(opts.method || 'GET').toUpperCase()} ${p}`, url: String(u) });
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const envelope = hit !== undefined && hit !== null && typeof hit === 'object' && 'body' in hit;
    const status = hit === undefined ? 404 : (envelope ? (hit.status || 200) : 200);
    const body = hit === undefined ? { error: 'Not Found' } : (envelope ? hit.body : hit);
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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /locations': [{ id: 1, name: 'Oslo HQ' }],
  'GET /agents': [AGENT()],
  'GET /agents/7': AGENT(),
  'GET /system/version': { version: '0.165.0', agent: '0.42.0', agentSource: '0.42.0' },
  'GET /api/fleet/health': { summary: { warn: 1, total: 1 }, agents: [fleetAgent()] },
  'GET /api/fleet/nics': { agents: 0, totalNics: 0, drivers: [], drift: [], byAgent: [] },
  'GET /api/settings/maintenance': { windows: [] },
  'GET /api/dashboard/advanced': { widgets: {} },
  'GET /api/flows/map': { sites: [], flows: [] },
  'GET /api/interfaces': { agentId: 7, source: 'proc', ts: iso(), interfaces: IFACES },
}, over);

// Open the drawer on the one agent, and hand back its Ports section.
async function openPorts(t, over = {}) {
  const env = boot({ t, routes: SESSION(over) });
  await settle();
  env.doc.querySelector('#view table.dt tbody tr')
    .dispatchEvent(new env.window.Event('click', { bubbles: true }));
  await settle();
  const drawer = env.doc.querySelector('.ui-drawer');
  const ports = [...drawer.querySelectorAll('.dsec')].find((sec) => /Ports/.test(sec.querySelector('h3').textContent));
  return { ...env, drawer, ports };
}
const portRows = (ports) => [...ports.querySelectorAll('table.dt tbody tr')];
const firstCell = (tr) => tr.querySelector('td').textContent.trim();

test('the Hardware set summarises the ports, and the drawer has the list', async (t) => {
  const { doc, ports } = await openPorts(t);
  // The set says how many, how many are faulted and which is worst — the fleet
  // payload already carries all three (mergeHealth writes them into metrics).
  const head = [...doc.querySelectorAll('#view table.dt thead th')].map((h) => h.textContent.replace(/[↕↑↓]/g, '').trim());
  assert.deepEqual(head, ['Agent', 'Health', 'Version', 'Ports', 'Port faults', 'Link', 'NIC', 'Firmware', 'Location', 'Last seen', '']);
  const cells = [...doc.querySelectorAll('#view table.dt tbody tr td')].map((td) => td.textContent.trim());
  assert.equal(cells[3], '4', 'the port count is not the one the server sent');
  assert.match(cells[4], /^3\s*eth1$/, 'the fault count does not name the worst port');

  assert.ok(ports, 'the drawer has no Ports section');
  assert.equal(portRows(ports).length, 4);
});

test('an idle virtual port does not sort above the port dropping frames', async (t) => {
  const { ports } = await openPorts(t);
  // docker0 is DOWN, but it is virtual and idle — that is not a fault, and it
  // used to sort to the very top, above the port actually erroring.
  assert.deepEqual(portRows(ports).map(firstCell), ['eth1', 'eth0', 'eth2', 'docker0']);
});

test('the status chip is on the app\'s severity tones', async (t) => {
  const { ports } = await openPorts(t);
  const tone = (name) => portRows(ports).find((tr) => firstCell(tr) === name)
    .querySelectorAll('td')[1].querySelector('.badge-ui').className;
  assert.match(tone('eth1'), /crit/);
  assert.match(tone('eth0'), /warn/);
  assert.match(tone('eth2'), /ok/);
  // A virtual port that is merely down reads IDLE in neutral, not DOWN in red.
  assert.match(tone('docker0'), /neutral/);
});

test('errors and discards carry their own tone, and a zero does not', async (t) => {
  const { ports } = await openPorts(t);
  const row = (name) => portRows(ports).find((tr) => firstCell(tr) === name);
  assert.ok(row('eth1').querySelector('.num-crit'), 'a port erroring at 7/s reads as grey text');
  assert.ok(row('eth0').querySelector('.num-warn'), 'discards are not called out');
  assert.equal(row('eth2').querySelectorAll('.num-crit, .num-warn').length, 0, 'a clean port is toned anyway');
});

test('the negotiated duplex rides in the Link column and the named reasons sit under the badge', async (t) => {
  const halfDuplex = IFACES.map((i) => (i.iface === 'eth1'
    ? { ...i, duplex: 'half', reasons: ['duplex_mismatch', 'crc_errors'] }
    : i));
  const { ports } = await openPorts(t, { 'GET /api/interfaces': { agentId: 7, source: 'proc', ts: iso(), interfaces: halfDuplex } });
  const tr = portRows(ports).find((x) => firstCell(x) === 'eth1');
  assert.match(tr.querySelectorAll('td')[2].textContent, /half duplex/i);
  // "bad" alone sends somebody to the cable when the fix is the port's duplex.
  assert.match(tr.querySelectorAll('td')[1].textContent, /duplex/i);
});

test('the measurement line says where the numbers came from and when', async (t) => {
  const { ports } = await openPorts(t);
  assert.match(ports.textContent, /proc/);
});

test('a flow-source agent is told this table can never fill, and why', async (t) => {
  const { ports } = await openPorts(t, {
    'GET /api/interfaces': { agentId: 7, source: 'sflow', ts: iso(), interfaces: [] },
  });
  const state = ports.querySelector('.state');
  assert.ok(state, 'no EmptyState');
  // This is the difference between "wait" and "this will never work, here is
  // what to change" — so it keeps every word.
  assert.match(state.textContent, /reports flows, not interface counters/);
  assert.match(state.textContent, /proc/);
  assert.match(state.textContent, /snmp/);
  assert.equal(state.querySelectorAll('a').length, 3, 'the three screens that DO show flow data went');
});

test('a proc agent with no measurement yet says to wait, not to change a setting', async (t) => {
  const { ports } = await openPorts(t, {
    'GET /api/interfaces': { agentId: 7, source: 'proc', ts: null, interfaces: [] },
  });
  const state = ports.querySelector('.state');
  assert.ok(state);
  assert.doesNotMatch(state.textContent, /sflow|netflow/, 'a working agent is told to change its source');
});

test('a failed port read costs the ports section and nothing else', async (t) => {
  const { drawer, ports, errors, log, window } = await openPorts(t, {
    'GET /api/interfaces': { status: 500, body: { error: 'boom' } },
  });
  assert.deepEqual(errors, []);
  const err = ports.querySelector('.state.is-error');
  assert.ok(err, 'a failed read is not an ErrorState');
  assert.match(err.querySelector('code').textContent, /GET \/api\/interfaces/);
  // The verdict and the measurements above it are still true, and still useful.
  assert.match(drawer.textContent, /Interface errors 7\/s/);

  const before = log.filter((x) => x.key === 'GET /api/interfaces').length;
  [...err.querySelectorAll('button')].find((b) => /Retry|Prøv/i.test(b.textContent))
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(log.filter((x) => x.key === 'GET /api/interfaces').length > before, 'Retry did not retry');
});

test('a 404 says the agent is gone, and does not offer a Retry that cannot help', async (t) => {
  const { ports } = await openPorts(t, { 'GET /api/interfaces': undefined });
  const err = ports.querySelector('.state.is-error');
  assert.ok(err);
  assert.equal([...err.querySelectorAll('button')].filter((b) => /Retry|Prøv/i.test(b.textContent)).length, 0);
});

test('the ports are read when the drawer opens, and not polled under the reader', async (t) => {
  const { log } = await openPorts(t);
  await settle(400);
  assert.equal(log.filter((x) => x.key === 'GET /api/interfaces').length, 1,
    'the drawer started a poller — a table nobody asked to refresh moved under them');
});

// ---------------------------------------------------------------- agent page
const AGENT_SESSION = (over = {}) => SESSION(Object.assign({
  'GET /api/fleet/agent/7': { health: { status: 'warn', reason: 'x', metrics: { targets: 1, reachable: 1 } }, quality: { status: 'ok' }, throughput: null },
  'GET /api/probes/latest': { results: [] },
  'GET /agents/7/results': [],
  'GET /api/forecast/interfaces': FORECAST,
  'GET /api/agents/7/config': [],
  'GET /api/cmdb/agents/7': null,
  'GET /api/dependencies': [],
  'GET /api/events': [],
}, over));

async function bootAgent(t, over = {}) {
  const env = boot({ t, url: 'http://server.test/agents/7', routes: AGENT_SESSION(over) });
  await settle(700);
  const fold = [...env.doc.querySelectorAll('#view details.sec')]
    .find((d) => /Interfaces/.test(d.querySelector('summary').textContent));
  return { ...env, fold };
}

test('the capacity forecast sits under the interface table on the agent page', async (t) => {
  const { fold } = await bootAgent(t);
  assert.ok(fold, 'the agent page lost its Interfaces fold');
  const tables = [...fold.querySelectorAll('table.dt')];
  assert.equal(tables.length, 2, 'the forecast is not beside the state it forecasts');
  const heads = [...tables[1].querySelectorAll('thead th')].map((h) => h.textContent.trim());
  assert.ok(heads.includes('Interface'));
  assert.ok(heads.some((h) => /30d/.test(h)), 'the horizon is not named in the header');
});

test('only links with a usable projection are listed; the rest are left out rather than shown blank', async (t) => {
  const { fold } = await bootAgent(t);
  const rows = [...fold.querySelectorAll('table.dt')][1].querySelectorAll('tbody tr');
  assert.deepEqual([...rows].map((tr) => tr.querySelector('td').textContent.trim()), ['eth0', 'eth2']);
});

test('a link filling within a fortnight is called out, a flat one is not', async (t) => {
  const { fold } = await bootAgent(t);
  const rows = [...[...fold.querySelectorAll('table.dt')][1].querySelectorAll('tbody tr')];
  const eth0 = rows.find((tr) => tr.querySelector('td').textContent.trim() === 'eth0');
  const eth2 = rows.find((tr) => tr.querySelector('td').textContent.trim() === 'eth2');
  assert.ok(eth0.querySelector('.badge-ui.crit'), 'a link four days from full is not called out');
  assert.equal(eth2.querySelectorAll('.badge-ui.crit, .badge-ui.warn').length, 0);
  assert.match(eth0.textContent, /Theil-Sen/, 'the engine\'s own explanation was paraphrased away');
});

test('the forecast is read once with the page, not on the interface poll', async (t) => {
  const { log } = await bootAgent(t);
  await settle(700);
  const reads = log.filter((x) => x.key === 'GET /api/forecast/interfaces').length;
  assert.equal(reads, 1, `two weeks of history re-read ${reads} times`);
  assert.ok(log.filter((x) => x.key === 'GET /api/interfaces').length >= 1);
});

test('a failed forecast keeps the interface table on screen — the current state is the more urgent of the two', async (t) => {
  const { fold } = await bootAgent(t, { 'GET /api/forecast/interfaces': { status: 500, body: { error: 'boom' } } });
  assert.ok(fold.querySelector('table.dt'), 'the ports went with the forecast');
  const err = fold.querySelector('.state.is-error');
  assert.ok(err);
  assert.match(err.querySelector('code').textContent, /GET \/api\/forecast\/interfaces/);
});

test('an agent whose links have no history yet gets an explanation, not an empty table', async (t) => {
  const none = { ...FORECAST, interfaces: FORECAST.interfaces.filter((f) => !f.ok) };
  const { fold } = await bootAgent(t, { 'GET /api/forecast/interfaces': none });
  const states = [...fold.querySelectorAll('.state')];
  assert.ok(states.length, 'no EmptyState for a forecast that cannot be made');
  assert.equal([...fold.querySelectorAll('table.dt')].length, 1, 'an empty forecast table was drawn anyway');
});
