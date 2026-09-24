'use strict';

// The agent page's flow-pair baseline context and LLDP neighbours (public/app.js
// loadAgentDependencies / loadAgentNeighbours), booted in the real dashboard.
//
// The behaviour that must survive:
//   * the outbound dependency table shows each pair's last complete hour with
//     the shared BaselineMetric line ("…% above normal for a Tuesday at
//     14:00") — from GET /api/baselines/flow-pair, which had no caller — and a
//     pair with no baseline gets the number and NO context line;
//   * the Baseline dialog is open to viewers, names its weekdays through the
//     catalogue (it was a hardcoded Sun..Sat), and says "normal for this hour:
//     median ± MAD vs now";
//   * the neighbours card lists the host's LLDP adjacencies.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const AGENT = { id: 7, display_name: 'oslo-edge-01', hostname: 'oslo-edge-01.lan', platform: 'linux', arch: 'amd64', status: 'online', location_id: null, capabilities: {} };
const PEER = { id: 9, display_name: 'db-1', hostname: 'db-1', status: 'online' };

function boot({ t, routes = {}, url = 'http://server.test/agents/7', role = 'admin', locale = null } = {}) {
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
  if (locale) window.localStorage.setItem('blueeye.locale', locale);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

// Tuesday 14:00 UTC. The 443 pair ran at 2200 bytes against a normal of 1000;
// the 5432 pair has traffic but no baseline for that slot.
const CONTEXT = {
  host: 7, building: false,
  baselines: [{ srcHostId: 7, dstHostId: 9, dstPort: 443, dow: 2, hour: 14, medianBytes: 1000, madBytes: 100, sampleCount: 40, observationCount: 500, updatedAt: '2026-09-22T15:00:00.000Z' }],
  current: { bucket: '2026-09-22T14:00:00.000Z', dow: 2, hour: 14, pairs: [{ dstHostId: 9, dstPort: 443, bytes: 2200 }, { dstHostId: 9, dstPort: 5432, bytes: 50 }] },
};
const EDGES = [
  { srcHostId: 7, dstHostId: 9, dstPort: 443, bytes: 90000, packets: 10, connCount: 12, lastSeen: '2026-09-22T14:30:00.000Z' },
  { srcHostId: 7, dstHostId: 9, dstPort: 5432, bytes: 3000, packets: 10, connCount: 2, lastSeen: '2026-09-22T14:30:00.000Z' },
];
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /agents': [AGENT, PEER],
  'GET /agents/7': AGENT,
  'GET /api/fleet/agent/7': { health: { status: 'ok', metrics: {} } },
  'GET /api/probes/latest': { results: [] },
  'GET /api/interfaces': { source: 'proc', ts: null, interfaces: [] },
  'GET /agents/7/results': [],
  'GET /api/devices/7/config-history': { snapshots: [], diffs: [] },
  'GET /api/cmdb/assets/status': { enabled: false, type: null },
  'GET /api/targets/7/timeline': { events: [] },
  'GET /api/topology/dependencies': { host: 7, edges: EDGES },
  'GET /api/baselines/flow-pair': CONTEXT,
  'GET /api/topology/neighbors': { neighbors: [
    { id: 1, localAgentId: 7, localChassisId: 'aa', localPort: 'eth0', remoteChassisId: '00:1b:44:11:3a:b7', remotePort: 'Gi0/24', lastSeen: new Date().toISOString() },
  ], page: { limit: 50, offset: 0, total: 1 } },
}, over);

const panelBy = (doc, title) => [...doc.querySelectorAll('#view .panel-ui')].find((p) => (p.querySelector('h2') || {}).textContent === title);

test('each outbound pair shows its last hour against normal, and nothing where there is no baseline', async (t) => {
  const { doc, errors, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.deepEqual(errors, []);
  assert.ok(log.some((l) => l.key === 'GET /api/baselines/flow-pair' && /host=7/.test(l.url)), 'the baseline context was never asked for');
  const deps = panelBy(doc, 'Dependencies');
  assert.match(deps.querySelector('thead').textContent, /Hour 14:00 UTC/);
  const rows = [...deps.querySelectorAll('tbody tr')];
  const https = rows.find((r) => /443/.test(r.textContent));
  const pg = rows.find((r) => /5432/.test(r.textContent));
  // 2200 vs a median of 1000 = 120 % above normal for that slot.
  assert.match(https.querySelector('.bm').textContent, /120% above normal for a Tuesday at 14:00/);
  // No baseline for 5432: the value, and no context line at all.
  assert.ok(pg.querySelector('.bm .bm-value'));
  assert.equal(pg.querySelector('.bm .bm-context'), null, 'a pair with no baseline must not get a placeholder line');
});

test('the Baseline dialog is open to a viewer and says "normal for this hour vs now"', async (t) => {
  const { doc, log } = boot({
    t, role: 'viewer',
    routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }),
  });
  await settle();
  const row = [...panelBy(doc, 'Dependencies').querySelectorAll('tbody tr')].find((r) => /443/.test(r.textContent));
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Baseline');
  assert.ok(btn, 'a viewer is offered the baseline');
  btn.click();
  await settle(300);
  const call = log.filter((l) => l.key === 'GET /api/baselines/flow-pair').pop();
  assert.match(call.url, /dst=9&port=443/);
  assert.ok(!log.some((l) => l.key === 'GET /api/topology/flow-baselines'), 'the operator-only route is not needed to show a baseline');
  const card = doc.querySelector('#modal-card');
  assert.match(card.textContent, /Normal for a Tuesday at 14:00 UTC: 1000 B ± 100 B/);
  assert.match(card.textContent, /Last complete hour \(14:00 UTC\)/);
  assert.match(card.querySelector('.bm').textContent, /120% above normal/);
  // The day picker is the catalogue's weekdays, on the slot "now" belongs to.
  const days = [...card.querySelectorAll('select option')].map((o) => o.textContent);
  assert.deepEqual(days, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  assert.equal(card.querySelector('select').value, '2');
});

test('the Baseline dialog speaks Danish when the reader does', async (t) => {
  const { doc } = boot({ t, locale: 'da', routes: SESSION({ 'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: { locale: 'da' } } }) });
  await settle();
  const row = [...doc.querySelectorAll('#view tbody tr')].find((r) => /443/.test(r.textContent) && [...r.querySelectorAll('button')].some((b) => b.textContent === 'Baseline'));
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Baseline').click();
  await settle(300);
  const days = [...doc.querySelectorAll('#modal-card select option')].map((o) => o.textContent);
  assert.deepEqual(days, ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag']);
  assert.doesNotMatch(doc.querySelector('#modal-card').textContent, /\bSun\b|\bTue\b|Loading baseline/);
});

test('the neighbours card lists the host\'s LLDP adjacencies', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION() });
  await settle();
  assert.ok(log.some((l) => l.key === 'GET /api/topology/neighbors' && /target=7/.test(l.url)));
  const nb = panelBy(doc, 'LLDP neighbours');
  assert.ok(nb);
  const row = nb.querySelector('tbody tr');
  assert.match(row.textContent, /eth0/);
  assert.match(row.textContent, /00:1b:44:11:3a:b7/);
  assert.match(row.textContent, /Gi0\/24/);
});

test('no neighbours says how they get reported, not just "empty"', async (t) => {
  const { doc } = boot({ t, routes: SESSION({ 'GET /api/topology/neighbors': { neighbors: [], page: { limit: 50, offset: 0, total: 0 } } }) });
  await settle();
  assert.match(panelBy(doc, 'LLDP neighbours').textContent, /when lldpd runs on the host/);
});
