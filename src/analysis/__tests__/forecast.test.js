'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { forecast, theilSenSlope, median, MIN_POINTS } = require('../forecast');

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
// A clean rising series: v = 10 per day starting at 100.
const rising = (n, perDay = 10, base = 100) =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, v: base + i * perDay }));

test('median handles odd and even length', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('theilSenSlope recovers a clean linear slope (per ms)', () => {
  const slope = theilSenSlope(rising(10, 10).map((p) => ({ t: p.t, v: p.v })));
  assert.ok(Math.abs(slope * DAY - 10) < 1e-9); // 10 units/day
});

test('theilSenSlope is robust to a single outlier', () => {
  const pts = rising(11, 10).map((p) => ({ t: p.t, v: p.v }));
  pts[5].v += 100000; // one wild spike
  const slope = theilSenSlope(pts) * DAY;
  assert.ok(Math.abs(slope - 10) < 1e-6, `slope ${slope} should stay ~10 despite the outlier`);
});

test('forecast refuses insufficient data', () => {
  const r = forecast(rising(MIN_POINTS - 1, 10));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_data');
});

test('forecast projects a rising series and computes days-until-capacity', () => {
  const now = T0 + 9 * DAY; // evaluate at the last sample
  const r = forecast(rising(10, 10, 100), { capacity: 300, horizonDays: 10, now });
  assert.equal(r.ok, true);
  assert.equal(r.direction, 'rising');
  assert.ok(Math.abs(r.slopePerDay - 10) < 1e-6);
  // current ~= 190 (100 + 9*10); projected 10 days out ~= 290.
  assert.ok(Math.abs(r.current - 190) < 1e-6);
  assert.ok(Math.abs(r.projected - 290) < 1e-6);
  // capacity 300, current 190, +10/day -> ~11 days.
  assert.ok(Math.abs(r.daysUntilCapacity - 11) < 1e-6);
  assert.match(r.explanation, /rising/);
  assert.equal(r.evidence.method, 'theil-sen');
});

test('forecast reports a flat series and no days-until-capacity', () => {
  const flat = Array.from({ length: 8 }, (_, i) => ({ t: T0 + i * DAY, v: 50 }));
  const r = forecast(flat, { capacity: 100, now: T0 + 7 * DAY });
  assert.equal(r.direction, 'flat');
  assert.equal(r.daysUntilCapacity, null); // not rising -> no ETA
});

test('forecast gives no ETA when already at/over capacity', () => {
  const r = forecast(rising(8, 10, 100), { capacity: 50, now: T0 + 7 * DAY });
  assert.equal(r.daysUntilCapacity, null); // current already exceeds capacity
});
