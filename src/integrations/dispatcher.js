'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A failed attempt is worth retrying only when it's transient: a network failure
// (status 0) or a 5xx. A 4xx is a request problem (bad auth, bad payload) that a
// retry won't fix, so we stop and let the audit record it.
function isRetryable(status) {
  return status === 0 || (status >= 500 && status <= 599);
}

// The trigger layer for outbound integrations. Domain events (a finding becoming a
// NIS2-incident or anomaly, an agent enrolling or being deleted) are emitted here;
// the dispatcher fans each one out to every ENABLED integration whose connector
// subscribes to that event type, with:
//   - debounce  — a per (integration, correlation) cooldown so a recurring
//                 condition doesn't hammer the target;
//   - retry     — bounded exponential backoff on transient failures;
//   - audit     — exactly one integration_audit row per fire (ok/fail + the
//                 target's HTTP status + attempt count + actor for manual tests).
// Credentials are decrypted (secret box) only at fire time, never stored decoded.
function createIntegrationsDispatcher({
  integrationsRepo,
  auditRepo = null,
  secretBox,
  registry,
  logger = silentLogger,
  sleep = defaultSleep,
  now = () => Date.now(),
  cooldownMs = 60 * 1000,
  maxAttempts = 3,
  backoffBaseMs = 500,
}) {
  const lastFired = new Map(); // `${integrationId}|${correlationId}` -> last ts

  // Decrypts an integration's credentials into a plain object. A decrypt failure
  // yields {} (the request then goes out unauthenticated, the target answers 401,
  // and the audit records that) — never a throw that breaks the caller.
  function decryptCreds(integration) {
    try {
      return secretBox.decryptJson(integration.credentials_encrypted || '');
    } catch (err) {
      logger.warn(`integrations: could not decrypt credentials for #${integration.id} (${err.message})`);
      return {};
    }
  }

  // Shapes a DB row into the object a connector consumes (decrypted creds + config).
  function shape(integration) {
    return {
      id: integration.id,
      name: integration.name,
      type: integration.type,
      baseUrl: integration.base_url,
      authType: integration.auth_type,
      credentials: decryptCreds(integration),
      config: integration.config_json || {},
    };
  }

  // One audit row per fire. Best-effort: auditing never breaks a fire.
  async function audit(integration, event, result, attempts, actor) {
    if (!auditRepo || typeof auditRepo.record !== 'function') return;
    try {
      await auditRepo.record({
        integrationId: integration.id,
        integrationName: integration.name,
        integrationType: integration.type,
        event: event.type,
        correlationId: event.correlationId || null,
        ok: Boolean(result && result.ok),
        statusCode: result && result.status != null ? result.status : null,
        attempts,
        detail: result && result.detail,
        actorUserId: (actor && actor.id) || null,
        actorEmail: (actor && actor.email) || null,
        actorRole: (actor && actor.role) || null,
      });
    } catch (err) {
      logger.warn(`integrations: audit write failed (${err.message})`);
    }
  }

  // Calls one connector with bounded exponential-backoff retry. A connector that
  // throws is treated as a network failure (status 0) so it follows the same
  // retry rule. Returns { result, attempts }.
  async function sendWithRetry(connector, shaped, event) {
    let attempts = 0;
    let result = null;
    for (let i = 0; i < Math.max(1, maxAttempts); i += 1) {
      attempts += 1;
      try {
        result = await connector.send(shaped, event); // eslint-disable-line no-await-in-loop
      } catch (err) {
        result = { ok: false, status: 0, detail: `connector threw: ${err.message}` };
      }
      if (result && (result.ok || result.skipped)) break;
      if (!isRetryable(result ? result.status : 0)) break;
      if (i < maxAttempts - 1) {
        await sleep(backoffBaseMs * (2 ** i)); // eslint-disable-line no-await-in-loop
      }
    }
    return { result: result || { ok: false, status: 0, detail: 'no result' }, attempts };
  }

  // Fires one event at one integration: debounce -> send (retry) -> audit.
  async function fireOne(integration, event, { actor = null, bypassDebounce = false } = {}) {
    const connector = registry.get(integration.type);
    if (!connector) {
      const result = { ok: false, status: 0, detail: `no connector for type "${integration.type}"` };
      await audit(integration, event, result, 0, actor);
      return result;
    }
    if (!bypassDebounce) {
      // Key includes the event type so distinct events that share a correlation
      // id (agent.enroll vs agent.delete; an anomaly escalating to an incident)
      // are never debounced against each other.
      const key = `${integration.id}|${event.type}|${event.correlationId || ''}`;
      const last = lastFired.get(key);
      const ts = now();
      if (last !== undefined && ts - last < cooldownMs) {
        return { ok: false, skipped: true, debounced: true, detail: 'debounced' };
      }
      lastFired.set(key, ts);
    }
    const { result, attempts } = await sendWithRetry(connector, shape(integration), event);
    await audit(integration, event, result, attempts, actor);
    if (!result.ok && !result.skipped) {
      logger.warn(`integrations: ${integration.name} ${event.type} failed after ${attempts} attempt(s) (${result.detail})`);
    }
    return { ...result, attempts };
  }

  // Fans an event out to every enabled, subscribed integration.
  async function emit(event, { bypassDebounce = false } = {}) {
    let integrations = [];
    try {
      integrations = await integrationsRepo.findEnabledWithSecret();
    } catch (err) {
      logger.warn(`integrations: could not load integrations (${err.message})`);
      return { dispatched: 0, results: [] };
    }
    const results = [];
    for (const integration of integrations) {
      const connector = registry.get(integration.type);
      if (!connector) continue;
      if (!registry.eventsFor(integration, connector).includes(event.type)) continue;
      const r = await fireOne(integration, event, { bypassDebounce }); // eslint-disable-line no-await-in-loop
      results.push({ integrationId: integration.id, name: integration.name, ...r });
    }
    return { dispatched: results.filter((r) => !r.skipped).length, results };
  }

  // --- Event builders ------------------------------------------------------

  // A CRIT finding is a NIS2-incident (threshold breach); anything else is an
  // anomaly. correlation_id is STABLE for an ongoing (host, metric, kind) problem,
  // so ServiceNow updates one ticket instead of spawning a duplicate each time.
  function findingEvent(finding) {
    const severity = String(finding.severity || '').toUpperCase();
    return {
      type: severity === 'CRIT' ? 'incident' : 'anomaly',
      kind: 'finding',
      severity,
      correlationId: `be-finding-${finding.hostId}-${finding.metric}-${finding.kind}`,
      summary: finding.explanation || '',
      finding: {
        id: finding.id, hostId: finding.hostId, metric: finding.metric, kind: finding.kind,
        severity, explanation: finding.explanation, observed: finding.observed,
        baseline: finding.baseline, deviation: finding.deviation, at: finding.createdAt,
      },
    };
  }

  async function emitFinding(finding) {
    if (!finding || finding.hostId == null) return { dispatched: 0, results: [] };
    return emit(findingEvent(finding));
  }

  function agentEvent(kind, agent) {
    return {
      type: `agent.${kind}`,
      kind: 'agent',
      correlationId: `be-agent-${agent.id}`,
      agent: { id: agent.id, hostname: agent.hostname, display_name: agent.display_name, location_id: agent.location_id },
    };
  }

  async function emitAgentEvent(kind, agent) {
    if (!agent || agent.id == null) return { dispatched: 0, results: [] };
    if (kind !== 'enroll' && kind !== 'delete') return { dispatched: 0, results: [] };
    return emit(agentEvent(kind, agent));
  }

  // A cross-agent incident cluster as an ITSM event (Fase 5). ONE ticket per
  // cluster: correlation_id `be-cluster-<id>` makes the connector idempotent, so a
  // clustered incident never spawns per-member tickets. `worknote`, when set, makes
  // the connector APPEND a comment to the same ticket instead of rewriting it.
  function clusterEvent(cluster, { worknote = null } = {}) {
    return {
      type: 'incident',
      kind: 'cluster',
      severity: String(cluster.severity || 'WARN').toUpperCase(),
      correlationId: `be-cluster-${cluster.clusterId}`,
      summary: cluster.summary || cluster.suspectedCommonCause || 'Cross-agent incident',
      worknote: worknote || null,
      cluster: {
        id: cluster.clusterId, confidence: cluster.confidence, agentCount: cluster.agentCount,
        classification: cluster.classification, memberCount: cluster.memberCount,
      },
    };
  }

  // First ok result's external ticket ref (sys_id) + integration id — the caller
  // stores these on the cluster.
  function firstRef(results) {
    const ok = (results || []).find((r) => r.ok && r.ref);
    return ok ? { ticketRef: ok.ref, integrationId: ok.integrationId } : null;
  }

  // Cluster-opened → create-or-update the ONE ticket. Returns the fan-out result
  // plus `ref` (ticketRef + integrationId) so the cluster can store it.
  async function emitCluster(cluster) {
    if (!cluster || cluster.clusterId == null) return { dispatched: 0, results: [], ref: null };
    const out = await emit(clusterEvent(cluster), { bypassDebounce: true });
    return { ...out, ref: firstRef(out.results) };
  }

  // Cluster update/escalation/verification/resolve → append a worknote to the same
  // ticket. Connectors without worknote support skip it (never a duplicate ticket).
  async function emitClusterNote(cluster, note) {
    if (!cluster || cluster.clusterId == null || !note) return { dispatched: 0, results: [] };
    return emit(clusterEvent(cluster, { worknote: String(note) }), { bypassDebounce: true });
  }

  // Manual test-fire from the admin API. Loads the integration (with its secret),
  // runs the connector's connectivity test (NO debounce), records an audit row and
  // returns the ACTUAL result (incl. the target's HTTP status). Returns null when
  // the integration doesn't exist (route -> 404).
  async function testFire(integrationId, actor = null) {
    const integration = await integrationsRepo.findByIdWithSecret(integrationId);
    if (!integration) return null;
    const connector = registry.get(integration.type);
    if (!connector) {
      const result = { ok: false, status: 0, detail: `no connector for type "${integration.type}"` };
      await audit(integration, { type: 'test', correlationId: null }, result, 0, actor);
      return result;
    }
    let result;
    try {
      result = await connector.test(shape(integration));
    } catch (err) {
      result = { ok: false, status: 0, detail: `connector threw: ${err.message}` };
    }
    await audit(integration, { type: 'test', correlationId: null }, result, 1, actor);
    return result;
  }

  return { emit, emitFinding, emitAgentEvent, emitCluster, emitClusterNote, testFire };
}

module.exports = { createIntegrationsDispatcher, isRetryable };
