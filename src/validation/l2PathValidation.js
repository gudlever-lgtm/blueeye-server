'use strict';

// Query validation for the L2 path and device-location reads
// (src/routes/l2Path.js). Pure; each returns { value } or { errors }.
//
// An ENDPOINT is whatever the technician knows about one end: an IP, a MAC, a
// hostname, or `agent:<id>`. It is classified here, once, so the service never
// guesses what a string was meant to be — "10.0.0.5" is an address, never a
// hostname that happens to look like one.

const { normalizeMac, isIpv4, isIpv6 } = require('../identity/arpTable');

const MAX_ENDPOINT_LENGTH = 253; // a DNS name's own ceiling
// A hostname or a short name: labels of letters, digits, '-' and '_' (NetBIOS
// and plenty of switch sysNames use it), dot-separated.
const HOSTNAME_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}))*\.?$/;
const INVENTORY_KINDS = Object.freeze(['agent', 'switch', 'discovered', 'host']);
const INVENTORY_MAX_LIMIT = 200;
const INVENTORY_DEFAULT_LIMIT = 50;
const INVENTORY_MAX_OFFSET = 100000;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// One endpoint string -> { kind, value, raw } or null.
function parseEndpoint(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_ENDPOINT_LENGTH) return null;
  const agent = /^agent:(\d{1,10})$/i.exec(s);
  if (agent) {
    const id = Number(agent[1]);
    return id >= 1 && id <= 2147483647 ? { kind: 'agent', value: id, raw: s } : null;
  }
  if (isIpv4(s) || isIpv6(s)) return { kind: 'ip', value: s.toLowerCase(), raw: s };
  const mac = normalizeMac(s);
  if (mac) return { kind: 'mac', value: mac, raw: s };
  if (HOSTNAME_RE.test(s)) return { kind: 'hostname', value: s.replace(/\.$/, '').toLowerCase(), raw: s };
  return null;
}

const ENDPOINT_HINT = 'an IP, a MAC, a hostname or agent:<id>';

function endpointField(query, name, errors, { required = true } = {}) {
  const raw = query[name];
  if (raw === undefined || raw === '') {
    if (required) errors[name] = `${name} is required (${ENDPOINT_HINT})`;
    return null;
  }
  const parsed = parseEndpoint(raw);
  if (!parsed) errors[name] = `${name} must be ${ENDPOINT_HINT}`;
  return parsed;
}

// GET /api/topology/l2-path?from=&to=[&gateway=]
function validateL2PathQuery(query) {
  if (!isObj(query)) return { errors: { query: 'query must be an object' } };
  const errors = {};
  const from = endpointField(query, 'from', errors);
  const to = endpointField(query, 'to', errors);
  const gateway = endpointField(query, 'gateway', errors, { required: false });
  if (Object.keys(errors).length) return { errors };
  return { value: { from, to, gateway } };
}

// GET /api/devices/locate?q=
function validateLocateQuery(query) {
  if (!isObj(query)) return { errors: { query: 'query must be an object' } };
  const errors = {};
  const q = endpointField(query, 'q', errors);
  if (Object.keys(errors).length) return { errors };
  return { value: { q } };
}

function wholeNumber(raw, { min, max }) {
  if (typeof raw !== 'string' || !/^[0-9]{1,7}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : null;
}

// GET /api/devices/inventory?limit=&offset=&kind=&q=  — every field optional:
// no filter at all is the whole inventory, first page.
function validateInventoryQuery(query) {
  if (!isObj(query)) return { errors: { query: 'query must be an object' } };
  const errors = {};
  const value = { limit: INVENTORY_DEFAULT_LIMIT, offset: 0, kind: null, q: null };
  if (query.limit !== undefined && query.limit !== '') {
    const n = wholeNumber(query.limit, { min: 1, max: INVENTORY_MAX_LIMIT });
    if (n == null) errors.limit = `limit must be a whole number between 1 and ${INVENTORY_MAX_LIMIT}`;
    else value.limit = n;
  }
  if (query.offset !== undefined && query.offset !== '') {
    const n = wholeNumber(query.offset, { min: 0, max: INVENTORY_MAX_OFFSET });
    if (n == null) errors.offset = `offset must be a whole number between 0 and ${INVENTORY_MAX_OFFSET}`;
    else value.offset = n;
  }
  if (query.kind !== undefined && query.kind !== '') {
    if (typeof query.kind !== 'string' || !INVENTORY_KINDS.includes(query.kind)) {
      errors.kind = `kind must be one of ${INVENTORY_KINDS.join(', ')}`;
    } else value.kind = query.kind;
  }
  if (query.q !== undefined && query.q !== '') {
    if (typeof query.q !== 'string' || query.q.trim().length > 64) errors.q = 'q must be text of at most 64 characters';
    else value.q = query.q.trim().toLowerCase() || null;
  }
  if (Object.keys(errors).length) return { errors };
  return { value };
}

module.exports = {
  parseEndpoint,
  validateL2PathQuery,
  validateLocateQuery,
  validateInventoryQuery,
  INVENTORY_KINDS,
  INVENTORY_MAX_LIMIT,
  INVENTORY_DEFAULT_LIMIT,
};
