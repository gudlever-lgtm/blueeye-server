'use strict';

// Pure helpers for the audit middleware: turn an HTTP request into a readable
// audit action + target, and redact a request body so no secret ever lands in
// the trail. No I/O — unit-tested directly.

// Body fields that must never be written to the audit log, matched
// case-insensitively against the top-level key name (substring match so
// `currentPassword`, `bindPassword`, `apiKey`, `tileApiKey`, … are all caught).
const SECRET_KEY_PATTERNS = [
  'password', 'passwd', 'token', 'secret', 'apikey', 'api_key', 'privatekey',
  'private_key', 'credential', 'signature', 'bind_pw', 'passphrase',
];

function isSecretKey(key) {
  const k = String(key).toLowerCase();
  if (k === 'key') return true; // a bare "key" is almost always a secret here
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

// Returns a shallow, redacted copy of a request body suitable for `detail`.
// Secret-looking fields become '[redacted]'; the whole thing is capped so a
// large payload can't bloat the row.
function redactBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (isSecretKey(key)) { out[key] = '[redacted]'; continue; }
    if (value && typeof value === 'object') {
      // Don't deep-dump nested structures — note their shape only.
      out[key] = Array.isArray(value) ? `[array(${value.length})]` : '[object]';
      continue;
    }
    let s = value;
    if (typeof s === 'string' && s.length > 200) s = `${s.slice(0, 200)}…`;
    out[key] = s;
  }
  const json = JSON.stringify(out);
  if (json && json.length > 2000) return { note: 'body too large to record' };
  return Object.keys(out).length ? out : null;
}

const VERB = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

// Maps the first (or first two, for /api/x) path segment(s) to a singular
// resource name used in the action key and the target type.
const RESOURCE = {
  users: 'user',
  locations: 'location',
  agents: 'agent',
  'enrollment-codes': 'enrollment-code',
  me: 'profile',
  auth: 'auth',
  // /api/<x>
  settings: 'settings',
  integrations: 'integration',
  thresholds: 'threshold',
  ldap: 'ldap',
  nis2: 'nis2',
  alerting: 'alerting',
  'test-packages': 'test-package',
  assistant: 'assistant',
};

// Sub-action segments on /agents/:id/<sub> that name what was done.
const AGENT_SUBACTIONS = new Set([
  'run-test', 'probe', 'run-speedtest', 'update', 'upgrade', 'delete', 'diagnose', 'ping', 'install-tool', 'reconnect',
  'cmdb-link',
]);

// Splits a request path into clean segments (no query string, no trailing slash).
function segmentsOf(rawPath) {
  const path = String(rawPath || '').split('?')[0].replace(/\/+$/, '');
  return path.split('/').filter(Boolean);
}

// Describes a state-changing request as { action, targetType, targetId,
// targetLabel }. Returns null when the request isn't worth auditing (e.g. an
// unknown shape with no resource). `action` is a dotted key like 'user.update'
// or 'agent.run-test'.
function describeRequest(method, rawPath) {
  const m = String(method || '').toUpperCase();
  const verb = VERB[m];
  const seg = segmentsOf(rawPath);
  if (!seg.length) return null;

  // Login is a POST to /auth (no resource verb).
  if (seg[0] === 'auth') {
    return { action: 'auth.login', targetType: 'session', targetId: null, targetLabel: null };
  }

  // Normalise /api/<resource>/... down to <resource>/... so both shapes share
  // one mapping.
  let parts = seg;
  if (parts[0] === 'api') parts = parts.slice(1);
  if (!parts.length) return null;

  const head = parts[0];
  const resource = RESOURCE[head] || head;

  // /agents/:id/<sub> — the sub segment names the action (run-test, upgrade…).
  if (head === 'agents' && parts.length >= 3 && AGENT_SUBACTIONS.has(parts[2])) {
    return { action: `agent.${parts[2]}`, targetType: 'agent', targetId: parts[1] || null, targetLabel: null };
  }

  // /api/settings/<area> and /api/nis2/<kind>/... — keep the sub-area as target.
  if ((head === 'settings' || head === 'nis2' || head === 'ldap') && parts.length >= 2) {
    const sub = parts[1];
    const id = parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : null;
    return { action: `${resource}.${verb || 'update'}`, targetType: sub, targetId: id, targetLabel: null };
  }

  // The trailing numeric segment, if any, is the target id.
  const id = parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
  const action = `${resource}.${verb || m.toLowerCase()}`;
  return { action, targetType: resource, targetId: id, targetLabel: null };
}

// Whether a method changes state (and is therefore a candidate for auditing).
function isMutating(method) {
  return Boolean(VERB[String(method || '').toUpperCase()]);
}

module.exports = { describeRequest, redactBody, isSecretKey, isMutating, segmentsOf };
