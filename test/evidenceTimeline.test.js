'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIncidentTimeline, mapEvidenceSnapshot } = require('../src/timeline/incidentTimeline');
const { createIncidentClusterTimelineService } = require('../src/timeline/incidentTimelineService');
const { makeIncidentClustersRepo, makeFindingStore, makeEvidenceSnapshotsRepo } = require('../test-support/fakes');

test('mapEvidenceSnapshot emits an INFO event for a complete capture, WARN otherwise', () => {
  const [ok] = mapEvidenceSnapshot({ id: 3, target: '5', status: 'complete', items: [{ name: 'agent.state', status: 'ok' }], capturedAt: '2026-07-01T12:05:00Z' });
  assert.equal(ok.source, 'evidence');
  assert.equal(ok.severity, 'INFO');
  assert.equal(ok.ref_id, 3);
  assert.equal(ok.target, '5');
  assert.match(ok.summary, /Evidence snapshot captured on 5/);

  const [offline] = mapEvidenceSnapshot({ id: 4, target: '6', status: 'agent-offline', items: [], capturedAt: '2026-07-01T12:06:00Z' });
  assert.equal(offline.severity, 'WARN');
  assert.match(offline.summary, /offline/);
});

test('the evidence source is merged into the cluster timeline', async () => {
  const clustersRepo = makeIncidentClustersRepo();
  const findingStore = makeFindingStore();
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const member = { id: 'a', hostId: '1', metric: 'probe.loss', severity: 'CRIT', kind: 'THRESHOLD', explanation: 'x', evidence: [{}], createdAt: new Date('2026-07-01T12:00:00Z'), acked: false };
  findingStore.rows.push(member);
  const clusterId = await clustersRepo.create({ confidence: 'high', memberFindingIds: ['a'], status: 'open', detectedAt: new Date('2026-07-01T12:00:00Z') });
  const sid = await evidenceRepo.create({ clusterId, target: '1', commandSetVersion: 'evidence-v1', capturedAt: new Date('2026-07-01T12:05:00Z'), trigger: 'auto' });
  await evidenceRepo.complete(sid, { status: 'complete', items: [{ name: 'agent.state', status: 'ok' }], payloadText: 'x' });

  const svc = createIncidentClusterTimelineService({ clustersRepo, findingStore, evidenceRepo });
  const result = await svc.getTimeline(clusterId, { lookbackMinutes: 30 });
  const evidenceEvents = result.events.filter((e) => e.source === 'evidence');
  assert.equal(evidenceEvents.length, 1);
  assert.equal(evidenceEvents[0].ref_id, sid);
  assert.equal(result.partial, false);
});

test('buildIncidentTimeline places evidence events without a source failure', () => {
  const { events } = buildIncidentTimeline({
    memberFindings: [],
    evidenceSnapshots: [{ id: 1, target: '2', status: 'partial', items: [{ name: 'agent.state', status: 'ok' }, { name: 'arp.table', status: 'timeout' }], capturedAt: '2026-07-01T12:05:00Z' }],
    firstFindingAt: new Date('2026-07-01T12:00:00Z'),
  });
  const ev = events.find((e) => e.source === 'evidence');
  assert.ok(ev);
  assert.equal(ev.severity, 'WARN'); // partial is not complete
  assert.match(ev.summary, /1\/2 read-only items/);
});
