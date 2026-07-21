'use strict';

// Bucketed metric time-series for the Path Visualization timeline (overview strip
// + detail chart). Pure + explainable (CLAUDE.md): no DB, no ML — it takes the
// raw probe rows to one target and reduces them into fixed-width time buckets.
//
// Buckets are aligned on the ABSOLUTE epoch (`floor(tMs / bucketMs) * bucketMs`),
// so a bucket is always the same real duration regardless of wall-clock DST
// shifts — the timeline stays uniform across a spring-forward / fall-back. The
// tenant's timezone only affects how ticks are LABELLED (a frontend concern);
// the maths here is UTC-epoch and DST-agnostic by construction.

// The metric catalogue the API exposes (extensible list, per the spec). `render`
// tells the detail chart how to draw it (loss = bars, latency/jitter = line,
// throughput = area); `field` is the probe-row property; `agg` the per-bucket
// reducer.
const METRICS = [
  { id: 'loss', label: 'Loss', unit: '%', render: 'bars', field: 'lossPct', agg: 'avg' },
  { id: 'latency', label: 'Latency', unit: 'ms', render: 'line', field: 'rttMs', agg: 'median' },
  { id: 'jitter', label: 'Jitter', unit: 'ms', render: 'line', field: 'jitterMs', agg: 'median' },
  { id: 'throughput', label: 'Throughput', unit: 'B/s', render: 'area', field: 'bytes', agg: 'rate' },
];

const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));

function getMetric(id) {
  return METRIC_BY_ID.get(String(id || '').toLowerCase()) || null;
}

function median(xs) {
  const a = xs.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function aggregate(agg, values, bucketMs) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  switch (agg) {
    case 'median': return round2(median(nums));
    case 'avg': return round2(nums.reduce((s, v) => s + v, 0) / nums.length);
    case 'sum': return round2(nums.reduce((s, v) => s + v, 0));
    case 'rate': {
      // bytes in the bucket → bytes per second over the bucket's real duration.
      const total = nums.reduce((s, v) => s + v, 0);
      const secs = Math.max(1, bucketMs / 1000);
      return round2(total / secs);
    }
    default: return round2(median(nums));
  }
}

// Standard bucket sizes (seconds): 1m, 5m, 15m, 1h, 6h, 1d. `resolveBucketMs`
// honours an explicit request (clamped) or auto-picks ~120 buckets for the span.
const BUCKET_SECONDS = [60, 300, 900, 3600, 21600, 86400];

function resolveBucketMs(spanMs, requestedSec) {
  const req = Number.parseInt(requestedSec, 10);
  if (Number.isFinite(req) && req >= 60 && req <= 86400) return req * 1000;
  const span = Number.isFinite(spanMs) && spanMs > 0 ? spanMs : 3600 * 1000;
  const target = span / 120 / 1000; // aim for ~120 buckets, in seconds
  const pick = BUCKET_SECONDS.find((s) => s >= target) || BUCKET_SECONDS[BUCKET_SECONDS.length - 1];
  return pick * 1000;
}

// Reduce probe rows to a bucketed series. Each row: { agentId, agentName, ts,
// rttMs, jitterMs, lossPct, bytes }. `overlay==='agents'` splits into one series
// per probing agent; otherwise a single aggregate series.
//
//   returns { metric, label, unit, render, bucketMs, from, to,
//             series: [{ agentId, agentName, points: [{ t, value, count }] }] }
//
// Empty input ⇒ empty `series` array (never null), per the API convention.
function bucketMetric(rows, { from = null, to = null, bucketMs, metric, overlay = 'off' } = {}) {
  const def = typeof metric === 'string' ? getMetric(metric) : metric;
  if (!def) throw new Error(`unknown metric: ${metric}`);

  const list = Array.isArray(rows) ? rows : [];
  const tsOf = (r) => (r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime());
  const fromMs = from != null ? (from instanceof Date ? from.getTime() : new Date(from).getTime()) : null;
  const toMs = to != null ? (to instanceof Date ? to.getTime() : new Date(to).getTime()) : null;

  // Determine the bucket width from the window (or the data range when no window).
  let span = null;
  if (fromMs != null && toMs != null) span = toMs - fromMs;
  const size = Number.isFinite(bucketMs) && bucketMs > 0
    ? bucketMs
    : resolveBucketMs(span, null);

  const byAgent = new Map(); // seriesKey -> { agentId, agentName, buckets: Map(bucketStart -> values[]) }
  for (const r of list) {
    const t = tsOf(r);
    if (!Number.isFinite(t)) continue;
    if (fromMs != null && t < fromMs) continue;
    if (toMs != null && t > toMs) continue;
    const key = overlay === 'agents' ? String(r.agentId) : '_all';
    if (!byAgent.has(key)) byAgent.set(key, { agentId: overlay === 'agents' ? (r.agentId ?? null) : null, agentName: overlay === 'agents' ? (r.agentName ?? null) : null, buckets: new Map() });
    const s = byAgent.get(key);
    const bucketStart = Math.floor(t / size) * size;
    if (!s.buckets.has(bucketStart)) s.buckets.set(bucketStart, []);
    s.buckets.get(bucketStart).push(r[def.field]);
  }

  const series = [];
  for (const s of byAgent.values()) {
    const points = [];
    for (const [bucketStart, values] of [...s.buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const value = aggregate(def.agg, values, size);
      points.push({ t: new Date(bucketStart).toISOString(), value, count: values.filter((v) => v != null).length });
    }
    series.push({ agentId: s.agentId, agentName: s.agentName, points });
  }
  // Stable order: overlay series by agentId so colours/legend are deterministic.
  series.sort((a, b) => (a.agentId ?? -1) - (b.agentId ?? -1));

  return {
    metric: def.id,
    label: def.label,
    unit: def.unit,
    render: def.render,
    bucketMs: size,
    from: fromMs != null ? new Date(fromMs).toISOString() : null,
    to: toMs != null ? new Date(toMs).toISOString() : null,
    series,
  };
}

module.exports = { METRICS, getMetric, bucketMetric, resolveBucketMs };
