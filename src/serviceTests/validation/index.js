'use strict';

const { PERIODS } = require('../stats/period');

const { denyReason, REASON } = require('../security/hostPolicy');
const { validateDefinition } = require('../engine/validate');

// HTTP input validation for Service Tests. Pure functions returning { value } or
// { errors } — never both, never throwing, whatever garbage arrives. The routes
// turn `errors` into the repo's 400 contract:
//   { error: 'Validation failed', details }
//
// Reachability is NOT decided here: a base URL is checked for shape and for the
// permanent deny-list (an address no policy could ever permit), and the
// per-application allowlist is applied at run time by hostPolicy. Splitting it
// that way means an operator can register an application before its allowlist
// exists, and cannot register one pointed at 169.254.169.254 at all.

const NAME_MAX = 255;
const DESC_MAX = 4000;
const URL_MAX = 1024;
const LABEL_MAX = 255;
const ENV_TYPES = ['production', 'staging', 'development', 'test', 'custom'];
const ENTRY_TYPES = ['host', 'ip', 'cidr'];
// spec §22's fixed cadence choices, in seconds.
const INTERVALS = [60, 300, 900, 3600, 86400];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return String(value); } catch { return ''; }
}

const trimmed = (v, max) => str(v).trim().slice(0, max);

// Parses a positive integer id from a path/query param. Strict: '3abc', '', '-1'
// and '1.5' are all null, so a route never queries with a coerced value.
function parseId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = str(raw).trim();
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// An absolute http(s) base URL, refused if it names an address the module will
// never reach whatever the allowlist says.
function validateBaseUrl(raw, field = 'base_url', errors = {}) {
  const value = trimmed(raw, URL_MAX + 1);
  if (!value) { errors[field] = 'a web address is required'; return undefined; }
  if (value.length > URL_MAX) { errors[field] = `the address is too long (max ${URL_MAX})`; return undefined; }
  let url;
  try { url = new URL(value); } catch { errors[field] = 'that is not a valid web address (include https://)'; return undefined; }
  if (!['http:', 'https:'].includes(url.protocol)) {
    errors[field] = `only http and https are supported (got ${url.protocol.replace(':', '')})`;
    return undefined;
  }
  const denied = denyReason(url.hostname);
  if (denied === REASON.DENIED_ADDRESS) {
    errors[field] = 'loopback, link-local and metadata addresses can never be tested';
    return undefined;
  }
  return value;
}

// ------------------------------------------------------------------ application
function validateApplication(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};

  if (!partial || body.name !== undefined) {
    const name = trimmed(body.name, NAME_MAX + 1);
    if (!name) errors.name = 'a name is required';
    else if (name.length > NAME_MAX) errors.name = `the name is too long (max ${NAME_MAX})`;
    else value.name = name;
  }
  if (!partial || body.base_url !== undefined) {
    const url = validateBaseUrl(body.base_url, 'base_url', errors);
    if (url !== undefined) value.base_url = url;
  }
  if (body.description !== undefined) {
    value.description = body.description === null ? null : trimmed(body.description, DESC_MAX);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = body.enabled;
  }
  return Object.keys(errors).length ? { errors } : { value };
}

// ------------------------------------------------------------------ environment
function validateEnvironment(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};

  if (!partial) {
    const appId = parseId(body.application_id);
    if (appId === null) errors.application_id = 'an application is required';
    else value.application_id = appId;
  }
  if (!partial || body.name !== undefined) {
    const name = trimmed(body.name, NAME_MAX + 1);
    if (!name) errors.name = 'a name is required';
    else if (name.length > NAME_MAX) errors.name = `the name is too long (max ${NAME_MAX})`;
    else value.name = name;
  }
  if (!partial || body.base_url !== undefined) {
    const url = validateBaseUrl(body.base_url, 'base_url', errors);
    if (url !== undefined) value.base_url = url;
  }
  if (body.type !== undefined) {
    const type = str(body.type).toLowerCase();
    if (!ENV_TYPES.includes(type)) errors.type = `type must be one of ${ENV_TYPES.join(', ')}`;
    else value.type = type;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = body.enabled;
  }
  return Object.keys(errors).length ? { errors } : { value };
}

// ------------------------------------------------------------------ credential
// `secret` is write-only. Omitted on an update = leave the stored one alone;
// explicitly '' = clear it. Both are deliberate, and the repository honours the
// distinction.
function validateCredential(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};

  if (!partial) {
    const appId = parseId(body.application_id);
    if (appId === null) errors.application_id = 'an application is required';
    else value.application_id = appId;
  }
  if (!partial || body.label !== undefined) {
    const label = trimmed(body.label, LABEL_MAX + 1);
    if (!label) errors.label = 'a name for this login is required';
    else if (label.length > LABEL_MAX) errors.label = `the name is too long (max ${LABEL_MAX})`;
    else value.label = label;
  }
  if (body.username !== undefined) {
    value.username = body.username === null ? null : trimmed(body.username, NAME_MAX);
  }
  if (body.secret !== undefined) {
    if (body.secret === null) { value.secret = ''; }
    else {
      const secret = str(body.secret);
      if (secret.length > 4096) errors.secret = 'the password is too long (max 4096)';
      // A password shorter than the redactor's floor cannot be masked in logs
      // and screenshots, so it is refused rather than silently unmaskable.
      else if (secret !== '' && secret.length < 4) errors.secret = 'the password must be at least 4 characters, so it can be masked in logs and screenshots';
      else value.secret = secret;
    }
  }
  // Only complain that a password is MISSING when none was sent. A password that
  // was sent and rejected keeps the specific reason it was rejected for.
  if (!partial && body.secret === undefined) {
    errors.secret = 'a password is required';
  }
  return Object.keys(errors).length ? { errors } : { value };
}

// ------------------------------------------------------------------ allowlist
// Shape only. Whether the entry may be allowlisted at all is hostPolicy's
// judgement, which needs the DB-backed caps and the application's other entries.
function validateAllowedHost(body) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};
  const raw = trimmed(body.value, 256);
  if (!raw) errors.value = 'a hostname, IP address or range is required';
  else if (raw.length > 255) errors.value = 'the entry is too long (max 255)';
  else value.value = raw;

  if (body.entry_type !== undefined && body.entry_type !== null && body.entry_type !== '') {
    const t = str(body.entry_type).toLowerCase();
    if (!ENTRY_TYPES.includes(t)) errors.entry_type = `entry_type must be one of ${ENTRY_TYPES.join(', ')}`;
    else value.entry_type = t;
  }
  if (body.note !== undefined) value.note = body.note === null ? null : trimmed(body.note, 255);
  return Object.keys(errors).length ? { errors } : { value };
}

function validateAllowlistImport(body) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  if (typeof body.text !== 'string' || !body.text.trim()) {
    return { errors: { text: 'paste a list of hosts, addresses or ranges (one per line)' } };
  }
  return { value: { text: body.text, replace: body.replace === true } };
}

// ------------------------------------------------------------------ test
function validateTest(body, { partial = false, maxSteps } = {}) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};

  if (!partial) {
    const appId = parseId(body.application_id);
    if (appId === null) errors.application_id = 'an application is required';
    else value.application_id = appId;
  }
  if (!partial || body.name !== undefined) {
    const name = trimmed(body.name, NAME_MAX + 1);
    if (!name) errors.name = 'a name is required';
    else if (name.length > NAME_MAX) errors.name = `the name is too long (max ${NAME_MAX})`;
    else value.name = name;
  }
  if (body.description !== undefined) {
    value.description = body.description === null ? null : trimmed(body.description, DESC_MAX);
  }
  if (body.credential_id !== undefined && body.credential_id !== null && body.credential_id !== '') {
    const credId = parseId(body.credential_id);
    if (credId === null) errors.credential_id = 'that login does not look valid';
    else value.credential_id = credId;
  } else if (body.credential_id === null || body.credential_id === '') {
    value.credential_id = null;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = body.enabled;
  }
  if (!partial || body.definition !== undefined) {
    const { value: def, errors: defErrors } = validateDefinition(body.definition, { maxSteps });
    if (defErrors) Object.assign(errors, defErrors);
    else value.definition = def;
  }
  return Object.keys(errors).length ? { errors } : { value };
}

// ------------------------------------------------------------------ run request
function validateRunRequest(body) {
  if (body !== undefined && body !== null && !isPlainObject(body)) {
    return { errors: { _: 'the request body must be an object' } };
  }
  const b = body || {};
  const value = {};
  if (b.environment_id !== undefined && b.environment_id !== null && b.environment_id !== '') {
    const envId = parseId(b.environment_id);
    if (envId === null) return { errors: { environment_id: 'that environment does not look valid' } };
    value.environment_id = envId;
  }
  return { value };
}

// ------------------------------------------------------------------ discovery
function validateDiscoveryRequest(body) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};
  const appId = parseId(body.application_id);
  if (appId === null) errors.application_id = 'an application is required';
  else value.application_id = appId;

  if (body.environment_id !== undefined && body.environment_id !== null && body.environment_id !== '') {
    const envId = parseId(body.environment_id);
    if (envId === null) errors.environment_id = 'that environment does not look valid';
    else value.environment_id = envId;
  }
  // Per-run budget overrides, each bounded by the DB-backed settings at the
  // route. Only the fields an operator can sensibly tighten are accepted.
  if (body.budgets !== undefined && body.budgets !== null) {
    if (!isPlainObject(body.budgets)) errors.budgets = 'budgets must be an object';
    else {
      const budgets = {};
      for (const key of ['maxPages', 'maxDepth', 'maxRequests']) {
        if (body.budgets[key] === undefined || body.budgets[key] === null || body.budgets[key] === '') continue;
        const n = Number(body.budgets[key]);
        if (!Number.isInteger(n) || n < 1) errors[`budgets.${key}`] = `${key} must be a whole number of at least 1`;
        else budgets[key] = n;
      }
      value.budgets = budgets;
    }
  }
  return Object.keys(errors).length ? { errors } : { value };
}

// ------------------------------------------------------------------ schedule
function validateSchedule(body, { partial = false } = {}) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};

  if (!partial) {
    const testId = parseId(body.test_id);
    if (testId === null) errors.test_id = 'a test is required';
    else value.test_id = testId;
  }
  if (body.environment_id !== undefined) {
    if (body.environment_id === null || body.environment_id === '') value.environment_id = null;
    else {
      const envId = parseId(body.environment_id);
      if (envId === null) errors.environment_id = 'that environment does not look valid';
      else value.environment_id = envId;
    }
  }
  if (!partial || body.interval_sec !== undefined) {
    const n = Number(body.interval_sec);
    if (!INTERVALS.includes(n)) errors.interval_sec = `how often must be one of ${INTERVALS.join(', ')} seconds`;
    else value.interval_sec = n;
  }
  if (body.start_at !== undefined) {
    if (body.start_at === null || body.start_at === '') value.start_at = null;
    else {
      const d = new Date(body.start_at);
      if (Number.isNaN(d.getTime())) errors.start_at = 'that is not a valid start time';
      else value.start_at = d;
    }
  }
  if (body.timezone !== undefined && body.timezone !== null && body.timezone !== '') {
    const tz = trimmed(body.timezone, 64);
    // Intl is the authority — no bundled timezone list to drift out of date.
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); value.timezone = tz; }
    catch { errors.timezone = 'that is not a recognised time zone'; }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = body.enabled;
  }
  return Object.keys(errors).length ? { errors } : { value };
}

// ------------------------------------------------------------------ settings
function validateSettingsPatch(body) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  return { value: body };
}

// --------------------------------------------------------------------- stats
// The history chart's query string. Every field is optional and every bad value
// is a 400 rather than a silent default: a chart that quietly shows a different
// period than the one asked for is worse than an error, because it looks right.
function validateStatsQuery(query) {
  if (query !== undefined && query !== null && !isPlainObject(query)) {
    return { errors: { _: 'the query must be an object' } };
  }
  const q = query || {};
  const errors = {};
  const value = {};

  if (q.period !== undefined && q.period !== '') {
    if (!PERIODS.includes(String(q.period))) errors.period = `period must be one of: ${PERIODS.join(', ')}`;
    else value.period = String(q.period);
  }

  // Any date inside the wanted period. A day is enough to identify a week, a
  // month or a year, so there is one format rather than four.
  if (q.at !== undefined && q.at !== '') {
    const at = String(q.at);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) errors.at = 'a date must be written as YYYY-MM-DD';
    else if (Number.isNaN(Date.parse(`${at}T00:00:00Z`))) errors.at = 'that is not a real date';
    else value.at = at;
  }

  // The viewer's getTimezoneOffset(): minutes BEHIND UTC, so UTC+2 sends -120.
  // Bounded to a real offset — ±14h exists (Kiritimati), ±24h does not.
  if (q.tz_offset !== undefined && q.tz_offset !== '') {
    const offset = Number(q.tz_offset);
    if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
      errors.tz_offset = 'the time-zone offset must be whole minutes between -840 and 840';
    } else value.tz_offset = offset;
  }

  for (const [field, key] of [['test_id', 'test_id'], ['application_id', 'application_id']]) {
    if (q[field] === undefined || q[field] === '') continue;
    const id = parseId(q[field]);
    if (id === null) errors[field] = `that ${field.replace('_id', '')} does not look valid`;
    else value[key] = id;
  }

  return Object.keys(errors).length ? { errors } : { value };
}

module.exports = {
  parseId,
  validateStatsQuery,
  validateApplication,
  validateEnvironment,
  validateCredential,
  validateAllowedHost,
  validateAllowlistImport,
  validateTest,
  validateRunRequest,
  validateDiscoveryRequest,
  validateSchedule,
  validateSettingsPatch,
  validateBaseUrl,
  ENV_TYPES,
  ENTRY_TYPES,
  PERIODS,
  INTERVALS,
  NAME_MAX,
};
