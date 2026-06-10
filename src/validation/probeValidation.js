'use strict';

const PROBE_TYPES = ['ping', 'tcp', 'dns', 'traceroute', 'http', 'curl', 'pageload', 'transaction'];
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const HEADER_EXPECT_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(\s*:\s*.{1,200})?$/;
const MAX_RESULTS = 200;
// Host/IP/hostname must start alphanumeric (so it can never be read as a CLI
// flag like "-rf") and contain only host-safe characters.
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/;

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
      hops = r.hops.map((h) => ({
        hop: numOrNull(h && h.hop),
        ip: h && h.ip ? String(h.ip).slice(0, 45) : null,
        rttMs: numOrNull(h && h.rttMs),
        minMs: numOrNull(h && h.minMs),
        maxMs: numOrNull(h && h.maxMs),
        jitterMs: numOrNull(h && h.jitterMs),
        lossPct: numOrNull(h && h.lossPct),
        sent: intOrNull(h && h.sent),
        recv: intOrNull(h && h.recv),
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
      detail: r.detail != null ? String(r.detail).slice(0, 255) : (r.error != null ? String(r.error).slice(0, 255) : null),
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
        const h = String(s.header);
        if (h.length > 256) return { errors: { [`steps[${i}].header`]: 'header must be <=256 chars' } };
        step.header = h;
      }
      if (s.data) {
        const d = String(s.data);
        if (d.length > 2048) return { errors: { [`steps[${i}].data`]: 'data must be <=2048 chars' } };
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
  } else {
    const host = String(b.host || b.target || '').trim();
    if (!HOST_RE.test(host)) return { errors: { host: 'host/target is required and must be a valid hostname or IP' } };
    spec.host = host;
    if (type === 'tcp') {
      const port = Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { errors: { port: 'port (1-65535) is required for a tcp probe' } };
      spec.port = port;
    }
    if (type === 'traceroute' && b.maxHops !== undefined) {
      const m = Number(b.maxHops);
      if (!Number.isInteger(m) || m < 1 || m > 40) return { errors: { maxHops: 'maxHops must be an integer between 1 and 40' } };
      spec.maxHops = m;
    }
    if (type === 'traceroute' && b.queries !== undefined) {
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

module.exports = { validateProbeResults, validateProbeSpec, PROBE_TYPES };
