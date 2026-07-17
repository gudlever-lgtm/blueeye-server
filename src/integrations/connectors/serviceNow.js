'use strict';

const { authHeader, requestJson, DEFAULT_TIMEOUT_MS } = require('../httpClient');

const silentLogger = { info() {}, warn() {}, error() {} };

// ServiceNow ITSM connector. Creates/updates an Incident (REST Table API) when a
// NIS2-incident (CRIT finding) or anomaly fires. Auth is Basic or OAuth2 (Bearer).
// Idempotent via correlation_id: before creating it looks for an existing incident
// with the same correlation_id and PATCHes it instead, so a recurring condition
// updates one ticket rather than spawning duplicates.
//
// BlueEye severity -> ServiceNow impact/urgency (1=High .. 3=Low):
//   CRIT -> 1/1, WARN -> 2/2, INFO/other -> 3/3.
function createServiceNowConnector({ fetchImpl = globalThis.fetch, logger = silentLogger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const type = 'servicenow';
  const authTypes = ['basic', 'oauth2'];
  const defaultEvents = ['incident', 'anomaly'];

  function impactUrgency(severity) {
    const s = String(severity || '').toUpperCase();
    if (s === 'CRIT') return { impact: '1', urgency: '1' };
    if (s === 'WARN') return { impact: '2', urgency: '2' };
    return { impact: '3', urgency: '3' };
  }

  // Type-specific config_json. table defaults to 'incident'; events is an optional
  // override of which BlueEye events this integration reacts to.
  function validateConfig(config) {
    const c = config && typeof config === 'object' ? config : {};
    const value = {};
    if (c.table !== undefined) {
      const t = String(c.table).trim();
      if (!/^[a-z0-9_]{1,64}$/i.test(t)) return { errors: { table: 'table must be 1-64 chars of [a-z0-9_]' } };
      value.table = t;
    }
    return { value };
  }

  function tableOf(integration) {
    const t = integration.config && integration.config.table;
    return typeof t === 'string' && t ? t : 'incident';
  }

  function headersFor(integration) {
    return authHeader(integration.authType, integration.credentials, {});
  }

  // Builds the incident body from a finding.
  function incidentBody(event) {
    const f = event.finding || {};
    const { impact, urgency } = impactUrgency(f.severity || event.severity);
    const lines = [
      f.explanation || event.summary || 'BlueEye detected an anomaly.',
      '',
      `Host: ${f.hostId ?? 'n/a'}`,
      `Metric: ${f.metric ?? 'n/a'}`,
      `Severity: ${f.severity ?? event.severity ?? 'n/a'}`,
      f.deviation != null ? `Deviation: ${f.deviation}` : null,
      f.observed != null ? `Observed: ${f.observed}` : null,
      f.baseline != null ? `Baseline: ${f.baseline}` : null,
    ].filter((x) => x != null);
    return {
      short_description: `[BlueEye ${f.severity || event.severity || 'INFO'}] ${f.metric || 'finding'} on host ${f.hostId ?? 'n/a'}`,
      description: lines.join('\n'),
      impact,
      urgency,
      correlation_id: event.correlationId,
      // A stable source tag so ServiceNow admins can filter BlueEye-raised tickets.
      u_source: 'BlueEye',
    };
  }

  // Sends an event. Returns { ok, status, detail, correlationId, action }.
  async function send(integration, event) {
    const table = tableOf(integration);
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const headers = headersFor(integration);
    const cid = event.correlationId;

    // 1) Idempotency: find an existing incident with this correlation_id.
    const lookup = await requestJson(fetchImpl, {
      method: 'GET',
      url: `${base}/api/now/table/${encodeURIComponent(table)}?sysparm_query=correlation_id=${encodeURIComponent(cid)}&sysparm_limit=1&sysparm_fields=sys_id`,
      headers,
      timeoutMs,
    });
    // A failed lookup (auth/network) is reported as-is — don't blindly create.
    if (!lookup.ok) {
      return { ok: false, status: lookup.status, detail: `lookup failed: ${lookup.detail}`, correlationId: cid, action: 'lookup' };
    }
    const existing = lookup.json && Array.isArray(lookup.json.result) ? lookup.json.result[0] : null;
    // A worknote event just APPENDS to the journal field (ServiceNow work_notes is
    // additive on PATCH) — used to roll cluster updates onto the ONE cluster ticket
    // without rewriting its fields. Falls back to the full body when creating.
    const body = event.worknote
      ? { work_notes: String(event.worknote), correlation_id: cid, u_source: 'BlueEye' }
      : incidentBody(event);

    // 2) PATCH the existing ticket, or POST a new one.
    let res;
    let action;
    if (existing && existing.sys_id) {
      action = event.worknote ? 'worknote' : 'update';
      res = await requestJson(fetchImpl, {
        method: 'PATCH',
        url: `${base}/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(existing.sys_id)}`,
        headers,
        body,
        timeoutMs,
      });
    } else {
      action = 'create';
      res = await requestJson(fetchImpl, {
        method: 'POST',
        url: `${base}/api/now/table/${encodeURIComponent(table)}`,
        headers,
        body,
        timeoutMs,
      });
    }
    const result = res.json && res.json.result;
    const number = result && result.number;
    const ref = (existing && existing.sys_id) || (result && result.sys_id) || null;
    return {
      ok: res.ok,
      status: res.status,
      detail: res.ok ? `${action} incident${number ? ' ' + number : ''} (${res.status})` : `${action} failed: ${res.detail}`,
      correlationId: cid,
      action,
      ref,               // sys_id of the ticket — stored on the cluster
      ticketNumber: number || null,
    };
  }

  // Connectivity/auth check: a bounded read against the table.
  async function test(integration) {
    const table = tableOf(integration);
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: `${base}/api/now/table/${encodeURIComponent(table)}?sysparm_limit=1&sysparm_fields=sys_id`,
      headers: headersFor(integration),
      timeoutMs,
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? `reached ServiceNow (${res.status})` : res.detail };
  }

  // --- CMDB integration (single source of truth) -------------------------------
  // The CMDB asset table (Configuration Items). Defaults to the platform's cmdb_ci
  // base class; override via config.assetTable to scope to a subclass.
  function assetTableOf(integration) {
    const t = integration.config && integration.config.assetTable;
    return typeof t === 'string' && t ? t : 'cmdb_ci';
  }

  // CMDB connectivity/auth check: a bounded read of the asset (CI) table — this
  // exercises the exact endpoint asset search uses, so a service account scoped to
  // the CMDB (but not to incidents) still passes. Returns { ok, status, detail }.
  async function testConnection(integration) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: `${base}/api/now/table/${encodeURIComponent(assetTableOf(integration))}?sysparm_limit=1&sysparm_fields=sys_id`,
      headers: headersFor(integration),
      timeoutMs,
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? `reached ServiceNow (${res.status})` : res.detail };
  }

  // CMDB asset search. Queries the CI table by name (nameLIKE) and normalises the
  // result to { id, name, type, location }[]. display_value=true resolves the
  // location reference to a readable string. Returns { ok, status, detail, assets }.
  async function search(integration, query) {
    const base = String(integration.baseUrl || '').replace(/\/+$/, '');
    const q = String(query || '').trim();
    const res = await requestJson(fetchImpl, {
      method: 'GET',
      url: `${base}/api/now/table/${encodeURIComponent(assetTableOf(integration))}`
        + `?sysparm_query=${encodeURIComponent('nameLIKE' + q)}`
        + '&sysparm_limit=20&sysparm_display_value=true'
        + '&sysparm_fields=sys_id,name,sys_class_name,location',
      headers: headersFor(integration),
      timeoutMs,
    });
    if (!res.ok) return { ok: false, status: res.status, detail: res.detail, assets: [] };
    const rows = res.json && Array.isArray(res.json.result) ? res.json.result : [];
    const assets = rows
      .map((r) => ({ id: String(r.sys_id ?? ''), name: r.name ?? '', type: r.sys_class_name || null, location: r.location || null }))
      .filter((a) => a.id);
    return { ok: true, status: res.status, assets };
  }

  return { type, authTypes, defaultEvents, validateConfig, send, test, testConnection, search };
}

module.exports = { createServiceNowConnector };
