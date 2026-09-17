'use strict';

const crypto = require('crypto');
const { Severity, FindingKind } = require('./constants');
const { sigmaFromMad } = require('./baselines');
const { loadConfig } = require('./config');

const DEFAULT_INTERVAL_MS = 60000; // window width when none is supplied

// Robust anomaly/flatline detector over the baseline store. evaluate(sample)
// returns a Finding or null and never throws on normal data — only ever returns
// a Finding or null.
//
//   const detector = createDetector({ baselines, config, intervalMs });
//   const finding = detector.evaluate(sample);
function createDetector({ baselines, config = loadConfig(), intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (!baselines) throw new Error('createDetector requires a baseline store');

  function evaluate(sample) {
    // Thresholds are read per-call so runtime edits (Settings → Analysis)
    // take effect without a restart.
    const { critSigma, warnSigma, baselineDays, minSamples } = config;
    // Defensive: ignore anything that isn't a usable numeric sample.
    if (!sample || typeof sample.value !== 'number' || Number.isNaN(sample.value)) {
      return null;
    }
    const ts = sample.ts instanceof Date ? sample.ts : new Date(sample.ts);
    const bucket = baselines.bucket(ts);
    const baseline = baselines.get(sample.hostId, sample.metric, bucket);

    // 1) Warm-up: no baseline yet (or too few samples) — learn and emit nothing.
    if (!baseline || baseline.n < minSamples) {
      baselines.update(sample);
      return null;
    }

    // 2) Robust z-score (sigmas) from the baseline. `sigma` is null when the
    //    window holds no scale at all — every sample identical. That is NOT a
    //    tiny spread, and the old `|| 1e-9` floor turned it into one: an
    //    ordinary change against a flat window scored ~1e9 sigmas and cleared
    //    every threshold. A metric with no scale is handled by the flatline
    //    branch below (that is exactly what a constant metric is); anything
    //    reaching step 4 without a sigma has nothing quantifiable to report.
    const sigma = baseline.sigma !== undefined ? baseline.sigma : sigmaFromMad(baseline.mad);
    const dev = sigma == null ? null : (sample.value - baseline.median) / sigma;

    const window = [new Date(ts.getTime() - intervalMs), ts];
    const base = {
      id: crypto.randomUUID(),
      hostId: sample.hostId,
      metric: sample.metric,
      observed: sample.value,
      baseline: baseline.median,
      window,
      evidence: [sample],
      correlatedWith: [],
      createdAt: new Date(),
      acked: false,
    };

    // 3) Flatline: the metric stopped changing — likely a stalled sensor/agent.
    if (baselines.isFlat(sample.hostId, sample.metric)) {
      baselines.update(sample);
      return {
        ...base,
        severity: Severity.WARN,
        kind: FindingKind.FLATLINE,
        deviation: 0,
        explanation:
          'Metric unchanged across 10 consecutive intervals — possible sensor or agent stop',
      };
    }

    // 4) Severity from the deviation. Below warnSigma it's normal: learn + null.
    //    No sigma means no deviation can be stated, so there is nothing to
    //    classify — the constant series it describes was already answered by
    //    the flatline branch.
    if (dev == null) { baselines.update(sample); return null; }
    const absDev = Math.abs(dev);
    let severity = null;
    if (absDev >= critSigma) severity = Severity.CRIT;
    else if (absDev >= warnSigma) severity = Severity.WARN;

    if (!severity) {
      baselines.update(sample);
      return null;
    }

    // 5) Build the anomaly finding with a concrete explanation (real
    //    numbers, no placeholders), then 6) always update the baseline.
    const finding = {
      ...base,
      severity,
      kind: FindingKind.ANOMALY,
      deviation: dev,
      explanation:
        `${sample.metric} at ${sample.value} deviated ${dev.toFixed(1)}σ ` +
        `from ${baselineDays}-day baseline (${baseline.median})`,
    };
    baselines.update(sample);
    return finding;
  }

  return { evaluate };
}

module.exports = { createDetector, DEFAULT_INTERVAL_MS };
