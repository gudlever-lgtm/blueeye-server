'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { requireFeature } = require('../license/features');
const { ROLES } = require('../auth/roles');
const { issueToken } = require('../auth/jwt');
const { createUserProvisioner } = require('../auth/provision');
const { parseId } = require('../validation/locationValidation');
const { validateRoleMap } = require('../validation/oidcValidation');
const { config } = require('../config');

// Name of the short-lived cookie that carries the per-login state/nonce/PKCE
// verifier between /login and /callback. Signed as a JWT with the JWT secret, so
// it is tamper-proof and self-expiring (the browser, not the server, holds it —
// the auth service stays stateless).
const TX_COOKIE = 'blueeye_oidc_tx';
const TX_TTL_SECONDS = 600; // 10 minutes to complete the round-trip

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isHttps(req) {
  return Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Where to bounce the browser after a callback. The token rides in the URL
// FRAGMENT (never sent to a server, never written to access logs) so the SPA can
// pick it up on load. A failure carries a stable, non-sensitive reason code.
function successRedirect(user, token) {
  const frag = new URLSearchParams({ sso_token: token, role: user.role, email: user.email });
  return `/#${frag.toString()}`;
}
function failureRedirect(reason) {
  return `/?sso_error=${encodeURIComponent(reason || 'failed')}`;
}

// PUBLIC OIDC routes mounted at /auth/oidc — the browser-facing SSO flow:
//   GET /auth/oidc/login    → 302 to the IdP (sets the tx cookie)
//   GET /auth/oidc/callback → exchange + verify + JIT-provision + issue JWT
// Local login (POST /auth/login) is untouched and remains the fallback.
function createOidcAuthRouter({ usersRepo, oidcAuth, ssoLoginAuditRepo = null, auditLogger = null }) {
  const router = express.Router();
  const provisioner = createUserProvisioner({ usersRepo });

  async function auditSso(req, { ok, reason, subject = null, role = null, matched = 0 }) {
    if (ssoLoginAuditRepo && typeof ssoLoginAuditRepo.record === 'function') {
      try {
        await ssoLoginAuditRepo.record({ provider: 'oidc', subject, ok, reason, grantedRole: ok ? role : null, groupsMatched: matched || 0, sourceIp: req.ip });
      } catch { /* best-effort */ }
    }
    if (auditLogger) {
      try {
        await auditLogger.record(req, {
          category: 'auth', action: ok ? 'login_success' : 'login_failure', outcome: ok ? 'success' : 'failure',
          actorEmail: subject, actorRole: role, target: subject, detail: `auth=oidc${ok ? '' : ` reason=${reason}`}`,
        });
      } catch { /* best-effort */ }
    }
  }

  router.get('/login', asyncHandler(async (req, res) => {
    if (!oidcAuth || !oidcAuth.isEnabled()) return res.redirect(failureRedirect('oidc-disabled'));
    let reqInfo;
    try { reqInfo = await oidcAuth.createLoginRequest(); } catch { return res.redirect(failureRedirect('discovery-failed')); }
    const tx = jwt.sign(
      { state: reqInfo.state, nonce: reqInfo.nonce, cv: reqInfo.codeVerifier },
      config.auth.jwtSecret, { expiresIn: TX_TTL_SECONDS }
    );
    res.cookie(TX_COOKIE, tx, { httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/auth/oidc', maxAge: TX_TTL_SECONDS * 1000 });
    return res.redirect(reqInfo.url);
  }));

  router.get('/callback', asyncHandler(async (req, res) => {
    const clear = () => res.clearCookie(TX_COOKIE, { path: '/auth/oidc' });
    if (!oidcAuth || !oidcAuth.isEnabled()) { clear(); return res.redirect(failureRedirect('oidc-disabled')); }

    if (req.query.error) { clear(); await auditSso(req, { ok: false, reason: 'idp-error' }); return res.redirect(failureRedirect('idp-error')); }

    const cookies = parseCookies(req);
    let txData = null;
    try { txData = jwt.verify(cookies[TX_COOKIE] || '', config.auth.jwtSecret); } catch { txData = null; }
    clear();
    if (!txData) { await auditSso(req, { ok: false, reason: 'invalid-state' }); return res.redirect(failureRedirect('invalid-state')); }

    const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
    if (!returnedState || returnedState !== txData.state) {
      await auditSso(req, { ok: false, reason: 'invalid-state' });
      return res.redirect(failureRedirect('invalid-state'));
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const result = await oidcAuth.handleCallback({ code, codeVerifier: txData.cv, nonce: txData.nonce });
    if (!result || !result.ok) {
      await auditSso(req, { ok: false, reason: (result && result.reason) || 'failed', subject: result && result.subject });
      return res.redirect(failureRedirect((result && result.reason) || 'failed'));
    }

    const user = await provisioner.provision({ email: result.email, role: result.role });
    const token = issueToken(user);
    await auditSso(req, { ok: true, reason: 'ok', subject: result.subject || user.email, role: user.role, matched: result.matched });
    return res.redirect(successRedirect(user, token));
  }));

  return router;
}

// ADMIN OIDC config API mounted at /api/oidc — read-only status + the group→role
// map CRUD + a discovery connectivity test. Admin-only; mutations + the test are
// licence-gated (sso_oidc). The IdP connection itself is env-configured (no
// secrets are stored or returned here).
function createOidcAdminRouter({ oidcAuth, oidcRoleMapRepo, ssoLoginAuditRepo = null, featureGate = null }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  const gate = featureGate ? requireFeature(featureGate, 'sso_oidc') : (req, res, next) => next();

  // GET /api/oidc/config — env + licence + (non-secret) issuer/client/redirect.
  router.get('/config', asyncHandler(async (req, res) => {
    res.json(oidcAuth ? oidcAuth.status() : { authEnabledFlag: false, licensed: false, configured: false, enabled: false });
  }));

  router.get('/role-map', asyncHandler(async (req, res) => {
    res.json(await oidcRoleMapRepo.findAll());
  }));

  router.post('/role-map', gate, asyncHandler(async (req, res) => {
    const { value, errors } = validateRoleMap(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    if (await oidcRoleMapRepo.findByClaim(value.claimValue)) {
      return res.status(409).json({ error: 'Claim value already mapped' });
    }
    const created = await oidcRoleMapRepo.create(value);
    res.status(201).json(created);
  }));

  router.put('/role-map/:id', gate, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const { value, errors } = validateRoleMap(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const existing = await oidcRoleMapRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Role mapping not found' });
    const dup = await oidcRoleMapRepo.findByClaim(value.claimValue);
    if (dup && dup.id !== id) return res.status(409).json({ error: 'Claim value already mapped' });
    res.json(await oidcRoleMapRepo.update(id, value));
  }));

  router.delete('/role-map/:id', gate, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const removed = await oidcRoleMapRepo.remove(id);
    if (!removed) return res.status(404).json({ error: 'Role mapping not found' });
    res.status(204).end();
  }));

  router.get('/login-audit', asyncHandler(async (req, res) => {
    if (!ssoLoginAuditRepo || typeof ssoLoginAuditRepo.findAll !== 'function') return res.json([]);
    const raw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    res.json(await ssoLoginAuditRepo.findAll({ provider: 'oidc', limit }));
  }));

  router.post('/test', gate, asyncHandler(async (req, res) => {
    if (!oidcAuth || typeof oidcAuth.testDiscovery !== 'function') {
      return res.status(503).json({ error: 'OIDC auth not available' });
    }
    res.json(await oidcAuth.testDiscovery());
  }));

  return router;
}

module.exports = { createOidcAuthRouter, createOidcAdminRouter };
