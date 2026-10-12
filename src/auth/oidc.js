'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const silentLogger = { info() {}, warn() {}, error() {} };

// Role precedence for "highest matching role wins" (mirrors the LDAP service).
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

// Signature algorithms we accept on an id_token. RS*/PS* (RSA) and ES* (EC) are
// the families every EU/self-hosted IdP (Keycloak, Authentik, Zitadel) uses;
// `none` and HMAC (`HS*`) are deliberately excluded — a public JWKS can't carry
// a shared HMAC secret, so allowing HS* would invite an algorithm-confusion attack.
const ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

// PKCE (RFC 7636, S256): a high-entropy verifier + its SHA-256 challenge. The
// verifier never leaves this server until the token exchange, so an intercepted
// authorization code is useless without it.
function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// OpenID Connect authentication service — authorization-code flow with PKCE.
// HAND-ROLLED (no US SDK): discovery + token exchange use injected `fetch`, and
// id_token verification uses Node crypto (JWK→KeyObject) + `jsonwebtoken`. The
// service is stateless; the route carries the per-login state/nonce/verifier in a
// short-lived signed cookie. Flow:
//   1) createLoginRequest() -> { url, state, nonce, codeVerifier }
//   2) (browser visits the IdP, comes back with ?code&state)
//   3) handleCallback({ code, codeVerifier, nonce }) -> { ok, email, role, ... }
function createOidcAuth({
  config = {},
  oidcRoleMapRepo,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
  featureGate = null,
  logger = silentLogger,
} = {}) {
  const authEnabledFlag = Boolean(config.authEnabled);

  // Whether the licence includes OIDC SSO. Fail-OPEN when no gate is injected
  // (tests / plan-less installs keep working); fail-CLOSED — OIDC disabled,
  // local login remains — once a gate says no.
  function licensed() {
    if (!featureGate || typeof featureGate.isFeatureEnabled !== 'function') return true;
    return featureGate.isFeatureEnabled('sso_oidc') === true;
  }

  // True only when the env flag is on, the licence covers it AND the issuer +
  // client id + redirect are configured (the secret is optional — a public PKCE
  // client needs none).
  function isConfigured() {
    return Boolean(config.issuer && config.clientId && config.redirectUri);
  }
  function isEnabled() {
    return authEnabledFlag && licensed() && isConfigured();
  }

  // All OIDC endpoints (discovery, token, JWKS) live behind an env-configured
  // issuer but are still remote: a stalled IdP must not hang the public
  // /auth/oidc/login and /callback routes and pile up sockets. Bound every call
  // with an AbortController timeout, mirroring the assistant/geocode/integration
  // callers. Best-effort: if the injected fetch ignores `signal` (some test
  // fakes), the await simply resolves normally.
  const FETCH_TIMEOUT_MS = 10000;
  async function fetchJson(url, opts = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
    if (timer && typeof timer.unref === 'function') timer.unref();
    let res;
    try {
      res = await fetchImpl(url, controller ? { ...opts, signal: controller.signal } : opts);
    } catch (err) {
      throw new Error(`request to ${url} failed (${err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'network error'})`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || !res.ok) {
      const status = res ? res.status : 'no-response';
      throw new Error(`request to ${url} failed (${status})`);
    }
    return res.json();
  }

  // Cached OpenID provider metadata (.well-known/openid-configuration). Cached
  // per issuer for the process lifetime; IdP endpoints are effectively static.
  let discoveryCache = null;
  async function discover() {
    if (discoveryCache && discoveryCache.issuer === config.issuer) return discoveryCache.doc;
    const url = `${config.issuer}/.well-known/openid-configuration`;
    const doc = await fetchJson(url);
    if (!doc || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new Error('discovery document is missing required endpoints');
    }
    discoveryCache = { issuer: config.issuer, doc };
    return doc;
  }

  // Builds the IdP authorization URL for the redirect.
  function buildAuthUrl(doc, { state, nonce, codeChallenge }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes || 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const sep = doc.authorization_endpoint.includes('?') ? '&' : '?';
    return `${doc.authorization_endpoint}${sep}${params.toString()}`;
  }

  // Step 1: mint the per-login secrets + the redirect URL. The caller persists
  // { state, nonce, codeVerifier } (signed cookie) and 302s the browser to `url`.
  async function createLoginRequest() {
    const doc = await discover();
    const state = base64url(crypto.randomBytes(16));
    const nonce = base64url(crypto.randomBytes(16));
    const { verifier, challenge } = generatePkce();
    const url = buildAuthUrl(doc, { state, nonce, codeChallenge: challenge });
    return { url, state, nonce, codeVerifier: verifier };
  }

  // Exchanges the authorization code for tokens (confidential client → secret in
  // the body via client_secret_post; public client → PKCE proof only).
  async function exchangeCode({ code, codeVerifier }, doc) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    });
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
    return fetchJson(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  }

  // Verifies an id_token: fetches the JWKS, picks the signing key by `kid`,
  // imports it (JWK→KeyObject — no PEM conversion library needed) and lets
  // jsonwebtoken check the signature, audience and issuer with the algorithm
  // pinned to the asymmetric set. The nonce is matched here (jsonwebtoken has no
  // nonce option) to bind the token to THIS login.
  async function verifyIdToken(idToken, { nonce }, doc) {
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || !decoded.header) throw new Error('malformed id_token');
    const alg = decoded.header.alg;
    if (!ALLOWED_ALGS.includes(alg)) throw new Error(`unsupported id_token alg: ${alg}`);

    const jwks = await fetchJson(doc.jwks_uri);
    const keys = Array.isArray(jwks && jwks.keys) ? jwks.keys : [];
    const kid = decoded.header.kid;
    const jwk = (kid && keys.find((k) => k.kid === kid)) || (keys.length === 1 ? keys[0] : null);
    if (!jwk) throw new Error('no matching JWKS key for id_token');

    const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const claims = jwt.verify(idToken, keyObject, {
      algorithms: [alg],
      audience: config.clientId,
      issuer: doc.issuer || config.issuer,
    });
    if (nonce && claims.nonce !== nonce) throw new Error('id_token nonce mismatch');
    return claims;
  }

  // Reads the group/role values out of the claims. Accepts either an array claim
  // (the common case) or a single string.
  function claimGroups(claims) {
    const raw = claims[config.roleClaim || 'groups'];
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string' && raw) return [raw];
    return [];
  }

  // Maps the claim values to the HIGHEST BlueEye role via oidc_role_map. Returns
  // { role, matched } (matched = how many values mapped); role is null when none do.
  async function resolveRole(groups) {
    let maps = [];
    try { maps = await oidcRoleMapRepo.findAll(); } catch { maps = []; }
    const wanted = new Map(maps.map((m) => [String(m.claim_value).toLowerCase(), m.blueeye_role]));
    let role = null;
    let matched = 0;
    for (const g of groups) {
      const r = wanted.get(String(g).toLowerCase());
      if (!r) continue;
      matched += 1;
      if (!role || ROLE_RANK[r] > ROLE_RANK[role]) role = r;
    }
    return { role, matched };
  }

  // Step 3: complete the callback. Return shapes:
  //   { ok:true, email, role, subject, groups, matched, claims }
  //   { ok:false, reason }  reason in:
  //     'disabled' | 'invalid-input' | 'discovery-failed' | 'token-failed' |
  //     'invalid-token' | 'no-role'
  async function handleCallback({ code, codeVerifier, nonce }) {
    if (!isEnabled()) return { ok: false, reason: 'disabled' };
    if (typeof code !== 'string' || !code || typeof codeVerifier !== 'string' || !codeVerifier) {
      return { ok: false, reason: 'invalid-input' };
    }

    let doc;
    try { doc = await discover(); } catch (err) { logger.warn(`oidc: discovery failed (${err.message})`); return { ok: false, reason: 'discovery-failed' }; }

    let tokens;
    try { tokens = await exchangeCode({ code, codeVerifier }, doc); } catch (err) { logger.warn(`oidc: token exchange failed (${err.message})`); return { ok: false, reason: 'token-failed' }; }
    if (!tokens || !tokens.id_token) return { ok: false, reason: 'token-failed' };

    let claims;
    try { claims = await verifyIdToken(tokens.id_token, { nonce }, doc); } catch (err) { logger.warn(`oidc: id_token verification failed (${err.message})`); return { ok: false, reason: 'invalid-token' }; }

    const { role, matched } = await resolveRole(claimGroups(claims));
    if (!role) return { ok: false, reason: 'no-role' };

    // An id_token that carries an UNVERIFIED email is refused rather than
    // trusted: provision() finds/creates (and role-realigns) the local user by
    // email, so an IdP that lets a user set an arbitrary, unverified email would
    // otherwise allow binding to — and taking over — another user's account
    // (e.g. a low-privilege user setting their email to an admin's address).
    // Requiring email_verified before the email claim is used closes that. When
    // the IdP asserts no email at all (email scope not configured), the stable,
    // non-user-settable `sub` is used instead — unchanged.
    const hasEmail = typeof claims.email === 'string' && !!claims.email;
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    if (hasEmail && !emailVerified) {
      logger.warn('oidc: refusing login — email claim present but email_verified is not true');
      return { ok: false, reason: 'email-unverified' };
    }
    const email = hasEmail
      ? claims.email.toLowerCase()
      : (typeof claims.preferred_username === 'string' && claims.preferred_username
        ? claims.preferred_username.toLowerCase()
        : String(claims.sub || '').toLowerCase());
    if (!email) return { ok: false, reason: 'invalid-token' };

    return { ok: true, email, role, subject: String(claims.sub || ''), groups: claimGroups(claims), matched, claims };
  }

  // Connectivity check for the admin UI: confirm the issuer's discovery document
  // is reachable + well-formed. Returns { ok, detail }.
  async function testDiscovery() {
    if (!isConfigured()) return { ok: false, detail: 'OIDC issuer/client/redirect not configured' };
    try {
      const doc = await discover();
      return { ok: true, detail: `discovered ${doc.issuer || config.issuer}` };
    } catch (err) {
      return { ok: false, detail: `discovery failed: ${err.message}` };
    }
  }

  // Public, non-secret view for the admin config page + the login screen.
  function status() {
    return {
      authEnabledFlag,
      licensed: licensed(),
      configured: isConfigured(),
      enabled: isEnabled(),
      issuer: config.issuer || '',
      clientId: config.clientId || '',
      redirectUri: config.redirectUri || '',
      scopes: config.scopes || '',
      roleClaim: config.roleClaim || 'groups',
      clientSecretSet: Boolean(config.clientSecret),
    };
  }

  return { isEnabled, isConfigured, licensed, createLoginRequest, handleCallback, resolveRole, testDiscovery, status };
}

module.exports = { createOidcAuth, generatePkce, ROLE_RANK, ALLOWED_ALGS };
