'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const samlXml = require('./samlXml');

const silentLogger = { info() {}, warn() {}, error() {} };
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
const CLOCK_SKEW_MS = 5 * 60 * 1000; // tolerate 5 minutes of IdP/SP clock drift

// SAML 2.0 SP-initiated SSO service. Supplements local login behind the licence
// feature `sso_saml` (Professional+). The AuthnRequest goes out over HTTP-Redirect;
// the IdP POSTs the SAMLResponse back to the ACS. The assertion is verified with
// the HAND-ROLLED, dependency-free XML-DSig verifier (src/auth/samlXml.js) — no
// US SDK. We validate, in order: signature → referenced element is the Assertion
// → Issuer → Conditions (NotBefore/NotOnOrAfter) → AudienceRestriction → Subject
// confirmation expiry. Attributes map to the highest BlueEye role; no match = deny.
function createSamlAuth({
  config = {},
  samlRoleMapRepo,
  featureGate = null,
  nowFn = () => Date.now(),
  logger = silentLogger,
} = {}) {
  const authEnabledFlag = Boolean(config.authEnabled);

  function licensed() {
    if (!featureGate || typeof featureGate.isFeatureEnabled !== 'function') return true;
    return featureGate.isFeatureEnabled('sso_saml') === true;
  }
  function isConfigured() {
    return Boolean(config.entryPoint && config.spEntityId && config.idpCert);
  }
  function isEnabled() {
    return authEnabledFlag && licensed() && isConfigured();
  }

  function audience() { return config.audience || config.spEntityId; }

  // Builds the SP-initiated AuthnRequest and the HTTP-Redirect URL (DEFLATE +
  // base64 + url-encode, per the SAML Redirect binding). Returns { url, requestId }.
  function buildLoginRequest({ relayState = '' } = {}) {
    const requestId = `_${crypto.randomBytes(16).toString('hex')}`;
    const issueInstant = new Date(nowFn()).toISOString();
    const acs = config.callbackUrl || '';
    const xml =
      '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"' +
      ' xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"' +
      ` ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}"` +
      ' ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"' +
      `${acs ? ` AssertionConsumerServiceURL="${samlXml.escapeAttr(acs)}"` : ''}>` +
      `<saml:Issuer>${samlXml.escapeText(config.spEntityId)}</saml:Issuer>` +
      '<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>' +
      '</samlp:AuthnRequest>';

    const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
    const params = new URLSearchParams({ SAMLRequest: deflated });
    if (relayState) params.set('RelayState', relayState);
    const sep = config.entryPoint.includes('?') ? '&' : '?';
    return { url: `${config.entryPoint}${sep}${params.toString()}`, requestId };
  }

  function parseDate(s) {
    const t = Date.parse(String(s || ''));
    return Number.isNaN(t) ? null : t;
  }

  // Maps SAML attribute values to the HIGHEST BlueEye role via saml_role_map.
  async function resolveRole(values) {
    let maps = [];
    try { maps = await samlRoleMapRepo.findAll(); } catch { maps = []; }
    const wanted = new Map(maps.map((m) => [String(m.claim_value).toLowerCase(), m.blueeye_role]));
    let role = null;
    let matched = 0;
    for (const v of values) {
      const r = wanted.get(String(v).toLowerCase());
      if (!r) continue;
      matched += 1;
      if (!role || ROLE_RANK[r] > ROLE_RANK[role]) role = r;
    }
    return { role, matched };
  }

  // Pulls the configured role attribute's values out of the assertion.
  function roleValues(assertion) {
    const wanted = (config.roleAttribute || 'groups').toLowerCase();
    const out = [];
    for (const attr of samlXml.findAllByLocal(assertion, 'Attribute')) {
      const name = (samlXml.attrValue(attr, 'Name') || '').toLowerCase();
      const friendly = (samlXml.attrValue(attr, 'FriendlyName') || '').toLowerCase();
      if (name !== wanted && friendly !== wanted) continue;
      for (const val of samlXml.findAllByLocal(attr, 'AttributeValue')) out.push(samlXml.textOf(val).trim());
    }
    return out.filter(Boolean);
  }

  // One-time-use guard: assertion IDs we have already consumed, each mapped to
  // the ms after which the assertion is expired anyway (so the entry can be
  // dropped). A signed SAMLResponse is a bearer artifact valid for its whole
  // Conditions window; without this an attacker who captures one (proxy log,
  // browser history, a shared-workstation POST body, or an IdP-initiated flow
  // with no InResponseTo) could re-POST it to the ACS and mint a fresh session
  // for the victim. In-memory + per-process: it does not survive a restart and
  // is not shared across instances, but the assertion window is short (minutes),
  // so it closes the practical replay window. Bounded by that window — an
  // assertion that can no longer be replayed needs no entry.
  const seenAssertions = new Map(); // assertion ID -> expiry ms
  const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000; // used when the assertion names no window

  function sweepSeen(now) {
    for (const [id, exp] of seenAssertions) if (exp <= now) seenAssertions.delete(id);
  }
  // Latest NotOnOrAfter the assertion asserts (Conditions or any
  // SubjectConfirmationData), plus skew — after that it fails the window checks
  // regardless, so the replay entry can expire with it.
  function replayExpiry(assertion, now) {
    let latest = 0;
    const cond = samlXml.findFirstByLocal(assertion, 'Conditions');
    if (cond) { const t = parseDate(samlXml.attrValue(cond, 'NotOnOrAfter')); if (t) latest = Math.max(latest, t); }
    for (const scd of samlXml.findAllByLocal(assertion, 'SubjectConfirmationData')) {
      const t = parseDate(samlXml.attrValue(scd, 'NotOnOrAfter')); if (t) latest = Math.max(latest, t);
    }
    return (latest > 0 ? latest : now + DEFAULT_REPLAY_TTL_MS) + CLOCK_SKEW_MS;
  }

  // Handles the SAMLResponse from the ACS (base64, HTTP-POST binding). Return:
  //   { ok:true, email, role, subject, attributes, matched }
  //   { ok:false, reason }  reason in: 'disabled' | 'invalid-input' | 'parse-error' |
  //     'bad-signature' | 'not-assertion' | 'issuer-mismatch' | 'expired' |
  //     'not-yet-valid' | 'audience' | 'no-subject' | 'no-role' | 'no-assertion-id' |
  //     'replayed'
  async function handleResponse(samlResponseB64, { requestId = null } = {}) {
    if (!isEnabled()) return { ok: false, reason: 'disabled' };
    if (typeof samlResponseB64 !== 'string' || !samlResponseB64) return { ok: false, reason: 'invalid-input' };

    let root;
    try {
      const xml = Buffer.from(samlResponseB64, 'base64').toString('utf8');
      root = samlXml.parseXml(xml);
    } catch (err) { logger.warn(`saml: parse failed (${err.message})`); return { ok: false, reason: 'parse-error' }; }
    if (!root) return { ok: false, reason: 'parse-error' };

    // 1) Signature: only the element that was actually digested + signed is trusted.
    const v = samlXml.verifySignature(root, config.idpCert);
    if (!v.ok) { logger.warn(`saml: signature rejected (${v.reason})`); return { ok: false, reason: 'bad-signature' }; }

    const signed = samlXml.findById(root, v.signedId);
    let assertion = null;
    if (signed && signed.local === 'Assertion') assertion = signed;
    else if (signed && signed.local === 'Response') assertion = samlXml.findFirstByLocal(signed, 'Assertion');
    if (!assertion) return { ok: false, reason: 'not-assertion' };

    // 2) Issuer (enforced when an expected IdP entityID is configured). A MISSING
    //    <Issuer> is treated the same as a mismatch — a signed assertion that
    //    omits its issuer must not bypass the configured-IdP binding.
    if (config.idpEntityId) {
      const issuer = samlXml.textOf(samlXml.findFirstByLocal(assertion, 'Issuer')).trim();
      if (issuer !== config.idpEntityId) return { ok: false, reason: 'issuer-mismatch' };
    }

    const now = nowFn();

    // 3) Conditions window.
    const conditions = samlXml.findFirstByLocal(assertion, 'Conditions');
    if (conditions) {
      const notBefore = parseDate(samlXml.attrValue(conditions, 'NotBefore'));
      const notOnOrAfter = parseDate(samlXml.attrValue(conditions, 'NotOnOrAfter'));
      if (notBefore !== null && now + CLOCK_SKEW_MS < notBefore) return { ok: false, reason: 'not-yet-valid' };
      if (notOnOrAfter !== null && now - CLOCK_SKEW_MS >= notOnOrAfter) return { ok: false, reason: 'expired' };
    }

    // 4) AudienceRestriction must name our SP whenever an expected audience is
    //    configured. Enforced even if the assertion omits AudienceRestriction (or
    //    Conditions entirely): a signed assertion that never names this SP — e.g.
    //    one minted for a different SP, or not audience-restricted at all — must be
    //    rejected, not accepted just because the role attribute happens to map.
    const expectedAudience = audience();
    if (expectedAudience) {
      const audiences = samlXml.findAllByLocal(assertion, 'Audience').map((a) => samlXml.textOf(a).trim());
      if (!audiences.includes(expectedAudience)) return { ok: false, reason: 'audience' };
    }

    // 5) Subject confirmation expiry + (optional) InResponseTo binding.
    for (const scd of samlXml.findAllByLocal(assertion, 'SubjectConfirmationData')) {
      const exp = parseDate(samlXml.attrValue(scd, 'NotOnOrAfter'));
      if (exp !== null && now - CLOCK_SKEW_MS >= exp) return { ok: false, reason: 'expired' };
      const inResponseTo = samlXml.attrValue(scd, 'InResponseTo');
      if (requestId && inResponseTo && inResponseTo !== requestId) return { ok: false, reason: 'bad-signature' };
    }

    // 5b) One-time use: reject a replayed assertion. Only runs once the assertion
    //     is signature-valid and inside its window, so an unsigned/expired ID can
    //     never poison the cache. Checked-and-marked SYNCHRONOUSLY here (before the
    //     awaited role lookup below) so two concurrent replays cannot both pass.
    const assertionId = samlXml.attrValue(assertion, 'ID');
    if (!assertionId) return { ok: false, reason: 'no-assertion-id' };
    sweepSeen(now);
    if (seenAssertions.has(assertionId)) {
      logger.warn('saml: rejected replayed assertion (ID already consumed)');
      return { ok: false, reason: 'replayed' };
    }
    seenAssertions.set(assertionId, replayExpiry(assertion, now));

    // 6) Identity + role.
    const nameId = samlXml.findFirstByLocal(samlXml.findFirstByLocal(assertion, 'Subject') || assertion, 'NameID');
    const email = samlXml.textOf(nameId).trim().toLowerCase();
    if (!email) return { ok: false, reason: 'no-subject' };

    const values = roleValues(assertion);
    const { role, matched } = await resolveRole(values);
    if (!role) return { ok: false, reason: 'no-role' };

    return { ok: true, email, role, subject: email, attributes: values, matched };
  }

  // SP metadata (entityID + ACS), for handing to the IdP admin.
  function metadata() {
    const acs = config.callbackUrl || '';
    return '<?xml version="1.0"?>' +
      `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${samlXml.escapeAttr(config.spEntityId || '')}">` +
      '<SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">' +
      `<AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${samlXml.escapeAttr(acs)}" index="0"/>` +
      '</SPSSODescriptor></EntityDescriptor>';
  }

  function status() {
    return {
      authEnabledFlag,
      licensed: licensed(),
      configured: isConfigured(),
      enabled: isEnabled(),
      entryPoint: config.entryPoint || '',
      spEntityId: config.spEntityId || '',
      audience: audience() || '',
      idpEntityId: config.idpEntityId || '',
      callbackUrl: config.callbackUrl || '',
      roleAttribute: config.roleAttribute || 'groups',
      idpCertSet: Boolean(config.idpCert),
    };
  }

  return { isEnabled, isConfigured, licensed, buildLoginRequest, handleResponse, resolveRole, metadata, status };
}

module.exports = { createSamlAuth, ROLE_RANK };
