'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// An update that can only be delivered while the operator is watching is an
// update an intermittently-connected fleet never gets. These specs cover the
// three ways that changed: the queue, the fleet rollout, and an agent that asks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentCommander,
  makeSourceStore,
  makeReleaseStore,
  makeCommandQueue,
  makeSettingsService,
  makeAgentTokensRepo,
  authHeader,
} = require('../test-support/fakes');

// An agent token that maps to agent_id 7.
const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 7 }) });

const viewer = () => authHeader('viewer');
const admin = () => authHeader('admin');

const offline = () => makeAgentCommander({ sendCommandAndWait: async () => ({ delivered: 0, acked: false, reply: null }) });
const accepts = (seen = []) => makeAgentCommander({
  sendCommandAndWait: async (id, command) => {
    seen.push({ id, command });
    return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } };
  },
});

// ---- the queue -------------------------------------------------------------

test('an update for an offline agent is queued instead of refused', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 7, hostname: 'node-7' }) });
  const agentCommandQueue = makeCommandQueue();

  const res = await request(makeApp({ agentsRepo, agentCommander: offline(), agentCommandQueue }))
    .post('/agents/7/update')
    .set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.queued, true);
  const waiting = await agentCommandQueue.pendingFor(7);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].command.name, 'update');
});

test('queueing an update twice leaves one command, with the newest target', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 7 }) });
  const agentCommandQueue = makeCommandQueue();
  const app = makeApp({ agentsRepo, agentCommander: offline(), agentCommandQueue });

  await request(app).post('/agents/7/update').set('Authorization', admin());
  await request(app).post('/agents/7/update').set('Authorization', admin());

  assert.equal((await agentCommandQueue.pendingFor(7)).length, 1);
});

test('without a queue an offline agent still answers 409, as it did before', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 7 }) });
  const res = await request(makeApp({ agentsRepo, agentCommander: offline(), agentCommandQueue: null }))
    .post('/agents/7/update')
    .set('Authorization', admin());
  assert.equal(res.status, 409);
  assert.equal(res.body.queued, false);
});

test('a queued command never carries a signature or a correlation id', async () => {
  // Both are bound to a moment: the agent refuses a signature more than five
  // minutes off its clock, and the id is stamped per send. Storing either would
  // guarantee the command is refused when it is finally delivered.
  const { stripTransport } = require('../src/repositories/agentCommandQueueRepository');
  const stored = stripTransport({
    name: 'update', version: '1.2.3', id: 's1', commandSignature: 'abc', issuedAt: 123, auditId: 9,
  });
  assert.deepEqual(stored, { name: 'update', version: '1.2.3', auditId: 9 });
});

// ---- the fleet rollout -----------------------------------------------------

const fleetAgents = () => makeAgentsRepo({
  findAll: async () => [
    { id: 1, hostname: 'a', location_id: 1, capabilities: { agentVersion: '0.9.0', managed: 'systemd' } },
    { id: 2, hostname: 'b', location_id: 1, capabilities: { agentVersion: '9.9.9', managed: 'systemd' } },
    { id: 3, hostname: 'c', location_id: 2, capabilities: { agentVersion: '0.9.0', managed: 'docker' } },
    { id: 4, hostname: 'd', location_id: 2, capabilities: { agentVersion: '0.9.0', managed: 'windows-service' } },
    { id: 5, hostname: 'e', location_id: 2, capabilities: {} },
  ],
});

// The source bundle decides the offered version in these specs.
const sourceAt = (version) => makeSourceStore({ sourceVersion: () => version, available: () => true });

test('GET /agents/updates/fleet counts what is behind without touching anything', async () => {
  const res = await request(makeApp({
    agentsRepo: fleetAgents(),
    agentSourceStore: sourceAt('1.0.0'),
    releaseStore: makeReleaseStore({ latest: () => null }),
  }))
    .get('/agents/updates/fleet')
    .set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.offeredVersion, '1.0.0');
  // a and d are behind and restartable; b is current; c is docker; e never
  // reported a version.
  assert.deepEqual(res.body.targets.map((t) => t.id), [1, 4]);
  assert.equal(res.body.behind, 2);
  assert.equal(res.body.unknownVersion, 1);
});

test('a fleet rollout moves at most one batch and says what is left', async () => {
  const seen = [];
  const res = await request(makeApp({
    agentsRepo: fleetAgents(),
    agentCommander: accepts(seen),
    agentSourceStore: sourceAt('1.0.0'),
    releaseStore: makeReleaseStore({ latest: () => null }),
  }))
    .post('/agents/updates/fleet')
    .set('Authorization', admin())
    .send({ batch: 1 });

  assert.equal(res.status, 202);
  assert.equal(res.body.moved, 1);
  assert.equal(res.body.remaining, 1, 'the canary is one call; the operator looks, then continues');
  assert.deepEqual(res.body.results.map((r) => r.id), [1]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command.name, 'update');
});

test('a fleet rollout queues the agents that are not connected', async () => {
  const agentCommandQueue = makeCommandQueue();
  const res = await request(makeApp({
    agentsRepo: fleetAgents(),
    agentCommander: offline(),
    agentCommandQueue,
    agentSourceStore: sourceAt('1.0.0'),
    releaseStore: makeReleaseStore({ latest: () => null }),
  }))
    .post('/agents/updates/fleet')
    .set('Authorization', admin())
    .send({ batch: 10 });

  assert.equal(res.status, 202);
  assert.deepEqual(res.body.counts, { queued: 2 });
  assert.equal((await agentCommandQueue.pendingFor(1)).length, 1);
  assert.equal((await agentCommandQueue.pendingFor(4)).length, 1);
});

test('a dry run changes nothing', async () => {
  const seen = [];
  const agentCommandQueue = makeCommandQueue();
  const res = await request(makeApp({
    agentsRepo: fleetAgents(),
    agentCommander: accepts(seen),
    agentCommandQueue,
    agentSourceStore: sourceAt('1.0.0'),
    releaseStore: makeReleaseStore({ latest: () => null }),
  }))
    .post('/agents/updates/fleet')
    .set('Authorization', admin())
    .send({ dryRun: true, locationId: 2 });

  assert.equal(res.status, 200);
  assert.equal(res.body.dryRun, true);
  assert.deepEqual(res.body.wouldUpdate.map((t) => t.id), [4]);
  assert.equal(seen.length, 0);
  assert.equal(agentCommandQueue._rows.size, 0);
});

test('a fleet rollout rejects a nonsense batch and a nonsense agent list', async () => {
  const app = makeApp({ agentsRepo: fleetAgents(), agentSourceStore: sourceAt('1.0.0') });
  for (const body of [{ batch: 0 }, { batch: 9999 }, { agentIds: ['x'] }, { locationId: -1 }]) {
    const res = await request(app).post('/agents/updates/fleet').set('Authorization', admin()).send(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} must not be accepted`);
  }
});

test('a viewer cannot start a fleet rollout', async () => {
  const res = await request(makeApp({ agentsRepo: fleetAgents() }))
    .post('/agents/updates/fleet')
    .set('Authorization', viewer())
    .send({});
  assert.equal(res.status, 403);
});

// ---- the offer in the agent's own config -----------------------------------

test('GET /agents/me/config tells the agent what is offered and whether it may act', async () => {
  const app = makeApp({
    agentTokensRepo: agentToken(),
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 7, monitor_config: null }) }),
    agentSourceStore: sourceAt('1.0.0'),
    releaseStore: makeReleaseStore({ latest: () => null }),
    settingsService: makeSettingsService({ initial: { agents: { autoUpdate: true, autoUpdateWindow: '02:00-04:00' } } }),
  });
  const res = await request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-token');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.updates, { agentVersion: '1.0.0', auto: true, window: '02:00-04:00' });
});

test('the offer says auto:false until someone turns the policy on', async () => {
  const app = makeApp({
    agentTokensRepo: agentToken(),
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 7, monitor_config: null }) }),
    agentSourceStore: sourceAt('1.0.0'),
    releaseStore: makeReleaseStore({ latest: () => null }),
  });
  const res = await request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-token');
  assert.equal(res.status, 200);
  assert.equal(res.body.updates.auto, false, 'pushing code to customer hosts is opt-in');
});
