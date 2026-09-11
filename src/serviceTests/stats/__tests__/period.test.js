'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePeriod, bucketKey, sqlFormat, isPeriod, PERIODS } = require('../period');

// Copenhagen in summer: UTC+2, so getTimezoneOffset() is -120.
const CPH = -120;
const NOW = new Date('2026-09-11T09:30:00.000Z');

test('only the four segmentations exist', () => {
  assert.deepEqual(PERIODS, ['day', 'week', 'month', 'year']);
  for (const p of PERIODS) assert.equal(isPeriod(p), true, p);
  for (const p of ['hour', 'decade', '', null, undefined, 'DAY']) assert.equal(isPeriod(p), false, String(p));
});

test('an unknown period or a malformed date falls back rather than throwing', () => {
  // A chart is not worth a crash: a bad query string draws this week.
  const fallback = resolvePeriod({ period: 'decade', at: 'yesterday', now: NOW, offsetMinutes: CPH });
  assert.equal(fallback.period, 'week');
  assert.equal(fallback.at, '2026-09-07');
});

test('each period covers the right window in the viewer\'s local time', () => {
  const cases = [
    ['day', '2026-09-11', '2026-09-10T22:00:00.000Z', '2026-09-11T22:00:00.000Z', 24, 'hour'],
    ['week', '2026-09-07', '2026-09-06T22:00:00.000Z', '2026-09-13T22:00:00.000Z', 7, 'day'],
    ['month', '2026-09-01', '2026-08-31T22:00:00.000Z', '2026-09-30T22:00:00.000Z', 30, 'day'],
    ['year', '2026-01-01', '2025-12-31T22:00:00.000Z', '2026-12-31T22:00:00.000Z', 12, 'month'],
  ];
  for (const [period, at, from, to, count, bucket] of cases) {
    const r = resolvePeriod({ period, now: NOW, offsetMinutes: CPH });
    assert.equal(r.at, at, period);
    assert.equal(r.from.toISOString(), from, period);
    assert.equal(r.to.toISOString(), to, period);
    assert.equal(r.buckets.length, count, period);
    assert.equal(r.bucket, bucket, period);
  }
});

test('the window is UTC when the viewer is at UTC', () => {
  const r = resolvePeriod({ period: 'day', now: NOW, offsetMinutes: 0 });
  assert.equal(r.from.toISOString(), '2026-09-11T00:00:00.000Z');
  assert.equal(r.to.toISOString(), '2026-09-12T00:00:00.000Z');
});

test('a week starts on Monday', () => {
  // 2026-09-11 is a Friday; the week it belongs to starts on the 7th.
  for (const day of ['2026-09-07', '2026-09-11', '2026-09-13']) {
    assert.equal(resolvePeriod({ period: 'week', at: day, now: NOW, offsetMinutes: CPH }).at, '2026-09-07', day);
  }
  assert.equal(resolvePeriod({ period: 'week', at: '2026-09-14', now: NOW, offsetMinutes: CPH }).at, '2026-09-14');
});

test('any date inside a period identifies it', () => {
  for (const day of ['2026-09-01', '2026-09-11', '2026-09-30']) {
    assert.equal(resolvePeriod({ period: 'month', at: day, now: NOW, offsetMinutes: CPH }).at, '2026-09-01', day);
    assert.equal(resolvePeriod({ period: 'year', at: day, now: NOW, offsetMinutes: CPH }).at, '2026-01-01', day);
  }
});

test('month lengths and leap years come from the calendar, not from 30-day arithmetic', () => {
  const lengths = { '2026-02-01': 28, '2024-02-01': 29, '2026-04-01': 30, '2026-07-01': 31 };
  for (const [at, days] of Object.entries(lengths)) {
    assert.equal(resolvePeriod({ period: 'month', at, now: NOW, offsetMinutes: CPH }).buckets.length, days, at);
  }
});

test('prev and next step by one period, and next stops at today', () => {
  const sept = resolvePeriod({ period: 'month', at: '2026-09-11', now: NOW, offsetMinutes: CPH });
  assert.equal(sept.prev_at, '2026-08-01');
  assert.equal(sept.next_at, '2026-10-01');
  assert.equal(sept.is_current, true);
  assert.equal(sept.has_next, false, 'October has not happened yet');

  const august = resolvePeriod({ period: 'month', at: '2026-08-15', now: NOW, offsetMinutes: CPH });
  assert.equal(august.has_next, true);
  assert.equal(august.is_current, false);

  // Across a year boundary, backwards.
  const january = resolvePeriod({ period: 'month', at: '2026-01-09', now: NOW, offsetMinutes: CPH });
  assert.equal(january.prev_at, '2025-12-01');
});

test('a bucket key is the same string the SQL format produces', () => {
  // These two must agree exactly or empty buckets never match a row and every
  // chart reads as "nothing ran".
  assert.equal(sqlFormat('hour'), '%Y-%m-%d %H:00');
  assert.equal(sqlFormat('day'), '%Y-%m-%d 00:00');
  assert.equal(sqlFormat('month'), '%Y-%m-01 00:00');

  const at = new Date('2026-09-11T13:37:00.000Z');
  assert.equal(bucketKey(at, 'hour'), '2026-09-11 13:00');
  assert.equal(bucketKey(at, 'day'), '2026-09-11 00:00');
  assert.equal(bucketKey(at, 'month'), '2026-09-01 00:00');
});

test('every bucket in the period is present, in order, with no gaps', () => {
  const r = resolvePeriod({ period: 'week', at: '2026-09-07', now: NOW, offsetMinutes: CPH });
  assert.deepEqual(r.buckets.map((b) => b.key), [
    '2026-09-07 00:00', '2026-09-08 00:00', '2026-09-09 00:00', '2026-09-10 00:00',
    '2026-09-11 00:00', '2026-09-12 00:00', '2026-09-13 00:00',
  ]);
  const starts = r.buckets.map((b) => new Date(b.start).getTime());
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] > starts[i - 1], 'buckets must ascend');
});

test('a nonsensical offset is clamped instead of shifting the window into fiction', () => {
  const r = resolvePeriod({ period: 'day', at: '2026-09-11', now: NOW, offsetMinutes: 999999 });
  assert.equal(r.offset_minutes, 1440);
  const bad = resolvePeriod({ period: 'day', at: '2026-09-11', now: NOW, offsetMinutes: 'not a number' });
  assert.equal(bad.offset_minutes, 0);
});
