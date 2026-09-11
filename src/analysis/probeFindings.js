'use strict';

const crypto = require('crypto');
const { Severity, FindingKind } = require('./constants');
const { computeAgentHealth } = require('../health/probeHealth');
const { extractAsPath, diffAsPath } = require('./asPath');
const { median } = require('./baselines');

// TLS-certificate expiry thresholds (days). A site can be perfectly reachable
// while its certificate is about to lapse, so this is judged independently of
// the reachability/latency verdict below.
const CERT_WARN_DAYS = 14;
const CERT_CRIT_DAYS = 3;

// Turns one agent's recent active-probe rows into Finding objects, ready for the
// finding store. Pure + explainable: the reachability/loss/latency/jitter
// findings reuse the SAME median+MAD verdict the fleet-health view shows
// (src/health/probeHealth.js), so a finding never says anything the dashboard
// verdict doesn't. Each finding mirrors the detector's shape (id / hostId /
// metric / severity / kind / observed / baseline / deviation / explanation /
// evidence / window / createdAt).
//
//   evaluateProbeFindings(agentId, rowsNewestFirst, { now, geoProvider }) -> Finding[]
//
// `rows` must be this agent's recent rows, newest-first (as computeAgentHealth
// expects). Only warn/bad/down verdicts produce findings; ok/stale/unknown don't.
// `geoProvider` (optional) enables AS-path change findings — it maps traceroute hop
// IPs to ASNs; without it that check is skipped (everything else is unaffected).
function evaluateProbeFindings(agentId, rows, { now = () => new Date(), geoProvider = null } = {}) {
  const at = now();
  const hostId = String(agentId);
  const out = [];

  const health = computeAgentHealth(rows, { now: at.getTime() });
  const severity = health.status === 'warn'
    ? Severity.WARN
    : (health.status === 'bad' || health.status === 'down') ? Severity.CRIT : null;
  if (severity) {
    for (const ev of health.evidence) {
      out.push(buildFinding({ hostId, at, severity, ev, health }));
    }
  }

  for (const c of certFindings(hostId, rows, at)) out.push(c);
  for (const c of asPathFindings(hostId, rows, at, geoProvider)) out.push(c);
  return out;
}

// Maps a single verdict evidence row to a finding.
function buildFinding({ hostId, at, severity, ev, health }) {
  const kind = ev.metric === 'latency' ? FindingKind.ANOMALY : FindingKind.THRESHOLD;
  const observed = ev.metric === 'loss' ? ev.lossPct
    : ev.metric === 'latency' ? ev.rttMs
      : ev.metric === 'jitter' ? ev.jitterMs
        : ev.metric === 'reachability' ? (ev.unreachable ?? null)
          : null;
  const baseline = ev.metric === 'latency' ? (ev.baselineMs ?? null) : null;
  const deviation = ev.metric === 'latency' ? (ev.z ?? null) : null;
  return {
    id: crypto.randomUUID(),
    hostId,
    metric: `probe.${ev.metric}`,
    severity,
    kind,
    observed: observed ?? null,
    baseline,
    deviation,
    window: [new Date(at.getTime() - 60000), at],
    explanation: explain(ev, health),
    evidence: [{ ...ev, ts: at.toISOString() }],
    correlatedWith: [],
    createdAt: at,
    acked: false,
  };
}

// A concrete, human-readable explanation per signal (real numbers, no
// placeholders) — same wording the fleet-health reason line uses.
function explain(ev, health) {
  const to = ev.target ? ` to ${ev.target}` : '';
  if (ev.metric === 'reachability') {
    return `${health.metrics.unreachable}/${health.metrics.targets} probe target(s) not responding (e.g. ${ev.target}).`;
  }
  if (ev.metric === 'loss') return `Packet loss ${ev.lossPct}%${to}.`;
  if (ev.metric === 'latency') return `Latency ${ev.rttMs} ms${to} — ~${ev.baselineMs} ms normal (z=${ev.z}).`;
  if (ev.metric === 'jitter') return `Jitter ${ev.jitterMs} ms${to}.`;
  return health.reason || 'Probe health degraded.';
}

// Certificate-expiry findings from the newest http row per target that carries a
// certExpiryDays reading.
function certFindings(hostId, rows, at) {
  const out = [];
  const seen = new Set();
  for (const r of rows) { // newest-first
    if (r.type !== 'http' || seen.has(r.target)) continue;
    seen.add(r.target);
    const days = r.certExpiryDays;
    if (days == null || !Number.isFinite(days)) continue;
    const severity = days <= CERT_CRIT_DAYS ? Severity.CRIT : days <= CERT_WARN_DAYS ? Severity.WARN : null;
    if (!severity) continue;
    out.push({
      id: crypto.randomUUID(),
      hostId,
      metric: 'probe.cert',
      severity,
      kind: FindingKind.THRESHOLD,
      observed: days,
      baseline: CERT_WARN_DAYS,
      deviation: null,
      window: [new Date(at.getTime() - 60000), at],
      explanation: days <= 0
        ? `TLS certificate for ${r.target} has expired.`
        : `TLS certificate for ${r.target} expires in ${days} day(s).`,
      evidence: [{ metric: 'cert', type: 'http', target: r.target, certExpiryDays: days, ts: at.toISOString() }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    });
  }
  return out;
}

// AS-path change findings. For each traceroute target, compares the observed
// (forwarding) AS-path of the two most recent runs (rows are newest-first) and
// raises a finding when the ordered AS sequence changed. A different
// destination/origin AS is the strongest signal (WARN); other reroutes are INFO.
// Needs a geoProvider to map hop IPs to ASNs; without one it yields nothing. The
// pipeline's per-(metric,target) cooldown means a sustained new path is reported
// once, not on every probe — the same way the loss/latency findings behave.
// How many traceroute runs per target are read when measuring what a reroute did
// to the latency. Bounded: this runs on every ingest, and a median over the last
// two dozen runs is already a stable number.
const ASPATH_RTT_WINDOW = 24;

// A latency shift only counts as "the reroute cost something" when it is BOTH
// relatively and absolutely material. 15 ms on a 12 ms path is a different event
// from 15 ms on a 400 ms path, and neither threshold alone says so.
const RTT_SHIFT_PCT = 0.25;
const RTT_SHIFT_MS = 10;

// What the reroute did to the round-trip time.
//
// This is the "performance baseline" half of a path change: "the path changed"
// is a fact an operator can do nothing with, while "the path changed and latency
// went from 24 ms to 91 ms" names the cost and decides whether anyone should
// care tonight.
//
// The two sides are NOT symmetric, and pretending otherwise would be a lie about
// the data. A path change is detected on the tick it happens, so at that moment
// there is exactly ONE run on the new path and a whole window of runs on the old
// one. So:
//
//   before — the MEDIAN of the runs on the old path. This is where the noise
//            protection is needed and where it is available: a single slow
//            historical sample must not become the baseline the change is
//            judged against (CLAUDE.md: robust statistics, median not mean).
//   after  — however many runs are already on the new path, usually one.
//
// Which is why `samplesAfter` is carried into the explanation rather than hidden:
// "latency rose from 24 ms to 91 ms (median of 1 run on the new path vs 12 on the
// old)" is an honest sentence, and the thresholds below are what stop that single
// sample from escalating a severity on its own.
//
// Runs are attributed to a path by their own observed AS-path, so a flap back
// and forth does not smear the two populations together.
function rttAcrossPathChange(runs, { prevSequence, curSequence, geoProvider }) {
  const key = (seq) => (seq || []).join('>');
  const prevKey = key(prevSequence);
  const curKey = key(curSequence);
  const before = [];
  const after = [];

  for (const r of runs) {
    const rtt = r && (r.rttMs != null ? r.rttMs : r.rtt_ms);
    if (!Number.isFinite(rtt)) continue;
    const seq = key(extractAsPath(r.hops, { geoProvider }).sequence);
    if (seq === curKey) after.push(rtt);
    else if (seq === prevKey) before.push(rtt);
  }
  if (!before.length || !after.length) return null;

  const beforeMs = median(before);
  const afterMs = median(after);
  if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) return null;

  const deltaMs = afterMs - beforeMs;
  const ratio = beforeMs > 0 ? Math.abs(deltaMs) / beforeMs : Infinity;
  const material = Math.abs(deltaMs) >= RTT_SHIFT_MS && ratio >= RTT_SHIFT_PCT;

  return {
    beforeMs: Math.round(beforeMs * 10) / 10,
    afterMs: Math.round(afterMs * 10) / 10,
    deltaMs: Math.round(deltaMs * 10) / 10,
    samplesBefore: before.length,
    samplesAfter: after.length,
    material,
    // Only a WORSE path is worth waking someone for; a reroute that made things
    // faster is reported at the severity it would have had anyway.
    worse: material && deltaMs > 0,
  };
}

function asPathFindings(hostId, rows, at, geoProvider) {
  if (!geoProvider || typeof geoProvider.lookup !== 'function') return [];
  // Every recent traceroute per target, not just the newest two: the newest two
  // decide WHETHER the path changed, the rest measure what it cost.
  const byTarget = new Map();
  for (const r of rows) { // newest-first
    if (!r || r.type !== 'traceroute' || !Array.isArray(r.hops)) continue;
    const list = byTarget.get(r.target) || [];
    if (list.length < ASPATH_RTT_WINDOW) { list.push(r); byTarget.set(r.target, list); }
  }
  const out = [];
  for (const [target, list] of byTarget) {
    if (list.length < 2) continue; // need a previous run to compare against
    const cur = extractAsPath(list[0].hops, { geoProvider });
    const prev = extractAsPath(list[1].hops, { geoProvider });
    if (cur.length === 0 || prev.length === 0) continue; // no public ASNs to compare
    const d = diffAsPath(prev.sequence, cur.sequence);
    if (!d.changed) continue;

    const rtt = rttAcrossPathChange(list, {
      prevSequence: prev.sequence, curSequence: cur.sequence, geoProvider,
    });
    // A reroute that measurably hurt is a WARN even when the origin AS is
    // unchanged — that is the case the old severity rule could not see, because
    // it only ever looked at the control plane.
    const severity = (d.originChanged || (rtt && rtt.worse)) ? Severity.WARN : Severity.INFO;

    out.push({
      id: crypto.randomUUID(),
      hostId,
      metric: 'probe.aspath',
      severity,
      kind: FindingKind.ANOMALY, // a deviation from the previously observed path
      // The latency is the number a human reads, so it is what `observed` and
      // `baseline` carry when it is known; the AS-path lengths are the fallback.
      observed: rtt ? rtt.afterMs : cur.length,
      baseline: rtt ? rtt.beforeMs : prev.length,
      deviation: rtt ? rtt.deltaMs : null,
      window: [new Date(at.getTime() - 60000), at],
      explanation: explainAsPath(target, prev, cur, d, rtt),
      evidence: [{
        metric: 'aspath', type: 'traceroute', target,
        prevPath: prev.sequence, curPath: cur.sequence,
        added: d.added, removed: d.removed,
        prevOrigin: d.prevOrigin, curOrigin: d.curOrigin, originChanged: d.originChanged,
        rtt,
        ts: at.toISOString(),
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    });
  }
  return out;
}

// Plain-language explanation of an AS-path change — real ASNs, no placeholders.
function explainAsPath(target, prev, cur, d, rtt = null) {
  const fmt = (seq) => (seq.length ? seq.map((a) => `AS${a}`).join(' → ') : '(none)');
  const tail = ` Observed AS-path now ${fmt(cur.sequence)} (was ${fmt(prev.sequence)}).`;
  const head = d.originChanged
    ? `Path to ${target} now exits via AS${d.curOrigin} (was AS${d.prevOrigin}).`
    : (() => {
      const bits = [];
      if (d.added.length) bits.push(`now transits ${d.added.map((a) => `AS${a}`).join(', ')}`);
      if (d.removed.length) bits.push(`no longer via ${d.removed.map((a) => `AS${a}`).join(', ')}`);
      if (!bits.length && d.lengthDelta !== 0) bits.push(`AS-path length ${d.lengthDelta > 0 ? `grew by ${d.lengthDelta}` : `shrank by ${-d.lengthDelta}`}`);
      return `Path to ${target} changed: ${bits.length ? bits.join('; ') : 'AS-path reordered'}.`;
    })();
  return `${head}${tail}${explainRttShift(rtt)}`;
}

// What the reroute cost, in the sentence an operator reads. Silent when the
// medians say nothing changed — "latency is unchanged" on every reroute trains
// people to stop reading the line that matters.
function explainRttShift(rtt) {
  if (!rtt) return '';
  const samples = ` (median of ${rtt.samplesAfter} run${rtt.samplesAfter === 1 ? '' : 's'} on the new path vs ${rtt.samplesBefore} on the old).`;
  if (!rtt.material) return ` Latency is unchanged at ~${rtt.afterMs} ms${samples}`;
  const direction = rtt.deltaMs > 0 ? 'rose' : 'fell';
  return ` Latency ${direction} from ${rtt.beforeMs} ms to ${rtt.afterMs} ms${samples}`;
}

module.exports = {
  evaluateProbeFindings, rttAcrossPathChange, explainRttShift,
  CERT_WARN_DAYS, CERT_CRIT_DAYS, RTT_SHIFT_PCT, RTT_SHIFT_MS, ASPATH_RTT_WINDOW,
};
