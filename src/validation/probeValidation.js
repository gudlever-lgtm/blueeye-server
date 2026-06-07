'use strict';

const PROBE_TYPES = ['ping', 'tcp', 'dns', 'traceroute', 'http'];
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
    let hops = null;
    if (r.hops != null) {
      if (!Array.isArray(r.hops) || r.hops.length > 64) return { errors: { [`results[${i}].hops`]: 'hops must be an array (<=64)' } };
      hops = r.hops.map((h) => ({ hop: numOrNull(h && h.hop), ip: h && h.ip ? String(h.ip).slice(0, 45) : null, rttMs: numOrNull(h && h.rttMs) }));
    }
    out.push({
      ts, type, target, ok: r.ok === true,
      rttMs: numOrNull(r.rttMs), minMs: numOrNull(r.minMs), maxMs: numOrNull(r.maxMs),
      jitterMs: numOrNull(r.jitterMs), lossPct: numOrNull(r.lossPct), hops,
      status: intOrNull(r.status), certExpiryDays: numOrNull(r.certExpiryDays),
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
  if (type === 'http') {
    // http takes a URL (the agent reads spec.host as the target).
    const url = normalizeHttpTarget(b.url || b.target || b.host);
    if (!url) return { errors: { target: 'a valid http(s) URL is required for an http probe' } };
    spec.host = url;
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
  }
  if (b.count !== undefined) {
    const c = Number(b.count);
    if (!Number.isInteger(c) || c < 1 || c > 20) return { errors: { count: 'count must be an integer between 1 and 20' } };
    spec.count = c;
  }
  return { value: spec };
}

module.exports = { validateProbeResults, validateProbeSpec, PROBE_TYPES };
