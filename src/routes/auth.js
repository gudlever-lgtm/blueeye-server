'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { verifyPassword, hashPassword } = require('../auth/password');
const { issueToken } = require('../auth/jwt');
const { ROLES } = require('../auth/roles');
const { config } = require('../config');
const { noopRateLimiter } = require('../middleware/rateLimit');

// Authentication routes (public). Supports two paths behind the SAME endpoint:
//   1) external LDAP/AD auth (when enabled) — tried first; on success a local
//      user is just-in-time provisioned so the rest of the system is unchanged;
//   2) local JWT auth — the original flow, and the fallback when LDAP is
//      disabled or doesn't authenticate the user.
function createAuthRouter({ usersRepo, ldapAuth = null, ldapLoginAuditRepo = null, auditLogger = null, rateLimit = noopRateLimiter }) {
  const router = express.Router();

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
    rateLimit,
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
        await auditLogin(req, { action: 'login_failure', outcome: 'failure', email: email || '(none)', detail: 'invalid credentials' });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = issueToken(user);
      await auditLogin(req, { action: 'login_success', outcome: 'success', email: user.email, role: user.role, userId: user.id, detail: 'auth=local' });
      return res.json({
        token,
        tokenType: 'Bearer',
        expiresIn: config.auth.jwtExpiresIn,
        user: { id: user.id, email: user.email, role: user.role },
      });
    })
  );

  return router;
}

module.exports = { createAuthRouter };
