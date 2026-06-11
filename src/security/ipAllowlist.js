'use strict';

// Pure IP/CIDR allowlist matching for the security pack. No I/O. Supports IPv4
// and IPv6 CIDRs, plus bare addresses (treated as /32 or /128). Used to gate
// login by source address per role: the effective allowlist for a user is the
// global list UNION the list for their role; if that combined list is non-empty
// and the source IP is not in it, login is refused (403). An empty effective
// list means "no restriction configured for this principal" → allowed.

const { ROLES, ALL_ROLES } = require('../auth/roles');

// Strips an IPv4-mapped IPv6 prefix (::ffff:192.0.2.1 → 192.0.2.1) so a proxy
// that hands us mapped addresses still matches IPv4 rules.
function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  let s = ip.trim();
  if (s === '') return '';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) s = m[1];
  return s;
}

function isIpv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// IPv4 dotted-quad → 32-bit unsigned int (via BigInt for uniformity).
function ipv4ToBig(s) {
  return s.split('.').reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n);
}

// Expands an IPv6 address (with optional :: and embedded IPv4 tail) to a 128-bit
// BigInt. Returns null if it does not parse.
function ipv6ToBig(s) {
  let str = s;
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) → two hextets.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (v4) {
    if (!isIpv4(v4[1])) return null;
    const n = ipv4ToBig(v4[1]);
    const hi = (n >> 16n) & 0xffffn;
    const lo = n & 0xffffn;
    str = str.slice(0, v4.index) + hi.toString(16) + ':' + lo.toString(16);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  let acc = 0n;
  for (const g of groups) {
    if (g === '') return null;
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    acc = (acc << 16n) + BigInt(parseInt(g, 16));
  }
  return acc;
}

// Parses a CIDR ("10.0.0.0/8", "2001:db8::/32") or bare address into
// { base, bits, family } in BigInt, or null when malformed.
function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const s = cidr.trim();
  if (s === '') return null;
  const [addrRaw, prefixRaw] = s.split('/');
  const addr = normalizeIp(addrRaw);
  if (isIpv4(addr)) {
    const bits = prefixRaw === undefined ? 32 : Number(prefixRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    return { base: ipv4ToBig(addr), bits, family: 4, width: 32 };
  }
  const big = ipv6ToBig(addr);
  if (big === null) return null;
  const bits = prefixRaw === undefined ? 128 : Number(prefixRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
  return { base: big, bits, family: 6, width: 128 };
}

// Is `ip` inside `cidr`? Mismatched families are never a match.
function ipInCidr(ip, cidr) {
  const net = parseCidr(cidr);
  if (!net) return false;
  const norm = normalizeIp(ip);
  const family = isIpv4(norm) ? 4 : 6;
  if (family !== net.family) return false;
  const addr = family === 4 ? ipv4ToBig(norm) : ipv6ToBig(norm);
  if (addr === null) return false;
  if (net.bits === 0) return true;
  const shift = BigInt(net.width - net.bits);
  return (addr >> shift) === (net.base >> shift);
}

// Validates a rules object, returning a normalized { enabled, global, roles }.
// Unknown CIDRs are dropped (the caller validates separately for the API 422),
// so a malformed stored rule can never crash a login.
function normalizeRules(rules) {
  const r = rules && typeof rules === 'object' ? rules : {};
  const cleanList = (list) =>
    (Array.isArray(list) ? list : []).map((c) => String(c).trim()).filter((c) => parseCidr(c) !== null);
  const roles = {};
  for (const role of ALL_ROLES) {
    roles[role] = cleanList(r.roles && r.roles[role]);
  }
  return {
    enabled: r.enabled === true || r.enabled === 'true',
    global: cleanList(r.global),
    roles,
  };
}

// Decides whether `ip` may log in as `role` under `rules`. Returns
// { allowed, restricted }: restricted=false means no allowlist applied.
function isAllowed(ip, role, rules) {
  const r = normalizeRules(rules);
  if (!r.enabled) return { allowed: true, restricted: false };
  const roleList = (role && r.roles[role]) || [];
  const effective = [...r.global, ...roleList];
  if (effective.length === 0) return { allowed: true, restricted: false };
  const ok = effective.some((cidr) => ipInCidr(ip, cidr));
  return { allowed: ok, restricted: true };
}

module.exports = { normalizeIp, parseCidr, ipInCidr, normalizeRules, isAllowed, ROLES };
