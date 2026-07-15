'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeFindingStore, makeIncidentsRepo, makeAuditEventsRepo,
  makeRemediationPlaybooksRepo, authHeader,
} = require('../test-support/fakes');

const HOST = '9';
const TRIGGER = '2026-06-01T08:00:00Z'; // finding.created_at

// Seeds a finding at TRIGGER on host 9 plus a mix of change + symptom events in
// and out of the default 30-min window before it.
function seededApp(over = {}) {
  const findingStore = over.findingStore || makeFindingStore();
  if (!over.findingStore) {
    findingStore.rows.push(
      { id: 'trigger', hostId: HOST, metric: 'cpu', severity: 'CRIT', explanation: 'CPU spike', createdAt: TRIGGER },
      // a SYMPTOM (another finding) inside the window — must be excluded
      { id: 'sym', hostId: HOST, metric: 'mem', severity: 'WARN', explanation: 'mem', createdAt: '2026-06-01T07:55:00Z' },
    );
  }

  const auditEventsRepo = over.auditEventsRepo || makeAuditEventsRepo();
  if (!over.auditEventsRepo) {
    auditEventsRepo.rows.push(
      { id: 1, ts: '2026-06-01T07:50:00Z', actorType: 'agent', actorId: 9, action: 'agent.online', ip: '10.0.0.5' }, // change
      { id: 2, ts: '2026-06-01T07:40:00Z', actorType: 'agent', actorId: 9, action: 'agent.enrolled', ip: null }, // change
      { id: 3, ts: '2026-06-01T07:42:00Z', actorType: 'agent', actorId: 9, action: 'agent.offline', ip: null }, // symptom
      { id: 4, ts: '2026-06-01T08:30:00Z', actorType: 'agent', actorId: 9, action: 'agent.online', ip: null }, // AFTER trigger — excluded
    );
  }

  const incidentsRepo = over.incidentsRepo || makeIncidentsRepo();
  if (!over.incidentsRepo) {
    incidentsRepo.rows.push({ id: 1, agent_id: 9, metric: 'reachability', severity: 'critical', started_at: new Date('2026-06-01T07:35:00Z'), resolved_at: null, affected_target: '8.8.8.8' }); // symptom
  }

  const remediationPlaybooksRepo = over.remediationPlaybooksRepo || makeRemediationPlaybooksRepo();

  const app = makeApp({ findingStore, auditEventsRepo, incidentsRepo, remediationPlaybooksRepo });
  return { app, findingStore, auditEventsRepo, incidentsRepo, remediationPlaybooksRepo };
}

async function seedPlaybook(repo, ranAt) {
  const pbId = await repo.create({ name: 'Restart iface', trigger_condition: 'cpu', action_type: 'manual' });
  await repo.recordRun({ incidentCaseId: 1, playbookId: pbId, hostId: HOST, status: 'success', ranAt: new Date(ranAt) });
}

// ---- 200 with change events (symptoms + out-of-window excluded) ------------

test('GET /api/findings/:id/context returns only change events before the trigger → 200', async () => {
  const ctx = seededApp();
  await seedPlaybook(ctx.remediationPlaybooksRepo, '2026-06-01T07:45:00Z'); // change, in window
  await seedPlaybook(ctx.remediationPlaybooksRepo, '2026-06-01T07:00:00Z'); // change, BEFORE window — excluded

  const res = await request(ctx.app)
    .get('/api/findings/trigger/context')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.trigger.at, '2026-06-01T08:00:00.000Z');
  assert.equal(res.body.window.minutes, 30);

  const types = res.body.changes.map((c) => c.type);
  // change events in [07:30, 08:00], closest-to-trigger first:
  //   07:50 agent.online, 07:45 playbook.success, 07:40 agent.enrolled
  assert.deepEqual(types, ['agent.online', 'playbook.success', 'agent.enrolled']);

  // No symptoms leaked (findings, incidents, offline) and nothing after trigger.
  assert.ok(!res.body.changes.some((c) => c.source === 'finding'));
  assert.ok(!res.body.changes.some((c) => c.source === 'incident'));
  assert.ok(!res.body.changes.some((c) => c.type === 'agent.offline'));
  // Descending (closest-to-trigger first).
  const ts = res.body.changes.map((c) => c.timestamp);
  assert.deepEqual(ts, [...ts].sort((a, b) => new Date(b) - new Date(a)));
});

test('GET /api/findings/:id/context honours a custom window', async () => {
  const ctx = seededApp();
  await seedPlaybook(ctx.remediationPlaybooksRepo, '2026-06-01T07:45:00Z'); // 15 min before trigger
  // window=10 → [07:50, 08:00]: the 07:45 playbook falls outside, only 07:50 online remains.
  const res = await request(ctx.app)
    .get('/api/findings/trigger/context?window=10')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.changes.map((c) => c.type), ['agent.online']);
});

// ---- 200 empty (not 404) --------------------------------------------------

test('GET /api/findings/:id/context returns [] (not 404) when no changes → 200', async () => {
  // A finding with no surrounding change events.
  const findingStore = makeFindingStore();
  findingStore.rows.push({ id: 'lonely', hostId: HOST, metric: 'cpu', severity: 'WARN', explanation: 'x', createdAt: TRIGGER });
  const app = makeApp({ findingStore });
  const res = await request(app)
    .get('/api/findings/lonely/context')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.changes, []);
  assert.equal(res.body.partial, false);
});

// ---- 404 unknown finding --------------------------------------------------

test('GET /api/findings/:id/context → 404 when the finding does not exist', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get('/api/findings/nope/context')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ---- 400 invalid window ---------------------------------------------------

test('GET /api/findings/:id/context → 400 on invalid window', async () => {
  const { app } = seededApp();
  for (const w of ['0', 'abc', '99999', '-5']) {
    const res = await request(app)
      .get(`/api/findings/trigger/context?window=${w}`)
      .set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 400, `window=${w} should be 400`);
  }
});

// ---- RBAC -----------------------------------------------------------------

test('GET /api/findings/:id/context requires auth → 401', async () => {
  const { app } = seededApp();
  assert.equal((await request(app).get('/api/findings/trigger/context')).status, 401);
});

// ---- partial-failure consistency with Phase 1 -----------------------------

test('GET /api/findings/:id/context flags partial when a source fails, keeps the rest', async () => {
  const remediationPlaybooksRepo = makeRemediationPlaybooksRepo({
    listRunsForHost: async () => { throw new Error('playbook backend down'); },
  });
  const ctx = seededApp({ remediationPlaybooksRepo });

  const res = await request(ctx.app)
    .get('/api/findings/trigger/context')
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200); // not a 500
  assert.equal(res.body.partial, true);
  assert.ok(res.body.failedSources.includes('playbookRuns'));
  // agent.online (a change) still survives.
  assert.ok(res.body.changes.some((c) => c.type === 'agent.online'));
});
