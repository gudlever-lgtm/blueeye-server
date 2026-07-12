'use strict';

const { authHeader, requestJson, DEFAULT_TIMEOUT_MS } = require('../httpClient');

const silentLogger = { info() {}, warn() {}, error() {} };

// A generic, CONFIG-DRIVEN CMDB connector — "bring your own CMDB". Unlike the
// ServiceNow/Nautobot connectors (which hard-code their APIs), everything here is
// supplied by the admin in the CMDB config's `config` object, so any HTTP/JSON
// asset API can be wired up without new code:
//
//   searchPath     path appended to base_url for the search (e.g. /api/assets)
//   queryParam     query-string param carrying the search text (default 'q')
//   testPath       path for the connection test (default = searchPath)
//   resultsPath    dot-path to the results ARRAY in the response (default '' =
//                  the response body is itself the array)
//   idField        dot-path (within a result) to the asset id     (default 'id')
//   nameField      dot-path to the display name                    (default 'name')
//   typeField      dot-path to the asset type/class                (optional)
//   locationField  dot-path to the location label                  (optional)
//   tokenScheme    Authorization scheme word for token auth        (default 'Bearer')
//
// Auth reuses the shared authHeader (basic/token/oauth2/none). Only metadata is
// ever read — the connector normalises every result to { id, name, type, location }.
function createCustomCmdbConnector({ fetchImpl = globalThis.fetch, logger = silentLogger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const type = 'custom';
  const authTypes = ['none', 'basic', 'token', 'oauth2'];

  // Reads a dot-path (e.g. "data.items" or "device.name") out of an object.
  // An empty/absent path returns the value itself. Never throws.
  function pick(obj, path) {
    if (path === undefined || path === null || path === '') return obj;
    let cur = obj;
    for (const key of String(path).split('.')) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[key];
    }
    return cur;
  }
  const asString = (v) => (v === null || v === undefined ? null : String(v));

  function cfgOf(integration) {
    return (integration && integration.config && typeof integration.config === 'object') ? integration.config : {};
  }
  function headersFor(integration) {
    const c = cfgOf(integration);
    return authHeader(integration.authType, integration.credentials, { tokenScheme: c.tokenScheme || 'Bearer' });
  }
  function urlFor(integration, path, params) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const p = String(path || '/');
    let url = `${base}${p.startsWith('/') ? '' : '/'}${p}`;
    const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (entries.length) {
      const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    return url;
  }

  // Connectivity/auth check: a bounded GET of the test (or search) path.
  async function testConnection(integration) {
    const c = cfgOf(integration);
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: urlFor(integration, c.testPath || c.searchPath || '/', {}),
      headers: headersFor(integration),
      timeoutMs,
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? `reached CMDB (${res.status})` : res.detail };
  }

  // Config-driven asset search → normalised { id, name, type, location }[].
  async function search(integration, query) {
    const c = cfgOf(integration);
    const q = String(query || '').trim();
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: urlFor(integration, c.searchPath || '/', { [c.queryParam || 'q']: q }),
      headers: headersFor(integration),
      timeoutMs,
    });
    if (!res.ok) return { ok: false, status: res.status, detail: res.detail, assets: [] };
    const arr = pick(res.json, c.resultsPath);
    const rows = Array.isArray(arr) ? arr : [];
    const assets = rows
      .map((r) => ({
        id: asString(pick(r, c.idField || 'id')) || '',
        name: asString(pick(r, c.nameField || 'name')) || '',
        type: c.typeField ? asString(pick(r, c.typeField)) : null,
        location: c.locationField ? asString(pick(r, c.locationField)) : null,
      }))
      .filter((a) => a.id);
    return { ok: true, status: res.status, assets };
  }

  return { type, authTypes, testConnection, search };
}

module.exports = { createCustomCmdbConnector };
