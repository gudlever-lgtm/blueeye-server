'use strict';

// Capacity / trend forecasting — local + explainable, no ML, no cloud (mirrors
// the detector's robust-statistics philosophy). It fits a Theil–Sen trend (the
// median of all pairwise slopes — the robust analogue of least-squares, unmoved
// by a few outliers, just like the detector's median + MAD), projects the metric
// forward, and — given a capacity ceiling — estimates the time-to-capacity
// ("days until full"). Every result carries a plain-language explanation + the
// evidence it was derived from.

const DAY_MS = 24 * 3600 * 1000;
const MIN_POINTS = 4; // below this a "trend" is noise, not signal

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Theil–Sen slope over points [{t, v}] (t in ms): median of all pairwise slopes.
// O(n^2) — callers cap n. Returns value-units per millisecond, or null.
function theilSenSlope(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dt = points[j].t - points[i].t;
      if (dt !== 0) slopes.push((points[j].v - points[i].v) / dt);
    }
  }
  return slopes.length ? median(slopes) : null;
}

function round(n) {
  if (!Number.isFinite(n)) return n;
  return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}

// Forecast a numeric time series. `points` is [{ t, v }] where t is ms-epoch or a
// Date and v is the metric value. Options: `capacity` (ceiling for days-until),
// `horizonDays` (how far to project), `now` (clock, injectable for tests).
// Returns { ok, direction, slopePerDay, current, projected, daysUntilCapacity,
// evidence, explanation } — or { ok:false, reason } when there isn't enough data.
function forecast(points, { capacity = null, horizonDays = 30, now = Date.now() } = {}) {
  const pts = (Array.isArray(points) ? points : [])
    .map((p) => ({ t: p && p.t instanceof Date ? p.t.getTime() : Number(p && p.t), v: Number(p && p.v) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);

  if (pts.length < MIN_POINTS) {
    return {
      ok: false,
      reason: 'insufficient_data',
      samples: pts.length,
      explanation: `Not enough data to forecast (need at least ${MIN_POINTS} points, have ${pts.length}).`,
    };
  }

  const slopePerMs = theilSenSlope(pts);
  // Robust intercept: median of (v - slope·t), so one spike can't tilt the line.
  const intercept = median(pts.map((p) => p.v - slopePerMs * p.t));
  const slopePerDay = slopePerMs * DAY_MS;
  const at = (t) => intercept + slopePerMs * t;
  const current = at(now);
  const projected = at(now + horizonDays * DAY_MS);
  const direction = slopePerDay > 0 ? 'rising' : slopePerDay < 0 ? 'falling' : 'flat';

  // Time-to-capacity only when we're below the ceiling and genuinely rising.
  let daysUntilCapacity = null;
  const cap = capacity == null ? null : Number(capacity);
  if (cap != null && Number.isFinite(cap) && slopePerDay > 0 && current < cap) {
    daysUntilCapacity = (cap - current) / slopePerDay;
  }

  const evidence = {
    method: 'theil-sen',
    samples: pts.length,
    windowFrom: new Date(pts[0].t).toISOString(),
    windowTo: new Date(pts[pts.length - 1].t).toISOString(),
    slopePerDay,
    current,
  };

  let explanation = direction === 'flat'
    ? `No significant trend (robust Theil–Sen over ${pts.length} samples).`
    : `Trend ${direction} ${slopePerDay >= 0 ? '+' : ''}${round(slopePerDay)}/day (robust Theil–Sen over ${pts.length} samples).`;
  explanation += ` Projected ${round(projected)} in ${horizonDays} day(s).`;
  if (daysUntilCapacity != null) {
    explanation += ` At this rate it reaches capacity (${round(cap)}) in ~${Math.round(daysUntilCapacity)} day(s).`;
  }

  return {
    ok: true,
    direction,
    slopePerDay,
    current,
    projected,
    horizonDays,
    capacity: cap,
    daysUntilCapacity,
    evidence,
    explanation,
  };
}

module.exports = { forecast, theilSenSlope, median, MIN_POINTS };
