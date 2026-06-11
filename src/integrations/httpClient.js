'use strict';

// Shared outbound-HTTP helper for connectors. Mirrors the assistant's pattern:
// fetch is injected (so tests run offline) and each call is bounded by an
// AbortController timeout. requestJson NEVER throws for an HTTP error status — it
// returns { ok, status, detail, json }; a network failure/timeout comes back as
// { ok:false, status:0 }. The dispatcher uses status to decide whether a retry
// makes sense (network/5xx) or not (4xx is the caller's fault and won't self-heal).

const { baseUrlBlockedReason } = require('./ssrfGuard');

const DEFAULT_TIMEOUT_MS = 15000;

// Builds the Authorization header from the decrypted credentials. Returns {} when
// no usable credential is present (so a request just goes out unauthenticated and
// the target answers 401 — which the audit then records faithfully). tokenScheme
// lets token-auth connectors pick their header word (Nautobot uses "Token").
function authHeader(authType, credentials = {}, { tokenScheme = 'Bearer' } = {}) {
  const c = credentials && typeof credentials === 'object' ? credentials : {};
  if (authType === 'basic') {
    if (!c.username) return {};
    const raw = `${c.username}:${c.password || ''}`;
    return { Authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` };
  }
  if (authType === 'oauth2') {
    const tok = c.accessToken || c.token || '';
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  }
  if (authType === 'token') {
    const tok = c.token || c.accessToken || '';
    return tok ? { Authorization: `${tokenScheme} ${tok}` } : {};
  }
  return {};
}

// JSON request with a timeout. Returns { ok, status, detail, json }.
async function requestJson(fetchImpl, { method = 'GET', url, headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, detail: 'no fetch implementation', json: null };
  if (!url) return { ok: false, status: 0, detail: 'no url', json: null };
  // SSRF guard at send time too: blocks an internal IP-literal target even if it
  // was stored before validation existed, or appears as a redirect Location.
  const blocked = baseUrlBlockedReason(url);
  if (blocked) return { ok: false, status: 0, detail: blocked, json: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sendBody = body !== undefined && body !== null;
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(sendBody ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: sendBody ? JSON.stringify(body) : undefined,
      // Don't follow redirects: an allowed host could otherwise 3xx us to an
      // internal address, bypassing the host check above.
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, status: 0, detail: `request failed: ${err.message}`, json: null };
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { ok: Boolean(res && res.ok), status: res ? res.status : 0, detail: `status ${res ? res.status : 0}`, json };
}

module.exports = { authHeader, requestJson, DEFAULT_TIMEOUT_MS };
