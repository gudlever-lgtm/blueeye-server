'use strict';

// WHY a DNS or TCP probe failed, in the sentence a finding carries.
//
// "3/5 probe targets not responding" was the whole explanation for a failed
// DNS or TCP probe, and it hid the one thing that decides who has to act:
//
//   DNS  ENOTFOUND — the resolver ANSWERED that the name does not exist. The
//                    network is fine; the zone (or the name asked for) is wrong.
//        ETIMEOUT  — the resolver did not answer. The resolver is down, or
//                    something between here and it drops port 53.
//        ESERVFAIL — the resolver answered "I could not". Its upstream or the
//                    zone's DNSSEC is broken; the path to it works.
//        refused   — nothing listens on 53 there, or it will not recurse for us.
//   TCP  refused   — a RST came back: the host is up, and either nothing listens
//                    on the port or an ACL rejects the connection.
//        timeout   — nothing came back at all: a filter drops the SYN silently,
//                    or the host is down.
//
// And one cross-check a technician makes by reflex: when ICMP to the same host
// still works while TCP to one port fails, the host is up and the fault is in
// what sits in front of that one port — "ICMP ok, TCP/443 blocked".
//
// Pure: rows in (newest-first, as the probe pipeline passes them), a
// description out. Every statement is traceable to a stored field (errorCode,
// failure, resolver, the ping row it compared against), and nothing is guessed:
// an older agent that reported no code gets no claim about the kind of failure.

// DNS error codes → [short label, what it means]. The codes are node's
// (dns.NOTFOUND etc.) plus getaddrinfo's EAI_* forms, which the OS resolver path
// (dns.lookup) reports instead.
const DNS_CODES = {
  ENOTFOUND: ['NXDOMAIN', 'the name does not exist — the resolver answered, the record is missing'],
  ENODATA: ['NODATA', 'the name exists but has no record of the requested type'],
  EAI_NONAME: ['NXDOMAIN', 'the name does not exist — the resolver answered, the record is missing'],
  ETIMEOUT: ['timeout', 'the resolver did not answer — resolver down or port 53 filtered on the way'],
  ETIMEDOUT: ['timeout', 'the resolver did not answer — resolver down or port 53 filtered on the way'],
  EAI_AGAIN: ['timeout', 'the resolver did not answer in time (temporary failure) — resolver down, overloaded or unreachable'],
  ESERVFAIL: ['SERVFAIL', 'the resolver answered SERVFAIL — its upstream or the zone (often DNSSEC) is broken, the path to it works'],
  EREFUSED: ['REFUSED', 'the resolver refused the query — it does not recurse for this client (ACL)'],
  ECONNREFUSED: ['refused', 'the connection to the resolver was refused — nothing listens on port 53 there'],
  ENETUNREACH: ['unreachable', 'no route to the resolver'],
  EHOSTUNREACH: ['unreachable', 'the resolver host is unreachable'],
};

// TCP failure classes, as the agent names them.
const TCP_FAILURES = {
  refused: ['refused', 'actively refused (RST) — service down or an ACL rejects the connection'],
  timeout: ['timeout', 'timed out — silently dropped (firewall/filter) or the host is down'],
  unreachable: ['unreachable', 'host or network unreachable — no route, or an ICMP unreachable came back'],
  error: ['error', 'the connection failed'],
};

// Socket errnos that name a TCP failure class, for a row that carried a code
// but no classification.
const TCP_CODE_CLASS = {
  ECONNREFUSED: 'refused',
  ETIMEDOUT: 'timeout',
  ETIMEOUT: 'timeout',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
};

// "host:port" → { host, port }. IPv6 literals come as "[::1]:443" or, from the
// agent's own formatting, "::1:443" — the port is always the last colon group.
function splitHostPort(target) {
  const s = String(target || '');
  const br = /^\[([^\]]+)\]:(\d{1,5})$/.exec(s);
  if (br) return { host: br[1], port: Number(br[2]) };
  const i = s.lastIndexOf(':');
  if (i <= 0) return { host: s, port: null };
  const port = Number(s.slice(i + 1));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { host: s.slice(0, i), port } : { host: s, port: null };
}

// The newest ping to `host` in the rows, or null. Rows are newest-first.
function latestPing(rows, host) {
  for (const r of rows || []) {
    if (r && r.type === 'ping' && r.target === host) return r;
  }
  return null;
}

// Describes why ONE failed dns/tcp row failed. Returns null for any other row
// type, or for a row that succeeded.
//
//   { type, target, kind, code, resolver, text, icmpOk, port }
//
// `kind` is the short class ('NXDOMAIN', 'timeout', 'refused', …) or null when
// the agent did not say; `text` is the clause that goes into the sentence.
function describeFailure(row, rows = []) {
  if (!row || row.ok) return null;
  if (row.type === 'dns') {
    const code = row.errorCode ? String(row.errorCode).toUpperCase() : null;
    const known = code ? DNS_CODES[code] : null;
    const via = row.resolver ? ` (resolver ${row.resolver})` : '';
    let text;
    if (known) text = `DNS lookup of ${row.target} failed with ${known[0]}${code !== known[0] ? ` (${code})` : ''}${via}: ${known[1]}`;
    else if (code) text = `DNS lookup of ${row.target} failed (${code})${via}`;
    else text = `DNS lookup of ${row.target} failed${via} — the agent did not report why (update the agent for the error code)`;
    return {
      type: 'dns', target: row.target, kind: known ? known[0] : null, code, resolver: row.resolver || null,
      text, icmpOk: null, port: null,
    };
  }
  if (row.type === 'tcp') {
    const code = row.errorCode ? String(row.errorCode).toUpperCase() : null;
    const cls = row.failure || (code ? TCP_CODE_CLASS[code] : null) || null;
    const known = cls ? TCP_FAILURES[cls] : null;
    const { host, port } = splitHostPort(row.target);
    let text = known
      ? `TCP connect to ${row.target} ${known[1]}${code ? ` (${code})` : ''}`
      : `TCP connect to ${row.target} failed${code ? ` (${code})` : ''} — the agent did not report how (update the agent for refused/timeout)`;
    // The cross-check. Only the newest ping counts, and only a ping that
    // actually succeeded: an old green ping says nothing about now, and a failed
    // one means the host itself is gone, which is a different sentence.
    const ping = latestPing(rows, host);
    const icmpOk = ping ? ping.ok === true : null;
    if (icmpOk === true) {
      text += `. ICMP to ${host} ok, TCP/${port || '?'} blocked — likely filter/ACL or service down`;
    } else if (icmpOk === false) {
      text += `. ICMP to ${host} fails as well — the host (or the path to it) is down, not just the port`;
    }
    return { type: 'tcp', target: row.target, kind: known ? known[0] : null, code, resolver: null, text, icmpOk, port };
  }
  return null;
}

// Every failed dns/tcp target in the rows, newest row per (type, target),
// described. Newest-first rows in, so the first row seen per key is the verdict
// the health model also uses.
function describeFailures(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r || (r.type !== 'dns' && r.type !== 'tcp')) continue;
    const key = `${r.type}|${r.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = describeFailure(r, rows);
    if (d) out.push(d);
  }
  return out;
}

// --- DHCP ---------------------------------------------------------------------
//
// The DHCP test (blueeye-agent src/probes/dhcp.js) answers two questions, and
// each has its own sentence:
//
//   no offer         — the test RAN (an `offers` list is stored) and nobody
//                      answered within the window. The DHCP server, or the relay
//                      (ip helper-address) in front of it, is down or not
//                      reachable from this segment. Existing leases keep
//                      working until they expire; a device that reboots or is
//                      plugged in now gets no address.
//   several servers  — more than one DISTINCT server identifier answered one
//                      DISCOVER. On a flat (OT) network that is a rogue or
//                      misconfigured server, and whichever answers first hands
//                      out the default gateway and the resolver — which is why
//                      it is a security finding, not only an availability one.
//
// A test that could not run (no `offers` list: no permission for port 68, no
// IPv4 interface) says nothing about the network, and gets no sentence here —
// its reason is already in `detail` and in the agent.probe-failed audit row.

// How many offers are spelled out in one sentence.
const MAX_OFFERS_EXPLAINED = 4;

const secs = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / 100) / 10;
};

// One offer, the way a technician reads it off a capture.
function describeOffer(o) {
  if (!o) return '';
  const bits = [];
  if (o.offeredIp) bits.push(`offers ${o.offeredIp}${o.subnetMask ? `/${o.subnetMask}` : ''}`);
  if (o.router) bits.push(`router ${o.router}`);
  if (o.dns && o.dns.length) bits.push(`DNS ${o.dns.join(', ')}`);
  if (o.relay) bits.push(`via relay ${o.relay}`);
  return `${o.serverId || 'a server with no server identifier'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

// Describes the newest dhcp row. Returns null for any other row type, for a
// test that could not run, and for a healthy single-server answer.
//
//   { type:'dhcp', target, kind:'no_offer'|'multiple_servers', iface, timeoutMs,
//     serverCount, serverIds, offers, text }
function describeDhcp(row) {
  if (!row || row.type !== 'dhcp' || !row.dhcp || !Array.isArray(row.dhcp.offers)) return null;
  const d = row.dhcp;
  const iface = d.iface || row.target;
  const base = { type: 'dhcp', target: row.target, iface, timeoutMs: d.timeoutMs ?? null };
  if (d.offers.length === 0) {
    const s = secs(d.timeoutMs);
    return {
      ...base,
      kind: 'no_offer',
      serverCount: 0,
      serverIds: [],
      offers: [],
      text: `No DHCP server answered on ${iface}${s != null ? ` within ${s} s` : ''}: the DHCP server, or the relay in front of it, is down or unreachable from this segment. Existing leases keep working until they expire; a device that reboots or is plugged in now gets no address`,
    };
  }
  const serverIds = [...new Set(d.offers.map((o) => o && o.serverId).filter(Boolean))];
  const count = Number.isInteger(d.serverCount) ? d.serverCount : serverIds.length;
  if (count <= 1) return null;
  const listed = d.offers.slice(0, MAX_OFFERS_EXPLAINED).map(describeOffer).join('; ');
  const more = d.offers.length > MAX_OFFERS_EXPLAINED ? ` (+${d.offers.length - MAX_OFFERS_EXPLAINED} more)` : '';
  return {
    ...base,
    kind: 'multiple_servers',
    serverCount: count,
    serverIds,
    offers: d.offers,
    text: `${count} DHCP servers answered on ${iface}: ${serverIds.join(', ') || 'unidentified servers'} — a rogue or misconfigured DHCP server. Whichever answers first hands out the default gateway and DNS, so clients on this segment can be sent anywhere. Offers: ${listed}${more}`,
  };
}

module.exports = { describeFailure, describeFailures, describeDhcp, describeOffer, splitHostPort, DNS_CODES, TCP_FAILURES };
