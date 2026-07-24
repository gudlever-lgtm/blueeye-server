'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPairBaselines, zScore, classify, slotOf } = require('../src/analysis/flowPairBaseline');

const HOUR = 3600 * 1000;
const pair = { srcHostId: 1, dstHostId: 2, dstPort: 443 };

// Generate `days` of hourly buckets for one pair starting at `start`, with a
// bytes function of (dow, hour, index).
function series(start, days, bytesFn) {
  const rows = [];
  for (let i = 0; i < days * 24; i += 1) {
    const bucket = new Date(start.getTime() + i * HOUR);
    const { dow, hour } = slotOf(bucket);
    rows.push({ ...pair, bucket, bytes: bytesFn(dow, hour, i) });
  }
  return rows;
}

test('day-of-week + hour-of-day bucketing across a month of data', () => {
  // 28 days = 4 of each weekday. One slot (Tue-ish 14:00) is quiet (~100),
  // everything else is loud (~9000). Baseline for the quiet slot must reflect
  // ONLY that slot's samples, not a flat mean over all hours.
  const start = new Date('2026-06-01T00:00:00.000Z');
  const targetDow = slotOf(new Date('2026-06-02T14:00:00.000Z')).dow; // a Tuesday 14:00
  const targetHour = 14;
  const rows = series(start, 28, (dow, hour) => (dow === targetDow && hour === targetHour ? 100 : 9000));

  const baselines = buildPairBaselines(rows, { minObservations: 100 });
  // 7*24 = 168 slots, all eligible (pair has 672 buckets >= 100).
  assert.equal(baselines.length, 168);
  const quiet = baselines.find((b) => b.dow === targetDow && b.hour === targetHour);
  assert.equal(quiet.medianBytes, 100);          // NOT ~9000 — slot-aware
  assert.equal(quiet.sampleCount, 4);            // 4 Tuesdays in 28 days
  assert.equal(quiet.observationCount, 672);     // total buckets for the pair

  // A loud slot baselines around 9000.
  const loud = baselines.find((b) => b.dow === ((targetDow + 1) % 7) && b.hour === targetHour);
  assert.equal(loud.medianBytes, 9000);

  // Scoring a Tuesday-14:00 value of 9000 against the QUIET baseline is a large
  // deviation (compared to prior Tuesdays 14:00, not the flat mean).
  const z = zScore(quiet, 9000);
  assert.ok(Math.abs(z) > 4, `expected big z, got ${z}`);
});

test('known-deviation synthetic series produces a score; flat series does not', () => {
  const start = new Date('2026-06-01T00:00:00.000Z');
  // A slot with real variance so MAD > 0: values cycle 100/120/140/160.
  const vals = [100, 120, 140, 160];
  const rows = series(start, 28, (dow, hour, i) => (hour === 3 ? vals[Math.floor(i / 24) % 4] : 500));
  const baselines = buildPairBaselines(rows, { minObservations: 100 });
  const slot = baselines.find((b) => b.hour === 3);
  assert.ok(slot.madBytes > 0);

  // A big spike scores; a value at the median does not.
  assert.ok(classify(zScore(slot, 5000), { warnSigma: 3, critSigma: 4 }) === 'CRIT');
  assert.equal(classify(zScore(slot, slot.medianBytes), { warnSigma: 3, critSigma: 4 }), null);
});

test('flat series (no variance, observed equals baseline) yields no anomaly', () => {
  const start = new Date('2026-06-01T00:00:00.000Z');
  const rows = series(start, 28, () => 1000); // perfectly flat everywhere
  const baselines = buildPairBaselines(rows, { minObservations: 100 });
  const b = baselines[0];
  assert.equal(b.medianBytes, 1000);
  assert.equal(b.madBytes, 0);
  // Observed equals the flat baseline → z 0 → no score.
  assert.equal(classify(zScore(b, 1000), {}), null);
});

test('minimum observation gate: a sparse pair gets no baseline', () => {
  const start = new Date('2026-06-01T00:00:00.000Z');
  const rows = series(start, 3, () => 1000); // 72 buckets < 100
  assert.deepEqual(buildPairBaselines(rows, { minObservations: 100 }), []);
  // Lowering the gate makes it eligible.
  assert.ok(buildPairBaselines(rows, { minObservations: 50 }).length > 0);
});

test('classify honours sigma thresholds', () => {
  assert.equal(classify(2.9, { warnSigma: 3, critSigma: 4 }), null);
  assert.equal(classify(3.1, { warnSigma: 3, critSigma: 4 }), 'WARN');
  assert.equal(classify(-4.2, { warnSigma: 3, critSigma: 4 }), 'CRIT');
  assert.equal(classify(null, {}), null);
});
