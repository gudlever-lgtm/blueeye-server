'use strict';

const crypto = require('crypto');
const { Severity, FindingKind } = require('./constants');
const { MAD_TO_SIGMA } = require('./baselines');
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

  const { critSigma, warnSigma, baselineDays, minSamples } = config;

  function evaluate(sample) {
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

    // 2) Robust z-score (sigmas) from the baseline. The 1e-9 floor avoids a
    //    divide-by-zero when MAD is 0 (very stable metric).
    const sigma = baseline.mad * MAD_TO_SIGMA || 1e-9;
    const dev = (sample.value - baseline.median) / sigma;

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
          'Metric uændret i 10 på hinanden følgende intervaller — muligt sensor- eller agentstop',
      };
    }

    // 4) Severity from the deviation. Below warnSigma it's normal: learn + null.
    const absDev = Math.abs(dev);
    let severity = null;
    if (absDev >= critSigma) severity = Severity.CRIT;
    else if (absDev >= warnSigma) severity = Severity.WARN;

    if (!severity) {
      baselines.update(sample);
      return null;
    }

    // 5) Build the anomaly finding with a concrete Danish explanation (real
    //    numbers, no placeholders), then 6) always update the baseline.
    const finding = {
      ...base,
      severity,
      kind: FindingKind.ANOMALY,
      deviation: dev,
      explanation:
        `${sample.metric} på ${sample.value} afveg ${dev.toFixed(1)}σ ` +
        `fra ${baselineDays}-dages baseline (${baseline.median})`,
    };
    baselines.update(sample);
    return finding;
  }

  return { evaluate };
}

module.exports = { createDetector, DEFAULT_INTERVAL_MS };
