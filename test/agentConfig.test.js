'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  authHeader,
} = require('../test-support/fakes');

// An agent token that maps to agent_id 9.
const agentToken = () =>
  makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
const operator = () => authHeader('operator');

// ---------------------------------------- PUT /agents/:id with monitor_config
test('PUT /agents/:id accepts a valid snmp monitor_config', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 1, hostname: 'h' }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'snmp', snmp: { host: '10.0.0.1', version: '2c', port: 161 }, intervalMs: 60000 } });

  assert.equal(res.status, 200);
  assert.equal(patch.monitor_config.source, 'snmp');
  assert.equal(patch.monitor_config.snmp.host, '10.0.0.1');
  assert.equal(patch.monitor_config.intervalMs, 60000);
});

test('PUT /agents/:id accepts source proc', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 1 }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'proc' } });
  assert.equal(res.status, 200);
  assert.equal(patch.monitor_config.source, 'proc');
});

test('PUT /agents/:id accepts source netflow with an optional port', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 1 }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'netflow', netflow: { port: 2055 } } });
  assert.equal(res.status, 200);
  assert.equal(patch.monitor_config.source, 'netflow');
  assert.equal(patch.monitor_config.netflow.port, 2055);
});

test('PUT /agents/:id accepts a netflow/sflow collector bindAddress (IP literal)', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 1 }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const app = makeApp({ agentsRepo });
  let res = await request(app)
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'netflow', netflow: { port: 2055, bindAddress: '127.0.0.1' } } });
  assert.equal(res.status, 200);
  assert.equal(patch.monitor_config.netflow.bindAddress, '127.0.0.1');

  res = await request(app)
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { bindAddress: '::1' } } });
  assert.equal(res.status, 200);
  assert.equal(patch.monitor_config.sflow.bindAddress, '::1');
});

test('PUT /agents/:id rejects a non-IP collector bindAddress (400)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { bindAddress: 'eth0; rm -rf /' } } });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.monitor_config);
});

test('PUT /agents/:id rejects a bad netflow port (400)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'netflow', netflow: { port: 70000 } } });
  assert.equal(res.status, 400);
});

test('PUT /agents/:id accepts source sflow with an optional port', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 1 }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { port: 6343 } } });
  assert.equal(res.status, 200);
  assert.equal(patch.monitor_config.source, 'sflow');
  assert.equal(patch.monitor_config.sflow.port, 6343);
});

test('PUT /agents/:id accepts a sflow hsflowd exporter block', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 1 }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { port: 6343, hsflowd: { samplingRate: 512, device: 'eth0' } } } });
  assert.equal(res.status, 200);
  assert.deepEqual(patch.monitor_config.sflow.hsflowd, { samplingRate: 512, device: 'eth0' });
});

test('PUT /agents/:id accepts hsflowd:true (defaults) and normalises it', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 1 }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { hsflowd: true } } });
  assert.equal(res.status, 200);
  assert.equal(patch.monitor_config.sflow.hsflowd, true);
});

test('PUT /agents/:id rejects a bad hsflowd samplingRate (400)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { hsflowd: { samplingRate: 0 } } } });
  assert.equal(res.status, 400);
});

test('PUT /agents/:id rejects an hsflowd device with shell-unsafe characters (400)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { hsflowd: { device: 'eth0; rm -rf /' } } } });
  assert.equal(res.status, 400);
});

test('PUT /agents/:id rejects a bad sflow port (400)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'sflow', sflow: { port: 0 } } });
  assert.equal(res.status, 400);
});

test('PUT /agents/:id rejects an invalid monitor_config source (400)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'carrier-pigeon' } });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.monitor_config);
});

test('PUT /agents/:id rejects snmp without a host (400)', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 1 }) });
  const res = await request(makeApp({ agentsRepo }))
    .put('/agents/1')
    .set('Authorization', operator())
    .send({ monitor_config: { source: 'snmp', snmp: {} } });
  assert.equal(res.status, 400);
  assert.match(res.body.details.monitor_config, /host is required/);
});

// ------------------------------------------------- GET /agents/me/config (token)
test('GET /agents/me/config returns the assigned config', async () => {
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 9, monitor_config: { source: 'snmp', snmp: { host: '1.2.3.4' } } }),
  });
  const res = await request(makeApp({ agentsRepo, agentTokensRepo: agentToken() }))
    .get('/agents/me/config')
    .set('Authorization', 'Bearer agent-tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 9);
  assert.equal(res.body.monitorConfig.source, 'snmp');
});

test('GET /agents/me/config defaults to proc when unset', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 9, monitor_config: null }) });
  const res = await request(makeApp({ agentsRepo, agentTokensRepo: agentToken() }))
    .get('/agents/me/config')
    .set('Authorization', 'Bearer agent-tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.monitorConfig.source, 'proc');
});

test('GET /agents/me/config without an agent token returns 401', async () => {
  const res = await request(makeApp()).get('/agents/me/config');
  assert.equal(res.status, 401);
});

test('GET /agents/me/config with a USER jwt (not an agent token) returns 401', async () => {
  // A staff JWT is not a valid agent token, so agent-token auth rejects it.
  const res = await request(makeApp())
    .get('/agents/me/config')
    .set('Authorization', operator());
  assert.equal(res.status, 401);
});

// -------------------------------------- POST /agents/me/capabilities (token)
test('POST /agents/me/capabilities stores capabilities for the token agent', async () => {
  let stored;
  const agentsRepo = makeAgentsRepo({
    setCapabilities: async (id, caps) => { stored = { id, caps }; return { id, capabilities: caps }; },
  });
  const res = await request(makeApp({ agentsRepo, agentTokensRepo: agentToken() }))
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc', 'snmp'], agentVersion: '0.1.0' } });

  assert.equal(res.status, 200);
  assert.equal(stored.id, 9); // agent id comes from the token
  assert.deepEqual(stored.caps.sources, ['proc', 'snmp']);
});

test('POST /agents/me/capabilities normalises a NIC inventory and drops junk fields', async () => {
  let stored;
  const agentsRepo = makeAgentsRepo({
    setCapabilities: async (id, caps) => { stored = caps; return { id, capabilities: caps }; },
  });
  const res = await request(makeApp({ agentsRepo, agentTokensRepo: agentToken() }))
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc'], nic: [
      { iface: 'wlan0', driver: 'iwlwifi', firmwareVersion: '83.A', secret: 'drop-me', port: 1234 },
      'garbage',
    ] } });
  assert.equal(res.status, 200);
  assert.equal(stored.nic.length, 1);
  assert.deepEqual(stored.nic[0], { iface: 'wlan0', driver: 'iwlwifi', firmwareVersion: '83.A' });
});

test('POST /agents/me/capabilities rejects a bad shape (400)', async () => {
  const res = await request(makeApp({ agentTokensRepo: agentToken() }))
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: 'not-an-array' } });
  assert.equal(res.status, 400);
});

test('POST /agents/me/capabilities rejects a non-array nic (400)', async () => {
  const res = await request(makeApp({ agentTokensRepo: agentToken() }))
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc'], nic: 'eth0' } });
  assert.equal(res.status, 400);
});

test('POST /agents/me/capabilities without an agent token returns 401', async () => {
  const res = await request(makeApp())
    .post('/agents/me/capabilities')
    .send({ capabilities: { sources: ['proc'] } });
  assert.equal(res.status, 401);
});
