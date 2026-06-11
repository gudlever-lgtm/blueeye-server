'use strict';

const net = require('net');

// SSRF guard for outbound integration URLs. The server runs on-prem, so an admin
// (or api_access token holder) who can point a connector at an internal address
// turns the server into a network-pivot. We block obvious internal targets:
// loopback, RFC1918/private, link-local (incl. cloud metadata 169.254.169.254),
// ULA, and the literal "localhost".
//
// This blocks IP *literals* and localhost at validation/request time without DNS
// resolution (so it stays test-friendly and side-effect free). It does NOT defend
// against a hostname that resolves to an internal IP (DNS rebinding); pair it with
// a network egress policy for that. Combined with redirect:'manual' in the HTTP
// client, an allowed host also can't redirect to an internal IP literal.

function ipv4Blocked(ip) {
  const p = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 255 && b === 255) return true; // broadcast
  return false;
}

function ipv6Blocked(ip) {
  let v = ip.toLowerCase();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (v === '::1' || v === '::') return true; // loopback / unspecified
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // fe80::/10 link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 ULA
  // IPv4-mapped (::ffff:a.b.c.d) — defer to the IPv4 check.
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

// True when a hostname/host literal must not be reached by an outbound request.
function isBlockedHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIPv4(host)) return ipv4Blocked(host);
  if (net.isIPv6(host)) return ipv6Blocked(host);
  return false; // a regular hostname — allowed (resolution is out of scope here)
}

// Validates a base URL string: returns an error message or null. Used by the
// integrations validator and as a request-time check in the HTTP client.
function baseUrlBlockedReason(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'baseUrl must be a valid URL';
  }
  if (isBlockedHost(u.hostname)) {
    return 'baseUrl must not point at a private, loopback, or link-local address';
  }
  return null;
}

module.exports = { isBlockedHost, baseUrlBlockedReason };
