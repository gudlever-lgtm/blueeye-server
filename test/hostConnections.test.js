'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeAgentTokensRepo, makeServiceDependenciesRepo, makeHostConnectionsRepo,
} = require('../test-support/fakes');
const { sanitize } = require('../src/repositories/hostConnectionsRepository');
const { createServiceDependencyJob } = require('../src/topology/serviceDependencyJob');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

// ---- repo sanitize ---------------------------------------------------------

test('sanitize drops self/empty/invalid-port edges and defaults connCount', () => {
  const out = sanitize([
    { srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, connCount: 3 },
    { srcIp: '10.0.0.1', dstIp: '10.0.0.1', dstPort: 22 }, // self → dropped
    { srcIp: '', dstIp: '10.0.0.2', dstPort: 80 }, // empty src → dropped
    { srcIp: '10.0.0.1', dstIp: '10.0.0.9', dstPort: 70000 }, // bad port → dropped
    { srcIp: '10.0.0.1', dstIp: '10.0.0.3', dstPort: 5432 }, // no count → defaults 1
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, connCount: 3 });
  assert.equal(out[1].connCount, 1);
});

// ---- capabilities ingest ---------------------------------------------------

test('POST /agents/me/capabilities ingests connection edges for the agent', async () => {
  const hostConnectionsRepo = makeHostConnectionsRepo();
  const agentsRepo = makeAgentsRepo();
  const app = makeApp({ hostConnectionsRepo, agentsRepo, agentTokensRepo: agentToken() });
  const res = await request(app)
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc'], connections: [{ srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, connCount: 2 }] } });
  assert.equal(res.status, 200);
  assert.equal(hostConnectionsRepo.rows.length, 1);
  assert.equal(hostConnectionsRepo.rows[0].agent_id, 9); // from the token
  assert.equal(hostConnectionsRepo.rows[0].dst_port, 443);
});

test('POST /agents/me/capabilities without connections leaves the table empty', async () => {
  const hostConnectionsRepo = makeHostConnectionsRepo();
  const app = makeApp({ hostConnectionsRepo, agentsRepo: makeAgentsRepo(), agentTokensRepo: agentToken() });
  const res = await request(app)
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc'] } });
  assert.equal(res.status, 200);
  assert.equal(hostConnectionsRepo.rows.length, 0);
});

// ---- service-dependency job merge ------------------------------------------

test('service-dependency job merges connection-table edges with the flow edges', async () => {
  const serviceDependenciesRepo = makeServiceDependenciesRepo();
  const hostConnectionsRepo = makeHostConnectionsRepo();
  // Agent 1 reports it talks to agent 2 on 443 (no flow exporter → no flow rows).
  await hostConnectionsRepo.replaceForAgent(1, [{ srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, connCount: 3 }]);
  const agentsRepo = makeAgentsRepo({
    findAll: async () => ([
      { id: 1, capabilities: { ips: ['10.0.0.1'] } },
      { id: 2, capabilities: { ips: ['10.0.0.2'] } },
    ]),
  });
  const flowsRepo = { tcpServiceFlows: async () => [] }; // no flow data at all
  const job = createServiceDependencyJob({ serviceDependenciesRepo, flowsRepo, agentsRepo, hostConnectionsRepo });
  const result = await job.run();
  assert.ok(result && result.stats.edges >= 1);
  const edge = serviceDependenciesRepo.rows.find((r) => r.src_host_id === 1 && r.dst_host_id === 2 && r.dst_port === 443);
  assert.ok(edge, 'connection-derived edge is stored');
  assert.equal(edge.conn_count, 3);
  assert.equal(edge.bytes, 0); // a connection table has no byte counters
});

test('job drops connection edges whose endpoints are not monitored hosts', async () => {
  const serviceDependenciesRepo = makeServiceDependenciesRepo();
  const hostConnectionsRepo = makeHostConnectionsRepo();
  await hostConnectionsRepo.replaceForAgent(1, [{ srcIp: '10.0.0.1', dstIp: '8.8.8.8', dstPort: 443, connCount: 5 }]);
  const agentsRepo = makeAgentsRepo({ findAll: async () => ([{ id: 1, capabilities: { ips: ['10.0.0.1'] } }]) });
  const flowsRepo = { tcpServiceFlows: async () => [] };
  const job = createServiceDependencyJob({ serviceDependenciesRepo, flowsRepo, agentsRepo, hostConnectionsRepo });
  await job.run();
  assert.equal(serviceDependenciesRepo.rows.length, 0); // 8.8.8.8 is unknown → dropped
});
