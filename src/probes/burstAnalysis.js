'use strict';

const { median, mad } = require('../analysis/baselines');

// Reads a burst: 120-ish samples of one target, once a second, and says what
// SHAPE the loss has.
//
// THE NUMBERS ARE NOT THE POINT. "6.3% loss, median 1.4 ms" is a row of
// figures; a technician already knew something was wrong or they would not have
// run a burst. What they cannot see from a number is whether the loss is spread
// evenly or arrives in bursts — and that distinction is the whole diagnostic
// value:
//
//   EVEN loss, at a low rate        → congestion, a duplex mismatch, a bad
//                                     cable: something continuously wrong.
//   CLUSTERED loss, quiet between   → something PERIODIC. A spanning-tree
//                                     reconvergence, a failing link that
//                                     re-negotiates, a scheduled job, a
//                                     radio interferer. Utterly different
//                                     places to look.
//   ONE cluster at the start/end    → probably the thing being measured
//                                     starting or stopping, not the path.
//
// Pure, deterministic, and computed in code — never by a model. It uses the
// SAME median + MAD helpers as the rest of the analysis (src/analysis/
// baselines.js), because a second definition of "typical" in this codebase is a
// second thing to keep honest.

// A run shorter than this cannot support a claim about shape: two losses in six
// samples is not a pattern, it is two losses.
const MIN_SAMPLES_FOR_PATTERN = 10;

// Losses this close together are one cluster. At 1 Hz, a gap of one sample
// means "the very next second", which is plainly the same event; two is the
// widest gap that still reads as one burst rather than two.
const CLUSTER_GAP = 2;

const PATTERN = Object.freeze({
  CLEAN: 'clean',
  EVEN: 'even',
  CLUSTERED: 'clustered',
  TOTAL: 'total',
  EDGE: 'edge',
  INSUFFICIENT: 'insufficient',
});

function round(n, places = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// The p95 of a small sorted array, by nearest rank. Not interpolated: with 120
// points the difference is noise, and an integer index is one fewer thing to be
// subtly wrong.
function p95(sorted) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Groups the indexes of lost samples into runs, allowing CLUSTER_GAP between
// them. Returns [{ start, end, size }] in order.
function clusterLosses(lostIndexes, gap = CLUSTER_GAP) {
  const clusters = [];
  for (const i of lostIndexes) {
    const last = clusters[clusters.length - 1];
    if (last && i - last.end <= gap) {
      last.end = i;
      last.size += 1;
    } else {
      clusters.push({ start: i, end: i, size: 1 });
    }
  }
  return clusters;
}

// Decides the shape, and returns BOTH the verdict and the sentence that
// explains it. The sentence is the part a technician reads, so it says what the
// shape implies rather than restating the arithmetic.
function describePattern({ samples, clusters, lost, lossPct, hz }) {
  if (!lost) {
    return {
      pattern: PATTERN.CLEAN,
      explanation: `No loss in ${samples} samples. Whatever is wrong, it is not this path dropping packets right now.`,
    };
  }
  if (lost === samples) {
    return {
      pattern: PATTERN.TOTAL,
      explanation: `Every one of ${samples} samples was lost. The target did not answer at all — this is unreachable, not degraded.`,
    };
  }
  if (samples < MIN_SAMPLES_FOR_PATTERN) {
    return {
      pattern: PATTERN.INSUFFICIENT,
      explanation: `${lost} of ${samples} samples lost. Too few samples to say whether that is spread out or clustered — run a longer burst.`,
    };
  }

  const n = clusters.length;
  const spacings = [];
  for (let i = 1; i < n; i += 1) spacings.push(clusters[i].start - clusters[i - 1].start);
  // Seconds between clusters, which is what a person can act on — "every 16
  // seconds" is a lead, "every 16 samples" is a unit conversion away from one.
  const secondsBetween = spacings.length && hz ? round(median(spacings) / hz, 1) : null;

  // One cluster touching the very start or end is more likely the thing being
  // measured starting or stopping than a property of the path.
  const atEdge = n === 1 && (clusters[0].start === 0 || clusters[0].end === samples - 1);
  if (atEdge) {
    return {
      pattern: PATTERN.EDGE,
      explanation: `${lost} samples lost in one run at the ${clusters[0].start === 0 ? 'start' : 'end'} of the burst. That is often the measurement starting or stopping rather than the path — re-run it around the fault instead of across it.`,
    };
  }

  // ONE burst: a single event, whatever its size.
  if (n === 1) {
    return {
      pattern: PATTERN.CLUSTERED,
      explanation: `${lost} samples lost in a single burst, with none either side. One event, not a continuously bad path — look for something that happened once: a reconvergence, a restart, a scheduled job.`,
    };
  }

  // Several bursts, each of more than one sample: loss ARRIVES IN GROUPS, which
  // is already not congestion.
  const avgClusterSize = lost / n;
  if (avgClusterSize >= 2) {
    return {
      pattern: PATTERN.CLUSTERED,
      explanation: `${lost} samples lost in ${n} bursts, quiet in between. Loss arriving in groups is not congestion — look for something that recurs: spanning-tree reconvergence, a link renegotiating, a scheduled job, an interferer.`,
    };
  }

  // All singletons. Now the question is whether they are REGULARLY spaced.
  //
  // This is the distinction that matters and the one easiest to get wrong: five
  // isolated losses in sixty seconds are periodic only if the GAPS ARE ALIKE.
  // Random 5% loss also produces a median gap of twelve, and calling that
  // "every 12 seconds" would send somebody hunting for a scheduled job that
  // does not exist. So the test is the spread of the gaps, not their size —
  // MAD against the median, the same robust measure used everywhere else here.
  const medSpacing = spacings.length ? median(spacings) : null;
  const spacingMad = spacings.length > 1 && medSpacing ? mad(spacings, medSpacing) : null;
  const regular = n >= 3 && medSpacing > 0 && spacingMad != null && (spacingMad / medSpacing) <= 0.25;

  if (regular) {
    return {
      pattern: PATTERN.CLUSTERED,
      explanation: `${lost} single-sample losses at a regular ${secondsBetween}s interval. Regular spacing is the signature of something scheduled or cyclic — a job, a keepalive timing out, a radio duty cycle — not of a congested path.`,
    };
  }

  return {
    pattern: PATTERN.EVEN,
    explanation: `${lossPct}% loss scattered across the burst — single samples, irregularly spaced, no pattern to the gaps. That reads as something continuously wrong on the path: congestion, a duplex mismatch or a bad cable, rather than a recurring event.`,
  };
}

// Analyses one burst. `samples` is [{ t, ok, rttMs }] as the agent produced it.
// Returns the verdict the row stores and the screen shows. Never throws.
function analyseBurst(samples, { hz = 1 } = {}) {
  const rows = Array.isArray(samples) ? samples.filter((s) => s && typeof s === 'object') : [];
  const n = rows.length;

  if (!n) {
    return {
      sampleCount: 0,
      lostCount: 0,
      lossPct: null,
      medianRttMs: null,
      p95RttMs: null,
      jitterMs: null,
      lossClusters: null,
      pattern: PATTERN.INSUFFICIENT,
      explanation: 'The burst produced no samples at all.',
      clusters: [],
    };
  }

  const lostIndexes = [];
  const rtts = [];
  rows.forEach((s, i) => {
    if (s.ok) {
      if (Number.isFinite(s.rttMs)) rtts.push(s.rttMs);
    } else {
      lostIndexes.push(i);
    }
  });

  const lost = lostIndexes.length;
  const lossPct = round((lost / n) * 100);
  const sorted = [...rtts].sort((a, b) => a - b);
  const med = sorted.length ? median(sorted) : null;
  // MAD, not standard deviation: one 400 ms outlier in a 1.4 ms series would
  // dominate a deviation and say the path is unstable when it had one hiccup.
  // The same robust choice the rest of the analysis makes.
  const jitter = sorted.length > 1 ? mad(sorted, med) : null;

  const clusters = clusterLosses(lostIndexes);
  const { pattern, explanation } = describePattern({
    samples: n, clusters, lost, lossPct, hz: Number(hz) || 1,
  });

  return {
    sampleCount: n,
    lostCount: lost,
    lossPct,
    medianRttMs: round(med, 3),
    p95RttMs: round(p95(sorted), 3),
    jitterMs: round(jitter, 3),
    lossClusters: clusters.length,
    pattern,
    explanation,
    // The cluster boundaries, so the chart can shade them rather than the
    // reader having to find them in the line.
    clusters: clusters.map((c) => ({ start: c.start, end: c.end, size: c.size })),
  };
}

module.exports = {
  analyseBurst,
  clusterLosses,
  PATTERN,
  MIN_SAMPLES_FOR_PATTERN,
  CLUSTER_GAP,
};
