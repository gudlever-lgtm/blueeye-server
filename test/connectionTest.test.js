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
