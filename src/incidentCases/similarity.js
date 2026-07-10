'use strict';

// Similarity scoring for incidents — simple weighted matching, NOT ML. Given a
// target incident and a pool of past resolved/closed incidents, score each by
// how many of the matching criteria it shares and return the top N.
//
// Criteria + default weights (device match is the strongest signal):
//   device        (3) — same device (host_id)
//   deviceType    (1) — same device-type (agent platform), only when NOT the
//                       same device (so it never double-counts with `device`).
//                       There is no explicit device role/type field in the data
//                       model; platform is the closest available proxy.
//   anomalyType   (2) — same primary anomaly type (primary finding metric)
//   configChangeType (1) — both were correlated to a config change of the same
//                       risk class (high/medium/low)
//
// Ties break by most-recently-resolved, then id. Candidates with score 0 (no
// shared criteria at all) are dropped.

const DEFAULT_WEIGHTS = { device: 3, deviceType: 1, anomalyType: 2, configChangeType: 1 };

function msOf(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function scoreOne(target, cand, w) {
  const matchedOn = [];
  let score = 0;

  if (cand.hostId != null && target.hostId != null && String(cand.hostId) === String(target.hostId)) {
    score += w.device;
    matchedOn.push('device');
  } else if (cand.platform && target.platform && cand.platform === target.platform) {
    score += w.deviceType;
    matchedOn.push('deviceType');
  }

  if (cand.primaryMetric && target.primaryMetric && cand.primaryMetric === target.primaryMetric) {
    score += w.anomalyType;
    matchedOn.push('anomalyType');
  }

  if (cand.configChangeType && target.configChangeType && cand.configChangeType === target.configChangeType) {
    score += w.configChangeType;
    matchedOn.push('configChangeType');
  }

  return { score, matchedOn };
}

// Returns the top `limit` candidates by score, each annotated with { score,
// matchedOn }. The target itself (same id) is always excluded.
function scoreSimilarIncidents(target, candidates, { weights = DEFAULT_WEIGHTS, limit = 5 } = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const scored = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (target && String(c.id) === String(target.id)) continue;
    const { score, matchedOn } = scoreOne(target || {}, c, w);
    if (score <= 0) continue;
    scored.push({ ...c, score, matchedOn });
  }
  scored.sort((a, b) => b.score - a.score
    || msOf(b.resolvedAt) - msOf(a.resolvedAt)
    || (Number(b.id) - Number(a.id)));
  return scored.slice(0, Math.max(0, limit));
}

module.exports = { scoreSimilarIncidents, DEFAULT_WEIGHTS };
