'use strict';

// Validation for the transaction-test domain (respec). Pure functions returning
// `{ value }` or `{ errors }` — never both. Config shape depends on `type`.
// Secrets are a write-only { name: value } map; http steps may reference them as
// `{{secret:name}}` — a reference to an undeclared secret is rejected.

const net = require('net');

const TEST_TYPES = ['http', 'tcp', 'dns', 'icmp'];
// How a test captures around its runs. 'off' means tcpdump is never spawned —
// not spawned and discarded. Default everywhere.
const CAPTURE_MODES = ['off', 'on_fault', 'always'];
// The phases a step is split into (agent: src/transactions/phases.js). Fixed
// list: a phase the server does not know about is dropped rather than stored,
// so the column's shape stays something the dashboard can rely on.
const PHASE_KEYS = ['dns', 'tcp', 'tls', 'ttfb', 'transfer'];
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'PTR', 'SRV'];
const EXTRACT_TYPES = ['regex', 'json', 'cookie'];
const DEVIATION_ALERTS = ['slower', 'faster', 'any'];
// Host/IP must start alphanumeric (never read as a CLI flag) and be host-safe.
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/;
const SECRET_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const SECRET_REF_RE = /\{\{\s*secret:([A-Za-z0-9_]{1,64})\s*\}\}/g;
const NAME_MAX = 255;
const MAX_STEPS = 20;

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Collects every {{secret:NAME}} reference in a string.
function secretRefsIn(str, out) {
  if (typeof str !== 'string') return;
  let m;
  SECRET_REF_RE.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = SECRET_REF_RE.exec(str)) !== null) out.add(m[1]);
}

// Optional alert thresholds (nested in config): consecutive_fails / latency_ms /
// deviation. Returns { value } or { error } (single message).
function validateThresholds(raw) {
  if (raw === undefined || raw === null) return { value: undefined };
  if (!isPlainObject(raw)) return { error: 'thresholds must be an object' };
  const out = {};
  if (raw.consecutive_fails !== undefined && raw.consecutive_fails !== null && raw.consecutive_fails !== '') {
    const n = Number(raw.consecutive_fails);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { error: 'thresholds.consecutive_fails must be an integer 1-100' };
    out.consecutive_fails = n;
  }
  if (raw.latency_ms !== undefined && raw.latency_ms !== null && raw.latency_ms !== '') {
    const n = Number(raw.latency_ms);
    if (!Number.isInteger(n) || n < 1 || n > 3600000) return { error: 'thresholds.latency_ms must be an integer 1-3600000' };
    out.latency_ms = n;
  }
  if (raw.deviation !== undefined && raw.deviation !== null && raw.deviation !== '') {
    const d = String(raw.deviation).toLowerCase();
    if (!DEVIATION_ALERTS.includes(d)) return { error: `thresholds.deviation must be one of ${DEVIATION_ALERTS.join(', ')}` };
    out.deviation = d;
  }
  return { value: Object.keys(out).length ? out : undefined };
}

// http config: { steps: [...], thresholds? }. Each step is an http(s) request.
function validateHttpConfig(config, declaredSecrets, errors) {
  if (!isPlainObject(config) || !Array.isArray(config.steps) || config.steps.length === 0) {
    errors.config = 'http test needs config.steps (a non-empty array)';
    return null;
  }
  if (config.steps.length > MAX_STEPS) { errors.config = `too many steps (max ${MAX_STEPS})`; return null; }
  const usedSecrets = new Set();
  const steps = [];
  for (let i = 0; i < config.steps.length; i += 1) {
    const s = isPlainObject(config.steps[i]) ? config.steps[i] : {};
    const url = String(s.url || '').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 1024) {
      errors[`config.steps[${i}].url`] = 'each step needs an http(s) URL (<=1024 chars; may contain {{secret:x}}/{{var}})';
      return null;
    }
    const step = { url };
    secretRefsIn(url, usedSecrets);
    if (s.name !== undefined && s.name !== '') step.name = String(s.name).slice(0, 120);
    const method = String(s.method || 'GET').toUpperCase();
    if (!HTTP_METHODS.includes(method)) { errors[`config.steps[${i}].method`] = `method must be one of ${HTTP_METHODS.join(', ')}`; return null; }
    step.method = method;
    if (s.headers !== undefined && s.headers !== null) {
      if (!isPlainObject(s.headers)) { errors[`config.steps[${i}].headers`] = 'headers must be an object'; return null; }
      const headers = {};
      for (const [k, v] of Object.entries(s.headers)) {
        const key = String(k).slice(0, 128);
        const val = String(v).slice(0, 2048);
        headers[key] = val;
        secretRefsIn(key, usedSecrets); secretRefsIn(val, usedSecrets);
      }
      step.headers = headers;
    }
    if (s.body !== undefined && s.body !== null && s.body !== '') {
      const body = String(s.body);
      if (body.length > 8192) { errors[`config.steps[${i}].body`] = 'body must be <=8192 chars'; return null; }
      step.body = body;
      secretRefsIn(body, usedSecrets);
    }
    if (s.expect_status !== undefined && s.expect_status !== null && s.expect_status !== '') {
      const st = Number(s.expect_status);
      if (!Number.isInteger(st) || st < 100 || st > 599) { errors[`config.steps[${i}].expect_status`] = 'expect_status must be 100-599'; return null; }
      step.expect_status = st;
    }
    if (s.expect_keyword) {
      const kw = String(s.expect_keyword);
      if (kw.length > 512) { errors[`config.steps[${i}].expect_keyword`] = 'expect_keyword must be <=512 chars'; return null; }
      step.expect_keyword = kw;
    }
    if (s.extract && isPlainObject(s.extract) && (s.extract.name || s.extract.pattern)) {
      const name = String(s.extract.name || '').trim();
      const type = String(s.extract.type || 'regex').toLowerCase();
      const pattern = String(s.extract.pattern || '');
      if (!SECRET_NAME_RE.test(name)) { errors[`config.steps[${i}].extract.name`] = 'extract name must be 1-64 chars [A-Za-z0-9_]'; return null; }
      if (!EXTRACT_TYPES.includes(type)) { errors[`config.steps[${i}].extract.type`] = `extract type must be one of ${EXTRACT_TYPES.join(', ')}`; return null; }
      if (!pattern || pattern.length > 256) { errors[`config.steps[${i}].extract.pattern`] = 'extract pattern is required (<=256 chars)'; return null; }
      if (type === 'regex') { try { new RegExp(pattern); } catch { errors[`config.steps[${i}].extract.pattern`] = 'extract pattern is not a valid regex'; return null; } }
      step.extract = { name, type, pattern };
    }
    steps.push(step);
  }
  // Reject references to secrets that weren't declared.
  for (const ref of usedSecrets) {
    if (!declaredSecrets.has(ref)) { errors.config = `unknown secret reference {{secret:${ref}}} — declare it in secrets`; return null; }
  }
  return { steps };
}

function validateDnsConfig(config, errors) {
  const c = isPlainObject(config) ? config : {};
  const record = String(c.record || 'A').toUpperCase();
  if (!DNS_RECORD_TYPES.includes(record)) { errors['config.record']  = `record must be one of ${DNS_RECORD_TYPES.join(', ')}`; return null; }
  const out = { record };
  if (c.expect !== undefined && c.expect !== null && c.expect !== '') {
    const expect = String(c.expect);
    if (expect.length > 255) { errors['config.expect'] = 'expect must be <=255 chars'; return null; }
    out.expect = expect;
  }
  return out;
}

// Validates a create/update body. `existingSecretNames` supplies the declared
// secret set when the body omits `secrets` (update keeps stored secrets).
function validateTransactionInput(body, { existingSecretNames = [] } = {}) {
  const b = isPlainObject(body) ? body : {};
  const errors = {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) errors.name = 'name is required';
  else if (name.length > NAME_MAX) errors.name = `name must be at most ${NAME_MAX} characters`;

  const type = String(b.type || '').toLowerCase();
  if (!TEST_TYPES.includes(type)) errors.type = `type must be one of ${TEST_TYPES.join(', ')}`;

  // Secrets (write-only). When provided, must be a { name: string } map.
  let secrets; // undefined = keep existing
  const declaredSecrets = new Set(existingSecretNames);
  if (b.secrets !== undefined && b.secrets !== null) {
    if (!isPlainObject(b.secrets)) errors.secrets = 'secrets must be an object of name -> value';
    else {
      secrets = {};
      for (const [k, v] of Object.entries(b.secrets)) {
        if (!SECRET_NAME_RE.test(k)) { errors.secrets = `secret name "${k}" must be 1-64 chars [A-Za-z0-9_]`; break; }
        secrets[k] = String(v);
      }
      if (!errors.secrets) { declaredSecrets.clear(); for (const k of Object.keys(secrets)) declaredSecrets.add(k); }
    }
  }

  if (errors.type) return { errors }; // can't pick a config validator

  // target + per-type config.
  let target = typeof b.target === 'string' ? b.target.trim() : '';
  let config = null;
  if (type === 'http') {
    config = validateHttpConfig(b.config, declaredSecrets, errors);
    if (config && !target) target = config.steps[0].url.slice(0, 255);
  } else if (type === 'tcp') {
    if (!HOST_RE.test(target)) errors.target = 'target host is required and must be a valid hostname or IP';
    const port = Number(isPlainObject(b.config) ? b.config.port : undefined);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors['config.port'] = 'port (1-65535) is required for a tcp test';
    else config = { port };
  } else if (type === 'dns') {
    if (!HOST_RE.test(target)) errors.target = 'target host is required and must be a valid hostname';
    config = validateDnsConfig(b.config, errors);
  } else if (type === 'icmp') {
    if (!HOST_RE.test(target)) errors.target = 'target host is required and must be a valid hostname or IP';
    config = {};
  }

  // thresholds (nested in config).
  const thr = validateThresholds(isPlainObject(b.config) ? b.config.thresholds : undefined);
  if (thr.error) errors['config.thresholds'] = thr.error;

  let intervalSec = 60;
  if (b.interval_sec !== undefined && b.interval_sec !== null && b.interval_sec !== '') {
    const n = Number(b.interval_sec);
    if (!Number.isInteger(n) || n < 5 || n > 86400) errors.interval_sec = 'interval_sec must be an integer 5-86400';
    else intervalSec = n;
  }

  // Header capture around this test's runs. Defaults to 'off', and an
  // unrecognised value is an ERROR rather than a silent fall back to 'off' — a
  // typo that quietly disables collection is worse than one that is refused, and
  // the same typo falling the other way would enable it by accident.
  let capture = 'off';
  if (b.capture !== undefined && b.capture !== null && b.capture !== '') {
    const mode = String(b.capture).toLowerCase();
    if (!CAPTURE_MODES.includes(mode)) errors.capture = `capture must be one of ${CAPTURE_MODES.join(', ')}`;
    else capture = mode;
  }

  if (Object.keys(errors).length) return { errors };

  if (thr.value) config.thresholds = thr.value;
  return {
    value: {
      name,
      type,
      target: target || null,
      config,
      secrets, // undefined = keep existing; object = replace
      interval_sec: intervalSec,
      capture,
      enabled: b.enabled !== false,
    },
  };
}

// PUT /:id/agents body: { agent_ids: [int, ...] } (empty clears all).
function validateAgentAssignment(body) {
  const b = isPlainObject(body) ? body : {};
  if (!Array.isArray(b.agent_ids)) return { errors: { agent_ids: 'agent_ids must be an array' } };
  if (b.agent_ids.length > 1000) return { errors: { agent_ids: 'too many agents (max 1000)' } };
  const ids = [];
  const seen = new Set();
  for (let i = 0; i < b.agent_ids.length; i += 1) {
    const n = Number(b.agent_ids[i]);
    if (!Number.isInteger(n) || n < 1) return { errors: { [`agent_ids[${i}]`]: 'must be a positive integer' } };
    if (!seen.has(n)) { seen.add(n); ids.push(n); }
  }
  return { value: { agent_ids: ids } };
}

// Validates the agent -> server transaction_result WS payload. Accepts a single
// result object or { results: [...] }. Assignment is enforced by the caller.
function validateResultIngest(payload) {
  const b = isPlainObject(payload) ? payload : {};
  const raw = Array.isArray(b.results) ? b.results : (b.result ? [b.result] : null);
  if (!Array.isArray(raw)) return { errors: { results: 'results must be an array (or a single result)' } };
  if (raw.length === 0) return { errors: { results: 'results must not be empty' } };
  if (raw.length > 1000) return { errors: { results: 'too many results (max 1000)' } };
  const STATUS = ['ok', 'fail', 'timeout', 'error'];
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    if (!isPlainObject(r)) return { errors: { [`results[${i}]`]: 'must be an object' } };
    const testId = Number(r.test_id);
    if (!Number.isInteger(testId) || testId < 1) return { errors: { [`results[${i}].test_id`]: 'test_id must be a positive integer' } };
    const status = String(r.status || '').toLowerCase();
    if (!STATUS.includes(status)) return { errors: { [`results[${i}].status`]: `status must be one of ${STATUS.join(', ')}` } };
    let latencyMs = null;
    if (r.latency_ms !== undefined && r.latency_ms !== null && r.latency_ms !== '') {
      const n = Number(r.latency_ms);
      if (!Number.isFinite(n) || n < 0) return { errors: { [`results[${i}].latency_ms`]: 'latency_ms must be a non-negative number' } };
      latencyMs = Math.round(n);
    }
    let time = null;
    if (r.time) { const d = new Date(r.time); if (Number.isNaN(d.getTime())) return { errors: { [`results[${i}].time`]: 'time must be a valid date' } }; time = d; }
    let stepTimings = null;
    if (r.step_timings !== undefined && r.step_timings !== null) {
      if (!Array.isArray(r.step_timings) || r.step_timings.length > 64) return { errors: { [`results[${i}].step_timings`]: 'step_timings must be an array (<=64)' } };
      stepTimings = r.step_timings.map((v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; });
    }
    // Phase breakdown per step: { dns, tcp, tls, ttfb, transfer, reused?,
    // address?, localPort?, remotePort? }, each number or null. NULL IS KEPT AS
    // NULL — it means the moment never happened (no TLS, a reused keep-alive
    // socket), and coercing it to 0 would make a missing handshake render as an
    // instant one, which is the exact case worth seeing.
    let stepPhases = null;
    if (r.step_phases !== undefined && r.step_phases !== null) {
      if (!Array.isArray(r.step_phases) || r.step_phases.length > 64) {
        return { errors: { [`results[${i}].step_phases`]: 'step_phases must be an array (<=64)' } };
      }
      stepPhases = r.step_phases.map((raw) => {
        if (!isPlainObject(raw)) return null;
        const out = {};
        for (const key of PHASE_KEYS) {
          const v = raw[key];
          if (v === undefined || v === null) { out[key] = null; continue; }
          const n = Number(v);
          out[key] = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
        }
        if (raw.reused === true) out.reused = true;
        // The address the name actually resolved to. Validated as an address
        // rather than trusted as a string: it is agent-supplied and ends up on
        // a screen next to the test's configured target.
        if (typeof raw.address === 'string' && net.isIP(raw.address.trim())) out.address = raw.address.trim();
        for (const key of ['localPort', 'remotePort']) {
          const n = Number(raw[key]);
          if (Number.isInteger(n) && n > 0 && n <= 65535) out[key] = n;
        }
        return out;
      });
    }
    let stepFailed = null;
    if (r.step_failed !== undefined && r.step_failed !== null && r.step_failed !== '') {
      const n = Number(r.step_failed);
      if (!Number.isInteger(n) || n < 0 || n > 127) return { errors: { [`results[${i}].step_failed`]: 'step_failed must be 0-127' } };
      stepFailed = n;
    }
    let detail = null;
    if (r.detail !== undefined && r.detail !== null) {
      // Structured { phase, step, errno } — stored as a bounded JSON string.
      const json = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail);
      if (json.length > 255) return { errors: { [`results[${i}].detail`]: 'detail is too large (max 255 chars)' } };
      detail = r.detail;
    }
    out.push({ test_id: testId, status, latency_ms: latencyMs, time, step_timings: stepTimings, step_phases: stepPhases, step_failed: stepFailed, detail });
  }
  return { value: { results: out } };
}

// A `transaction_capture` frame from an agent. The packet records are bounded
// and every field is re-read here: the agent is authenticated, but a row that
// lands in the database is a row somebody will read as fact, and "the agent
// said so" is not a validation.
//
// FIELDS NOT ON THIS LIST ARE DROPPED. That is the privacy boundary restated on
// the ingest side: even an agent that somehow sent a payload field could not get
// one stored, because only these keys are copied out.
const PACKET_INT_KEYS = ['sport', 'dport', 'len', 'ttl', 'seq', 'ack', 'win', 'mss', 'payload', 'proto'];
const MAX_PACKETS = 2000;

function validateCaptureIngest(payload) {
  const b = isPlainObject(payload) ? payload : {};
  const testId = Number(b.test_id);
  if (!Number.isInteger(testId) || testId < 1) return { errors: { test_id: 'test_id must be a positive integer' } };

  let time = null;
  if (b.time) { const d = new Date(b.time); if (Number.isNaN(d.getTime())) return { errors: { time: 'time must be a valid date' } }; time = d; }
  if (!time) return { errors: { time: 'time is required — it is how the capture is matched to its result' } };

  const c = isPlainObject(b.capture) ? b.capture : null;
  if (!c) return { errors: { capture: 'capture must be an object' } };
  if (!Array.isArray(c.packets)) return { errors: { 'capture.packets': 'capture.packets must be an array' } };
  if (c.packets.length > MAX_PACKETS) return { errors: { 'capture.packets': `too many packets (max ${MAX_PACKETS})` } };

  const packets = [];
  for (const raw of c.packets) {
    if (!isPlainObject(raw)) continue;
    const rec = {};
    const t = Number(raw.t);
    rec.t = Number.isFinite(t) && t >= 0 ? Math.round(t * 1000) / 1000 : 0;
    for (const key of ['src', 'dst']) {
      const v = typeof raw[key] === 'string' ? raw[key].trim() : '';
      rec[key] = net.isIP(v) ? v : null;
    }
    for (const key of PACKET_INT_KEYS) {
      const n = Number(raw[key]);
      rec[key] = Number.isInteger(n) && n >= 0 ? n : null;
    }
    // Flag letters only — the set tcpdump prints. Anything else is not a flag
    // field, whatever it claims to be.
    rec.flags = typeof raw.flags === 'string' && /^[FSRPAUEC]{0,8}$/.test(raw.flags) ? raw.flags : null;
    if (isPlainObject(raw.icmp)) {
      const type = Number(raw.icmp.type);
      const code = Number(raw.icmp.code);
      rec.icmp = Number.isInteger(type) && Number.isInteger(code) ? { type, code } : null;
    } else rec.icmp = null;
    packets.push(rec);
  }

  const posInt = (v, max) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= max ? n : null; };
  return {
    value: {
      test_id: testId,
      time,
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 64) : null,
      iface: typeof c.iface === 'string' ? c.iface.slice(0, 32) : null,
      filter: typeof c.filter === 'string' ? c.filter.slice(0, 512) : null,
      snaplen: posInt(c.snaplen, 65535),
      duration_ms: posInt(c.duration_ms, 3600000),
      observed: posInt(c.observed, 1000000),
      foreign_count: posInt(c.foreign, 1000000),
      truncated: c.truncated === true,
      packets,
    },
  };
}

module.exports = {
  validateTransactionInput,
  validateAgentAssignment,
  validateResultIngest,
  validateCaptureIngest,
  TEST_TYPES,
  DNS_RECORD_TYPES,
  CAPTURE_MODES,
  PHASE_KEYS,
};
