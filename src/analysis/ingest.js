'use strict';

// Maps an ingested agent result payload into MetricSamples the detector can
// evaluate. A result payload looks like { name, traffic, system, ... }; we
// derive one sample per numeric metric we care about (host performance + the
// aggregated traffic rates). This keeps the detector working on the SAME data
// the ingest already persists — no separate pipeline.
//
// Returns MetricSample[] (possibly empty). `now` is injectable for tests.
function extractSamples(hostId, payload, now = () => new Date()) {
  if (!payload || typeof payload !== 'object') return [];
  const ts = now();
  const samples = [];
  const push = (metric, value, labels = {}) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      samples.push({ hostId: String(hostId), metric, value, ts, labels });
    }
  };

  const sys = payload.system;
  if (sys && typeof sys === 'object') {
    push('cpu', sys.cpuPercent);
    push('mem', sys.memUsedPercent);
    if (Array.isArray(sys.loadavg) && sys.loadavg.length) push('load1', Number(sys.loadavg[0]));
    push('uptime', sys.uptimeSec);
  }

  const totals = payload.traffic && payload.traffic.totals;
  if (totals && typeof totals === 'object') {
    push('rx.bytesPerSec', Number(totals.rxBytesPerSec));
    push('tx.bytesPerSec', Number(totals.txBytesPerSec));
  }

  return samples;
}

module.exports = { extractSamples };
