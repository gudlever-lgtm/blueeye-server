'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { verifyPassword, hashPassword } = require('../auth/password');
const { issueToken } = require('../auth/jwt');
const { ROLES } = require('../auth/roles');
const { config } = require('../config');

// Authentication routes (public). Supports two paths behind the SAME endpoint:
//   1) external LDAP/AD auth (when enabled) — tried first; on success a local
//      user is just-in-time provisioned so the rest of the system is unchanged;
//   2) local JWT auth — the original flow, and the fallback when LDAP is
//      disabled or doesn't authenticate the user.
function createAuthRouter({ usersRepo, ldapAuth = null, ldapLoginAuditRepo = null, auditLogger = null, securityService = null }) {
  const router = express.Router();

  // Security pack (Enterprise `security_pack`): IP allowlist + lockout reset on a
  // successful login. Returns false (and writes the 403) when the source IP is
  // not allowed for this user's role; the caller must then NOT issue a token.
  async function passSecurityChecks(req, res, user, authKind) {
    if (!securityService) return true;
    const ip = req.ip;
    const chk = await securityService.checkIp({ ip, role: user.role });
    if (!chk.allowed) {
      await auditLogin(req, { action: 'login_denied_ip', outcome: 'denied', email: user.email, role: user.role, userId: user.id, detail: `auth=${authKind} ip not allowlisted` });
      res.status(403).json({ error: 'Access from this network is not permitted', reason: 'ip_not_allowlisted' });
      return false;
    }
    try { await securityService.recordSuccess({ email: user.email, ip }); } catch { /* best-effort */ }
    return true;
  }

  // Records a login outcome in the unified audit log (best-effort). Distinct
  // from the LDAP-specific login audit above, which captures bind detail.
  async function auditLogin(req, { action, outcome, email, role = null, userId = null, detail = null }) {
    if (!auditLogger) return;
    await auditLogger.record(req, {
      category: 'auth', action, outcome,
      actorUserId: userId, actorEmail: email, actorRole: role, target: email, detail,
    });
  }

  // A throwaway hash compared against when the email is unknown, so login takes
  // roughly the same time whether or not the account exists (reduces user
  // enumeration via timing). Computed lazily, then memoised.
  let dummyHashPromise = null;
  const getDummyHash = () => {
    if (!dummyHashPromise) {
      dummyHashPromise = hashPassword('account-enumeration-guard');
    }
    return dummyHashPromise;
  };

  // Records an LDAP login attempt (best-effort; auditing never blocks login).
  async function auditLdap(username, result, sourceIp) {
    if (!ldapLoginAuditRepo || typeof ldapLoginAuditRepo.record !== 'function') return;
    try {
      await ldapLoginAuditRepo.record({
        username,
        ok: Boolean(result.ok),
        reason: result.ok ? 'ok' : (result.reason || 'bind-failed'),
        grantedRole: result.ok ? result.role : null,
        groupsMatched: result.matched || 0,
        sourceIp,
      });
    } catch { /* best-effort */ }
  }

  // Finds or just-in-time provisions the local user backing an LDAP identity, so
  // we can issue the SAME JWT (sub = local user id) and the rest of the system —
  // /me, audit FKs, the users list — sees no difference. AD is the source of
  // truth for the role: an existing (non-protected) user's role is realigned to
  // the LDAP-derived one; a protected super-admin is never demoted.
  async function provisionLdapUser(result) {
    const email = result.email;
    const existing = await usersRepo.findByEmail(email);
    if (existing) {
      if (existing.protected) return { id: existing.id, email: existing.email, role: ROLES.ADMIN };
      if (existing.role !== result.role) {
        try { await usersRepo.update(existing.id, { role: result.role }); } catch { /* best-effort */ }
      }
      return { id: existing.id, email: existing.email, role: result.role };
    }
    // Unusable random password — LDAP is this user's auth path, not local login.
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
    try {
      return await usersRepo.create({ email, passwordHash, role: result.role });
    } catch {
      // Lost a create race (unique email) — re-read the now-existing row.
      const again = await usersRepo.findByEmail(email);
      if (again) return { id: again.id, email: again.email, role: again.protected ? ROLES.ADMIN : result.role };
      throw new Error('could not provision LDAP user');
    }
  }

  // POST /auth/login { email, password } -> { token, ... } or 401.
  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      // `email` is the login identifier; for LDAP it may be a username/UPN, so we
      // keep the original (only lower-cased) for the directory search.
      const identifier = typeof body.email === 'string' ? body.email.trim() : '';
      const email = identifier.toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';

      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
      }

      // 0) Brute-force lockout (security pack). If this user or source IP is
      //    currently locked, refuse with 429 BEFORE touching any auth backend —
      //    a distinct code so the audit log can tell lockouts from bad passwords.
      if (securityService) {
        const lock = await securityService.checkLockout({ email, ip: req.ip });
        if (lock.locked) {
          res.set('Retry-After', String(lock.retryAfterSeconds));
          await auditLogin(req, { action: 'login_locked', outcome: 'denied', email, detail: `locked scope=${lock.scope}, retryAfter=${lock.retryAfterSeconds}s` });
          return res.status(429).json({ error: 'Too many failed login attempts — try again later', retryAfter: lock.retryAfterSeconds });
        }
      }

      // 1) LDAP first, if enabled. On success issue the same JWT; on any miss,
      //    fall through to local auth (per spec: fall back when LDAP fails/disabled).
      if (ldapAuth && typeof ldapAuth.isEnabled === 'function') {
        let enabled = false;
        try { enabled = await ldapAuth.isEnabled(); } catch { enabled = false; }
        if (enabled) {
          let result = { enabled: true, ok: false, reason: 'bind-failed', matched: 0 };
          try { result = await ldapAuth.authenticate(identifier, password); } catch { result = { enabled: true, ok: false, reason: 'bind-failed', matched: 0 }; }
          if (result && result.enabled) await auditLdap(identifier, result, req.ip);
          if (result && result.ok) {
            const user = await provisionLdapUser(result);
            if (!(await passSecurityChecks(req, res, user, 'ldap'))) return;
            const token = issueToken(user);
            await auditLogin(req, { action: 'login_success', outcome: 'success', email: user.email, role: user.role, userId: user.id, detail: 'auth=ldap' });
            return res.json({
              token,
              tokenType: 'Bearer',
              expiresIn: config.auth.jwtExpiresIn,
              user: { id: user.id, email: user.email, role: user.role },
              auth: 'ldap',
            });
          }
        }
      }

      // 2) Local JWT auth (original flow + the LDAP fallback).
      const user = await usersRepo.findByEmailWithHash(email);
      const hash = user ? user.password_hash : await getDummyHash();
      const passwordOk = await verifyPassword(password, hash);

      if (!user || !passwordOk) {
        // Count this failure toward the per-user + per-IP lockout (security pack).
        if (securityService) { try { await securityService.recordFailure({ email, ip: req.ip }); } catch { /* best-effort */ } }
        await auditLogin(req, { action: 'login_failure', outcome: 'failure', email: email || '(none)', detail: 'invalid credentials' });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (!(await passSecurityChecks(req, res, user, 'local'))) return;

      const token = issueToken(user);
      // Password max-age (security pack): surface expiry so the client can prompt
      // a change. Non-blocking — the user can still sign in to change it.
      let passwordExpired = false;
      if (securityService) { try { passwordExpired = await securityService.isPasswordExpired(user.password_changed_at); } catch { passwordExpired = false; } }
      await auditLogin(req, { action: 'login_success', outcome: 'success', email: user.email, role: user.role, userId: user.id, detail: `auth=local${passwordExpired ? ', password expired' : ''}` });
      return res.json({
        token,
        tokenType: 'Bearer',
        expiresIn: config.auth.jwtExpiresIn,
        user: { id: user.id, email: user.email, role: user.role },
        passwordExpired,
      });
    })
  );

  return router;
}

module.exports = { createAuthRouter };
