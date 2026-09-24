'use strict';

const crypto = require('crypto');
const { Severity, FindingKind } = require('./constants');
const { sigmaFromMad } = require('./baselines');
const { loadConfig } = require('./config');
const { METRICS: DEVICE_PORT_METRICS } = require('./deviceIngest');

const DEFAULT_INTERVAL_MS = 60000; // window width when none is supplied

// WHICH METRICS MAY NOT FLATLINE.
//
// A flatline means "this number stopped changing, so whatever produces it has
// probably stopped" — true of cpu, memory, load, traffic totals: a live host
// never holds those perfectly still for ten intervals. It is false of a metric
// whose HEALTHY state is a constant. A switch port's error, discard and FCS
// rates are 0 for as long as the port is fine, its broadcast rate is 0 on a
// quiet segment, and an unused port's utilisation is 0 forever. Calling that a
// stalled sensor raised a FLATLINE warning on every sample of every healthy
// port, which is noise on exactly the ports nobody needs to look at.
//
// A flatline could not catch a stall there anyway: a device that stops
// answering produces no counter rows at all (nothing reaches the detector), and
// a frozen counter reads exactly like a healthy zero. So the rule is: the
// per-port rates from deviceIngest (METRICS — one list, so a rate added there
// is covered here) never flatline; they are judged on deviation only. Injectable as
// `flatlineExempt` for a deployment or test that wants a different rule.
const PORT_METRIC_RE = new RegExp(
  `^if\\.\\d+\\.(${DEVICE_PORT_METRICS.map(([, suffix]) => suffix.replace(/\./g, '\\.')).join('|')})$`
);
function isDevicePortMetric(metric) {
  return typeof metric === 'string' && PORT_METRIC_RE.test(metric);
}

// Robust anomaly/flatline detector over the baseline store. evaluate(sample)
// returns a Finding or null and never throws on normal data — only ever returns
// a Finding or null.
//
//   const detector = createDetector({ baselines, config, intervalMs });
//   const finding = detector.evaluate(sample);
function createDetector({
  baselines,
  config = loadConfig(),
  intervalMs = DEFAULT_INTERVAL_MS,
  flatlineExempt = isDevicePortMetric,
} = {}) {
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
    //    every threshold. A metric with no scale is handled at step 4.
    const sigma = baseline.sigma !== undefined ? baseline.sigma : sigmaFromMad(baseline.mad);
    const dev = sigma == null ? null : (sample.value - baseline.median) / sigma;

    const window = [new Date(ts.getTime() - intervalMs), ts];
    const base = {
      id: crypto.randomUUID(),
      hostId: sample.hostId,
      // Carried straight through from the sample when it has them (migration
      // 110). A sample from an agent has neither and the finding keeps the
      // shape it has always had; a sample from a switch port has both, so the
      // finding can say WHICH port rather than only which agent polled it.
      deviceId: sample.deviceId ?? null,
      interfaceId: sample.interfaceId ?? null,
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
    //    Only when THIS sample continues the flat run (a value that differs is
    //    the metric moving again, and is judged on its deviation below), and
    //    never for a metric whose healthy state is constant (see
    //    isDevicePortMetric).
    const exempt = typeof flatlineExempt === 'function' && flatlineExempt(sample.metric);
    if (!exempt && baselines.isFlat(sample.hostId, sample.metric, sample.value)) {
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
    //
    //    No sigma means every baseline sample was identical. The same value
    //    again is normal. A DIFFERENT value is a step off a constant — the
    //    first FCS error on a port that has read 0 for its whole window — and
    //    that is a real change the detector must report, but not in sigmas:
    //    the distance is finite and the scale is zero, so any sigma figure
    //    would be an artifact of whatever floor we divided by (see
    //    robustSigma). It is reported as a WARN anomaly with no deviation and
    //    the plain numbers. If the metric stays off the constant, the next
    //    sample has a scale again and is graded on it like any other.
    if (dev == null) {
      if (sample.value === baseline.median) { baselines.update(sample); return null; }
      const finding = {
        ...base,
        severity: Severity.WARN,
        kind: FindingKind.ANOMALY,
        deviation: null,
        explanation:
          `${sample.metric} at ${sample.value} left a constant ${baselineDays}-day baseline ` +
          `(${baseline.median} in all ${baseline.n} samples) — no spread to measure the change in σ`,
      };
      baselines.update(sample);
      return finding;
    }
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

module.exports = { createDetector, isDevicePortMetric, DEFAULT_INTERVAL_MS };
