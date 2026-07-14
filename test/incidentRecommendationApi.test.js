'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeIncidentCasesRepo, makeFindingStore, makeAgentsRepo,
  makeRemediationPlaybooksRepo, authHeader,
} = require('../test-support/fakes');

// Seeds a target incident (device 9, cpu anomaly) plus resolved/closed history,
// and returns the wired fakes. `playbooks` lets a test pre-seed playbook defs.
async function seed({ withPlaybook = false } = {}) {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const targetId = await incidentCasesRepo.create({
    host_id: '9', title: 'target', status: 'open', severity: 'CRIT', primary_finding_id: 'pf',
    first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z'),
  });
  // A: resolved, same device + same anomaly type (cpu). Resolution time = 1h.
  const aId = await incidentCasesRepo.create({
    host_id: '9', title: 'A', status: 'resolved', severity: 'CRIT', primary_metric: 'cpu',
    first_event_at: new Date('2026-05-05T00:00:00Z'), last_event_at: new Date('2026-05-05T01:00:00Z'),
    resolved_at: new Date('2026-05-05T01:00:00Z'),
  });
  // B: resolved, same device only (mem).
  await incidentCasesRepo.create({
    host_id: '9', title: 'B', status: 'resolved', severity: 'WARN', primary_metric: 'mem',
    first_event_at: new Date('2026-05-04T00:00:00Z'), last_event_at: new Date('2026-05-04T00:00:00Z'),
    resolved_at: new Date('2026-05-04T00:00:00Z'),
  });
  // C: CLOSED (not resolved) — same device + cpu. Must be EXCLUDED from history.
  await incidentCasesRepo.create({
    host_id: '9', title: 'C', status: 'closed', severity: 'WARN', primary_metric: 'cpu',
    first_event_at: new Date('2026-05-03T00:00:00Z'), last_event_at: new Date('2026-05-03T00:00:00Z'),
    resolved_at: new Date('2026-05-03T00:00:00Z'),
  });

  const findingStore = makeFindingStore();
  await findingStore.save({ id: 'pf', hostId: '9', metric: 'cpu', severity: 'CRIT', explanation: 'x', evidence: [{}], createdAt: new Date('2026-06-01T08:00:00Z') });
  const agentsRepo = makeAgentsRepo({ findById: async (aid) => (Number(aid) === 9 ? { id: 9, platform: 'linux' } : null) });

  const remediationPlaybooksRepo = makeRemediationPlaybooksRepo();
  if (withPlaybook) {
    await remediationPlaybooksRepo.create({ name: 'Restart CPU hog', trigger_condition: 'cpu', action_type: 'restart_service', auto_trigger: 0, manual_action_text: 'Restart the offending service.' });
  }
  return { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId, aId };
}

test('GET /recommendation returns the three ordered sections → 200 (viewer)', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId } = await seed();
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/recommendation`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  // Section keys present, in order.
  assert.deepEqual(Object.keys(res.body), ['incidentId', 'matching_playbook', 'historical_matches', 'ai_suggestion']);
  assert.equal(res.body.matching_playbook, null); // no playbook seeded
  assert.ok(Array.isArray(res.body.historical_matches));
  assert.equal(res.body.ai_suggestion, null);
});

test('GET /recommendation history is RESOLVED-only (closed-without-resolution excluded)', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId } = await seed();
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/recommendation`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const titles = res.body.historical_matches.map((h) => h.title);
  assert.ok(titles.includes('A') && titles.includes('B'), 'resolved A + B present');
  assert.ok(!titles.includes('C'), 'closed C excluded');
});

test('GET /recommendation annotates resolution time + timesSeen + playbook used', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId, aId } = await seed();
  // Record that a playbook ran (succeeded) on the resolved incident A.
  const pbId = await remediationPlaybooksRepo.create({ name: 'PB-A', trigger_condition: 'cpu', action_type: 'run_probe' });
  await remediationPlaybooksRepo.recordRun({ incidentCaseId: aId, playbookId: pbId, status: 'succeeded', resultText: 'fixed' });
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/recommendation`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const a = res.body.historical_matches.find((h) => h.title === 'A');
  assert.equal(a.resolutionTimeSeconds, 3600); // 1 hour
  assert.equal(a.timesSeen, 1); // only A is a resolved cpu incident
  assert.equal(a.playbook.name, 'PB-A');
  assert.equal(a.playbook.status, 'succeeded');
});

test('GET /recommendation matching_playbook suggests a matched playbook (manual)', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId } = await seed({ withPlaybook: true });
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/recommendation`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.matching_playbook.name, 'Restart CPU hog');
  assert.equal(res.body.matching_playbook.action_type, 'restart_service');
  assert.equal(res.body.matching_playbook.already_run, false);
  assert.equal(res.body.matching_playbook.auto_trigger, false);
  assert.equal(res.body.matching_playbook.manual_action_text, 'Restart the offending service.');
});

test('GET /recommendation shows the run RESULT when the playbook already ran on this incident', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId } = await seed();
  const pbId = await remediationPlaybooksRepo.create({ name: 'CPU auto', trigger_condition: 'cpu', action_type: 'restart_service', auto_trigger: 1 });
  await remediationPlaybooksRepo.recordRun({ incidentCaseId: targetId, playbookId: pbId, status: 'failed', resultText: 'service would not restart', ranBy: 'op@x' });
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/recommendation`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.matching_playbook.already_run, true);
  assert.equal(res.body.matching_playbook.run.status, 'failed');
  assert.equal(res.body.matching_playbook.run.result_text, 'service would not restart');
  assert.equal(res.body.matching_playbook.run.ran_by, 'op@x');
  // Suggestion fields are NOT present once it has run.
  assert.equal(res.body.matching_playbook.manual_action_text, undefined);
});

test('GET /recommendation?force_ai=true is 403 for a viewer (operator+ only)', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId } = await seed();
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/recommendation?force_ai=true`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('GET /recommendation?force_ai=true is allowed for an operator → 200', async () => {
  const { incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo, targetId } = await seed();
  const app = makeApp({ incidentCasesRepo, findingStore, agentsRepo, remediationPlaybooksRepo });
  const res = await request(app).get(`/api/incidents/${targetId}/recommendation?force_ai=true`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200); // ai_suggestion still null until 1c is wired
});

test('GET /recommendation is 404 for an unknown incident', async () => {
  const res = await request(makeApp()).get('/api/incidents/9999/recommendation').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /recommendation is 400 for a non-numeric id', async () => {
  const res = await request(makeApp()).get('/api/incidents/abc/recommendation').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /recommendation surfaces a repo failure as 500', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ findById: async () => { throw new Error('db down'); } });
  const res = await request(makeApp({ incidentCasesRepo })).get('/api/incidents/1/recommendation').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

test('GET /recommendation requires auth → 401', async () => {
  const res = await request(makeApp()).get('/api/incidents/1/recommendation');
  assert.equal(res.status, 401);
});
