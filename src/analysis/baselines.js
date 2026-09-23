'use strict';

// Local, explainable baselines — no ML libraries. For each
// `${hostId}|${metric}|${bucket}` key we keep a rolling window of the last N
// values and derive a robust centre (median) and spread (MAD). Buckets split by
// UTC hour so day/night rhythms don't pollute each other.
//
// Persistence mirrors the license cache pattern: an injected `store` with
// read()/write() (a file store in production, in-memory in tests) so warmed-up
// baselines survive a restart.

// Median of a numeric array (true median: sort + middle value/average of two).
function median(arr) {
  const n = arr.length;
  if (n === 0) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Median Absolute Deviation around a given median.
function mad(arr, med) {
  if (arr.length === 0) return NaN;
  const m = med === undefined ? median(arr) : med;
  const absDevs = arr.map((v) => Math.abs(v - m));
  return median(absDevs);
}

// 1.4826 makes MAD a consistent estimator of the standard deviation for
// normally distributed data. Exposed for the detector's z-score.
const MAD_TO_SIGMA = 1.4826;

// Mean absolute deviation around the median. A coarser scale than MAD, used
// only when MAD is 0: MAD is a median of absolute deviations, so it reads 0 the
// moment more than half the samples are identical — [5,5,5,5,9] has MAD 0 even
// though the series plainly varies. The mean keeps a usable scale there.
function meanAbsDev(arr, med) {
  if (!arr.length) return NaN;
  const m = med === undefined ? median(arr) : med;
  return arr.reduce((sum, v) => sum + Math.abs(v - m), 0) / arr.length;
}

// The robust scale a z-score divides by, or NULL when the samples carry no
// scale at all (every one of them identical).
//
// This used to be `mad * MAD_TO_SIGMA || 1e-9`, in both detectors. The floor
// was meant to avoid a divide-by-zero, and it does — by fabricating a sigma a
// billion times smaller than a byte. A flow pair whose baseline slot happened
// to be flat then scored its ordinary hourly change as
//
//   (0 - 92845056) / 1e-9  =  -92845056000000000 σ
//
// which the dashboard printed verbatim and which cleared any crit threshold by
// sixteen orders of magnitude. Every constant pair that changed AT ALL became a
// CRIT, and the number in it was the byte difference times 10^9 — an artifact of
// the floor constant, not a measurement.
//
// A zero MAD does not mean "an infinitesimally small spread". It means the
// robust scale is UNDEFINED, and nothing true can be said in sigmas. So: fall
// back to the mean absolute deviation, which recovers a scale whenever the
// samples are not all identical, and return null when they are — a caller that
// cannot get a scale must say so rather than divide by a constant.
function robustSigma(values, med) {
  if (!Array.isArray(values) || !values.length) return null;
  const m = med === undefined ? median(values) : med;
  const byMad = mad(values, m) * MAD_TO_SIGMA;
  if (Number.isFinite(byMad) && byMad > 0) return byMad;
  const byMean = meanAbsDev(values, m) * MAD_TO_SIGMA;
  if (Number.isFinite(byMean) && byMean > 0) return byMean;
  return null; // every sample identical: no scale exists
}

// The same decision for a baseline that stored only its median and MAD (the
// per-pair baselines persist a summary, not the window). Without the samples
// there is no mean-absolute-deviation fallback, so a zero MAD is terminal.
function sigmaFromMad(madValue) {
  const sigma = (Number(madValue) || 0) * MAD_TO_SIGMA;
  return Number.isFinite(sigma) && sigma > 0 ? sigma : null;
}

const DEFAULT_WINDOW = 200;
const DEFAULT_MIN_SAMPLES = 200;
const FLAT_RUN = 10; // identical trailing values that count as "flat"

function keyOf(hostId, metric, bucket) {
  return `${hostId}|${metric}|${bucket}`;
}

// Builds a baseline store. `store` (optional) persists the raw windows so the
// median/MAD can be recomputed after a restart. When `persistIntervalMs` > 0,
// persistence is debounced onto a timer (and update() only marks the windows
// dirty) so disk I/O never runs on the per-sample ingest path; the default of 0
// persists synchronously on every update (used by tests and the in-memory store).
function createBaselineStore({
  store = null,
  windowSize = DEFAULT_WINDOW,
  minSamples = DEFAULT_MIN_SAMPLES,
  persistIntervalMs = 0,
} = {}) {
  /** @type {Map<string, number[]>} key -> rolling window of recent values */
  const windows = new Map();
  const canPersist = Boolean(store && typeof store.write === 'function');
  let dirty = false;
  let flushTimer = null;

  // Load any persisted windows on construction.
  if (store && typeof store.read === 'function') {
    const data = store.read();
    if (data && typeof data === 'object') {
      for (const [k, vals] of Object.entries(data)) {
        if (Array.isArray(vals)) windows.set(k, vals.filter((v) => typeof v === 'number').slice(-windowSize));
      }
    }
  }

  // UTC hour of day (0–23) — the bucket a sample belongs to.
  function bucket(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.getUTCHours();
  }

  function persist() {
    if (!canPersist) return;
    dirty = false;
    store.write(Object.fromEntries(windows));
  }

  // Debounced flush: serialize + write only when something changed, at most
  // once per interval. The timer is unref'd so it never holds the process open.
  if (canPersist && persistIntervalMs > 0) {
    flushTimer = setInterval(() => {
      if (dirty) persist();
    }, persistIntervalMs);
    flushTimer.unref();
  }

  // Stops the flush timer and writes a final snapshot (synchronously when the
  // store supports it) so a warmed-up baseline survives a graceful shutdown.
  function stop() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (canPersist && dirty) {
      if (typeof store.flushSync === 'function') {
        dirty = false;
        store.flushSync(Object.fromEntries(windows));
      } else {
        persist();
      }
    }
  }

  // Adds a sample's value to its window (capped at windowSize) and persists. When
  // debounced persistence is active, this only marks the windows dirty.
  function update(sample) {
    if (!sample || typeof sample.value !== 'number' || Number.isNaN(sample.value)) return;
    const key = keyOf(sample.hostId, sample.metric, bucket(sample.ts));
    let win = windows.get(key);
    if (!win) { win = []; windows.set(key, win); }
    win.push(sample.value);
    if (win.length > windowSize) win.splice(0, win.length - windowSize);
    if (flushTimer) dirty = true;
    else persist();
  }

  // Returns { n, median, mad, sigma } for a key, or null until minSamples is
  // reached. `sigma` is the scale a z-score divides by — null when the window
  // carries no scale at all, which a caller must handle rather than falling back
  // to a constant (see robustSigma).
  function get(hostId, metric, b) {
    const win = windows.get(keyOf(hostId, metric, b));
    if (!win || win.length < minSamples) return null;
    const med = median(win);
    return { n: win.length, median: med, mad: mad(win, med), sigma: robustSigma(win, med) };
  }

  // True when the most recent FLAT_RUN values are identical for any of a
  // host/metric's buckets — a sensor/agent stall indicator (the metric stopped
  // changing). Checking per bucket keeps the values time-ordered.
  //
  // `value` (optional) is the sample being judged. When it is given, the run
  // only counts as flat if that sample CONTINUES it: a value that differs from
  // the run is the metric changing, which is the opposite of a stall. Looking
  // at history alone called the first real error on a zero counter a flatline
  // and hid it for one whole interval.
  function isFlat(hostId, metric, value) {
    for (const [k, win] of windows) {
      const [h, m] = k.split('|');
      if (h !== hostId || m !== metric) continue;
      if (win.length >= FLAT_RUN) {
        const tail = win.slice(-FLAT_RUN);
        if (!tail.every((v) => v === tail[0])) continue;
        if (value === undefined || value === tail[0]) return true;
      }
    }
    return false;
  }

  return { bucket, update, get, isFlat, persist, stop, _windows: windows };
}

module.exports = {
  createBaselineStore,
  median,
  mad,
  meanAbsDev,
  robustSigma,
  sigmaFromMad,
  MAD_TO_SIGMA,
  FLAT_RUN,
  DEFAULT_WINDOW,
  DEFAULT_MIN_SAMPLES,
};
