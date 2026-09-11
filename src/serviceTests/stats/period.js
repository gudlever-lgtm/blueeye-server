'use strict';

// Period maths for the run-history charts: "this week", "March", "2026" — and
// the buckets a period is drawn in.
//
// Pure and self-contained (no Date library, repo convention), and the ONLY place
// that decides what a period means. The repository groups rows with the same
// bucket keys this module produces, and the API hands the client the previous
// and next period so the dashboard never re-derives any of it.
//
// Time zones: everything a person means by "today" is local. The database stores
// UTC, so a period is resolved in the viewer's wall clock — `offsetMinutes` is
// exactly what `new Date().getTimezoneOffset()` returns (minutes BEHIND UTC, so
// UTC+2 is -120) — and converted back to UTC for the query. Bucketing in UTC
// would put the first two hours of a Copenhagen day in the previous one.

const PERIODS = ['day', 'week', 'month', 'year'];

// One bucket per period, chosen so a chart has enough bars to show a shape and
// few enough to read: a day in hours, a week and a month in days, a year in
// months.
const BUCKET_FOR = { day: 'hour', week: 'day', month: 'day', year: 'month' };

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function isPeriod(value) { return PERIODS.includes(value); }

function pad(n, width = 2) { return String(n).padStart(width, '0'); }

// A Date shifted into the viewer's wall clock, so the getUTC* accessors read
// local fields. The server's own timezone never enters into it.
function toLocal(date, offsetMinutes) { return new Date(date.getTime() - offsetMinutes * MINUTE); }
function toUtc(local, offsetMinutes) { return new Date(local.getTime() + offsetMinutes * MINUTE); }

// The bucket key for a local instant — the same string the SQL DATE_FORMAT
// produces, so rows and empty buckets merge by equality.
function bucketKey(local, bucket) {
  const y = local.getUTCFullYear();
  const m = pad(local.getUTCMonth() + 1);
  const d = pad(local.getUTCDate());
  if (bucket === 'hour') return `${y}-${m}-${d} ${pad(local.getUTCHours())}:00`;
  if (bucket === 'month') return `${y}-${m}-01 00:00`;
  return `${y}-${m}-${d} 00:00`;
}

// MySQL's format string for the same key. Paired with bucketKey above: change
// one and the other must follow, which is why they live side by side.
function sqlFormat(bucket) {
  if (bucket === 'hour') return '%Y-%m-%d %H:00';
  if (bucket === 'month') return '%Y-%m-01 00:00';
  return '%Y-%m-%d 00:00';
}

// `at` is any date inside the wanted period, as YYYY-MM-DD. Anything else (a
// typo, a missing value) falls back to today rather than throwing — this is a
// chart, and a chart with no data beats an error page.
function parseAt(at, offsetMinutes, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(at || ''));
  if (!m) return toLocal(now, offsetMinutes);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(date.getTime()) ? toLocal(now, offsetMinutes) : date;
}

function localDateString(local) {
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}

// Monday, following ISO-8601 — the week a Danish or German operator means.
function startOfWeek(local) {
  const day = (local.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day));
}

function startOfPeriod(local, period) {
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  if (period === 'day') return new Date(Date.UTC(y, m, d));
  if (period === 'week') return startOfWeek(local);
  if (period === 'month') return new Date(Date.UTC(y, m, 1));
  return new Date(Date.UTC(y, 0, 1));
}

function shiftPeriod(startLocal, period, by) {
  const y = startLocal.getUTCFullYear();
  const m = startLocal.getUTCMonth();
  const d = startLocal.getUTCDate();
  if (period === 'day') return new Date(Date.UTC(y, m, d + by));
  if (period === 'week') return new Date(Date.UTC(y, m, d + 7 * by));
  if (period === 'month') return new Date(Date.UTC(y, m + by, 1));
  return new Date(Date.UTC(y + by, 0, 1));
}

// Every bucket start inside the period, in order. Built by CALENDAR arithmetic,
// not by adding a fixed number of milliseconds: a month is not 30 days and a DST
// day is not 24 hours, and a chart that silently drops or repeats a bar on the
// last Sunday of October is worse than no chart.
function bucketStarts(startLocal, endLocal, bucket) {
  const starts = [];
  let cursor = startLocal;
  let guard = 0;
  while (cursor < endLocal && guard < 1000) {
    starts.push(cursor);
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const d = cursor.getUTCDate();
    if (bucket === 'hour') cursor = new Date(cursor.getTime() + HOUR);
    else if (bucket === 'month') cursor = new Date(Date.UTC(y, m + 1, 1));
    else cursor = new Date(Date.UTC(y, m, d + 1));
    guard += 1;
  }
  return starts;
}

// Resolves everything the API and the chart need from (period, at, offset):
// the UTC window to query, the bucket shape, every bucket in the period
// (including the empty ones), and where "previous" and "next" point.
function resolvePeriod({ period = 'week', at = null, offsetMinutes = 0, now = new Date() } = {}) {
  const chosen = isPeriod(period) ? period : 'week';
  const offset = Number.isFinite(Number(offsetMinutes)) ? Math.max(-1440, Math.min(1440, Number(offsetMinutes))) : 0;
  const bucket = BUCKET_FOR[chosen];

  const anchor = parseAt(at, offset, now);
  const startLocal = startOfPeriod(anchor, chosen);
  const endLocal = shiftPeriod(startLocal, chosen, 1);

  const starts = bucketStarts(startLocal, endLocal, bucket);
  const nowLocal = toLocal(now, offset);

  return {
    period: chosen,
    bucket,
    offset_minutes: offset,
    at: localDateString(startLocal),
    from: toUtc(startLocal, offset),
    to: toUtc(endLocal, offset),
    sql_format: sqlFormat(bucket),
    // Empty buckets are part of the answer: a day with no runs is a gap the
    // operator needs to see, not a bar the chart quietly leaves out.
    buckets: starts.map((s) => ({ key: bucketKey(s, bucket), start: s.toISOString() })),
    prev_at: localDateString(shiftPeriod(startLocal, chosen, -1)),
    next_at: localDateString(shiftPeriod(startLocal, chosen, 1)),
    // A period that has not happened yet is not offered — "next" stops at the
    // one containing today.
    has_next: shiftPeriod(startLocal, chosen, 1) <= startOfPeriod(nowLocal, chosen),
    is_current: startLocal.getTime() === startOfPeriod(nowLocal, chosen).getTime(),
  };
}

module.exports = { resolvePeriod, bucketKey, sqlFormat, isPeriod, PERIODS, BUCKET_FOR, DAY };
