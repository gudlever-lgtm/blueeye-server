'use strict';

const crypto = require('crypto');
const { Severity, FindingKind } = require('./constants');
const { computeAgentHealth } = require('../health/probeHealth');
const { extractAsPath, diffAsPath } = require('./asPath');

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
function asPathFindings(hostId, rows, at, geoProvider) {
  if (!geoProvider || typeof geoProvider.lookup !== 'function') return [];
  const byTarget = new Map(); // target -> up to the 2 newest traceroute runs
  for (const r of rows) { // newest-first
    if (!r || r.type !== 'traceroute' || !Array.isArray(r.hops)) continue;
    const list = byTarget.get(r.target) || [];
    if (list.length < 2) { list.push(r); byTarget.set(r.target, list); }
  }
  const out = [];
  for (const [target, list] of byTarget) {
    if (list.length < 2) continue; // need a previous run to compare against
    const cur = extractAsPath(list[0].hops, { geoProvider });
    const prev = extractAsPath(list[1].hops, { geoProvider });
    if (cur.length === 0 || prev.length === 0) continue; // no public ASNs to compare
    const d = diffAsPath(prev.sequence, cur.sequence);
    if (!d.changed) continue;
    out.push({
      id: crypto.randomUUID(),
      hostId,
      metric: 'probe.aspath',
      severity: d.originChanged ? Severity.WARN : Severity.INFO,
      kind: FindingKind.ANOMALY, // a deviation from the previously observed path
      observed: cur.length,
      baseline: prev.length,
      deviation: null,
      window: [new Date(at.getTime() - 60000), at],
      explanation: explainAsPath(target, prev, cur, d),
      evidence: [{
        metric: 'aspath', type: 'traceroute', target,
        prevPath: prev.sequence, curPath: cur.sequence,
        added: d.added, removed: d.removed,
        prevOrigin: d.prevOrigin, curOrigin: d.curOrigin, originChanged: d.originChanged,
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
function explainAsPath(target, prev, cur, d) {
  const fmt = (seq) => (seq.length ? seq.map((a) => `AS${a}`).join(' → ') : '(none)');
  const tail = ` Observed AS-path now ${fmt(cur.sequence)} (was ${fmt(prev.sequence)}).`;
  if (d.originChanged) return `Path to ${target} now exits via AS${d.curOrigin} (was AS${d.prevOrigin}).${tail}`;
  const bits = [];
  if (d.added.length) bits.push(`now transits ${d.added.map((a) => `AS${a}`).join(', ')}`);
  if (d.removed.length) bits.push(`no longer via ${d.removed.map((a) => `AS${a}`).join(', ')}`);
  if (!bits.length && d.lengthDelta !== 0) bits.push(`AS-path length ${d.lengthDelta > 0 ? `grew by ${d.lengthDelta}` : `shrank by ${-d.lengthDelta}`}`);
  return `Path to ${target} changed: ${bits.length ? bits.join('; ') : 'AS-path reordered'}.${tail}`;
}

module.exports = { evaluateProbeFindings, CERT_WARN_DAYS, CERT_CRIT_DAYS };
