'use strict';

const { baseUrlBlockedReason } = require('../integrations/ssrfGuard');

// The security-screening lens for the "Test area". PURE + explainable: every check
// carries a status (ok/info/warn/bad) and a plain-language note, so the dashboard
// can show *why* a target passed or failed with no network I/O. Connectivity (the
// live reachability test) is layered on top by the router — this module judges only
// the *configuration's* security posture from already-safe (secret-free) inputs.

// Severity precedence for rolling a set of checks up into one verdict.
const SEV_RANK = { ok: 0, info: 1, warn: 2, bad: 3 };
function worse(a, b) { return SEV_RANK[b] > SEV_RANK[a] ? b : a; }
function rollup(checks) { return (checks || []).reduce((acc, c) => worse(acc, c.status), 'ok'); }

function isHttps(url) { return /^https:\/\//i.test(String(url || '')); }
function isHttp(url) { return /^http:\/\//i.test(String(url || '')); }
function hostOf(url) { try { return new URL(String(url)).host.toLowerCase(); } catch { return ''; } }

const check = (id, label, status, note) => ({ id, label, status, note });

// Wraps a target's checks with a one-line config summary + the rolled-up posture.
function entry(name, { detail = '', configured = false, enabled = false, security = [] }) {
  return { name, detail, configured, enabled, security, posture: rollup(security) };
}

// Shared HTTPS/transport judgement for an outbound URL. `plaintext` tailors how
// severe a bare-HTTP endpoint is (an alert webhook leaks data → bad; map tiles are
// public → warn).
function transportCheck(url, { plaintext = 'bad' } = {}) {
  if (!url) return check('transport', 'Transport', 'info', 'No endpoint URL configured.');
  if (isHttps(url)) return check('transport', 'Transport', 'ok', 'Endpoint uses HTTPS (encrypted in transit).');
  if (isHttp(url)) return check('transport', 'Transport', plaintext, 'Endpoint uses plaintext HTTP — data is sent unencrypted.');
  return check('transport', 'Transport', 'warn', 'Endpoint scheme is neither http nor https.');
}

// --- Email / alert channels ------------------------------------------------

function screenEmail(email = {}) {
  const smtp = email.smtp || {};
  const host = smtp.host || '';
  const port = Number(smtp.port) || 0;
  const security = [];
  if (!host) {
    security.push(check('smtp', 'SMTP server', 'info', 'No SMTP server configured.'));
  } else if (smtp.secure === true) {
    security.push(check('tls', 'TLS', 'ok', 'Implicit TLS (SMTPS) is enabled.'));
  } else if (port === 25) {
    security.push(check('tls', 'TLS', 'bad', 'Port 25 with TLS off — mail (and any credentials) is sent in cleartext.'));
  } else if (port === 465) {
    security.push(check('tls', 'TLS', 'warn', 'Port 465 expects implicit TLS, but "secure" is off — enable secure.'));
  } else {
    security.push(check('tls', 'TLS', 'warn', 'TLS is off — delivery relies on opportunistic STARTTLS, which is not enforced.'));
  }
  if (host) {
    security.push(email.smtpPassSet && smtp.user
      ? check('auth', 'Authentication', 'ok', 'SMTP authentication is configured.')
      : check('auth', 'Authentication', 'info', 'No SMTP authentication — the relay must accept unauthenticated mail.'));
    security.push(email.to
      ? check('recipient', 'Recipient', 'ok', `Alerts are sent to ${email.to}.`)
      : check('recipient', 'Recipient', 'warn', 'No recipient address configured.'));
  }
  return entry('Email (SMTP)', {
    detail: host ? `${host}:${port || 587}` : 'not configured',
    configured: Boolean(host), enabled: Boolean(email.enabled), security,
  });
}

function screenWebhook(webhook = {}) {
  const url = webhook.url || '';
  const security = [transportCheck(url, { plaintext: 'bad' })];
  if (url) {
    security.push(webhook.secretSet
      ? check('signing', 'Payload signing', 'ok', 'An HMAC secret is set — the receiver can verify each payload is authentic.')
      : check('signing', 'Payload signing', 'warn', 'No HMAC secret — the receiver cannot verify authenticity (payloads are spoofable).'));
  }
  return entry('Webhook (alerts)', {
    detail: url ? hostOf(url) : 'not configured',
    configured: Boolean(url), enabled: Boolean(webhook.enabled), security,
  });
}

function screenSyslog(syslog = {}) {
  const host = syslog.host || '';
  const proto = (syslog.proto || 'udp').toLowerCase();
  const security = [];
  if (!host) security.push(check('syslog', 'Syslog server', 'info', 'No syslog server configured.'));
  else security.push(check('transport', 'Transport', 'warn', `Syslog over ${proto.toUpperCase()} has no transport encryption — keep it on a trusted network segment.`));
  return entry('Syslog', {
    detail: host ? `${proto}://${host}:${syslog.port || 514}` : 'not configured',
    configured: Boolean(host), enabled: Boolean(syslog.enabled), security,
  });
}

// --- Remote API receivers (ITSM / IPAM) ------------------------------------

function screenIntegration(row = {}) {
  const url = row.base_url || '';
  const type = row.type || 'integration';
  const authType = row.auth_type || 'none';
  const security = [transportCheck(url, { plaintext: 'bad' })];
  // Private/loopback target — the integrations SSRF guard would block it at send
  // time; surface it here so a stored internal target is visible in the screening.
  if (url && baseUrlBlockedReason(url)) {
    security.push(check('target', 'Target address', 'bad', 'Points at a private, loopback or link-local address.'));
  }
  if (authType === 'none') {
    security.push(type === 'webhook'
      ? check('auth', 'Authentication', 'warn', 'No authentication — anyone who learns the URL can post to it.')
      : check('auth', 'Authentication', 'bad', 'No authentication configured for an ITSM/IPAM target.'));
  } else {
    security.push(check('auth', 'Authentication', 'ok', `Authenticated (${authType}).`));
  }
  if (!row.enabled) security.push(check('enabled', 'State', 'info', 'Disabled — this integration is not firing on events.'));
  return entry(row.name || `${type} integration`, {
    detail: `${type} · ${hostOf(url) || url || 'no url'}`,
    configured: Boolean(url), enabled: Boolean(row.enabled), security,
  });
}

// --- Authentication (SSO) --------------------------------------------------

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

function screenLdap(cfg = {}) {
  const host = cfg.host || '';
  const security = [];
  if (!host) {
    security.push(check('ldap', 'Directory', 'info', 'No LDAP/AD directory configured.'));
  } else if (cfg.use_tls) {
    security.push(check('tls', 'TLS', 'ok', 'LDAPS/TLS is enabled — the bind is encrypted.'));
  } else if (LOCAL_HOSTS.includes(String(host).toLowerCase())) {
    security.push(check('tls', 'TLS', 'info', 'Plaintext bind to localhost (TLS is likely terminated by a local sidecar).'));
  } else {
    security.push(check('tls', 'TLS', 'bad', 'Plaintext LDAP to a remote host — bind credentials are exposed on the wire.'));
  }
  return entry('LDAP / Active Directory', {
    detail: host ? `${cfg.use_tls ? 'ldaps' : 'ldap'}://${host}:${cfg.port || 389}` : 'not configured',
    configured: Boolean(host), enabled: Boolean(cfg.enabled), security,
  });
}

function screenOidc(status = {}) {
  const issuer = status.issuer || '';
  const security = [];
  if (!issuer) security.push(check('oidc', 'Issuer', 'info', 'No OIDC issuer configured.'));
  else if (isHttps(issuer)) security.push(check('issuer', 'Issuer', 'ok', 'Issuer is reached over HTTPS.'));
  else security.push(check('issuer', 'Issuer', 'bad', 'Issuer URL is not HTTPS — discovery/token traffic is unencrypted.'));
  if (issuer) {
    security.push(status.clientSecretSet
      ? check('client', 'Client', 'ok', 'Confidential client (a client secret is set).')
      : check('client', 'Client', 'info', 'Public client (PKCE only) — no client secret, which is expected for PKCE.'));
  }
  return entry('SSO — OIDC', {
    detail: issuer ? hostOf(issuer) : 'not configured',
    configured: Boolean(status.configured), enabled: Boolean(status.enabled), security,
  });
}

function screenSaml(status = {}) {
  const ep = status.entryPoint || '';
  const security = [];
  if (!ep) security.push(check('saml', 'IdP', 'info', 'No SAML IdP configured.'));
  else if (isHttps(ep)) security.push(check('entry', 'IdP SSO URL', 'ok', 'IdP SSO endpoint is HTTPS.'));
  else security.push(check('entry', 'IdP SSO URL', 'bad', 'IdP SSO endpoint is not HTTPS.'));
  if (ep) {
    security.push(status.idpCertSet
      ? check('cert', 'Assertion signature', 'ok', 'IdP signing certificate is set — assertions are verified.')
      : check('cert', 'Assertion signature', 'warn', 'No IdP signing certificate — assertions cannot be verified.'));
  }
  return entry('SSO — SAML', {
    detail: ep ? hostOf(ep) : 'not configured',
    configured: Boolean(status.configured), enabled: Boolean(status.enabled), security,
  });
}

// --- Other outbound services ----------------------------------------------

function screenAssistant(status = {}) {
  const baseUrl = status.baseUrl || '';
  const host = hostOf(baseUrl);
  const security = [transportCheck(baseUrl, { plaintext: 'bad' })];
  if (host) {
    security.push(host.endsWith('mistral.ai')
      ? check('provider', 'Provider', 'ok', 'Mistral (EU) — complies with the no-US-vendor policy.')
      : check('provider', 'Provider', 'info', 'Custom/self-hosted endpoint — confirm it is EU or self-hosted per policy.'));
  }
  if (status.enabled && !status.configured) {
    security.push(check('key', 'API key', 'warn', 'The assistant is enabled but no API key is set.'));
  }
  return entry('AI assistant', {
    detail: host || 'not configured',
    configured: Boolean(status.configured), enabled: Boolean(status.enabled), security,
  });
}

function screenMap(map = {}) {
  const tileUrl = map.tileUrl || '';
  const geocodeUrl = map.geocodeUrl || '';
  const security = [];
  if (!tileUrl) security.push(check('tiles', 'Map tiles', 'info', 'No tile URL configured.'));
  else if (isHttps(tileUrl)) security.push(check('tiles', 'Map tiles', 'ok', 'Tiles are served over HTTPS.'));
  else security.push(check('tiles', 'Map tiles', 'warn', 'Tiles are served over plaintext HTTP.'));
  if (geocodeUrl) {
    security.push(isHttps(geocodeUrl)
      ? check('geocoder', 'Geocoder', 'ok', 'Geocoder is reached over HTTPS.')
      : check('geocoder', 'Geocoder', 'warn', 'Geocoder URL is not HTTPS.'));
  }
  return entry('Map tiles & geocoder', {
    detail: hostOf(tileUrl) || 'not configured',
    configured: Boolean(tileUrl), enabled: true, security,
  });
}

function screenLicense(status = {}) {
  const s = status.status || 'unknown';
  const byStatus = {
    valid: check('license', 'Licence', 'ok', 'Licence is valid and signature-verified.'),
    grace: check('license', 'Licence', 'warn', 'In grace period — the licence server was unreachable; running on a cached proof.'),
    expired: check('license', 'Licence', 'bad', 'Licence has expired.'),
    invalid: check('license', 'Licence', 'bad', `Licence is not valid${status.reason ? ` (${status.reason})` : ''}.`),
    unlicensed: check('license', 'Licence', 'warn', 'No usable licence proof.'),
    unknown: check('license', 'Licence', 'info', 'Licence has not been validated yet.'),
  };
  return entry('Licence server', {
    detail: status.validUntil ? `valid until ${status.validUntil}` : s,
    configured: true, enabled: true, security: [byStatus[s] || byStatus.unknown],
  });
}

module.exports = {
  rollup, worse, isHttps, isHttp, hostOf,
  screenEmail, screenWebhook, screenSyslog,
  screenIntegration,
  screenLdap, screenOidc, screenSaml,
  screenAssistant, screenMap, screenLicense,
};
