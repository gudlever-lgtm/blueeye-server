'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { scoreSimilarIncidents, DEFAULT_WEIGHTS } = require('../src/incidentCases/similarity');

const TARGET = { id: 100, hostId: '9', platform: 'linux', primaryMetric: 'cpu', configChangeType: 'high' };

test('scoring ranks by number/weight of matched criteria (known fixtures)', () => {
  const candidates = [
    // full match: device(3) + anomalyType(2) + configChangeType(1) = 6
    { id: 1, hostId: '9', platform: 'linux', primaryMetric: 'cpu', configChangeType: 'high', resolvedAt: '2026-05-01T00:00:00Z' },
    // device(3) only = 3
    { id: 2, hostId: '9', platform: 'linux', primaryMetric: 'mem', configChangeType: null, resolvedAt: '2026-05-02T00:00:00Z' },
    // same device-type + anomalyType = 1 + 2 = 3, but device differs
    { id: 3, hostId: '7', platform: 'linux', primaryMetric: 'cpu', configChangeType: null, resolvedAt: '2026-05-03T00:00:00Z' },
  ];
  const out = scoreSimilarIncidents(TARGET, candidates);
  assert.deepEqual(out.map((r) => r.id), [1, 3, 2]);
  assert.equal(out[0].score, 6);
  // tie at score 3 → most-recently-resolved first (id 3 resolved after id 2)
  assert.equal(out[1].id, 3);
  assert.equal(out[2].id, 2);
  assert.deepEqual(out[0].matchedOn, ['device', 'anomalyType', 'configChangeType']);
});

test('candidates with no shared criteria are dropped', () => {
  const out = scoreSimilarIncidents(TARGET, [
    { id: 5, hostId: '99', platform: 'windows', primaryMetric: 'disk', configChangeType: 'low' },
  ]);
  assert.deepEqual(out, []);
});

test('device match and device-type never double-count', () => {
  const [r] = scoreSimilarIncidents(TARGET, [{ id: 6, hostId: '9', platform: 'linux', primaryMetric: 'x' }]);
  assert.equal(r.score, DEFAULT_WEIGHTS.device); // 3, not 3+1
  assert.deepEqual(r.matchedOn, ['device']);
});

test('the target itself is excluded and limit is honoured', () => {
  const cands = [
    { id: 100, hostId: '9', primaryMetric: 'cpu' }, // == target, excluded
    { id: 1, hostId: '9', primaryMetric: 'cpu' },
    { id: 2, hostId: '9', primaryMetric: 'cpu' },
    { id: 3, hostId: '9', primaryMetric: 'cpu' },
  ];
  const out = scoreSimilarIncidents(TARGET, cands, { limit: 2 });
  assert.equal(out.length, 2);
  assert.ok(!out.some((r) => r.id === 100));
});

test('weights are overridable', () => {
  const [r] = scoreSimilarIncidents(TARGET, [{ id: 1, hostId: '9', primaryMetric: 'cpu' }], { weights: { device: 10 } });
  // device 10 + anomalyType default 2 = 12
  assert.equal(r.score, 12);
});
