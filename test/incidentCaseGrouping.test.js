'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIncidentCaseService } = require('../src/incidentCases/incidentCaseService');
const { makeIncidentCasesRepo, makeFindingStore } = require('../test-support/fakes');

// Exercises the auto-create/grouping policy against the in-memory fakes (same
// surface as the real repo + finding store). The default window is the
// correlator's (60s).
const T0 = new Date('2026-06-01T08:00:00Z');
const at = (secs) => new Date(T0.getTime() + secs * 1000);

function finding(over = {}) {
  return { id: 'f1', hostId: 'core-sw', metric: 'cpu', severity: 'WARN', createdAt: T0, ...over };
}

function svcWith() {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const findingStore = makeFindingStore();
  const svc = createIncidentCaseService({ incidentCasesRepo, findingStore });
  return { svc, incidentCasesRepo, findingStore };
}

test('two anomalies on the same device WITHIN the window group into ONE incident', async () => {
  const { svc, incidentCasesRepo } = svcWith();
  const r1 = await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  const r2 = await svc.assignFinding(finding({ id: 'b', createdAt: at(30) })); // +30s < 60s

  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.incidentCaseId, r2.incidentCaseId);
  assert.equal(incidentCasesRepo.rows.length, 1);
});

test('two anomalies on the same device OUTSIDE the window make TWO incidents', async () => {
  const { svc, incidentCasesRepo } = svcWith();
  const r1 = await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  const r2 = await svc.assignFinding(finding({ id: 'b', createdAt: at(120) })); // +120s > 60s

  assert.equal(r1.created, true);
  assert.equal(r2.created, true);
  assert.notEqual(r1.incidentCaseId, r2.incidentCaseId);
  assert.equal(incidentCasesRepo.rows.length, 2);
});

test('a finding exactly at the window boundary still groups (<=)', async () => {
  const { svc, incidentCasesRepo } = svcWith();
  await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  const r2 = await svc.assignFinding(finding({ id: 'b', createdAt: at(60) })); // exactly 60s
  assert.equal(r2.created, false);
  assert.equal(incidentCasesRepo.rows.length, 1);
});

test('anomalies on DIFFERENT devices never group together', async () => {
  const { svc, incidentCasesRepo } = svcWith();
  await svc.assignFinding(finding({ id: 'a', hostId: 'sw-1', createdAt: at(0) }));
  await svc.assignFinding(finding({ id: 'b', hostId: 'sw-2', createdAt: at(10) }));
  assert.equal(incidentCasesRepo.rows.length, 2);
});

test('the sliding window extends as new anomalies keep arriving', async () => {
  const { svc, incidentCasesRepo } = svcWith();
  // Each finding is within 60s of the PREVIOUS one, so the incident keeps growing
  // even though the last is 135s after the first.
  await svc.assignFinding(finding({ id: 'a', createdAt: at(0) }));
  await svc.assignFinding(finding({ id: 'b', createdAt: at(45) }));
  await svc.assignFinding(finding({ id: 'c', createdAt: at(90) }));
  const r = await svc.assignFinding(finding({ id: 'd', createdAt: at(135) }));
  assert.equal(r.created, false);
  assert.equal(incidentCasesRepo.rows.length, 1);
  assert.equal(new Date(incidentCasesRepo.rows[0].last_event_at).getTime(), at(135).getTime());
});

test('grouping escalates severity (WARN -> CRIT) but never downgrades', async () => {
  const { svc, incidentCasesRepo } = svcWith();
  await svc.assignFinding(finding({ id: 'a', severity: 'WARN', createdAt: at(0) }));
  await svc.assignFinding(finding({ id: 'b', severity: 'CRIT', createdAt: at(20) }));
  assert.equal(incidentCasesRepo.rows[0].severity, 'CRIT');
  await svc.assignFinding(finding({ id: 'c', severity: 'INFO', createdAt: at(40) }));
  assert.equal(incidentCasesRepo.rows[0].severity, 'CRIT'); // not downgraded
});

test('a new incident is opened as system/open with the finding as primary + a title, and the finding is linked', async () => {
  const { svc, incidentCasesRepo, findingStore } = svcWith();
  const f = finding({ id: 'a', metric: 'interface_errors', severity: 'CRIT', createdAt: at(0) });
  await findingStore.save(f); // so the link is observable on the store
  const r = await svc.assignFinding(f);

  const row = incidentCasesRepo.rows[0];
  assert.equal(row.status, 'open');
  assert.equal(row.created_by, 'system');
  assert.equal(row.primary_finding_id, 'a');
  assert.equal(row.severity, 'CRIT');
  assert.match(row.title, /interface_errors/);
  assert.match(row.title, /core-sw/);
  assert.equal(new Date(row.first_event_at).getTime(), at(0).getTime());
  assert.equal(findingStore.rows.find((x) => x.id === 'a').incidentCaseId, r.incidentCaseId);
});

test('assignFinding is a no-op (returns null) for a finding with no id or no host', async () => {
  const { svc, incidentCasesRepo } = svcWith();
  assert.equal(await svc.assignFinding({ hostId: 'x', createdAt: at(0) }), null);
  assert.equal(await svc.assignFinding({ id: 'x', createdAt: at(0) }), null);
  assert.equal(incidentCasesRepo.rows.length, 0);
});

test('a repository failure is swallowed (never breaks ingestion)', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ findOpenByHost: async () => { throw new Error('db down'); } });
  const findingStore = makeFindingStore();
  const svc = createIncidentCaseService({ incidentCasesRepo, findingStore });
  assert.equal(await svc.assignFinding(finding({ id: 'a' })), null);
});
