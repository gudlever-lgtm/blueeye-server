'use strict';

const { authHeader, requestJson, DEFAULT_TIMEOUT_MS } = require('../httpClient');

const silentLogger = { info() {}, warn() {}, error() {} };

// A generic, CONFIG-DRIVEN outbound ITSM connector — "bring your own ticketing
// system". Unlike the ServiceNow connector (which hard-codes the ServiceNow Table
// API), everything here is supplied by the admin in the integration's `config`
// block, so any HTTP/JSON ticket API can be wired up without new code:
//
//   path          path appended to base_url for the create call   (default '/')
//   method        POST or PUT                                       (default POST)
//   fields        map of API field (dot-path) -> BlueEye event key  (see EVENT_KEYS)
//   staticFields  object merged into every request body (nesting allowed)
//   headers       static extra request headers (name -> value)
//   tokenScheme   Authorization scheme word for token auth          (default Bearer)
//   testPath      path for the connection test (GET)                (default = path)
//
// The request body is built by deep-cloning `staticFields`, then setting each
// `fields` entry from the event (a dotted target key builds a nested object, so
// Jira's `fields.summary` or GLPI's `input.name` are expressible). Only metadata
// derived from the finding is ever sent — never raw traffic or payload.
//
// Auth reuses the shared authHeader (none/basic/token/oauth2). Idempotency is NOT
// attempted (arbitrary APIs have no common correlation-lookup); the dispatcher's
// per-(integration,event,correlation) debounce already suppresses duplicates.

// The vocabulary an admin can map API fields onto. Values are computed per event.
const EVENT_KEYS = ['title', 'explanation', 'summary', 'severity', 'metric', 'host', 'correlationId', 'deviation', 'observed', 'baseline', 'impact', 'urgency'];
const METHODS = ['POST', 'PUT'];
const PATH_MAX = 256;
const FIELD_MAX = 128;
const HEADER_MAX = 1024;
const MAX_FIELDS = 40;
const CONFIG_MAX_CHARS = 8000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function createCustomItsmConnector({ fetchImpl = globalThis.fetch, logger = silentLogger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const type = 'custom';
  const authTypes = ['none', 'basic', 'token', 'oauth2'];
  const defaultEvents = ['incident', 'anomaly'];

  function impactUrgency(severity) {
    const s = String(severity || '').toUpperCase();
    if (s === 'CRIT') return { impact: '1', urgency: '1' };
    if (s === 'WARN') return { impact: '2', urgency: '2' };
    return { impact: '3', urgency: '3' };
  }

  // The per-event context an admin's `fields` map draws from. Missing values are
  // null so they are simply omitted from the body rather than sent as "null".
  function contextFor(event) {
    const f = event.finding || {};
    const sev = String(f.severity || event.severity || 'INFO').toUpperCase();
    const host = f.hostId == null ? null : String(f.hostId);
    const metric = f.metric == null ? null : String(f.metric);
    const { impact, urgency } = impactUrgency(sev);
    return {
      title: `[BlueEye ${sev}] ${metric || 'finding'}${host ? ` on host ${host}` : ''}`,
      explanation: f.explanation || event.summary || 'BlueEye detected an anomaly.',
      summary: event.summary || f.explanation || '',
      severity: sev,
      metric,
      host,
      correlationId: event.correlationId || null,
      deviation: f.deviation == null ? null : f.deviation,
      observed: f.observed == null ? null : f.observed,
      baseline: f.baseline == null ? null : f.baseline,
      impact,
      urgency,
    };
  }

  function cfgOf(integration) {
    return (integration && integration.config && typeof integration.config === 'object' && !Array.isArray(integration.config)) ? integration.config : {};
  }
  function pathOf(integration) {
    const p = cfgOf(integration).path;
    return typeof p === 'string' && p ? p : '/';
  }
  function methodOf(integration) {
    const m = String(cfgOf(integration).method || 'POST').toUpperCase();
    return METHODS.includes(m) ? m : 'POST';
  }
  function testPathOf(integration) {
    const t = cfgOf(integration).testPath;
    return typeof t === 'string' && t ? t : pathOf(integration);
  }
  function headersFor(integration) {
    const c = cfgOf(integration);
    const staticHeaders = (c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)) ? c.headers : {};
    // Auth header wins over any static header of the same name.
    return { ...staticHeaders, ...authHeader(integration.authType, integration.credentials, { tokenScheme: c.tokenScheme || 'Bearer' }) };
  }

  // Sets a (possibly dotted) key on `obj`, creating intermediate objects. Refuses
  // to walk through a prototype-pollution segment. Never throws.
  function setPath(obj, dottedKey, value) {
    const parts = String(dottedKey).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i += 1) {
      const key = parts[i];
      if (FORBIDDEN_KEYS.has(key)) return;
      if (i === parts.length - 1) { cur[key] = value; return; }
      if (cur[key] === null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
      cur = cur[key];
    }
  }

  // Builds the request body: staticFields as a base (deep-cloned so we never mutate
  // stored config), with each mapped event field written on top.
  function buildBody(integration, event) {
    const c = cfgOf(integration);
    let body = {};
    if (c.staticFields && typeof c.staticFields === 'object' && !Array.isArray(c.staticFields)) {
      try { body = JSON.parse(JSON.stringify(c.staticFields)); } catch { body = {}; }
    }
    const ctx = contextFor(event);
    const fields = (c.fields && typeof c.fields === 'object' && !Array.isArray(c.fields)) ? c.fields : { short_description: 'title', description: 'explanation', correlation_id: 'correlationId' };
    for (const [target, key] of Object.entries(fields)) {
      const v = ctx[key];
      if (v !== undefined && v !== null) setPath(body, target, v);
    }
    return body;
  }

  // config validation: paths, method, and the shapes of fields/staticFields/headers.
  function validateConfig(config) {
    const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const value = {};
    if (c.path !== undefined && c.path !== null && c.path !== '') {
      const p = String(c.path);
      if (!p.startsWith('/') || p.length > PATH_MAX) return { errors: { path: 'path must start with / and be at most 256 chars' } };
      value.path = p;
    }
    if (c.method !== undefined && c.method !== null && c.method !== '') {
      const m = String(c.method).toUpperCase();
      if (!METHODS.includes(m)) return { errors: { method: `method must be one of: ${METHODS.join(', ')}` } };
      value.method = m;
    }
    if (c.testPath !== undefined && c.testPath !== null && c.testPath !== '') {
      const t = String(c.testPath);
      if (!t.startsWith('/') || t.length > PATH_MAX) return { errors: { testPath: 'testPath must start with / and be at most 256 chars' } };
      value.testPath = t;
    }
    if (c.tokenScheme !== undefined && c.tokenScheme !== null && c.tokenScheme !== '') {
      const s = String(c.tokenScheme);
      if (s.length > FIELD_MAX || /\s/.test(s)) return { errors: { tokenScheme: 'tokenScheme must be a single word' } };
      value.tokenScheme = s;
    }
    if (c.fields !== undefined && c.fields !== null) {
      if (typeof c.fields !== 'object' || Array.isArray(c.fields)) return { errors: { fields: 'fields must be an object of { apiField: eventKey }' } };
      const entries = Object.entries(c.fields);
      if (entries.length > MAX_FIELDS) return { errors: { fields: `fields must have at most ${MAX_FIELDS} entries` } };
      const out = {};
      for (const [target, key] of entries) {
        if (typeof target !== 'string' || target === '' || target.length > FIELD_MAX) return { errors: { fields: 'each field name must be a 1-128 char string' } };
        if (String(target).split('.').some((seg) => FORBIDDEN_KEYS.has(seg) || seg === '')) return { errors: { fields: `field name "${target}" is not allowed` } };
        if (typeof key !== 'string' || !EVENT_KEYS.includes(key)) return { errors: { fields: `field "${target}" must map to one of: ${EVENT_KEYS.join(', ')}` } };
        out[target] = key;
      }
      value.fields = out;
    }
    if (c.staticFields !== undefined && c.staticFields !== null) {
      if (typeof c.staticFields !== 'object' || Array.isArray(c.staticFields)) return { errors: { staticFields: 'staticFields must be an object' } };
      if (hasForbiddenKey(c.staticFields)) return { errors: { staticFields: 'staticFields must not contain __proto__, constructor or prototype keys' } };
      value.staticFields = c.staticFields;
    }
    if (c.headers !== undefined && c.headers !== null) {
      if (typeof c.headers !== 'object' || Array.isArray(c.headers)) return { errors: { headers: 'headers must be an object of string values' } };
      const out = {};
      for (const [name, hv] of Object.entries(c.headers)) {
        if (FORBIDDEN_KEYS.has(name)) return { errors: { headers: `header "${name}" is not allowed` } };
        if (typeof name !== 'string' || name === '' || name.length > FIELD_MAX || !/^[A-Za-z0-9-]+$/.test(name)) return { errors: { headers: 'each header name must be a 1-128 char token ([A-Za-z0-9-])' } };
        if (typeof hv !== 'string' || hv.length > HEADER_MAX) return { errors: { headers: `header "${name}" must be a string up to ${HEADER_MAX} chars` } };
        out[name] = hv;
      }
      value.headers = out;
    }
    let str;
    try { str = JSON.stringify(value); } catch { return { errors: { config: 'config must be JSON-serialisable' } }; }
    if (str.length > CONFIG_MAX_CHARS) return { errors: { config: `config is too large (max ${CONFIG_MAX_CHARS} chars)` } };
    return { value };
  }

  // Sends the event as a ticket create. Returns { ok, status, detail, correlationId }.
  async function send(integration, event) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const method = methodOf(integration);
    const path = pathOf(integration);
    const res = await requestJson(fetchImpl, {
      method,
      url: `${base}${path}`,
      headers: headersFor(integration),
      body: buildBody(integration, event),
      timeoutMs,
    });
    return {
      ok: res.ok,
      status: res.status,
      detail: res.ok ? `${method} ${path} (${res.status})` : `${method} failed: ${res.detail}`,
      correlationId: event.correlationId || null,
    };
  }

  // Connectivity/auth check: a bounded GET of the test (or create) path. A create
  // endpoint that rejects GET surfaces its status here — point testPath at a
  // read-safe endpoint if that is undesirable.
  async function test(integration) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: `${base}${testPathOf(integration)}`,
      headers: headersFor(integration),
      timeoutMs,
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? `reached endpoint (${res.status})` : res.detail };
  }

  return { type, authTypes, defaultEvents, validateConfig, send, test };
}

// Recursively true if any object in the graph carries a forbidden own key.
function hasForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) return true;
      if (hasForbiddenKey(value[k])) return true;
    }
  }
  return false;
}

module.exports = { createCustomItsmConnector, EVENT_KEYS };
