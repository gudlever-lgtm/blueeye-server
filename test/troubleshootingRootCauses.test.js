'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRootCauses,
  collateBlastRadius,
  worstSeverity,
  causeText,
} = require('../src/troubleshooting/overview');

// A minimal buildClusterDetail()-shaped object — only the fields the rollup reads.
function cluster(over = {}) {
  return {
    id: 1,
    status: 'open',
    confidence: 'high',
    firstSeen: '2026-07-27T10:00:00.000Z',
    lastSeen: '2026-07-27T10:05:00.000Z',
    memberCount: 2,
    members: [{ severity: 'WARN' }, { severity: 'CRIT' }],
    affectedAgents: ['4', '7'],
    suspectedRootCause: { classification: 'network', reason: 'link metrics', commonCause: null },
    evidenceSummary: { drivers: [], text: 'Grouped on time proximity alone.' },
    ...over,
  };
}

const radius = (isolated = [], dependents = []) => ({
  directly_isolated: isolated.map((hostId) => ({ hostId, path: [] })),
  dependency_affected: dependents.map((hostId) => ({ hostId, path: [] })),
});

test('worstSeverity takes the highest member severity', () => {
  assert.equal(worstSeverity([{ severity: 'INFO' }, { severity: 'CRIT' }, { severity: 'WARN' }]), 'CRIT');
  assert.equal(worstSeverity([{ severity: 'INFO' }]), 'INFO');
  assert.equal(worstSeverity([]), null);
  assert.equal(worstSeverity(null), null);
});

test('causeText prefers the correlator conclusion, then evidence, then reason', () => {
  assert.equal(
    causeText(cluster({ suspectedRootCause: { commonCause: 'Uplink sw-core-1 down', reason: 'r' } })),
    'Uplink sw-core-1 down',
  );
  assert.equal(causeText(cluster()), 'Grouped on time proximity alone.');
  assert.equal(
    causeText(cluster({ evidenceSummary: null, suspectedRootCause: { reason: 'link metrics' } })),
    'link metrics',
  );
  // Nothing at all to say — still no crash, still names the evidence we have.
  assert.equal(
    causeText({ affectedAgents: ['1', '2'] }),
    'Correlated anomalies across 2 agent(s).',
  );
});

// --- The core contract: N affected devices collapse to ONE root cause. -------
test('one cluster produces exactly one root cause, not one per affected device', () => {
  const out = buildRootCauses([cluster({ affectedAgents: ['1', '2', '3', '4', '5'] })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].affectedDeviceIds, [1, 2, 3, 4, 5]);
});

test('root cause carries the mandated fields', () => {
  const [rc] = buildRootCauses([cluster()]);
  assert.equal(rc.id, 1);
  assert.equal(rc.severity, 'CRIT'); // worst member wins
  assert.equal(rc.cause, 'Grouped on time proximity alone.');
  assert.deepEqual(rc.affectedDeviceIds, [4, 7]);
  assert.equal(rc.blastRadiusCount, 0); // no topology supplied
  assert.equal(rc.primaryDeviceId, 4); // lowest id — stable deep-link anchor
});

test('blast radius counts only devices BEYOND the affected set', () => {
  // Agent 4 isolates 8 and 9; but 7 is already named as affected, so it must
  // not be counted again.
  const blastByNode = new Map([[4, radius([7, 8, 9])]]);
  const [rc] = buildRootCauses([cluster()], { blastByNode });
  assert.deepEqual(rc.blastRadius.directlyIsolated, [8, 9]);
  assert.equal(rc.blastRadiusCount, 2);
});

test('blast radius unions across every affected device and de-duplicates', () => {
  const blastByNode = new Map([
    [4, radius([8], [10])],
    [7, radius([8, 9], [10, 11])],
  ]);
  const [rc] = buildRootCauses([cluster()], { blastByNode });
  assert.deepEqual(rc.blastRadius.directlyIsolated, [8, 9]);
  assert.deepEqual(rc.blastRadius.dependencyAffected, [10, 11]);
  assert.equal(rc.blastRadiusCount, 4);
});

test('a host that is L2-isolated is not double-counted as a service dependent', () => {
  const blastByNode = new Map([[4, radius([8], [8, 9])]]);
  const [rc] = buildRootCauses([cluster()], { blastByNode });
  assert.deepEqual(rc.blastRadius.directlyIsolated, [8]);
  assert.deepEqual(rc.blastRadius.dependencyAffected, [9]);
  assert.equal(rc.blastRadiusCount, 2);
});

test('blastByNode also accepts a plain object', () => {
  const [rc] = buildRootCauses([cluster()], { blastByNode: { 4: radius([8, 9]) } });
  assert.equal(rc.blastRadiusCount, 2);
});

test('missing blast radius for a node yields 0, not a throw', () => {
  const [rc] = buildRootCauses([cluster()], { blastByNode: new Map() });
  assert.equal(rc.blastRadiusCount, 0);
  assert.deepEqual(rc.blastRadius.directlyIsolated, []);
});

test('ordering: worst severity first, then most recent, then id', () => {
  const out = buildRootCauses([
    cluster({ id: 1, members: [{ severity: 'WARN' }], lastSeen: '2026-07-27T10:00:00.000Z' }),
    cluster({ id: 2, members: [{ severity: 'CRIT' }], lastSeen: '2026-07-27T09:00:00.000Z' }),
    cluster({ id: 3, members: [{ severity: 'WARN' }], lastSeen: '2026-07-27T11:00:00.000Z' }),
  ]);
  assert.deepEqual(out.map((r) => r.id), [2, 3, 1]);
});

// --- Fail-closed: bad input costs the panel, never the screen. ---------------
test('garbage in yields an empty list, never a throw', () => {
  assert.deepEqual(buildRootCauses(null), []);
  assert.deepEqual(buildRootCauses(undefined), []);
  assert.deepEqual(buildRootCauses('nope'), []);
  assert.deepEqual(buildRootCauses([null, undefined, {}]), []); // {} has no id
});

test('non-numeric agent ids are dropped rather than becoming NaN', () => {
  const [rc] = buildRootCauses([cluster({ affectedAgents: ['4', 'sw-core-1', null, '', '0', '-2'] })]);
  assert.deepEqual(rc.affectedDeviceIds, [4]);
});

test('a cluster with no members still reports a severity', () => {
  const [rc] = buildRootCauses([cluster({ members: [], memberCount: 0 })]);
  assert.equal(rc.severity, 'INFO');
});

test('collateBlastRadius is safe with no topology at all', () => {
  assert.deepEqual(collateBlastRadius([1, 2], null), {
    directlyIsolated: [], dependencyAffected: [], count: 0,
  });
});
