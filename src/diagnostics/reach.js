'use strict';

// Lightweight reachability probe for admin-configured infrastructure endpoints
// (the SAML IdP SSO URL, the AI-assistant API, …). Unlike integrations/httpClient
// it deliberately does NOT apply the private-IP SSRF block: these targets are
// server-side configuration (not per-request input) and are explicitly allowed to
// be self-hosted on a private network (EU/self-hosted policy). ANY HTTP response —
// even 3xx/4xx/5xx — answers "is it reachable?" with yes; only a network error or
// timeout counts as unreachable. fetch is injected so tests run offline.

const DEFAULT_TIMEOUT_MS = 8000;

async function reachUrl(fetchImpl, url, { method = 'GET', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, detail: 'no fetch implementation' };
  if (!url) return { ok: false, status: 0, detail: 'no url' };
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { ok: false, status: 0, detail: 'invalid url' }; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    // redirect:'manual' — a reachable host that 3xx-redirects still counts as up,
    // and we never silently follow it somewhere else.
    res = await fetchImpl(parsed.toString(), { method, redirect: 'manual', signal: controller.signal });
  } catch (err) {
    return { ok: false, status: 0, detail: `unreachable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }

  const status = res ? res.status : 0;
  return { ok: status > 0, status, detail: status ? `reachable (HTTP ${status})` : 'no response' };
}

module.exports = { reachUrl, DEFAULT_TIMEOUT_MS };
