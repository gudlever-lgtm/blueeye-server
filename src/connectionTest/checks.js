'use strict';

// The Connection Test catalogue — "one address, the whole battery".
//
// A probe answers one question about one target. An operator asked whether a
// host is reachable usually wants all of them: does the name resolve, does it
// answer ICMP, is the port open, what does the path look like, does a full-size
// packet get through. This module is that list, and it is the ONLY place it
// exists: the dashboard renders the catalogue the server serves, and a run
// builds its probe specs from the same entries. A check the UI offers is
// therefore always a check the server can dispatch.
//
// Each entry is a probe spec builder. They are deliberately plain: the same
// specs an operator would fill in by hand on the Run-a-probe tab, so a
// connection test produces ordinary probe_results rows that every other screen
// (fleet health, path visualisation, findings, availability) already
// understands. Nothing new is stored.
//
// `available: false` marks a check the catalogue KNOWS about but the agent
// cannot run yet. It is listed rather than hidden so the screen says what a
// connection test covers, and the server refuses to dispatch it — a greyed-out
// row is a promise, not a silent no-op. Nothing is marked so today: reverse DNS
// and the TLS certificate check landed in blueeye-agent 0.27. An agent older
// than that answers `unknown probe type`, which the screen reports as the
// failure reason it is.

const net = require('net');

// `appliesTo: 'hostname'` = the check is meaningless for an IP literal. A DNS
// lookup of 1.1.1.1 resolves nothing and would report a green tick for a
// question nobody asked.
const CHECKS = [
  { id: 'dns', type: 'dns', available: true, appliesTo: 'hostname', spec: (host) => ({ type: 'dns', host }) },
  { id: 'rdns', type: 'rdns', available: true, appliesTo: 'any', spec: (host) => ({ type: 'rdns', host }) },
  { id: 'ping', type: 'ping', available: true, appliesTo: 'any', spec: (host) => ({ type: 'ping', host, count: 4 }) },
  { id: 'tcp80', type: 'tcp', available: true, appliesTo: 'any', port: 80, spec: (host) => ({ type: 'tcp', host, port: 80, count: 1 }) },
  { id: 'tcp443', type: 'tcp', available: true, appliesTo: 'any', port: 443, spec: (host) => ({ type: 'tcp', host, port: 443, count: 1 }) },
  { id: 'tls', type: 'tls', available: true, appliesTo: 'any', port: 443, spec: (host) => ({ type: 'tls', host, port: 443 }) },
  { id: 'traceroute', type: 'traceroute', available: true, appliesTo: 'any', spec: (host) => ({ type: 'traceroute', host, queries: 3 }) },
  { id: 'tcptraceroute', type: 'tcptraceroute', available: true, appliesTo: 'any', port: 443, spec: (host) => ({ type: 'tcptraceroute', host, port: 443, queries: 3 }) },
  { id: 'path_mtu', type: 'path_mtu', available: true, appliesTo: 'any', spec: (host) => ({ type: 'path_mtu', host, per_hop: true }) },
  // The application itself. Everything above it says the packets arrive; this
  // is the only check that says the service ANSWERED — a port that opens with a
  // load balancer and no backend behind it passes tcp443 and fails here, which
  // is the whole reason the row exists. https, because a check of :443 that
  // spoke plaintext would be measuring a different service.
  { id: 'http', type: 'http', available: true, appliesTo: 'any', port: 443, spec: (host) => ({ type: 'http', url: `https://${wrapHost(host)}/`, count: 1 }) },
];

const CHECK_IDS = CHECKS.map((c) => c.id);

const isIpLiteral = (host) => net.isIP(String(host || '').trim()) !== 0;

// An IPv6 literal has to be bracketed inside a URL, or `https://::1/` parses as
// a scheme-relative nonsense rather than a host. A name and an IPv4 literal go
// in untouched.
const wrapHost = (host) => {
  const h = String(host || '').trim();
  return net.isIP(h) === 6 ? `[${h}]` : h;
};

// Is this check worth running against this target? An unavailable check never
// is; a hostname-only check is not, against an IP literal.
function checkApplies(check, host) {
  if (!check || !check.available) return false;
  if (check.appliesTo === 'hostname' && isIpLiteral(host)) return false;
  return true;
}

// The catalogue as the API serves it: what each check is, whether it can run at
// all, and — when a target is given — whether it applies to that target. The
// human labels live in the dashboard's translation catalogue, not here; this is
// the machine-readable half.
function catalogue(host = null) {
  return CHECKS.map((c) => ({
    id: c.id,
    type: c.type,
    port: c.port || null,
    available: c.available,
    appliesTo: c.appliesTo,
    applies: host === null ? c.available : checkApplies(c, host),
  }));
}

// The probe specs for a run: the requested checks, in catalogue order, skipping
// anything that does not apply to this target. Returns `{ specs, skipped }` so
// the caller can tell the operator what was left out and why — a check that
// quietly disappears is the same bug as one that quietly fails.
function specsFor(host, ids, { ports = null } = {}) {
  const want = new Set(ids || []);
  const specs = [];
  const skipped = [];
  for (const c of CHECKS) {
    if (!want.has(c.id)) continue;
    if (!checkApplies(c, host)) {
      skipped.push({ id: c.id, reason: c.available ? 'not_applicable' : 'not_supported' });
      continue;
    }
    specs.push({ id: c.id, probe: c.spec(host) });
  }
  // Extra TCP ports the ladder is configured for. They ride alongside the
  // catalogue's own rows rather than replacing them, so a run still produces
  // every check the screen listed — and an estate on 8443 gets a firewall rung
  // about 8443 instead of one about a port nobody uses. The id is derived from
  // the port so a result can still be matched back to the row that asked.
  const extra = (Array.isArray(ports) ? ports : [])
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
    .filter((p) => !CHECKS.some((c) => c.type === 'tcp' && c.port === p));
  if (want.has('tcp80') || want.has('tcp443')) {
    for (const p of new Set(extra)) specs.push({ id: `tcp${p}`, probe: { type: 'tcp', host, port: p, count: 1 } });
  }
  return { specs, skipped };
}

module.exports = { CHECKS, CHECK_IDS, catalogue, specsFor, checkApplies, isIpLiteral, wrapHost };
