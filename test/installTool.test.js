'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeAgentCommander, makeAuditRepo, makeAuditEventsRepo, authHeader,
} = require('../test-support/fakes');
const { createInstallToolService } = require('../src/services/installToolService');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');
const admin = () => authHeader('admin');
const agent5 = () => makeAgentsRepo({ findById: async () => ({ id: 5, hostname: 'node-5', location_id: 9 }) });

// ---- route: POST /agents/:id/install-tool ---------------------------------

test('POST /agents/:id/install-tool records a requested install + carries the audit id (operator)', async () => {
  let asked;
  const auditRepo = makeAuditRepo();
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, command) => { asked = command; return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }; },
  });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, auditRepo }))
    .post('/agents/5/install-tool').set('Authorization', operator()).send({ tool: 'traceroute' });
  assert.equal(res.status, 202);
  assert.equal(res.body.tool, 'traceroute');
  assert.equal(asked.name, 'install-tool');
  assert.equal(asked.tool, 'traceroute');
  assert.equal(asked.auditId, res.body.auditId);
  assert.equal(auditRepo.rows[0].action, 'install-tool');
  assert.equal(auditRepo.rows[0].targetVersion, 'traceroute');
  assert.equal(auditRepo.rows[0].agentHostname, 'node-5');
});

test('POST /agents/:id/install-tool rejects a tool not on the allowlist (400)', async () => {
  const res = await request(makeApp({ agentsRepo: agent5() }))
    .post('/agents/5/install-tool').set('Authorization', operator()).send({ tool: 'rm-rf' });
  assert.equal(res.status, 400);
  assert.match(res.body.details.tool, /must be one of/);
});

test('POST /agents/:id/install-tool is operator+ (403 viewer) and 404 for unknown agent', async () => {
  assert.equal((await request(makeApp({ agentsRepo: agent5() })).post('/agents/5/install-tool').set('Authorization', viewer()).send({ tool: 'traceroute' })).status, 403);
  const res404 = await request(makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) }))
    .post('/agents/9/install-tool').set('Authorization', operator()).send({ tool: 'traceroute' });
  assert.equal(res404.status, 404);
});

test('POST /agents/:id/install-tool marks failed + 409 when the agent is not connected', async () => {
  const auditRepo = makeAuditRepo();
  const agentCommander = makeAgentCommander({ sendCommandAndWait: async () => ({ delivered: 0, acked: false, reply: null }) });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, auditRepo }))
    .post('/agents/5/install-tool').set('Authorization', admin()).send({ tool: 'mtr' });
  assert.equal(res.status, 409);
  assert.equal(auditRepo.rows[0].state, 'failed');
  assert.equal(auditRepo.rows[0].result_detail, 'agent not connected');
});

// ---- auto-install service -------------------------------------------------

const failingTrace = [{ type: 'traceroute', target: 'example.com', ok: false, execError: 'traceroute not installed' }];
const settingsOn = { getAgents: async () => ({ autoInstallTools: true }) };
const settingsOff = { getAgents: async () => ({ autoInstallTools: false }) };

function svc(overrides = {}) {
  return createInstallToolService({
    agentCommander: overrides.agentCommander || makeAgentCommander(),
    auditRepo: overrides.auditRepo || makeAuditRepo(),
    auditEventsRepo: overrides.auditEventsRepo || makeAuditEventsRepo(),
    agentsRepo: overrides.agentsRepo || agent5(),
    settingsService: overrides.settingsService || settingsOn,
  });
}

test('auto-install pushes an install-tool command for a missing-tool probe failure when opted in', async () => {
  let sent = null;
  const agentCommander = makeAgentCommander({ sendCommand: (id, cmd) => { sent = { id, cmd }; return 1; } });
  const auditRepo = makeAuditRepo();
  const auditEventsRepo = makeAuditEventsRepo();
  await svc({ agentCommander, auditRepo, auditEventsRepo }).maybeAutoInstall(5, failingTrace);
  assert.ok(sent, 'a command was pushed');
  assert.equal(sent.cmd.name, 'install-tool');
  assert.equal(sent.cmd.tool, 'traceroute');
  assert.equal(auditRepo.rows[0].action, 'install-tool');
  // the auto-trigger is surfaced in the unified trail as a system action
  const ev = auditEventsRepo.rows.find((r) => r.action === 'agent.install-tool');
  assert.equal(ev.actorType, 'system');
  assert.deepEqual(ev.detail, { tool: 'traceroute', trigger: 'auto', delivered: true });
});

test('auto-install does nothing when the opt-in is off', async () => {
  let sent = 0;
  const agentCommander = makeAgentCommander({ sendCommand: () => { sent += 1; return 1; } });
  await svc({ agentCommander, settingsService: settingsOff }).maybeAutoInstall(5, failingTrace);
  assert.equal(sent, 0);
});

test('auto-install ignores ordinary loss (no execError) and unknown failures', async () => {
  let sent = 0;
  const agentCommander = makeAgentCommander({ sendCommand: () => { sent += 1; return 1; } });
  const results = [{ type: 'ping', target: 'x', ok: false, lossPct: 100 }, { type: 'dns', target: 'y', ok: false, execError: 'dns failed' }];
  await svc({ agentCommander }).maybeAutoInstall(5, results);
  assert.equal(sent, 0);
});

test('auto-install is throttled by a recent identical request in the audit trail', async () => {
  let sent = 0;
  const agentCommander = makeAgentCommander({ sendCommand: () => { sent += 1; return 1; } });
  const auditRepo = makeAuditRepo();
  // seed a recent install-tool request for the same agent+tool
  await auditRepo.record({ agentId: 5, action: 'install-tool', targetVersion: 'traceroute' });
  await svc({ agentCommander, auditRepo }).maybeAutoInstall(5, failingTrace);
  assert.equal(sent, 0);
});

test('auto-install marks the audit row failed when the agent is not connected', async () => {
  const agentCommander = makeAgentCommander({ sendCommand: () => 0 });
  const auditRepo = makeAuditRepo();
  await svc({ agentCommander, auditRepo }).maybeAutoInstall(5, failingTrace);
  assert.equal(auditRepo.rows[0].state, 'failed');
  assert.equal(auditRepo.rows[0].result_detail, 'agent not connected');
});
