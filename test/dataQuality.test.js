'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDataQuality } = require('../src/health/dataQuality');

const NOW = Date.parse('2026-06-02T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const netflow = (packets, dropped, finishedMsAgo = 500) => ({
  created_at: new Date(NOW),
  payload: { finishedAt: ago(finishedMsAgo), traffic: { source: 'netflow', packets, droppedPackets: dropped } },
});

test('computeDataQuality is unknown with no measurement (but still reports version)', () => {
  const q = computeDataQuality({ capabilities: { agentVersion: '0.2.0' }, latest: null, now: NOW });
  assert.equal(q.status, 'unknown');
  assert.equal(q.version, '0.2.0');
});

test('computeDataQuality is ok for low drop + small skew', () => {
  const q = computeDataQuality({ capabilities: { agentVersion: '0.2.0' }, latest: netflow(100, 0), now: NOW });
  assert.equal(q.status, 'ok');
  assert.equal(q.dropPct, 0);
  assert.equal(q.source, 'netflow');
});

test('computeDataQuality warns at ~2% drop and is bad at ~6%', () => {
  assert.equal(computeDataQuality({ latest: netflow(98, 2), now: NOW }).status, 'warn');
  const bad = computeDataQuality({ latest: netflow(94, 6), now: NOW });
  assert.equal(bad.status, 'bad');
  assert.equal(bad.evidence[0].metric, 'drop');
});

test('computeDataQuality flags clock skew (warn ≥5s, bad ≥60s)', () => {
  const warn = computeDataQuality({ latest: { created_at: new Date(NOW), payload: { finishedAt: ago(6000), traffic: { source: 'proc', interfaces: [] } } }, now: NOW });
  assert.equal(warn.status, 'warn');
  assert.equal(warn.clockSkewMs, 6000);
  const bad = computeDataQuality({ latest: { created_at: new Date(NOW), payload: { finishedAt: ago(90000), traffic: { source: 'proc' } } }, now: NOW });
  assert.equal(bad.status, 'bad');
});
