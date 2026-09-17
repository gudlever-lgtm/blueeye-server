'use strict';

// Recurrence — "repeat this, on a calendar" for test packages.
//
// `test_packages.schedule_ms` is a plain interval: run every N ms since the last
// run. That cannot say "every Monday at 08:00" and it cannot say anything longer
// than a day, which is exactly what the Connection Test's Repeat dialog asks
// for. A recurrence is the calendar half of the same question:
//
//   { period: 'daily', every: 6, at: '08:00' }   → 08:00, 12:00, 16:00, 20:00
//   { period: 'weekly', every: 1, at: '07:30', weekday: 1 }  → Mondays 07:30
//   { period: 'monthly', every: 2, at: '06:00', dayOfMonth: 1 } → the 1st and ~15th
//
// `every` is the number of runs INSIDE one period, evenly spaced from the
// anchor — the same knob the dialog calls "repetitions within the period". The
// spacing is derived from the real calendar length of that period rather than a
// constant, so a daily schedule stays at 08:00 across a DST change and a monthly
// one spaces itself over 28, 30 or 31 days as the month actually has.
//
// Everything here is pure and computed in the SERVER's local time zone (the
// scheduler ticks there; a per-package zone would be a column and a promise we
// cannot keep for an on-prem box whose clock the customer owns). No I/O, no
// Date.now() — the caller passes the instant, which is what makes it testable.

const PERIODS = ['hourly', 'daily', 'weekly', 'monthly'];

// A calendar day is nominally 24h, but the real length of a period is taken from
// the calendar below; these are only used for the "is this spacing sane" bound.
const NOMINAL_PERIOD_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 28 * 24 * 60 * 60 * 1000,
};

// The floor on the gap between two runs of one package. Below this a "schedule"
// is a burst: every run pushes commands to every targeted agent, and agents
// answer by measuring the customer's network.
const MIN_SPACING_MS = 5 * 60 * 1000;
const MAX_EVERY = 288; // 288 × 5 min = one day, the tightest a daily period can be

// ISO weekday: Monday = 1 … Sunday = 7. JS `getDay()` is Sunday = 0.
const isoDay = (d) => d.getDay() || 7;

function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at == null ? '' : at).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

// The spacing a spec asks for, using the period's nominal length. Used by
// validation; the scheduler uses the real calendar length instead.
function nominalSpacingMs(spec) {
  return Math.floor(NOMINAL_PERIOD_MS[spec.period] / spec.every);
}

// The start of the period `d` falls inside — the anchor every slot is measured
// from. Local time throughout.
function periodStart(spec, d) {
  const at = spec.at ? parseAt(spec.at) : { h: 0, m: 0 };
  const hh = at ? at.h : 0;
  const mm = at ? at.m : 0;
  if (spec.period === 'hourly') {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), 0, 0, 0);
  }
  if (spec.period === 'daily') {
    const anchor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
    if (anchor > d) anchor.setDate(anchor.getDate() - 1);
    return anchor;
  }
  if (spec.period === 'weekly') {
    const anchor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);
    // Walk back to the requested weekday (0-6 days), then one more week if that
    // lands in the future (the weekday matches but the time has not come yet).
    const back = (isoDay(anchor) - spec.weekday + 7) % 7;
    anchor.setDate(anchor.getDate() - back);
    if (anchor > d) anchor.setDate(anchor.getDate() - 7);
    return anchor;
  }
  const anchor = new Date(d.getFullYear(), d.getMonth(), spec.dayOfMonth, hh, mm, 0, 0);
  if (anchor > d) anchor.setMonth(anchor.getMonth() - 1);
  return anchor;
}

// The anchor of the period after this one — calendar arithmetic, so a DST change
// or a 31-day month changes the length rather than the wall-clock time.
function nextPeriodStart(spec, start) {
  const next = new Date(start.getTime());
  if (spec.period === 'hourly') next.setHours(next.getHours() + 1);
  else if (spec.period === 'daily') next.setDate(next.getDate() + 1);
  else if (spec.period === 'weekly') next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

// The next instant this recurrence fires, strictly after `fromMs`.
// Returns null for a spec that is not valid — the caller treats that as
// "never due" rather than guessing at what was meant.
function nextRunAt(spec, fromMs) {
  const { value } = validateRecurrence(spec);
  if (!value) return null;
  const from = new Date(Number(fromMs));
  if (Number.isNaN(from.getTime())) return null;

  let start = periodStart(value, from);
  // Two periods are enough: a slot in this one, or the first of the next.
  for (let period = 0; period < 2; period += 1) {
    const end = nextPeriodStart(value, start);
    const span = end.getTime() - start.getTime();
    const step = span / value.every;
    for (let k = 0; k < value.every; k += 1) {
      const slot = start.getTime() + Math.round(k * step);
      if (slot > from.getTime()) return slot;
    }
    start = end;
  }
  return null;
}

// Validation lives here beside the maths so the two can never disagree about
// what a recurrence is. `src/validation/recurrenceValidation.js` re-exports it
// for the HTTP layer (and for the validation gate to sweep).
function validateRecurrence(raw) {
  const errors = {};
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = {};

  const period = String(input.period || '');
  if (!PERIODS.includes(period)) {
    errors.period = `period must be one of: ${PERIODS.join(', ')}`;
    return { errors };
  }
  value.period = period;

  const every = Number(input.every === undefined || input.every === null ? 1 : input.every);
  if (!Number.isInteger(every) || every < 1 || every > MAX_EVERY) {
    errors.every = `every must be an integer between 1 and ${MAX_EVERY}`;
  } else {
    value.every = every;
  }

  if (period === 'hourly') {
    // The hour is the period; a time of day would contradict it.
    value.at = null;
  } else {
    const at = parseAt(input.at);
    if (!at) errors.at = 'at must be a time of day as HH:MM';
    else value.at = `${String(at.h).padStart(2, '0')}:${String(at.m).padStart(2, '0')}`;
  }

  if (period === 'weekly') {
    const wd = Number(input.weekday);
    if (!Number.isInteger(wd) || wd < 1 || wd > 7) errors.weekday = 'weekday must be 1 (Monday) to 7 (Sunday)';
    else value.weekday = wd;
  }

  if (period === 'monthly') {
    // Capped at 28 so every month has the day — a "the 31st" schedule that
    // skips February is a bug report, not a schedule.
    const dom = Number(input.dayOfMonth);
    if (!Number.isInteger(dom) || dom < 1 || dom > 28) errors.dayOfMonth = 'dayOfMonth must be between 1 and 28';
    else value.dayOfMonth = dom;
  }

  if (!errors.every && nominalSpacingMs(value) < MIN_SPACING_MS) {
    errors.every = `every is too frequent — runs must be at least ${MIN_SPACING_MS / 60000} minutes apart`;
  }

  return Object.keys(errors).length ? { errors } : { value };
}

module.exports = {
  PERIODS,
  MIN_SPACING_MS,
  MAX_EVERY,
  validateRecurrence,
  nextRunAt,
  nominalSpacingMs,
};
