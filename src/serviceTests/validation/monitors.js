'use strict';

const { denyReason, REASON } = require('../security/hostPolicy');
const { isType, typeMeta, TYPE_NAMES, defaultsFor, secretFields } = require('../monitors/types');
const { isReadOnly } = require('../monitors/checks/db');

// HTTP input validation for monitors. Pure: { value } or { errors }, never both,
// never throwing, whatever arrives.
//
// Three things here are security controls rather than input hygiene, and each is
// deliberate:
//
//   1. Every host field clears the PERMANENT deny-list. A monitor is an outbound
//      connection the server makes on a schedule with credentials attached, so
//      loopback, link-local and the cloud metadata address are refused here the
//      same way they are for a browser test. Private LAN addresses ARE allowed:
//      the directory, the mail relay and the database this product monitors live
//      on them, and that is the point of on-prem software.
//   2. A mail monitor's recipient must be in the operator's domain allowlist
//      when one is configured. Without that rule, "send a mail and measure it"
//      is a scheduled mail sender pointed at any address on the internet.
//   3. A database monitor may only run a single SELECT. A scheduled statement
//      that can write is a scheduled accident.

const NAME_MAX = 255;
const DESC_MAX = 2000;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 86400;
const MAX_MS = 3600000;

// Deliberately loose. Address syntax has more corner cases than any regexp, and
// the authoritative answer is what the mail server says — the shape check is
// here to catch a typo, not to be RFC 5322.
const EMAIL_RE = /^[^\s@,;<>]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._:-]{0,253}[A-Za-z0-9])?$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)));
const trimmed = (v, max) => str(v).trim().slice(0, max);

const domainOf = (email) => str(email).split('@').pop().toLowerCase();

// One config field against its catalogue spec. Writes into `errors` and returns
// the accepted value, or undefined when there is nothing to store.
function validateField(name, spec, raw, errors, prefix = 'config') {
  const key = `${prefix}.${name}`;
  const absent = raw === undefined || raw === null || raw === '';
  if (absent) {
    if (spec.required) errors[key] = 'this is required';
    return undefined;
  }
  switch (spec.type) {
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n)) { errors[key] = 'must be a whole number'; return undefined; }
      if (spec.min !== undefined && n < spec.min) { errors[key] = `must be at least ${spec.min}`; return undefined; }
      if (spec.max !== undefined && n > spec.max) { errors[key] = `must be at most ${spec.max}`; return undefined; }
      return n;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') { errors[key] = 'must be true or false'; return undefined; }
      return raw;
    }
    case 'enum': {
      const v = str(raw);
      if (!spec.values.includes(v)) { errors[key] = `must be one of ${spec.values.join(', ')}`; return undefined; }
      return v;
    }
    case 'list': {
      if (!Array.isArray(raw)) { errors[key] = 'must be a list'; return undefined; }
      if (spec.max && raw.length > spec.max) { errors[key] = `at most ${spec.max} entries`; return undefined; }
      const items = raw.map((v) => trimmed(v, 255)).filter(Boolean);
      if (!items.length) { errors[key] = 'must not be empty'; return undefined; }
      const bad = items.find((v) => !HOST_RE.test(v));
      if (bad) { errors[key] = `"${bad}" is not a valid name`; return undefined; }
      return items;
    }
    case 'email': {
      const v = trimmed(raw, spec.max || 255);
      if (!EMAIL_RE.test(v)) { errors[key] = 'that is not a valid email address'; return undefined; }
      return v;
    }
    case 'host':
    case 'domain': {
      const v = trimmed(raw, spec.max || 255);
      if (!HOST_RE.test(v)) { errors[key] = 'that is not a valid host or domain name'; return undefined; }
      if (denyReason(v) === REASON.DENIED_ADDRESS) {
        errors[key] = 'loopback, link-local and metadata addresses can never be monitored';
        return undefined;
      }
      return v;
    }
    case 'secret':
    case 'text':
    default: {
      const v = trimmed(raw, (spec.max || 1024) + 1);
      if (spec.max && v.length > spec.max) { errors[key] = `too long (max ${spec.max})`; return undefined; }
      return v;
    }
  }
}

// Type-specific rules that no field spec can express.
function validateTypeRules(type, config, errors, { recipientDomains = [] } = {}) {
  if (type === 'mail') {
    const to = config.to_address;
    if (to && recipientDomains.length) {
      const domain = domainOf(to);
      const allowed = recipientDomains.some((d) => domain === String(d).toLowerCase());
      if (!allowed) {
        errors['config.to_address'] = `only these domains may be probed: ${recipientDomains.join(', ')}`;
      }
    }
    if (config.roundtrip && !config.imap_host) errors['config.imap_host'] = 'round-trip needs a mailbox to look in';
    if (config.roundtrip && !config.imap_username) errors['config.imap_username'] = 'round-trip needs a mailbox user';
    if (config.smtp_security === 'none') {
      // Allowed, because an internal relay on a trusted segment is a real
      // deployment — but never silently: a plaintext password would otherwise
      // cross the network because a default was left alone.
      if (config.smtp_username && config.smtp_password) {
        errors['config.smtp_security'] = 'credentials cannot be sent over an unencrypted connection — use starttls or tls';
      }
    }
  }
  if (type === 'ldap_bind') {
    const url = str(config.url).trim();
    let parsed = null;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !['ldap:', 'ldaps:'].includes(parsed.protocol)) {
      errors['config.url'] = 'the address must start with ldap:// or ldaps://';
    } else if (denyReason(parsed.hostname) === REASON.DENIED_ADDRESS) {
      errors['config.url'] = 'loopback, link-local and metadata addresses can never be monitored';
    }
  }
  if (type === 'rbl') {
    // A blacklist is indexed by ADDRESS. Accepting a hostname would mean
    // checking whatever it happened to point at that day — and silently
    // checking the wrong thing is worse than refusing the input.
    const ip = str(config.ip).trim();
    const octets = ip.split('.');
    const ipv4 = octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
    if (ip && !ipv4) errors['config.ip'] = 'a blacklist check needs an IPv4 address, not a hostname';
  }
  if (type === 'db_connect' && config.query !== undefined && !isReadOnly(config.query)) {
    errors['config.query'] = 'only a single SELECT is allowed';
  }
  if (type === 'dns_record') {
    if (config.preset === 'dkim' && !config.selector) errors['config.selector'] = 'a DKIM check needs a selector';
    if (config.preset === 'custom' && !config.record) errors['config.record'] = 'a custom check needs a record type';
    if (config.preset === 'custom' && !config.name) errors['config.name'] = 'a custom check needs a name to look up';
  }
}

// The whole request body.
//
// `partial` is a PATCH: only the fields present are validated, EXCEPT config,
// which is always validated whole — a config merged field-by-field could pass
// every individual rule and still be an incoherent monitor (round-trip on with
// the mailbox removed).
function validateMonitor(body, { partial = false, recipientDomains = [], existing = null, minIntervalSec = MIN_INTERVAL_SEC } = {}) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};

  const type = partial ? (body.type !== undefined ? str(body.type) : (existing && existing.type)) : str(body.type);
  if (!partial || body.type !== undefined) {
    if (!isType(type)) {
      errors.type = `must be one of ${TYPE_NAMES.join(', ')}`;
      return { errors };
    }
    if (partial && existing && type !== existing.type) {
      errors.type = 'the check type cannot be changed — create a new monitor instead';
      return { errors };
    }
    if (!partial) value.type = type;
  }
  if (!isType(type)) return { errors: { type: `must be one of ${TYPE_NAMES.join(', ')}` } };
  const meta = typeMeta(type);

  if (!partial || body.name !== undefined) {
    const name = trimmed(body.name, NAME_MAX + 1);
    if (!name) errors.name = 'a name is required';
    else if (name.length > NAME_MAX) errors.name = `the name is too long (max ${NAME_MAX})`;
    else value.name = name;
  }
  if (body.description !== undefined) {
    value.description = body.description === null ? null : trimmed(body.description, DESC_MAX);
  }
  if (body.application_id !== undefined) {
    if (body.application_id === null) value.application_id = null;
    else {
      const id = Number(body.application_id);
      if (!Number.isInteger(id) || id <= 0) errors.application_id = 'not a valid application';
      else value.application_id = id;
    }
  }
  if (body.environment_id !== undefined) {
    if (body.environment_id === null) value.environment_id = null;
    else {
      const id = Number(body.environment_id);
      if (!Number.isInteger(id) || id <= 0) errors.environment_id = 'not a valid environment';
      else value.environment_id = id;
    }
  }
  if (!partial || body.interval_sec !== undefined) {
    const n = Number(body.interval_sec === undefined ? meta.defaultIntervalSec : body.interval_sec);
    const floor = Math.max(MIN_INTERVAL_SEC, Number(minIntervalSec) || MIN_INTERVAL_SEC);
    if (!Number.isInteger(n)) errors.interval_sec = 'must be a whole number of seconds';
    else if (n < floor) errors.interval_sec = `must be at least ${floor} seconds`;
    else if (n > MAX_INTERVAL_SEC) errors.interval_sec = `must be at most ${MAX_INTERVAL_SEC} seconds`;
    else value.interval_sec = n;
  }
  for (const field of ['warn_ms', 'crit_ms']) {
    if (body[field] === undefined) continue;
    if (body[field] === null) { value[field] = null; continue; }
    const n = Number(body[field]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MS) errors[field] = `must be between 1 and ${MAX_MS} ms`;
    else value[field] = n;
  }
  if (value.warn_ms && value.crit_ms && value.crit_ms < value.warn_ms) {
    errors.crit_ms = 'the critical limit cannot be lower than the warning limit';
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = body.enabled;
  }

  // ------------------------------------------------------------------ config
  const rawConfig = body.config === undefined ? (partial ? null : {}) : body.config;
  if (rawConfig !== null) {
    if (!isPlainObject(rawConfig)) {
      errors.config = 'the configuration must be an object';
      return { errors };
    }
    const merged = { ...defaultsFor(type), ...(partial && existing ? existing.config : {}), ...rawConfig };
    const config = {};
    const secrets = {};
    const secretNames = new Set(secretFields(type));

    for (const [name, spec] of Object.entries(meta.fields)) {
      const accepted = validateField(name, spec, merged[name], errors);
      if (accepted === undefined) continue;
      if (secretNames.has(name)) secrets[name] = accepted;
      else config[name] = accepted;
    }
    // A secret explicitly sent as '' is a CLEAR, and must survive the "absent"
    // branch above that skips empty values.
    for (const name of secretNames) {
      if (isPlainObject(rawConfig) && rawConfig[name] === '') secrets[name] = '';
    }
    validateTypeRules(type, { ...config, ...secrets }, errors, { recipientDomains });

    const target = config[meta.target];
    if (!target) {
      if (!errors[`config.${meta.target}`]) errors[`config.${meta.target}`] = 'this is required';
    } else {
      value.target = String(target).slice(0, 255);
    }
    value.config = config;
    if (Object.keys(secrets).length) value.secrets = secrets;
  }

  return Object.keys(errors).length ? { errors } : { value };
}

// `validateField` is deliberately NOT exported: it takes a field spec as its
// second argument and has no meaning on its own, and the gate's validator sweep
// calls every exported function with garbage — an export whose contract is
// "always called with a spec" would be a false failure there and a misleading
// API here.
module.exports = { validateMonitor, EMAIL_RE, HOST_RE, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC };
