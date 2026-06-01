'use strict';

// IP helpers + private/non-routable detection. RFC1918 and other non-routable
// addresses are topology, not geography — the geo layer must never run them
// through GeoIP or plot them as a geographic point. Pure JS, no dependencies.

// IPv4 dotted-quad -> 32-bit unsigned int, or null if not a valid IPv4 literal.
function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

function isIpv4(ip) {
  return ipv4ToInt(ip) !== null;
}

// Non-routable / special-use IPv4 ranges (RFC1918, loopback, link-local, CGNAT,
// "this network"). Stored as [lo, hi] integer bounds.
const V4_PRIVATE_RANGES = [
  ['10.0.0.0', '10.255.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['127.0.0.0', '127.255.255.255'], // loopback
  ['169.254.0.0', '169.254.255.255'], // link-local
  ['100.64.0.0', '100.127.255.255'], // CGNAT (RFC6598)
  ['0.0.0.0', '0.255.255.255'], // "this" network
].map(([lo, hi]) => [ipv4ToInt(lo), ipv4ToInt(hi)]);

// True when an address must be kept out of the geo layer. Anything that isn't a
// public, routable address — including unparseable input — is treated as
// non-geo (safe default: we never accidentally geolocate internal traffic).
function isPrivate(ip) {
  if (typeof ip !== 'string' || ip.trim() === '') return true;
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return V4_PRIVATE_RANGES.some(([lo, hi]) => v4 >= lo && v4 <= hi);
  }
  // IPv6 (best-effort): unspecified, loopback, ULA (fc00::/7), link-local (fe80::/10).
  const s = ip.trim().toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true; // fe80::/10
  // Anything that isn't a recognisable IPv6 literal is also non-geo.
  return !/^[0-9a-f:]+$/.test(s) || s.indexOf(':') === -1;
}

// Picks the external (public, routable) endpoint of a flow and the direction
// relative to the monitored network. Returns null when both ends are private
// (an internal/topology flow that must not be geolocated).
//   { ip, direction }  direction: 'out' (to dst) | 'in' (from src)
function externalEndpoint(srcIp, dstIp) {
  const srcPriv = isPrivate(srcIp);
  const dstPriv = isPrivate(dstIp);
  if (srcPriv && dstPriv) return null; // internal flow
  if (!dstPriv) return { ip: dstIp, direction: 'out' }; // prefer dst as the peer
  return { ip: srcIp, direction: 'in' };
}

module.exports = { ipv4ToInt, isIpv4, isPrivate, externalEndpoint };
