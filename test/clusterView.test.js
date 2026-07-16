'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { confidenceBreakdown, SINGLE_SIGNAL_BASELINE } = require('../src/analysis/crossAgentCorrelator');
const { classifyRootCauseLayer, buildClusterDetail } = require('../src/analysis/clusterView');

const member = (over = {}) => ({
  id: 'f', hostId: '1', metric: 'cpu', severity: 'WARN', kind: 'ANOMALY',
  observed: 9, baseline: 3, deviation: 4, explanation: 'x', evidence: [{}, {}],
  acked: false, createdAt: new Date('2026-07-01T12:00:00Z'), ...over,
});

// ---- confidenceBreakdown ---------------------------------------------------

test('confidenceBreakdown: high tier scores above the single-signal baseline', () => {
  const members = [member({ hostId: '1', metric: 'probe.loss' }), member({ hostId: '2', metric: 'probe.loss' })];
  const bd = confidenceBreakdown('high', members);
  assert.deepEqual(bd.signals, { time: true, topology: true, type: true });
  assert.equal(bd.baseline, SINGLE_SIGNAL_BASELINE);
  assert.ok(bd.aboveBaseline);
  assert.ok(bd.score > bd.baseline);
  assert.equal(bd.contributing.length, 3);
});

test('confidenceBreakdown: low/time-only tier equals the baseline (not above)', () => {
  // Distinct metrics across the two hosts -> no shared type signal.
  const members = [member({ hostId: '1', metric: 'cpu' }), member({ hostId: '2', metric: 'mem' })];
  const bd = confidenceBreakdown('low', members);
  assert.deepEqual(bd.signals, { time: true, topology: false, type: false });
  assert.equal(bd.score, bd.baseline);
  assert.equal(bd.aboveBaseline, false);
});

test('confidenceBreakdown: medium tier reflects the topology signal', () => {
  const members = [member({ hostId: '1', metric: 'cpu' }), member({ hostId: '2', metric: 'mem' })];
  const bd = confidenceBreakdown('medium', members);
  assert.deepEqual(bd.signals, { time: true, topology: true, type: false });
  assert.ok(bd.aboveBaseline);
});

// ---- classifyRootCauseLayer ------------------------------------------------

test('classifyRootCauseLayer: interface/packet metrics -> network-layer', () => {
  const r = classifyRootCauseLayer(['probe.loss', 'iface.errors']);
  assert.equal(r.layer, 'network-layer');
  assert.match(r.reason, /interface\/packet/);
});

test('classifyRootCauseLayer: TCP/app metrics -> application-layer', () => {
  // Unambiguously app-layer (avoid "latency", which is also a network fragment).
  const r = classifyRootCauseLayer(['tcp.retransmit', 'rtt.app']);
  assert.equal(r.layer, 'application-layer');
});

test('classifyRootCauseLayer: mixed signals -> undetermined', () => {
  const r = classifyRootCauseLayer(['probe.loss', 'tcp.retransmit']);
  assert.equal(r.layer, 'undetermined');
});

test('classifyRootCauseLayer: unmappable metrics -> undetermined', () => {
  const r = classifyRootCauseLayer(['cpu', 'mem']);
  assert.equal(r.layer, 'undetermined');
});

// ---- buildClusterDetail ----------------------------------------------------

test('buildClusterDetail assembles members, affected agents, root cause and evidence summary', () => {
  const cluster = {
    id: 42, status: 'open', confidence: 'high',
    memberFindingIds: ['a', 'b'], suspectedCommonCause: 'shared uplink',
    advisory: null, detectedAt: '2026-07-01T12:03:00Z', createdAt: '2026-07-01T12:00:00Z',
    acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null,
  };
  const members = [
    member({ id: 'a', hostId: '1', metric: 'probe.loss', severity: 'CRIT' }),
    member({ id: 'b', hostId: '2', metric: 'probe.loss', severity: 'WARN' }),
  ];
  const detail = buildClusterDetail(cluster, members);

  assert.equal(detail.id, 42);
  assert.equal(detail.memberCount, 2);
  assert.equal(detail.members.length, 2);
  assert.deepEqual(detail.affectedAgents.sort(), ['1', '2']);
  assert.equal(detail.firstSeen, '2026-07-01T12:00:00Z');
  assert.equal(detail.lastSeen, '2026-07-01T12:03:00Z');
  assert.equal(detail.suspectedRootCause.classification, 'network-layer');
  assert.equal(detail.suspectedRootCause.commonCause, 'shared uplink');
  assert.ok(detail.confidenceBreakdown.aboveBaseline);
  assert.ok(detail.evidenceSummary.text.includes('same finding-type'));
  // members carry their evidence sample counts (evidence never travels without it).
  assert.equal(detail.members[0].evidenceSamples, 2);
});
