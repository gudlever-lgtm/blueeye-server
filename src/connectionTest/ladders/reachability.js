'use strict';

// Ladder 1 — REACHABILITY. One agent, one destination: where does the
// communication stop?
//
// The rungs are the layers a packet meets, in the order it meets them:
//
//   DNS → ARP → routing → firewall/ACL → TCP → NAT/load balancer → TLS → application
//
// Six of them are a CAUSAL chain and their relative order is locked (see
// `locked` below): a name has to resolve before a path can be walked to it; a
// packet has to reach the host before a rule can drop it; a handshake has to
// complete before TLS can negotiate over it. ARP and NAT/LB are observations
// ABOUT the path rather than steps along it, so they move freely.
//
// The rung the whole ladder is built around is the firewall one, and it is
// decided by the DIVERGENCE between ICMP and TCP rather than by either alone —
// the single most misread signal in network troubleshooting. See firewallRung.
//
// ctx: { results, host, arp } — probe rows for the agent (newest first), the
// destination as it was typed, and what the server knows about its ARP.

const net = require('net');
const { detectMiddlebox } = require('../lb');
const { STATUS, rung } = require('./registry');
const { specsFor, CHECK_IDS } = require('../checks');

// A TCP failure that means a filter dropped the packet, versus one that means
// the packet arrived and the host said no. A RST is the host answering — the
// path is open and the service is not listening, which is the application's
// problem and never the firewall's. Getting this backwards sends an operator to
// the firewall team for a service that simply is not running.
const FILTERED = new Set(['timeout', 'unreachable']);
const ANSWERED = new Set(['refused']);

const LAYERS = ['dns', 'arp', 'routing', 'firewall', 'tcp', 'nat_lb', 'tls', 'application'];
const LOCKED = ['dns', 'routing', 'firewall', 'tcp', 'tls', 'application'];

const isIp = (h) => net.isIP(String(h || '').trim()) !== 0;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// --- picking the rows that belong to this destination ------------------------

// Probe targets are written differently per type: a bare host for ping/dns/
// traceroute/path_mtu, `host:port` for tcp/tcptraceroute/tls, and a full URL for
// http. One function so a row can never be attributed to the wrong destination.
function targetHost(row) {
  if (!row || typeof row.target !== 'string') return null;
  const t = row.target.trim();
  if (!t) return null;
  if (row.type === 'http' || row.type === 'curl' || row.type === 'pageload') {
    try { return new URL(t).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
  }
  // `host:port`, including a bracketed IPv6 literal. A bare IPv6 address has
  // colons of its own, so it is tested as an address before it is split.
  if (net.isIP(t) !== 0) return t.toLowerCase();
  const bracket = t.match(/^\[(.+)\](?::\d+)?$/);
  if (bracket) return bracket[1].toLowerCase();
  const idx = t.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(t.slice(idx + 1))) return t.slice(0, idx).toLowerCase();
  return t.toLowerCase();
}

function targetPort(row) {
  if (!row || typeof row.target !== 'string') return null;
  const m = row.target.match(/:(\d+)$/);
  return m ? Number(m[1]) : null;
}

// Newest row per type for this destination, plus every tcp row kept by port —
// the ICMP/TCP divergence needs each port separately, and one `tcp` slot would
// throw away the :80 answer the moment the :443 one arrived.
function collect(results, host) {
  const want = String(host || '').trim().toLowerCase();
  const by = {};
  const tcp = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r.type !== 'string') continue;
    if (want && targetHost(r) !== want) continue;
    if (r.type === 'tcp') {
      const port = targetPort(r);
      if (port === null || tcp.has(port)) continue;
      tcp.set(port, r);
      continue;
    }
    if (by[r.type] === undefined) by[r.type] = r;
  }
  return { by, tcp };
}

// --- the rungs ---------------------------------------------------------------

function dnsRung(by, host) {
  if (isIp(host)) return rung('dns', STATUS.NA, 'dns.na', { host });
  const r = by.dns;
  if (!r) return rung('dns', STATUS.UNKNOWN, 'dns.untested');
  if (r.ok) {
    return rung('dns', STATUS.OK, r.resolver ? 'dns.ok.via' : 'dns.ok',
      { rtt: num(r.rttMs) ?? '?', resolver: r.resolver }, { rtt_ms: num(r.rttMs) });
  }
  const code = r.errorCode ? String(r.errorCode).toUpperCase() : null;
  const key = code && r.resolver ? 'dns.failed.code_via'
    : code ? 'dns.failed.code'
      : r.resolver ? 'dns.failed.via' : 'dns.failed';
  return rung('dns', STATUS.FAILED, key, { code, resolver: r.resolver }, { error_code: code });
}

// ARP is only on the path when the destination is on the agent's own segment.
// Off-segment, the packet is handed to the default gateway and the destination's
// MAC is never asked for, so "no ARP entry" is not a finding — it is the correct
// state. `arp` is what the server already knows from arp_entries; absent means
// nobody has reported this address, which on a routed path means nothing at all.
function arpRung(by, host, arp) {
  if (!isIp(host)) return rung('arp', STATUS.NA, 'arp.name');
  // No context at all means nobody asked — not that the answer was no. The two
  // have to stay apart: "ARP is not on the path" rules the rung out of the
  // diagnosis, and doing that on no evidence would hide a real layer-2 fault.
  if (!arp) return rung('arp', STATUS.UNKNOWN, 'arp.unknown.none');
  if (arp.onLocalSegment === false) return rung('arp', STATUS.NA, 'arp.na.remote', { host });
  if (arp.onLocalSegment !== true) return rung('arp', STATUS.UNKNOWN, 'arp.unknown.segments');
  if (arp.mac) {
    const full = Boolean(arp.source && arp.lastSeen);
    return rung('arp', STATUS.OK, full ? 'arp.ok.seen' : 'arp.ok',
      { host, mac: arp.mac, source: arp.source, lastSeen: arp.lastSeen }, { mac: arp.mac });
  }
  return rung('arp', STATUS.FAILED, 'arp.failed', { host });
}

function routingRung(by, host, lossThresholdPct) {
  const r = by.traceroute;
  if (!r) return rung('routing', STATUS.UNKNOWN, 'routing.untested');
  const hops = Array.isArray(r.hops) ? r.hops : [];
  if (!hops.length) return rung('routing', STATUS.UNKNOWN, 'routing.nohops');
  // Did the trace get there? A traceroute stops when the destination answers,
  // so the last hop having an address IS the arrival — comparing hop addresses
  // against the target only works when the target was typed as an address, and
  // reading a name against them marks every successful trace to a hostname as
  // never having arrived.
  const last = hops[hops.length - 1];
  const reached = Boolean(last && last.ip)
    || hops.some((h) => h && h.ip && String(h.ip).toLowerCase() === String(host).toLowerCase());
  // Sustained loss — loss at one hop that continues to the end. Loss at a
  // single middle hop that stops is the router rate-limiting its own replies
  // while forwarding perfectly, and reading it as a fault is the commonest way
  // a traceroute is misread.
  let from = null;
  for (let i = 0; i < hops.length; i += 1) {
    const loss = num(hops[i] && hops[i].lossPct);
    if (loss === null || loss < lossThresholdPct) continue;
    if (hops.slice(i + 1).every((h) => (num(h && h.lossPct) ?? -1) >= lossThresholdPct)) { from = num(hops[i].hop) ?? i + 1; break; }
    break;
  }
  if (from !== null && from > 0 && !reached) {
    return rung('routing', STATUS.FAILED, 'routing.failed', { hop: from, host }, { hop: from, hop_count: hops.length });
  }
  if (from !== null && from > 0) {
    return rung('routing', STATUS.SUSPECT, 'routing.suspect.loss', { hop: from, host }, { hop: from, hop_count: hops.length });
  }
  if (!reached) {
    return rung('routing', STATUS.SUSPECT, 'routing.suspect.noreply', { hops: hops.length }, { hop_count: hops.length });
  }
  return rung('routing', STATUS.OK, 'routing.ok', { hops: hops.length, host }, { hop_count: hops.length });
}

// The rung the whole module is built around.
//
// ICMP and TCP are different traffic. A firewall rule, an ACL or a security
// group can permit one and deny the other, and when it does the network looks
// perfect and the application is dead. The verdict comes from the DIVERGENCE:
//
//   ping ok  + port timed out   → a filter. The packets are dropped in silence,
//                                 which is what a deny rule does and what a
//                                 host that is down cannot do (it is answering
//                                 ICMP).
//   ping ok  + port refused     → NOT a filter. A RST is the host answering:
//                                 the path is open, nothing is listening. The
//                                 firewall is fine and the service is not.
//   ping bad + port bad         → not answerable here. Both directions are
//                                 broken, which is the path's problem, and
//                                 routing already owns it.
//   ping bad + port ok          → ICMP is filtered and the application path is
//                                 open. Worth saying out loud, because an
//                                 ICMP-only monitor calls this an outage.
function firewallRung(by, tcp) {
  const ping = by.ping;
  const ports = [...tcp.entries()].map(([port, r]) => ({ port, r }));
  if (!ping && !ports.length) return rung('firewall', STATUS.UNKNOWN, 'firewall.untested.both');
  if (!ping) return rung('firewall', STATUS.UNKNOWN, 'firewall.untested.noping');
  if (!ports.length) return rung('firewall', STATUS.UNKNOWN, 'firewall.untested.noports');

  const icmpOk = ping.ok === true;
  const filtered = ports.filter((p) => !p.r.ok && FILTERED.has(String(p.r.failure || '')));
  const refused = ports.filter((p) => !p.r.ok && ANSWERED.has(String(p.r.failure || '')));
  const open = ports.filter((p) => p.r.ok);
  const unexplained = ports.filter((p) => !p.r.ok && !FILTERED.has(String(p.r.failure || '')) && !ANSWERED.has(String(p.r.failure || '')));

  const list = (set) => set.map((p) => p.port).join(', ');
  if (icmpOk && filtered.length) {
    return rung('firewall', STATUS.FAILED,
      filtered.length > 1 ? 'firewall.failed.many' : 'firewall.failed.one', { ports: list(filtered) },
      { icmp_ok: true, filtered_ports: filtered.map((p) => p.port), open_ports: open.map((p) => p.port) });
  }
  if (icmpOk && refused.length && !open.length) {
    return rung('firewall', STATUS.OK, 'firewall.ok.refused', { ports: list(refused) },
      { icmp_ok: true, refused_ports: refused.map((p) => p.port) });
  }
  if (!icmpOk && open.length) {
    return rung('firewall', STATUS.SUSPECT, 'firewall.suspect.icmp', { ports: list(open) },
      { icmp_ok: false, open_ports: open.map((p) => p.port) });
  }
  if (!icmpOk) return rung('firewall', STATUS.UNKNOWN, 'firewall.unknown.bothdown');
  if (unexplained.length) return rung('firewall', STATUS.UNKNOWN, 'firewall.unknown.unclassified', { ports: list(unexplained) });
  return rung('firewall', STATUS.OK, 'firewall.ok', { ports: list(open) },
    { icmp_ok: true, open_ports: open.map((p) => p.port) });
}

function tcpRung(tcp) {
  const ports = [...tcp.entries()].map(([port, r]) => ({ port, r }));
  if (!ports.length) return rung('tcp', STATUS.UNKNOWN, 'tcp.untested');
  const open = ports.filter((p) => p.r.ok);
  if (open.length) {
    const fastest = open.reduce((a, b) => ((num(b.r.rttMs) ?? Infinity) < (num(a.r.rttMs) ?? Infinity) ? b : a));
    const shut = ports.filter((p) => !p.r.ok).map((p) => p.port);
    return rung('tcp', STATUS.OK, shut.length ? 'tcp.ok.partial' : 'tcp.ok',
      { ports: open.map((p) => p.port).join(', '), rtt: num(fastest.r.rttMs) ?? '?', shut: shut.join(', ') },
      { open_ports: open.map((p) => p.port), rtt_ms: num(fastest.r.rttMs) });
  }
  // `refused` / `timeout` / `unreachable` are the agent's own classification —
  // protocol words, the same in every locale.
  const how = ports.map((p) => `${p.port} ${p.r.failure || 'failed'}`).join(', ');
  return rung('tcp', STATUS.FAILED, 'tcp.failed', { detail: how }, { closed_ports: ports.map((p) => p.port) });
}

function natLbRung(by, host) {
  const found = detectMiddlebox({
    traceroute: by.traceroute || null,
    tcptraceroute: by.tcptraceroute || null,
    tls: by.tls || null,
    http: by.http || null,
    host,
  });
  if (found.present === null) {
    return rung('nat_lb', STATUS.UNKNOWN, 'natlb.untested', null, { evidence: found.evidence });
  }
  const lead = found.evidence[0];
  if (found.present === false) {
    // The rung's sentence IS the evidence's, so it uses the evidence's own key.
    return rung('nat_lb', STATUS.OK, lead.key, lead.params, { evidence: found.evidence });
  }
  // A middlebox is not a fault. It is a thing that changes what every rung
  // above it is measuring, and it is reported so the operator knows whose
  // health to go and read. `evidence` is the leading finding's own sentence,
  // rendered first and then wrapped — one nesting level, resolved at render.
  return rung('nat_lb', STATUS.SUSPECT, 'natlb.suspect', { evidence: { key: lead.key, params: lead.params } },
    { basis: found.basis, evidence: found.evidence });
}

function tlsRung(by, certWarnDays) {
  const r = by.tls;
  if (!r) return rung('tls', STATUS.UNKNOWN, 'tls.untested');
  if (r.ok) {
    const days = num(r.certExpiryDays);
    if (days !== null && days <= certWarnDays) {
      return rung('tls', STATUS.SUSPECT, 'tls.suspect.expiry', { days }, { expiry_days: days });
    }
    return rung('tls', STATUS.OK, days !== null ? 'tls.ok.days' : 'tls.ok', { days }, { expiry_days: days });
  }
  // The agent's own clause is quoted inside a translated frame rather than
  // replacing it — it is a measurement in the words of the thing that measured
  // it, and an operator may need to match it against a log.
  return rung('tls', STATUS.FAILED, r.detail ? 'tls.failed' : 'tls.failed.nodetail',
    { detail: r.detail }, { expiry_days: num(r.certExpiryDays) });
}

function applicationRung(by) {
  const r = by.http;
  if (!r) return rung('application', STATUS.UNKNOWN, 'app.untested');
  const status = num(r.status);
  if (r.ok) {
    return rung('application', STATUS.OK, 'app.ok',
      { status: status ?? '?', rtt: num(r.rttMs) ?? '?' }, { http_status: status, rtt_ms: num(r.rttMs) });
  }
  if (status === null) {
    return rung('application', STATUS.FAILED, r.detail ? 'app.failed.norequest.detail' : 'app.failed.norequest',
      { detail: r.detail }, { http_status: null });
  }
  if (status >= 500) return rung('application', STATUS.FAILED, 'app.failed.5xx', { status }, { http_status: status });
  if (status >= 400) return rung('application', STATUS.FAILED, 'app.failed.4xx', { status }, { http_status: status });
  return rung('application', STATUS.FAILED, 'app.failed.other', { status }, { http_status: status });
}

// --- the definition ----------------------------------------------------------

const DEF = {
  id: 'reachability',
  layers: LAYERS,
  locked: LOCKED,
  needs: { agents: 1, target: 'host' },
  extras: {
    // The ports the TCP and firewall rungs read. 80 and 443 are the default and
    // the wrong answer for an estate on 8443, 22 or 1433 — which is most of the
    // reason any of this is configurable.
    ports: [80, 443],
    // A certificate this close to expiry is worth saying out loud without being
    // a break.
    certWarnDays: 14,
    // Per-hop loss at or above this, sustained to the end of the trace, is the
    // routing rung's break. Below it, it is a router rate-limiting its own ICMP.
    lossThresholdPct: 5,
  },
  clamp(c) {
    const out = {};
    const ports = Array.isArray(c.ports)
      ? [...new Set(c.ports.filter((p) => Number.isInteger(p) && p > 0 && p <= 65535))]
      : [];
    if (ports.length) out.ports = ports;
    if (Number.isInteger(c.certWarnDays) && c.certWarnDays >= 0 && c.certWarnDays <= 365) out.certWarnDays = c.certWarnDays;
    if (Number.isInteger(c.lossThresholdPct) && c.lossThresholdPct >= 1 && c.lossThresholdPct <= 100) out.lossThresholdPct = c.lossThresholdPct;
    return out;
  },
  // The check catalogue owns WHAT a run pushes — it is the same list the screen
  // shows, so a check offered there is always one the server can send. This
  // ladder adds the ports Settings asked for on top of it.
  dispatch: ({ host, config }) => specsFor(host, CHECK_IDS, { ports: config.ports }),
  // Sorting the probe rows by type is the one thing every rung needs, so it
  // happens once here rather than eight times below.
  prepare: (ctx) => ({ ...collect(ctx.results, ctx.host), host: ctx.host, arp: ctx.arp }),
  rungs: {
    dns: (p) => dnsRung(p.by, p.host),
    arp: (p) => arpRung(p.by, p.host, p.arp),
    routing: (p, cfg) => routingRung(p.by, p.host, cfg.lossThresholdPct),
    firewall: (p) => firewallRung(p.by, p.tcp),
    tcp: (p) => tcpRung(p.tcp),
    nat_lb: (p) => natLbRung(p.by, p.host),
    tls: (p, cfg) => tlsRung(p.by, cfg.certWarnDays),
    application: (p) => applicationRung(p.by),
  },
};

module.exports = { DEF, LAYERS, LOCKED, FILTERED, ANSWERED, targetHost, targetPort, collect };
