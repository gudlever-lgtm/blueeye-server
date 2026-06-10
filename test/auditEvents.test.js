'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAuditEventsRepo, makeAgentsRepo, makeAgentCommander, makeUsersRepo, authHeader,
} = require('../test-support/fakes');
const { hashPassword } = require('../src/auth/password');

const admin = () => authHeader('admin');
const operator = () => authHeader('operator');
const viewer = () => authHeader('viewer');

// Lets res.on('finish') + the fire-and-forget audit write settle before asserting.
const settle = () => new Promise((r) => setImmediate(r));

// ---- read API RBAC ---------------------------------------------------------

test('GET /api/audit requires authentication', async () => {
  const res = await request(makeApp()).get('/api/audit');
  assert.equal(res.status, 401);
});

test('GET /api/audit is forbidden for non-admins', async () => {
  for (const who of [viewer, operator]) {
    const res = await request(makeApp()).get('/api/audit').set('Authorization', who());
    assert.equal(res.status, 403);
  }
});

test('GET /api/audit returns the trail for an admin', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', actorLabel: 'a@b.c', action: 'user.update' });
  const res = await request(makeApp({ auditEventsRepo })).get('/api/audit').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].action, 'user.update');
});

test('GET /api/audit/actions lists distinct actions (admin)', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ action: 'user.update' });
  await auditEventsRepo.record({ action: 'user.update' });
  await auditEventsRepo.record({ action: 'agent.delete' });
  const res = await request(makeApp({ auditEventsRepo })).get('/api/audit/actions').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ['agent.delete', 'user.update']);
});

test('GET /api/audit/export.csv returns CSV (admin)', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', actorLabel: 'a@b.c', action: 'user.update' });
  const res = await request(makeApp({ auditEventsRepo })).get('/api/audit/export.csv').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.text, /^ts,actorType,actorLabel/);
  assert.match(res.text, /user\.update/);
});

test('GET /api/audit filters by actorType', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', action: 'user.update' });
  await auditEventsRepo.recordRecurring({ actorType: 'agent', action: 'agent.probe', dedupKey: 'k1' });
  const res = await request(makeApp({ auditEventsRepo })).get('/api/audit?actorType=agent').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].actorType, 'agent');
});

// ---- middleware: user actions are audited ----------------------------------

test('a successful user mutation is recorded with who/what/when', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5, hostname: 'node-5' }) });
  const app = makeApp({ auditEventsRepo, agentsRepo, agentCommander: makeAgentCommander() });
  const res = await request(app).post('/agents/5/run-test').set('Authorization', operator()).send({});
  assert.equal(res.status, 202);
  await settle();
  assert.equal(auditEventsRepo.rows.length, 1);
  const row = auditEventsRepo.rows[0];
  assert.equal(row.action, 'agent.run-test');
  assert.equal(row.actorType, 'user');
  assert.equal(row.actorLabel, 'operator@blueeye.local');
  assert.equal(row.actorRole, 'operator');
  assert.equal(row.targetId, '5');
  assert.equal(row.method, 'POST');
  assert.equal(row.status, 202);
});

test('a repeating run-test records the repeat interval annotation', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: 5, hostname: 'node-5' }) });
  const app = makeApp({ auditEventsRepo, agentsRepo, agentCommander: makeAgentCommander() });
  await request(app).post('/agents/5/run-test').set('Authorization', operator()).send({ intervalMs: 60000 });
  await settle();
  assert.equal(auditEventsRepo.rows[0].repeatIntervalMs, 60000);
});

test('failed (non-2xx) requests are not audited', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  // No agent found -> 404 from the run-test route.
  const agentsRepo = makeAgentsRepo({ findById: async () => null });
  const app = makeApp({ auditEventsRepo, agentsRepo });
  const res = await request(app).post('/agents/5/run-test').set('Authorization', operator()).send({});
  assert.equal(res.status, 404);
  await settle();
  assert.equal(auditEventsRepo.rows.length, 0);
});

test('GET requests are never audited', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const app = makeApp({ auditEventsRepo });
  await request(app).get('/agents').set('Authorization', viewer());
  await settle();
  assert.equal(auditEventsRepo.rows.length, 0);
});

test('reading the audit log does not audit itself', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const app = makeApp({ auditEventsRepo });
  await request(app).get('/api/audit').set('Authorization', admin());
  await settle();
  assert.equal(auditEventsRepo.rows.length, 0);
});

test('a successful login is audited with the posted email and secrets redacted', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => ({ id: 1, email: 'admin@blueeye.local', role: 'admin', password_hash: await hashPassword('pw-correct') }),
  });
  const app = makeApp({ auditEventsRepo, usersRepo });
  const res = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'pw-correct' });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(auditEventsRepo.rows.length, 1);
  const row = auditEventsRepo.rows[0];
  assert.equal(row.action, 'auth.login');
  assert.equal(row.actorLabel, 'admin@blueeye.local');
  assert.equal(row.detail.password, '[redacted]');
});

test('a failed login is not audited', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  const usersRepo = makeUsersRepo({
    findByEmailWithHash: async () => ({ id: 1, email: 'admin@blueeye.local', role: 'admin', password_hash: await hashPassword('pw-correct') }),
  });
  const app = makeApp({ auditEventsRepo, usersRepo });
  const res = await request(app).post('/auth/login').send({ email: 'admin@blueeye.local', password: 'wrong' });
  assert.equal(res.status, 401);
  await settle();
  assert.equal(auditEventsRepo.rows.length, 0);
});
