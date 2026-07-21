'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { METRICS, getMetric, bucketMetric, resolveBucketMs } = require('../pathTimeseries');

const row = (ts, over = {}) => ({ agentId: 1, agentName: 'a1', ts, rttMs: 10, jitterMs: 2, lossPct: 0, bytes: 1000, ok: true, ...over });

test('getMetric resolves the catalogue and rejects unknowns', () => {
  assert.equal(getMetric('latency').field, 'rttMs');
  assert.equal(getMetric('LOSS').render, 'bars');
  assert.equal(getMetric('throughput').agg, 'rate');
  assert.equal(getMetric('nope'), null);
  assert.ok(METRICS.length >= 4);
});

test('bucketMetric returns an empty series array (not null) for no rows', () => {
  const out = bucketMetric([], { from: '2026-06-09T00:00:00Z', to: '2026-06-09T01:00:00Z', metric: 'latency' });
  assert.deepEqual(out.series, []);
  assert.equal(out.metric, 'latency');
});

test('bucketMetric buckets latency with the median per bucket', () => {
  const out = bucketMetric([
    row('2026-06-09T10:00:10Z', { rttMs: 10 }),
    row('2026-06-09T10:00:20Z', { rttMs: 30 }),
    row('2026-06-09T10:00:40Z', { rttMs: 20 }),
  ], { from: '2026-06-09T10:00:00Z', to: '2026-06-09T10:05:00Z', bucketMs: 300000, metric: 'latency' });
  assert.equal(out.series.length, 1);
  assert.equal(out.series[0].points.length, 1);
  assert.equal(out.series[0].points[0].value, 20); // median of [10,30,20]
  assert.equal(out.series[0].points[0].count, 3);
});

test('bucketMetric with overlay=agents splits one series per agent', () => {
  const out = bucketMetric([
    row('2026-06-09T10:00:10Z', { agentId: 1, agentName: 'a1', rttMs: 10 }),
    row('2026-06-09T10:00:10Z', { agentId: 2, agentName: 'a2', rttMs: 50 }),
  ], { from: '2026-06-09T10:00:00Z', to: '2026-06-09T10:05:00Z', bucketMs: 300000, metric: 'latency', overlay: 'agents' });
  assert.equal(out.series.length, 2);
  assert.deepEqual(out.series.map((s) => s.agentId), [1, 2]);
  assert.equal(out.series[0].points[0].value, 10);
  assert.equal(out.series[1].points[0].value, 50);
});

test('bucketMetric throughput aggregates bytes into bytes/sec over the bucket', () => {
  const out = bucketMetric([
    row('2026-06-09T10:00:10Z', { bytes: 3000 }),
    row('2026-06-09T10:00:20Z', { bytes: 3000 }),
  ], { from: '2026-06-09T10:00:00Z', to: '2026-06-09T10:01:00Z', bucketMs: 60000, metric: 'throughput' });
  // 6000 bytes over a 60s bucket = 100 B/s
  assert.equal(out.series[0].points[0].value, 100);
  assert.equal(out.render, 'area');
});

test('bucketMetric rejects an unknown metric', () => {
  assert.throws(() => bucketMetric([], { metric: 'bogus' }), /unknown metric/);
});

// --- DST correctness -------------------------------------------------------
// Europe/Copenhagen springs forward 2026-03-29 02:00 -> 03:00 CET->CEST. Because
// bucketing is aligned on the absolute UTC epoch, an hourly bucket is always
// exactly 3600s of real time — the "missing" wall-clock hour must NOT create a
// gap, a double-count, or shift the bucket edges.
test('bucketMetric bucket edges are DST-agnostic across the spring-forward boundary', () => {
  // Timestamps straddling the CET->CEST transition, one probe every 30 min (UTC).
  const rows = [];
  // 00:30, 01:30, 02:30, 03:30 UTC == local 01:30 CET, 03:30 CEST, 04:30, 05:30
  for (const iso of ['2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', '2026-03-29T02:30:00Z', '2026-03-29T03:30:00Z']) {
    rows.push(row(iso, { rttMs: 10 }));
  }
  const out = bucketMetric(rows, {
    from: '2026-03-29T00:00:00Z', to: '2026-03-29T04:00:00Z', bucketMs: 3600000, metric: 'latency',
  });
  // Exactly 4 hourly buckets, each with exactly one sample — no gap, no overlap.
  assert.equal(out.series[0].points.length, 4);
  assert.deepEqual(out.series[0].points.map((p) => p.count), [1, 1, 1, 1]);
  // Bucket starts are clean UTC-hour boundaries, uniformly 3600s apart.
  const starts = out.series[0].points.map((p) => Date.parse(p.t));
  for (let i = 1; i < starts.length; i += 1) assert.equal(starts[i] - starts[i - 1], 3600000);
  assert.equal(new Date(starts[0]).toISOString(), '2026-03-29T00:00:00.000Z');
});

test('resolveBucketMs honours a valid request and auto-picks otherwise', () => {
  assert.equal(resolveBucketMs(3600000, 300), 300000); // explicit 5m
  assert.equal(resolveBucketMs(3600000, 5), 60000); // too small -> auto (~30s target -> 60s)
  assert.equal(resolveBucketMs(24 * 3600000, null), 900000); // 1 day / 120 ~= 720s -> 900s (15m)
});
