'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAnomalies,
  buildSummary,
  percentVsBaseline,
  NODE_STATE,
} = require('../src/troubleshooting/overview');

// A flow.volume finding exactly as flowPairBaselineJob writes it.
function flowFinding(over = {}) {
  const { src = '4', dst = '7', dstPort = 443, ...rest } = over;
  return {
    id: 'f1',
    hostId: String(src),
    metric: 'flow.volume',
    severity: 'WARN',
    observed: 2500,
    baseline: 1000,
    deviation: 6.2,
    window: ['2026-07-27T09:00:00.000Z', '2026-07-27T10:00:00.000Z'],
    createdAt: '2026-07-27T10:01:00.000Z',
    explanation: 'Flow 4->7:443 volume deviated',
    evidence: [{ hostId: String(src), metric: 'flow.volume', labels: { src: String(src), dst: String(dst), dstPort } }],
    ...rest,
  };
}

test('percentVsBaseline is a signed percentage against the baseline', () => {
  assert.equal(percentVsBaseline(2500, 1000), 150); // 2.5x the usual
  assert.equal(percentVsBaseline(200, 1000), -80); // nearly silent
  assert.equal(percentVsBaseline(1000, 1000), 0);
  // No meaningful ratio exists against a zero/absent baseline.
  assert.equal(percentVsBaseline(500, 0), null);
  assert.equal(percentVsBaseline(500, null), null);
  assert.equal(percentVsBaseline(null, 100), null);
});

test('an anomaly carries the mandated fields', () => {
  const [a] = buildAnomalies([flowFinding()]);
  assert.equal(a.linkId, '4->7:443');
  assert.equal(a.currentVsBaselinePct, 150);
  assert.equal(a.since, '2026-07-27T09:00:00.000Z'); // window start, not createdAt
});

test('since falls back to createdAt when the window is absent', () => {
  const [a] = buildAnomalies([flowFinding({ window: null })]);
  assert.equal(a.since, '2026-07-27T10:01:00.000Z');
});

test('the pair is resolved from evidence labels, port optional', () => {
  const [a] = buildAnomalies([flowFinding({ dstPort: null })]);
  assert.equal(a.linkId, '4->7');
  assert.equal(a.dstPort, null);
  assert.equal(a.srcHostId, 4);
  assert.equal(a.dstHostId, 7);
});

test('a finding with no pair labels is skipped, not rendered as undefined', () => {
  assert.deepEqual(buildAnomalies([flowFinding({ evidence: [] })]), []);
  assert.deepEqual(buildAnomalies([flowFinding({ evidence: [{ labels: { src: '4' } }] })]), []);
  assert.deepEqual(buildAnomalies([{ id: 'x' }]), []);
});

test('largest absolute swing first — a collapse ranks with a spike', () => {
  const out = buildAnomalies([
    flowFinding({ id: 'a', src: '1', observed: 1100, baseline: 1000 }), // +10%
    flowFinding({ id: 'b', src: '2', observed: 50, baseline: 1000 }), // -95%
    flowFinding({ id: 'c', src: '3', observed: 3000, baseline: 1000 }), // +200%
  ]);
  assert.deepEqual(out.map((a) => a.id ?? a.findingId), ['c', 'b', 'a']);
});

test('unrateable rows sink to the bottom rather than disappearing', () => {
  const out = buildAnomalies([
    flowFinding({ id: 'a', baseline: 0 }),
    flowFinding({ id: 'b', src: '9', observed: 1200, baseline: 1000 }),
  ]);
  assert.deepEqual(out.map((a) => a.findingId), ['b', 'a']);
  assert.equal(out[1].currentVsBaselinePct, null);
});

test('garbage in yields an empty list, never a throw', () => {
  for (const input of [null, undefined, 'x', [null, undefined]]) {
    assert.deepEqual(buildAnomalies(input), []);
  }
});

// --- summary ----------------------------------------------------------------
test('summary pairs raw alarms against the causes they collapse to', () => {
  const rootCauses = [
    { id: 1, memberCount: 30, affectedDeviceIds: [1, 2], blastRadius: { directlyIsolated: [3], dependencyAffected: [] } },
    { id: 2, memberCount: 17, affectedDeviceIds: [4], blastRadius: { directlyIsolated: [], dependencyAffected: [5] } },
  ];
  const s = buildSummary({ rootCauses, anomalies: [{}, {}] });
  assert.equal(s.activeFaults, 47); // 30 + 17 raw member findings
  assert.equal(s.rootCauses, 2); // collapsed to 2 causes
  assert.equal(s.affectedDevices, 5); // 1,2,3,4,5 — each counted once
  assert.equal(s.anomalies, 2);
});

test('affectedDevices counts a device once even when several causes name it', () => {
  const s = buildSummary({
    rootCauses: [
      { affectedDeviceIds: [1, 2], blastRadius: { directlyIsolated: [3] } },
      { affectedDeviceIds: [2, 3], blastRadius: { dependencyAffected: [1] } },
    ],
  });
  assert.equal(s.affectedDevices, 3);
});

test('non-ok topology nodes join the impact footprint and are broken out', () => {
  const topology = {
    counts: { ok: 1, down: 1, unreachable_downstream: 2 },
    nodes: [
      { id: 1, state: NODE_STATE.OK },
      { id: 2, state: NODE_STATE.DOWN },
      { id: 3, state: NODE_STATE.UNREACHABLE_DOWNSTREAM },
      { id: 4, state: NODE_STATE.UNREACHABLE_DOWNSTREAM },
    ],
  };
  const s = buildSummary({ rootCauses: [], topology });
  assert.equal(s.affectedDevices, 3); // 2, 3, 4 — the healthy node is not impact
  assert.equal(s.devicesDown, 1);
  assert.equal(s.devicesUnreachable, 2);
});

test('empty state yields all zeros, never a throw', () => {
  assert.deepEqual(buildSummary(), {
    activeFaults: 0, affectedDevices: 0, rootCauses: 0, anomalies: 0,
    devicesDown: 0, devicesUnreachable: 0,
  });
  assert.deepEqual(buildSummary({ rootCauses: null, topology: null, anomalies: null }).affectedDevices, 0);
});
