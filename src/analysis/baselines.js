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

const DEFAULT_WINDOW = 200;
const DEFAULT_MIN_SAMPLES = 200;
const FLAT_RUN = 10; // identical trailing values that count as "flat"

function keyOf(hostId, metric, bucket) {
  return `${hostId}|${metric}|${bucket}`;
}

// Builds a baseline store. `store` (optional) persists the raw windows so the
// median/MAD can be recomputed after a restart.
function createBaselineStore({ store = null, windowSize = DEFAULT_WINDOW, minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  /** @type {Map<string, number[]>} key -> rolling window of recent values */
  const windows = new Map();

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
    if (!store || typeof store.write !== 'function') return;
    store.write(Object.fromEntries(windows));
  }

  // Adds a sample's value to its window (capped at windowSize) and persists.
  function update(sample) {
    if (!sample || typeof sample.value !== 'number' || Number.isNaN(sample.value)) return;
    const key = keyOf(sample.hostId, sample.metric, bucket(sample.ts));
    let win = windows.get(key);
    if (!win) { win = []; windows.set(key, win); }
    win.push(sample.value);
    if (win.length > windowSize) win.splice(0, win.length - windowSize);
    persist();
  }

  // Returns { n, median, mad } for a key, or null until minSamples is reached.
  function get(hostId, metric, b) {
    const win = windows.get(keyOf(hostId, metric, b));
    if (!win || win.length < minSamples) return null;
    const med = median(win);
    return { n: win.length, median: med, mad: mad(win, med) };
  }

  // True when the most recent FLAT_RUN values are identical for any of a
  // host/metric's buckets — a sensor/agent stall indicator (the metric stopped
  // changing). Checking per bucket keeps the values time-ordered.
  function isFlat(hostId, metric) {
    for (const [k, win] of windows) {
      const [h, m] = k.split('|');
      if (h !== hostId || m !== metric) continue;
      if (win.length >= FLAT_RUN) {
        const tail = win.slice(-FLAT_RUN);
        if (tail.every((v) => v === tail[0])) return true;
      }
    }
    return false;
  }

  return { bucket, update, get, isFlat, persist, _windows: windows };
}

module.exports = {
  createBaselineStore,
  median,
  mad,
  MAD_TO_SIGMA,
  FLAT_RUN,
  DEFAULT_WINDOW,
  DEFAULT_MIN_SAMPLES,
};
