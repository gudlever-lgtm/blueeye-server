'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createBaselineStore, median, mad } = require('../baselines');

const at = (iso) => new Date(iso);

test('median is correct for odd and even datasets', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5]), 5);
});

test('mad is correct on a known dataset', () => {
  // values 1..9 -> median 5; abs devs [4,3,2,1,0,1,2,3,4] -> median 2
  assert.equal(mad([1, 2, 3, 4, 5, 6, 7, 8, 9]), 2);
  // with explicit median argument
  assert.equal(mad([2, 4, 6], 4), 2);
});

test('a single outlier does not move the median much', () => {
  const base = [10, 11, 9, 10, 11, 9, 10, 11];
  const withOutlier = base.concat([10000]);
  const before = median(base);
  const after = median(withOutlier);
  assert.ok(Math.abs(after - before) <= 1, `median moved too much: ${before} -> ${after}`);
});

test('bucket separates day and night by UTC hour', () => {
  const store = createBaselineStore();
  assert.equal(store.bucket(at('2026-01-01T02:30:00Z')), 2);
  assert.equal(store.bucket(at('2026-01-01T14:30:00Z')), 14);
  assert.notEqual(store.bucket(at('2026-01-01T02:00:00Z')), store.bucket(at('2026-01-01T14:00:00Z')));
});

test('get returns null before minSamples, then a baseline after', () => {
  const store = createBaselineStore({ minSamples: 5, windowSize: 50 });
  const ts = at('2026-01-01T03:00:00Z'); // bucket 3
  for (let i = 0; i < 4; i += 1) store.update({ hostId: 'h1', metric: 'cpu', value: 10 + (i % 2), ts });
  assert.equal(store.get('h1', 'cpu', 3), null); // only 4 < 5

  store.update({ hostId: 'h1', metric: 'cpu', value: 11, ts });
  const b = store.get('h1', 'cpu', 3);
  assert.ok(b && b.n === 5);
  assert.equal(typeof b.median, 'number');
  assert.equal(typeof b.mad, 'number');
});

test('day and night buckets are independent', () => {
  const store = createBaselineStore({ minSamples: 3, windowSize: 50 });
  const day = at('2026-01-01T12:00:00Z');
  const night = at('2026-01-01T00:00:00Z');
  for (let i = 0; i < 3; i += 1) store.update({ hostId: 'h1', metric: 'cpu', value: 80, ts: day });
  for (let i = 0; i < 3; i += 1) store.update({ hostId: 'h1', metric: 'cpu', value: 5, ts: night });
  assert.equal(store.get('h1', 'cpu', 12).median, 80);
  assert.equal(store.get('h1', 'cpu', 0).median, 5);
});

test('isFlat is true for 10 identical trailing values, false otherwise', () => {
  const store = createBaselineStore({ minSamples: 1, windowSize: 50 });
  const ts = at('2026-01-01T05:00:00Z');
  for (let i = 0; i < 9; i += 1) store.update({ hostId: 'h1', metric: 'cpu', value: 42, ts });
  assert.equal(store.isFlat('h1', 'cpu'), false); // only 9 identical

  store.update({ hostId: 'h1', metric: 'cpu', value: 42, ts });
  assert.equal(store.isFlat('h1', 'cpu'), true); // now 10 identical

  store.update({ hostId: 'h1', metric: 'cpu', value: 99, ts });
  assert.equal(store.isFlat('h1', 'cpu'), false); // trailing 10 no longer identical
});

test('windows are capped at windowSize (rolling)', () => {
  const store = createBaselineStore({ minSamples: 1, windowSize: 5 });
  const ts = at('2026-01-01T06:00:00Z');
  for (let i = 0; i < 20; i += 1) store.update({ hostId: 'h1', metric: 'cpu', value: i, ts });
  assert.equal(store.get('h1', 'cpu', 6).n, 5); // capped
});

test('baselines persist and reload via an injected store (survive restart)', () => {
  let saved = null;
  const fileLike = { read: () => saved, write: (d) => { saved = JSON.parse(JSON.stringify(d)); } };

  const s1 = createBaselineStore({ store: fileLike, minSamples: 3, windowSize: 50 });
  const ts = at('2026-01-01T07:00:00Z');
  for (let i = 0; i < 5; i += 1) s1.update({ hostId: 'h1', metric: 'cpu', value: 50, ts });
  assert.ok(saved && Object.keys(saved).length === 1);

  // New instance reading the same persisted data keeps the warmed baseline.
  const s2 = createBaselineStore({ store: fileLike, minSamples: 3, windowSize: 50 });
  const b = s2.get('h1', 'cpu', 7);
  assert.ok(b && b.n === 5 && b.median === 50);
});

test('debounced persistence does not write per sample and flushes on stop', () => {
  let writes = 0;
  let flushed = null;
  const fileLike = {
    read: () => null,
    write() { writes += 1; },
    flushSync(d) { flushed = d; },
  };
  const s = createBaselineStore({ store: fileLike, minSamples: 1, windowSize: 50, persistIntervalMs: 60000 });
  const ts = at('2026-01-01T08:00:00Z');
  for (let i = 0; i < 10; i += 1) s.update({ hostId: 'h1', metric: 'cpu', value: i, ts });

  // No synchronous per-sample write happened (it is debounced onto the timer).
  assert.equal(writes, 0);

  // Graceful shutdown flushes the warmed window synchronously.
  s.stop();
  assert.ok(flushed && Array.isArray(flushed['h1|cpu|8']) && flushed['h1|cpu|8'].length === 10);
});
