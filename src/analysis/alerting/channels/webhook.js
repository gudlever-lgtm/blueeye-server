'use strict';

const crypto = require('crypto');

const silentLogger = { info() {}, warn() {}, error() {} };

// Webhook channel: POSTs the finding (+ its correlation group) as JSON to a
// configurable URL. The body is HMAC-SHA256 signed with a shared secret so the
// receiver can verify authenticity (header `X-BlueEye-Signature: sha256=<hex>`).
// fetch is injected for tests (no real network).
function createWebhookChannel({ config = {}, fetchImpl = globalThis.fetch, logger = silentLogger }) {
  async function send(finding, group) {
    if (!config.url) return { ok: false, detail: 'no webhook url configured' };
    if (typeof fetchImpl !== 'function') return { ok: false, detail: 'no fetch implementation' };

    const body = JSON.stringify({
      type: 'finding',
      sentAt: new Date().toISOString(),
      finding,
      group: group ? { likelyCause: group.likelyCause, hint: group.hint } : null,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (config.secret) {
      const sig = crypto.createHmac('sha256', config.secret).update(body).digest('hex');
      headers['X-BlueEye-Signature'] = `sha256=${sig}`;
    }

    let res;
    try {
      // redirect:'manual' so a validated (external) URL can't 3xx-redirect the
      // request onto an internal host — a redirect surfaces as a non-ok status
      // below rather than being followed. Mirrors the integrations httpClient.
      res = await fetchImpl(config.url, { method: 'POST', headers, body, redirect: 'manual' });
    } catch (err) {
      logger.warn(`alerting: webhook request failed (${err.message})`);
      return { ok: false, detail: `request failed: ${err.message}` };
    }
    if (!res || !res.ok) return { ok: false, detail: `provider returned ${res ? res.status : 'no response'}` };
    return { ok: true, detail: `posted (${res.status})` };
  }

  return { name: 'webhook', send };
}

module.exports = { createWebhookChannel };
