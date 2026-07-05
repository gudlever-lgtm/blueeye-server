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
const { validateRoleMap } = require('../validation/samlValidation');
const { config } = require('../config');

// Short-lived signed cookie carrying the AuthnRequest ID between /login and the
// ACS, so the response's InResponseTo can be bound to a request we issued.
const TX_COOKIE = 'blueeye_saml_tx';
const TX_TTL_SECONDS = 600;

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    // A foreign cookie on the same host can carry a bare '%' — a URIError
    // here must not break the SSO callback; keep the raw value instead.
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

function isHttps(req) {
  return Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function successRedirect(user, token) {
  const frag = new URLSearchParams({ sso_token: token, role: user.role, email: user.email });
  return `/#${frag.toString()}`;
}
function failureRedirect(reason) {
  return `/?sso_error=${encodeURIComponent(reason || 'failed')}`;
}

// PUBLIC SAML routes mounted at /auth/saml:
//   GET  /auth/saml/login    → 302 to the IdP with a DEFLATE'd AuthnRequest
//   POST /auth/saml/callback → verify the signed assertion → JIT user → JWT (ACS)
//   GET  /auth/saml/metadata → SP metadata XML for the IdP admin
// Local login (POST /auth/login) is untouched and remains the fallback.
function createSamlAuthRouter({ usersRepo, samlAuth, ssoLoginAuditRepo = null, auditLogger = null }) {
  const router = express.Router();
  const provisioner = createUserProvisioner({ usersRepo });

  async function auditSso(req, { ok, reason, subject = null, role = null, matched = 0 }) {
    if (ssoLoginAuditRepo && typeof ssoLoginAuditRepo.record === 'function') {
      try { await ssoLoginAuditRepo.record({ provider: 'saml', subject, ok, reason, grantedRole: ok ? role : null, groupsMatched: matched || 0, sourceIp: req.ip }); } catch { /* best-effort */ }
    }
    if (auditLogger) {
      try {
        await auditLogger.record(req, {
          category: 'auth', action: ok ? 'login_success' : 'login_failure', outcome: ok ? 'success' : 'failure',
          actorEmail: subject, actorRole: role, target: subject, detail: `auth=saml${ok ? '' : ` reason=${reason}`}`,
        });
      } catch { /* best-effort */ }
    }
  }

  router.get('/login', asyncHandler(async (req, res) => {
    if (!samlAuth || !samlAuth.isEnabled()) return res.redirect(failureRedirect('saml-disabled'));
    let reqInfo;
    try { reqInfo = await samlAuth.buildLoginRequest(); } catch { return res.redirect(failureRedirect('saml-error')); }
    const tx = jwt.sign({ rid: reqInfo.requestId }, config.auth.jwtSecret, { expiresIn: TX_TTL_SECONDS });
    res.cookie(TX_COOKIE, tx, { httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/auth/saml', maxAge: TX_TTL_SECONDS * 1000 });
    return res.redirect(reqInfo.url);
  }));

  // ACS — the IdP POSTs SAMLResponse here (HTTP-POST binding, form-encoded). The
  // app uses express.json() globally, so parse url-encoded bodies just here.
  router.post('/callback', express.urlencoded({ extended: false, limit: '2mb' }), asyncHandler(async (req, res) => {
    const clear = () => res.clearCookie(TX_COOKIE, { path: '/auth/saml' });
    if (!samlAuth || !samlAuth.isEnabled()) { clear(); return res.redirect(failureRedirect('saml-disabled')); }

    let requestId = null;
    try { const tx = jwt.verify(parseCookies(req)[TX_COOKIE] || '', config.auth.jwtSecret); requestId = tx && tx.rid; } catch { requestId = null; }
    clear();

    const samlResponse = req.body && typeof req.body.SAMLResponse === 'string' ? req.body.SAMLResponse : '';
    const result = await samlAuth.handleResponse(samlResponse, { requestId });
    if (!result || !result.ok) {
      await auditSso(req, { ok: false, reason: (result && result.reason) || 'failed' });
      return res.redirect(failureRedirect((result && result.reason) || 'failed'));
    }

    const user = await provisioner.provision({ email: result.email, role: result.role });
    const token = issueToken(user);
    await auditSso(req, { ok: true, reason: 'ok', subject: result.subject || user.email, role: user.role, matched: result.matched });
    return res.redirect(successRedirect(user, token));
  }));

  router.get('/metadata', asyncHandler(async (req, res) => {
    if (!samlAuth || typeof samlAuth.metadata !== 'function') return res.status(404).end();
    res.type('application/xml').send(samlAuth.metadata());
  }));

  return router;
}

// ADMIN SAML config API mounted at /api/saml — read-only status + the
// attribute→role map CRUD. Admin-only; mutations are licence-gated (sso_saml).
// The IdP connection itself is env-configured (no secrets stored or returned).
function createSamlAdminRouter({ samlAuth, samlRoleMapRepo, ssoLoginAuditRepo = null, featureGate = null }) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  const gate = featureGate ? requireFeature(featureGate, 'sso_saml') : (req, res, next) => next();

  router.get('/config', asyncHandler(async (req, res) => {
    res.json(samlAuth ? samlAuth.status() : { authEnabledFlag: false, licensed: false, configured: false, enabled: false });
  }));

  router.get('/role-map', asyncHandler(async (req, res) => {
    res.json(await samlRoleMapRepo.findAll());
  }));

  router.post('/role-map', gate, asyncHandler(async (req, res) => {
    const { value, errors } = validateRoleMap(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    if (await samlRoleMapRepo.findByClaim(value.claimValue)) {
      return res.status(409).json({ error: 'Attribute value already mapped' });
    }
    const created = await samlRoleMapRepo.create(value);
    res.status(201).json(created);
  }));

  router.put('/role-map/:id', gate, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const { value, errors } = validateRoleMap(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const existing = await samlRoleMapRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Role mapping not found' });
    const dup = await samlRoleMapRepo.findByClaim(value.claimValue);
    if (dup && dup.id !== id) return res.status(409).json({ error: 'Attribute value already mapped' });
    res.json(await samlRoleMapRepo.update(id, value));
  }));

  router.delete('/role-map/:id', gate, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid id' });
    const removed = await samlRoleMapRepo.remove(id);
    if (!removed) return res.status(404).json({ error: 'Role mapping not found' });
    res.status(204).end();
  }));

  router.get('/login-audit', asyncHandler(async (req, res) => {
    if (!ssoLoginAuditRepo || typeof ssoLoginAuditRepo.findAll !== 'function') return res.json([]);
    const raw = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    res.json(await ssoLoginAuditRepo.findAll({ provider: 'saml', limit }));
  }));

  return router;
}

module.exports = { createSamlAuthRouter, createSamlAdminRouter };
