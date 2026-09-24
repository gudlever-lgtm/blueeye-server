'use strict';

// Settings → Authentication (public/app.js settingsAuthView) — the security
// policy panel (migration 041) and the OIDC/SAML admin sections next to LDAP,
// plus the dashboard's handling of the three new server answers:
// password_expired (the change screen), ip_not_allowed (signed out, told why)
// and password_reused (said in the user's language via messageKey).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const SECURITY = {
  passwordHistory: 5, passwordMaxAgeDays: 0,
  ipAllowlist: { admin: ['10.0.0.0/8'], operator: [], viewer: [] },
  yourIp: '10.1.2.3', limits: { passwordHistoryMax: 24, passwordMaxAgeMaxDays: 3650, allowlistMaxPerRole: 100 },
};
const OIDC_STATUS = {
  authEnabledFlag: true, licensed: true, configured: true, enabled: true,
  issuer: 'https://idp.example.eu/realms/acme', clientId: 'blueeye', redirectUri: 'https://be.example.eu/auth/oidc/callback',
  scopes: 'openid email profile', roleClaim: 'groups', clientSecretSet: true,
};
const SAML_STATUS = {
  authEnabledFlag: false, licensed: false, configured: false, enabled: false,
  entryPoint: '', spEntityId: '', audience: '', idpEntityId: '', callbackUrl: '', roleAttribute: 'groups', idpCertSet: false,
};

function boot({ t, routes = {}, url = 'http://server.test/settings/auth', role = 'admin', token = 'T' } = {}) {
  const errors = [];
  const calls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const all = Object.assign({
    'GET /me': { id: 1, email: 'admin@acme.dk', role, preferences: {} },
    'GET /auth/sso': { oidc: { enabled: false }, saml: { enabled: false } },
    'GET /license': { plan: 'professional', features: {} },
    'GET /api/settings/security': SECURITY,
    'PUT /api/settings/security': (body) => ({ ...SECURITY, ...body, ipAllowlist: { ...SECURITY.ipAllowlist, ...(body.ipAllowlist || {}) } }),
    'GET /api/ldap/config': { config: {}, licensed: true, authEnabledFlag: false, bindPasswordSet: false },
    'GET /api/ldap/role-map': [],
    'GET /api/ldap/login-audit': [],
    'GET /api/oidc/config': OIDC_STATUS,
    'GET /api/oidc/role-map': [{ id: 3, claim_value: 'blueeye-admins', blueeye_role: 'admin' }],
    'GET /api/oidc/login-audit': [
      { id: 1, subject: 'alice@acme.dk', ok: 0, reason: 'ip-not-allowed', granted_role: null, groups_matched: 1, source_ip: '192.0.2.9', created_at: '2026-09-24T08:00:00Z' },
    ],
    'POST /api/oidc/role-map': { body: { id: 4 }, status: 201 },
    'POST /api/oidc/test': { ok: true, detail: 'discovered https://idp.example.eu/realms/acme' },
    'GET /api/saml/config': SAML_STATUS,
    'GET /api/saml/role-map': [],
    'GET /api/saml/login-audit': [],
  }, routes);
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, path: p, body });
    let hit = all[`${method} ${p}`];
    if (typeof hit === 'function') hit = hit(body);
    const envelope = hit !== undefined && hit !== null && typeof hit === 'object' && !Array.isArray(hit) && 'body' in hit;
    const status = hit === undefined ? 404 : (envelope ? (hit.status || 200) : 200);
    const out = hit === undefined ? { error: 'Not Found' } : (envelope ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => out, text: async () => JSON.stringify(out) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  if (t) t.after(() => window.close());
  if (token) window.localStorage.setItem('blueeye.server.token', token);
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, calls };
}
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));
const section = (doc, key) => doc.querySelector(`#view [data-auth-section="${key}"]`);

test('the tab shows the security policy, LDAP, OIDC and SAML — in that order', async (t) => {
  const { doc, errors } = boot({ t });
  await settle();
  assert.deepEqual(errors, []);
  const keys = [...doc.querySelectorAll('#view [data-auth-section]')].map((n) => n.dataset.authSection);
  assert.deepEqual(keys, ['security', 'ldap', 'oidc', 'saml']);
  const titles = [...doc.querySelectorAll('#view .auth-section-title')].map((h) => h.textContent);
  assert.deepEqual(titles, ['Security policy', 'LDAP / Active Directory', 'SSO — OpenID Connect (OIDC)', 'SSO — SAML 2.0']);

  const sec = section(doc, 'security');
  assert.equal(sec.querySelector('[data-sec="passwordHistory"]').value, '5');
  assert.equal(sec.querySelector('[data-sec="passwordMaxAgeDays"]').value, '0');
  assert.equal(sec.querySelector('[data-sec-role="admin"]').value, '10.0.0.0/8');
  assert.match(sec.querySelector('[data-sec-yourip]').textContent, /10\.1\.2\.3/);
});

test('saving the password rules and the allowlist PUTs exactly what the form says', async (t) => {
  const { doc, calls } = boot({ t });
  await settle();
  const sec = section(doc, 'security');
  sec.querySelector('[data-sec="passwordHistory"]').value = '8';
  sec.querySelector('[data-sec="passwordMaxAgeDays"]').value = '90';
  sec.querySelector('[data-sec-save="password"]').click();
  await settle(100);
  let put = calls.filter((c) => c.method === 'PUT' && c.path === '/api/settings/security').pop();
  assert.deepEqual(put.body, { passwordHistory: 8, passwordMaxAgeDays: 90 });

  sec.querySelector('[data-sec-role="viewer"]').value = '192.0.2.0/24\n 2001:db8::/32 \n\n';
  sec.querySelector('[data-sec-save="allowlist"]').click();
  await settle(100);
  put = calls.filter((c) => c.method === 'PUT' && c.path === '/api/settings/security').pop();
  assert.deepEqual(put.body, { ipAllowlist: { admin: ['10.0.0.0/8'], operator: [], viewer: ['192.0.2.0/24', '2001:db8::/32'] } });
});

test('the lock-out refusal is shown in the user\'s words, from the server\'s messageKey', async (t) => {
  const { doc } = boot({
    t,
    routes: {
      'PUT /api/settings/security': { status: 409, body: { error: 'allowlist_excludes_you', message: 'x', messageKey: 'set.sec.err.selfLockout', messageParams: { ip: '10.1.2.3' } } },
    },
  });
  await settle();
  const sec = section(doc, 'security');
  sec.querySelector('[data-sec-role="admin"]').value = '172.16.0.0/12';
  sec.querySelector('[data-sec-save="allowlist"]').click();
  await settle(100);
  const err = [...sec.querySelectorAll('.error')].map((e) => e.textContent).join(' ');
  assert.match(err, /Your current address \(10\.1\.2\.3\) is not in the admin allowlist/);
});

test('OIDC: live status, env-configured fields, a discovery test, the role map and the login audit', async (t) => {
  const { doc, calls } = boot({ t });
  await settle();
  const oidc = section(doc, 'oidc');
  assert.equal(oidc.querySelector('[data-sso-live]').dataset.ssoLive, 'yes');
  assert.match(oidc.querySelector('[data-sso-status]').textContent, /https:\/\/idp\.example\.eu\/realms\/acme/);
  assert.match(oidc.querySelector('[data-sso-status]').textContent, /OIDC_AUTH_ENABLED/);

  oidc.querySelector('[data-sso-test="oidc"]').click();
  await settle(100);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/oidc/test'));
  assert.match(doc.querySelector('#toast').textContent, /Connected: discovered/);

  const rows = oidc.querySelectorAll('[data-sso-rolemap] tbody tr');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /blueeye-admins/);

  oidc.querySelector('[data-sso-new="oidc"]').value = ' netops ';
  oidc.querySelector('[data-sso-add="oidc"]').click();
  await settle(100);
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/oidc/role-map');
  assert.deepEqual(post.body, { claimValue: 'netops', role: 'viewer' });

  const audit = oidc.querySelector('[data-sso-audit] tbody');
  assert.match(audit.textContent, /ip-not-allowed/);
  assert.match(audit.textContent, /192\.0\.2\.9/);
});

test('SAML unlicensed: status and audit stay visible, the role map is not offered', async (t) => {
  const { doc } = boot({ t });
  await settle();
  const saml = section(doc, 'saml');
  assert.equal(saml.querySelector('[data-sso-licence]').textContent, 'Licence: no — part of the Professional plan');
  assert.equal(saml.querySelector('[data-sso-rolemap]'), null);
  assert.ok(saml.querySelector('[data-sso-audit]'));
  assert.equal(saml.querySelector('[data-sso-live]').dataset.ssoLive, 'no');
  assert.equal(saml.querySelector('a[href="/auth/saml/metadata"]').textContent, 'SP metadata (XML)');
  assert.equal(saml.querySelector('[data-sso-test]'), null, 'SAML has no discovery test');
});

test('an unlicensed LDAP no longer hides the rest of the tab', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /api/ldap/config': { config: {}, licensed: false } } });
  await settle();
  assert.ok(section(doc, 'security').querySelector('[data-sec="passwordHistory"]'));
  assert.ok(section(doc, 'oidc').querySelector('[data-sso-status]'));
  assert.match(section(doc, 'ldap').textContent, /not included in your licence/);
});

test('the Danish tab is Danish', async (t) => {
  const { doc } = boot({ t, routes: { 'GET /me': { id: 1, email: 'admin@acme.dk', role: 'admin', preferences: { locale: 'da' } } } });
  await settle();
  const titles = [...doc.querySelectorAll('#view .auth-section-title')].map((h) => h.textContent);
  assert.equal(titles[0], 'Sikkerhedspolitik');
  assert.match(section(doc, 'security').textContent, /IP-tilladelsesliste pr\. rolle/);
});

test('403 password_expired on any request holds the session to the change screen', async (t) => {
  const { doc } = boot({
    t,
    url: 'http://server.test/agents',
    routes: { 'GET /agents': { status: 403, body: { error: 'password_expired', messageKey: 'auth.fc.expiredLead' } } },
  });
  await settle(600);
  assert.equal(doc.querySelector('#force-change').classList.contains('hidden'), false);
  assert.equal(doc.querySelector('#app').classList.contains('hidden'), true);
  assert.equal(doc.querySelector('#force-change-form p.meta').textContent, 'Your password has expired. Choose a new one to continue.');
  assert.equal(doc.querySelector('label[for="fc-current"]').textContent, 'Current password');
});

test('a reused password on the change screen is said from the server\'s messageKey', async (t) => {
  const { doc } = boot({
    t,
    url: 'http://server.test/agents',
    routes: {
      'GET /agents': { status: 403, body: { error: 'password_expired' } },
      'POST /auth/change-password': { status: 400, body: { error: 'password_reused', message: 'x', messageKey: 'auth.pw.reused', messageParams: { n: 5 }, details: { newPassword: 'x' } } },
    },
  });
  await settle(600);
  doc.querySelector('#fc-current').value = 'Old-Password-2024!';
  doc.querySelector('#fc-new').value = 'Brand-New-Pw-2026!';
  doc.querySelector('#fc-confirm').value = 'Brand-New-Pw-2026!';
  doc.querySelector('#force-change-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await settle(100);
  assert.equal(doc.querySelector('#fc-error').textContent, 'That password is one of your last 5 passwords. Choose a different one.');
});

test('a sign-in answered passwordExpired goes straight to the change screen', async (t) => {
  const { doc } = boot({
    t, token: null, url: 'http://server.test/',
    routes: { 'POST /auth/login': { token: 'T2', user: { id: 1, email: 'a@acme.dk', role: 'viewer' }, passwordExpired: true } },
  });
  await settle(300);
  doc.querySelector('#email').value = 'a@acme.dk';
  doc.querySelector('#password').value = 'Old-Password-2024!';
  doc.querySelector('#login-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await settle(300);
  assert.equal(doc.querySelector('#force-change').classList.contains('hidden'), false);
  assert.match(doc.querySelector('#force-change-form p.meta').textContent, /expired/);
});

test('403 ip_not_allowed signs the session out and the login screen says why', async (t) => {
  const { doc, window } = boot({
    t,
    url: 'http://server.test/agents',
    routes: { 'GET /agents': { status: 403, body: { error: 'ip_not_allowed' } } },
  });
  await settle(600);
  assert.equal(doc.querySelector('#login').classList.contains('hidden'), false);
  assert.equal(window.localStorage.getItem('blueeye.server.token'), null);
  assert.match(doc.querySelector('#login-error').textContent, /not permitted for your role/);
});

test('a refused sign-in (403 ip_not_allowed) is explained, not shown as a code', async (t) => {
  const { doc } = boot({
    t, token: null, url: 'http://server.test/',
    routes: { 'POST /auth/login': { status: 403, body: { error: 'ip_not_allowed', messageKey: 'auth.ipDenied' } } },
  });
  await settle(300);
  doc.querySelector('#email').value = 'a@acme.dk';
  doc.querySelector('#password').value = 'Old-Password-2024!';
  doc.querySelector('#login-form').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true }));
  await settle(200);
  assert.match(doc.querySelector('#login-error').textContent, /not permitted for your role/);
});
