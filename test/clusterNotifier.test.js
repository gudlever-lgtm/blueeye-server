'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createClusterNotifier } = require('../src/analysis/clusterNotifier');
const { makeIncidentClustersRepo, makeAlertDispatchLogRepo, makeIntegrationsDispatcher } = require('../test-support/fakes');

const now = () => new Date('2026-07-01T12:00:00Z');

function harness(over = {}) {
  const clustersRepo = over.clustersRepo || makeIncidentClustersRepo();
  const alertLog = over.alertLog || makeAlertDispatchLogRepo();
  const integrationTrigger = over.integrationTrigger || makeIntegrationsDispatcher();
  const alertEvents = [];
  const alertDispatcher = { dispatchClusterEvent: async (subject, group, { kind }) => { alertEvents.push({ kind, severity: subject.severity }); return { dispatched: true }; } };
  const audits = [];
  const auditLogger = { record: async (req, e) => { audits.push(e); } };
  const nis2Calls = [];
  const nis2Service = { generateForCluster: async (cluster) => { nis2Calls.push(cluster.clusterId ?? cluster.id); return 55; } };
  const notifier = createClusterNotifier({
    alertDispatcher, integrationTrigger, nis2Service, clustersRepo, alertLog, auditLogger, now, digestMs: 10 * 60 * 1000,
  });
  return { notifier, clustersRepo, alertLog, integrationTrigger, alertEvents, audits, nis2Calls };
}

const member = (id, over = {}) => ({ id, hostId: over.hostId || '1', metric: over.metric || 'probe.loss', severity: over.severity || 'WARN' });

async function seedCluster(clustersRepo, over = {}) {
  const id = await clustersRepo.create({ confidence: 'high', memberFindingIds: over.members || ['a', 'b'], suspectedCommonCause: 'shared uplink', status: 'open', detectedAt: now() });
  return id;
}

// ---- opened: alert + ONE ticket + NIS2 (CRIT) + suppression ---------------

test('opened → cluster-opened alert, ONE ITSM ticket stored, suppression audited', async () => {
  const h = harness();
  const id = await seedCluster(h.clustersRepo);
  await h.notifier.notify({
    event: 'opened',
    cluster: { clusterId: id, id, confidence: 'high', severity: 'CRIT', memberFindingIds: ['a', 'b'], hostIds: ['1', '2'], suspectedCommonCause: 'shared uplink' },
    prev: {},
    members: [member('a', { hostId: '1' }), member('b', { hostId: '2' })],
    newMemberFindings: [member('a', { hostId: '1' }), member('b', { hostId: '2' })],
  });

  assert.deepEqual(h.alertEvents.map((e) => e.kind), ['opened']);
  // ONE ticket created + ref stored on the cluster.
  const ticketCalls = h.integrationTrigger.calls.filter((c) => c.kind === 'cluster');
  assert.equal(ticketCalls.length, 1);
  assert.equal(h.clustersRepo.rows.find((r) => r.id === id).itsm_ticket_ref, `SNOW-${id}`);
  // CRIT → one NIS2 cluster draft.
  assert.deepEqual(h.nis2Calls, [id]);
  // suppression audited for both members (neither had a prior finding alert).
  const supp = h.audits.filter((a) => a.action === 'alert_suppressed');
  assert.equal(supp.length, 2);
});

test('race case: a member already alerted before clustering is noted, not "suppressed"', async () => {
  const h = harness();
  const id = await seedCluster(h.clustersRepo);
  // 'a' already has a finding-level alert.
  await h.alertLog.record({ subjectType: 'finding', subjectId: 'a', sentAt: now() });
  await h.notifier.notify({
    event: 'opened',
    cluster: { clusterId: id, id, confidence: 'high', severity: 'WARN', memberFindingIds: ['a', 'b'], hostIds: ['1', '2'] },
    prev: {},
    members: [member('a'), member('b')],
    newMemberFindings: [member('a'), member('b')],
  });
  assert.equal(h.audits.filter((a) => a.action === 'alert_race').length, 1);       // 'a' raced
  assert.equal(h.audits.filter((a) => a.action === 'alert_suppressed').length, 1);  // 'b' suppressed
});

// ---- update / escalation ---------------------------------------------------

test('escalation bypasses the digest window and appends an ITSM worknote', async () => {
  const h = harness();
  const id = await seedCluster(h.clustersRepo);
  await h.notifier.notify({
    event: 'updated',
    cluster: { clusterId: id, id, confidence: 'high', severity: 'CRIT', memberFindingIds: ['a', 'b', 'c'], hostIds: ['1', '2', '3'], itsmTicketRef: `SNOW-${id}` },
    prev: { alertLastAt: new Date(now().getTime() - 2 * 60 * 1000), alertLastSeverity: 'WARN', alertMemberCount: 2 }, // 2 min ago, was WARN
    members: [member('a'), member('b'), member('c')],
    newMemberFindings: [member('c')],
  });
  assert.deepEqual(h.alertEvents.map((e) => e.kind), ['escalation']);
  // worknote appended to the SAME ticket (no new ticket).
  assert.equal(h.integrationTrigger.calls.filter((c) => c.kind === 'cluster').length, 0);
  assert.equal(h.integrationTrigger.calls.filter((c) => c.kind === 'cluster-note').length, 1);
});

test('an update within the digest window fires no alert but still records suppression', async () => {
  const h = harness();
  const id = await seedCluster(h.clustersRepo);
  await h.notifier.notify({
    event: 'updated',
    cluster: { clusterId: id, id, confidence: 'high', severity: 'WARN', memberFindingIds: ['a', 'b', 'c'], hostIds: ['1', '2'] },
    prev: { alertLastAt: new Date(now().getTime() - 2 * 60 * 1000), alertLastSeverity: 'WARN', alertMemberCount: 2 },
    members: [member('a'), member('b'), member('c')],
    newMemberFindings: [member('c')],
  });
  assert.equal(h.alertEvents.length, 0); // within window
  assert.equal(h.audits.filter((a) => a.action === 'alert_suppressed').length, 1); // 'c' still suppressed
});

// ---- resolved --------------------------------------------------------------

test('resolved → one resolution alert + ITSM worknote', async () => {
  const h = harness();
  const id = await seedCluster(h.clustersRepo);
  await h.notifier.notify({
    event: 'resolved',
    cluster: { clusterId: id, id, confidence: 'high', severity: 'WARN', memberFindingIds: ['a'], itsmTicketRef: `SNOW-${id}`, durationText: '42 min', resolutionNote: 'carrier fixed WAN' },
    members: [],
  });
  assert.deepEqual(h.alertEvents.map((e) => e.kind), ['resolved']);
  assert.equal(h.integrationTrigger.calls.filter((c) => c.kind === 'cluster-note').length, 1);
});

// ---- resilience ------------------------------------------------------------

test('an ITSM connector failure never blocks alerting or throws', async () => {
  const integrationTrigger = makeIntegrationsDispatcher({ emitCluster: async () => { throw new Error('SNOW down'); } });
  const h = harness({ integrationTrigger });
  const id = await seedCluster(h.clustersRepo);
  await h.notifier.notify({
    event: 'opened',
    cluster: { clusterId: id, id, confidence: 'high', severity: 'WARN', memberFindingIds: ['a'], hostIds: ['1'] },
    prev: {}, members: [member('a')], newMemberFindings: [member('a')],
  });
  assert.deepEqual(h.alertEvents.map((e) => e.kind), ['opened']); // alert still fired despite ITSM failure
});
