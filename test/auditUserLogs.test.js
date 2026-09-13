'use strict';

// HTTP tests for the User Logs endpoints (GET /api/audit/users and its CSV
// export) — RBAC, the licence split, filters, and every failure code the routes
// can produce (400 / 401 / 403 / 404 / 500).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAuditEventsRepo, makeAuditLogRepo, makeUsersRepo, authHeader } = require('../test-support/fakes');

const admin = () => authHeader('admin');
const operator = () => authHeader('operator');
const viewer = () => authHeader('viewer');

const usersRepo = () => makeUsersRepo({
  findAll: async () => [
    { id: 7, email: 'lars@example.dk', name: 'Lars Hansen', role: 'admin' },
    { id: 8, email: 'mette@example.dk', name: 'Mette Sørensen', role: 'operator' },
  ],
});

async function seeded() {
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', actorId: 7, actorLabel: 'lars@example.dk', actorRole: 'admin', action: 'user.update', method: 'PUT', path: '/users/9', status: 200, ip: '10.0.0.5' });
  await auditEventsRepo.record({ actorType: 'user', actorId: 8, actorLabel: 'mette@example.dk', actorRole: 'operator', action: 'agent.delete', method: 'DELETE', path: '/agents/3', status: 200, ip: '10.0.0.6' });
  await auditEventsRepo.record({ actorType: 'agent', actorId: 3, actorLabel: 'srv-01', action: 'agent.report' });
  return auditEventsRepo;
}

// ---- RBAC ------------------------------------------------------------------

test('GET /api/audit/users requires authentication (401)', async () => {
  const res = await request(makeApp()).get('/api/audit/users');
  assert.equal(res.status, 401);
});

test('GET /api/audit/users is admin-only (403 for viewer and operator)', async () => {
  for (const who of [viewer, operator]) {
    const res = await request(makeApp()).get('/api/audit/users').set('Authorization', who());
    assert.equal(res.status, 403);
  }
});

test('GET /api/audit/users/export.csv is admin-only', async () => {
  const res = await request(makeApp()).get('/api/audit/users/export.csv').set('Authorization', operator());
  assert.equal(res.status, 403);
  const anon = await request(makeApp()).get('/api/audit/users/export.csv');
  assert.equal(anon.status, 401);
});

// ---- the read model over HTTP ---------------------------------------------

test('GET /api/audit/users returns user actions only, with id, name, email, time and action', async () => {
  const app = makeApp({ auditEventsRepo: await seeded(), usersRepo: usersRepo() });
  const res = await request(app).get('/api/audit/users').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 2, 'the agent-caused row is not user activity');
  const row = res.body.entries.find((e) => e.userId === 7);
  assert.equal(row.name, 'Lars Hansen');
  assert.equal(row.email, 'lars@example.dk');
  assert.equal(row.actionLabel, 'Updated user');
  assert.ok(row.ts);
  assert.equal(res.body.summary.users, 2);
});

test('a delete and a denied action come back flagged with a reason', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', actorId: 8, actorLabel: 'mette@example.dk', action: 'agent.delete', status: 200 });
  await auditEventsRepo.record({ actorType: 'user', actorId: 8, actorLabel: 'mette@example.dk', action: 'settings.update', status: 403 });
  const app = makeApp({ auditEventsRepo, usersRepo: usersRepo() });
  const res = await request(app).get('/api/audit/users').set('Authorization', admin());
  assert.equal(res.status, 200);
  const denied = res.body.entries.find((e) => e.action === 'settings.update');
  assert.equal(denied.flagLevel, 'critical');
  assert.ok(denied.flags[0].message);
  const del = res.body.entries.find((e) => e.action === 'agent.delete');
  assert.equal(del.flagLevel, 'notice');
  assert.equal(res.body.summary.flagged, 2);
});

test('?flagged=1 narrows to the rows worth a second look', async () => {
  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', actorId: 7, actorLabel: 'lars@example.dk', action: 'location.update', status: 200 });
  await auditEventsRepo.record({ actorType: 'user', actorId: 7, actorLabel: 'lars@example.dk', action: 'location.delete', status: 200 });
  const app = makeApp({ auditEventsRepo, usersRepo: usersRepo() });
  const res = await request(app).get('/api/audit/users?flagged=1').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].action, 'location.delete');
});

test('?user= filters to one account, and a bad id is a 400', async () => {
  const app = makeApp({ auditEventsRepo: await seeded(), usersRepo: usersRepo() });
  const ok = await request(app).get('/api/audit/users?user=8').set('Authorization', admin());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.entries.length, 1);
  assert.equal(ok.body.entries[0].userId, 8);

  const bad = await request(app).get('/api/audit/users?user=not-a-number').set('Authorization', admin());
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /user id/i);
});

test('?q= searches the name, email and action', async () => {
  const app = makeApp({ auditEventsRepo: await seeded(), usersRepo: usersRepo() });
  const res = await request(app).get('/api/audit/users?q=mette').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].email, 'mette@example.dk');
});

test('rows survive a users table that cannot be read — names just go missing', async () => {
  const app = makeApp({
    auditEventsRepo: await seeded(),
    usersRepo: makeUsersRepo({ findAll: async () => { throw new Error('db down'); } }),
  });
  const res = await request(app).get('/api/audit/users').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 2);
  assert.equal(res.body.entries[0].name, null);
  assert.equal(res.body.entries[0].deletedUser, false, 'an unreadable directory is not proof the user is gone');
});

test('the hash-chained audit_log is merged in', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record({ category: 'auth', action: 'auth_login', outcome: 'failure', actorUserId: 7, actorEmail: 'lars@example.dk', ip: '203.0.113.4' });
  const app = makeApp({ auditEventsRepo: await seeded(), auditLogRepo, usersRepo: usersRepo() });
  const res = await request(app).get('/api/audit/users').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sources, { events: true, log: true });
  assert.ok(res.body.entries.some((e) => e.action === 'auth_login' && e.flagLevel === 'warn'));
});

// The point of the whole view: User Logs IS the audit record, so it is NOT
// licence-gated. An admin on any plan sees every action, failed sign-ins
// included — an audit list that silently drops rows by plan is worse than none.
test('the audit_log rows are shown even when the plan does not include audit_log', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record({ category: 'auth', action: 'auth_login', outcome: 'failure', actorUserId: 7, actorEmail: 'lars@example.dk', ip: '203.0.113.4' });
  const app = makeApp({
    auditEventsRepo: await seeded(),
    auditLogRepo,
    usersRepo: usersRepo(),
    featureGate: { isFeatureEnabled: (key) => key !== 'audit_log', requireFeature: () => (req, res, next) => next() },
  });
  const res = await request(app).get('/api/audit/users').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.ok(res.body.entries.some((e) => e.action === 'auth_login'), 'a failed sign-in was withheld by licence');
  assert.equal(res.body.entries.length, 3);
});

test('the licensed compliance read (/api/audit/all) stays gated', async () => {
  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record({ category: 'auth', action: 'auth_login', outcome: 'failure', actorUserId: 7, actorEmail: 'lars@example.dk' });
  const app = makeApp({
    auditEventsRepo: await seeded(),
    auditLogRepo,
    usersRepo: usersRepo(),
    featureGate: { isFeatureEnabled: (key) => key !== 'audit_log', requireFeature: () => (req, res, next) => next() },
  });
  const res = await request(app).get('/api/audit/all').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.sources.log, 0, 'the unified compliance read must still respect the licence');
});

// ---- CSV -------------------------------------------------------------------

test('GET /api/audit/users/export.csv returns a CSV with the id, name and flag columns', async () => {
  const app = makeApp({ auditEventsRepo: await seeded(), usersRepo: usersRepo() });
  const res = await request(app).get('/api/audit/users/export.csv').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /user-logs\.csv/);
  assert.match(res.text.split('\n')[0], /userId.*name.*email.*action.*flagLevel/);
  assert.match(res.text, /Lars Hansen/);
});

test('the CSV export rejects a bad user id with 400 too', async () => {
  const app = makeApp({ auditEventsRepo: await seeded(), usersRepo: usersRepo() });
  const res = await request(app).get('/api/audit/users/export.csv?user=abc').set('Authorization', admin());
  assert.equal(res.status, 400);
});

// ---- failure codes ---------------------------------------------------------

test('an unknown path under /api/audit is a 404', async () => {
  const res = await request(makeApp()).get('/api/audit/users/nope').set('Authorization', admin());
  assert.equal(res.status, 404);
});

test('a repository failure surfaces as a 500, not a broken page', async () => {
  const app = makeApp({
    auditEventsRepo: makeAuditEventsRepo({ findAll: async () => { throw new Error('audit store unreachable'); } }),
    usersRepo: usersRepo(),
  });
  const res = await request(app).get('/api/audit/users').set('Authorization', admin());
  assert.equal(res.status, 500);
});
