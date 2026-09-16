'use strict';

const crypto = require('crypto');
const { Severity, FindingKind } = require('./constants');

// Root-cause rules for the `path_mtu` probe.
//
// The fault this names is the one that costs hours: a service connects, works
// for small exchanges, and then loses data the moment a full-size packet goes
// out. Every reachability and latency test passes, because every one of them
// uses small packets. The path has a lower MTU somewhere, and the ICMP that
// would have told the sender so is being dropped, so Path MTU Discovery never
// completes and the sender keeps retransmitting a packet that can never arrive.
//
// PURE: probe rows in, findings out. No database, no clock, no network — `at` is
// passed in, the same way the other evaluators in this directory take it.
//
// Three rules, and the second one is what keeps the first honest:
//
//   1. A BLACKHOLE IS THE FAULT. Large packets disappear with no ICMP. Nothing
//      downstream can self-correct, so this is CRIT and carries the concrete fix.
//   2. A REDUCTION WITH ICMP IS NOT A FAULT. A tunnel (IPsec/GRE/PPPoE) lowering
//      the MTU and saying so is PMTUD working exactly as designed. Reporting it
//      as a problem would bury rule 1 under noise from every tunnelled path in
//      the estate, so it is INFO and says plainly that it is expected.
//   3. A HOP THAT DOES NOT ANSWER IS NOT EVIDENCE OF ANYTHING. `no_response`
//      hops are excluded from every verdict here. A silent router is the normal
//      state of a great deal of the internet.
//
// Every finding carries the measured numbers and the hop that produced them, so
// an operator can go to one router rather than to "the network".

// A negotiated MSS is allowed to sit this far above what the path measured
// before it is called a clamping failure. Zero would fire on a 1-byte rounding
// difference between two measurements taken seconds apart.
const MSS_SLACK = 8;

// Loss on the small-packet probe below which "the path is fine for small
// packets" is a fair statement. Above it, the MTU verdict is still true but it
// is no longer the only thing wrong, and the explanation says so instead of
// claiming corroboration it does not have.
const SMALL_PACKET_LOSS_OK = 2;

const withHop = (hops, hop) => (Array.isArray(hops) ? hops.find((h) => h && h.hop === hop) : null) || null;

// Names the router an operator should go and look at: the hop where the path
// narrows, with its address when the trace saw one.
function whereItNarrows(row) {
  const hop = row.mtu && row.mtu.mtuDropAtHop != null ? row.mtu.mtuDropAtHop : null;
  if (hop == null) return { hop: null, ip: null, label: 'somewhere on the path' };
  const h = withHop(row.hops, hop);
  const ip = h && h.ip ? h.ip : null;
  return { hop, ip, label: ip ? `hop ${hop} (${ip})` : `hop ${hop}` };
}

// Corroboration from the ordinary ping probe to the same target. Small packets
// getting through cleanly while sized packets do not is what turns "we measured
// a ceiling" into "the ceiling is about SIZE" — the single distinction that
// separates an MTU fault from plain packet loss.
//
// Returns null when there is no ping row to lean on. An absent corroboration is
// reported as absent; it is never implied.
function smallPacketEvidence(rows, target) {
  for (const r of rows) { // newest-first
    if (r.type !== 'ping' || r.target !== target) continue;
    const loss = Number.isFinite(r.lossPct) ? r.lossPct : null;
    if (loss == null) return null;
    return { lossPct: loss, clean: loss <= SMALL_PACKET_LOSS_OK };
  }
  return null;
}

function sentence(small) {
  if (!small) return '';
  return small.clean
    ? ` Small packets to the same target are getting through (${small.lossPct}% loss), so this is a size limit, not general packet loss.`
    : ` The same target is also losing small packets (${small.lossPct}% loss), so there is a reachability problem on top of the size limit.`;
}

function finding({ hostId, at, metric, severity, kind, observed, baseline, explanation, evidence }) {
  return {
    id: crypto.randomUUID(),
    hostId,
    metric,
    severity,
    kind,
    observed: observed ?? null,
    baseline: baseline ?? null,
    deviation: null,
    window: [new Date(at.getTime() - 60000), at],
    explanation,
    evidence,
    correlatedWith: [],
    createdAt: at,
    acked: false,
  };
}

// Path-MTU findings from the newest path_mtu row per target.
//
//   evaluateMtuFindings(hostId, rowsNewestFirst, at) -> Finding[]
//
// `rows` is this agent's recent probe rows, newest-first — the same list the
// other evaluators in this directory read, so the ping corroboration above can
// be found without a second query.
function evaluateMtuFindings(hostId, rows, at) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  const seen = new Set();

  for (const row of rows) { // newest-first
    if (!row || row.type !== 'path_mtu' || seen.has(row.target)) continue;
    seen.add(row.target);
    const m = row.mtu && typeof row.mtu === 'object' ? row.mtu : null;
    if (!m) continue;

    const pathMtu = Number.isFinite(m.pathMtu) ? m.pathMtu : null;
    const recommended = Number.isFinite(m.recommendedMss) ? m.recommendedMss : null;
    const where = whereItNarrows(row);
    const small = smallPacketEvidence(rows, row.target);
    const base = { metric: 'path_mtu', type: 'path_mtu', target: row.target, pathMtu, ts: at.toISOString() };

    // ---------------------------------------------------------- 1. blackhole
    if (m.blackholeDetected) {
      // ICMP type 3 code 4 ("fragmentation needed and DF set") is the message
      // that is not arriving. Naming the exact type/code matters: it is what an
      // operator has to allow in a firewall rule, and "allow ICMP" is both too
      // broad to be accepted and too vague to be actioned.
      const fixes = [
        `allow ICMP type 3 code 4 (fragmentation needed) inbound at or before ${where.label}`,
        recommended != null ? `clamp TCP MSS to ${recommended} on the tunnel or edge router` : null,
        'or give the whole path the same MTU',
      ].filter(Boolean);
      out.push(finding({
        hostId,
        at,
        metric: 'probe.mtu.blackhole',
        severity: Severity.CRIT,
        kind: FindingKind.THRESHOLD,
        observed: pathMtu,
        baseline: null,
        explanation: `Path MTU to ${row.target} is ${pathMtu ?? 'below the tested maximum'} bytes, but no ICMP`
          + ` "fragmentation needed" is coming back — large packets are being dropped silently at ${where.label}.`
          + ` Connections will establish and then stall on their first full-size packet, because the sender is`
          + ` never told to send less.${sentence(small)}`
          + ` Fix: ${fixes.join(', ')}.`,
        evidence: [
          { ...base, blackhole: true, icmpFragNeededSeen: !!m.icmpFragNeededSeen, dropAtHop: where.hop, hopIp: where.ip, recommendedMss: recommended },
          ...(small ? [{ metric: 'corroboration', type: 'ping', target: row.target, lossPct: small.lossPct, ts: at.toISOString() }] : []),
        ],
      }));
    } else if (m.icmpFragNeededSeen && pathMtu != null && where.hop != null) {
      // ------------------------------------------------------- 2. reduced only
      // Deliberately INFO. PMTUD is working; the path simply is not 1500 bytes.
      // It becomes a problem only for an application that ignores the ICMP it is
      // being sent, which is worth saying once rather than implying by severity.
      out.push(finding({
        hostId,
        at,
        metric: 'probe.mtu.reduced',
        severity: Severity.INFO,
        kind: FindingKind.THRESHOLD,
        observed: pathMtu,
        baseline: null,
        explanation: `Path MTU to ${row.target} is ${pathMtu} bytes, reduced at ${where.label}, and the router is`
          + ` sending ICMP "fragmentation needed" as it should. This is expected on a tunnelled path`
          + ` (IPsec, GRE, PPPoE) and Path MTU Discovery handles it. It only becomes a fault if an application`
          + ` or firewall ignores that ICMP${recommended != null ? `; clamping TCP MSS to ${recommended} removes the dependency on it` : ''}.`,
        evidence: [{ ...base, blackhole: false, icmpFragNeededSeen: true, dropAtHop: where.hop, hopIp: where.ip, recommendedMss: recommended }],
      }));
    }

    // ------------------------------------------------------- 3. missing clamp
    // Independent of the two above: a path can be perfectly well-behaved and
    // still have a sender negotiating segments it cannot deliver.
    const observedMss = Number.isFinite(m.mssObserved) ? m.mssObserved : null;
    if (m.mssSupported && observedMss != null && recommended != null && observedMss > recommended + MSS_SLACK) {
      out.push(finding({
        hostId,
        at,
        metric: 'probe.mtu.clamp',
        severity: Severity.WARN,
        kind: FindingKind.THRESHOLD,
        observed: observedMss,
        baseline: recommended,
        explanation: `TCP to ${row.target} negotiated an MSS of ${observedMss} bytes, but the measured path only`
          + ` carries ${pathMtu} bytes — a segment of that size cannot arrive whole. MSS clamping is missing:`
          + ` set it to ${recommended} on the tunnel or edge router so the sender never builds a segment the`
          + ` path will not take.`,
        evidence: [{ ...base, mssObserved: observedMss, recommendedMss: recommended, gapBytes: observedMss - recommended }],
      }));
    }
  }
  return out;
}

module.exports = { evaluateMtuFindings, MSS_SLACK, SMALL_PACKET_LOSS_OK };
