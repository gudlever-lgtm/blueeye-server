'use strict';

// Interface capacity forecasting — "when does this link run out of room?"
//
// src/analysis/forecast.js had the whole engine (robust Theil–Sen trend +
// days-to-capacity) and POST /api/forecast exposed it, but nothing in the
// product ever called either: the endpoint takes a series the CALLER has to
// supply, and no caller existed. A capacity forecast nobody can reach is not a
// feature.
//
// This is the part that was missing: somewhere to get the series and the
// ceiling from. Both already exist and neither needs new storage.
//
//   the series   every agent result carries per-interface rx/txBytesPerSec, and
//                `results` keeps them for the retention window.
//   the ceiling  the interface's own negotiated link speed (`speedMbps`), which
//                the agent reports alongside. A 1 Gbit port is full at 1 Gbit —
//                that is a real ceiling, not a number an operator had to invent
//                in a settings screen.
//
// So the projection is on utilisation percent against 100, and "days until
// capacity" means days until the link saturates at the current trend.
//
// Deliberately NOT included: a forecast for interfaces with no speedMbps (an
// SNMP device that does not report it, most virtual ports). A projection with
// no ceiling can still show a trend, and it does — it just reports
// daysUntilCapacity: null rather than inventing a limit.

const { forecast, MIN_POINTS } = require('./forecast');
const { computeInterfaceHealth } = require('../health/interfaceHealth');
const { numOrNull } = require('../lib/num');

// Utilisation is a percentage, so the ceiling is the same for every link
// regardless of its speed. That is the whole reason to forecast the percentage
// rather than the byte rate.
const CAPACITY_PCT = 100;

// How far back to read, and the cap on rows pulled per agent. A result arrives
// roughly once a minute, so 14 days is ~20k rows — enough for a trend that
// survives a busy Tuesday, bounded enough not to be a table scan.
const DEFAULT_WINDOW_DAYS = 14;
const MAX_ROWS = 20000;

// Theil–Sen is O(n²) in the number of points, so the series is downsampled to
// this many buckets before fitting. 14 days of hourly buckets is 336; 400 keeps
// a whole window of hourly detail with room to spare, and caps the fit at
// ~80k slope computations, which is milliseconds.
const MAX_FIT_POINTS = 400;

// Reduces a series to at most `max` points by averaging within equal-width time
// buckets. Averaging (not sampling) is deliberate: utilisation is spiky, and
// picking every Nth point would make the trend depend on which minute happened
// to be sampled. It also smooths the sub-hour noise the trend should ignore.
function downsample(points, max = MAX_FIT_POINTS) {
  if (points.length <= max) return points;
  const first = points[0].t;
  const last = points[points.length - 1].t;
  const span = last - first;
  if (span <= 0) return points.slice(-max);
  const width = span / max;
  const buckets = new Map();
  for (const p of points) {
    const k = Math.min(max - 1, Math.floor((p.t - first) / width));
    const b = buckets.get(k);
    if (b) { b.sum += p.v; b.n += 1; b.tSum += p.t; } else { buckets.set(k, { sum: p.v, n: 1, tSum: p.t }); }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => ({ t: Math.round(b.tSum / b.n), v: b.sum / b.n }));
}

// Turns stored result rows into { iface -> [{t, v}] } of utilisation percent.
// Rows may arrive newest-first (findByAgentId orders by id DESC); the series is
// sorted by time here so callers do not have to care.
function seriesFromResults(rows) {
  const byIface = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = row && row.created_at;
    const t = at instanceof Date ? at.getTime() : Date.parse(at);
    if (!Number.isFinite(t)) continue;
    const traffic = row.payload && row.payload.traffic;
    if (!traffic) continue;
    // Reuse the SAME derivation the Interfaces screen and the fleet rollup use,
    // rather than recomputing utilisation a second way. If the definition of
    // "utilisation" ever changes, the forecast changes with it.
    // NB: computeInterfaceHealth names the port `iface`, not `name`.
    for (const iface of computeInterfaceHealth(traffic)) {
      if (!iface || typeof iface.iface !== 'string') continue;
      // numOrNull, not Number(): an absent utilisation must never become 0%.
      // Zero is the GOOD end of this scale — a link at 0% is idle, and a series
      // of invented zeros would report a busy link as trending downward, which
      // is the one direction a capacity forecast must never err in. See
      // src/lib/num.js.
      const util = numOrNull(iface.utilPct);
      if (util === null) continue;
      if (!byIface.has(iface.iface)) {
        byIface.set(iface.iface, { points: [], virtual: Boolean(iface.virtual), speedMbps: iface.speedMbps ?? null });
      }
      const entry = byIface.get(iface.iface);
      entry.points.push({ t, v: util });
      // The newest row wins for the metadata: a link that was renegotiated to a
      // different speed should be described by the speed it has now.
      if (t >= (entry.latestT || 0)) { entry.latestT = t; entry.speedMbps = iface.speedMbps ?? entry.speedMbps; }
    }
  }
  for (const entry of byIface.values()) entry.points.sort((a, b) => a.t - b.t);
  return byIface;
}

// Forecasts every interface in `rows`. Returns one entry per interface, newest
// data first in the underlying series. `now` is injectable for tests.
function forecastInterfaces(rows, { horizonDays = 30, now = Date.now() } = {}) {
  const out = [];
  for (const [name, entry] of seriesFromResults(rows)) {
    const points = downsample(entry.points);
    const f = forecast(points, { capacity: CAPACITY_PCT, horizonDays, now });
    out.push({
      iface: name,
      virtual: entry.virtual,
      speedMbps: entry.speedMbps,
      samples: entry.points.length,
      ...f,
    });
  }
  // Most urgent first: links that will saturate soonest, then the rest by how
  // fast they are climbing. An operator reads the top of this list and stops.
  out.sort((a, b) => {
    const ad = a.daysUntilCapacity == null ? Infinity : a.daysUntilCapacity;
    const bd = b.daysUntilCapacity == null ? Infinity : b.daysUntilCapacity;
    if (ad !== bd) return ad - bd;
    return (b.slopePerDay || 0) - (a.slopePerDay || 0);
  });
  return out;
}

module.exports = {
  forecastInterfaces,
  seriesFromResults,
  downsample,
  CAPACITY_PCT,
  DEFAULT_WINDOW_DAYS,
  MAX_ROWS,
  MAX_FIT_POINTS,
  MIN_POINTS,
};
