'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeAgentCommander, makeAuditRepo, makeSourceStore, authHeader } = require('../test-support/fakes');
const { createAgentActionAuditRepository } = require('../src/repositories/agentActionAuditRepository');

const viewer = () => authHeader('viewer');
const operator = () => authHeader('operator');
const admin = () => authHeader('admin');

const agent5 = () => makeAgentsRepo({ findById: async () => ({ id: 5, hostname: 'node-5', location_id: 9 }) });

// ---- update records the action + carries the audit id ----------------------

test('POST /agents/:id/update records a requested upgrade and sends the audit id', async () => {
  let asked;
  const auditRepo = makeAuditRepo();
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, command) => { asked = command; return { delivered: 1, acked: true, reply: { accepted: true, runtime: 'systemd' } }; },
  });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, auditRepo, agentSourceStore: makeSourceStore({ sourceVersion: () => '0.1.0' }) }))
    .post('/agents/5/update').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(typeof res.body.auditId, 'number');
  assert.equal(asked.auditId, res.body.auditId); // the agent gets the id to echo back
  assert.equal(auditRepo.rows.length, 1);
  assert.equal(auditRepo.rows[0].action, 'upgrade');
  assert.equal(auditRepo.rows[0].agentId, 5);
  assert.equal(auditRepo.rows[0].agentHostname, 'node-5');
  assert.equal(auditRepo.rows[0].actorEmail, 'admin@blueeye.local');
  assert.equal(auditRepo.rows[0].state, 'requested'); // accepted, but completion is async
});

test('POST /agents/:id/update marks the audit row failed when a runtime declines', async () => {
  const auditRepo = makeAuditRepo();
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async () => ({ delivered: 1, acked: true, reply: { accepted: false, runtime: 'docker', reason: 'docker-managed' } }),
  });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, auditRepo }))
    .post('/agents/5/update').set('Authorization', admin());
  assert.equal(res.status, 202);
  assert.equal(auditRepo.rows[0].state, 'failed');
  assert.equal(auditRepo.rows[0].result_detail, 'docker-managed');
});

// ---- delete command --------------------------------------------------------

test('POST /agents/:id/delete sends a delete command and records it (admin)', async () => {
  let asked;
  const auditRepo = makeAuditRepo();
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async (id, command) => { asked = command; return { delivered: 1, acked: true, reply: { accepted: true } }; },
  });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, auditRepo }))
    .post('/agents/5/delete').set('Authorization', admin());

  assert.equal(res.status, 202);
  assert.equal(asked.name, 'delete');
  assert.equal(asked.auditId, res.body.auditId);
  assert.equal(auditRepo.rows[0].action, 'delete');
  assert.equal(auditRepo.rows[0].state, 'requested');
});

test('POST /agents/:id/delete marks failed + returns 409 when the agent is not connected', async () => {
  const auditRepo = makeAuditRepo();
  const agentCommander = makeAgentCommander({ sendCommandAndWait: async () => ({ delivered: 0, acked: false, reply: null }) });
  const res = await request(makeApp({ agentsRepo: agent5(), agentCommander, auditRepo }))
    .post('/agents/5/delete').set('Authorization', admin());
  assert.equal(res.status, 409);
  assert.equal(auditRepo.rows[0].state, 'failed');
  assert.equal(auditRepo.rows[0].result_detail, 'agent not connected');
});

test('POST /agents/:id/delete is admin-only (403 operator) and 404 for unknown agent', async () => {
  assert.equal((await request(makeApp()).post('/agents/5/delete').set('Authorization', operator())).status, 403);
  const res404 = await request(makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) }))
    .post('/agents/9/delete').set('Authorization', admin());
  assert.equal(res404.status, 404);
});

test('POST /agents/:id/delete without a token returns 401', async () => {
  assert.equal((await request(makeApp()).post('/agents/5/delete')).status, 401);
});

// ---- audit query routes ----------------------------------------------------

test('GET /agents/:id/audit returns the per-agent trail (admin), 403 for a viewer', async () => {
  const auditRepo = makeAuditRepo();
  await auditRepo.record({ agentId: 5, action: 'upgrade', targetVersion: '0.4.0', actorUserId: 1 });
  const app = makeApp({ agentsRepo: agent5(), auditRepo });

  const ok = await request(app).get('/agents/5/audit').set('Authorization', admin());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 1);
  assert.equal(ok.body[0].action, 'upgrade');

  assert.equal((await request(app).get('/agents/5/audit').set('Authorization', viewer())).status, 403);
});

test('GET /audit (admin) lists all, filters by ?user=, and validates the id', async () => {
  const auditRepo = makeAuditRepo();
  await auditRepo.record({ agentId: 5, action: 'upgrade', actorUserId: 1 });
  await auditRepo.record({ agentId: 6, action: 'delete', actorUserId: 2 });
  const app = makeApp({ auditRepo });

  const all = await request(app).get('/audit').set('Authorization', admin());
  assert.equal(all.status, 200);
  assert.equal(all.body.length, 2);

  const byUser = await request(app).get('/audit?user=2').set('Authorization', admin());
  assert.equal(byUser.body.length, 1);
  assert.equal(byUser.body[0].action, 'delete');

  assert.equal((await request(app).get('/audit?user=abc').set('Authorization', admin())).status, 400);
  assert.equal((await request(app).get('/audit').set('Authorization', operator())).status, 403);
});

// ---- repository SQL (fake pool) --------------------------------------------

test('agentActionAuditRepository issues the expected INSERT/UPDATE/SELECT', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^INSERT/i.test(sql.trim())) return [{ insertId: 42 }];
      if (/^UPDATE/i.test(sql.trim())) return [{ affectedRows: 1 }];
      return [[]];
    },
  };
  const repo = createAgentActionAuditRepository({ pool });

  const id = await repo.record({ agentId: 5, action: 'upgrade', targetVersion: '0.4.0', actorUserId: 1 });
  assert.equal(id, 42);
  assert.match(calls[0].sql, /INSERT INTO agent_action_audit/);
  assert.match(calls[0].sql, /'requested'/);

  assert.equal(await repo.complete(42, { state: 'completed', resultDetail: 'ok' }), true);
  assert.match(calls[1].sql, /UPDATE agent_action_audit SET state = \?/);
  assert.match(calls[1].sql, /state = 'requested'/); // only flips a still-requested row

  await repo.findByAgent(5, { limit: 25 });
  assert.deepEqual(calls[2].params, [5, 25]);
});
