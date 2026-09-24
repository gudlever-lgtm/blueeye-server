'use strict';

const net = require('net');

const PROBE_TYPES = ['ping', 'tcp', 'dns', 'rdns', 'traceroute', 'tcptraceroute', 'http', 'curl', 'pageload', 'transaction', 'path_mtu', 'tls', 'dhcp'];
// How many DHCPOFFERs one DHCP test may report (the agent caps at the same
// number). More servers than this answering one DISCOVER is already the
// finding; the rest would only be stored.
const MAX_DHCP_OFFERS = 8;
const MAX_DHCP_DNS = 4;
// The DHCP test's collection window, in ms. The agent clamps to the same range.
const DHCP_TIMEOUT_MS = { min: 1000, max: 10000 };
// An interface name as `ip link` / Get-NetAdapter print it. It is only ever a
// key into the agent's own interface table — no shell sees it — but a name that
// cannot exist is a typo worth a 400, not a probe that reports "not found".
const IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:@()-]{0,63}$/;
// How many payload sizes one ping sweep may carry, and how large each may be.
// Each size is its own `ping` invocation on the agent, so the first bounds the
// RUN, not just the packet.
const MAX_PING_SIZES = 6;
const MAX_PAYLOAD_BYTES = 65500;
// What a path-MTU probe may report per hop. An unrecognised status is dropped
// rather than stored: the dashboard colours and the root-cause rules both switch
// on this value, and a status neither of them knows would render as nothing at
// all while looking like data.
const MTU_HOP_STATUSES = ['ok', 'reduced', 'blackhole', 'no_response', 'skipped'];
// Jumbo frames. Above this there is no Ethernet to carry it, so a larger
// `max_size` is a typo, not a request.
const MAX_PACKET_SIZE = 9216;
// Below these an IP stack is not required to work, so a smaller floor tests
// nothing. RFC 791 / RFC 8200 minimums.
const MIN_PACKET_SIZE = { 4: 576, 6: 1280 };
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const HEADER_EXPECT_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(\s*:\s*.{1,200})?$/;
// A REQUEST header on a transaction step must be a real `Name: value` field.
// curl reads `-H @file` from the local disk, so a value that isn't a field
// (notably one starting '@') would turn a probe into an arbitrary file read on
// the agent host. The agent enforces this independently (src/probes/curlArgs.js);
// rejecting it here as well keeps the bad spec out of the database and gives the
// operator a real error instead of a silently failing step. No CR/LF either —
// that would split the request.
const HEADER_SEND_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+:[^\r\n]*$/;
const MAX_RESULTS = 200;
// Host/IP/hostname must start alphanumeric (so it can never be read as a CLI
// flag like "-rf") and contain only host-safe characters.
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/;

// An IPv6 literal may legally begin with a colon (`::1`, `::ffff:192.0.2.1`),
// which HOST_RE's leading-alphanumeric rule rejects. That rule exists to stop a
// target being read as a CLI flag, and a string `net.isIPv6` accepts can never
// be one — so a verified literal is admitted without loosening the guard for
// anything else.
// Not exported: this is an internal guard, not a validator. The gate sweeps
// everything `src/validation` exports as a validator — same signature, same
// `{value}|{errors}` contract — and a boolean predicate in that namespace would
// either fail the sweep or force the sweep to grow an exception, which is how a
// gate stops meaning anything.
function isSafeHost(host) {
  if (typeof host !== 'string') return false;
  const s = host.trim();
  return s.length > 0 && s.length <= 255 && (HOST_RE.test(s) || net.isIPv6(s));
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// The IP family a probe will actually run as: an explicit request wins, a
// literal target names itself, and a hostname means IPv4. Returns null for a
// request that is neither 4 nor 6, which the caller turns into a 400.
function familyOf(requested, host) {
  if (requested === undefined || requested === null || requested === '') {
    return net.isIPv6(host) ? 6 : 4;
  }
  const n = Number(requested);
  return n === 4 || n === 6 ? n : null;
}

// A packet size, rejected outright when it is outside anything an IP network
// could carry. Storing a nonsense size would put a nonsense recommended MSS in
// front of an operator, which is worse than storing nothing.
function sizeOrNull(v) {
  const n = intOrNull(v);
  return n != null && n > 0 && n <= MAX_PACKET_SIZE ? n : null;
}

function mtuStatusOf(v) {
  const s = v == null ? '' : String(v).toLowerCase();
  return MTU_HOP_STATUSES.includes(s) ? s : null;
}

// The path-MTU verdict, field by field from a typed source. Nothing is spread:
// a key the agent invents must not reach the database because a future version
// of the agent added it.
function mtuBlock(r) {
  const pathMtu = sizeOrNull(r.path_mtu ?? r.pathMtu);
  const ipVersion = Number(r.ip_version ?? r.ipVersion) === 6 ? 6 : 4;
  return {
    ipVersion,
    pathMtu,
    blackholeDetected: (r.blackhole_detected ?? r.blackholeDetected) === true,
    icmpFragNeededSeen: (r.icmp_frag_needed_seen ?? r.icmpFragNeededSeen) === true,
    mtuDropAtHop: intOrNull(r.mtu_drop_at_hop ?? r.mtuDropAtHop),
    mssSupported: (r.mss_supported ?? r.mssSupported) === true,
    mssObserved: sizeOrNull(r.mss_observed ?? r.mssObserved),
    // Recomputed, never taken on trust: it is the number an operator will type
    // into a router, and it has to agree with the path MTU stored beside it.
    recommendedMss: pathMtu != null ? pathMtu - (ipVersion === 6 ? 60 : 40) : null,
    durationMs: intOrNull(r.duration_ms ?? r.durationMs),
  };
}

// The TLS/certificate verdict, field by field from a typed source. Nothing is
// spread: a key the agent invents must not reach the database because a future
// version of the agent added it.
//
// The four faults are stored APART because they are four different jobs: an
// expiry goes in a diary, an untrusted chain is a deployment mistake, a name
// mismatch is usually the wrong virtual host, and the protocol/cipher is what
// an audit asks for. Collapsing them into one "invalid" flag would throw away
// which one it was.
// node checks the chain BEFORE the name, so this code on an unauthorized
// handshake means the chain validated and only the name failed.
const TLS_NAME_ERROR_RE = /ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate's altnames/i;

function tlsBlock(r) {
  const names = Array.isArray(r.altNames) ? r.altNames : [];
  const authorizationError = str(r.authorizationError, 120);
  const sni = r.servername != null ? String(r.servername).trim() : '';
  return {
    protocol: str(r.protocol, 32),
    cipher: str(r.cipher, 64),
    authorized: r.authorized === true,
    // node's own code (CERT_HAS_EXPIRED, SELF_SIGNED_CERT_IN_CHAIN, …) — kept
    // verbatim because it names the fault precisely and a paraphrase would not.
    authorizationError,
    // Did the CHAIN validate, apart from the name (agent 0.40+ sends it).
    // `authorized` is one flag for both checks, and read alone it reported a
    // certificate for the wrong virtual host as an untrusted chain. An older
    // agent's row is read the same way: authorized, or refused only for the
    // name (ERR_TLS_CERT_ALTNAME_INVALID), is a chain that validated.
    chainTrusted: typeof r.chainTrusted === 'boolean'
      ? r.chainTrusted
      : (r.authorized === true || (authorizationError != null && TLS_NAME_ERROR_RE.test(authorizationError))),
    // The SNI name the agent asked for (agent 0.40+) — what a name-mismatch
    // finding names. Held to the hostname rule; anything else is dropped.
    servername: sni && isSafeHost(sni) ? sni.slice(0, 253) : null,
    // Tri-state ON PURPOSE: true/false is a verdict, null is "there was no name
    // to check" (an IP with no SNI). Coercing null to false would report every
    // IP target as serving the wrong certificate.
    hostnameMatches: r.hostnameMatches === true ? true : (r.hostnameMatches === false ? false : null),
    expiryDays: numOrNull(r.expiryDays),
    expired: r.expired === true,
    notYetValid: r.notYetValid === true,
    validFrom: str(r.validFrom, 40),
    validTo: str(r.validTo, 40),
    subject: str(r.subject, 190),
    issuer: str(r.issuer, 190),
    altNames: names.slice(0, 16).map((n) => str(n, 190)).filter(Boolean),
    serialNumber: str(r.serialNumber, 64),
    fingerprint256: str(r.fingerprint256, 128),
    chainLength: intOrNull(r.chainLength),
    selfSigned: r.selfSigned === true,
  };
}

// WHERE the certificate is in a tls row, or null when there is none.
//
// The agent (src/probes/tls.js) nests the verdict under `tls`; the flat shape
// (fields on the row itself) is accepted too. Reading ONLY the flat fields —
// as this did — turned every nested verdict into `authorized: false`.
//
// NO CERTIFICATE, NO BLOCK. A handshake that failed (a plain-HTTP port answers
// ERR_SSL_WRONG_VERSION_NUMBER, a refused port ECONNREFUSED) or completed
// without a certificate carries none of these fields, only `error`. Building a
// block from nothing coerced the absent `authorized` into false, and the
// analysis then reported an untrusted certificate "for an unknown reason" for
// a port that never presented one. The failure is the error; the certificate
// verdict is null.
const TLS_CERT_FIELDS = [
  'authorized', 'authorizationError', 'chainTrusted', 'hostnameMatches', 'expiryDays', 'expired', 'notYetValid',
  'validFrom', 'validTo', 'subject', 'issuer', 'altNames', 'serialNumber', 'fingerprint256',
];
function tlsSource(r) {
  if (r.tls && typeof r.tls === 'object' && !Array.isArray(r.tls)) return r.tls;
  return TLS_CERT_FIELDS.some((k) => r[k] !== undefined) ? r : null;
}

// The reverse-DNS answer. `forwardConfirmed` is the field worth having: a PTR
// that does not resolve back to the address it came from looks fine until
// somebody checks it, and the services that care (mail, most of all) do check.
function rdnsBlock(r) {
  const names = Array.isArray(r.ptrNames) ? r.ptrNames : [];
  return {
    address: str(r.address, 45),
    ptrNames: names.slice(0, 8).map((n) => str(n, 190)).filter(Boolean),
    forwardConfirmed: r.forwardConfirmed === true,
  };
}

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));

// A dotted-quad IPv4 address, or null. Every address in a DHCP offer is IPv4
// (RFC 2131 is an IPv4 protocol), so anything else is junk, not data.
const ipv4OrNull = (v) => (typeof v === 'string' && net.isIPv4(v.trim()) ? v.trim() : null);

// The DHCP test's result: which interface asked, how long it listened, and
// every offer that came back. Field by field, like the blocks above. Returns
// null when the agent sent no `offers` array at all — a probe that could not
// RUN (no permission, no interface) measured nothing, and storing an empty
// list for it would read as "nobody answered", which is a finding.
function dhcpBlock(r) {
  if (!Array.isArray(r.offers)) return null;
  const offers = r.offers.slice(0, MAX_DHCP_OFFERS).map((o) => ({
    serverId: ipv4OrNull(o && o.serverId),
    offeredIp: ipv4OrNull(o && o.offeredIp),
    leaseSec: (() => { const n = intOrNull(o && o.leaseSec); return n != null && n >= 0 && n <= 0xffffffff ? n : null; })(),
    router: ipv4OrNull(o && o.router),
    dns: (o && Array.isArray(o.dns) ? o.dns : []).map(ipv4OrNull).filter(Boolean).slice(0, MAX_DHCP_DNS),
    subnetMask: ipv4OrNull(o && o.subnetMask),
    relay: ipv4OrNull(o && o.relay),
  }));
  // Recomputed from the offers that survived validation rather than taken on
  // trust: it is the number the rogue-server finding is decided on, and it has
  // to agree with the list stored beside it. An offer without a server
  // identifier still counts once, exactly as the agent counts it.
  const ids = new Set(offers.map((o) => o.serverId).filter(Boolean));
  const serverCount = ids.size + (offers.some((o) => !o.serverId) ? 1 : 0);
  const timeout = intOrNull(r.timeoutMs ?? r.timeout_ms);
  return {
    iface: typeof r.iface === 'string' && IFACE_RE.test(r.iface.trim()) ? r.iface.trim() : null,
    timeoutMs: timeout != null && timeout >= DHCP_TIMEOUT_MS.min && timeout <= DHCP_TIMEOUT_MS.max ? timeout : null,
    offers,
    serverCount,
  };
}

// How a failed TCP connect ended, as the agent classifies it. Anything else is
// dropped rather than stored: the finding text switches on this value, and a
// word it does not know would read as "no classification" while looking like
// data.
const TCP_FAILURES = ['refused', 'timeout', 'unreachable', 'error'];
// Every responding address at one TTL (ECMP members answering within one run).
// Bounded: a hop answering from more addresses than this is not a load balancer
// any operator can act on, and the list is stored on every hop of every run.
const MAX_HOP_IPS = 8;

// A resolver/socket errno as the platform names it (ENOTFOUND, ETIMEOUT,
// ESERVFAIL, ECONNREFUSED, EAI_AGAIN …). Only the errno shape is accepted —
// this string ends up in a finding sentence, so free text has no business here.
function errorCodeOf(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  return /^[A-Z0-9_]{1,32}$/.test(s) ? s : null;
}

function tcpFailureOf(v) {
  const s = v == null ? '' : String(v).toLowerCase();
  return TCP_FAILURES.includes(s) ? s : null;
}

// The distinct responding addresses on one hop, first == the hop's own `ip`
// (null for a silent hop). Readers that just want the members use
// hopMembers() in src/analysis/pathGraph.js, which falls back to `ip`.
function hopIpsOf(h, ip) {
  const out = [];
  if (ip) out.push(ip);
  for (const raw of Array.isArray(h && h.ips) ? h.ips : []) {
    if (raw == null || raw === '') continue;
    const s = String(raw).slice(0, 45);
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_HOP_IPS) break;
  }
  return out.length ? out : null;
}

// Normalizes an http-probe target to a canonical http(s) URL string (defaulting
// a bare host to https), or null when it isn't a valid http(s) URL. The URL is
// passed to the agent's `fetch`, never a shell, so the HOST_RE CLI-flag guard
// (which would reject the "://") doesn't apply here.
function normalizeHttpTarget(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) return null;
  } else {
    s = `https://${s}`;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  return u.href.length <= 255 ? u.href : null;
}

// Validates the agent -> server probe-results payload:
//   { results: [ { type, target, ok, rttMs?, lossPct?, jitterMs?, hops?, ... } ] }
function validateProbeResults(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.results)) return { errors: { results: 'results must be an array' } };
  if (b.results.length === 0) return { errors: { results: 'results must not be empty' } };
  if (b.results.length > MAX_RESULTS) return { errors: { results: `too many results (max ${MAX_RESULTS})` } };
  const out = [];
  for (let i = 0; i < b.results.length; i += 1) {
    const r = b.results[i];
    if (!r || typeof r !== 'object') return { errors: { [`results[${i}]`]: 'must be an object' } };
    const type = String(r.type || '').toLowerCase();
    if (!PROBE_TYPES.includes(type)) return { errors: { [`results[${i}].type`]: `type must be one of ${PROBE_TYPES.join(', ')}` } };
    const target = String(r.target || '').trim();
    if (!target || target.length > 255) return { errors: { [`results[${i}].target`]: 'target is required (<=255 chars)' } };
    let ts = null;
    if (r.ts) {
      const d = new Date(r.ts);
      if (Number.isNaN(d.getTime())) return { errors: { [`results[${i}].ts`]: 'ts must be a valid date' } };
      ts = d;
    }
    if (type === 'dhcp' && r.offers != null) {
      if (!Array.isArray(r.offers) || r.offers.length > MAX_DHCP_OFFERS) return { errors: { [`results[${i}].offers`]: `offers must be an array (<=${MAX_DHCP_OFFERS})` } };
      if (r.serverCount != null && !(Number.isInteger(r.serverCount) && r.serverCount >= 0 && r.serverCount <= MAX_DHCP_OFFERS)) {
        return { errors: { [`results[${i}].serverCount`]: `serverCount must be an integer between 0 and ${MAX_DHCP_OFFERS}` } };
      }
    }
    let elements = null;
    if (r.elements != null) {
      if (!Array.isArray(r.elements) || r.elements.length > 64) return { errors: { [`results[${i}].elements`]: 'elements must be an array (<=64)' } };
      // pageload waterfall: one row per fetched resource (document first). Metadata
      // only — URL, resource kind, HTTP status, byte count and load time in ms.
      elements = r.elements.map((e) => ({
        url: e && e.url ? String(e.url).slice(0, 255) : null,
        kind: e && e.kind ? String(e.kind).slice(0, 16) : null,
        status: intOrNull(e && e.status),
        bytes: intOrNull(e && e.bytes),
        ms: numOrNull(e && e.ms),
      }));
    }
    let hops = null;
    if (r.hops != null) {
      if (!Array.isArray(r.hops) || r.hops.length > 64) return { errors: { [`results[${i}].hops`]: 'hops must be an array (<=64)' } };
      // MTR-style hops carry per-hop loss/jitter and the sent/recv probe counts
      // (the path-visualisation overlay). Older agents send only { hop, ip, rttMs };
      // the extra fields normalise to null and are simply absent on the graph.
      hops = r.hops.map((h) => {
        // An agent that sends `ips` but no `ip` still names the hop: the first
        // member is its representative, exactly as the agent defines it.
        const ip0 = h && h.ip ? String(h.ip).slice(0, 45)
          : (h && Array.isArray(h.ips) && h.ips[0] ? String(h.ips[0]).slice(0, 45) : null);
        return {
          hop: numOrNull(h && h.hop),
          ip: ip0,
          // Every address that answered at this TTL in THIS run. Two members
          // of an ECMP group answering one run is a fork the path graph and the
          // diagnose rules can see without waiting for a second run. Null when
          // the agent did not send the list (older agents): "one address was
          // reported" and "one address answered" are different claims, and
          // only the second may rule ECMP out.
          ips: h && Array.isArray(h.ips) ? hopIpsOf(h, ip0) : null,
          rttMs: numOrNull(h && h.rttMs),
          minMs: numOrNull(h && h.minMs),
          maxMs: numOrNull(h && h.maxMs),
          jitterMs: numOrNull(h && h.jitterMs),
          lossPct: numOrNull(h && h.lossPct),
          sent: intOrNull(h && h.sent),
          recv: intOrNull(h && h.recv),
          // path_mtu adds the largest packet that reached this hop and what that
          // means. Null on a traceroute row, exactly as the latency fields above
          // are null on a path_mtu one — one hop shape, two kinds of measurement.
          maxMtu: sizeOrNull(h && (h.max_mtu ?? h.maxMtu)),
          status: mtuStatusOf(h && h.status),
        };
      });
    }
    // The ping size sweep. The row's own rtt/loss columns describe the SMALLEST
    // size, so this is the only place the size dependence lives.
    let sizes = null;
    if (r.sizes != null) {
      if (!Array.isArray(r.sizes) || r.sizes.length > MAX_PING_SIZES) return { errors: { [`results[${i}].sizes`]: `sizes must be an array (<=${MAX_PING_SIZES})` } };
      sizes = r.sizes.map((s0) => ({
        bytes: intOrNull(s0 && s0.bytes),
        sent: intOrNull(s0 && s0.sent),
        recv: intOrNull(s0 && s0.recv),
        lossPct: numOrNull(s0 && s0.lossPct),
        rttMs: numOrNull(s0 && s0.rttMs),
        minMs: numOrNull(s0 && s0.minMs),
        maxMs: numOrNull(s0 && s0.maxMs),
        jitterMs: numOrNull(s0 && s0.jitterMs),
        mtuHint: intOrNull(s0 && s0.mtuHint),
        // Did the probe MEASURE this size, or did it never leave the host? A
        // payload the local interface refused is not 100% loss on the path, and
        // reading it as such would point the diagnosis at the wrong end.
        measured: s0 ? s0.measured !== false : false,
        error: s0 && s0.error != null ? String(s0.error).slice(0, 200) : null,
      }));
    }
    out.push({
      ts, type, target, ok: r.ok === true,
      rttMs: numOrNull(r.rttMs), minMs: numOrNull(r.minMs), maxMs: numOrNull(r.maxMs),
      jitterMs: numOrNull(r.jitterMs), lossPct: numOrNull(r.lossPct), hops,
      status: intOrNull(r.status), certExpiryDays: numOrNull(r.certExpiryDays),
      // curl content-check metadata (null for the other probe types). Privacy by
      // design: the agent reports only the received byte count + content-type,
      // never the response body itself.
      bytes: intOrNull(r.bytes), contentType: r.contentType != null ? String(r.contentType).slice(0, 120) : null,
      elements,
      // The path-MTU verdict. The agent reports it in the wire shape documented
      // for the probe (snake_case); this is the one place it is translated to
      // the camelCase the repository, the root-cause rules and the dashboard
      // use, the same way rtt_ms became rttMs above. Only path_mtu rows carry it.
      mtu: type === 'path_mtu' ? mtuBlock(r) : null,
      // The certificate the port presented, and what the address says it is
      // called. Same treatment as the MTU verdict: only the probe that produces
      // one carries it, and it is copied field by field rather than spread.
      tls: type === 'tls' && tlsSource(r) ? tlsBlock(tlsSource(r)) : null,
      rdns: type === 'rdns' ? rdnsBlock(r) : null,
      // The DHCP offers (migration 132). Only a dhcp row carries them.
      dhcp: type === 'dhcp' ? dhcpBlock(r) : null,
      sizes,
      // A sweep also says whether don't-fragment was set; without it the sizes
      // mean nothing, because the path would simply have fragmented them.
      df: r.df === true,
      detail: r.detail != null ? String(r.detail).slice(0, 255) : (r.error != null ? String(r.error).slice(0, 255) : null),
      // The agent sets `error` only when it could not RUN the probe at all
      // (binary missing, tool timed out, unknown type) — distinct from ordinary
      // reachability loss, which reports metrics with no error. Preserved here
      // (separate from the stored `detail`) so ingestion can audit a genuine
      // "agent cannot perform this task" without flagging every host-down probe.
      execError: r.error != null ? String(r.error).slice(0, 255) : null,
      // WHY a dns/tcp probe failed (migration 121). Optional: older agents omit
      // them and the finding falls back to "not responding". `failure` is the
      // TCP probe's own classification, so only a tcp row may carry it.
      errorCode: (type === 'dns' || type === 'tcp') ? errorCodeOf(r.errorCode ?? r.error_code) : null,
      failure: type === 'tcp' ? tcpFailureOf(r.failure) : null,
      resolver: type === 'dns' && isSafeHost(r.resolver) ? String(r.resolver).trim().slice(0, 64) : null,
    });
  }
  return { value: { results: out } };
}

// Validates the operator trigger spec: { type, host|target|url, port?, count?, maxHops? }.
function validateProbeSpec(body) {
  const b = body && typeof body === 'object' ? body : {};
  const type = String(b.type || '').toLowerCase();
  if (!PROBE_TYPES.includes(type)) return { errors: { type: `type must be one of ${PROBE_TYPES.join(', ')}` } };

  const spec = { type };
  if (type === 'http' || type === 'curl' || type === 'pageload') {
    // http/curl/pageload take a URL (the agent reads spec.host as the target).
    const url = normalizeHttpTarget(b.url || b.target || b.host);
    if (!url) return { errors: { target: `a valid http(s) URL is required for a ${type} probe` } };
    spec.host = url;
    if (type === 'pageload' && b.maxElements !== undefined) {
      const m = Number(b.maxElements);
      if (!Number.isInteger(m) || m < 1 || m > 40) return { errors: { maxElements: 'maxElements must be an integer between 1 and 40' } };
      spec.maxElements = m;
    }
    if (type === 'curl') {
      // Content-verification parameters. All optional; with none set the curl
      // probe degrades to a status<400 reachability check (like the http probe).
      if (b.method !== undefined) {
        const m = String(b.method).toUpperCase();
        if (!HTTP_METHODS.includes(m)) return { errors: { method: `method must be one of ${HTTP_METHODS.join(', ')}` } };
        spec.method = m;
      }
      if (b.expectStatus !== undefined) {
        const s = Number(b.expectStatus);
        if (!Number.isInteger(s) || s < 100 || s > 599) return { errors: { expectStatus: 'expectStatus must be an HTTP status code (100-599)' } };
        spec.expectStatus = s;
      }
      if (b.expectBody !== undefined) {
        const body = String(b.expectBody);
        if (!body || body.length > 512) return { errors: { expectBody: 'expectBody must be 1-512 chars (a substring or /regex/)' } };
        spec.expectBody = body;
      }
      if (b.expectHeader !== undefined) {
        const h = String(b.expectHeader).trim();
        if (!HEADER_EXPECT_RE.test(h)) return { errors: { expectHeader: 'expectHeader must be "Name" or "Name: value"' } };
        spec.expectHeader = h;
      }
      if (b.minBytes !== undefined) {
        const mb = Number(b.minBytes);
        if (!Number.isInteger(mb) || mb < 0 || mb > 1e9) return { errors: { minBytes: 'minBytes must be a non-negative integer' } };
        spec.minBytes = mb;
      }
      if (b.maxBytes !== undefined) {
        const mb = Number(b.maxBytes);
        if (!Number.isInteger(mb) || mb < 1 || mb > 1e9) return { errors: { maxBytes: 'maxBytes must be a positive integer' } };
        spec.maxBytes = mb;
      }
    }
  } else if (type === 'transaction') {
    // A multi-step journey: ordered steps, each an http(s) request (the URL may
    // carry {{vars}} extracted from earlier steps) with optional assertions and an
    // optional value extraction. The agent runs them in order and stops on failure.
    if (!Array.isArray(b.steps) || b.steps.length === 0) return { errors: { steps: 'a transaction needs at least one step' } };
    if (b.steps.length > 10) return { errors: { steps: 'too many steps (max 10)' } };
    const steps = [];
    for (let i = 0; i < b.steps.length; i += 1) {
      const s = b.steps[i] && typeof b.steps[i] === 'object' ? b.steps[i] : {};
      const url = String(s.url || '').trim();
      if (!/^https?:\/\//i.test(url) || url.length > 512) return { errors: { [`steps[${i}].url`]: 'each step needs an http(s) URL (<=512 chars; may contain {{vars}})' } };
      const step = { url };
      if (s.method !== undefined && s.method !== '') {
        const m = String(s.method).toUpperCase();
        if (!HTTP_METHODS.includes(m)) return { errors: { [`steps[${i}].method`]: `method must be one of ${HTTP_METHODS.join(', ')}` } };
        if (m !== 'GET') step.method = m;
      }
      if (s.expectStatus !== undefined && s.expectStatus !== null && s.expectStatus !== '') {
        const st = Number(s.expectStatus);
        if (!Number.isInteger(st) || st < 100 || st > 599) return { errors: { [`steps[${i}].expectStatus`]: 'expectStatus must be 100-599' } };
        step.expectStatus = st;
      }
      if (s.expectBody) {
        const eb = String(s.expectBody);
        if (eb.length > 512) return { errors: { [`steps[${i}].expectBody`]: 'expectBody must be <=512 chars' } };
        step.expectBody = eb;
      }
      if (s.header) {
        const h = String(s.header).trim();
        if (h.length > 256) return { errors: { [`steps[${i}].header`]: 'header must be <=256 chars' } };
        if (!HEADER_SEND_RE.test(h)) return { errors: { [`steps[${i}].header`]: 'header must be a "Name: value" field (a local-file reference is not accepted)' } };
        step.header = h;
      }
      if (s.data) {
        const d = String(s.data);
        if (d.length > 2048) return { errors: { [`steps[${i}].data`]: 'data must be <=2048 chars' } };
        // '@' is curl's "read the body from this file" marker. The agent sends
        // the body with --data-raw so it is never opened, but a spec that only
        // makes sense as a file read is a mistake (or an attempt) either way.
        if (d.startsWith('@')) return { errors: { [`steps[${i}].data`]: 'data must not start with "@" (a local-file reference is not accepted)' } };
        step.data = d;
      }
      if (s.extract && typeof s.extract === 'object' && (s.extract.name || s.extract.pattern)) {
        const name = String(s.extract.name || '').trim();
        const pattern = String(s.extract.pattern || '');
        if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) return { errors: { [`steps[${i}].extract.name`]: 'extract name must be 1-64 chars [A-Za-z0-9_]' } };
        if (!pattern || pattern.length > 256) return { errors: { [`steps[${i}].extract.pattern`]: 'extract pattern is required (<=256 chars)' } };
        try { new RegExp(pattern); } catch { return { errors: { [`steps[${i}].extract.pattern`]: 'extract pattern is not a valid regex' } }; }
        step.extract = { name, pattern, from: s.extract.from === 'header' ? 'header' : 'body' };
      }
      steps.push(step);
    }
    spec.steps = steps;
    spec.host = steps[0].url.slice(0, 255); // target/display column
    if (b.name) spec.name = String(b.name).slice(0, 120);
  } else if (type === 'path_mtu') {
    // Sizes are IP PACKET sizes, which is what an MTU is — the agent subtracts
    // the header overhead before handing a payload length to `ping`. Validating
    // the same bounds the agent enforces means an operator gets a 400 with a
    // reason instead of a probe that silently clamps and reports a number they
    // did not ask for.
    const host = String(b.host || b.target || '').trim();
    if (!isSafeHost(host)) return { errors: { host: 'host/target is required and must be a valid hostname or IP' } };
    spec.host = host;
    // An IPv6 literal names its own family, so an operator who types an address
    // gets IPv6 without also remembering a parameter — and, more importantly, the
    // size floor below is then checked against 1280 rather than 576. Resolving it
    // HERE rather than leaving it to the agent means the stored spec says what
    // will actually run.
    const ipVersion = familyOf(b.ip_version, host);
    if (ipVersion === null) return { errors: { ip_version: 'ip_version must be 4 or 6' } };
    spec.ip_version = ipVersion;

    const floor = MIN_PACKET_SIZE[ipVersion];
    const maxSize = b.max_size === undefined || b.max_size === null || b.max_size === '' ? 1500 : Number(b.max_size);
    if (!Number.isInteger(maxSize) || maxSize < floor || maxSize > MAX_PACKET_SIZE) {
      return { errors: { max_size: `max_size must be an integer between ${floor} and ${MAX_PACKET_SIZE}` } };
    }
    const minSize = b.min_size === undefined || b.min_size === null || b.min_size === '' ? floor : Number(b.min_size);
    if (!Number.isInteger(minSize) || minSize < floor || minSize > MAX_PACKET_SIZE) {
      return { errors: { min_size: `min_size must be an integer between ${floor} and ${MAX_PACKET_SIZE}` } };
    }
    // Checked as a PAIR, after both are individually sound. Silently swapping
    // them would run a search over an inverted range and report its floor as
    // the path MTU.
    if (minSize > maxSize) return { errors: { min_size: 'min_size must not be greater than max_size' } };
    spec.min_size = minSize;
    spec.max_size = maxSize;

    if (b.per_hop !== undefined) spec.per_hop = b.per_hop === true || b.per_hop === 'true';
    if (b.probes_per_size !== undefined) {
      const n = Number(b.probes_per_size);
      if (!Number.isInteger(n) || n < 1 || n > 10) return { errors: { probes_per_size: 'probes_per_size must be an integer between 1 and 10' } };
      spec.probes_per_size = n;
    }
    if (b.timeout_ms !== undefined) {
      const n = Number(b.timeout_ms);
      if (!Number.isInteger(n) || n < 100 || n > 10000) return { errors: { timeout_ms: 'timeout_ms must be an integer between 100 and 10000' } };
      spec.timeout_ms = n;
    }
    // Optional MSS check. null/'' means "don't", which is the default — it opens
    // a real TCP connection to the target, and that is the operator's call.
    if (b.tcp_port !== undefined && b.tcp_port !== null && b.tcp_port !== '') {
      const port = Number(b.tcp_port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { errors: { tcp_port: 'tcp_port must be an integer between 1 and 65535' } };
      spec.tcp_port = port;
    }
  } else if (type === 'dhcp') {
    // A DHCP test is not aimed at a host: it broadcasts a DISCOVER and listens.
    // The only thing it can be told is which interface to speak for (default:
    // the agent's default-route interface) and how long to listen.
    const iface = b.iface === undefined || b.iface === null ? '' : String(b.iface).trim();
    if (iface) {
      if (!IFACE_RE.test(iface)) return { errors: { iface: 'iface must be an interface name (letters, digits, . _ : @ - space; <=64 chars)' } };
      spec.iface = iface;
    }
    if (b.timeout_ms !== undefined || b.timeoutMs !== undefined) {
      const n = Number(b.timeout_ms ?? b.timeoutMs);
      if (!Number.isInteger(n) || n < DHCP_TIMEOUT_MS.min || n > DHCP_TIMEOUT_MS.max) {
        return { errors: { timeout_ms: `timeout_ms must be an integer between ${DHCP_TIMEOUT_MS.min} and ${DHCP_TIMEOUT_MS.max}` } };
      }
      spec.timeoutMs = n;
    }
    // A count means nothing to a broadcast that collects every answer.
    return { value: spec };
  } else if (type === 'tls') {
    // A certificate lives on a port, not only on a URL: 465 (SMTP), 993 (IMAP),
    // 636 (LDAPS), a database, a management interface. The port is therefore
    // part of the question, and defaults to 443 rather than being required.
    const host = String(b.host || b.target || '').trim();
    if (!isSafeHost(host)) return { errors: { host: 'host/target is required and must be a valid hostname or IP' } };
    spec.host = host;
    const port = b.port === undefined || b.port === null || b.port === '' ? 443 : Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { errors: { port: 'port must be an integer between 1 and 65535' } };
    spec.port = port;
    // SNI. Pointing the probe at an IP and naming the host is how you check the
    // certificate ONE virtual host serves on a shared address, so the name is
    // held to the same rule as any other target rather than passed through.
    if (b.servername !== undefined && b.servername !== null && b.servername !== '') {
      const sni = String(b.servername).trim();
      if (!isSafeHost(sni)) return { errors: { servername: 'servername must be a valid hostname' } };
      spec.servername = sni;
    }
    if (b.timeout_ms !== undefined || b.timeoutMs !== undefined) {
      const n = Number(b.timeout_ms ?? b.timeoutMs);
      if (!Number.isInteger(n) || n < 100 || n > 60000) return { errors: { timeout_ms: 'timeout_ms must be an integer between 100 and 60000' } };
      spec.timeoutMs = n;
    }
  } else {
    const host = String(b.host || b.target || '').trim();
    if (!isSafeHost(host)) return { errors: { host: 'host/target is required and must be a valid hostname or IP' } };
    spec.host = host;
    // The trace probes carry the family too: an IPv6 path is traced by a
    // different binary, and a stored spec that does not say which family it ran
    // as cannot be re-run to the same answer.
    if (type === 'traceroute' || type === 'tcptraceroute') {
      const v = familyOf(b.ip_version, host);
      if (v === null) return { errors: { ip_version: 'ip_version must be 4 or 6' } };
      if (b.ip_version !== undefined || v === 6) spec.ip_version = v;
    }
    if (type === 'ping' && b.sizes !== undefined) {
      // A size sweep: the same target asked at several payload sizes with
      // don't-fragment set. This is what separates "the path is lossy" from
      // "the path has an MTU nobody told the sender about". The agent enforces
      // the same bounds independently (blueeye-agent src/probes/ping.js);
      // rejecting them here too keeps a bad spec out of the database and gives
      // the operator a real error instead of a probe that measures nothing.
      if (!Array.isArray(b.sizes) || b.sizes.length === 0) return { errors: { sizes: 'sizes must be a non-empty array of payload byte counts' } };
      if (b.sizes.length > MAX_PING_SIZES) return { errors: { sizes: `too many sizes (max ${MAX_PING_SIZES})` } };
      const sizes = [];
      for (const raw of b.sizes) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > MAX_PAYLOAD_BYTES) return { errors: { sizes: `each size must be an integer between 0 and ${MAX_PAYLOAD_BYTES}` } };
        if (!sizes.includes(n)) sizes.push(n);
      }
      spec.sizes = sizes.sort((x, y) => x - y);
    }
    if (type === 'ping' && b.df !== undefined) spec.df = b.df === true || b.df === 'true';
    if (type === 'tcp') {
      const port = Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { errors: { port: 'port (1-65535) is required for a tcp probe' } };
      spec.port = port;
    }
    if (type === 'tcptraceroute') {
      // The port is what makes this probe worth running — it is the port the
      // filtered traffic uses. Optional, but pinned to https here rather than
      // left to the agent, so the stored spec always says which port was traced.
      const port = b.port === undefined || b.port === null || b.port === '' ? 443 : Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { errors: { port: 'port must be an integer between 1 and 65535' } };
      spec.port = port;
    }
    if ((type === 'traceroute' || type === 'tcptraceroute') && b.maxHops !== undefined) {
      const m = Number(b.maxHops);
      if (!Number.isInteger(m) || m < 1 || m > 40) return { errors: { maxHops: 'maxHops must be an integer between 1 and 40' } };
      spec.maxHops = m;
    }
    if ((type === 'traceroute' || type === 'tcptraceroute') && b.queries !== undefined) {
      const q = Number(b.queries);
      if (!Number.isInteger(q) || q < 1 || q > 10) return { errors: { queries: 'queries must be an integer between 1 and 10' } };
      spec.queries = q;
    }
  }
  if (b.count !== undefined) {
    const c = Number(b.count);
    if (!Number.isInteger(c) || c < 1 || c > 20) return { errors: { count: 'count must be an integer between 1 and 20' } };
    spec.count = c;
  }
  return { value: spec };
}

module.exports = { validateProbeResults, validateProbeSpec, PROBE_TYPES, MAX_DHCP_OFFERS, MAX_PING_SIZES, MAX_PAYLOAD_BYTES, MTU_HOP_STATUSES, MAX_PACKET_SIZE, TCP_FAILURES, MAX_HOP_IPS };
