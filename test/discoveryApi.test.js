'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeDiscoveredDevicesRepo, makeAgentsRepo, makeAgentCommander, makeAuditLogRepo, authHeader } = require('../test-support/fakes');

async function seededRepo() {
  const repo = makeDiscoveredDevicesRepo();
  await repo.upsertCandidate({ ip: '10.0.0.2', hostname: 'printer.lan', openPorts: [80, 443], icmp: true, seenAt: new Date('2026-07-24T10:00:00Z') });
  return repo;
}

test('GET /api/discovery/candidates lists candidates (admin)', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const res = await request(app).get('/api/discovery/candidates').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.candidates.length, 1);
  assert.equal(res.body.candidates[0].ip, '10.0.0.2');
  assert.equal(res.body.candidates[0].status, 'discovered');
});

test('discovery endpoints require auth → 401', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  assert.equal((await request(app).get('/api/discovery/candidates')).status, 401);
});

test('discovery endpoints are ADMIN-only — viewer AND operator get 403 on every path', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const paths = [
    ['get', '/api/discovery/candidates'],
    ['get', '/api/discovery/config'],
    ['put', '/api/discovery/config'],
    ['get', '/api/discovery/sweeps'],
    ['post', '/api/discovery/scan'],
    ['post', '/api/discovery/candidates/1/promote'],
    ['post', '/api/discovery/candidates/1/ignore'],
  ];
  for (const role of ['viewer', 'operator']) {
    for (const [method, path] of paths) {
      const res = await request(app)[method](path).set('Authorization', authHeader(role)); // eslint-disable-line no-await-in-loop
      assert.equal(res.status, 403, `${role} ${method} ${path} should be 403, got ${res.status}`);
    }
  }
});

test('GET /api/discovery/candidates/:id unknown → 404', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  assert.equal((await request(app).get('/api/discovery/candidates/999').set('Authorization', authHeader('admin'))).status, 404);
});

test('promote unknown candidate → 404', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  assert.equal((await request(app).post('/api/discovery/candidates/999/promote').set('Authorization', authHeader('admin'))).status, 404);
});

test('GET /api/discovery/candidates → 500 on store failure', async () => {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo({ list: async () => { throw new Error('DB down'); } });
  const app = makeApp({ discoveredDevicesRepo });
  assert.equal((await request(app).get('/api/discovery/candidates').set('Authorization', authHeader('admin'))).status, 500);
});

test('a candidate is NOT a monitored device until an admin promotes it', async () => {
  const discoveredDevicesRepo = await seededRepo();
  const created = [];
  const agentsRepo = makeAgentsRepo({
    findById: async () => null,
    insertSnmpDevice: async ({ hostname, host }) => { created.push({ hostname, host }); return 4242; },
  });
  const app = makeApp({ discoveredDevicesRepo, agentsRepo });

  // Before promotion: the candidate exists but NO agent was created for it.
  assert.equal(created.length, 0);
  const cand = discoveredDevicesRepo.rows[0];
  assert.equal(cand.status, 'discovered');
  assert.equal(cand.promoted_agent_id, null);

  // Promote (admin) → creates exactly one SNMP device and flips the candidate.
  const res = await request(app).post(`/api/discovery/candidates/${cand.id}/promote`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 4242);
  assert.deepEqual(created, [{ hostname: 'printer.lan', host: '10.0.0.2' }]);
  assert.equal(cand.status, 'promoted');
  assert.equal(cand.promoted_agent_id, 4242);

  // Promoting again is idempotent (no second device).
  const again = await request(app).post(`/api/discovery/candidates/${cand.id}/promote`).set('Authorization', authHeader('admin'));
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyPromoted, true);
  assert.equal(created.length, 1);
});

test('ignore marks a candidate ignored (admin)', async () => {
  const discoveredDevicesRepo = await seededRepo();
  const app = makeApp({ discoveredDevicesRepo });
  const id = discoveredDevicesRepo.rows[0].id;
  const res = await request(app).post(`/api/discovery/candidates/${id}/ignore`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(discoveredDevicesRepo.rows[0].status, 'ignored');
});

// ---- runtime-editable scope (PUT /config) ----------------------------------

test('GET /api/discovery/config reports the effective scope + editable flag', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const res = await request(app).get('/api/discovery/config').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.editable, true); // settings-backed provider wired
  assert.equal(res.body.scopeConfigured, false); // no CIDRs yet
  assert.ok(Array.isArray(res.body.ports));
});

test('PUT /api/discovery/config sets the scope and it round-trips (admin)', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const res = await request(app).put('/api/discovery/config')
    .set('Authorization', authHeader('admin'))
    .send({ cidrs: ['10.0.0.0/24'], ports: [22, 443], rateLimit: 25 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.config.cidrs, ['10.0.0.0/24']);
  assert.deepEqual(res.body.config.ports, [22, 443]);
  assert.equal(res.body.config.rateLimit, 25);
  assert.equal(res.body.config.scopeConfigured, true);
  // Read back through GET.
  const got = await request(app).get('/api/discovery/config').set('Authorization', authHeader('admin'));
  assert.deepEqual(got.body.cidrs, ['10.0.0.0/24']);
  assert.equal(got.body.source.cidrs, 'settings');
});

test('PUT /api/discovery/config rejects an invalid CIDR → 400', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const res = await request(app).put('/api/discovery/config')
    .set('Authorization', authHeader('admin'))
    .send({ cidrs: ['not-a-cidr'] });
  assert.equal(res.status, 400);
  assert.ok(res.body.details && res.body.details.cidrs);
});

test('PUT /api/discovery/config rejects an out-of-range port → 400', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const res = await request(app).put('/api/discovery/config')
    .set('Authorization', authHeader('admin'))
    .send({ ports: [70000] });
  assert.equal(res.status, 400);
});

test('GET /api/discovery/sweeps returns audited sweeps (admin)', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const res = await request(app).get('/api/discovery/sweeps').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.sweeps));
});

// ---- agent-executed sweep (POST /scan with agentId) ------------------------

test('POST /api/discovery/scan with agentId pushes run-discovery to that agent', async () => {
  let sent = null;
  const agentCommander = makeAgentCommander({ sendCommand: (id, cmd) => { sent = { id, cmd }; return 1; } });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'a' }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander });
  const res = await request(app).put('/api/discovery/config').set('Authorization', authHeader('admin')).send({ cidrs: ['10.0.0.0/24'] });
  assert.equal(res.status, 200);
  const scan = await request(app).post('/api/discovery/scan').set('Authorization', authHeader('admin')).send({ agentId: 7 });
  assert.equal(scan.status, 202);
  assert.equal(scan.body.mode, 'agent');
  assert.equal(sent.id, 7);
  assert.equal(sent.cmd.name, 'run-discovery');
  assert.deepEqual(sent.cmd.discovery.cidrs, ['10.0.0.0/24']); // effective scope forwarded
});

test('POST /api/discovery/scan with agentId returns 409 when the agent is offline', async () => {
  const agentCommander = makeAgentCommander({ sendCommand: () => 0 }); // not connected
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander });
  const res = await request(app).post('/api/discovery/scan').set('Authorization', authHeader('admin')).send({ agentId: 7 });
  assert.equal(res.status, 409);
});

test('POST /api/discovery/scan with an unknown agentId → 404', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander: makeAgentCommander() });
  const res = await request(app).post('/api/discovery/scan').set('Authorization', authHeader('admin')).send({ agentId: 999 });
  assert.equal(res.status, 404);
});

// ---- several agents at once (POST /scan with agentIds) ---------------------
// A sweep only reaches the segments the host running it sits on, so a routed
// site needs one per agent. These pin the part that is easy to get wrong:
// one agent being offline must not cancel the sweeps on the others.

test('POST /api/discovery/scan with agentIds fans out to every one of them', async () => {
  const sent = [];
  const agentCommander = makeAgentCommander({ sendCommand: (id, cmd) => { sent.push({ id, cmd }); return 1; } });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: `sw-${id}` }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander });

  const res = await request(app).post('/api/discovery/scan')
    .set('Authorization', authHeader('admin')).send({ agentIds: [7, 8, 9] });

  assert.equal(res.status, 202);
  assert.equal(res.body.mode, 'agent');
  assert.equal(res.body.requested, 3);
  assert.equal(res.body.delivered, 3);
  assert.deepEqual(sent.map((x) => x.id), [7, 8, 9]);
  assert.equal(sent[0].cmd.name, 'run-discovery');
  // The hostname travels back so the UI names the agent rather than its id.
  assert.deepEqual(res.body.results.map((r) => r.hostname), ['sw-7', 'sw-8', 'sw-9']);
});

test('one offline agent does not cancel the others — 202 with a per-agent verdict', async () => {
  // The whole point of the fan-out. Refusing eleven sweeps because the twelfth
  // agent dropped off between the page loading and the button being pressed
  // would make the feature useless on exactly the fleets that need it.
  const agentCommander = makeAgentCommander({ sendCommand: (id) => (id === 8 ? 0 : 1) });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: `sw-${id}` }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander });

  const res = await request(app).post('/api/discovery/scan')
    .set('Authorization', authHeader('admin')).send({ agentIds: [7, 8, 9] });

  assert.equal(res.status, 202);
  assert.equal(res.body.delivered, 2);
  assert.equal(res.body.requested, 3);
  const missed = res.body.results.find((r) => !r.delivered);
  assert.equal(missed.agentId, 8);
  assert.equal(missed.reason, 'not_connected');
  assert.equal(missed.hostname, 'sw-8', 'the one that missed out is NAMED, not just counted');
});

test('a fan-out nobody accepted is a 409, not a cheerful 202', async () => {
  const agentCommander = makeAgentCommander({ sendCommand: () => 0 });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander });

  const res = await request(app).post('/api/discovery/scan')
    .set('Authorization', authHeader('admin')).send({ agentIds: [7, 8] });

  assert.equal(res.status, 409);
  assert.equal(res.body.delivered, 0);
  assert.equal(res.body.results.length, 2);
});

test('an unknown agent in the list is reported, and the rest still sweep', async () => {
  const agentCommander = makeAgentCommander({ sendCommand: () => 1 });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => (id === 999 ? null : { id, hostname: `sw-${id}` }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander });

  const res = await request(app).post('/api/discovery/scan')
    .set('Authorization', authHeader('admin')).send({ agentIds: [7, 999] });

  assert.equal(res.status, 202);
  assert.equal(res.body.delivered, 1);
  assert.equal(res.body.results.find((r) => r.agentId === 999).reason, 'not_found');
});

test('the same agent twice is one sweep, and the list is bounded', async () => {
  const sent = [];
  const agentCommander = makeAgentCommander({ sendCommand: (id) => { sent.push(id); return 1; } });
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), agentsRepo, agentCommander });
  const admin = (body) => request(app).post('/api/discovery/scan').set('Authorization', authHeader('admin')).send(body);

  const dup = await admin({ agentIds: [7, 7, 7] });
  assert.equal(dup.status, 202);
  assert.deepEqual(sent, [7], 'asking twice is one sweep, not two');

  // A sweep is rate-limited network scanning; a hundred hosts starting at once
  // is a burst. The cap REFUSES rather than silently truncating.
  const tooMany = await admin({ agentIds: Array.from({ length: 51 }, (_, i) => i + 1) });
  assert.equal(tooMany.status, 400);

  assert.equal((await admin({ agentIds: [] })).status, 400, 'an empty list is a mistake, not a server sweep');
  assert.equal((await admin({ agentIds: ['nope'] })).status, 400);
});

// ---- the sweep history is parsed, not a raw string -------------------------
// The audit log IS the sweep history (no sweeps table — a sweep is an admin
// action first, and the hash-chained log is what makes it non-repudiable). The
// cost is that the numbers arrive as the `detail` line its two writers wrote,
// so the route parses it back. These pin that parsing, because the screen now
// depends on the fields rather than on the string.

const sweepRow = (over = {}) => ({
  category: 'discovery', action: 'discovery_sweep', outcome: 'success', ...over,
});

test('GET /sweeps parses a server-run sweep into fields, with a duration', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record(sweepRow({
    target: '10.0.0.0/24',
    detail: 'addresses=256 probed=256 found=0 start=2026-07-24T17:42:40.449Z end=2026-07-24T18:03:44.684Z',
  }));
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), auditLogRepo });

  const res = await request(app).get('/api/discovery/sweeps').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  const [s] = res.body.sweeps;

  assert.equal(s.ranBy.kind, 'server', 'no agent ran it, so it does not claim one');
  assert.equal(s.ranBy.agentId, null);
  assert.equal(s.scope, '10.0.0.0/24', 'a server sweep keeps its scope in `target`');
  assert.equal(s.addresses, 256);
  assert.equal(s.probed, 256);
  // 0 is a MEASUREMENT — a clean network — and must not read as "unknown".
  assert.equal(s.found, 0);
  assert.equal(s.durationMs, 1264235, 'start and end become a span the UI can print');
  assert.equal(s.refused, false);
  // The raw line survives beside the parsed fields, so nothing that read it breaks.
  assert.match(s.detail, /addresses=256/);
});

test('GET /sweeps names the AGENT that ran an agent-executed sweep', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record(sweepRow({
    target: 'agent:31',
    detail: 'agent-executed addresses=512 probed=400 found=3 scope=192.168.5.0/24',
  }));
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'gods_monster' }) });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), auditLogRepo, agentsRepo });

  const res = await request(app).get('/api/discovery/sweeps').set('Authorization', authHeader('admin'));
  const [s] = res.body.sweeps;

  assert.equal(s.ranBy.kind, 'agent');
  assert.equal(s.ranBy.agentId, 31);
  // A HOSTNAME, because "agent:31" on a screen is a number somebody then has to
  // go and look up.
  assert.equal(s.ranBy.hostname, 'gods_monster');
  assert.equal(s.scope, '192.168.5.0/24', 'an agent sweep carries its scope in `scope=`');
  assert.equal(s.found, 3);
  assert.equal(s.durationMs, null, 'that writer records no start/end, and none is invented');
});

test('an agent deleted since its sweep has no name invented for it', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record(sweepRow({ target: 'agent:31', detail: 'agent-executed addresses=8 probed=8 found=0' }));
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), auditLogRepo, agentsRepo });

  const [s] = (await request(app).get('/api/discovery/sweeps').set('Authorization', authHeader('admin'))).body.sweeps;
  assert.equal(s.ranBy.agentId, 31, 'the id is still known');
  assert.equal(s.ranBy.hostname, null, 'the name is not');
});

test('a refused sweep carries its reason and no counts', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record(sweepRow({
    action: 'discovery_sweep_refused', target: '(none)', detail: 'reason=NO_SCOPE scope=(none)',
  }));
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), auditLogRepo });

  const [s] = (await request(app).get('/api/discovery/sweeps').set('Authorization', authHeader('admin'))).body.sweeps;
  assert.equal(s.refused, true);
  assert.equal(s.reason, 'NO_SCOPE');
  // Absent, not zero: nothing was swept, so there is no count to report.
  assert.equal(s.addresses, null);
  assert.equal(s.found, null);
});

test('a detail line in a shape neither writer produces degrades, it does not throw', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record(sweepRow({ target: null, detail: null }));
  await auditLogRepo.record(sweepRow({ target: 'agent:x', detail: 'something else entirely' }));
  const app = makeApp({ discoveredDevicesRepo: await seededRepo(), auditLogRepo });

  const res = await request(app).get('/api/discovery/sweeps').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.sweeps.length, 2);
  for (const s of res.body.sweeps) {
    assert.equal(s.addresses, null);
    assert.equal(s.found, null);
    assert.equal(s.durationMs, null);
    assert.equal(s.ranBy.kind, 'server', 'agent:x is not an agent id');
  }
});
