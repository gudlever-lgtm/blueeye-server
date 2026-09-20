'use strict';

// Maps one counter sample into the MetricSamples the detector evaluates.
//
// THE GAP THIS CLOSES. `extractSamples()` — the agent path — emits six metrics:
// cpu, mem, load1, uptime and the two traffic totals. Per-interface numbers are
// collected, stored, and shown on a screen, and they have never reached the
// detector at all. There is no MAD, no z-score and no flatline on a single
// interface counter anywhere in this product.
//
// WHAT IS DELIBERATELY NOT HERE.
//
// Not the raw counters. A counter is monotonically rising, so its median is
// meaningless and every sample is an all-time high — the baseline would call
// steady traffic an anomaly forever. Only the RATES are emitted, which is what
// the existing detector is built for.
//
// Not a sample with no rate. A row marked `discontinuity` has raw counters and
// null rates on purpose (a reboot, a renumbering, a gap), and feeding a null
// through as 0 would teach the baseline that the port went quiet when what
// actually happened is that we could not measure it.
//
// THE METRIC NAME IS THE BASELINE KEY. Baselines are looked up by
// (hostId, metric, bucket), so a port's errors must not share a key with
// another port's. The id is in the name — `if.12.in.errPps` — which is what
// keeps one flapping port from raising the baseline for all forty-eight.

// Which rates are worth a baseline, and what each one is for.
//
// Utilisation and the two rate columns are the "is this port busy" questions.
// The error and discard rates are the "is this port BROKEN" questions, and they
// are the reason this exists: a port that starts discarding at 4 per second
// when it has never discarded at all is a fault, and until now nothing noticed.
const METRICS = [
  ['inUtilPct', 'in.utilPct'],
  ['outUtilPct', 'out.utilPct'],
  ['inErrPps', 'in.errPps'],
  ['outErrPps', 'out.errPps'],
  ['inDiscPps', 'in.discPps'],
  ['outDiscPps', 'out.discPps'],
  ['fcsPps', 'fcs.pps'],
  ['inBcastPps', 'in.bcastPps'],
];

// Turns one stored counter row into samples. `hostId` is the POLLING AGENT, so
// an agent-scoped read still finds these; the device and the port are carried
// alongside (migration 110) so a finding can say which port rather than only
// which agent noticed.
function extractDeviceSamples(sample, { hostId, ts = null } = {}) {
  if (!sample || typeof sample !== 'object') return [];
  // A row whose rates were voided has nothing to evaluate. Its raw counters are
  // still stored and still evidence; they are just not a measurement of an
  // interval.
  if (sample.discontinuity) return [];
  const interfaceId = Number(sample.interfaceId);
  if (!Number.isInteger(interfaceId) || interfaceId < 1) return [];

  const at = ts ? new Date(ts) : new Date(sample.ts);
  const out = [];
  for (const [field, suffix] of METRICS) {
    const value = sample[field];
    // Null is "not measured", and it must never become 0 — zero errors is what
    // RULES OUT a fault, so an unmeasured column turned into a zero would
    // actively teach the baseline that a broken port is healthy.
    if (value == null || !Number.isFinite(Number(value))) continue;
    out.push({
      hostId: String(hostId),
      deviceId: sample.deviceId == null ? null : Number(sample.deviceId),
      interfaceId,
      metric: `if.${interfaceId}.${suffix}`,
      value: Number(value),
      ts: at,
      // The port's name, for an explanation that reads as a place rather than
      // as an id. Optional: the sample carries it only on the reads that join.
      labels: sample.ifName ? { iface: sample.ifName } : {},
    });
  }
  return out;
}

// Every sample in one ingested cycle.
function extractCycleSamples(rows, { hostId } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) out.push(...extractDeviceSamples(row, { hostId }));
  return out;
}

module.exports = { extractDeviceSamples, extractCycleSamples, METRICS };
