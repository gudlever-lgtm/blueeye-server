'use strict';

// GET /agents/:id/tests — "what can this agent run, and what already targets it?"
//
// The screen behind it is the agent's own Tests tab, and the whole point of the
// endpoint is that it answers BEFORE a run rather than after a failure. So the
// cases that matter are the honest ones: an agent that said SNMP is missing, an
// old agent that said nothing at all, and an agent nobody is holding a socket to.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeAgentCommander, makeTestPackagesRepo, authHeader,
} = require('../test-support/fakes');
const { TEST_CATALOGUE, runnableTests } = require('../src/services/agentTestCatalogue');

const viewer = () => authHeader('viewer');

const AGENT = {
  id: 7,
  hostname: 'edge-1',
  status: 'online',
  capabilities: { sources: ['proc', 'netflow', 'sflow'], unavailable: { snmp: 'net-snmp is missing — reinstall the agent' } },
};

function appWith(overrides = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findById: async (id) => (Number(id) === AGENT.id ? AGENT : null),
      findAll: async () => [AGENT],
      ...(overrides.agentsRepo || {}),
    }),
    ...overrides.rest,
  });
}

// ------------------------------------------------------------------ catalogue
test('the catalogue marks poll-snmp unavailable with the AGENT\'s own reason', () => {
  const list = runnableTests(AGENT);
  assert.equal(list.length, TEST_CATALOGUE.length);
  const snmp = list.find((x) => x.type === 'poll-snmp');
  assert.equal(snmp.available, false);
  assert.match(snmp.reason, /net-snmp is missing/);
  // Everything else on a healthy proc agent is offered.
  assert.deepEqual(list.filter((x) => !x.available).map((x) => x.type), ['poll-snmp']);
});

test('an agent that reported no sources at all is not greyed out', () => {
  // An older agent in the field reports fewer fields. Treating silence as "no"
  // would disable every test on it — a regression dressed as a feature.
  for (const agent of [{ id: 1 }, { id: 1, capabilities: null }, { id: 1, capabilities: { managed: 'systemd' } }]) {
    assert.deepEqual(runnableTests(agent).filter((x) => !x.available), [], JSON.stringify(agent));
  }
});

test('an agent with an empty source list loses the tests that need one, and keeps the rest', () => {
  const list = runnableTests({ id: 1, capabilities: { sources: [], unavailable: {} } });
  const blocked = list.filter((x) => !x.available).map((x) => x.type).sort();
  assert.deepEqual(blocked, ['poll-snmp', 'run-test']);
  assert.equal(list.find((x) => x.type === 'ping').available, true);
});

// ---------------------------------------------------------------- the endpoint
test('GET /agents/:id/tests returns the catalogue and the packages aimed at the agent', async () => {
  const packagesRepo = makeTestPackagesRepo({
    findAll: async () => [
      { id: 1, name: 'All agents', enabled: true, items: [{}], targets: { mode: 'all' }, schedule_ms: 60000 },
      { id: 2, name: 'This one', enabled: true, items: [{}, {}], targets: { mode: 'agents', agentIds: [7] }, schedule_ms: 0 },
      { id: 3, name: 'Someone else', enabled: false, items: [{}], targets: { mode: 'agents', agentIds: [99] }, schedule_ms: 0 },
    ],
  });
  const res = await request(appWith({ rest: { testPackagesRepo: packagesRepo } }))
    .get('/agents/7/tests').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 7);
  assert.equal(res.body.tests.length, TEST_CATALOGUE.length);
  assert.deepEqual(res.body.packages.map((p) => p.name), ['All agents', 'This one']);
  assert.equal(res.body.packages[1].items, 2);
});

test('GET /agents/:id/tests reports connectivity from the live socket, not the stored status', async () => {
  // The row says online; nothing holds a socket. A test offered as runnable
  // right now would be a lie the operator only finds out about after clicking.
  const offline = await request(appWith()).get('/agents/7/tests').set('Authorization', viewer());
  assert.equal(offline.body.connected, false);

  const live = await request(appWith({
    rest: { agentCommander: makeAgentCommander({ connectedAgentIds: () => [7] }) },
  })).get('/agents/7/tests').set('Authorization', viewer());
  assert.equal(live.body.connected, true);
});

test('GET /agents/:id/tests still answers when the package repository throws (500 would lose the catalogue)', async () => {
  const packagesRepo = makeTestPackagesRepo({ findAll: async () => { throw new Error('mysql gone'); } });
  const res = await request(appWith({ rest: { testPackagesRepo: packagesRepo } }))
    .get('/agents/7/tests').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.packages, []);
  assert.equal(res.body.tests.length, TEST_CATALOGUE.length);
});

test('GET /agents/:id/tests: 400 for a non-numeric id, 404 for an unknown agent, 401 without a token', async () => {
  const app = appWith();
  assert.equal((await request(app).get('/agents/abc/tests').set('Authorization', viewer())).status, 400);
  assert.equal((await request(app).get('/agents/999/tests').set('Authorization', viewer())).status, 404);
  assert.equal((await request(app).get('/agents/7/tests')).status, 401);
});

test('GET /agents/:id/tests returns 500 when the agent read itself fails', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => { throw new Error('boom'); } }) });
  const res = await request(app).get('/agents/7/tests').set('Authorization', viewer());
  assert.equal(res.status, 500);
});
