'use strict';

const { baseUrlBlockedReason } = require('../integrations/ssrfGuard');

// Validation for the CMDB settings + asset-link APIs. Pure functions returning
// either { value } (normalised) or { errors } (a field -> message map). The
// connector-specific check (does this auth_type suit the chosen type) lives in
// the route, which holds the connector registry — here we validate the shared,
// type-agnostic shape, mirroring integrationValidation.js.

const CMDB_TYPES = ['servicenow', 'nautobot', 'custom'];
const AUTH_TYPES = ['none', 'basic', 'oauth2', 'token'];
const URL_MAX = 512;
const PATH_MAX = 256;
const FIELD_MAX = 128;
// The custom-connector STRING config keys (all optional except searchPath). Values
// are short strings (paths / query param / dot-paths / a token scheme word). A
// `preset` marker (which named template prefilled the form) round-trips too so the
// dropdown can re-select it on reload.
const CUSTOM_KEYS = ['searchPath', 'testPath', 'queryParam', 'resultsPath', 'idField', 'nameField', 'typeField', 'locationField', 'tokenScheme', 'preset'];
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,128}$/;
const HEADER_VALUE_MAX = 1024;
const HEADER_MAX_KEYS = 20;
const CRED_MAX_KEYS = 20;
const CRED_KEY_RE = /^[\w.-]{1,64}$/;
const CRED_VALUE_MAX = 2000;
const ASSET_ID_MAX = 255;
const ASSET_NAME_MAX = 255;
const ASSET_LOCATION_MAX = 255;
const SEARCH_MIN = 2;
const SEARCH_MAX = 256;
// Prototype-pollution vectors — rejected explicitly (they match CRED_KEY_RE).
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validType(raw, errors) {
  if (typeof raw !== 'string' || raw.trim() === '') { errors.type = 'type is required'; return undefined; }
  const t = raw.trim().toLowerCase();
  if (!CMDB_TYPES.includes(t)) { errors.type = `type must be one of: ${CMDB_TYPES.join(', ')}`; return undefined; }
  return t;
}

function validBaseUrl(raw, errors) {
  if (typeof raw !== 'string' || raw.trim() === '') { errors.base_url = 'base_url is required'; return undefined; }
  const u = raw.trim();
  if (u.length > URL_MAX || !/^https?:\/\//i.test(u)) { errors.base_url = 'base_url must be an http(s) URL'; return undefined; }
  const blocked = baseUrlBlockedReason(u);
  if (blocked) { errors.base_url = blocked; return undefined; }
  return u.replace(/\/+$/, '');
}

function validAuthType(raw, errors) {
  if (raw === undefined) return 'none';
  if (typeof raw !== 'string' || !AUTH_TYPES.includes(raw)) { errors.auth_type = `auth_type must be one of: ${AUTH_TYPES.join(', ')}`; return undefined; }
  return raw;
}

// Credentials are an object of string secrets (e.g. { username, password } or
// { token }). Validated for shape/size only — connectors interpret the keys.
function validCredentials(raw, errors) {
  if (raw === undefined) return undefined; // not supplied — keep existing on edit
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { errors.credentials = 'credentials must be an object'; return undefined; }
  const keys = Object.keys(raw);
  if (keys.length > CRED_MAX_KEYS) { errors.credentials = `credentials must have at most ${CRED_MAX_KEYS} keys`; return undefined; }
  const out = {};
  for (const k of keys) {
    if (FORBIDDEN_KEYS.has(k)) { errors.credentials = `credential key "${k}" is not allowed`; return undefined; }
    if (!CRED_KEY_RE.test(k)) { errors.credentials = `credential key "${k}" must be 1-64 chars of [A-Za-z0-9_.-]`; return undefined; }
    const v = raw[k];
    if (typeof v !== 'string') { errors.credentials = `credential "${k}" must be a string`; return undefined; }
    if (v.length > CRED_VALUE_MAX) { errors.credentials = `credential "${k}" is too long`; return undefined; }
    out[k] = v;
  }
  return out;
}

function validEnabled(raw) {
  if (raw === undefined) return undefined;
  return raw === true || raw === 'true';
}

// The custom-connector `config` block (only for type === 'custom'). Every key is a
// short string; searchPath is required and must be a path. Unknown keys are
// dropped. Returns the normalised config or sets an error.
function validCustomConfig(raw, errors) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  const sp = c.searchPath;
  if (typeof sp !== 'string' || sp.trim() === '') { errors.config = 'config.searchPath is required for a custom CMDB'; return undefined; }
  if (!sp.startsWith('/') || sp.length > PATH_MAX) { errors.config = 'config.searchPath must start with / and be at most 256 chars'; return undefined; }
  out.searchPath = sp.trim();
  for (const key of CUSTOM_KEYS) {
    if (key === 'searchPath') continue;
    const v = c[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') { errors.config = `config.${key} must be a string`; return undefined; }
    const max = (key === 'testPath') ? PATH_MAX : FIELD_MAX;
    if (v.length > max) { errors.config = `config.${key} is too long`; return undefined; }
    if (key === 'testPath' && !v.startsWith('/')) { errors.config = 'config.testPath must start with /'; return undefined; }
    out[key] = v.trim();
  }
  // Optional static extra headers (e.g. GLPI's App-Token). An object of string
  // values; header names are HTTP tokens, values are bounded.
  if (c.headers !== undefined && c.headers !== null) {
    if (typeof c.headers !== 'object' || Array.isArray(c.headers)) { errors.config = 'config.headers must be an object of string values'; return undefined; }
    const hkeys = Object.keys(c.headers);
    if (hkeys.length > HEADER_MAX_KEYS) { errors.config = `config.headers must have at most ${HEADER_MAX_KEYS} entries`; return undefined; }
    const headers = {};
    for (const name of hkeys) {
      if (FORBIDDEN_KEYS.has(name) || !HEADER_NAME_RE.test(name)) { errors.config = `config.headers name "${name}" must be a 1-128 char token ([A-Za-z0-9-])`; return undefined; }
      const hv = c.headers[name];
      if (typeof hv !== 'string' || hv.length > HEADER_VALUE_MAX) { errors.config = `config.headers "${name}" must be a string up to ${HEADER_VALUE_MAX} chars`; return undefined; }
      headers[name] = hv;
    }
    if (Object.keys(headers).length) out.headers = headers;
  }
  return out;
}

// PUT /api/settings/cmdb — type + baseUrl required; credentials optional on an
// edit (omit to keep the stored secret). clearCredentials wipes them. A custom
// type also requires a `config` block (searchPath + optional mappings).
function validateCmdbConfig(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  value.type = validType(input.type, errors);
  value.baseUrl = validBaseUrl(input.base_url, errors);
  value.authType = validAuthType(input.auth_type, errors);

  // config only applies to the custom connector; the built-ins ignore it.
  if (value.type === 'custom') {
    const cfg = validCustomConfig(input.config, errors);
    if (cfg !== undefined) value.config = cfg;
  } else {
    value.config = {};
  }

  if (input.clearCredentials === true || input.clearCredentials === 'true') {
    value.clearCredentials = true;
  } else {
    const creds = validCredentials(input.credentials, errors);
    if (creds !== undefined) value.credentials = creds;
  }

  const enabled = validEnabled(input.enabled);
  value.enabled = enabled === undefined ? false : enabled;

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

// GET /api/cmdb/assets/search?q= — q must be present and at least SEARCH_MIN chars
// (after trimming). Returns { q } normalised, or { error } (a message string).
function validateAssetSearch(rawQuery) {
  if (typeof rawQuery !== 'string') return { error: 'q is required' };
  const q = rawQuery.trim();
  if (q.length < SEARCH_MIN) return { error: `q must be at least ${SEARCH_MIN} characters` };
  if (q.length > SEARCH_MAX) return { error: `q must be at most ${SEARCH_MAX} characters` };
  return { q };
}

// PUT /api/agents/:id/cmdb-link — asset id + name are required strings;
// cmdb_asset_location is OPTIONAL (an asset may have no location) and captured
// as an informational label (never touches agents.location_id).
function validateAgentLink(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  const id = input.cmdb_asset_id;
  if (typeof id !== 'string' || id.trim() === '') { errors.cmdb_asset_id = 'cmdb_asset_id is required'; }
  else if (id.length > ASSET_ID_MAX) { errors.cmdb_asset_id = `cmdb_asset_id must be at most ${ASSET_ID_MAX} characters`; }
  else value.cmdbAssetId = id.trim();

  const name = input.cmdb_asset_name;
  if (typeof name !== 'string' || name.trim() === '') { errors.cmdb_asset_name = 'cmdb_asset_name is required'; }
  else if (name.length > ASSET_NAME_MAX) { errors.cmdb_asset_name = `cmdb_asset_name must be at most ${ASSET_NAME_MAX} characters`; }
  else value.cmdbAssetName = name.trim();

  // Optional: absent/null → no location stored. A non-string is a bad request; an
  // empty string normalises to null.
  const loc = input.cmdb_asset_location;
  if (loc !== undefined && loc !== null) {
    if (typeof loc !== 'string') { errors.cmdb_asset_location = 'cmdb_asset_location must be a string'; }
    else if (loc.length > ASSET_LOCATION_MAX) { errors.cmdb_asset_location = `cmdb_asset_location must be at most ${ASSET_LOCATION_MAX} characters`; }
    else value.cmdbAssetLocation = loc.trim() === '' ? null : loc.trim();
  } else {
    value.cmdbAssetLocation = null;
  }

  // Optional: confirm overwriting an existing (manual) site with the CMDB location.
  value.overwriteLocation = input.overwrite_location === true || input.overwrite_location === 'true';

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateCmdbConfig, validateAssetSearch, validateAgentLink, CMDB_TYPES, AUTH_TYPES };
