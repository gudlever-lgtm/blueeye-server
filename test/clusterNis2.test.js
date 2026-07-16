'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildClusterNis2Draft, createClusterNis2Service } = require('../src/analysis/clusterNis2');
const { makeNis2IncidentsRepo, makeIncidentClustersRepo, makeAssistant } = require('../test-support/fakes');

const cluster = (over = {}) => ({
  id: 7, clusterId: 7, severity: 'CRIT', confidence: 'high',
  suspectedCommonCause: 'shared uplink at site (host 10.0.0.1)', firstSeen: '2026-07-01T12:00:00Z', ...over,
});
const members = [{ id: 'a', hostId: '1', metric: 'probe.loss' }, { id: 'b', hostId: '2', metric: 'probe.loss' }];

// ---- pure builder: invariants ----------------------------------------------

test('buildClusterNis2Draft: DRAFT invariants + IP masking (template, no AI)', () => {
  const d = buildClusterNis2Draft(cluster(), { members });
  assert.match(d.title, /^\[Cluster draft\]/);      // not AI → [Cluster draft]
  assert.equal(d.notificationRequired, false);       // NEVER auto-submitted
  assert.equal(d.nis2Relevant, false);               // human assesses
  assert.equal(d.status, 'open');
  assert.match(d.rootCause, /human review before submission/);
  assert.doesNotMatch(d.rootCause, /10\.0\.0\.1/);   // IP masked
  assert.match(d.rootCause, /\[host\]/);
  assert.match(d.affectedSystems, /agent 1, agent 2/);
});

test('buildClusterNis2Draft: AI content is clearly marked', () => {
  const d = buildClusterNis2Draft(cluster(), { members, aiText: 'Likely a shared switch fault.' });
  assert.match(d.title, /^\[AI draft\]/);
  assert.match(d.rootCause, /AI-generated content is clearly marked/);
});

// ---- service: one draft, works without Mistral, suppression audited --------

function svc(over = {}) {
  const nis2IncidentsRepo = over.nis2IncidentsRepo || makeNis2IncidentsRepo();
  const clustersRepo = over.clustersRepo || makeIncidentClustersRepo();
  const audits = [];
  const auditLogger = { record: async (req, e) => { audits.push(e); } };
  const service = createClusterNis2Service({ nis2IncidentsRepo, clustersRepo, assistant: over.assistant || null, auditLogger });
  return { service, nis2IncidentsRepo, clustersRepo, audits };
}

test('generateForCluster: ONE draft, fully functional WITHOUT Mistral', async () => {
  const h = svc(); // assistant null → template fallback
  const id = await h.clustersRepo.create({ confidence: 'high', memberFindingIds: ['a', 'b'], status: 'open', detectedAt: new Date() });
  const draftId = await h.service.generateForCluster({ id, clusterId: id, severity: 'CRIT', suspectedCommonCause: 'x' }, { members });
  assert.ok(draftId);
  assert.equal(h.nis2IncidentsRepo.rows.length, 1);
  assert.match(h.nis2IncidentsRepo.rows[0].title, /\[Cluster draft\]/);
  // per-finding drafts suppressed, audited, linked to the cluster draft.
  assert.ok(h.audits.some((a) => a.action === 'nis2_cluster_draft' && a.target === String(id)));
  assert.equal(h.clustersRepo.rows.find((r) => r.id === id).nis2_draft_id, draftId);
});

test('generateForCluster is idempotent — no duplicate draft when one is linked', async () => {
  const h = svc();
  const draftId = await h.service.generateForCluster({ id: 9, clusterId: 9, severity: 'CRIT', nis2DraftId: 123 }, { members });
  assert.equal(draftId, 123);
  assert.equal(h.nis2IncidentsRepo.rows.length, 0); // nothing created
});

test('generateForCluster marks the draft [AI draft] when the assistant is enabled', async () => {
  const assistant = { isEnabled: () => true, suggestClusterCause: async () => ({ answer: 'Shared switch fault at the site.' }) };
  const h = svc({ assistant });
  const id = await h.clustersRepo.create({ confidence: 'high', memberFindingIds: ['a'], status: 'open', detectedAt: new Date() });
  await h.service.generateForCluster({ id, clusterId: id, severity: 'CRIT' }, { members });
  assert.match(h.nis2IncidentsRepo.rows[0].title, /\[AI draft\]/);
});
