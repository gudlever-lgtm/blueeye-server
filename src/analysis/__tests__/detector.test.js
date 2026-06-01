'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDetector } = require('../detector');
const { createBaselineStore, MAD_TO_SIGMA } = require('../baselines');
const { Severity, FindingKind } = require('../constants');
const { loadConfig } = require('../config');

const TS = new Date('2026-01-01T03:00:00Z'); // bucket 3
const HOST = 'h1';
const METRIC = 'cpu';

// Warms a baseline store to a known median/MAD by feeding `n` values that
// alternate median±1, giving median≈M and MAD=1. Uses small minSamples so tests
// are fast.
function warmedStore({ median = 10, n = 20, minSamples = 10 } = {}) {
  const store = createBaselineStore({ minSamples, windowSize: 500 });
  for (let i = 0; i < n; i += 1) {
    store.update({ hostId: HOST, metric: METRIC, value: median + (i % 2 === 0 ? 1 : -1), ts: TS });
  }
  return store;
}

const cfg = (over = {}) => ({ ...loadConfig({}), minSamples: 10, ...over });

test('no finding during warm-up (baseline below minSamples)', () => {
  const store = createBaselineStore({ minSamples: 200, windowSize: 500 });
  const det = createDetector({ baselines: store, config: cfg({ minSamples: 200 }) });
  // First samples just warm the baseline.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(det.evaluate({ hostId: HOST, metric: METRIC, value: 10, ts: TS, labels: {} }), null);
  }
});

test('a normal value returns null', () => {
  const store = warmedStore({ median: 10 });
  const det = createDetector({ baselines: store, config: cfg() });
  // value 11 -> dev ~1σ, below warnSigma (3) -> null
  assert.equal(det.evaluate({ hostId: HOST, metric: METRIC, value: 11, ts: TS, labels: {} }), null);
});

test('a 4σ deviation yields a CRIT anomaly with evidence + explanation', () => {
  const store = warmedStore({ median: 10 }); // MAD=1 -> sigma = 1.4826
  const det = createDetector({ baselines: store, config: cfg() });
  // value = median + 5*sigma ≈ 10 + 7.41 -> ~5σ (>= critSigma 4)
  const value = 10 + 5 * MAD_TO_SIGMA;
  const f = det.evaluate({ hostId: HOST, metric: METRIC, value, ts: TS, labels: {} });
  assert.ok(f, 'expected a finding');
  assert.equal(f.severity, Severity.CRIT);
  assert.equal(f.kind, FindingKind.ANOMALY);
  assert.ok(typeof f.explanation === 'string' && f.explanation.trim().length > 0);
  assert.ok(Array.isArray(f.evidence) && f.evidence.length >= 1);
  assert.ok(Math.abs(f.deviation) >= 4);
});

test('a 3σ deviation yields a WARN anomaly', () => {
  const store = warmedStore({ median: 10 });
  const det = createDetector({ baselines: store, config: cfg() });
  const value = 10 + 3.2 * MAD_TO_SIGMA; // ~3.2σ -> WARN (>=3, <4)
  const f = det.evaluate({ hostId: HOST, metric: METRIC, value, ts: TS, labels: {} });
  assert.ok(f);
  assert.equal(f.severity, Severity.WARN);
  assert.equal(f.kind, FindingKind.ANOMALY);
});

test('a flatline yields a FLATLINE finding (WARN)', () => {
  // Warm with enough identical values that isFlat() is true and n >= minSamples.
  const store = createBaselineStore({ minSamples: 10, windowSize: 500 });
  for (let i = 0; i < 12; i += 1) store.update({ hostId: HOST, metric: METRIC, value: 42, ts: TS });
  const det = createDetector({ baselines: store, config: cfg() });
  const f = det.evaluate({ hostId: HOST, metric: METRIC, value: 42, ts: TS, labels: {} });
  assert.ok(f);
  assert.equal(f.kind, FindingKind.FLATLINE);
  assert.equal(f.severity, Severity.WARN);
  assert.match(f.explanation, /sensor- eller agentstop/);
});

test('explanation contains the actual numbers, not placeholders', () => {
  const store = warmedStore({ median: 10 });
  const det = createDetector({ baselines: store, config: cfg() });
  const value = 10 + 6 * MAD_TO_SIGMA;
  const f = det.evaluate({ hostId: HOST, metric: METRIC, value, ts: TS, labels: {} });
  assert.ok(f.explanation.includes(String(value))); // observed value present
  assert.ok(f.explanation.includes('σ')); // sigma symbol
  assert.ok(/baseline \(10\)/.test(f.explanation)); // real baseline median
  assert.ok(!/\$\{/.test(f.explanation)); // no template placeholders
});

test('evaluate never throws on odd input and ignores non-numeric samples', () => {
  const store = warmedStore({ median: 10 });
  const det = createDetector({ baselines: store, config: cfg() });
  assert.equal(det.evaluate(null), null);
  assert.equal(det.evaluate({ hostId: HOST, metric: METRIC, value: 'x', ts: TS }), null);
  assert.equal(det.evaluate({ hostId: HOST, metric: METRIC, value: NaN, ts: TS }), null);
});

test('loadConfig returns documented defaults and honours env overrides', () => {
  const d = loadConfig({});
  assert.equal(d.analysisEnabled, true);
  assert.equal(d.assistantEnabled, false);
  assert.equal(d.critSigma, 4.0);
  assert.equal(d.warnSigma, 3.0);
  assert.equal(d.baselineDays, 7);
  assert.equal(d.minSamples, 200);

  const o = loadConfig({ ANALYSIS_ENABLED: 'false', ANALYSIS_CRIT_SIGMA: '5.5', ANALYSIS_MIN_SAMPLES: '50' });
  assert.equal(o.analysisEnabled, false);
  assert.equal(o.critSigma, 5.5);
  assert.equal(o.minSamples, 50);
});
