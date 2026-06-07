'use strict';

const crypto = require('crypto');
const { authHeader, requestJson, DEFAULT_TIMEOUT_MS } = require('../httpClient');

const silentLogger = { info() {}, warn() {}, error() {} };

// Generic outbound webhook connector — the simplest concrete proof that the
// connector interface is open for future targets (Netbox, custom systems). POSTs
// the event as JSON to base_url. If a shared secret is configured in credentials
// it HMAC-SHA256-signs the body (X-BlueEye-Signature: sha256=<hex>) exactly like
// the alerting webhook channel, so a receiver can verify authenticity. Reacts to
// every event type by default.
function createWebhookConnector({ fetchImpl = globalThis.fetch, logger = silentLogger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const type = 'webhook';
  const authTypes = ['none', 'token', 'basic'];
  const defaultEvents = ['incident', 'anomaly', 'agent.enroll', 'agent.delete'];

  function validateConfig() {
    // No required type-specific config; signing is via the optional credentials.secret.
    return { value: {} };
  }

  function bodyFor(event, extra = {}) {
    return {
      type: 'blueeye.event',
      event: event.type,
      sentAt: new Date().toISOString(),
      correlationId: event.correlationId || null,
      data: event.finding || event.agent || null,
      ...extra,
    };
  }

  async function post(integration, event, extra) {
    const url = String(integration.baseUrl || '');
    const payload = bodyFor(event, extra);
    const raw = JSON.stringify(payload);
    const headers = { ...authHeader(integration.authType, integration.credentials, {}) };
    const secret = integration.credentials && integration.credentials.secret;
    if (secret) {
      headers['X-BlueEye-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    }
    // requestJson stringifies the body itself; pass the object (signature is over
    // the same canonical JSON.stringify, so it matches what goes on the wire).
    const res = await requestJson(fetchImpl, { method: 'POST', url, headers, body: payload, timeoutMs });
    return { ok: res.ok, status: res.status, detail: res.ok ? `posted (${res.status})` : res.detail };
  }

  async function send(integration, event) {
    return post(integration, event);
  }

  async function test(integration) {
    return post(integration, { type: 'test', correlationId: `test-${Date.now()}` }, { test: true });
  }

  return { type, authTypes, defaultEvents, validateConfig, send, test };
}

module.exports = { createWebhookConnector };
