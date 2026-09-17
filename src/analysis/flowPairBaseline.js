'use strict';

const { median, mad, sigmaFromMad } = require('./baselines');
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

// Robust z-score of an observed volume against a stored {medianBytes, madBytes},
// or NULL when the slot's baseline carries no scale (madBytes 0).
//
// The zero-MAD guard used to be `|| 1e-9`, and the comment claimed it was safe
// because "a flat series where observed == median scores 0". That is the only
// case it was safe for. The moment the observation DIFFERED, the division by
// 1e-9 produced the byte difference times 10^9:
//
//   Flow 4->9:443 volume 0B deviated -92845056000000000.0σ from its 92845056B
//   baseline for this weekday/hour
//
// — a CRIT on every constant pair that changed at all, carrying a number that
// measures nothing but the floor constant. A slot whose samples are identical
// has no robust scale, so there is no deviation to state; sigmaFromMad returns
// null and the pair is not scored this hour.
//
// This does mean a perfectly constant pair no longer raises a volume anomaly.
// It never raised a meaningful one: it raised a CRIT whose magnitude was an
// artifact. Detecting "a constant link changed" needs a rule of its own
// (a ratio against the median), not a sigma that cannot be computed.
function zScore(baseline, observed) {
  if (!baseline) return null;
  const sigma = sigmaFromMad(baseline.madBytes);
  if (sigma == null) return null;
  return (Number(observed) - Number(baseline.medianBytes)) / sigma;
}

// Defaults for the no-scale path below. A flat slot is violated by a change that
// is both ABSOLUTELY worth mentioning (past the byte floor, so 100B -> 140B on a
// near-idle pair is not an incident) and RELATIVELY large against the median.
const FLAT_MIN_BYTES = 1024;
const FLAT_WARN_RATIO = 2;   // double (or half) the baseline
const FLAT_CRIT_RATIO = 10;  // an order of magnitude

// Score an observation against its slot baseline, by whichever basis the
// baseline can actually support.
//
//   basis 'sigma' — the slot varied, so a robust z-score means something.
//   basis 'ratio' — the slot's samples were identical, so there is NO sigma.
//                   A change is still worth flagging (a pair that has sent
//                   exactly 100B every Tuesday at 14:00 and suddenly sends
//                   100000B is the case this job exists for), but it is stated
//                   as a multiple of the baseline, which is a fact about the
//                   data, rather than as a sigma the data cannot support.
//
// Returns { severity, z, ratio, basis }; severity null means "within normal".
function scoreDeviation(baseline, observed, opts = {}) {
  const none = { severity: null, z: null, ratio: null, basis: null };
  if (!baseline) return none;
  const {
    warnSigma = 3, critSigma = 4,
    flatMinBytes = FLAT_MIN_BYTES,
    flatWarnRatio = FLAT_WARN_RATIO,
    flatCritRatio = FLAT_CRIT_RATIO,
  } = opts;

  const z = zScore(baseline, observed);
  if (z != null) {
    return { severity: classify(z, { warnSigma, critSigma }), z, ratio: null, basis: 'sigma' };
  }

  const med = Number(baseline.medianBytes) || 0;
  const delta = (Number(observed) || 0) - med;
  if (delta === 0) return none;
  const absDelta = Math.abs(delta);
  if (absDelta < flatMinBytes) return none;
  // A median of 0 means the pair normally sends nothing at all, so any traffic
  // past the floor is a whole new flow rather than a multiple of anything.
  const ratio = med > 0 ? absDelta / med : Infinity;
  let severity = null;
  if (ratio >= flatCritRatio) severity = Severity.CRIT;
  else if (ratio >= flatWarnRatio) severity = Severity.WARN;
  return { severity, z: null, ratio, basis: 'ratio' };
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

module.exports = {
  buildPairBaselines, zScore, scoreDeviation, classify, slotOf, pairKey,
  DEFAULT_MIN_OBSERVATIONS, FLAT_MIN_BYTES, FLAT_WARN_RATIO, FLAT_CRIT_RATIO,
};
