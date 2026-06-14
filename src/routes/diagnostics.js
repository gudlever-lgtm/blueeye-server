'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const screening = require('../diagnostics/screening');
const { reachUrl } = require('../diagnostics/reach');

// "Test area" — a consolidated security screening of every OUTBOUND integration
// the server talks to: email/alert channels, remote API receivers (ITSM/IPAM),
// SSO (LDAP/OIDC/SAML) and other outbound services (AI assistant, map/geocoder,
// licence server). Admin-only. It does two things per target:
//   1. a CONNECTIVITY test (reusing each subsystem's own test primitive — the
//      alerting dispatcher's channel test, the integrations dispatcher's
//      test-fire, ldapAuth.testConnection / oidcAuth.testDiscovery, and a generic
//      reachability probe for the rest), and
//   2. a SECURITY-POSTURE screen (src/diagnostics/screening.js — pure, explainable:
//      HTTPS vs plaintext, missing TLS, unsigned webhooks, plaintext LDAP, missing
//      secrets, licence state, …).
// Nothing here returns a secret: the catalogue is built only from already-safe
// (redacted) config + the connectors' own safe test results.

const GROUPS = {
  email: 'Email & alert channels',
  itsm: 'Remote API receivers (ITSM/IPAM)',
  auth: 'Authentication (SSO)',
  other: 'Other outbound services',
};
const GROUP_ORDER = [
  { key: 'email', label: GROUPS.email },
  { key: 'itsm', label: GROUPS.itsm },
  { key: 'auth', label: GROUPS.auth },
  { key: 'other', label: GROUPS.other },
];

function createDiagnosticsRouter({
  alertingDispatcher = null,
  integrationsRepo = null,
  integrationsDispatcher = null,
  ldapAuth = null,
  ldapConfigRepo = null,
  oidcAuth = null,
  samlAuth = null,
  assistant = null,
  settingsService = null,
  licenseManager = null,
  featureGate = null,
  fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
} = {}) {
  const router = express.Router();
  router.use(requireAuth, requireRole(ROLES.ADMIN));

  // Fail-OPEN when no gate is injected (tests / plan-less installs), matching the
  // auth services' own behaviour; only an explicit "false" locks an SSO target.
  const isLicensed = (feature) => !featureGate || typeof featureGate.isFeatureEnabled !== 'function'
    || featureGate.isFeatureEnabled(feature) === true;

  const assistantStatus = () => (assistant && typeof assistant.status === 'function' ? assistant.status() : null);

  async function safe(fn, fallback) {
    try { return await fn(); } catch { return fallback; }
  }

  // Gathers only SECRET-FREE config from every subsystem (no live network calls).
  async function gather() {
    const alerting = settingsService && typeof settingsService.getAlertingSafe === 'function'
      ? await safe(() => settingsService.getAlertingSafe(), {})
      : {};
    return {
      channels: (alerting && alerting.channels) || {},
      integrations: integrationsRepo ? await safe(() => integrationsRepo.findAll(), []) : [],
      ldap: ldapConfigRepo ? await safe(() => ldapConfigRepo.get(), null) : null,
      oidc: oidcAuth ? oidcAuth.status() : null,
      saml: samlAuth ? samlAuth.status() : null,
      assistant: assistantStatus(),
      map: settingsService && typeof settingsService.getMap === 'function' ? await safe(() => settingsService.getMap(), {}) : {},
      license: licenseManager && typeof licenseManager.getStatus === 'function' ? licenseManager.getStatus() : null,
    };
  }

  const alertRunnable = (channel) => Boolean(
    alertingDispatcher && typeof alertingDispatcher.channelNames === 'function'
    && alertingDispatcher.channelNames().includes(channel),
  );

  // Builds the full catalogue: id + category + entitlement + runnability around the
  // pure posture screen. No live connectivity tests are run here.
  async function buildCatalog() {
    const g = await gather();
    const out = [];
    const add = (id, category, runnable, licensed, screen) => out.push({
      id, category, group: GROUPS[category], runnable, licensed, ...screen,
    });

    // Email & alert channels.
    add('alert:email', 'email', alertRunnable('email'), true, screening.screenEmail(g.channels.email));
    add('alert:webhook', 'email', alertRunnable('webhook'), true, screening.screenWebhook(g.channels.webhook));
    add('alert:syslog', 'email', alertRunnable('syslog'), true, screening.screenSyslog(g.channels.syslog));

    // Remote API receivers (ITSM/IPAM).
    for (const row of g.integrations) {
      add(`integration:${row.id}`, 'itsm', true, true, screening.screenIntegration(row));
    }

    // Authentication (SSO).
    add('ldap', 'auth', Boolean(ldapAuth && (g.ldap && g.ldap.host)), isLicensed('sso_ldap'), screening.screenLdap(g.ldap || {}));
    add('oidc', 'auth', Boolean(oidcAuth && g.oidc && g.oidc.configured), isLicensed('sso_oidc'), screening.screenOidc(g.oidc || {}));
    add('saml', 'auth', Boolean(samlAuth && g.saml && g.saml.entryPoint), isLicensed('sso_saml'), screening.screenSaml(g.saml || {}));

    // Other outbound services. Only probe the assistant once it is actually set up
    // (an API key is present) or switched on — its base URL defaults to the provider
    // even when the feature is off, so probing unconditionally would emit outbound
    // traffic to a third party for a feature nobody enabled.
    add('assistant', 'other', Boolean(g.assistant && g.assistant.baseUrl && (g.assistant.configured || g.assistant.enabled)), true, screening.screenAssistant(g.assistant || {}));
    add('map', 'other', false, true, screening.screenMap(g.map || {}));
    add('license', 'other', false, true, screening.screenLicense(g.license || {}));

    return out;
  }

  // Runs ONE target's live connectivity test, reusing each subsystem's primitive.
  // Returns { ran, ok, severity, detail } — severity is the worse of the live
  // result and the configuration's posture, so a reachable-but-insecure target
  // (e.g. plaintext HTTP) is still flagged.
  async function connect(target, actor) {
    const id = target.id;
    if (target.licensed === false) {
      return { ran: false, skipped: true, ok: null, detail: 'Not included in the current licence.' };
    }
    if (!target.runnable) {
      return { ran: false, ok: null, detail: 'No live connectivity test — configuration screened only.' };
    }

    if (id.startsWith('alert:')) {
      const channel = id.slice('alert:'.length);
      const r = await alertingDispatcher.test(channel);
      if (r === null) return { ran: true, ok: false, detail: 'channel not available' };
      return { ran: true, ok: Boolean(r.ok), detail: r.detail || (r.ok ? 'sent' : 'failed') };
    }
    if (id.startsWith('integration:')) {
      const intId = Number(id.slice('integration:'.length));
      if (!integrationsDispatcher || typeof integrationsDispatcher.testFire !== 'function') {
        return { ran: false, ok: null, detail: 'Integration dispatcher not available.' };
      }
      const r = await integrationsDispatcher.testFire(intId, actor);
      if (r === null) return { ran: true, ok: false, detail: 'integration not found' };
      const status = r.status != null ? ` (HTTP ${r.status})` : '';
      return { ran: true, ok: Boolean(r.ok), detail: `${r.detail || (r.ok ? 'ok' : 'failed')}${status}` };
    }
    if (id === 'ldap') {
      const r = await ldapAuth.testConnection();
      return { ran: true, ok: Boolean(r.ok), detail: r.detail || (r.ok ? 'bound' : 'failed') };
    }
    if (id === 'oidc') {
      const r = await oidcAuth.testDiscovery();
      return { ran: true, ok: Boolean(r.ok), detail: r.detail || (r.ok ? 'discovered' : 'failed') };
    }
    if (id === 'saml') {
      const r = await reachUrl(fetchImpl, samlAuth.status().entryPoint);
      return { ran: true, ok: Boolean(r.ok), detail: r.detail };
    }
    if (id === 'assistant') {
      const st = assistantStatus() || {};
      const r = await reachUrl(fetchImpl, st.baseUrl);
      return { ran: true, ok: Boolean(r.ok), detail: r.detail };
    }
    return { ran: false, ok: null, detail: 'Unknown target.' };
  }

  async function runTarget(target, actor) {
    const startedAt = Date.now();
    let conn;
    try {
      conn = await connect(target, actor);
    } catch (err) {
      conn = { ran: true, ok: false, detail: `error: ${err.message}` };
    }
    // Connectivity severity, then merge with the posture so an insecure-but-up
    // target never reads as fully "ok".
    let connSev = 'info';
    if (conn.ran) connSev = conn.ok ? 'ok' : 'bad';
    else if (conn.skipped) connSev = 'info';
    else connSev = target.posture; // not runnable → posture is the verdict
    const severity = screening.worse(connSev, target.posture);
    return { ...target, result: { ...conn, severity, durationMs: Date.now() - startedAt } };
  }

  const countBy = (items, pick) => items.reduce((acc, t) => {
    const s = pick(t);
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, { ok: 0, info: 0, warn: 0, bad: 0 });

  // GET /api/diagnostics/targets — the catalogue + posture, no live tests run.
  router.get('/targets', asyncHandler(async (req, res) => {
    const targets = await buildCatalog();
    res.json({
      groups: GROUP_ORDER,
      targets,
      summary: { total: targets.length, ...countBy(targets, (t) => t.posture) },
    });
  }));

  // POST /api/diagnostics/run — run the screening. Body: { targets?: string[] }.
  // An omitted/empty list screens everything ("run full screening").
  router.post('/run', asyncHandler(async (req, res) => {
    const wanted = req.body && req.body.targets;
    if (wanted !== undefined && !Array.isArray(wanted)) {
      return res.status(400).json({ error: 'Validation failed', details: { targets: 'targets must be an array of ids' } });
    }
    const catalog = await buildCatalog();
    let selected = catalog;
    if (Array.isArray(wanted) && wanted.length) {
      const ids = new Set(wanted.map(String));
      selected = catalog.filter((t) => ids.has(t.id));
      if (!selected.length) return res.status(400).json({ error: 'No matching targets' });
    }

    const targets = await Promise.all(selected.map((t) => runTarget(t, req.user)));
    res.json({
      ran: targets.length,
      at: new Date().toISOString(),
      targets,
      summary: { total: targets.length, ...countBy(targets, (t) => t.result.severity) },
    });
  }));

  return router;
}

module.exports = { createDiagnosticsRouter, GROUPS, GROUP_ORDER };
