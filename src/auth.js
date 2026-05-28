import { createHmac, timingSafeEqual } from 'node:crypto';

// Agent WebSocket token format (HMAC):
//
//   token   = base64url(payload) "." base64url(HMAC_SHA256(secret, base64url(payload)))
//   payload = "<agentId>:<exp>"      where exp is a unix timestamp in seconds
//
// The signature binds the agentId and expiry to the shared WS_AGENT_SECRET, so
// the server can verify a token offline (no DB lookup) and reject anything that
// is malformed, tampered with, or expired.

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Mint a signed agent token. Used by the token-minting CLI and by tests.
 * @param {string} agentId
 * @param {number} exp unix timestamp in seconds at which the token expires
 * @param {string} secret shared HMAC secret (WS_AGENT_SECRET)
 */
export function signAgentToken(agentId, exp, secret) {
  if (!secret) throw new Error('cannot sign token without a secret');
  const payload = b64url(`${agentId}:${exp}`);
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify an agent token against the shared secret.
 * @returns {{ok: true, agentId: string, exp: number} | {ok: false, reason: string}}
 */
export function verifyAgentToken(token, secret, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'server has no WS_AGENT_SECRET configured' };
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'missing token' };
  }

  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) {
    return { ok: false, reason: 'malformed token' };
  }
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(payload).digest();
  let provided;
  try {
    provided = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'bad signature encoding' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad signature' };
  }

  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf(':');
  if (sep < 1) return { ok: false, reason: 'malformed payload' };
  const agentId = decoded.slice(0, sep);
  const exp = Number(decoded.slice(sep + 1));
  if (!Number.isFinite(exp)) return { ok: false, reason: 'invalid expiry' };
  if (exp * 1000 <= now) return { ok: false, reason: 'token expired' };

  return { ok: true, agentId, exp };
}

/**
 * Extract an agent token from a WebSocket upgrade request.
 * Prefers `Authorization: Bearer <token>`, falls back to a `?token=` query param.
 */
export function extractAgentToken(req) {
  const auth = req?.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const t = url.searchParams.get('token');
    if (t) return t;
  } catch {
    // ignore unparsable URLs
  }
  return null;
}
