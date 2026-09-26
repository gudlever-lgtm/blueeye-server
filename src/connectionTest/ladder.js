'use strict';

// The ladder: where does the communication stop?
//
// "I cannot reach X" is answered nine times over by the Connection Test, one
// row per check, and an operator still has to read nine rows and work out which
// one matters. This module is the reading. It walks the checks in the order the
// packets themselves go through them —
//
//   DNS → ARP → routing → firewall/ACL → TCP → NAT/load balancer → TLS → application
//
// — and names the FIRST rung that breaks. Everything below a break is the
// answer; everything above it has not been reached yet and is reported as
// untested rather than as healthy, because a green tick on a layer that was
// never exercised is the lie this module exists to stop.
//
// Four rules hold the whole thing up.
//
// 1. A rung is only decided by a measurement. No check, no verdict: the rung
//    reads `unknown`, and `unknown` is never silently promoted to `ok`. The
//    difference between "we looked and it is fine" and "nobody looked" is the
//    difference between a diagnosis and a guess.
//
// 2. A rung says WHY in the same breath. Every status carries `because` — the
//    measurement that decided it, in a sentence — so the screen never shows a
//    red rung whose reason lives somewhere else.
//
// 3. The order is the packet's order, not the model's tidiness. The firewall
//    rung sits between routing and TCP because that is where a filter acts, and
//    it is decided by the DIVERGENCE between ICMP and TCP rather than by either
//    on its own. That divergence is the single most misread signal in network
//    troubleshooting: ping works, TCP/443 does not, and the network gets blamed
//    for a rule somebody wrote.
//
// 4. Nothing here re-measures. Every input is an ordinary probe result already
//    in `probe_results`, so the ladder can be recomputed from history, and a
//    rung can never disagree with the row it was read from.
//
// Pure: results in, a verdict out. No database, no clock, no network.

const net = require('net');
const { detectMiddlebox } = require('./lb');

// Status vocabulary. Deliberately five words, not three: "not measured" and
// "not applicable" are different answers, and both are different from "fine".
const STATUS = {
  OK: 'ok',              // measured, and it works
  FAILED: 'failed',      // measured, and it is broken — a candidate for the stop
  SUSPECT: 'suspect',    // measured, and something is off without being a break
  UNKNOWN: 'unknown',    // not measured, or measured and it cannot decide
  NA: 'not_applicable',  // the question does not apply to this destination
  UNREACHED: 'unreached',// below the stop: never exercised, so it has no verdict
};

// The rungs, in the order a packet meets them.
const LAYERS = ['dns', 'arp', 'routing', 'firewall', 'tcp', 'nat_lb', 'tls', 'application'];

// A TCP failure that means a filter dropped the packet, versus one that means
// the packet arrived and the host said no. A RST is the host answering — the
// path is open and the service is not listening, which is the application's
// problem and never the firewall's. Getting this backwards sends an operator to
// the firewall team for a service that simply is not running.
const FILTERED = new Set(['timeout', 'unreachable']);
const ANSWERED = new Set(['refused']);

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

// The canonical three fields are written LAST on purpose: an extra called
// `status` (the HTTP one) would otherwise overwrite the rung's own status and
// the ladder would report a number where it means to report a verdict.
const rung = (layer, status, because, extra = {}) => ({ ...extra, layer, status, because });

function dnsRung(by, host) {
  if (isIp(host)) return rung('dns', STATUS.NA, `${host} is an address, so there is no name to resolve`);
  const r = by.dns;
  if (!r) return rung('dns', STATUS.UNKNOWN, 'no DNS lookup was run against this name');
  if (r.ok) return rung('dns', STATUS.OK, `the name resolved in ${num(r.rttMs) ?? '?'} ms${r.resolver ? ` via ${r.resolver}` : ''}`, { rtt_ms: num(r.rttMs) });
  const code = r.errorCode ? String(r.errorCode).toUpperCase() : null;
  return rung('dns', STATUS.FAILED,
    `the name did not resolve${code ? ` (${code})` : ''}${r.resolver ? ` — resolver ${r.resolver}` : ''}. Nothing above this rung was ever addressed`,
    { error_code: code });
}

// ARP is only on the path when the destination is on the agent's own segment.
// Off-segment, the packet is handed to the default gateway and the destination's
// MAC is never asked for, so "no ARP entry" is not a finding — it is the correct
// state. `arp` is what the server already knows from arp_entries; absent means
// nobody has reported this address, which on a routed path means nothing at all.
function arpRung(by, host, arp) {
  if (!isIp(host)) {
    return rung('arp', STATUS.NA, 'ARP resolves addresses, not names — this rung is answered once the name has resolved to an address on the local segment');
  }
  // No context at all means nobody asked — not that the answer was no. The two
  // have to stay apart: "ARP is not on the path" rules the rung out of the
  // diagnosis, and doing that on no evidence would hide a real layer-2 fault.
  if (!arp) {
    return rung('arp', STATUS.UNKNOWN, 'nothing is known about this address\'s neighbour table, so whether ARP is on the path to it cannot be said');
  }
  if (arp.onLocalSegment === false) {
    return rung('arp', STATUS.NA, `${host} is not on the agent's own segment, so the packet goes to the gateway and this address is never ARPed`);
  }
  if (arp.onLocalSegment !== true) {
    return rung('arp', STATUS.UNKNOWN, 'the agent has not reported which segments it is on, so whether ARP is on the path to this address cannot be said');
  }
  if (arp.mac) {
    return rung('arp', STATUS.OK, `${host} is at ${arp.mac}${arp.source ? ` (seen by ${arp.source})` : ''}${arp.lastSeen ? `, last seen ${arp.lastSeen}` : ''}`, { mac: arp.mac });
  }
  return rung('arp', STATUS.FAILED,
    `${host} is on the agent's segment and no MAC has ever been reported for it — nothing on this segment answered for that address`);
}

function routingRung(by, host) {
  const r = by.traceroute;
  if (!r) return rung('routing', STATUS.UNKNOWN, 'no traceroute was run, so the path was never walked');
  const hops = Array.isArray(r.hops) ? r.hops : [];
  if (!hops.length) return rung('routing', STATUS.UNKNOWN, 'the traceroute returned no hops');
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
    if (loss === null || loss < 5) continue;
    if (hops.slice(i + 1).every((h) => (num(h && h.lossPct) ?? -1) >= 5)) { from = num(hops[i].hop) ?? i + 1; break; }
    break;
  }
  if (from !== null && from > 0 && !reached) {
    return rung('routing', STATUS.FAILED, `the path loses packets from hop ${from} onwards and never reaches ${host}`, { hop: from, hop_count: hops.length });
  }
  if (from !== null && from > 0) {
    return rung('routing', STATUS.SUSPECT, `the path reaches ${host} but loses packets from hop ${from} onwards`, { hop: from, hop_count: hops.length });
  }
  if (!reached) {
    return rung('routing', STATUS.SUSPECT, `the trace ran ${hops.length} hops without the destination answering — normal where the last hop filters ICMP, so this alone is not a break`, { hop_count: hops.length });
  }
  return rung('routing', STATUS.OK, `${hops.length} hops to ${host}, no sustained loss`, { hop_count: hops.length });
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
  if (!ping && !ports.length) return rung('firewall', STATUS.UNKNOWN, 'neither ICMP nor a TCP port was tested, so nothing can be said about filtering');
  if (!ping) return rung('firewall', STATUS.UNKNOWN, 'no ping was run, so a TCP failure cannot be told apart from a host that is down');
  if (!ports.length) return rung('firewall', STATUS.UNKNOWN, 'no TCP port was tested, so a filter that permits ICMP and denies the application port would not show');

  const icmpOk = ping.ok === true;
  const filtered = ports.filter((p) => !p.r.ok && FILTERED.has(String(p.r.failure || '')));
  const refused = ports.filter((p) => !p.r.ok && ANSWERED.has(String(p.r.failure || '')));
  const open = ports.filter((p) => p.r.ok);
  const unexplained = ports.filter((p) => !p.r.ok && !FILTERED.has(String(p.r.failure || '')) && !ANSWERED.has(String(p.r.failure || '')));

  if (icmpOk && filtered.length) {
    const list = filtered.map((p) => p.port).join(', ');
    return rung('firewall', STATUS.FAILED,
      `ICMP is answered and TCP/${list} ${filtered.length > 1 ? 'are' : 'is'} dropped in silence — a firewall rule, an ACL or a security group permitting ping and denying the application port. A host that was down could not answer the ping`,
      { icmp_ok: true, filtered_ports: filtered.map((p) => p.port), open_ports: open.map((p) => p.port) });
  }
  if (icmpOk && refused.length && !open.length) {
    return rung('firewall', STATUS.OK,
      `ICMP is answered and TCP/${refused.map((p) => p.port).join(', ')} came back refused — a reset is the host answering, so nothing is filtering. The port is closed, which is the service's problem and not the network's`,
      { icmp_ok: true, refused_ports: refused.map((p) => p.port) });
  }
  if (!icmpOk && open.length) {
    return rung('firewall', STATUS.SUSPECT,
      `ping does not come back but TCP/${open.map((p) => p.port).join(', ')} connects — ICMP is filtered somewhere and the application path is open. An ICMP-only monitor calls this an outage; it is not one`,
      { icmp_ok: false, open_ports: open.map((p) => p.port) });
  }
  if (!icmpOk) {
    return rung('firewall', STATUS.UNKNOWN,
      'neither ICMP nor TCP comes back — both directions are broken, so this is the path rather than a rule that permits one and denies the other');
  }
  if (unexplained.length) {
    return rung('firewall', STATUS.UNKNOWN,
      `TCP/${unexplained.map((p) => p.port).join(', ')} failed and the agent did not report how, so a drop cannot be told from a reset (update the agent for refused/timeout)`);
  }
  return rung('firewall', STATUS.OK,
    `ICMP is answered and TCP/${open.map((p) => p.port).join(', ')} connects — nothing between the agent and the destination is filtering either`,
    { icmp_ok: true, open_ports: open.map((p) => p.port) });
}

function tcpRung(tcp) {
  const ports = [...tcp.entries()].map(([port, r]) => ({ port, r }));
  if (!ports.length) return rung('tcp', STATUS.UNKNOWN, 'no TCP port was tested');
  const open = ports.filter((p) => p.r.ok);
  if (open.length) {
    const fastest = open.reduce((a, b) => ((num(b.r.rttMs) ?? Infinity) < (num(a.r.rttMs) ?? Infinity) ? b : a));
    const shut = ports.filter((p) => !p.r.ok).map((p) => p.port);
    return rung('tcp', STATUS.OK,
      `the handshake completes on TCP/${open.map((p) => p.port).join(', ')} in ${num(fastest.r.rttMs) ?? '?'} ms${shut.length ? ` (TCP/${shut.join(', ')} did not)` : ''}`,
      { open_ports: open.map((p) => p.port), rtt_ms: num(fastest.r.rttMs) });
  }
  const how = ports.map((p) => `${p.port} ${p.r.failure || 'failed'}`).join(', ');
  return rung('tcp', STATUS.FAILED, `no handshake completed — TCP/${how}`, { closed_ports: ports.map((p) => p.port) });
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
    return rung('nat_lb', STATUS.UNKNOWN,
      'the ICMP and TCP paths were not both walked, so whether something answers for the destination cannot be said. Not the same as nothing being there',
      { evidence: found.evidence });
  }
  if (found.present === false) {
    return rung('nat_lb', STATUS.OK, found.evidence[0].text, { evidence: found.evidence });
  }
  // A middlebox is not a fault. It is a thing that changes what every rung
  // above it is measuring, and it is reported so the operator knows whose
  // health to go and read.
  return rung('nat_lb', STATUS.SUSPECT,
    `${found.evidence[0].text}. Whatever answers above this rung may be the middlebox rather than the service behind it`,
    { basis: found.basis, evidence: found.evidence });
}

function tlsRung(by) {
  const r = by.tls;
  if (!r) return rung('tls', STATUS.UNKNOWN, 'no TLS handshake was attempted');
  if (r.ok) {
    const days = num(r.certExpiryDays);
    if (days !== null && days <= 14) {
      return rung('tls', STATUS.SUSPECT, `the handshake completes and the certificate is valid, but it expires in ${days} days`, { expiry_days: days });
    }
    return rung('tls', STATUS.OK, r.detail || `the handshake completes and the certificate is valid${days !== null ? ` for another ${days} days` : ''}`, { expiry_days: days });
  }
  return rung('tls', STATUS.FAILED, r.detail || 'the TLS handshake did not complete', { expiry_days: num(r.certExpiryDays) });
}

function applicationRung(by) {
  const r = by.http;
  if (!r) return rung('application', STATUS.UNKNOWN, 'the service itself was never asked for anything — every rung below only proves the packets arrive');
  const status = num(r.status);
  if (r.ok) return rung('application', STATUS.OK, `the service answered HTTP ${status ?? '?'} in ${num(r.rttMs) ?? '?'} ms`, { http_status: status, rtt_ms: num(r.rttMs) });
  if (status === null) return rung('application', STATUS.FAILED, r.detail || 'the request did not complete — nothing answered on the application port', { http_status: null });
  if (status >= 500) return rung('application', STATUS.FAILED, `the service answered HTTP ${status} — it reached the code and the code failed`, { http_status: status });
  if (status >= 400) return rung('application', STATUS.FAILED, `the service answered HTTP ${status} — it is running and it refused the request`, { http_status: status });
  return rung('application', STATUS.FAILED, r.detail || `the service answered HTTP ${status}`, { http_status: status });
}

// --- the walk ----------------------------------------------------------------

// Walk the ladder for one destination.
//
//   results  probe rows for the agent, newest-first (probeResultsRepository's
//            shape). Rows for other destinations are ignored, not mis-read.
//   host     the destination, as it was typed
//   arp      { onLocalSegment, mac, source, lastSeen } — what the server knows
//            about this address from arp_entries, or null when it knows nothing
//   symptom  what the operator said was wrong, echoed back so the answer sits
//            next to the question. Never parsed, never trusted, never executed
//
// Returns { host, symptom, layers[], stopsAt, verdict, tested, untested }.
function walk({ results = [], host = '', arp = null, symptom = null } = {}) {
  const { by, tcp } = collect(results, host);

  const computed = {
    dns: dnsRung(by, host),
    arp: arpRung(by, host, arp),
    routing: routingRung(by, host),
    firewall: firewallRung(by, tcp),
    tcp: tcpRung(tcp),
    nat_lb: natLbRung(by, host),
    tls: tlsRung(by),
    application: applicationRung(by),
  };

  // The first break is the answer. Everything above it is reported as
  // `unreached` and keeps its own reading in `would_have_said`, so an operator
  // can see that the rung was measured without the screen claiming it means
  // anything: a TLS handshake that "succeeded" to a load balancer while DNS
  // pointed at the wrong address is not evidence that TLS is fine.
  const layers = [];
  let stopsAt = null;
  for (const id of LAYERS) {
    const r = computed[id];
    if (stopsAt === null) {
      layers.push(r);
      if (r.status === STATUS.FAILED) stopsAt = id;
      continue;
    }
    layers.push(r.status === STATUS.UNKNOWN || r.status === STATUS.NA
      ? r
      : rung(id, STATUS.UNREACHED, `not reached — the communication already stops at ${stopsAt}`, { would_have_said: r.status }));
  }

  const decided = layers.filter((l) => l.status === STATUS.OK || l.status === STATUS.FAILED || l.status === STATUS.SUSPECT);
  const untested = layers.filter((l) => l.status === STATUS.UNKNOWN).map((l) => l.layer);
  const stop = stopsAt ? layers.find((l) => l.layer === stopsAt) : null;
  const suspects = layers.filter((l) => l.status === STATUS.SUSPECT);

  let verdict;
  if (stop) {
    // A rung that is odd without being broken still belongs in the answer when
    // something below it broke: a load balancer in the path is exactly what
    // explains a healthy handshake under a dead service, and leaving it out of
    // the sentence sends the operator to the wrong team.
    const also = suspects.filter((sp) => LAYERS.indexOf(sp.layer) < LAYERS.indexOf(stopsAt));
    verdict = {
      outcome: 'stops',
      layer: stopsAt,
      text: `The communication stops at ${stopsAt}: ${stop.because}.${also.length ? ` Also worth knowing — ${also.map((sp) => `${sp.layer}: ${sp.because}`).join('. ')}.` : ''}`,
    };
  } else if (decided.length === 0) {
    verdict = { outcome: 'untested', layer: null, text: 'Nothing has been measured against this destination yet, so there is no verdict — run the ladder.' };
  } else if (suspects.length) {
    // "No rung is broken" would overclaim while half the ladder is untested, so
    // the sentence says which half it is speaking for.
    verdict = {
      outcome: 'suspect',
      layer: suspects[0].layer,
      text: `No rung that was measured is broken. ${suspects.map((sp) => `${sp.layer}: ${sp.because}`).join('. ')}.${untested.length ? ` ${untested.join(', ')} ${untested.length > 1 ? 'were' : 'was'} not tested.` : ''}`,
    };
  } else if (untested.length) {
    verdict = {
      outcome: 'partial',
      layer: null,
      text: `Every rung that was measured is healthy. ${untested.join(', ')} ${untested.length > 1 ? 'were' : 'was'} not tested, so the ladder is not complete.`,
    };
  } else {
    verdict = { outcome: 'clear', layer: null, text: 'Every rung answered and none of them is broken — the fault is not on the path to this destination.' };
  }

  return {
    host,
    symptom: symptom ? String(symptom).slice(0, 500) : null,
    layers,
    stopsAt,
    verdict,
    tested: decided.map((l) => l.layer),
    untested,
  };
}

module.exports = { walk, STATUS, LAYERS, targetHost, targetPort, collect, FILTERED, ANSWERED };
