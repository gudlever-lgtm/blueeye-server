'use strict';

const { median, mad, MAD_TO_SIGMA } = require('./baselines');
const { Severity } = require('./constants');

// Pure per-flow-pair volume baselining. Extends per-metric anomaly detection to
// per-(src_host, dst_host, dst_port), REUSING the existing median/MAD robust
// statistics (src/analysis/baselines.js) — no new statistical code here.
//
// Baselines are day-of-week + hour-of-day aware: a bucket's volume is compared
// against prior buckets in the SAME (dow, hour) slot (Tuesday 14:00 vs prior
// Tuesdays 14:00), not a flat mean. A pair needs at least `minObservations`
// total hourly buckets before any of its slots are eligible for scoring.

const DEFAULT_MIN_OBSERVATIONS = 100;

function pairKey(r) {
  return `${r.srcHostId}|${r.dstHostId}|${r.dstPort}`;
}

// UTC day-of-week (0=Sun..6=Sat) + hour-of-day (0..23) of an hourly bucket.
function slotOf(bucket) {
  const d = bucket instanceof Date ? bucket : new Date(bucket);
  return { dow: d.getUTCDay(), hour: d.getUTCHours() };
}

// Build baselines from historical hourly rows (each { srcHostId, dstHostId,
// dstPort, bucket, bytes }). Returns one baseline row per (pair, dow, hour) for
// pairs meeting the observation gate. `observationCount` is the pair's total
// bucket count (the eligibility signal); `sampleCount` is the slot's count.
function buildPairBaselines(hourlyRows, { minObservations = DEFAULT_MIN_OBSERVATIONS } = {}) {
  const byPair = new Map();
  for (const r of Array.isArray(hourlyRows) ? hourlyRows : []) {
    if (!r || r.srcHostId == null || r.dstHostId == null || r.dstPort == null) continue;
    const k = pairKey(r);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }

  const out = [];
  for (const rows of byPair.values()) {
    const observationCount = rows.length;
    if (observationCount < minObservations) continue; // gate: not enough history yet
    const first = rows[0];
    // Group this pair's buckets by (dow, hour).
    const bySlot = new Map();
    for (const r of rows) {
      const { dow, hour } = slotOf(r.bucket);
      const sk = `${dow}|${hour}`;
      if (!bySlot.has(sk)) bySlot.set(sk, { dow, hour, values: [] });
      bySlot.get(sk).values.push(Number(r.bytes) || 0);
    }
    for (const { dow, hour, values } of bySlot.values()) {
      const med = median(values);
      const spread = mad(values, med);
      out.push({
        srcHostId: Number(first.srcHostId),
        dstHostId: Number(first.dstHostId),
        dstPort: Number(first.dstPort),
        dow,
        hour,
        medianBytes: Math.round(med),
        madBytes: Math.round(spread),
        sampleCount: values.length,
        observationCount,
      });
    }
  }
  return out;
}

// Robust z-score of an observed volume against a stored {medianBytes, madBytes}.
// Identical scaling to the live detector (value - median) / (mad * MAD_TO_SIGMA),
// with the same zero-MAD guard so a perfectly flat baseline can't divide by zero
// (a flat series where observed == median scores 0 → no deviation).
function zScore(baseline, observed) {
  if (!baseline) return null;
  const sigma = (Number(baseline.madBytes) || 0) * MAD_TO_SIGMA || 1e-9;
  return (Number(observed) - Number(baseline.medianBytes)) / sigma;
}

// Classify a z-score into a severity given sigma thresholds, or null if within
// the normal band (no anomaly). Deviation only — no threat labelling.
function classify(z, { warnSigma = 3, critSigma = 4 } = {}) {
  if (z == null || !Number.isFinite(z)) return null;
  const a = Math.abs(z);
  if (a >= critSigma) return Severity.CRIT;
  if (a >= warnSigma) return Severity.WARN;
  return null;
}

module.exports = { buildPairBaselines, zScore, classify, slotOf, pairKey, DEFAULT_MIN_OBSERVATIONS };
