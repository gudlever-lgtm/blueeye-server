'use strict';

const dns = require('dns').promises;
const net = require('net');
const { parseCidr, totalAddresses, inScope } = require('../../discovery/cidr');

// The SSRF decision for Service Tests — docs/service-assurance.md §6.
//
// This module makes the server drive a browser, which is the one capability that
// could turn BlueEye into an open proxy into a customer's network. Every
// navigation and every sub-request passes TWO independent checks and must clear
// both:
//
//   1. The permanent deny-list. Refused for everyone, always, not allowlistable
//      at any privilege level: non-http(s) schemes, loopback, link-local and the
//      cloud metadata endpoint, 0.0.0.0/8, broadcast.
//   2. The per-application allowlist. Permitted only if the host matches the
//      application's own base URL, one of its environments, or an explicit row in
//      service_test_allowed_hosts (a hostname, an IP, or a CIDR segment).
//
// RFC1918 IS allowlistable — that is the point. BlueEye is on-prem software and
// the applications customers want tested live on private ranges. What the
// allowlist opens is the private LAN; what it can never open is host-local and
// metadata addresses. Loopback would let a test browser reach BlueEye's own API
// from the server's own network position; 169.254.169.254 is the classic pivot.
//
// The literal checks are deliberately shared with src/integrations/ssrfGuard.js's
// intent, but reimplemented against parseCidr here so the SAME code path judges a
// single address and a range — one of them being subtly more permissive than the
// other is exactly the bug this module exists to prevent.

const ALLOWED_SCHEMES = ['http:', 'https:'];

// Never reachable, never allowlistable. Expressed as CIDRs so one matcher covers
// both a bare address and an operator's range that happens to overlap.
const DENY_CIDRS = [
  '127.0.0.0/8',      // loopback — would reach BlueEye's own API
  '169.254.0.0/16',   // link-local, including 169.254.169.254 cloud metadata
  '0.0.0.0/8',        // "this network"
  '255.255.255.255/32', // broadcast
].map(parseCidr);

const DENY_HOSTNAMES = ['localhost'];

// Reasons are stable identifiers, so the UI can translate them and tests can
// assert on them without matching prose.
const REASON = {
  SCHEME: 'scheme_not_allowed',
  MALFORMED: 'malformed_url',
  DENIED_ADDRESS: 'address_permanently_blocked',
  NOT_ALLOWLISTED: 'host_not_allowlisted',
  RESOLVE_FAILED: 'host_did_not_resolve',
  RESOLVED_DENIED: 'resolves_to_blocked_address',
};

function isDeniedIpv4(ip) {
  return DENY_CIDRS.some((c) => c && inScope(ip, [c]));
}

// IPv6 is not allowlistable in V1 (parseCidr is IPv4-only), so the safe answer
// for any IPv6 literal that is loopback/ULA/link-local is "denied", and for
// anything else "not allowlisted" — which the second check reports anyway.
function isDeniedIpv6(ip) {
  const v = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::1' || v === '::') return true;
  if (/^fe[89ab]/.test(v)) return true;      // fe80::/10 link-local
  if (/^f[cd]/.test(v)) return true;         // fc00::/7 unique local
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isDeniedIpv4(mapped[1]);
  return false;
}

// Check 1, for a host literal or name. Returns a reason string or null.
function denyReason(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return REASON.MALFORMED;
  if (DENY_HOSTNAMES.includes(h) || h.endsWith('.localhost')) return REASON.DENIED_ADDRESS;
  if (net.isIPv4(h)) return isDeniedIpv4(h) ? REASON.DENIED_ADDRESS : null;
  if (net.isIPv6(h)) return isDeniedIpv6(h) ? REASON.DENIED_ADDRESS : null;
  return null; // a hostname — judged again after resolution
}

// Parses an allowlist entry into a matcher. Returns { entry_type, value, cidr? }
// or { error } — the same shape the validator hands to a 400 response.
function parseEntry(rawValue, rawType = null) {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) return { error: 'entry must not be empty' };
  if (value.length > 255) return { error: 'entry is too long (max 255)' };

  const looksCidr = value.includes('/');
  const type = rawType || (looksCidr ? 'cidr' : (net.isIP(value) ? 'ip' : 'host'));

  if (type === 'cidr' || (type === 'ip' && looksCidr)) {
    const parsed = parseCidr(value);
    if (!parsed) return { error: 'not a valid IPv4 range (use 10.20.0.0/16)' };
    return { entry_type: 'cidr', value, cidr: parsed };
  }
  if (type === 'ip') {
    if (!net.isIPv4(value)) return { error: 'not a valid IPv4 address' };
    const parsed = parseCidr(value); // a bare IP parses as /32
    return { entry_type: 'ip', value, cidr: parsed };
  }
  // A value shaped like a dotted quad but not a valid address is a typo, not a
  // host name. Accepting it as a hostname would create an entry that silently
  // never matches anything — the operator would think their range was allowed.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return { error: 'not a valid IPv4 address' };

  // hostname
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(value)) return { error: 'not a valid hostname' };
  return { entry_type: 'host', value };
}

// Validates one entry against the deny-list and the DB-backed caps. `existing`
// is the application's current entries, so the address cap covers the TOTAL
// rather than each entry in isolation.
//
// settings: { minCidrPrefix, maxAddressesPerApplication } from the settings service.
function validateEntry(rawValue, rawType, { settings, existing = [] } = {}) {
  const parsed = parseEntry(rawValue, rawType);
  if (parsed.error) return { errors: { value: parsed.error } };

  if (parsed.entry_type === 'host') {
    const reason = denyReason(parsed.value);
    if (reason) return { errors: { value: 'that hostname is permanently blocked and cannot be allowlisted' } };
    return { value: { entry_type: 'host', value: parsed.value } };
  }

  // A range or address must not overlap the permanent deny-list. Checking the
  // FIRST and LAST address plus each deny range's own bounds catches both an
  // entry inside a denied range and a broad entry that swallows one.
  for (const deny of DENY_CIDRS) {
    if (!deny) continue;
    const overlaps = parsed.cidr.first <= deny.last && deny.first <= parsed.cidr.last;
    if (overlaps) {
      return { errors: { value: 'that range covers loopback, link-local or metadata addresses, which can never be allowlisted' } };
    }
  }

  const minPrefix = (settings && settings.minCidrPrefix) || 16;
  if (parsed.entry_type === 'cidr' && parsed.cidr.prefix < minPrefix) {
    return {
      errors: {
        value: `/${parsed.cidr.prefix} covers ${parsed.cidr.count.toLocaleString('en-US')} addresses; the widest range allowed is /${minPrefix}`,
      },
    };
  }

  const cap = (settings && settings.maxAddressesPerApplication) || 65536;
  const others = existing
    .filter((e) => e.value !== parsed.value && (e.entry_type === 'cidr' || e.entry_type === 'ip'))
    .map((e) => e.value);
  const { count } = totalAddresses([...others, parsed.value]);
  if (count > cap) {
    return {
      errors: {
        value: `this would allow ${count.toLocaleString('en-US')} addresses for one application; the limit is ${cap.toLocaleString('en-US')}`,
      },
    };
  }

  return { value: { entry_type: parsed.entry_type, value: parsed.value } };
}

// Builds the runtime policy for ONE application: the hosts its own URLs imply
// plus its allowlist rows. `resolve` is injected so tests stay offline and a
// deployment can supply its own resolver.
//
//   const policy = createHostPolicy({ baseUrls: [...], entries: [...] });
//   await policy.check('https://portal.kunde.dk/login')  →  { allowed, reason }
function createHostPolicy({ baseUrls = [], entries = [], resolve = null } = {}) {
  const hostnames = new Set();
  const ranges = [];

  for (const url of baseUrls) {
    try { hostnames.add(new URL(url).hostname.toLowerCase()); } catch { /* ignore an unparseable base URL */ }
  }
  for (const e of entries) {
    if (!e || !e.value) continue;
    if (e.entry_type === 'host') { hostnames.add(String(e.value).toLowerCase()); continue; }
    const parsed = parseCidr(e.value);
    if (parsed) ranges.push(parsed);
  }

  const lookup = resolve || (async (host) => {
    const res = await dns.lookup(host, { all: true });
    return res.map((r) => r.address);
  });

  function allowlisted(host) {
    const h = String(host || '').toLowerCase();
    if (hostnames.has(h)) return true;
    if (net.isIPv4(h) && ranges.length && inScope(h, ranges)) return true;
    return false;
  }

  // The full decision for one URL. Async because a hostname must be resolved
  // before its addresses can be judged — that is what closes the DNS-rebinding
  // gap a literal-only guard leaves open.
  async function check(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { return { allowed: false, reason: REASON.MALFORMED }; }

    if (!ALLOWED_SCHEMES.includes(url.protocol)) {
      return { allowed: false, reason: REASON.SCHEME, detail: url.protocol.replace(':', '') };
    }
    const host = url.hostname.toLowerCase();

    // Check 1 — permanent deny-list on the literal.
    const denied = denyReason(host);
    if (denied) return { allowed: false, reason: denied, detail: host };

    // Check 2 — the allowlist.
    if (!allowlisted(host)) return { allowed: false, reason: REASON.NOT_ALLOWLISTED, detail: host };

    // Check 1 again, on what the name actually resolves to. An IP literal has
    // already been judged, so only names need this.
    if (!net.isIP(host)) {
      let addresses;
      try { addresses = await lookup(host); } catch { return { allowed: false, reason: REASON.RESOLVE_FAILED, detail: host }; }
      if (!addresses || !addresses.length) return { allowed: false, reason: REASON.RESOLVE_FAILED, detail: host };
      for (const addr of addresses) {
        const bad = net.isIPv6(addr) ? isDeniedIpv6(addr) : isDeniedIpv4(addr);
        if (bad) return { allowed: false, reason: REASON.RESOLVED_DENIED, detail: `${host} → ${addr}` };
      }
    }

    return { allowed: true, reason: null };
  }

  // Synchronous pre-filter for the browser's request interceptor, which cannot
  // await a DNS lookup per subresource without wrecking page-load timings. It is
  // strictly NARROWER than check(): it can only allow what check() would allow on
  // the literal and allowlist, and every top-level navigation still goes through
  // the full async check.
  function checkSync(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { return { allowed: false, reason: REASON.MALFORMED }; }
    if (!ALLOWED_SCHEMES.includes(url.protocol)) return { allowed: false, reason: REASON.SCHEME };
    const host = url.hostname.toLowerCase();
    const denied = denyReason(host);
    if (denied) return { allowed: false, reason: denied, detail: host };
    if (!allowlisted(host)) return { allowed: false, reason: REASON.NOT_ALLOWLISTED, detail: host };
    return { allowed: true, reason: null };
  }

  return { check, checkSync, allowlisted, hostnames: [...hostnames], rangeCount: ranges.length };
}

// Plain-language explanation for a refusal, for the UI and the run log.
function explainReason(reason, detail = '') {
  const d = detail ? ` (${detail})` : '';
  switch (reason) {
    case REASON.SCHEME: return `Only http and https addresses can be used${d}.`;
    case REASON.MALFORMED: return `That is not a valid web address${d}.`;
    case REASON.DENIED_ADDRESS: return `That address is permanently blocked and cannot be allowlisted${d}.`;
    case REASON.NOT_ALLOWLISTED: return `That host is not on this application's allowed list${d}. An administrator can add it under Allowed hosts.`;
    case REASON.RESOLVE_FAILED: return `That host name could not be looked up${d}.`;
    case REASON.RESOLVED_DENIED: return `That host name resolves to a blocked address${d}.`;
    default: return `The address was refused${d}.`;
  }
}

module.exports = {
  createHostPolicy, validateEntry, parseEntry, denyReason, explainReason,
  REASON, ALLOWED_SCHEMES, DENY_CIDRS, DENY_HOSTNAMES,
};
