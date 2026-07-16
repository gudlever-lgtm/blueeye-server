'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createVerificationService } = require('../src/remediation/verificationService');
const { makeVerificationRunsRepo, makeFindingStore } = require('../test-support/fakes');
const { buildIncidentTimeline } = require('../src/timeline/incidentTimeline');

const T = new Date('2026-07-01T12:00:00Z').getTime();
const at = (ms) => new Date(T + ms);

// A mutable clock so schedule() and runDue() can happen at different "times".
function harness(over = {}) {
  let clock = T;
  const verificationRunsRepo = over.verificationRunsRepo || makeVerificationRunsRepo();
  const findingStore = over.findingStore || makeFindingStore();
  const audits = [];
  const auditLogger = { record: async (req, e) => { audits.push(e); } };
  const published = [];
  const svc = createVerificationService({
    verificationRunsRepo, findingStore, auditLogger,
    publishCluster: (c) => published.push(c),
    now: () => new Date(clock),
  });
  return { svc, verificationRunsRepo, findingStore, audits, published, setClock: (ms) => { clock = ms; } };
}

test('schedule creates a pending run with due_at = executed_at + settle', async () => {
  const h = harness();
  const run = await h.svc.schedule({ clusterId: 7, affectedTargets: ['1'], findingTypes: ['cpu'], settleSeconds: 300 });
  assert.equal(run.status, 'pending');
  assert.equal(new Date(run.dueAt).getTime() - new Date(run.executedAt).getTime(), 300 * 1000);
});

test('settle time is respected: a run whose window has not elapsed is NOT processed', async () => {
  const h = harness();
  await h.svc.schedule({ clusterId: 7, affectedTargets: ['1'], findingTypes: ['cpu'], settleSeconds: 300 });
  h.setClock(T + 299 * 1000); // 1s before due
  const summary = await h.svc.runDue();
  assert.equal(summary.checked, 0);
  assert.equal(h.verificationRunsRepo.rows[0].status, 'pending');
});

test('cleared symptoms → passed; audit + suggestResolve published; NEVER auto-resolves', async () => {
  const h = harness();
  // A stale finding BEFORE execution only — nothing fresh after the fix.
  h.findingStore.rows.push({ id: 'old', hostId: '1', metric: 'cpu', severity: 'CRIT', acked: false, createdAt: at(-60 * 1000) });
  await h.svc.schedule({ clusterId: 7, affectedTargets: ['1'], findingTypes: ['cpu'], settleSeconds: 300 });
  h.setClock(T + 301 * 1000);
  const summary = await h.svc.runDue();
  assert.equal(summary.passed, 1);
  assert.equal(h.verificationRunsRepo.rows[0].status, 'passed');
  // audited as passed
  assert.ok(h.audits.some((a) => a.action === 'verification_passed' && a.target === '7'));
  // suggests resolution but does NOT resolve (no 'resolved' status ever published)
  const v = h.published.find((p) => p.verification);
  assert.equal(v.verification.status, 'passed');
  assert.equal(v.verification.suggestResolve, true);
  assert.ok(!h.published.some((p) => p.status === 'resolved'));
});

test('persisting symptoms → failed with readings; audited failed', async () => {
  const h = harness();
  await h.svc.schedule({ clusterId: 7, affectedTargets: ['1', '2'], findingTypes: ['cpu'], settleSeconds: 300 });
  // A FRESH, unacked cpu finding after execution on target 2 → symptom persists.
  h.findingStore.rows.push({ id: 'fresh', hostId: '2', metric: 'cpu', severity: 'CRIT', observed: 99, deviation: 6, acked: false, createdAt: at(60 * 1000) });
  h.setClock(T + 301 * 1000);
  const summary = await h.svc.runDue();
  assert.equal(summary.failed, 1);
  const row = h.verificationRunsRepo.rows[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.readings.length, 1);
  assert.equal(row.readings[0].metric, 'cpu');
  assert.ok(h.audits.some((a) => a.action === 'verification_failed'));
});

test('an acknowledged fresh finding does NOT count as a persisting symptom', async () => {
  const h = harness();
  await h.svc.schedule({ clusterId: 7, affectedTargets: ['1'], findingTypes: ['cpu'], settleSeconds: 300 });
  h.findingStore.rows.push({ id: 'ackd', hostId: '1', metric: 'cpu', severity: 'CRIT', acked: true, createdAt: at(60 * 1000) });
  h.setClock(T + 301 * 1000);
  const summary = await h.svc.runDue();
  assert.equal(summary.passed, 1); // acked finding ignored → cleared
});

test('a finding-store failure yields status error (surfaced, not silent)', async () => {
  const findingStore = makeFindingStore({ list: async () => { throw new Error('db down'); } });
  const h = harness({ findingStore });
  await h.svc.schedule({ clusterId: 7, affectedTargets: ['1'], findingTypes: ['cpu'], settleSeconds: 300 });
  h.setClock(T + 301 * 1000);
  const summary = await h.svc.runDue();
  assert.equal(summary.error, 1);
  assert.equal(h.verificationRunsRepo.rows[0].status, 'error');
  assert.ok(h.audits.some((a) => a.action === 'verification_error'));
});

test('a completed run is NOT reprocessed on the next sweep', async () => {
  const h = harness();
  await h.svc.schedule({ clusterId: 7, affectedTargets: ['1'], findingTypes: ['cpu'], settleSeconds: 60 });
  h.setClock(T + 61 * 1000);
  await h.svc.runDue();
  const second = await h.svc.runDue();
  assert.equal(second.checked, 0);
});

// ---- timeline emission ------------------------------------------------------

test('verification runs surface as a "verification" timeline source', async () => {
  const passed = { id: 1, clusterId: 7, status: 'passed', executedAt: at(0), completedAt: at(301000), readings: null };
  const failed = { id: 2, clusterId: 7, status: 'failed', executedAt: at(0), completedAt: at(301000), readings: [{ metric: 'cpu' }] };
  const { events } = buildIncidentTimeline({ memberFindings: [], agentSources: [], verifications: [passed, failed], firstFindingAt: at(0) });
  const vEvents = events.filter((e) => e.source === 'verification');
  assert.equal(vEvents.length, 2);
  assert.ok(vEvents.some((e) => e.type === 'verification.passed' && e.severity === 'INFO' && e.suggestResolve === true));
  assert.ok(vEvents.some((e) => e.type === 'verification.failed' && e.severity === 'WARN'));
});
