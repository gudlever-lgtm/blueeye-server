'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeIncidentClustersRepo, makeFindingStore, makeRunbooksRepo,
  makeRemediationPlaybooksRepo, makeVerificationService, makeAssistant, authHeader,
} = require('../test-support/fakes');

// Cluster of 3 members: two 'cpu' (dominant) + one 'mem', on agents 1 & 2.
async function setup(over = {}) {
  const incidentClustersRepo = makeIncidentClustersRepo();
  const findingStore = makeFindingStore();
  const runbooksRepo = over.runbooksRepo || makeRunbooksRepo();
  const remediationPlaybooksRepo = over.remediationPlaybooksRepo || makeRemediationPlaybooksRepo();
  const verificationService = over.verificationService || makeVerificationService();

  findingStore.rows.push({ id: 'a', hostId: '1', metric: 'cpu', severity: 'CRIT', explanation: 'x', evidence: [{}], createdAt: new Date('2026-07-01T12:00:00Z'), acked: false });
  findingStore.rows.push({ id: 'b', hostId: '2', metric: 'cpu', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: new Date('2026-07-01T12:01:00Z'), acked: false });
  findingStore.rows.push({ id: 'c', hostId: '1', metric: 'mem', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: new Date('2026-07-01T12:02:00Z'), acked: false });

  const id = await incidentClustersRepo.create({
    confidence: 'high', memberFindingIds: ['a', 'b', 'c'], suspectedCommonCause: 'shared uplink',
    advisory: over.advisory ?? null, status: over.status || 'open', detectedAt: new Date('2026-07-01T12:02:00Z'),
  });
  const app = makeApp({ incidentClustersRepo, findingStore, runbooksRepo, remediationPlaybooksRepo, verificationService, ...(over.assistant ? { assistant: over.assistant } : {}) });
  return { app, id, incidentClustersRepo, findingStore, runbooksRepo, remediationPlaybooksRepo, verificationService };
}

// ---- GET recommended-actions ----------------------------------------------

test('GET recommended-actions returns runbooks matching dominant finding types (viewer+)', async () => {
  const runbooksRepo = makeRunbooksRepo();
  await runbooksRepo.create({ findingType: 'cpu', title: 'Tame CPU', bodyMarkdown: '# do' });
  const { app, id } = await setup({ runbooksRepo });
  const res = await request(app).get(`/api/incident-clusters/${id}/recommended-actions`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.findingTypes, ['cpu', 'mem']); // cpu dominates (2 members) → first
  assert.equal(res.body.hasRunbooks, true);
  assert.equal(res.body.runbooks[0].findingType, 'cpu');
});

test('GET recommended-actions: no matching runbook → empty (hasRunbooks false)', async () => {
  const { app, id } = await setup(); // no runbooks seeded
  const res = await request(app).get(`/api/incident-clusters/${id}/recommended-actions`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.hasRunbooks, false);
  assert.deepEqual(res.body.runbooks, []);
});

test('GET recommended-actions: advisory only surfaced when Mistral enabled', async () => {
  const withAi = await setup({ advisory: 'Check the shared uplink.', assistant: makeAssistant({ isEnabled: () => true }) });
  let res = await request(withAi.app).get(`/api/incident-clusters/${withAi.id}/recommended-actions`).set('Authorization', authHeader('viewer'));
  assert.equal(res.body.advisory, 'Check the shared uplink.');
  assert.equal(res.body.advisoryEnabled, true);

  const noAi = await setup({ advisory: 'Check the shared uplink.', assistant: makeAssistant({ isEnabled: () => false }) });
  res = await request(noAi.app).get(`/api/incident-clusters/${noAi.id}/recommended-actions`).set('Authorization', authHeader('viewer'));
  assert.equal(res.body.advisory, null); // disabled → not surfaced
  assert.equal(res.body.advisoryEnabled, false);
});

test('GET recommended-actions is 404 for an unknown cluster', async () => {
  const { app } = await setup();
  const res = await request(app).get('/api/incident-clusters/99999/recommended-actions').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ---- POST run-playbook -----------------------------------------------------

async function withLinkedRunbook(over = {}) {
  const remediationPlaybooksRepo = makeRemediationPlaybooksRepo();
  const pbId = await remediationPlaybooksRepo.create({ name: 'Restart svc', trigger_condition: 'cpu', action_type: 'restart_service' });
  const runbooksRepo = makeRunbooksRepo();
  const rbId = await runbooksRepo.create({ findingType: 'cpu', title: 'Tame CPU', bodyMarkdown: '# do', linkedPlaybookId: pbId });
  const ctx = await setup({ runbooksRepo, remediationPlaybooksRepo, ...over });
  return { ...ctx, pbId, rbId };
}

test('POST run-playbook (operator+) schedules verification → 202', async () => {
  const { app, id, rbId, verificationService } = await withLinkedRunbook();
  const res = await request(app).post(`/api/incident-clusters/${id}/run-playbook`).set('Authorization', authHeader('operator')).send({ runbookId: rbId });
  assert.equal(res.status, 202);
  assert.equal(res.body.run.playbookName, 'Restart svc');
  assert.deepEqual(res.body.run.affectedTargets.sort(), ['1', '2']);
  assert.ok(res.body.verification, 'a verification was scheduled');
  assert.equal(verificationService.scheduled.length, 1);
  assert.deepEqual(verificationService.scheduled[0].findingTypes, ['cpu', 'mem']);
});

test('POST run-playbook is 403 for a viewer', async () => {
  const { app, id, rbId } = await withLinkedRunbook();
  const res = await request(app).post(`/api/incident-clusters/${id}/run-playbook`).set('Authorization', authHeader('viewer')).send({ runbookId: rbId });
  assert.equal(res.status, 403);
});

test('POST run-playbook 400 when neither runbookId nor playbookId given', async () => {
  const { app, id } = await withLinkedRunbook();
  const res = await request(app).post(`/api/incident-clusters/${id}/run-playbook`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 400);
});

test('POST run-playbook 400 when the runbook has no linked playbook', async () => {
  const runbooksRepo = makeRunbooksRepo();
  const rbId = await runbooksRepo.create({ findingType: 'cpu', title: 'Manual only', bodyMarkdown: '# do' }); // no link
  const { app, id } = await setup({ runbooksRepo });
  const res = await request(app).post(`/api/incident-clusters/${id}/run-playbook`).set('Authorization', authHeader('operator')).send({ runbookId: rbId });
  assert.equal(res.status, 400);
  assert.match(res.body.details.runbookId, /no linked playbook/);
});

test('POST run-playbook 409 against a resolved cluster', async () => {
  const { app, id, rbId } = await withLinkedRunbook({ status: 'resolved' });
  const res = await request(app).post(`/api/incident-clusters/${id}/run-playbook`).set('Authorization', authHeader('operator')).send({ runbookId: rbId });
  assert.equal(res.status, 409);
});

test('POST run-playbook 404 for an unknown cluster', async () => {
  const { app, rbId } = await withLinkedRunbook();
  const res = await request(app).post('/api/incident-clusters/99999/run-playbook').set('Authorization', authHeader('operator')).send({ runbookId: rbId });
  assert.equal(res.status, 404);
});
