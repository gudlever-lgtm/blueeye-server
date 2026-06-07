'use strict';

// Validation for the integrations CRUD API. Pure functions returning either
// { value } (normalised, ready for the route to encrypt + persist) or { errors }
// (a field -> message map) — never both. Connector-specific checks (is the type
// known, is the auth type supported, is config valid) live in the route, which
// has the connector registry; here we validate the shared, type-agnostic shape.

const TYPE_MAX = 32;
const NAME_MAX = 255;
const URL_MAX = 512;
const AUTH_TYPES = ['none', 'basic', 'oauth2', 'token'];
const CONFIG_MAX_CHARS = 8000;
const CRED_MAX_KEYS = 20;
const CRED_KEY_RE = /^[\w.-]{1,64}$/;
const CRED_VALUE_MAX = 2000;

function validType(raw, errors) {
  if (typeof raw !== 'string' || raw.trim() === '') { errors.type = 'type is required'; return undefined; }
  const t = raw.trim().toLowerCase();
  if (t.length > TYPE_MAX || !/^[a-z0-9_-]+$/.test(t)) { errors.type = 'type must be 1-32 chars of [a-z0-9_-]'; return undefined; }
  return t;
}

function validName(raw, errors) {
  if (typeof raw !== 'string' || raw.trim() === '') { errors.name = 'name is required'; return undefined; }
  const n = raw.trim();
  if (n.length > NAME_MAX) { errors.name = `name must be at most ${NAME_MAX} characters`; return undefined; }
  return n;
}

function validBaseUrl(raw, errors) {
  if (typeof raw !== 'string' || raw.trim() === '') { errors.baseUrl = 'baseUrl is required'; return undefined; }
  const u = raw.trim();
  if (u.length > URL_MAX || !/^https?:\/\//i.test(u)) { errors.baseUrl = 'baseUrl must be an http(s) URL'; return undefined; }
  return u.replace(/\/+$/, '');
}

function validAuthType(raw, errors) {
  if (raw === undefined) return 'none';
  if (typeof raw !== 'string' || !AUTH_TYPES.includes(raw)) { errors.authType = `authType must be one of: ${AUTH_TYPES.join(', ')}`; return undefined; }
  return raw;
}

// Credentials are an object of string secrets (e.g. { username, password } or
// { token }). Validated for shape/size only — connectors interpret the keys.
function validCredentials(raw, errors) {
  if (raw === undefined) return undefined; // not supplied
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { errors.credentials = 'credentials must be an object'; return undefined; }
  const keys = Object.keys(raw);
  if (keys.length > CRED_MAX_KEYS) { errors.credentials = `credentials must have at most ${CRED_MAX_KEYS} keys`; return undefined; }
  const out = {};
  for (const k of keys) {
    if (!CRED_KEY_RE.test(k)) { errors.credentials = `credential key "${k}" must be 1-64 chars of [A-Za-z0-9_.-]`; return undefined; }
    const v = raw[k];
    if (typeof v !== 'string') { errors.credentials = `credential "${k}" must be a string`; return undefined; }
    if (v.length > CRED_VALUE_MAX) { errors.credentials = `credential "${k}" is too long`; return undefined; }
    out[k] = v;
  }
  return out;
}

function validConfig(raw, errors) {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { errors.config = 'config must be an object'; return undefined; }
  let str;
  try { str = JSON.stringify(raw); } catch { errors.config = 'config must be JSON-serialisable'; return undefined; }
  if (str.length > CONFIG_MAX_CHARS) { errors.config = `config is too large (max ${CONFIG_MAX_CHARS} chars)`; return undefined; }
  return raw;
}

function validEnabled(raw) {
  if (raw === undefined) return undefined;
  return raw === true || raw === 'true';
}

// POST /api/integrations — type, name and baseUrl are required.
function validateIntegrationCreate(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  value.type = validType(input.type, errors);
  value.name = validName(input.name, errors);
  value.baseUrl = validBaseUrl(input.baseUrl, errors);
  value.authType = validAuthType(input.authType, errors);

  const creds = validCredentials(input.credentials, errors);
  if (creds !== undefined) value.credentials = creds;
  const config = validConfig(input.config, errors);
  value.config = config !== undefined ? config : {};
  const enabled = validEnabled(input.enabled);
  value.enabled = enabled === undefined ? true : enabled;

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

// PUT /api/integrations/:id — all fields optional; type is immutable. Credentials
// are write-only: supply a new object to replace them, set clearCredentials:true
// to wipe them, or omit both to keep the stored secret untouched.
function validateIntegrationUpdate(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (input.name !== undefined) value.name = validName(input.name, errors);
  if (input.baseUrl !== undefined) value.baseUrl = validBaseUrl(input.baseUrl, errors);
  if (input.authType !== undefined) value.authType = validAuthType(input.authType, errors);
  if (input.enabled !== undefined) value.enabled = validEnabled(input.enabled);
  const config = validConfig(input.config, errors);
  if (config !== undefined) value.config = config;

  if (input.clearCredentials === true || input.clearCredentials === 'true') {
    value.clearCredentials = true;
  } else {
    const creds = validCredentials(input.credentials, errors);
    if (creds !== undefined) value.credentials = creds;
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateIntegrationCreate, validateIntegrationUpdate, AUTH_TYPES };
