'use strict';

// Ladder 3 — LOCAL HOST. Is the problem this machine?
//
// Asked BEFORE a destination ladder means anything. Every rung of the
// reachability ladder measures the path to somewhere; none of them can tell you
// that the NIC negotiated half duplex, that the DHCP lease came from a rogue
// server, or that the default gateway two feet away is the thing that is
// unreachable. Diagnosing a network for a host with a broken NIC is a day
// nobody gets back.
//
//   link      → is the interface up
//   duplex    → did it negotiate full duplex
//   errors    → is it dropping or corrupting frames
//   dhcp      → did anything answer for an address, and did more than one thing
//   gateway   → does the first hop answer
//   resolver  → does a name resolve
//
// The chain is causal from `link` down: a link that is down makes duplex
// meaningless, an address has to come from somewhere before a gateway can be
// reached, and a gateway has to answer before an off-subnet resolver can. The
// `errors` rung is an observation about an interface that is already up — it
// moves.
//
// Everything here reads data agents ALREADY report: interface health from the
// traffic payload, the DHCP probe's offers, the first hop of any traceroute,
// and any DNS probe. No agent change, and no probe this ladder invented.
//
// ctx: { interfaces, results } — computeInterfaceHealth() output for the agent,
// and its probe rows (newest first).

const { STATUS, rung } = require('./registry');

const LAYERS = ['link', 'duplex', 'errors', 'dhcp', 'gateway', 'resolver'];
const LOCKED = ['link', 'duplex', 'dhcp', 'gateway', 'resolver'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const firstOf = (rows, type) => (Array.isArray(rows) ? rows : []).find((r) => r && r.type === type) || null;

// The worst REAL interface. A docker bridge with no carrier is not the
// operator's problem, and letting it into these numbers would report a link
// fault on every container host in the fleet.
function worstIface(interfaces) {
  const list = (Array.isArray(interfaces) ? interfaces : []).filter((i) => i && !i.virtual);
  if (!list.length) return null;
  const rank = { down: 0, bad: 1, warn: 2, ok: 3 };
  return list.reduce((a, b) => ((rank[b.status] ?? 9) < (rank[a.status] ?? 9) ? b : a), list[0]);
}

function linkRung(p) {
  const i = p.iface;
  if (!i) return rung('link', STATUS.UNKNOWN, 'link.untested');
  if (i.linkDown === true) return rung('link', STATUS.FAILED, 'link.down', { iface: i.name || '?' }, { iface: i.name || null });
  if (i.linkDown === false) {
    const speed = num(i.speedMbps);
    return rung('link', STATUS.OK, speed !== null ? 'link.up.speed' : 'link.up',
      { iface: i.name || '?', speed }, { iface: i.name || null, speed_mbps: speed });
  }
  return rung('link', STATUS.UNKNOWN, 'link.unreported', { iface: i.name || '?' });
}

// Half duplex on a modern switched port is a negotiation that failed, and it
// behaves as a network fault that gets worse under load — which is why it is
// diagnosed as congestion for weeks. Late collisions NAME it: they only happen
// when one end thinks it may transmit while the other is transmitting.
function duplexRung(p) {
  const i = p.iface;
  if (!i) return rung('duplex', STATUS.UNKNOWN, 'duplex.untested');
  const late = num(i.lateCollPerSec);
  if (late !== null && late > 0) {
    return rung('duplex', STATUS.FAILED, 'duplex.late', { iface: i.name || '?', rate: late }, { late_coll_per_sec: late });
  }
  if (i.duplex === 'half') return rung('duplex', STATUS.FAILED, 'duplex.half', { iface: i.name || '?' });
  if (i.duplex === 'full') return rung('duplex', STATUS.OK, 'duplex.full', { iface: i.name || '?' });
  // Absent, not zero. Many sources cannot read it at all, and reading "we could
  // not look" as "it is fine" is how a duplex mismatch survives a diagnosis.
  return rung('duplex', STATUS.UNKNOWN, 'duplex.unreported', { iface: i.name || '?' });
}

function errorsRung(p, cfg) {
  const i = p.iface;
  if (!i) return rung('errors', STATUS.UNKNOWN, 'errors.untested');
  const err = num(i.errPerSec);
  const drop = num(i.dropPerSec);
  if (err === null && drop === null) return rung('errors', STATUS.UNKNOWN, 'errors.unreported', { iface: i.name || '?' });
  const util = num(i.utilPct);
  if (err !== null && err >= cfg.errPerSec) {
    // Errors at LOW utilisation are the telling case: a link that corrupts
    // frames when it is barely busy is a cable, an SFP or a duplex mismatch,
    // never congestion.
    return rung('errors', STATUS.FAILED, util !== null && util < 50 ? 'errors.idle' : 'errors.busy',
      { iface: i.name || '?', rate: err, util }, { err_per_sec: err, util_pct: util });
  }
  if (drop !== null && drop >= cfg.dropPerSec) {
    return rung('errors', STATUS.SUSPECT, 'errors.drops', { iface: i.name || '?', rate: drop, util }, { drop_per_sec: drop, util_pct: util });
  }
  return rung('errors', STATUS.OK, 'errors.clean', { iface: i.name || '?' });
}

// The DHCP probe broadcasts a DISCOVER and collects every offer without ever
// requesting a lease. Two answers matter and they are different faults: nobody
// answered, and MORE THAN ONE thing answered.
function dhcpRung(p) {
  const r = p.dhcp;
  if (!r) return rung('dhcp', STATUS.UNKNOWN, 'dhcp.untested');
  const offers = r.dhcp && Array.isArray(r.dhcp.offers) ? r.dhcp.offers : null;
  // A test that could not RUN says nothing about the network — no permission
  // for port 68, no IPv4 interface. Its reason is already in `detail`.
  if (offers === null) return rung('dhcp', STATUS.UNKNOWN, r.detail ? 'dhcp.cannotrun.detail' : 'dhcp.cannotrun', { detail: r.detail });
  if (offers.length === 0) return rung('dhcp', STATUS.FAILED, 'dhcp.none');
  const servers = [...new Set(offers.map((o) => o && (o.serverId || o.server)).filter(Boolean))];
  if (servers.length > 1) {
    // Whichever answers first hands out the default gateway and the resolver,
    // so this is a security finding as much as an availability one.
    return rung('dhcp', STATUS.FAILED, 'dhcp.several', { count: servers.length, servers: servers.slice(0, 4).join(', ') }, { servers });
  }
  return rung('dhcp', STATUS.OK, 'dhcp.one', { server: servers[0] || '?' }, { servers });
}

// The first hop of any traceroute IS the gateway this host is using — read off
// the wire rather than out of a configuration file that may not match it.
function gatewayRung(p) {
  const hop = p.firstHop;
  if (!hop) return rung('gateway', STATUS.UNKNOWN, 'gateway.untested');
  if (!hop.ip) return rung('gateway', STATUS.FAILED, 'gateway.silent');
  const loss = num(hop.lossPct);
  if (loss !== null && loss >= 50) {
    return rung('gateway', STATUS.FAILED, 'gateway.lossy', { ip: hop.ip, loss }, { gateway: hop.ip, loss_pct: loss });
  }
  if (loss !== null && loss > 0) {
    // A router rate-limiting its OWN ICMP replies while forwarding perfectly is
    // the commonest false alarm in this whole product, so it is a suspect with
    // the caveat attached, never a break.
    return rung('gateway', STATUS.SUSPECT, 'gateway.someloss', { ip: hop.ip, loss }, { gateway: hop.ip, loss_pct: loss });
  }
  return rung('gateway', STATUS.OK, 'gateway.ok', { ip: hop.ip, rtt: num(hop.rttMs) ?? '?' }, { gateway: hop.ip });
}

function resolverRung(p, cfg) {
  const r = p.dns;
  if (!r) return rung('resolver', STATUS.UNKNOWN, 'resolver.untested');
  if (!r.ok) {
    const code = r.errorCode ? String(r.errorCode).toUpperCase() : null;
    return rung('resolver', STATUS.FAILED, code ? 'resolver.failed.code' : 'resolver.failed',
      { code, resolver: r.resolver || '?' }, { resolver: r.resolver || null });
  }
  const rtt = num(r.rttMs);
  if (rtt !== null && rtt >= cfg.resolverSlowMs) {
    // Every application above it experiences a slow resolver as the network
    // being broken, which is why it is worth a sentence rather than a tick.
    return rung('resolver', STATUS.SUSPECT, 'resolver.slow', { rtt, resolver: r.resolver || '?' }, { rtt_ms: rtt });
  }
  return rung('resolver', STATUS.OK, 'resolver.ok', { rtt: rtt ?? '?', resolver: r.resolver || '?' }, { rtt_ms: rtt });
}

const DEF = {
  id: 'local_host',
  layers: LAYERS,
  locked: LOCKED,
  needs: { agents: 1, target: 'none' },
  extras: {
    errPerSec: 1,
    dropPerSec: 1,
    resolverSlowMs: 1000,
  },
  clamp(c) {
    const out = {};
    const n = (k, min, max) => { if (Number.isInteger(c[k]) && c[k] >= min && c[k] <= max) out[k] = c[k]; };
    n('errPerSec', 0, 100000);
    n('dropPerSec', 0, 100000);
    n('resolverSlowMs', 1, 60000);
    return out;
  },
  // What this ladder asks for. The DHCP test needs port 68 (root or
  // CAP_NET_BIND_SERVICE) and says so itself when it cannot run; the traceroute
  // is only here for its FIRST hop, which is the gateway.
  dispatch: ({ config }) => ({ skipped: [], specs: [
    { id: 'dhcp', probe: { type: 'dhcp' } },
    { id: 'traceroute', probe: { type: 'traceroute', host: config.probeTarget || '1.1.1.1', queries: 3 } },
    { id: 'dns', probe: { type: 'dns', host: config.probeName || 'example.com', count: 2 } },
  ] }),
  prepare: (ctx) => {
    const trace = firstOf(ctx.results, 'traceroute');
    const hops = trace && Array.isArray(trace.hops) ? trace.hops : [];
    return {
      iface: worstIface(ctx.interfaces),
      dhcp: firstOf(ctx.results, 'dhcp'),
      dns: firstOf(ctx.results, 'dns'),
      firstHop: hops.length ? hops[0] : null,
    };
  },
  rungs: {
    link: linkRung,
    duplex: duplexRung,
    errors: errorsRung,
    dhcp: dhcpRung,
    gateway: gatewayRung,
    resolver: resolverRung,
  },
};

module.exports = { DEF, LAYERS, LOCKED, worstIface };
