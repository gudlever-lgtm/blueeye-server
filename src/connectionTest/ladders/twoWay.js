'use strict';

// Ladder 2 — TWO-WAY. The same question asked from both ends.
//
// A one-way ladder can tell you the communication stops, and it cannot tell you
// which DIRECTION is broken. That distinction is not a refinement; it is the
// whole answer for a class of faults that a forward test reports as "the
// network is fine":
//
//   * asymmetric routing — the two directions take different paths, so one of
//     them can be broken while the other is perfect;
//   * a stateful firewall on the return path, which never saw the SYN and drops
//     the answer. From one end that looks exactly like a dead service;
//   * one-way loss — a congested or failing link that is only in one direction,
//     which a round-trip measurement averages into something mild;
//   * an MTU that differs per direction, so small packets work both ways and the
//     reply to a large request vanishes.
//
// The rungs:
//
//   forward   → does A reach B at all
//   reverse   → does B reach A
//   symmetry  → do the two directions traverse the same routers
//   direction → which way is losing
//   latency   → do the two directions cost materially different time
//   mtu       → does the path carry the same packet size both ways
//
// The first four are a causal chain: there is nothing to compare until both
// directions have been measured, and nothing to say about which direction is
// losing until the paths are known. Latency and MTU are observations about a
// path that already works, so they move.
//
// ctx: { forward, reverse, host, peerHost } — the probe rows from each agent
// (newest first) about the OTHER end, and what each end was asked to reach.
//
// WHAT THIS DOES NOT CLAIM. A round trip cannot be split into two one-way
// latencies without synchronised clocks, which BlueEyes does not have and will
// not invent. The latency rung compares two ROUND TRIPS — A→B→A against B→A→B —
// and a difference between them means the two round trips are not the same
// path, which is a real finding and a different one from "the outbound leg is
// slow". The sentence says so.

const { STATUS, rung } = require('./registry');
const { comparePaths } = require('../../diagnose/facts');

const LAYERS = ['forward', 'reverse', 'symmetry', 'direction', 'latency', 'mtu'];
const LOCKED = ['forward', 'reverse', 'symmetry', 'direction'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const firstOf = (rows, type) => (Array.isArray(rows) ? rows : []).find((r) => r && r.type === type) || null;

// One direction's measurement, in the shape the rungs read.
function side(rows) {
  const ping = firstOf(rows, 'ping');
  const trace = firstOf(rows, 'traceroute');
  const mtu = firstOf(rows, 'path_mtu');
  return {
    ping,
    trace,
    mtu,
    ok: ping ? ping.ok === true : null,
    loss: ping ? num(ping.lossPct) : null,
    rtt: ping ? num(ping.rttMs) : null,
    pathMtu: mtu && mtu.mtu && typeof mtu.mtu === 'object' ? num(mtu.mtu.pathMtu) : null,
  };
}

function reachRung(layer, s, from, to) {
  if (!s.ping) return rung(layer, STATUS.UNKNOWN, `${layer}.untested`, { from, to });
  if (s.ok) return rung(layer, STATUS.OK, `${layer}.ok`, { from, to, loss: s.loss ?? 0, rtt: s.rtt ?? '?' }, { loss_pct: s.loss, rtt_ms: s.rtt });
  return rung(layer, STATUS.FAILED, `${layer}.failed`, { from, to }, { loss_pct: s.loss });
}

// Do the two directions traverse the same routers? comparePaths is the existing
// LCS-over-hops comparison (src/diagnose/facts.js) — reused rather than
// re-implemented, because a second, quietly different answer to "is this path
// symmetric" is worse than no second opinion at all.
//
// It is only a SUSPECT when they differ, never a break: asymmetric routing is
// normal on the internet and across most WANs. It becomes the answer when a
// direction is also losing, and the direction rung is what says so.
function symmetryRung(fwd, rev) {
  if (!fwd.trace || !rev.trace) return rung('symmetry', STATUS.UNKNOWN, 'symmetry.untested');
  const cmp = comparePaths(fwd.trace, rev.trace);
  if (!cmp.compared) return rung('symmetry', STATUS.UNKNOWN, 'symmetry.nohops');
  if (cmp.same_hops) {
    return rung('symmetry', STATUS.OK, 'symmetry.ok', { pct: Math.round(cmp.match_ratio * 100) }, { compare: cmp });
  }
  return rung('symmetry', STATUS.SUSPECT, 'symmetry.differs',
    { pct: Math.round(cmp.match_ratio * 100), forward: cmp.forward_hops, reverse: cmp.reverse_hops }, { compare: cmp });
}

// Which direction is losing. This is the rung the ladder exists for: it is the
// sentence that sends somebody to the right end of the link.
//
// A stateful firewall on the return path is the case worth naming out loud: it
// never saw the outbound SYN, so it drops the answer, and from the near end
// that is indistinguishable from a dead service — until the far end reports
// that ITS traffic arrives.
const ONE_WAY_LOSS_PCT = 5;

function directionRung(fwd, rev, from, to) {
  if (fwd.loss === null || rev.loss === null) return rung('direction', STATUS.UNKNOWN, 'direction.untested');
  const fBad = fwd.loss >= ONE_WAY_LOSS_PCT;
  const rBad = rev.loss >= ONE_WAY_LOSS_PCT;
  if (fBad && rBad) {
    return rung('direction', STATUS.FAILED, 'direction.both',
      { from, to, forward: fwd.loss, reverse: rev.loss }, { forward_loss_pct: fwd.loss, reverse_loss_pct: rev.loss });
  }
  if (fBad) {
    return rung('direction', STATUS.FAILED, 'direction.forward',
      { from, to, loss: fwd.loss }, { forward_loss_pct: fwd.loss, reverse_loss_pct: rev.loss });
  }
  if (rBad) {
    return rung('direction', STATUS.FAILED, 'direction.reverse',
      { from, to, loss: rev.loss }, { forward_loss_pct: fwd.loss, reverse_loss_pct: rev.loss });
  }
  return rung('direction', STATUS.OK, 'direction.ok', { forward: fwd.loss, reverse: rev.loss });
}

// Two round trips over what should be one path. A material difference means
// they are NOT one path — different queuing, different routing, or one
// direction crossing something the other does not.
function latencyRung(fwd, rev, cfg) {
  if (fwd.rtt === null || rev.rtt === null) return rung('latency', STATUS.UNKNOWN, 'latency.untested');
  const lo = Math.min(fwd.rtt, rev.rtt);
  const hi = Math.max(fwd.rtt, rev.rtt);
  const diff = Math.round((hi - lo) * 10) / 10;
  // A ratio, floored by an absolute gap: 0.4 ms against 0.2 ms is double and
  // means nothing, and reporting it would bury the case that matters.
  if (diff < cfg.latencyMinMs || hi < lo * cfg.latencyRatio) {
    return rung('latency', STATUS.OK, 'latency.ok', { forward: fwd.rtt, reverse: rev.rtt });
  }
  return rung('latency', STATUS.SUSPECT, 'latency.differs', { forward: fwd.rtt, reverse: rev.rtt, diff });
}

function mtuRung(fwd, rev) {
  if (fwd.pathMtu === null || rev.pathMtu === null) return rung('mtu', STATUS.UNKNOWN, 'mtu.untested');
  if (fwd.pathMtu === rev.pathMtu) return rung('mtu', STATUS.OK, 'mtu.ok', { mtu: fwd.pathMtu });
  return rung('mtu', STATUS.SUSPECT, 'mtu.differs',
    { forward: fwd.pathMtu, reverse: rev.pathMtu, smaller: Math.min(fwd.pathMtu, rev.pathMtu) });
}

const DEF = {
  id: 'two_way',
  layers: LAYERS,
  locked: LOCKED,
  // Two agents, because the second direction has to be measured BY the far end.
  // Nothing about this ladder can be answered from one.
  needs: { agents: 2, target: 'none' },
  extras: {
    // How much slower one round trip has to be than the other before it is
    // worth a sentence: both a ratio and an absolute floor, so a sub-millisecond
    // LAN never trips it.
    latencyRatio: 1.5,
    latencyMinMs: 10,
  },
  clamp(c) {
    const out = {};
    if (typeof c.latencyRatio === 'number' && c.latencyRatio >= 1 && c.latencyRatio <= 100) out.latencyRatio = c.latencyRatio;
    if (Number.isInteger(c.latencyMinMs) && c.latencyMinMs >= 0 && c.latencyMinMs <= 10000) out.latencyMinMs = c.latencyMinMs;
    return out;
  },
  // Both ends run the same three probes at each other. The caller dispatches
  // this list twice, once per agent, with the other end as the target.
  dispatch: ({ host }) => ({ skipped: [], specs: [
    { id: 'ping', probe: { type: 'ping', host, count: 4 } },
    { id: 'traceroute', probe: { type: 'traceroute', host, queries: 3 } },
    { id: 'path_mtu', probe: { type: 'path_mtu', host, per_hop: true } },
  ] }),
  prepare: (ctx) => ({
    fwd: side(ctx.forward),
    rev: side(ctx.reverse),
    // The names in the sentences. An agent's display name where there is one,
    // the address otherwise — an operator reads "probe-01", not "agent 7".
    from: ctx.fromName || ctx.host || 'this agent',
    to: ctx.toName || ctx.peerHost || 'the far end',
  }),
  rungs: {
    forward: (p) => reachRung('forward', p.fwd, p.from, p.to),
    reverse: (p) => reachRung('reverse', p.rev, p.to, p.from),
    symmetry: (p) => symmetryRung(p.fwd, p.rev),
    direction: (p) => directionRung(p.fwd, p.rev, p.from, p.to),
    latency: (p, cfg) => latencyRung(p.fwd, p.rev, cfg),
    mtu: (p) => mtuRung(p.fwd, p.rev),
  },
};

module.exports = { DEF, LAYERS, LOCKED, side, ONE_WAY_LOSS_PCT };
