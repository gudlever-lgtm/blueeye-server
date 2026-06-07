'use strict';

const { authHeader, requestJson, DEFAULT_TIMEOUT_MS } = require('../httpClient');

const silentLogger = { info() {}, warn() {}, error() {} };

// Nautobot IPAM/DCIM connector. ONE-WAY push: syncs BlueEye agents as Nautobot
// devices (REST API, token auth). Idempotent — it looks a device up by name and
// PATCHes it, or POSTs a new one. Deletion is NEVER performed unless the
// integration's config explicitly sets allowDelete:true (the "ingen sletning uden
// eksplicit flag" rule); otherwise an agent.delete event is recorded as skipped.
//
// Nautobot device creation needs environment-specific required fields (device_type,
// role, location, status). Those are supplied once in config.deviceDefaults and
// merged into every create — BlueEye does not guess them.
function createNautobotConnector({ fetchImpl = globalThis.fetch, logger = silentLogger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const type = 'nautobot';
  const authTypes = ['token'];
  const defaultEvents = ['agent.enroll', 'agent.delete'];

  // config: { devicePath?, allowDelete?, deviceDefaults? }.
  function validateConfig(config) {
    const c = config && typeof config === 'object' ? config : {};
    const value = {};
    if (c.devicePath !== undefined) {
      const p = String(c.devicePath).trim();
      if (!/^\/[\w/-]{1,128}$/.test(p)) return { errors: { devicePath: 'devicePath must start with / and be 1-128 path chars' } };
      value.devicePath = p;
    }
    if (c.allowDelete !== undefined) value.allowDelete = c.allowDelete === true || c.allowDelete === 'true';
    if (c.deviceDefaults !== undefined) {
      if (!c.deviceDefaults || typeof c.deviceDefaults !== 'object' || Array.isArray(c.deviceDefaults)) {
        return { errors: { deviceDefaults: 'deviceDefaults must be an object' } };
      }
      value.deviceDefaults = c.deviceDefaults;
    }
    return { value };
  }

  function devicePath(integration) {
    const p = integration.config && integration.config.devicePath;
    return typeof p === 'string' && p ? p.replace(/\/+$/, '') : '/api/dcim/devices';
  }
  function headersFor(integration) {
    // Nautobot expects "Authorization: Token <token>".
    return authHeader(integration.authType, integration.credentials, { tokenScheme: 'Token' });
  }
  function deviceName(event) {
    const a = event.agent || {};
    return a.hostname || a.display_name || `blueeye-agent-${a.id}`;
  }

  // Finds a device by exact name. Returns its id, or null (and surfaces a lookup
  // failure so the caller doesn't create on a transient error).
  async function findDevice(integration, name) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: `${base}${devicePath(integration)}/?name=${encodeURIComponent(name)}&limit=1`,
      headers: headersFor(integration),
      timeoutMs,
    });
    const row = res.json && Array.isArray(res.json.results) ? res.json.results[0] : null;
    return { lookup: res, id: row ? row.id : null };
  }

  async function upsertDevice(integration, event) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const name = deviceName(event);
    const { lookup, id } = await findDevice(integration, name);
    if (!lookup.ok) {
      return { ok: false, status: lookup.status, detail: `lookup failed: ${lookup.detail}`, action: 'lookup' };
    }
    const defaults = (integration.config && integration.config.deviceDefaults) || {};
    const body = { name, ...defaults, comments: `Synced from BlueEye (agent ${event.agent && event.agent.id})` };

    let res;
    let action;
    if (id) {
      action = 'update';
      res = await requestJson(fetchImpl, { method: 'PATCH', url: `${base}${devicePath(integration)}/${encodeURIComponent(id)}/`, headers: headersFor(integration), body, timeoutMs });
    } else {
      action = 'create';
      res = await requestJson(fetchImpl, { method: 'POST', url: `${base}${devicePath(integration)}/`, headers: headersFor(integration), body, timeoutMs });
    }
    return { ok: res.ok, status: res.status, detail: res.ok ? `${action} device ${name} (${res.status})` : `${action} failed: ${res.detail}`, action };
  }

  async function deleteDevice(integration, event) {
    const allowDelete = Boolean(integration.config && integration.config.allowDelete);
    if (!allowDelete) {
      // One-way push: no deletion without the explicit flag. Recorded as a
      // successful no-op (skipped) so the audit shows it was intentionally held.
      return { ok: true, status: 0, detail: 'delete skipped (allowDelete=false)', action: 'skip', skipped: true };
    }
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const name = deviceName(event);
    const { lookup, id } = await findDevice(integration, name);
    if (!lookup.ok) return { ok: false, status: lookup.status, detail: `lookup failed: ${lookup.detail}`, action: 'lookup' };
    if (!id) return { ok: true, status: 0, detail: `no device named ${name} to delete`, action: 'delete', skipped: true };
    const res = await requestJson(fetchImpl, { method: 'DELETE', url: `${base}${devicePath(integration)}/${encodeURIComponent(id)}/`, headers: headersFor(integration), timeoutMs });
    return { ok: res.ok, status: res.status, detail: res.ok ? `deleted device ${name} (${res.status})` : `delete failed: ${res.detail}`, action: 'delete' };
  }

  async function send(integration, event) {
    if (event.type === 'agent.delete') return deleteDevice(integration, event);
    // Default (agent.enroll and any other agent event): upsert the device.
    return upsertDevice(integration, event);
  }

  async function test(integration) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: `${base}${devicePath(integration)}/?limit=1`,
      headers: headersFor(integration),
      timeoutMs,
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? `reached Nautobot (${res.status})` : res.detail };
  }

  return { type, authTypes, defaultEvents, validateConfig, send, test };
}

module.exports = { createNautobotConnector };
