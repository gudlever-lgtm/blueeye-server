'use strict';

const { numOrNull } = require('../storage/shape');

// Performance baselines (V2 §9, P2 #8).
//
//     Normal:  0.8–1.5 s
//     Current: 4.7 s
//     WARNING · slower than this test's own normal
//
// Performance is METADATA on a result, not a separate system. There is no new
// measurement here: the runner already times every step and every run, and this
// file only says what those numbers mean by comparing them with the same test's
// own history.
//
// Median + MAD, like every other statistic in BlueEyes (CLAUDE.md: robust
// statistics, no ML, everything explainable). A mean and a standard deviation
// would let one 30-second timeout drag the "normal" band up until nothing ever
// looks slow again — which is the failure mode of every naive latency alarm.
//
// PURE: durations in, a verdict out. No database, no clock.

// Below this there is no baseline worth reporting. Three runs is not a normal,
// it is three runs, and a band drawn through them would be noise with a label.
const MIN_SAMPLES = 5;

// How many MADs away counts as outside normal. 3 is deliberately wide: a
// synthetic journey drives a real browser over a real network, and a band that
// fires on ordinary variance trains people to ignore it.
const K = 3;

// The floor under the band's width. Without it, a test that is consistently
// 400 ms ±2 ms gets a band of 394–406 and screams at 420 — a difference no
// human would notice and no user would feel.
const MIN_SPREAD_MS = 250;

// A run must ALSO be this much slower in relative terms. 250 ms on a 200 ms
// test is a real change; 250 ms on a 30-second journey is nothing.
const MIN_RATIO = 1.25;

// Takes an ALREADY SORTED array. Exported, so it is called by things this file
// does not control, and `sorted.length` on a null throws — which loses the page
// rather than the statistic.
function median(sorted) {
  const list = Array.isArray(sorted) ? sorted : [];
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

// The baseline this test's own successful runs describe.
//
//   baselineFrom([820, 910, 870, ...]) -> { median, mad, low, high, samples }
//
// Null when there is not enough history. Null is the honest answer, and the
// caller must not turn it into "normal".
function baselineFrom(durations, rawOptions = {}) {
  // A default parameter covers `undefined` and nothing else — `baselineFrom(x,
  // null)` sails past it and throws on the first property read.
  const { minSamples = MIN_SAMPLES, k = K, minSpreadMs = MIN_SPREAD_MS } = (rawOptions && typeof rawOptions === 'object') ? rawOptions : {};
  // numOrNull, not Number(): an unmeasured run must not enter the baseline as a
  // zero and drag the normal band down towards "instant".
  const values = (Array.isArray(durations) ? durations : [])
    .map(numOrNull)
    .filter((n) => n !== null && n >= 0);
  if (values.length < minSamples) {
    return { median: null, mad: null, low: null, high: null, samples: values.length, enough: false };
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const med = median(sorted);
  // Median absolute deviation: the median of how far each run sits from the
  // median. One catastrophic run moves it barely at all, which is the point.
  const deviations = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = median(deviations);

  const spread = Math.max(k * mad, minSpreadMs);
  return {
    median: Math.round(med),
    mad: Math.round(mad),
    low: Math.max(0, Math.round(med - spread)),
    high: Math.round(med + spread),
    samples: values.length,
    enough: true,
  };
}

// What this run's duration means against that baseline.
//
//   { verdict: 'normal'|'slow'|'fast'|'unknown', duration_ms, baseline, ratio, reason }
//
// `slow` is a WARNING, never a failure: a slow service is not a broken one, and
// a performance signal that can fail a test would make people delete the test.
function compare(durationMs, baseline, rawOptions = {}) {
  const { lang = 'en', minRatio = MIN_RATIO } = (rawOptions && typeof rawOptions === 'object') ? rawOptions : {};
  const current = numOrNull(durationMs);
  const base = baseline || {};

  if (current === null) {
    return {
      verdict: 'unknown', duration_ms: null, baseline: base, ratio: null,
      reason: lang === 'da' ? 'Kørslen blev ikke målt.' : 'This run was not measured.',
    };
  }
  if (!base.enough || base.median === null) {
    return {
      verdict: 'unknown',
      duration_ms: current,
      baseline: base,
      ratio: null,
      reason: lang === 'da'
        ? `Der er kun ${base.samples || 0} tidligere kørsler at sammenligne med — ikke nok til at sige hvad der er normalt.`
        : `Only ${base.samples || 0} earlier runs to compare with — not enough to say what normal is.`,
    };
  }

  const ratio = base.median > 0 ? current / base.median : null;

  // Slow needs BOTH: outside the band AND materially slower. Either alone
  // produces an alarm somebody has to learn to ignore.
  if (current > base.high && (ratio === null || ratio >= minRatio)) {
    return {
      verdict: 'slow',
      duration_ms: current,
      baseline: base,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      reason: lang === 'da'
        ? `Tog ${fmt(current, 'da')}; normalt ${fmt(base.low, 'da')}–${fmt(base.high, 'da')} over ${base.samples} kørsler.`
        : `Took ${fmt(current, 'en')}; normally ${fmt(base.low, 'en')}–${fmt(base.high, 'en')} across ${base.samples} runs.`,
    };
  }

  // Faster than normal is reported too, and is NOT good news by default: a run
  // that suddenly finishes in a fifth of the usual time is often a page that
  // stopped loading something, or an assertion that stopped being reached.
  if (current < base.low) {
    return {
      verdict: 'fast',
      duration_ms: current,
      baseline: base,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      reason: lang === 'da'
        ? `Tog ${fmt(current, 'da')}, hurtigere end normalt (${fmt(base.low, 'da')}–${fmt(base.high, 'da')}). Værd at se på: en side der holdt op med at indlæse noget ser også sådan ud.`
        : `Took ${fmt(current, 'en')}, faster than normal (${fmt(base.low, 'en')}–${fmt(base.high, 'en')}). Worth a look: a page that stopped loading something looks like this too.`,
    };
  }

  return {
    verdict: 'normal',
    duration_ms: current,
    baseline: base,
    ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
    reason: lang === 'da'
      ? `Tog ${fmt(current, 'da')}, inden for det normale (${fmt(base.low, 'da')}–${fmt(base.high, 'da')}).`
      : `Took ${fmt(current, 'en')}, within normal (${fmt(base.low, 'en')}–${fmt(base.high, 'en')}).`,
  };
}

// Seconds when it reads better as seconds, which is almost always: "4.7 s" is a
// duration a person feels, "4703 ms" is a number they have to convert.
function fmt(ms, lang = 'en') {
  const n = numOrNull(ms);
  if (n === null) return lang === 'da' ? 'ukendt' : 'unknown';
  if (n < 1000) return `${Math.round(n)} ms`;
  const seconds = n / 1000;
  const text = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return lang === 'da' ? `${text.replace('.', ',')} s` : `${text} s`;
}

// Per-step baselines, from the same history. A journey that got slower is worth
// knowing; WHICH step got slower is what someone can act on.
//
//   stepBaselines([{ position, label, duration_ms }, ...] per run) -> Map
//
// Keyed by position AND type, so a reordered test compares like with like rather
// than comparing step 3 against whatever used to be third.
function stepBaselines(runsSteps, options = {}) {
  const byKey = new Map();
  for (const steps of (Array.isArray(runsSteps) ? runsSteps : [])) {
    for (const step of (Array.isArray(steps) ? steps : [])) {
      if (!step || step.status !== 'pass') continue;
      const key = `${step.position}:${step.step_type || ''}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(step.duration_ms);
    }
  }
  const out = new Map();
  for (const [key, durations] of byKey) out.set(key, baselineFrom(durations, options));
  return out;
}

module.exports = {
  baselineFrom, compare, stepBaselines, fmt, median,
  MIN_SAMPLES, K, MIN_SPREAD_MS, MIN_RATIO,
};
