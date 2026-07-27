'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// Role precedence for "highest matching role wins".
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

// True for loopback hosts, where a plaintext bind is acceptable (e.g. TLS is
// terminated by a local stunnel/sidecar). Everywhere else TLS is mandatory.
function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// Escapes the LDAP filter metacharacters (RFC 4515) so a crafted username can't
// alter the search filter (LDAP injection).
function escapeFilter(value) {
  return String(value).replace(/[\\*()\x00]/g, (ch) => {
    switch (ch) {
      case '\\': return '\\5c';
      case '*': return '\\2a';
      case '(': return '\\28';
      case ')': return '\\29';
      case '\x00': return '\\00';
      default: return ch;
    }
  });
}

// Default LDAP client factory: lazily requires ldapts (mirroring how the email
// channel lazily requires nodemailer) so the server has no hard dependency and
// tests never need it — they inject their own factory. Returns null when ldapts
// is absent, which the auth service reports as 'unavailable'.
function defaultClientFactory({ url, tlsOptions }) {
  let ldapts;
  try {
    ldapts = require('ldapts'); // eslint-disable-line global-require
  } catch {
    return null;
  }
  return new ldapts.Client({ url, tlsOptions, timeout: 8000, connectTimeout: 8000 });
}

// LDAP/AD authentication service. The SAME code path serves Microsoft AD and
// OpenLDAP — only the configurable filters differ. Flow:
//   1) service-bind (or anonymous) and search for the user by user_filter
//   2) re-bind AS the user with the supplied password (the actual authentication)
//   3) resolve the user's groups to the HIGHEST mapped BlueEyes role
//   4) NO mapped group => access denied (there is deliberately no default role)
// TLS is required off-localhost: a plaintext bind (use_tls=false) to a non-local
// host is refused before any credential leaves the process.
function createLdapAuth({
  config = {},
  ldapConfigRepo,
  ldapRoleMapRepo,
  secretBox,
  clientFactory = defaultClientFactory,
  featureGate = null,
  logger = silentLogger,
} = {}) {
  const authEnabledFlag = Boolean(config.authEnabled);

  // Whether the licence includes the LDAP/AD feature. Fail-OPEN when no gate is
  // injected (tests / installs without the plan layer keep working); fail-CLOSED
  // — directory login disabled, falling back to local auth — once a gate says no.
  function licensed() {
    if (!featureGate || typeof featureGate.isFeatureEnabled !== 'function') return true;
    return featureGate.isFeatureEnabled('sso_ldap') === true;
  }

  // True only when the env flag is on, the licence covers it, AND an admin has
  // stored + enabled a config.
  async function isEnabled() {
    if (!authEnabledFlag || !licensed()) return false;
    let cfg = null;
    try { cfg = await ldapConfigRepo.get(); } catch { cfg = null; }
    return Boolean(cfg && cfg.enabled);
  }

  function renderFilter(filter, username, dn) {
    return String(filter || '')
      .replace(/\{\{\s*username\s*\}\}/g, escapeFilter(username))
      .replace(/\{\{\s*dn\s*\}\}/g, escapeFilter(dn || ''));
  }

  // Maps a set of group DNs to the highest BlueEyes role. Returns { role, matched }
  // (matched = how many of the user's groups mapped). role is null when none map.
  async function resolveRole(groupDns) {
    let maps = [];
    try { maps = await ldapRoleMapRepo.findAll(); } catch { maps = []; }
    const wanted = new Map(maps.map((m) => [String(m.ldap_group_dn).toLowerCase(), m.blueeye_role]));
    let role = null;
    let matched = 0;
    for (const dn of groupDns) {
      const r = wanted.get(String(dn).toLowerCase());
      if (!r) continue;
      matched += 1;
      if (!role || ROLE_RANK[r] > ROLE_RANK[role]) role = r;
    }
    return { role, matched };
  }

  // Group DNs from a user entry (AD returns memberOf as a string or array).
  function groupsFromEntry(entry) {
    if (!entry) return [];
    const mo = entry.memberOf;
    if (Array.isArray(mo)) return mo.map(String);
    if (typeof mo === 'string' && mo) return [mo];
    return [];
  }

  function urlFor(cfg) {
    return `${cfg.use_tls ? 'ldaps' : 'ldap'}://${cfg.host}:${cfg.port}`;
  }

  // Authenticates a user. Return shapes:
  //   { enabled:false }                              — LDAP off; caller falls back to local
  //   { enabled:true, ok:true, role, dn, email, username, groups, matched }
  //   { enabled:true, ok:false, reason }             — reason in:
  //       'invalid-input' | 'tls-required' | 'unavailable' | 'bind-failed' | 'no-role'
  async function authenticate(username, password) {
    // Off when the env flag is unset OR the licence doesn't cover LDAP/AD — the
    // caller then falls back to local auth, so an expired licence can never lock
    // everyone out.
    if (!authEnabledFlag || !licensed()) return { enabled: false };

    let cfg = null;
    try { cfg = await ldapConfigRepo.getWithSecret(); } catch (err) { logger.warn(`ldap: config read failed (${err.message})`); return { enabled: false }; }
    if (!cfg || !cfg.enabled) return { enabled: false };

    // Reject an empty username/password WITHOUT binding: many directories treat an
    // empty password as an "unauthenticated bind" that succeeds, which must never
    // grant access.
    if (typeof username !== 'string' || username.trim() === '' || typeof password !== 'string' || password === '') {
      return { enabled: true, ok: false, reason: 'invalid-input', matched: 0 };
    }

    // TLS enforcement: refuse a plaintext bind to a non-local host.
    if (!cfg.use_tls && !isLocalHost(cfg.host)) {
      logger.warn('ldap: refusing plaintext bind to a non-local host (use_tls=false)');
      return { enabled: true, ok: false, reason: 'tls-required', matched: 0 };
    }

    const client = clientFactory({ url: urlFor(cfg), tlsOptions: {} });
    if (!client) return { enabled: true, ok: false, reason: 'unavailable', matched: 0 };

    let bindPw = '';
    try { bindPw = secretBox.decrypt(cfg.bind_pw_encrypted || ''); } catch { bindPw = ''; }

    try {
      // 1) Service bind for the search (skip when no bind_dn -> anonymous).
      if (cfg.bind_dn) await client.bind(cfg.bind_dn, bindPw);

      // 2) Find the user.
      const { searchEntries } = await client.search(cfg.base_dn, {
        scope: 'sub',
        filter: renderFilter(cfg.user_filter, username),
        attributes: ['dn', 'memberOf', 'mail', 'cn'],
        sizeLimit: 2,
      });
      const entry = searchEntries && searchEntries[0];
      if (!entry || !entry.dn) return { enabled: true, ok: false, reason: 'bind-failed', matched: 0 };

      // 3) Bind AS the user — the actual authentication. A wrong password throws.
      await client.bind(entry.dn, password);

      // 4) Groups -> role. Fall back to a group_filter search when memberOf is absent.
      let groupDns = groupsFromEntry(entry);
      if (!groupDns.length && cfg.group_filter) {
        try {
          const r = await client.search(cfg.base_dn, {
            scope: 'sub', filter: renderFilter(cfg.group_filter, username, entry.dn), attributes: ['dn'], sizeLimit: 100,
          });
          groupDns = (r.searchEntries || []).map((e) => e.dn);
        } catch (err) { logger.warn(`ldap: group search failed (${err.message})`); }
      }

      const { role, matched } = await resolveRole(groupDns);
      if (!role) return { enabled: true, ok: false, reason: 'no-role', matched: 0 };

      const email = typeof entry.mail === 'string' && entry.mail ? entry.mail.toLowerCase() : username.toLowerCase();
      return { enabled: true, ok: true, role, dn: entry.dn, email, username, groups: groupDns, matched };
    } catch (err) {
      logger.warn(`ldap: authentication failed for ${username} (${err.message})`);
      return { enabled: true, ok: false, reason: 'bind-failed', matched: 0 };
    } finally {
      try { await client.unbind(); } catch { /* ignore */ }
    }
  }

  // Connectivity/credentials test for the admin UI: bind with the service account
  // (or anonymously) and confirm base_dn is reachable. Returns { ok, detail }.
  async function testConnection() {
    let cfg = null;
    try { cfg = await ldapConfigRepo.getWithSecret(); } catch { cfg = null; }
    if (!cfg) return { ok: false, detail: 'no LDAP config stored' };
    if (!cfg.use_tls && !isLocalHost(cfg.host)) return { ok: false, detail: 'TLS required: refusing plaintext bind to a non-local host' };
    const client = clientFactory({ url: urlFor(cfg), tlsOptions: {} });
    if (!client) return { ok: false, detail: 'ldapts is not installed' };
    let bindPw = '';
    try { bindPw = secretBox.decrypt(cfg.bind_pw_encrypted || ''); } catch { bindPw = ''; }
    try {
      if (cfg.bind_dn) await client.bind(cfg.bind_dn, bindPw);
      await client.search(cfg.base_dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'], sizeLimit: 1 });
      return { ok: true, detail: `bound to ${urlFor(cfg)}` };
    } catch (err) {
      return { ok: false, detail: `bind/search failed: ${err.message}` };
    } finally {
      try { await client.unbind(); } catch { /* ignore */ }
    }
  }

  return { isEnabled, authenticate, testConnection, resolveRole };
}

module.exports = { createLdapAuth, defaultClientFactory, isLocalHost, escapeFilter, ROLE_RANK };
