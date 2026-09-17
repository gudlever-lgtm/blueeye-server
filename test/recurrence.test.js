'use strict';

// src/schedule/recurrence.js — the calendar half of a test package's schedule.
// Every case here is computed in the server's LOCAL time zone, exactly as the
// scheduler computes it, so the assertions are written against local wall-clock
// components rather than an absolute epoch.

// Pinned to a zone WITH daylight saving so the DST cases mean something
// wherever this runs (CI is UTC, a developer's laptop is not). Set before the
// first Date is constructed, which is what makes it take effect.
process.env.TZ = 'Europe/Copenhagen';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateRecurrence, nextRunAt, MIN_SPACING_MS, MAX_EVERY } = require('../src/schedule/recurrence');

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

test('validateRecurrence rejects anything that is not a recurrence', () => {
  for (const bad of [undefined, null, 'daily', 42, [], {}, { period: 'yearly' }]) {
    assert.ok(validateRecurrence(bad).errors, JSON.stringify(bad));
  }
  // A period that needs a time of day must carry one.
  assert.ok(validateRecurrence({ period: 'daily', every: 1 }).errors.at);
  assert.ok(validateRecurrence({ period: 'daily', every: 1, at: '25:00' }).errors.at);
  assert.ok(validateRecurrence({ period: 'weekly', every: 1, at: '08:00' }).errors.weekday);
  assert.ok(validateRecurrence({ period: 'weekly', every: 1, at: '08:00', weekday: 8 }).errors.weekday);
  // The 29th-31st does not exist in every month, so it is not a monthly day.
  assert.ok(validateRecurrence({ period: 'monthly', every: 1, at: '08:00', dayOfMonth: 31 }).errors.dayOfMonth);
  assert.ok(validateRecurrence({ period: 'daily', every: 0, at: '08:00' }).errors.every);
  assert.ok(validateRecurrence({ period: 'daily', every: MAX_EVERY + 1, at: '08:00' }).errors.every);
});

test('validateRecurrence refuses a spacing that would burst the agents', () => {
  // One hour split 12 ways is 5 minutes — the floor — and 13 ways is under it.
  assert.equal(validateRecurrence({ period: 'hourly', every: 12 }).errors, undefined);
  assert.ok(validateRecurrence({ period: 'hourly', every: 13 }).errors.every);
  assert.equal(MIN_SPACING_MS, 5 * 60 * 1000);
});

test('validateRecurrence normalises what it keeps', () => {
  const { value } = validateRecurrence({ period: 'daily', every: '6', at: '8:05', extra: 'ignored' });
  assert.deepEqual(value, { period: 'daily', every: 6, at: '08:05' });
  // An hourly recurrence has no time of day — the hour IS the period.
  assert.equal(validateRecurrence({ period: 'hourly', every: 4, at: '08:00' }).value.at, null);
});

test('daily: the slots are evenly spaced from the time of day', () => {
  const spec = { period: 'daily', every: 6, at: '08:00' }; // 08, 12, 16, 20, 00, 04
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 10, 7, 0))), '03-10 08:00');
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 10, 8, 0))), '03-10 12:00');
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 10, 21, 30))), '03-11 00:00');
  // Once a day means once a day, at the hour asked for.
  const once = { period: 'daily', every: 1, at: '08:00' };
  assert.equal(hhmm(nextRunAt(once, at(2026, 3, 10, 8, 0, 0))), '03-11 08:00');
  assert.equal(hhmm(nextRunAt(once, at(2026, 3, 10, 7, 59))), '03-10 08:00');
});

test('hourly: the period is the hour, whatever minute it is now', () => {
  const spec = { period: 'hourly', every: 4 }; // :00 :15 :30 :45
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 10, 9, 1))), '03-10 09:15');
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 10, 9, 46))), '03-10 10:00');
});

test('weekly: it lands on the weekday asked for, and once a week means once', () => {
  const monday = { period: 'weekly', every: 1, at: '07:30', weekday: 1 };
  // 2026-03-10 is a Tuesday; the next Monday is the 16th.
  assert.equal(new Date(at(2026, 3, 10)).getDay(), 2);
  assert.equal(hhmm(nextRunAt(monday, at(2026, 3, 10, 12, 0))), '03-16 07:30');
  // Seven runs inside the week is one a day, still anchored at 07:30.
  const daily = { period: 'weekly', every: 7, at: '07:30', weekday: 1 };
  assert.equal(hhmm(nextRunAt(daily, at(2026, 3, 10, 12, 0))), '03-11 07:30');
});

test('monthly: the spacing follows the real length of the month', () => {
  const spec = { period: 'monthly', every: 2, at: '06:00', dayOfMonth: 1 };
  // February 2026 has 28 days → the second slot is the 15th.
  assert.equal(hhmm(nextRunAt(spec, at(2026, 2, 2, 0, 0))), '02-15 06:00');
  // March has 31 days AND loses an hour to DST on the 29th, so the period is
  // 743 hours and its midpoint is 17:30 rather than 18:00. That is the point of
  // measuring the period on the calendar: the second slot sits exactly halfway
  // through the month as it really is.
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 2, 0, 0))), '03-16 17:30');
  const once = { period: 'monthly', every: 1, at: '06:00', dayOfMonth: 28 };
  assert.equal(hhmm(nextRunAt(once, at(2026, 2, 28, 6, 0))), '03-28 06:00');
});

test('the next run is always strictly in the future, and an invalid spec is never due', () => {
  const spec = { period: 'daily', every: 4, at: '00:00' };
  let from = at(2026, 3, 10, 0, 0);
  for (let i = 0; i < 10; i += 1) {
    const next = nextRunAt(spec, from);
    assert.ok(next > from, `slot ${i} did not advance`);
    from = next;
  }
  for (const bad of [null, { period: 'nope' }, { period: 'daily', every: 1 }]) {
    assert.equal(nextRunAt(bad, Date.now()), null, JSON.stringify(bad));
  }
  assert.equal(nextRunAt({ period: 'daily', every: 1, at: '08:00' }, 'not-a-time'), null);
});

test('a DST change moves the clock, not the appointment', () => {
  // Europe/Copenhagen springs forward on 2026-03-29. A daily 08:00 schedule
  // stays at 08:00 — which is only true because the period length is taken
  // from the calendar rather than assumed to be 24h.
  const spec = { period: 'daily', every: 1, at: '08:00' };
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 28, 9, 0))), '03-29 08:00');
  assert.equal(hhmm(nextRunAt(spec, at(2026, 3, 29, 9, 0))), '03-30 08:00');
});
