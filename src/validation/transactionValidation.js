'use strict';

// Validation for the transaction-test domain. Pure functions returning either
// `{ value }` (normalised, ready for the repository) or `{ errors }` (a
// field -> message map) — never both. Mirrors the shape and guards used in
// probeValidation.js so http/tcp/dns configs are validated consistently.

const TEST_TYPES = ['http', 'tcp', 'dns'];
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// DNS record types we let an agent resolve (metadata only, never payload).
const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'PTR', 'SRV'];
// Host/IP/hostname must start alphanumeric (so it can never be read as a CLI
// flag) and contain only host-safe characters. Same guard as probeValidation.
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/;
const NAME_MAX = 255;
const MAX_STEPS = 10;
const RESULT_STATUSES = ['ok', 'fail', 'error'];

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// http config: { steps: [ { url, method?, expectStatus?, expectBody?, header?,
// data?, extract? } ] }. Each step is an http(s) request run in order.
function validateHttpConfig(config, errors) {
  if (!isPlainObject(config) || !Array.isArray(config.steps) || config.steps.length === 0) {
    errors.config = 'http test needs config.steps (a non-empty array)';
    return null;
  }
  if (config.steps.length > MAX_STEPS) {
    errors.config = `too many steps (max ${MAX_STEPS})`;
    return null;
  }
  const steps = [];
  for (let i = 0; i < config.steps.length; i += 1) {
    const s = isPlainObject(config.steps[i]) ? config.steps[i] : {};
    const url = String(s.url || '').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 512) {
      errors[`config.steps[${i}].url`] = 'each step needs an http(s) URL (<=512 chars; may contain {{vars}})';
      return null;
    }
    const step = { url };
    if (s.name !== undefined && s.name !== '') step.name = String(s.name).slice(0, 120);
    if (s.method !== undefined && s.method !== '') {
      const m = String(s.method).toUpperCase();
      if (!HTTP_METHODS.includes(m)) {
        errors[`config.steps[${i}].method`] = `method must be one of ${HTTP_METHODS.join(', ')}`;
        return null;
      }
      if (m !== 'GET') step.method = m;
    }
    if (s.expectStatus !== undefined && s.expectStatus !== null && s.expectStatus !== '') {
      const st = Number(s.expectStatus);
      if (!Number.isInteger(st) || st < 100 || st > 599) {
        errors[`config.steps[${i}].expectStatus`] = 'expectStatus must be 100-599';
        return null;
      }
      step.expectStatus = st;
    }
    if (s.expectBody) {
      const eb = String(s.expectBody);
      if (eb.length > 512) { errors[`config.steps[${i}].expectBody`] = 'expectBody must be <=512 chars'; return null; }
      step.expectBody = eb;
    }
    if (s.header) {
      const h = String(s.header);
      if (h.length > 256) { errors[`config.steps[${i}].header`] = 'header must be <=256 chars'; return null; }
      step.header = h;
    }
    if (s.data) {
      const d = String(s.data);
      if (d.length > 2048) { errors[`config.steps[${i}].data`] = 'data must be <=2048 chars'; return null; }
      step.data = d;
    }
    if (s.extract && typeof s.extract === 'object' && (s.extract.name || s.extract.pattern)) {
      const name = String(s.extract.name || '').trim();
      const pattern = String(s.extract.pattern || '');
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) { errors[`config.steps[${i}].extract.name`] = 'extract name must be 1-64 chars [A-Za-z0-9_]'; return null; }
      if (!pattern || pattern.length > 256) { errors[`config.steps[${i}].extract.pattern`] = 'extract pattern is required (<=256 chars)'; return null; }
      try { new RegExp(pattern); } catch { errors[`config.steps[${i}].extract.pattern`] = 'extract pattern is not a valid regex'; return null; }
      step.extract = { name, pattern, from: s.extract.from === 'header' ? 'header' : 'body' };
    }
    steps.push(step);
  }
  return { steps };
}

// tcp config: { host, port }.
function validateTcpConfig(config, errors) {
  if (!isPlainObject(config)) { errors.config = 'tcp test needs config { host, port }'; return null; }
  const host = String(config.host || '').trim();
  if (!HOST_RE.test(host)) { errors['config.host'] = 'host is required and must be a valid hostname or IP'; return null; }
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { errors['config.port'] = 'port (1-65535) is required for a tcp test'; return null; }
  return { host, port };
}

// dns config: { host, record }.
function validateDnsConfig(config, errors) {
  if (!isPlainObject(config)) { errors.config = 'dns test needs config { host, record }'; return null; }
  const host = String(config.host || '').trim();
  if (!HOST_RE.test(host)) { errors['config.host'] = 'host is required and must be a valid hostname'; return null; }
  const record = String(config.record || 'A').toUpperCase();
  if (!DNS_RECORD_TYPES.includes(record)) { errors['config.record'] = `record must be one of ${DNS_RECORD_TYPES.join(', ')}`; return null; }
  return { host, record };
}

// Optional alert thresholds: { consecutive_fails?, latency_ms? }.
function validateThresholds(raw, errors) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) { errors.thresholds = 'thresholds must be an object'; return null; }
  const out = {};
  if (raw.consecutive_fails !== undefined && raw.consecutive_fails !== null && raw.consecutive_fails !== '') {
    const n = Number(raw.consecutive_fails);
    if (!Number.isInteger(n) || n < 1 || n > 100) { errors['thresholds.consecutive_fails'] = 'consecutive_fails must be an integer 1-100'; return null; }
    out.consecutive_fails = n;
  }
  if (raw.latency_ms !== undefined && raw.latency_ms !== null && raw.latency_ms !== '') {
    const n = Number(raw.latency_ms);
    if (!Number.isInteger(n) || n < 1 || n > 3600000) { errors['thresholds.latency_ms'] = 'latency_ms must be an integer 1-3600000'; return null; }
    out.latency_ms = n;
  }
  return Object.keys(out).length ? out : null;
}

// Validates a create/update body for a transaction test.
function validateTransactionInput(body) {
  const b = isPlainObject(body) ? body : {};
  const errors = {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) errors.name = 'name is required';
  else if (name.length > NAME_MAX) errors.name = `name must be at most ${NAME_MAX} characters`;

  const type = String(b.type || '').toLowerCase();
  if (!TEST_TYPES.includes(type)) errors.type = `type must be one of ${TEST_TYPES.join(', ')}`;

  // Bail before per-type config validation if the type itself is unknown (we
  // wouldn't know which validator to run).
  if (errors.type) return { errors };

  let config = null;
  if (type === 'http') config = validateHttpConfig(b.config, errors);
  else if (type === 'tcp') config = validateTcpConfig(b.config, errors);
  else if (type === 'dns') config = validateDnsConfig(b.config, errors);

  const thresholds = validateThresholds(b.thresholds, errors);

  let intervalMs = 60000;
  if (b.interval_ms !== undefined && b.interval_ms !== null && b.interval_ms !== '') {
    const n = Number(b.interval_ms);
    if (!Number.isInteger(n) || n < 1000 || n > 86400000) errors.interval_ms = 'interval_ms must be an integer 1000-86400000';
    else intervalMs = n;
  }

  if (Object.keys(errors).length) return { errors };

  return {
    value: {
      name,
      type,
      config,
      thresholds,
      interval_ms: intervalMs,
      enabled: b.enabled !== false,
    },
  };
}

// Validates a PUT /:id/agents body: { agent_ids: [int, ...] }. Empty array is
// allowed (clears all assignments).
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

// Validates the agent -> server transaction_result WS payload:
//   { results: [ { test_id, status, latency_ms?, ran_at?, detail? } ] }
// Returns { value: { results } } or { errors }. Assignment (does this agent own
// the test) is enforced by the caller against the DB, not here.
function validateResultIngest(payload) {
  const b = isPlainObject(payload) ? payload : {};
  if (!Array.isArray(b.results)) return { errors: { results: 'results must be an array' } };
  if (b.results.length === 0) return { errors: { results: 'results must not be empty' } };
  if (b.results.length > 200) return { errors: { results: 'too many results (max 200)' } };
  const out = [];
  for (let i = 0; i < b.results.length; i += 1) {
    const r = b.results[i];
    if (!isPlainObject(r)) return { errors: { [`results[${i}]`]: 'must be an object' } };
    const testId = Number(r.test_id);
    if (!Number.isInteger(testId) || testId < 1) return { errors: { [`results[${i}].test_id`]: 'test_id must be a positive integer' } };
    const status = String(r.status || '').toLowerCase();
    if (!RESULT_STATUSES.includes(status)) return { errors: { [`results[${i}].status`]: `status must be one of ${RESULT_STATUSES.join(', ')}` } };
    let latencyMs = null;
    if (r.latency_ms !== undefined && r.latency_ms !== null && r.latency_ms !== '') {
      const n = Number(r.latency_ms);
      if (!Number.isFinite(n) || n < 0) return { errors: { [`results[${i}].latency_ms`]: 'latency_ms must be a non-negative number' } };
      latencyMs = Math.round(n);
    }
    let ranAt = null;
    if (r.ran_at) {
      const d = new Date(r.ran_at);
      if (Number.isNaN(d.getTime())) return { errors: { [`results[${i}].ran_at`]: 'ran_at must be a valid date' } };
      ranAt = d;
    }
    let detail = null;
    if (r.detail !== undefined && r.detail !== null) {
      // Metadata only; bound the size so a rogue agent can't bloat a row.
      const json = JSON.stringify(r.detail);
      if (json && json.length > 8192) return { errors: { [`results[${i}].detail`]: 'detail is too large (max 8KB)' } };
      detail = r.detail;
    }
    out.push({ test_id: testId, status, latency_ms: latencyMs, ran_at: ranAt, detail });
  }
  return { value: { results: out } };
}

module.exports = {
  validateTransactionInput,
  validateAgentAssignment,
  validateResultIngest,
  TEST_TYPES,
  DNS_RECORD_TYPES,
};
