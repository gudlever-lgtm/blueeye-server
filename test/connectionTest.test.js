'use strict';

// Connection Test API — /api/connection-test (catalogue, run, schedule).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentCommander,
  makeTestPackagesRepo,
  authHeader,
} = require('../test-support/fakes');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');

const agentsRepo = (overrides = {}) =>
  makeAgentsRepo({ findById: async (id) => (Number(id) === 1 ? { id: 1, hostname: 'probe-01' } : null), ...overrides });

const app = (over = {}) => makeApp({ agentsRepo: agentsRepo(), ...over });

const runBody = { agentId: 1, host: 'example.com', checks: ['ping', 'dns', 'tcp443'] };
const recurrence = { period: 'daily', every: 6, at: '08:00' };

// ---------------------------------------------------------------- catalogue
test('GET /checks serves the catalogue (viewer+) and says what does not apply', async () => {
  const res = await request(app()).get('/api/connection-test/checks?host=1.1.1.1').set('Authorization', viewer());
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.checks.map((c) => [c.id, c]));
  // A DNS lookup of an IP literal answers nothing, so it is offered but not applicable.
  assert.equal(byId.dns.available, true);
  assert.equal(byId.dns.applies, false);
  assert.equal(byId.ping.applies, true);
  // Both landed in blueeye-agent 0.27; an older agent in the field answers
  // "unknown probe type", which the screen reports as the failure reason.
  assert.equal(byId.rdns.available, true);
  assert.equal(byId.tls.available, true);
  // Reverse DNS is asked OF an address, so an IP literal is exactly its case.
  assert.equal(byId.rdns.applies, true);
  // Against a name, the DNS check applies again.
  const named = await request(app()).get('/api/connection-test/checks?host=example.com').set('Authorization', viewer());
  assert.equal(named.body.checks.find((c) => c.id === 'dns').applies, true);
});

test('GET /checks tolerates a hostile or absent host parameter', async () => {
  for (const q of ['', '?host=', '?host[]=1', '?host=%00', '?host=' + 'x'.repeat(5000)]) {
    const res = await request(app()).get(`/api/connection-test/checks${q}`).set('Authorization', viewer());
    assert.equal(res.status, 200, q);
    assert.ok(Array.isArray(res.body.checks), q);
  }
});

test('GET /checks without a token is 401', async () => {
  assert.equal((await request(app()).get('/api/connection-test/checks')).status, 401);
});

// ---------------------------------------------------------------- run
test('POST /run dispatches one probe per selected check -> 202', async () => {
  const sent = [];
  const commander = makeAgentCommander({ sendCommand: (id, cmd) => { sent.push({ id, cmd }); return 1; } });
  const res = await request(app({ agentCommander: commander })).post('/api/connection-test/run').set('Authorization', operator()).send(runBody);
  assert.equal(res.status, 202);
  assert.equal(res.body.delivered, 3);
  assert.deepEqual(res.body.dispatched.map((d) => d.id), ['dns', 'ping', 'tcp443']);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((s) => s.cmd.name), ['run-probe', 'run-probe', 'run-probe']);
  // Ordinary probe specs — nothing the rest of the product does not already store.
  assert.deepEqual(sent.map((s) => s.cmd.probe.type), ['dns', 'ping', 'tcp']);
  assert.equal(sent[2].cmd.probe.port, 443);
  assert.ok(sent.every((s) => s.cmd.probe.host === 'example.com'));
});

test('POST /run skips a check that cannot answer for this target', async () => {
  // A DNS lookup of an IP literal resolves nothing. Reverse DNS and TLS both
  // apply to an address, so they go out — the skip is about the QUESTION, not
  // about which checks exist.
  const res = await request(app()).post('/api/connection-test/run').set('Authorization', operator())
    .send({ agentId: 1, host: '1.1.1.1', checks: ['dns', 'ping', 'tls', 'rdns'] });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.dispatched.map((d) => d.id), ['rdns', 'ping', 'tls']);
  assert.deepEqual(res.body.skipped, [{ id: 'dns', reason: 'not_applicable' }]);
});

test('POST /run with nothing runnable is 400, not an empty success', async () => {
  const res = await request(app()).post('/api/connection-test/run').set('Authorization', operator())
    .send({ agentId: 1, host: '1.1.1.1', checks: ['dns'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.deepEqual(res.body.skipped.map((s) => s.id), ['dns']);
});

test('POST /run validates the body -> 400 with field-level details', async () => {
  const bad = [
    [{}, ['agentId', 'host', 'checks']],
    [{ agentId: 1, host: 'example.com', checks: [] }, ['checks']],
    [{ agentId: 1, host: 'example.com', checks: ['nope'] }, ['checks']],
    [{ agentId: 1, host: '-rf', checks: ['ping'] }, ['host']],
    [{ agentId: 1, host: 'a b;rm -rf /', checks: ['ping'] }, ['host']],
    [{ agentId: 'abc', host: 'example.com', checks: ['ping'] }, ['agentId']],
  ];
  for (const [body, fields] of bad) {
    const res = await request(app()).post('/api/connection-test/run').set('Authorization', operator()).send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    for (const f of fields) assert.ok(res.body.details[f], `${JSON.stringify(body)}: no detail for ${f}`);
  }
});

test('POST /run: unknown agent 404, disconnected agent 409, viewer 403, no token 401', async () => {
  const unknown = await request(app()).post('/api/connection-test/run').set('Authorization', operator()).send({ ...runBody, agentId: 999999 });
  assert.equal(unknown.status, 404);

  const offline = makeAgentCommander({ sendCommand: () => 0 });
  const disconnected = await request(app({ agentCommander: offline })).post('/api/connection-test/run').set('Authorization', operator()).send(runBody);
  assert.equal(disconnected.status, 409);
  assert.equal(disconnected.body.delivered, 0);

  assert.equal((await request(app()).post('/api/connection-test/run').set('Authorization', viewer()).send(runBody)).status, 403);
  assert.equal((await request(app()).post('/api/connection-test/run').send(runBody)).status, 401);
});

test('POST /run never answers 500 to junk', async () => {
  for (const body of [{}, [], 'str', null, 123, { checks: 'ping' }, { agentId: { a: 1 }, host: {}, checks: [{}] }]) {
    const res = await request(app()).post('/api/connection-test/run').set('Authorization', operator())
      .set('Content-Type', 'application/json').send(JSON.stringify(body));
    assert.ok(res.status < 500, `${JSON.stringify(body)} → ${res.status}`);
  }
});

// ---------------------------------------------------------------- schedule
test('POST /schedule saves the test as a recurring package -> 201', async () => {
  let created;
  const repo = makeTestPackagesRepo({ create: async (p) => { created = p; return { id: 7, ...p }; } });
  const res = await request(app({ testPackagesRepo: repo })).post('/api/connection-test/schedule').set('Authorization', operator())
    .send({ agentId: 1, host: 'example.com', checks: ['ping', 'dns'], runs: 2, recurrence });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 7);
  assert.equal(created.name, 'Connection test — example.com');
  assert.deepEqual(created.schedule_spec, recurrence);
  assert.equal(created.schedule_ms, 0, 'a calendar recurrence zeroes the interval');
  assert.deepEqual(created.targets, { mode: 'agents', agentIds: [1], locationIds: [] });
  // Two runs of two checks, in catalogue order.
  assert.deepEqual(created.items.map((i) => i.probe.type), ['dns', 'ping', 'dns', 'ping']);
  assert.equal(created.created_by, 1);
});

test('POST /schedule validates the recurrence and the size of a run -> 400', async () => {
  const bad = [
    [{ agentId: 1, host: 'example.com', checks: ['ping'] }, 'recurrence'],
    [{ agentId: 1, host: 'example.com', checks: ['ping'], recurrence: { period: 'yearly' } }, 'recurrence'],
    [{ agentId: 1, host: 'example.com', checks: ['ping'], recurrence: { period: 'hourly', every: 60 } }, 'recurrence'],
    [{ agentId: 1, host: 'example.com', checks: ['ping'], runs: 0, recurrence }, 'runs'],
    [{ agentId: 1, host: 'example.com', checks: ['ping', 'dns', 'tcp80', 'tcp443', 'traceroute'], runs: 5, recurrence }, 'runs'],
  ];
  for (const [body, field] of bad) {
    const res = await request(app()).post('/api/connection-test/schedule').set('Authorization', operator()).send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.details[field], `${JSON.stringify(body)}: no detail for ${field}`);
  }
});

test('POST /schedule: unknown agent 404, viewer 403, no token 401, junk never 500', async () => {
  const body = { agentId: 1, host: 'example.com', checks: ['ping'], recurrence };
  assert.equal((await request(app()).post('/api/connection-test/schedule').set('Authorization', operator()).send({ ...body, agentId: 999999 })).status, 404);
  assert.equal((await request(app()).post('/api/connection-test/schedule').set('Authorization', viewer()).send(body)).status, 403);
  assert.equal((await request(app()).post('/api/connection-test/schedule').send(body)).status, 401);
  for (const junk of [{}, [], 'str', null, { recurrence: 'daily' }]) {
    const res = await request(app()).post('/api/connection-test/schedule').set('Authorization', operator())
      .set('Content-Type', 'application/json').send(JSON.stringify(junk));
    assert.ok(res.status < 500, `${JSON.stringify(junk)} → ${res.status}`);
  }
});

test('POST /schedule is 503 when the deployment has no test packages', async () => {
  // makeApp always wires a package repository, so this one mounts the router
  // directly — the point is the branch, not the app.
  const express = require('express');
  const { createConnectionTestRouter } = require('../src/routes/connectionTest');
  const bare = express();
  bare.use(express.json());
  bare.use('/api/connection-test', createConnectionTestRouter({
    agentsRepo: agentsRepo(), agentCommander: makeAgentCommander(), testPackagesRepo: null,
  }));
  const res = await request(bare).post('/api/connection-test/schedule').set('Authorization', operator())
    .send({ agentId: 1, host: 'example.com', checks: ['ping'], recurrence });
  assert.equal(res.status, 503);
});

// ----------------------------------------------------------------- the ladder
//
// POST /walk dispatches the WHOLE catalogue and GET /ladder reads the verdict
// back out of what the probes stored. The pair is what turns "I cannot reach X"
// into "it stops at the firewall", so these cover the selection being fixed (a
// ladder full of skipped rungs cannot say where anything stops), the free-text
// symptom being data, and every failure code a caller can provoke.

const { makeProbeResultsRepo, makeArpEntriesRepo } = require('../test-support/fakes');
const { CHECK_IDS } = require('../src/connectionTest/checks');

const LADDER_ROWS = [
  { type: 'dns', target: 'example.com', ok: true, rttMs: 7, ts: '2026-01-01T00:00:00.000Z' },
  { type: 'ping', target: 'example.com', ok: true, lossPct: 0, rttMs: 12, ts: '2026-01-01T00:00:00.000Z' },
  { type: 'tcp', target: 'example.com:443', ok: false, failure: 'timeout', ts: '2026-01-01T00:00:00.000Z' },
  { type: 'tcp', target: 'example.com:80', ok: true, rttMs: 10, ts: '2026-01-01T00:00:00.000Z' },
  { type: 'traceroute', target: 'example.com', ok: true, ts: '2026-01-01T00:00:00.000Z', hops: [{ hop: 1, ip: '10.0.0.1', lossPct: 0 }, { hop: 2, ip: '93.184.216.34', lossPct: 0 }] },
];

const ladderApp = (rows = LADDER_ROWS, over = {}) => makeApp({
  agentsRepo: agentsRepo(),
  probeResultsRepo: makeProbeResultsRepo({ latestByAgent: async () => rows }),
  ...over,
});

test('POST /walk pushes every applicable check and echoes the symptom back', async () => {
  const commander = makeAgentCommander();
  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander: commander }))
    .post('/api/connection-test/walk').set('Authorization', operator())
    .send({ agentId: 1, host: 'example.com', symptom: 'the site loads for nobody since this morning' });
  assert.equal(res.status, 202);
  // Every check in the catalogue, not a selection: a rung nobody ran reads
  // "not tested", and a ladder of those cannot say where anything stops.
  assert.deepEqual(res.body.dispatched.map((d) => d.id).sort(), [...CHECK_IDS].sort());
  assert.equal(res.body.symptom, 'the site loads for nobody since this morning');
});

test('POST /walk against an IP literal skips only what cannot answer', async () => {
  const res = await request(makeApp({ agentsRepo: agentsRepo() }))
    .post('/api/connection-test/walk').set('Authorization', operator())
    .send({ agentId: 1, host: '1.1.1.1' });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.skipped.map((s) => s.id), ['dns']);
  assert.ok(!res.body.dispatched.some((d) => d.id === 'dns'));
});

test('POST /walk: unknown agent 404, viewer 403, no token 401, junk never 500', async () => {
  const body = { agentId: 1, host: 'example.com' };
  assert.equal((await request(ladderApp()).post('/api/connection-test/walk').set('Authorization', operator()).send({ ...body, agentId: 999999 })).status, 404);
  assert.equal((await request(ladderApp()).post('/api/connection-test/walk').set('Authorization', viewer()).send(body)).status, 403);
  assert.equal((await request(ladderApp()).post('/api/connection-test/walk').send(body)).status, 401);
  for (const junk of [{}, [], 'str', null, { host: '' }, { agentId: 'x', host: 'example.com' }, { agentId: 1, host: 'a b;rm -rf /' }, { agentId: 1, host: 'example.com', symptom: 'x'.repeat(5000) }, { agentId: 1, host: 'example.com', symptom: { a: 1 } }]) {
    const res = await request(ladderApp()).post('/api/connection-test/walk').set('Authorization', operator())
      .set('Content-Type', 'application/json').send(JSON.stringify(junk));
    assert.ok(res.status < 500, `${JSON.stringify(junk)} → ${res.status}`);
  }
});

test('POST /walk is 409 when the agent is not connected', async () => {
  const res = await request(makeApp({ agentsRepo: agentsRepo(), agentCommander: makeAgentCommander({ sendCommand: () => 0 }) }))
    .post('/api/connection-test/walk').set('Authorization', operator()).send({ agentId: 1, host: 'example.com' });
  assert.equal(res.status, 409);
});

test('GET /ladder names the rung the communication stops at', async () => {
  const res = await request(ladderApp()).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.stopsAt, 'firewall');
  assert.equal(res.body.verdict.outcome, 'stops');
  assert.deepEqual(res.body.layers.map((l) => l.layer), ['dns', 'arp', 'routing', 'firewall', 'tcp', 'nat_lb', 'tls', 'application']);
  // Every rung says why it says what it says, on the rung itself.
  for (const l of res.body.layers) assert.ok(l.because && l.because.length > 10, `${l.layer} has no reason`);
});

test('GET /ladder over an empty history is untested, not clear', async () => {
  const res = await request(ladderApp([])).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.stopsAt, null);
  assert.equal(res.body.verdict.outcome, 'untested');
});

test('GET /ladder asks the neighbour table only for an address', async () => {
  const arp = makeArpEntriesRepo();
  let asked = 0;
  arp.listForAgent = async () => { asked += 1; return [{ ip: '192.168.1.5', agentId: 1 }]; };
  arp.findByIp = async () => [];
  const named = await request(ladderApp([], { arpEntriesRepo: arp })).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(named.status, 200);
  assert.equal(asked, 0, 'a name has no ARP answer');
  const addressed = await request(ladderApp([], { arpEntriesRepo: arp })).get('/api/connection-test/ladder?agentId=1&host=192.168.1.9').set('Authorization', viewer());
  assert.equal(addressed.status, 200);
  assert.equal(asked, 1);
  assert.equal(addressed.body.stopsAt, 'arp');
});

test('GET /ladder: unknown agent 404, no token 401, bad input 400, junk never 500', async () => {
  assert.equal((await request(ladderApp()).get('/api/connection-test/ladder?agentId=999999&host=example.com').set('Authorization', viewer())).status, 404);
  assert.equal((await request(ladderApp()).get('/api/connection-test/ladder?agentId=1&host=example.com')).status, 401);
  for (const q of ['', '?agentId=1', '?host=example.com', '?agentId=0&host=example.com', '?agentId=1&host=', '?agentId=1&host[]=a', '?agentId=1&host=a%20b;id', `?agentId=1&host=example.com&symptom=${'x'.repeat(2000)}`]) {
    const res = await request(ladderApp()).get(`/api/connection-test/ladder${q}`).set('Authorization', viewer());
    assert.ok(res.status === 400 || res.status === 404, `${q} → ${res.status}`);
    assert.ok(res.status < 500, `${q} → ${res.status}`);
  }
});

test('GET /ladder is 503 where the deployment stores no probe results', async () => {
  const express = require('express');
  const { createConnectionTestRouter } = require('../src/routes/connectionTest');
  const bare = express();
  bare.use(express.json());
  bare.use('/api/connection-test', createConnectionTestRouter({
    agentsRepo: agentsRepo(), agentCommander: makeAgentCommander(), probeResultsRepo: null,
  }));
  const res = await request(bare).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 503);
});

test('the catalogue carries an application check, so a port that opens is not the last word', async () => {
  const res = await request(app()).get('/api/connection-test/checks?host=example.com').set('Authorization', viewer());
  const http = res.body.checks.find((c) => c.id === 'http');
  assert.ok(http, 'no http check in the catalogue');
  assert.equal(http.available, true);
  assert.equal(http.applies, true);
});

// ------------------------------------------------- the ladder's configuration

const { makeSettingsService } = (() => {
  // A settings service the router will accept: only getLadder is read.
  const fakes = require('../test-support/fakes');
  return { makeSettingsService: fakes.makeSettingsService || null };
})();

const ladderSettings = (ladder) => ({ getLadder: async () => ladder });

test('GET /ladder walks the configured order and reports a switched-off rung as such', async () => {
  const app2 = makeApp({
    agentsRepo: agentsRepo(),
    probeResultsRepo: makeProbeResultsRepo({ latestByAgent: async () => LADDER_ROWS }),
    settingsService: ladderSettings({
      order: ['nat_lb', 'dns', 'arp', 'routing', 'firewall', 'tcp', 'tls', 'application'],
      enabled: { dns: true, arp: false, routing: true, firewall: true, tcp: true, nat_lb: true, tls: true, application: true },
      ports: [80, 443],
      certWarnDays: 14,
      lossThresholdPct: 5,
    }),
  });
  const res = await request(app2).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.layers[0].layer, 'nat_lb', 'the configured order was not walked');
  const arp = res.body.layers.find((l) => l.layer === 'arp');
  assert.equal(arp.disabled, true);
  // Eight rungs still: switching one off must not make the answer look complete.
  assert.equal(res.body.layers.length, 8);
  assert.equal(res.body.stopsAt, 'firewall');
});

test('GET /ladder answers in the locale asked for, and falls back rather than failing', async () => {
  const da = await request(ladderApp()).get('/api/connection-test/ladder?agentId=1&host=example.com&locale=da').set('Authorization', viewer());
  assert.equal(da.status, 200);
  assert.equal(da.body.locale, 'da');
  assert.match(da.body.verdict.text, /Kommunikationen stopper ved firewallen/);
  // Technical terms are not translated, in any locale.
  for (const term of ['ICMP', 'TCP/443', 'ACL']) assert.ok(da.body.verdict.text.includes(term), term);

  for (const q of ['&locale=de', '&locale=', '&locale[]=da', `&locale=${'x'.repeat(200)}`]) {
    const res = await request(ladderApp()).get(`/api/connection-test/ladder?agentId=1&host=example.com${q}`).set('Authorization', viewer());
    assert.equal(res.status, 200, q);
    assert.equal(res.body.locale, 'en', q);
  }
});

test('a settings service that throws does not stop a diagnosis', async () => {
  const app2 = makeApp({
    agentsRepo: agentsRepo(),
    probeResultsRepo: makeProbeResultsRepo({ latestByAgent: async () => LADDER_ROWS }),
    settingsService: { getLadder: async () => { throw new Error('settings table unreachable'); } },
  });
  const res = await request(app2).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 200, 'the ladder refused to run because settings were unreadable');
  assert.equal(res.body.stopsAt, 'firewall');
});

test('POST /walk dispatches the configured ports as well as the catalogue ones', async () => {
  const sent = [];
  const res = await request(makeApp({
    agentsRepo: agentsRepo(),
    agentCommander: makeAgentCommander({ sendCommand: (id, cmd) => { sent.push(cmd); return 1; } }),
    settingsService: ladderSettings({ ...require('../src/connectionTest/ladder').DEFAULT_CONFIG, ports: [443, 8443, 22] }),
  })).post('/api/connection-test/walk').set('Authorization', operator()).send({ agentId: 1, host: 'example.com' });
  assert.equal(res.status, 202);
  const tcpPorts = sent.filter((c) => c.probe.type === 'tcp').map((c) => c.probe.port).sort((a, b) => a - b);
  assert.deepEqual(tcpPorts, [22, 80, 443, 8443], `dispatched ${tcpPorts.join(', ')}`);
});

// ------------------------------------------------- the other three ladders

const AGENT_A = { id: 1, hostname: 'probe-01', display_name: 'probe-01', capabilities: { ips: ['10.0.0.10'] } };
const AGENT_B = { id: 2, hostname: 'probe-02', display_name: 'probe-02', capabilities: { ips: ['10.9.0.20'] } };
const twoAgents = () => makeAgentsRepo({
  findById: async (id) => [AGENT_A, AGENT_B].find((a) => a.id === Number(id)) || null,
  findAll: async () => [AGENT_A, AGENT_B],
});

test('GET /ladders says what exists and what each one needs', async () => {
  const res = await request(app()).get('/api/connection-test/ladders').set('Authorization', viewer());
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.ladders.map((l) => [l.id, l]));
  assert.deepEqual(Object.keys(byId).sort(), ['device_location', 'local_host', 'reachability', 'two_way']);
  assert.deepEqual(byId.two_way.needs, { agents: 2, target: 'none' });
  // A screen has to know which rungs it may offer to move.
  assert.deepEqual(byId.reachability.movable, ['arp', 'nat_lb']);
  assert.equal(byId.device_location.dispatches, false);
  assert.equal((await request(app()).get('/api/connection-test/ladders')).status, 401);
});

test('POST /walk on the two-way ladder pushes probes from BOTH ends at each other', async () => {
  const sent = [];
  const res = await request(makeApp({
    agentsRepo: twoAgents(),
    agentCommander: makeAgentCommander({ sendCommand: (id, cmd) => { sent.push({ id, cmd }); return 1; } }),
  })).post('/api/connection-test/walk').set('Authorization', operator())
    .send({ ladder: 'two_way', agentId: 1, peerAgentId: 2 });
  assert.equal(res.status, 202);
  // Agent 1 probes agent 2's address, and agent 2 probes agent 1's.
  const from1 = sent.filter((x) => x.id === 1).map((x) => x.cmd.probe.host);
  const from2 = sent.filter((x) => x.id === 2).map((x) => x.cmd.probe.host);
  assert.ok(from1.length >= 3 && from1.every((h) => h === '10.9.0.20'), from1.join(','));
  assert.ok(from2.length >= 3 && from2.every((h) => h === '10.0.0.10'), from2.join(','));
});

test('POST /walk on the two-way ladder needs two DIFFERENT agents that both have an address', async () => {
  const app2 = makeApp({ agentsRepo: twoAgents() });
  const noPeer = await request(app2).post('/api/connection-test/walk').set('Authorization', operator())
    .send({ ladder: 'two_way', agentId: 1 });
  assert.equal(noPeer.status, 400);
  assert.match(noPeer.body.details.peerAgentId, /second agent/);

  const same = await request(app2).post('/api/connection-test/walk').set('Authorization', operator())
    .send({ ladder: 'two_way', agentId: 1, peerAgentId: 1 });
  assert.equal(same.status, 400);
  assert.match(same.body.details.peerAgentId, /must be different agents/);

  const missing = await request(app2).post('/api/connection-test/walk').set('Authorization', operator())
    .send({ ladder: 'two_way', agentId: 1, peerAgentId: 999999 });
  assert.equal(missing.status, 404);

  // An agent that never reported an address of its own leaves the far end
  // with nothing to aim at, and is told so rather than probing a blank.
  const anon = makeApp({
    agentsRepo: makeAgentsRepo({ findById: async (id) => (Number(id) === 1 ? AGENT_A : { id: 2, hostname: 'probe-02', capabilities: {} }) }),
  });
  const res = await request(anon).post('/api/connection-test/walk').set('Authorization', operator())
    .send({ ladder: 'two_way', agentId: 1, peerAgentId: 2 });
  assert.equal(res.status, 400);
  assert.match(res.body.details.peerAgentId, /has not reported an address of its own/);
});

test('POST /walk on the local-host ladder asks its own three questions', async () => {
  const sent = [];
  const res = await request(makeApp({
    agentsRepo: agentsRepo(),
    agentCommander: makeAgentCommander({ sendCommand: (id, cmd) => { sent.push(cmd.probe.type); return 1; } }),
  })).post('/api/connection-test/walk').set('Authorization', operator()).send({ ladder: 'local_host', agentId: 1 });
  assert.equal(res.status, 202);
  assert.deepEqual(sent.sort(), ['dhcp', 'dns', 'traceroute']);
});

test('POST /walk refuses the device-location ladder, which measures nothing new', async () => {
  const res = await request(app()).post('/api/connection-test/walk').set('Authorization', operator())
    .send({ ladder: 'device_location', device: '10.0.0.5' });
  assert.equal(res.status, 400);
  assert.match(res.body.details.ladder, /measures nothing new/);
});

test('POST /walk rejects an unknown ladder rather than defaulting to one', async () => {
  const res = await request(app()).post('/api/connection-test/walk').set('Authorization', operator())
    .send({ ladder: 'nope', agentId: 1, host: 'example.com' });
  assert.equal(res.status, 400);
  assert.match(res.body.details.ladder, /must be one of/);
});

test('GET /ladder reads the two-way ladder from what both ends stored', async () => {
  const rows = {
    1: [{ type: 'ping', target: '10.9.0.20', ok: true, lossPct: 0, rttMs: 12 }],
    2: [{ type: 'ping', target: '10.0.0.10', ok: true, lossPct: 40, rttMs: 13 }],
  };
  const res = await request(makeApp({
    agentsRepo: twoAgents(),
    probeResultsRepo: makeProbeResultsRepo({ latestByAgent: async (id) => rows[Number(id)] || [] }),
  })).get('/api/connection-test/ladder?ladder=two_way&agentId=1&peerAgentId=2').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.ladder, 'two_way');
  assert.equal(res.body.stopsAt, 'direction');
  assert.match(res.body.verdict.text, /probe-02 → probe-01/);
});

// The device-location ladder reads the SAME locator the Path & location screen
// uses, so these mount the router directly with a fake in its place — makeApp
// builds the real one out of repositories, which is a different test.
const withLocator = (deviceLocator) => {
  const express = require('express');
  const { createConnectionTestRouter } = require('../src/routes/connectionTest');
  const bare = express();
  bare.use(express.json());
  bare.use('/api/connection-test', createConnectionTestRouter({
    agentsRepo: agentsRepo(), agentCommander: makeAgentCommander(), deviceLocator,
  }));
  return bare;
};

test('GET /ladder reads the device-location ladder from the locator, and 503s without one', async () => {
  const locator = {
    where: async () => ({
      label: '10.0.0.5',
      macs: [{ mac: 'aa:bb:cc:dd:ee:ff', vendor: 'Dell' }],
      location: { deviceId: 2, deviceName: 'sw-core-1', ifName: 'Gi1/0/7', vlan: 20, portMacCount: 1 },
      port: { known: true, ifName: 'Gi1/0/7', adminStatus: 'down', operStatus: 'down' },
    }),
  };
  const res = await request(withLocator(locator))
    .get('/api/connection-test/ladder?ladder=device_location&device=10.0.0.5').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.stopsAt, 'state');
  assert.match(res.body.layers.find((l) => l.layer === 'state').because, /somebody shut it/);

  const none = await request(withLocator(null))
    .get('/api/connection-test/ladder?ladder=device_location&device=10.0.0.5').set('Authorization', viewer());
  assert.equal(none.status, 503);
});

test('a device nothing has seen is a verdict, not a 404', async () => {
  const res = await request(withLocator({ where: async () => null }))
    .get('/api/connection-test/ladder?ladder=device_location&device=10.0.0.5').set('Authorization', viewer());
  assert.equal(res.status, 200, 'a device the fleet has never seen looked like a broken API');
  assert.equal(res.body.stopsAt, 'identity');
});

test('a locator that throws does not take the diagnosis down with it', async () => {
  const res = await request(withLocator({ where: async () => { throw new Error('fdb table unreadable'); } }))
    .get('/api/connection-test/ladder?ladder=device_location&device=10.0.0.5').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.stopsAt, 'identity');
});

test('GET /ladder: every ladder rejects a missing or hostile input without a 500', async () => {
  const app2 = makeApp({ agentsRepo: twoAgents() });
  const bad = [
    '?ladder=two_way&agentId=1',
    '?ladder=two_way&agentId=1&peerAgentId=0',
    '?ladder=local_host',
    '?ladder=device_location',
    '?ladder=device_location&device=',
    '?ladder=device_location&device=a%20b;id',
    `?ladder=device_location&device=${'x'.repeat(400)}`,
    '?ladder=nope&agentId=1',
    '?ladder[]=two_way&agentId=1',
  ];
  for (const q of bad) {
    const res = await request(app2).get(`/api/connection-test/ladder${q}`).set('Authorization', viewer());
    assert.equal(res.status, 400, `${q} → ${res.status}`);
    assert.ok(res.body.details && Object.keys(res.body.details).length, q);
  }
});

// ------------------------------------- the join between a verdict and its why

test('the verdict carries the playbook that explains the rung it stopped at', async () => {
  const res = await request(ladderApp()).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.stopsAt, 'firewall');
  assert.deepEqual(res.body.playbooks.map((p) => p.id), ['firewall_acl']);
  assert.ok(res.body.playbooks[0].title.length > 5);
  assert.ok(res.body.playbooks[0].summary.length > 5);
});

test('the playbook comes back in the locale the verdict was asked for', async () => {
  const da = await request(ladderApp()).get('/api/connection-test/ladder?agentId=1&host=example.com&locale=da').set('Authorization', viewer());
  assert.match(da.body.playbooks[0].title, /firewall eller ACL/);
  const en = await request(ladderApp()).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.match(en.body.playbooks[0].title, /firewall or ACL/);
});

test('a ladder that is not broken offers nothing to read', async () => {
  const clean = [
    { type: 'dns', target: 'example.com', ok: true, rttMs: 7 },
    { type: 'ping', target: 'example.com', ok: true, lossPct: 0, rttMs: 12 },
    { type: 'tcp', target: 'example.com:443', ok: true, rttMs: 11 },
  ];
  const res = await request(ladderApp(clean)).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.stopsAt, null);
  assert.deepEqual(res.body.playbooks, []);
});

test('a rung nothing explains yet still gets a verdict, with an empty list', async () => {
  // TLS has no playbook. The ladder must still say where it stops — an
  // unexplained rung is not a reason to withhold the answer.
  const tlsBroken = [
    { type: 'dns', target: 'example.com', ok: true, rttMs: 7 },
    { type: 'ping', target: 'example.com', ok: true, lossPct: 0, rttMs: 12 },
    { type: 'tcp', target: 'example.com:443', ok: true, rttMs: 11 },
    { type: 'tls', target: 'example.com:443', ok: false, detail: 'certificate expired' },
  ];
  const res = await request(ladderApp(tlsBroken)).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.body.stopsAt, 'tls');
  assert.deepEqual(res.body.playbooks, []);
});

test('a deployment with no playbook catalogue still answers', async () => {
  const express = require('express');
  const { createConnectionTestRouter } = require('../src/routes/connectionTest');
  const bare = express();
  bare.use(express.json());
  bare.use('/api/connection-test', createConnectionTestRouter({
    agentsRepo: agentsRepo(),
    agentCommander: makeAgentCommander(),
    probeResultsRepo: makeProbeResultsRepo({ latestByAgent: async () => LADDER_ROWS }),
    diagnoseCatalog: null,
  }));
  const res = await request(bare).get('/api/connection-test/ladder?agentId=1&host=example.com').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.stopsAt, 'firewall');
  assert.deepEqual(res.body.playbooks, []);
});
