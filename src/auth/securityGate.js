'use strict';

const { verifyToken } = require('./jwt');
const { looksLikeApiToken } = require('../lib/apiToken');
const { clientIp } = require('../services/complianceLogger');

// The per-request half of the baseline security controls (migration 041):
//
//   * role-based IP allowlist — a signed-in principal (user JWT or API token)
//     whose role has an allowlist may only be served from an address inside it;
//   * password max age — a LOCAL-password session whose password is older than
//     security.passwordMaxAgeDays is refused everything except changing it.
//
// Mounted once in src/routes/index.js, after the API-token middleware (so an API
// token's role is known) and before every router. The address is req.ip — the
// app's own trust-proxy decision (TRUST_PROXY in src/app.js), never a raw
// X-Forwarded-For header, which a client can set to anything.
//
// Unauthenticated requests pass straight through: the routers answer those 401.
// A token that does not verify also passes through, for the same reason.

// Routes a password-expired session may still reach — the ones needed to
// change it (mirrors the one-time-password gate next to this one).
const PASSWORD_CHANGE_ALLOWED = new Set(['/auth/login', '/auth/change-password', '/auth/sso', '/me', '/health']);

// Routes that authenticate by other means (or not at all) and check the
// allowlist themselves: sign-in answers with its own 403, the SSO callbacks
// redirect with a reason. A stale Authorization header on them is ignored.
function isSignInPath(p) {
  return p === '/auth/login' || p === '/auth/sso' || p.startsWith('/auth/oidc/') || p.startsWith('/auth/saml/')
    || p === '/health' || p.startsWith('/health/');
}

const IP_DENIED_BODY = {
  error: 'ip_not_allowed',
  message: 'Access from your network address is not permitted for your role.',
  messageKey: 'auth.ipDenied',
};
const PASSWORD_EXPIRED_BODY = {
  error: 'password_expired',
  message: 'Your password has expired. Choose a new one to continue.',
  messageKey: 'auth.fc.expiredLead',
};

function createSecurityGate({ securityPolicy, auditLogger = null, now = () => Date.now(), auditEveryMs = 5 * 60 * 1000 } = {}) {
  if (!securityPolicy) throw new Error('createSecurityGate requires securityPolicy');

  // One audit row per (principal, address) per window: a token replayed from
  // outside the allowlist would otherwise write a row per request into a table
  // that is never purged (the hash-chained audit_log).
  const lastAudited = new Map();
  function shouldAudit(key) {
    const t = now();
    const prev = lastAudited.get(key);
    if (prev !== undefined && t - prev < auditEveryMs) return false;
    if (lastAudited.size > 5000) lastAudited.clear();
    lastAudited.set(key, t);
    return true;
  }

  function principalOf(req) {
    // The API-token middleware ran first and verified the credential.
    if (req.authVerified && req.user) {
      return { id: req.user.id ?? null, email: req.user.email || null, role: req.user.role, apiToken: Boolean(req.user.apiTokenId), pwdAt: null };
    }
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token || looksLikeApiToken(token)) return null;
    let decoded = null;
    try { decoded = verifyToken(token); } catch { return null; }
    return {
      id: Number(decoded.sub) || null,
      email: decoded.email || null,
      role: decoded.role,
      apiToken: false,
      pwdAt: Number.isFinite(decoded.pwdAt) ? decoded.pwdAt : null,
    };
  }

  return async function securityGate(req, res, next) {
    try {
      if (isSignInPath(req.path)) return next();
      const who = principalOf(req);
      if (!who) return next();
      const policy = await securityPolicy.get();

      const ip = clientIp(req);
      const verdict = securityPolicy.checkIp(who.role, ip);
      if (!verdict.allowed) {
        if (auditLogger && shouldAudit(`${who.role}|${who.id || who.email}|${ip}`)) {
          await auditLogger.record(req, {
            category: 'auth', action: 'ip_denied', outcome: 'denied',
            actorUserId: who.id, actorEmail: who.email, actorRole: who.role,
            target: `${req.method} ${req.path}`.slice(0, 255),
            detail: `role=${who.role}; ${verdict.reason}${who.apiToken ? '; api token' : ''}`,
          });
        }
        return res.status(403).json(IP_DENIED_BODY);
      }

      // Max age: local-password sessions only (pwdAt is only ever minted by the
      // local sign-in and change-password paths), never API tokens.
      if (!who.apiToken && who.pwdAt !== null && policy.passwordMaxAgeDays > 0
        && !PASSWORD_CHANGE_ALLOWED.has(req.path)) {
        const expiresAtMs = (who.pwdAt * 1000) + policy.passwordMaxAgeDays * 24 * 60 * 60 * 1000;
        if (expiresAtMs <= now()) return res.status(403).json(PASSWORD_EXPIRED_BODY);
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// The client address of a raw HTTP upgrade (WebSocket), which never passes
// through Express and so has no req.ip. Mirrors the app's trust-proxy setting
// (`trust proxy` = 1 hop when TRUST_PROXY is on): the proxy's own entry — the
// LAST X-Forwarded-For hop — when trusted, the socket peer otherwise. Never the
// first XFF hop, which the client writes.
function upgradeClientIp(req, trustProxy) {
  const remote = (req && req.socket && req.socket.remoteAddress) || null;
  if (!trustProxy) return remote;
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : remote;
}

// Synchronous verdict for a decoded user JWT on the dashboard WebSocket
// upgrade: the same allowlist and max-age rules as the request gate, against
// the policy's last-known snapshot (the upgrade handshake is synchronous).
function upgradeAllowed(securityPolicy, decoded, ip, now = Date.now()) {
  if (!securityPolicy || !decoded) return true;
  if (!securityPolicy.checkIp(decoded.role, ip).allowed) return false;
  const policy = securityPolicy.snapshot();
  if (Number.isFinite(decoded.pwdAt) && policy.passwordMaxAgeDays > 0
    && decoded.pwdAt * 1000 + policy.passwordMaxAgeDays * 24 * 60 * 60 * 1000 <= now) return false;
  return true;
}

module.exports = {
  createSecurityGate, upgradeClientIp, upgradeAllowed,
  IP_DENIED_BODY, PASSWORD_EXPIRED_BODY, PASSWORD_CHANGE_ALLOWED,
};
