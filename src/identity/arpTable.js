'use strict';

// Pure parser for ARP / neighbour tables (migration 073).
//
// The agent already collects `arp.table` as raw command output — today that is
// /proc/net/arp on Linux (src/runtime.js), but the agent-side collector is being
// widened, and evidence payloads captured months ago are still in the database.
// So this parses every shape we may be handed rather than assuming one:
//
//   /proc/net/arp   IP address  HW type  Flags  HW address  Mask  Device
//   ip neigh        192.168.1.1 dev eth0 lladdr 00:11:.. REACHABLE
//   arp -an (BSD)   ? (192.168.1.1) at 00:11:.. [ether] on eth0
//   arp -a (Win)    192.168.1.1    00-11-22-33-44-55   dynamic
//
// Format detection is per LINE, not per file: a payload can legitimately be a
// concatenation (the evidence snapshot joins items with "# name [status]"
// headers), and a stray unparseable line must never discard the rest.
//
// No I/O, no clock, no database — everything here is a pure function so the
// exact byte-level cases below are unit-testable.

// A MAC in any of the three separators we see, plus the bare 12-hex form.
const MAC_RE = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const MAC_BARE_RE = /^[0-9a-f]{12}$/i;

// Addresses that are never a host identity:
//   00:00:00:00:00:00  incomplete entry (/proc/net/arp writes this with flag 0x0)
//   ff:ff:ff:ff:ff:ff  broadcast
//   01:00:5e:xx        IPv4 multicast
//   33:33:xx           IPv6 multicast
//   01:80:c2:xx        IEEE reserved (STP/LLDP)
// Dropped at parse time so they are never stored, rather than stored and
// filtered on every read.
function isUsableMac(mac) {
  if (!mac) return false;
  if (mac === '00:00:00:00:00:00') return false;
  if (mac === 'ff:ff:ff:ff:ff:ff') return false;
  if (mac.startsWith('01:00:5e:')) return false;
  if (mac.startsWith('33:33:')) return false;
  if (mac.startsWith('01:80:c2:')) return false;
  // Multicast bit set in the first octet (covers anything not listed above).
  const first = parseInt(mac.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 1) === 0;
}

// Normalises any accepted MAC spelling to lowercase colon form. Returns null for
// anything that is not a MAC — this is also the public normaliser the search
// layer uses on a user's query, so "same MAC in three formats gives the same
// hit" is one function and not three code paths.
function normalizeMac(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (MAC_RE.test(s)) return s.replace(/-/g, ':').toLowerCase();
  if (MAC_BARE_RE.test(s)) return s.toLowerCase().match(/.{2}/g).join(':');
  // Cisco-style 0011.2233.4455 — common in switch output and in what a
  // technician copies out of a CMDB.
  const dotted = s.toLowerCase().replace(/\./g, '');
  if (/^[0-9a-f]{12}$/.test(dotted) && s.includes('.')) return dotted.match(/.{2}/g).join(':');
  return null;
}

// Loose IPv4 / IPv6 shape check. Deliberately not a full validator: the input is
// machine-generated output from the host's own stack, so the job is to tell an
// address column from a hostname column, not to police RFC compliance.
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
function isIpv4(s) {
  if (!IPV4_RE.test(s)) return false;
  return s.split('.').every((o) => Number(o) <= 255);
}
function isIpv6(s) {
  // Must contain a colon, only hex/colon characters, and not be a MAC.
  return s.includes(':') && /^[0-9a-f:]+$/i.test(s) && !MAC_RE.test(s);
}
function isIp(s) {
  return isIpv4(s) || isIpv6(s);
}

// Strips an IPv6 zone suffix (fe80::1%eth0) — the zone is the local interface,
// which we already record separately.
function stripZone(ip) {
  const i = ip.indexOf('%');
  return i === -1 ? ip : ip.slice(0, i);
}

// --- Per-format line parsers -------------------------------------------------
// Each returns { ip, mac, interface } or null. They are tried in order; the
// first that matches wins.

// /proc/net/arp:
//   192.168.1.1   0x1   0x2   00:11:22:33:44:55   *   eth0
// Flags 0x2 (ATF_COM) means complete. Anything without that bit is an
// unresolved entry and carries the all-zero MAC, which isUsableMac drops
// anyway — but checking the flag makes the intent explicit.
function parseProcNetArp(line) {
  const f = line.trim().split(/\s+/);
  if (f.length < 6) return null;
  if (!isIpv4(f[0])) return null;
  if (!/^0x[0-9a-f]+$/i.test(f[1]) || !/^0x[0-9a-f]+$/i.test(f[2])) return null;
  const flags = parseInt(f[2], 16);
  if (!(flags & 0x2)) return null; // incomplete
  const mac = normalizeMac(f[3]);
  if (!mac) return null;
  return { ip: f[0], mac, interface: f[5] || null };
}

// ip neigh show:
//   192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
//   192.168.1.9 dev eth0 FAILED            (no lladdr → skipped)
//   fe80::1 dev eth0 lladdr 00:11:.. router REACHABLE
function parseIpNeigh(line) {
  const f = line.trim().split(/\s+/);
  if (f.length < 3) return null;
  const ip = stripZone(f[0]);
  if (!isIp(ip)) return null;
  const devIdx = f.indexOf('dev');
  const llIdx = f.indexOf('lladdr');
  if (devIdx === -1 || llIdx === -1) return null;
  const mac = normalizeMac(f[llIdx + 1]);
  if (!mac) return null;
  // FAILED/INCOMPLETE entries can still carry a stale lladdr; do not trust them.
  if (/\b(FAILED|INCOMPLETE)\b/.test(line)) return null;
  return { ip, mac, interface: f[devIdx + 1] || null };
}

// BSD/macOS `arp -an`:
//   ? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0
//   ? (192.168.1.7) at <incomplete> on eth0
//   gw (10.0.0.1) at aa:bb:.. on en0 ifscope [ethernet]
function parseArpDashAn(line) {
  const m = line.match(/\(([^)]+)\)\s+at\s+(\S+)/i);
  if (!m) return null;
  const ip = stripZone(m[1]);
  if (!isIp(ip)) return null;
  const mac = normalizeMac(m[2]);
  if (!mac) return null; // covers <incomplete>
  const onMatch = line.match(/\son\s+(\S+)/i);
  return { ip, mac, interface: onMatch ? onMatch[1] : null };
}

// Windows `arp -a`:
//   Interface: 192.168.1.34 --- 0xb
//     Internet Address      Physical Address      Type
//     192.168.1.1           00-11-22-33-44-55     dynamic
// The interface here is an IP, not a device name; it is carried across lines by
// the caller, which is why this parser takes it as an argument.
function parseWindowsArp(line, currentInterface) {
  const f = line.trim().split(/\s+/);
  if (f.length < 2) return null;
  if (!isIpv4(f[0])) return null;
  const mac = normalizeMac(f[1]);
  if (!mac) return null;
  // Third column, when present, is dynamic/static — reject anything else so a
  // coincidentally-shaped line from another format is not mis-parsed here.
  if (f[2] && !/^(dynamic|static)$/i.test(f[2])) return null;
  return { ip: f[0], mac, interface: currentInterface || null };
}

const WINDOWS_IFACE_RE = /^Interface:\s+(\S+)/i;

// Parses a whole ARP/neighbour payload into deduplicated entries.
//
// Returns { entries: [{ ip, mac, interface }], parsed, skipped } — `skipped`
// counts lines that looked like data but yielded nothing (incomplete entries,
// broadcast MACs), so a caller can tell "empty table" from "nothing understood"
// instead of both looking like success.
//
// On duplicate IPs within one payload the LAST wins: neighbour tables print
// oldest-first, so the last mention is the current binding.
function parseArpTable(text) {
  const out = new Map(); // ip -> entry
  let parsed = 0;
  let skipped = 0;
  let winIface = null;

  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Evidence payloads are a concatenation with "# item [status]" headers.
    if (line.startsWith('#')) { winIface = null; continue; }

    const win = line.match(WINDOWS_IFACE_RE);
    if (win) { winIface = win[1]; continue; }

    // Column headers of the various tools.
    if (/^(IP address|Internet Address|Address)\b/i.test(line)) continue;

    const entry = parseProcNetArp(line)
      || parseIpNeigh(line)
      || parseArpDashAn(line)
      || parseWindowsArp(line, winIface);

    if (!entry) {
      // Only count a line as skipped if it plausibly WAS an entry — otherwise
      // prose and headers would inflate the number into noise.
      const first = line.split(/\s+/)[0];
      if (isIp(stripZone(first)) || /\(\s*\d/.test(line)) skipped += 1;
      continue;
    }
    if (!isUsableMac(entry.mac)) { skipped += 1; continue; }
    out.set(entry.ip, entry);
    parsed += 1;
  }

  return { entries: [...out.values()], parsed, skipped };
}

// Normalises the agent-reported capabilities.arp array (the second ingest
// source) into the same shape as the parsed text. Accepts objects with either
// {ip,mac,interface} or {address,lladdr,dev} spellings so the agent side can
// evolve without a lockstep server change. Invalid rows are dropped, never
// thrown on — a malformed entry must not cost the whole capabilities report.
function normalizeReportedArp(list) {
  const out = new Map();
  let skipped = 0;
  for (const row of Array.isArray(list) ? list : []) {
    if (!row || typeof row !== 'object') { skipped += 1; continue; }
    const ipRaw = row.ip || row.address || null;
    const macRaw = row.mac || row.lladdr || null;
    const ip = ipRaw == null ? null : stripZone(String(ipRaw).trim());
    const mac = normalizeMac(macRaw);
    if (!ip || !isIp(ip) || !mac || !isUsableMac(mac)) { skipped += 1; continue; }
    const iface = row.interface || row.dev || row.device || null;
    out.set(ip, { ip, mac, interface: iface ? String(iface).slice(0, 64) : null });
  }
  return { entries: [...out.values()], parsed: out.size, skipped };
}

module.exports = {
  parseArpTable,
  normalizeReportedArp,
  normalizeMac,
  isUsableMac,
  isIp,
  isIpv4,
  isIpv6,
  stripZone,
};
