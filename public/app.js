'use strict';

// BlueEyes server dashboard — dependency-free vanilla JS over the JSON API.
const TOKEN_KEY = 'blueeye.server.token';
const ROLE_KEY = 'blueeye.server.role';
const EMAIL_KEY = 'blueeye.server.email';
const THEME_KEY = 'blueeye.server.theme';
const NAV_COLLAPSE_KEY = 'blueeye.server.navCollapsed';
const AUTOREFRESH_KEY = 'blueeye.server.autoRefresh';

const $ = (sel) => document.querySelector(sel);

// Colour palettes — each comes in a light and a dark variant. The picker
// (Settings → Appearance) selects a palette; the topbar 🌙/☀️ button switches
// brightness within it. Each variant's `key` matches a [data-theme="…"] block in
// styles.css and is whitelisted server-side (preferencesValidation.js); `swatch`
// is [bg, panel, accent, text] for the preview. Keep all three in sync.
const PALETTES = [
  { key: 'default', label: 'Default', light: { key: 'light', swatch: ['#f1f5f9', '#ffffff', '#0284c7', '#0f172a'] }, dark: { key: 'dark', swatch: ['#0f172a', '#1e293b', '#38bdf8', '#e2e8f0'] } },
  { key: 'midnight', label: 'Midnight', light: { key: 'midnight-light', swatch: ['#eef0fb', '#ffffff', '#5b5bd6', '#181a2e'] }, dark: { key: 'midnight', swatch: ['#0a0a12', '#14141f', '#818cf8', '#e6e6f2'] } },
  { key: 'nord', label: 'Nord', light: { key: 'nord-light', swatch: ['#e5e9f0', '#eceff4', '#5e81ac', '#2e3440'] }, dark: { key: 'nord', swatch: ['#2e3440', '#3b4252', '#88c0d0', '#eceff4'] } },
  { key: 'forest', label: 'Forest', light: { key: 'forest-light', swatch: ['#eef4ee', '#ffffff', '#1f9d57', '#14241a'] }, dark: { key: 'forest', swatch: ['#0c1410', '#14201a', '#34d399', '#d7e6dc'] } },
  { key: 'sunset', label: 'Sunset', light: { key: 'sunset-light', swatch: ['#fbeef4', '#fffafc', '#d6438a', '#2a1320'] }, dark: { key: 'sunset', swatch: ['#1a1320', '#251a2e', '#f472b6', '#f1e7f2'] } },
  { key: 'solarized', label: 'Solarized', light: { key: 'solarized-light', swatch: ['#eee8d5', '#fdf6e3', '#268bd2', '#586e75'] }, dark: { key: 'solarized-dark', swatch: ['#002b36', '#073642', '#268bd2', '#93a1a1'] } },
  { key: 'contrast', label: 'High contrast', light: { key: 'contrast-light', swatch: ['#ffffff', '#ffffff', '#0040d0', '#000000'] }, dark: { key: 'contrast', swatch: ['#000000', '#0a0a0a', '#ffd400', '#ffffff'] } },
];
// Flatten to per-variant metadata keyed by the data-theme value. Each variant
// knows its family, its palette, and its opposite-brightness counterpart (dual).
const THEMES = PALETTES.flatMap((p) => [
  { key: p.light.key, family: 'light', dual: p.dark.key, palette: p.key, label: `${p.label} light`, swatch: p.light.swatch },
  { key: p.dark.key, family: 'dark', dual: p.light.key, palette: p.key, label: `${p.label} dark`, swatch: p.dark.swatch },
]);
const THEME_KEYS = THEMES.map((t) => t.key);
const themeMeta = (key) => THEMES.find((t) => t.key === key) || THEMES[0];
const paletteOf = (key) => themeMeta(key).palette;

// The theme is applied instantly from a local cache (no flash on load), then
// reconciled with the per-user value saved on the server (see loadProfile).
function applyTheme(theme) {
  const t = THEME_KEYS.includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = t;
  const btn = document.querySelector('#theme');
  if (btn) {
    const isDark = themeMeta(t).family === 'dark';
    const ico = isDark ? '☀️' : '🌙';
    // The theme control is now a labelled menu row ("Dark mode") with a leading
    // .menu-ico span — update just the icon so the label text is preserved.
    const icoEl = btn.querySelector('.menu-ico');
    if (icoEl) icoEl.textContent = ico; else btn.textContent = ico;
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }
}
function cachedTheme() {
  // Default to the dark enterprise palette; a user's saved/cached choice wins.
  try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; }
}
// Set once the user explicitly picks a theme (topbar toggle or Settings →
// Appearance). It makes that choice win over loadProfile()'s one-time server
// reconcile, which would otherwise override a fresh toggle with the previously
// saved value if /me is still in flight when the user clicks.
let themeUserChoice = false;
// Apply + cache a theme locally, and persist it to the signed-in user's account
// (so it follows them to any browser). Returns the save promise for callers that
// want to surface success/failure; the local apply always happens immediately.
function setTheme(theme, { persist = true } = {}) {
  const t = THEME_KEYS.includes(theme) ? theme : 'dark';
  if (persist) themeUserChoice = true;
  applyTheme(t);
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage off */ }
  if (persist && token) {
    return api('/me/preferences', { method: 'PUT', body: { theme: t } });
  }
  return Promise.resolve();
}
function initTheme() {
  applyTheme(cachedTheme());
  const btn = document.querySelector('#theme');
  if (btn) {
    // Light/dark toggle: flip to the same palette's opposite-brightness variant,
    // so brightness changes while your chosen colour palette is preserved.
    btn.addEventListener('click', () => {
      setTheme(themeMeta(document.documentElement.dataset.theme).dual)
        .catch(() => { /* keep the local change even if the save fails */ });
    });
  }
}
initTheme();
// Language is applied before the first render (function declarations hoist, so
// initLocale's definition further down is already available here).
initLocale();
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    // `class: cond ? 'x' : null` is a common shape; without the guard the
    // element ends up with the literal class "null".
    if (k === 'class') { if (v != null) node.className = v; }
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Capture a federated (OIDC/SAML) sign-in BEFORE reading the stored session: the
// /auth/*/callback redirects back with the freshly-minted JWT in the URL FRAGMENT
// (#sso_token=…&role=…&email=…) — fragments never reach the server, so the token
// stays out of access logs. We persist it like a local login and scrub the URL.
let ssoLoginError = '';
(function captureSso() {
  try {
    const hash = window.location.hash || '';
    if (hash.startsWith('#') && hash.includes('sso_token=')) {
      const p = new URLSearchParams(hash.slice(1));
      const t = p.get('sso_token');
      if (t) {
        localStorage.setItem(TOKEN_KEY, t);
        localStorage.setItem(ROLE_KEY, p.get('role') || 'viewer');
        localStorage.setItem(EMAIL_KEY, p.get('email') || '');
      }
      history.replaceState(null, '', window.location.pathname);
    }
    const q = new URLSearchParams(window.location.search || '');
    if (q.get('sso_error')) {
      ssoLoginError = q.get('sso_error');
      history.replaceState(null, '', window.location.pathname);
    }
  } catch { /* storage / URL API off — fall through to local login */ }
})();

let token = localStorage.getItem(TOKEN_KEY);
let role = localStorage.getItem(ROLE_KEY) || 'viewer';
let email = localStorage.getItem(EMAIL_KEY) || '';

// Reads the (unverified) payload of the current JWT — used only to detect the
// mustChangePassword flag so the UI can force the change screen even after a
// page reload (the server is still the authority; it 403s every other route).
function decodeToken(t = token) {
  if (!t || typeof t !== 'string') return {};
  const part = t.split('.')[1];
  if (!part) return {};
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) || {};
  } catch { return {}; }
}
// True while the signed-in user must change their one-time password first.
function needsPasswordChange() {
  return decodeToken().mustChangePassword === true;
}

const canWrite = () => role === 'operator' || role === 'admin';
const canDelete = () => role === 'admin';
const isAdmin = () => role === 'admin';

// ---- API helper -----------------------------------------------------------
// Inline SVG icons for icon-only buttons.
//
// One vocabulary across the whole dashboard: a red TRASH CAN deletes, and "×"
// only ever closes or cancels. The two had drifted into each other — a red "×"
// removed a transaction step here while the same mark closed a dialog two
// screens away — and a glyph is whatever the viewer's font decides: different
// weight per platform and blurry at button size. Stroked in currentColor, so it
// inherits the button's colour (including .danger red) and stays sharp.
const ICON_PATHS = {
  trash: ['M4 7h16', 'M10 4h4', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
};

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon-glyph');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body (e.g. 204) */ }
  // A 401 on an authenticated call means the session expired; on the login and
  // change-password calls it just means wrong credentials — surface the server's
  // message instead of tearing the session down.
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/change-password') {
    logout();
    throw new Error('Session expired — please log in again.');
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Human-readable text from an api() error: prefer the field-level validation
// details (joined), else the thrown message.
function errText(e) {
  return e.data && e.data.details ? Object.values(e.data.details).join(' · ') : e.message;
}

function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast${bad ? ' bad' : ''}`;
  setTimeout(() => t.classList.add('hidden'), 3200);
  // Every failure the user is shown is also captured into the Logs view, so an
  // error that flashed past in a toast can still be found afterwards (and, via
  // the best-effort ship to the server, by an admin in the merged log).
  if (bad) recordClientLog('error', message);
}

// Client-side log ring — failed dashboard actions the user was shown. Kept in
// memory for this session AND best-effort shipped to the server's log buffer so
// they merge with the operational stream in the admin Logs view. The ship uses a
// raw fetch (not api()) so it can never recurse through this capture path.
const CLIENT_LOG_MAX = 200;
const clientLog = [];
let clientLogSeq = 0;
function recordClientLog(level, message, meta) {
  clientLogSeq += 1;
  const id = `${Date.now()}-${clientLogSeq}`;
  const row = { id, ts: new Date().toISOString(), level, msg: String(message).slice(0, 500), source: 'client', meta: meta || {} };
  clientLog.push(row);
  if (clientLog.length > CLIENT_LOG_MAX) clientLog.shift();
  try {
    fetch('/api/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ id, level, msg: row.msg, meta: row.meta }),
    }).catch(() => { /* offline / no perms — the local copy still shows */ });
  } catch { /* ignore */ }
  return row;
}

function copyText(text) {
  const done = () => toast('Copied');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = el('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Could not copy', true); }
  ta.remove();
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const fmtDate = (s) => (s ? new Date(s).toLocaleString('en-GB') : '–');
function fmtDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---- Auth -----------------------------------------------------------------
async function login(emailInput, password) {
  const data = await api('/auth/login', { method: 'POST', body: { email: emailInput, password } });
  token = data.token;
  role = data.user.role;
  email = data.user.email;
  signingKeyPromptDone = false; // re-check the signing key for this freshly-logged-in user
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
  localStorage.setItem(EMAIL_KEY, email);
}
// License features (which modules the customer is entitled to). Cached with a
// short TTL so module visibility self-heals after a licence renewal without
// re-fetching on every render. Call invalidateFeatures() to force a refresh
// (e.g. right after "Revalidate now").
let licenseFeatures = null;
let featuresLoadedAt = 0;
const FEATURES_TTL_MS = 60000;
// The active licence package (Pilot/Starter/Professional). Locked
// modules are presented relative to THIS — i.e. "not part of your <plan> licence" —
// rather than as a generic free/pro tier. Same TTL + invalidation as the feature map.
let licensePlan = null;
let planLoadedAt = 0;
function invalidateFeatures() {
  licenseFeatures = null; featuresLoadedAt = 0;
  licensePlan = null; planLoadedAt = 0;
}
async function loadFeatures() {
  if (licenseFeatures && Date.now() - featuresLoadedAt < FEATURES_TTL_MS) return licenseFeatures;
  try { licenseFeatures = await api('/license/features'); featuresLoadedAt = Date.now(); }
  catch { if (!licenseFeatures) licenseFeatures = {}; }
  return licenseFeatures;
}
async function loadPlan() {
  if (licensePlan && Date.now() - planLoadedAt < FEATURES_TTL_MS) return licensePlan;
  try { licensePlan = await api('/license/plan'); planLoadedAt = Date.now(); }
  catch { if (!licensePlan) licensePlan = {}; }
  return licensePlan;
}
// The customer-facing name of the active licence ("Professional"), or '' if unknown.
function activePlanName() { return (licensePlan && licensePlan.plan_name) || ''; }
// The package a locked module is sold under, from /license/plan's `modules` map
// (server-side source of truth). Returns { name, label } or null when unknown.
function moduleRequirement(featureKey) {
  const m = licensePlan && licensePlan.modules && licensePlan.modules[featureKey];
  return m && m.required_plan_name ? { name: m.required_plan_name, label: m.required_plan_label } : null;
}
// How a licence-excluded module is described in tooltips/toasts — tied to the
// actual licence setup: name the package that unlocks it, else fall back to the
// active plan.
function lockedHint(label, featureKey) {
  const need = moduleRequirement(featureKey);
  if (need) return `${label} requires ${need.label}`;
  const plan = activePlanName();
  return plan
    ? `${label} is not part of your ${plan} licence`
    : `${label} is not included in your current licence`;
}
// Combined entitlement for a nav `data-feature` key. A module/feature is locked
// only when EITHER the legacy module map (/license/features: analysis/assistant/
// alerting/geo) OR the active plan's packaged-feature map (/license/plan, e.g.
// dashboard_advanced) explicitly excludes it. Unknown keys stay allowed ("show
// until we know it's off"), so a cold cache never hides a tab.
function featureEntitled(key) {
  if ((licenseFeatures || {})[key] === false) return false;
  const pf = (licensePlan && licensePlan.features) || {};
  if (Object.prototype.hasOwnProperty.call(pf, key) && pf[key] !== true) return false;
  return true;
}
function applyFeatureVisibility() {
  for (const b of document.querySelectorAll('.tabs button[data-feature]')) {
    const allowed = featureEntitled(b.dataset.feature); // show until we know it's off
    // Rather than hide a module the licence excludes, keep it visible but dimmed
    // with a lock marker (see .tabs button.locked). The state + tooltip are driven
    // by the actual licence setup (active plan + module entitlements), not a generic
    // free/pro split. Clicking it routes to Settings → License, never the 403 view.
    b.classList.toggle('locked', !allowed);
    if (!allowed) {
      const label = (b.textContent || 'This module').trim();
      const need = moduleRequirement(b.dataset.feature);
      // Badge shows the required package (e.g. "Professional"); lock glyph if unknown.
      b.dataset.lockBadge = need ? need.name : '🔒';
      b.title = lockedHint(label, b.dataset.feature);
    } else {
      delete b.dataset.lockBadge;
      b.removeAttribute('title');
    }
    if (!allowed && currentView === b.dataset.view) currentView = 'overview';
  }
}
// Role-based menu visibility. Roles are hierarchical (viewer < operator < admin);
// a nav item's data-min-role is the lowest role allowed to open it (absent = viewer,
// i.e. everyone). Items above the user's role are hidden, and any category group left
// with no visible items collapses so the rail shows only relevant sections. Mirrors
// applyFeatureVisibility's redirect: if the current view just disappeared, fall back
// to the always-available landing page.
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
function roleAtLeast(min) { return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 1); }
function applyRoleVisibility() {
  for (const b of document.querySelectorAll('.tabs button[data-min-role]')) {
    const allowed = roleAtLeast(b.dataset.minRole);
    b.classList.toggle('role-hidden', !allowed);
    if (!allowed && currentView === b.dataset.view) currentView = 'changes';
  }
  // Collapse category groups whose items are all hidden (by role or licence).
  // Only nav items count — the category-label button never keeps a group alive.
  for (const g of document.querySelectorAll('.tabs .nav-group')) {
    const anyVisible = [...g.querySelectorAll('button[data-view]')]
      .some((b) => !b.classList.contains('hidden') && !b.classList.contains('role-hidden'));
    g.classList.toggle('hidden', !anyVisible);
  }
}
// Synchronous entitlement check against the cached licence features. render()
// awaits loadFeatures() before any view runs, so the cache is warm. Mirrors
// applyFeatureVisibility's "allow until we know it's off" rule, so an in-view
// affordance (e.g. the AI assistant box) is hidden only when the licence
// explicitly excludes its module — never merely because the cache is cold.
function featureEnabled(name) {
  return featureEntitled(name);
}

// --- Language (i18n) ---------------------------------------------------------
// Translation shim over public/i18n.js. NEW UI text goes through t(); the older
// screens keep their inline English until they are touched. `t` is safe to call
// before i18n.js has loaded (it degrades to the key), so nothing can crash on it.
function t(key, params) {
  return (window.I18n && window.I18n.t) ? window.I18n.t(key, params) : String(key);
}
// Counted lines pick their own singular/plural form from `key.one` / `key.other`
// — "1 test" and "3 tests" are different sentences, and a catalogue that only
// carries the plural gets the singular wrong in every language.
function plural(key, n, params) {
  return (window.I18n && window.I18n.plural)
    ? window.I18n.plural(key, n, params)
    : t(key, { count: String(n), ...(params || {}) });
}
function relTime(value) {
  return (window.I18n && window.I18n.relativeTime) ? window.I18n.relativeTime(value) : String(value || '');
}
// The sidebar, the nav toggle and the footer are static markup in index.html —
// render() never touches them, so a language switch would leave the whole rail
// in the previous language. These walk the shipped attributes instead:
//   data-i18n            → textContent
//   data-i18n-title      → title
//   data-i18n-aria-label → aria-label
// The markup keeps its English text as the fallback, so the rail reads
// correctly even if i18n.js failed to load.
function applyStaticTranslations(root = document) {
  if (!window.I18n) return;
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of root.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
}

// Set once the user explicitly picks a language, so loadProfile()'s one-time
// server reconcile can't overwrite a fresh choice still in flight (same guard
// as themeUserChoice).
let localeUserChoice = false;
// Applies a locale immediately and persists it to the account. The local apply
// never waits on the network; a failed save keeps the local choice.
function setLocale(locale, { persist = true } = {}) {
  if (!window.I18n) return Promise.resolve();
  const applied = window.I18n.setLocale(locale);
  // Keep the account-menu switch and the static sidebar in step, wherever the
  // change came from (the menu itself, or Settings → Appearance).
  renderLangSwitch();
  applyStaticTranslations();
  if (persist) {
    localeUserChoice = true;
    if (token) return api('/me/preferences', { method: 'PUT', body: { locale: applied } });
  }
  return Promise.resolve();
}
// Seed from the previous session's cached locale (or the browser language) so
// the first paint is right without waiting for GET /me.
function initLocale() {
  if (!window.I18n) return;
  const nav = (navigator && navigator.language) || '';
  window.I18n.setLocale(window.I18n.resolveLocale(window.I18n.storedLocale(), nav));
  applyStaticTranslations();
}

// The user's saved preferences (colour theme + dashboard language). Loaded once
// per session; the server value wins over the local cache so the chosen theme
// follows the user across browsers. Best-effort — a failure keeps the cache.
let profileLoaded = false;
async function loadProfile() {
  if (profileLoaded) return;
  profileLoaded = true;
  try {
    const me = await api('/me');
    const locale = me && me.preferences && me.preferences.locale;
    // Same precedence rule as the theme: a choice made this session wins.
    if (!localeUserChoice && window.I18n) {
      // No saved locale on this account → fall back to the browser language
      // rather than inheriting what another account cached in this browser.
      window.I18n.setLocale(window.I18n.resolveLocale(locale, (navigator && navigator.language) || ''));
      renderLangSwitch();
      applyStaticTranslations();
    }
    const theme = me && me.preferences && me.preferences.theme;
    // The theme belongs to this account. Skip only if the user already chose one
    // this session (e.g. toggled while this request was in flight) — their
    // deliberate choice must win.
    if (themeUserChoice) return;
    if (theme && THEME_KEYS.includes(theme)) {
      applyTheme(theme);
      try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage off */ }
    } else {
      // This account has no saved theme: fall back to the default rather than
      // inheriting a theme another account cached in this browser's localStorage.
      applyTheme('dark');
      try { localStorage.removeItem(THEME_KEY); } catch { /* storage off */ }
    }
  } catch { /* keep the cached theme */ }
}

function logout() {
  disconnectLive();
  invalidateFeatures();
  profileLoaded = false;
  token = null;
  email = '';
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(EMAIL_KEY);
  // The colour theme is per-account, so drop this account's cached choice and
  // revert to the default. The next sign-in loads that account's own theme
  // (loadProfile), preventing one account's theme from following another when
  // they share a browser.
  themeUserChoice = false;
  localStorage.removeItem(THEME_KEY);
  applyTheme('dark');
  render();
}

// ---- Modal ----------------------------------------------------------------
// ---- Password policy (client-side mirror) ---------------------------------
// These constants and rules MUST mirror src/auth/password.js
// (checkPasswordPolicy) — there is no build step, so the dashboard re-states the
// always-on policy to give live "criteria + strength" feedback before submit.
// The server re-checks on every create/reset and stays the source of truth
// (a violation is rejected with HTTP 422), so a drift here can never weaken it —
// it would only show over-optimistic feedback, so keep the two in lockstep.
const PW_MIN_LENGTH = 12;
const PW_MAX_LENGTH = 72;
const PW_MIN_CLASSES = 3;
const PW_CLASS_NAMES = ['lowercase', 'uppercase', 'digit', 'symbol'];

// Evaluates a plaintext password against the baseline policy. Returns the tick
// list the meter renders plus whether the whole policy is met.
function evaluatePassword(pw) {
  const s = typeof pw === 'string' ? pw : '';
  const classes = {
    lower: /[a-z]/.test(s),
    upper: /[A-Z]/.test(s),
    digit: /[0-9]/.test(s),
    symbol: /[^A-Za-z0-9]/.test(s),
  };
  const classCount = Object.values(classes).filter(Boolean).length;
  const tooLong = s.length > PW_MAX_LENGTH;
  const rules = [
    { label: `At least ${PW_MIN_LENGTH} characters`, ok: s.length >= PW_MIN_LENGTH },
    { label: `${PW_MIN_CLASSES} of 4: ${PW_CLASS_NAMES.join(', ')} (${classCount}/4 used)`, ok: classCount >= PW_MIN_CLASSES },
  ];
  // The 72-char cap only matters once exceeded — surface it as a failing rule
  // exactly when it bites, so the common case isn't cluttered with it.
  if (tooLong) rules.push({ label: `No more than ${PW_MAX_LENGTH} characters`, ok: false });
  const meetsPolicy = s.length >= PW_MIN_LENGTH && classCount >= PW_MIN_CLASSES && !tooLong;
  return { classCount, rules, meetsPolicy, length: s.length };
}

// Strength score 0..4 (length + character variety) — independent of the pass/
// fail policy, so a merely-compliant password reads "Fair"/"Good" and a longer,
// more varied one reads "Strong". Empty → level 0 (meter hidden by the caller).
function passwordStrength(ev) {
  if (ev.length === 0) return { level: 0, label: '' };
  let score = 0;
  if (ev.length >= 8) score += 1;
  if (ev.length >= PW_MIN_LENGTH) score += 1;
  if (ev.length >= 16) score += 1;
  score += Math.max(0, ev.classCount - 2); // variety bonus: 0..2
  const level = Math.max(1, Math.min(4, score));
  return { level, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][level] };
}

// Builds the live strength + criteria meter appended under a password input.
// `optional`: when the field may be left blank (edit flows that keep the current
// password), the meter stays hidden until the user starts typing.
// Returns { node, update } — the caller wires `update` to the input's `input`
// event and calls it once for the initial state.
function passwordMeter(input, { optional = false } = {}) {
  const fill = el('div', { class: 'fill' });
  const bar = el('div', { class: 'usagebar' }, fill);
  const strengthLabel = el('span', { class: 'pw-strength-label' });
  const accepted = el('span', { class: 'pw-accepted hidden' }, '✓ Meets requirements');
  const rules = el('ul', { class: 'pw-rules' });
  const node = el('div', { class: 'pw-meter' },
    el('div', { class: 'pw-strength-row' }, bar, strengthLabel, accepted),
    rules);
  function update() {
    const val = input.value;
    if (optional && val === '') { node.classList.add('hidden'); return; }
    node.classList.remove('hidden');
    const ev = evaluatePassword(val);
    const st = passwordStrength(ev);
    // Bar colour reads as an "accepted" signal: green only once the policy is
    // met, otherwise warn/bad by raw strength so weak input looks unfinished.
    const cls = ev.meetsPolicy ? 'ok' : (st.level >= 2 ? 'warn' : 'bad');
    fill.className = `fill ${cls}`;
    fill.style.width = `${st.level * 25}%`;
    strengthLabel.textContent = st.label;
    strengthLabel.className = `pw-strength-label lvl-${st.level}`;
    accepted.classList.toggle('hidden', !ev.meetsPolicy);
    rules.replaceChildren(...ev.rules.map((r) =>
      el('li', { class: r.ok ? 'ok' : '' }, el('span', { class: 'pw-tick' }, r.ok ? '✓' : '○'), r.label)));
  }
  return { node, update };
}

function openModal(title, fields, onSubmit) {
  const card = $('#modal-card');
  const inputs = {};
  const form = el('form', { class: 'form-grid' });
  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      input = el('select', {}, ...f.options.map((o) => el('option', { value: o.value, ...(o.value === f.value ? { selected: 'selected' } : {}) }, o.label)));
    } else if (f.type === 'textarea') {
      input = el('textarea', { rows: 3 }, f.value || '');
    } else if (f.type === 'password-strength') {
      input = el('input', { type: 'password', value: f.value ?? '', autocomplete: 'new-password', spellcheck: 'false' });
    } else {
      input = el('input', { type: f.type || 'text', value: f.value ?? '' });
    }
    inputs[f.name] = input;
    const lbl = el('label', {}, f.label, input);
    // Optional per-field guidance ("what is this / why does it matter") — rendered
    // as a small muted note under the input. Backward-compatible: callers that
    // pass no `hint` are unaffected.
    if (f.hint) lbl.append(el('span', { class: 'field-hint' }, f.hint));
    // A password field can opt into the live strength + criteria meter.
    if (f.type === 'password-strength') {
      const meter = passwordMeter(input, { optional: f.optional });
      lbl.append(meter.node);
      input.addEventListener('input', meter.update);
      meter.update();
    }
    form.append(lbl);
  }
  const errP = el('p', { class: 'error' });
  form.append(errP);
  form.append(el('div', { class: 'form-actions' },
    el('button', { type: 'button', class: 'ghost', onclick: closeModal }, 'Cancel'),
    el('button', { type: 'submit' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const [k, node] of Object.entries(inputs)) values[k] = node.value;
    // onSubmit decides whether to close (some flows re-render the modal, e.g.
    // to show a one-time code), so don't auto-close here.
    try { await onSubmit(values); }
    // Prefer the server's field-level validation details (e.g. the 422 password
    // policy list) over the generic top-line message; errText falls back to it.
    catch (err) { errP.textContent = errText(err); }
  });
  card.replaceChildren(el('h3', {}, title), form);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').classList.remove('wide'); }

// Accessibility for the (single, shared) modal — installed once at startup, so it
// covers every modal flow without each open-site repeating it. On open it moves
// focus into the dialog and labels it from its heading; on close it restores
// focus to whatever was focused before. Escape closes; Tab is trapped inside the
// dialog (so keyboard users can't tab out into the inert page behind it).
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let modalReturnFocus = null;
function focusablesIn(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SEL)).filter((e) => e.offsetParent !== null);
}
function installModalA11y() {
  const modal = $('#modal');
  const card = $('#modal-card');
  if (!modal || !card) return;
  const obs = new MutationObserver(() => {
    const open = !modal.classList.contains('hidden');
    if (open && !modal._a11yOpen) {
      modal._a11yOpen = true;
      modalReturnFocus = document.activeElement;
      const h = card.querySelector('h3, h2');
      modal.setAttribute('aria-label', (h && h.textContent) || 'Dialog');
      const f = focusablesIn(card);
      (f[0] || card).focus();
    } else if (!open && modal._a11yOpen) {
      modal._a11yOpen = false;
      if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') modalReturnFocus.focus();
      modalReturnFocus = null;
    }
  });
  obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const f = focusablesIn(card);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// ---- First-run prompt: the agent signing key ------------------------------
// On an admin's first authenticated render, if no agent signing key exists yet, pop
// a prompt to generate it — it's required before any agent can be onboarded. Shown
// at most once per session (dismiss with "Later"); the Enrollment banner and
// Settings → Agent key remain as the other entry points. Reset on each login.
let signingKeyPromptDone = false;
async function maybePromptSigningKey() {
  if (signingKeyPromptDone) return;
  if (role !== 'admin') { signingKeyPromptDone = true; return; }
  if (modalOpen()) return; // don't clobber another modal — retry on the next render
  let status;
  try { status = await api('/api/settings/agent-release-key'); }
  catch { return; } // transient (e.g. session still settling) — retry next render
  signingKeyPromptDone = true;
  if (!status || status.configured) return;
  if (!modalOpen()) showSigningKeySetupPrompt();
}

function showSigningKeySetupPrompt() {
  const card = $('#modal-card');
  const genBtn = el('button', { type: 'button', onclick: () => generate() }, 'Generate signing key');
  card.replaceChildren(
    el('h3', {}, 'Set up the agent signing key'),
    el('div', { class: 'setup-prompt' },
      el('p', {}, 'Before you can add agents, this server needs an ', el('strong', {}, 'agent signing key'), '.'),
      el('p', { class: 'muted' }, 'It is generated here, on the server, and is the trust anchor for secure agent management — the server signs agent updates with it and the agents verify them. The private key never leaves the server and is never shown. You can delete it later, but agents cannot be added or upgraded from the server until a key exists.'),
      el('div', { class: 'form-actions' },
        el('button', { type: 'button', class: 'ghost', onclick: closeModal }, 'Later'),
        genBtn)));
  $('#modal').classList.remove('hidden');

  async function generate() {
    genBtn.disabled = true;
    try {
      await api('/api/settings/agent-release-key', { method: 'POST' });
      toast('Signing key generated — you can now add agents.');
      closeModal();
      render();
    } catch (err) { toast(errText(err), true); genBtn.disabled = false; }
  }
}

// ---- Views ----------------------------------------------------------------
// ---- Per-page explanation (hero + slide-in info drawer) -------------------
// Each view starts with a short hero line and a “More info” button that slides
// in a panel from the right with a fuller explanation.

// Cross-links used inside the info drawers. A help entry can point at the page
// that actually owns a feature it mentions: the link closes the drawer and
// switches to that view (or Settings sub-tab), exactly like clicking the tab.
// Labels mirror the top nav. A link whose target tab is hidden (licence/role)
// degrades to plain text, so the help never offers a dead end.
const VIEW_LABELS = {
  fleet: 'Overview', overview: 'Traffic', map: 'Sites', geo: 'Destinations', agents: 'Agents',
  interfaces: 'Interfaces', probes: 'Probes', tests: 'Tests', flows: 'Flows',
  findings: 'Analysis', reporting: 'Reporting', locations: 'Locations', enrollment: 'Enrollment', settings: 'Settings',
  docs: 'Documentation', investigation: 'Troubleshooting', nics: 'NICs', events: 'Events',
  serviceAssurance: 'Service Assurance', guide: 'Guides',
  logs: 'System Logs', userLogs: 'User Logs',
};
function gotoView(viewKey) {
  closeDrawer();
  // Probes and Tests share one view now; a 'tests' link opens the packages sub-tab.
  if (viewKey === 'tests') { probesTab = 'packages'; viewKey = 'probes'; }
  else if (viewKey === 'probes') { probesTab = 'run'; }
  currentView = viewKey;
  render();
}
// ---- Tabs -----------------------------------------------------------------
// A tab is not a button, and until this existed the dashboard drew it as one:
// a row of `small ghost` buttons where the selected one had a slightly
// different background. Next to a form's Save/Cancel — often on the same screen
// — nothing said which row switched a view and which row did something.
//
// So a tab strip looks like a tab strip: no button chrome, muted labels, and
// the selected one carrying the accent underline on the strip's own rule. It
// also BEHAVES like one, which is the half a stylesheet cannot do: the strip is
// one stop in the tab order (arrow keys move between the tabs, Home/End jump to
// the ends) and it announces itself as a tablist, so a screen reader says "tab
// 2 of 3, selected" instead of reading out three unrelated buttons.
//
//   tabStrip([['run', 'Run a probe'], ['packages', 'Test packages']], {
//     active: probesTab,
//     onPick: (key) => { probesTab = key; render(); },
//   })
//
// Returns the strip, with `setActive(key)` for the callers that switch tabs
// without re-rendering the whole screen.
function tabStrip(items, { active = null, onPick = null, className = '', ariaLabel = null } = {}) {
  const list = items.filter(Boolean);
  const strip = el('div', {
    class: `subtabs${className ? ` ${className}` : ''}`,
    role: 'tablist',
    ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
  });
  const buttons = [];

  const focusAt = (i) => {
    const next = buttons[(i + buttons.length) % buttons.length];
    if (next) next.focus();
  };

  function setActive(key) {
    for (const b of buttons) {
      const on = b.dataset.tab === String(key);
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      // One stop in the tab order: Tab enters the strip at the selected tab and
      // leaves it, arrows move within. This is what the pattern is for.
      b.tabIndex = on ? 0 : -1;
    }
    // Nothing selected (a view whose tab key is not in this strip) would trap
    // the keyboard with no way in, so the first tab stays reachable.
    if (!buttons.some((b) => b.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0;
  }

  list.forEach(([key, label], i) => {
    const btn = el('button', {
      type: 'button',
      class: 'subtab',
      role: 'tab',
      'data-tab': String(key),
      onclick: () => { setActive(key); if (onPick) onPick(key); },
      onkeydown: (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
        if (step) { e.preventDefault(); focusAt(i + step); return; }
        if (e.key === 'Home') { e.preventDefault(); focusAt(0); return; }
        if (e.key === 'End') { e.preventDefault(); focusAt(buttons.length - 1); }
      },
    }, label);
    buttons.push(btn);
    strip.append(btn);
  });

  setActive(active);
  strip.setActive = setActive;
  return strip;
}

// Why a nav entry cannot be opened: 'role' (above the user's role), 'licence'
// (not in this licence) or null (it can). One reading of the nav, used by the
// help drawers' viewLink and by the guides, so a link is never offered where
// the tab itself is hidden.
function viewBlockedReason(viewKey) {
  const tab = document.querySelector(`.tabs button[data-view="${viewKey}"]`);
  if (!tab) return null;
  if (tab.classList.contains('locked')) return 'licence';
  if (tab.classList.contains('role-hidden')) return 'role';
  if (tab.classList.contains('hidden')) return 'role';
  return null;
}
function viewLink(viewKey, label) {
  const text = label || VIEW_LABELS[viewKey] || viewKey;
  if (viewBlockedReason(viewKey)) return document.createTextNode(text);
  return el('a', { href: '#', class: 'drawer-link', onclick: (e) => { e.preventDefault(); gotoView(viewKey); } }, text);
}
// Deep-link into a specific Settings sub-tab (Analysis, Retention, Traffic types…).
function settingsLink(tab, label) {
  return el('a', { href: '#', class: 'drawer-link',
    onclick: (e) => { e.preventDefault(); closeDrawer(); settingsTab = tab; currentView = 'settings'; render(); } }, label);
}

// Deep-link into a specific Documentation article. Used where a message tells
// someone to read something: pointing at "the documentation" without saying
// where is the same as not telling them.
function docsLink(topicId, label) {
  return el('a', { href: '#', class: 'drawer-link',
    onclick: (e) => { e.preventDefault(); closeDrawer(); docsTopic = topicId; currentView = 'docs'; render(); } }, label);
}
function gotoDocs(topicId) { closeDrawer(); docsTopic = topicId; currentView = 'docs'; render(); }

const PAGE_INFO = {
  // The only PAGE_INFO entry written through t() from the start: the guide is new
  // text, and new UI text goes through the translation layer (CLAUDE.md). The
  // older entries below are still hardcoded English and migrate opportunistically.
  guide: {
    // Getters, not strings: the catalogue is read when the hero is drawn, so the
    // page follows a language switch without a reload.
    get hero() { return t('guide.info.hero'); },
    get title() { return t('guide.info.title'); },
    body: () => [
      el('p', {}, t('guide.info.p1')),
      el('p', {}, t('guide.info.p2')),
      el('p', { class: 'muted' }, t('guide.info.p3')),
    ],
  },
  serviceAssurance: {
    hero: 'Know when your digital services stop working — before your users do.',
    title: 'Service Assurance — synthetic monitoring of your web services',
    body: () => [
      el('p', {}, 'Register the web application you depend on, let ', el('strong', {}, 'Discovery'), ' look around it, and accept the tests it suggests. A test is a journey a real user takes — sign in, look up a customer, place an order — run on a schedule from a real browser.'),
      el('p', {}, 'Nothing here needs code. Steps are built by dragging them into order and filling in forms; selectors, timeouts and the raw engine error live behind ', el('strong', {}, 'Technical details'), ' and are never needed to build or read a test.'),
      el('p', {}, 'Discovery is ', el('strong', {}, 'read-only'), '. It never submits a form and never clicks anything that could delete, pay or send — anything whose effect it cannot determine is recorded and left alone.'),
      el('p', {}, el('strong', {}, 'Journeys '), 'are what make a set of tests mean something. A journey is a complete thing a user does \u2014 sign in, look up a customer, open the case \u2014 and the tests under it are how BlueEyes proves it still works. A required step failing means the user cannot get through; an optional one failing means part of the service is gone, but the journey is not. Every verdict comes with the sentence that explains it.'),
      el('p', { class: 'muted' }, 'Service Assurance only reaches an application\u2019s own address and the hosts an administrator has explicitly allowed. Loopback and cloud-metadata addresses can never be allowed, at any permission level.'),
    ],
  },
  changes: {
    hero: 'What happened since you last looked — agent and link transitions, new anomalies and events, playbook runs and configuration changes, newest first.',
    title: 'Changes — since you last looked',
    body: () => [
      el('p', {}, 'This is the landing page because a dashboard full of green answers a question nobody asked. The shift starts with ', el('strong', {}, 'what happened while I was away'), ' — so this page shows change, not status.'),
      el('p', {}, 'Pick a window, or leave it on ', el('strong', {}, 'since you last looked'), '. That reference point moves ', el('strong', {}, 'only'), ' when you press “Mark as seen” — never just because you opened the page — so it can still tell you what is new next time.'),
      el('p', {}, 'Rows marked ', el('strong', {}, 'current state'), ' are conditions rather than transitions. A stale heartbeat or an agent running an old version is something we know is true ', el('em', {}, 'now'), '; neither is recorded as a transition, so we cannot say when it started, and we would rather say that than invent a time.'),
      el('p', { class: 'muted' }, 'The Fleet page is still the right screen for bulk operations across agents — it just was not the right screen to open on.'),
    ],
  },
  docs: {
    hero: 'Documentation & how-to guides — step-by-step troubleshooting walkthroughs with worked examples, plus (for admins) setup guides for integrations like ServiceNow, including what a working connection and a failure look like.',
    title: 'Documentation — guides & how-tos',
    body: () => [
      el('p', {}, 'A built-in handbook. The ', el('strong', {}, 'Getting started'), ' and ', el('strong', {}, 'Troubleshooting how-tos'), ' sections are available to everyone and walk through real tasks — diagnosing an offline agent, chasing latency to a destination, reading a finding — using the pages you already have.'),
      el('p', {}, 'The ', el('strong', {}, 'Administration & setup'), ' section is admin-only. It explains how to wire up external systems (ServiceNow ITSM/CMDB, alerting, SSO/LDAP, enrollment) — exactly what each field needs and what a successful vs. failed connection looks like, so you can tell a misconfiguration from an outage.'),
      el('p', { class: 'muted' }, 'Links inside an article jump straight to the relevant page or Settings tab. Links to a page your role or licence hides simply render as plain text.'),
    ],
  },
  troubleshooting: {
    hero: 'One screen for an outage: what is failing, what it affects, and when it started — correlated root causes, the L2/L3 topology coloured by state, baseline deviations and a change timeline, all from a single read.',
    title: 'Troubleshooting — the consolidated fault view',
    body: () => [
      el('p', {}, 'Aggregates five existing capabilities into one screen so you do not have to switch views mid-outage: topology rediscovery (LLDP), service-dependency mapping, blast radius, per-flow-pair baselining and active discovery. It owns no data of its own — every number here is the same one the underlying page would show.'),
      el('p', {}, el('strong', {}, 'Root causes'), ' are the alarm rollup. The cross-agent correlator groups anomalies firing on ≥2 agents into one cause, so twenty devices reporting the same uplink failure appear as ', el('strong', {}, 'one'), ' entry, not twenty. The key figures spell the collapse out: "47 alarms → 3 causes".'),
      el('p', {}, el('strong', {}, 'Blast radius'), ' under each cause names what is affected ', el('em', {}, 'beyond'), ' the devices already listed — L2-isolated hosts first, then services that depend on them. ', el('strong', {}, 'Show path'), ' highlights that path on the topology graph; ', el('strong', {}, 'What changed?'), ' lists the config pushes, port flaps and new routes recorded in the 30 minutes before the fault started.'),
      el('p', {}, 'On the topology graph, ', el('strong', {}, 'green'), ' is a reporting agent, ', el('strong', {}, 'red'), ' is an agent that is down, and ', el('strong', {}, 'grey'), ' means the host sits behind a down node — we cannot hear it, which is not the same as knowing it is broken. Toggle between L2 adjacencies and L3 service dependencies, or show both.'),
      el('p', {}, el('strong', {}, 'Baseline deviations'), ' are flow pairs off their own weekday/hour median — a pair that normally moves 1 GB at 09:00 on a Monday and today moved 4 GB. Drag across the ', el('strong', {}, 'Timeline'), ' to narrow the event list to a window.'),
      el('p', {}, el('strong', {}, 'Active faults'), ' counts the raw alarms behind those causes. The figure is cheap; the rows behind it are not — a busy fleet carries tens of thousands — so the page does ', el('strong', {}, 'not'), ' load them. Use the link on the card to list them, one page at a time, with a counter saying how far it has got. Everything else on this screen is there before you ask.'),
      el('p', { class: 'muted' }, 'Operator+ — it aggregates data that is itself operator-gated, so it never widens access. Discovery candidates (addresses seen on the wire but not monitored) are listed for admins only. If one source is unavailable the page says so and keeps the remaining panels rather than failing whole.'),
    ],
  },
  topology: {
    hero: 'Dependency map — who talks to whom, built from the 5-tuple flows your agents already report (NetFlow/sFlow). Filter by site to scope the graph to one location.',
    title: 'Topology — flow-derived dependencies',
    body: () => [
      el('p', {}, 'Aggregates observed src→dst conversations into a directed, byte-weighted graph: each edge is a dependency, each node a host or external peer. Complements ', viewLink('flows', 'Flows'), ' (raw conversations) and the per-target path map — this is the service/host dependency view. Metadata only: addresses, ports, ASNs and byte/flow counts, never payload.'),
      el('p', {}, 'The ', el('strong', {}, 'Diagram'), ' draws the busiest hosts as a force-directed graph — circle size is traffic volume, line width is bytes between two hosts, green rings mark internal (RFC1918) hosts and amber rings mark external peers. Click a host to highlight its neighbourhood and open Ping/Show route for it, same as a table row.'),
      el('p', {}, 'The ', el('strong', {}, 'Map'), ' plots the same data geographically: external peers by country (circle size = traffic), your sites as anchor pins, and the observed dependencies as routes between them. Internal (private) hosts are never geolocated, so the map covers only the external subset — the Diagram remains the view for the internal structure. Routes internal→external are drawn from a single anchor site, so pick a ', el('strong', {}, 'Site'), ' to see its routes to external peers.'),
      el('p', {}, 'Use the ', el('strong', {}, 'Site'), ' filter to scope the graph to one location and reduce noise. Use the ', el('strong', {}, 'Window'), ' selector to widen or narrow the time range covered.'),
      el('p', { class: 'muted' }, 'Only agents whose traffic source is NetFlow or sFlow contribute flow records; the heaviest dependencies/hosts are shown when the graph is large.'),
    ],
  },
  screening: {
    hero: 'Test Settings — one place to verify every outbound integration: send a test email, reach your ITSM/IPAM receivers, check SSO and the other services BlueEyes talks to — each with a security check.',
    title: 'Test Settings — connectivity & security screening',
    body: () => [
      el('p', {}, 'A consolidated, admin-only screening of everything BlueEyes reaches OUTWARD to. Each target gets two verdicts: a live connectivity test and a security-posture check (HTTPS vs plaintext, TLS, signed webhooks, authentication, certificate/secret presence, licence state).'),
      el('div', { class: 'callout' },
        el('strong', {}, 'Running a test sends real traffic: '),
        el('span', {}, 'the email / webhook / syslog tests deliver an actual test message, and an ITSM/IPAM test performs a real (read-only) connectivity call to the receiver. SSO and the other services are probed for reachability.')),
      el('h4', {}, 'What is screened'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Email & alert channels '), '— SMTP email, webhook and syslog. Configure under ', viewLink('settings', 'Settings → Alerting'), '.'),
        el('li', {}, el('strong', {}, 'ITSM / API receivers '), '— ServiceNow, Jira/TOPdesk/GLPI, a generic webhook or a custom ticket API, and the Nautobot device sync (Settings → ITSM).'),
        el('li', {}, el('strong', {}, 'CMDB / asset inventory '), '— the single CMDB source agents link to: ServiceNow, Nautobot, NetBox, i-doit, GLPI or a custom source (Settings → CMDB).'),
        el('li', {}, el('strong', {}, 'Authentication (SSO) '), '— LDAP/AD bind, OIDC discovery and the SAML IdP.'),
        el('li', {}, el('strong', {}, 'Other outbound services '), '— the AI assistant endpoint, map tiles / geocoder and the licence server.')),
      el('h4', {}, 'Reading the result'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'OK '), '— reachable and securely configured.'),
        el('li', {}, el('strong', {}, 'Warning '), '— reachable but worth hardening (e.g. an unsigned webhook, plaintext syslog).'),
        el('li', {}, el('strong', {}, 'Critical '), '— failed to connect, or an insecure configuration (e.g. plaintext HTTP, no authentication).'),
        el('li', {}, el('strong', {}, 'Info '), '— not configured / not applicable.')),
      el('p', { class: 'muted' }, 'Hover a check chip for the reason behind it. No secrets are ever shown on this page.'),
    ],
  },
  tests: {
    hero: 'Reusable test packages — run the same checks on a schedule across many agents. (For a quick one-off check from a single agent, use Probes instead.)',
    title: 'Tests — packages pushed to agents',
    body: () => [
      el('div', { class: 'callout' },
        el('strong', {}, 'Probes vs. Tests: '),
        el('span', {}, 'A ', viewLink('probes', 'Probe'), ' is a single check you run by hand, right now, from one agent — handy for troubleshooting. A ', el('strong', {}, 'Test'), ' (this tab) is a saved, reusable package of those same checks, aimed at many agents (all / specific / by location) and run on a recurring schedule (or on demand). Same probe engine underneath; Tests add naming, fleet targeting and recurrence.')),
      el('p', {}, 'A test package is a named set of tests (ping / TCP / DNS / traceroute / cURL content check / page load / multi-step transaction / throughput / speed test) with a target selector and an optional schedule. The server pushes the tests to the selected, connected agents; each agent runs them and reports back — results appear on the ', viewLink('probes'), ' and ', viewLink('overview', 'Traffic'), ' pages as usual. A cURL test verifies the received HTTP response — status code, body match and a header — not just reachability.'),
      el('h4', {}, 'Targets'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'All agents '), '— every enrolled agent.'),
        el('li', {}, el('strong', {}, 'Specific agents '), '— pick individual agents.'),
        el('li', {}, el('strong', {}, 'By location '), '— every agent at the chosen sites.')),
      el('h4', {}, 'Schedule'),
      el('p', {}, 'Choose Manual (run on demand with “Run now”) or an interval from 1 minute up to 24 hours. The schedule applies to every target agent in the package; for different cadences, create separate packages.'),
      el('h4', {}, 'Predefined tests'),
      el('p', {}, 'Use “Add a predefined test” for common checks (internet latency, DNS, web reachability, path trace, throughput snapshot), or build a custom one. Metadata only: targets and timings, never payload.'),
      el('p', { class: 'muted' }, 'A run only reaches agents connected at that moment; offline agents pick up the next scheduled run when they reconnect.'),
    ],
  },
  fleet: {
    hero: 'All agents in one view — with a health assessment based on active reachability, packet loss, latency and jitter.',
    title: 'Overview — fleet health',
    body: () => [
      el('p', {}, 'The landing page collects all agents with a single health stamp, so you immediately see where something is wrong. Rows are sorted worst-first and refresh continuously. Click an agent to drill into its measurements.'),
      el('h4', {}, 'Filtering with the metric cards'),
      el('p', {}, 'The four metric cards are active filters — click a card (anywhere on it, or focus it and press Enter/Space) to narrow the grid. ', el('strong', {}, 'Kritiske'), ' and ', el('strong', {}, 'Advarsler'), ' filter to critical / warning agents (both can be on at once), ', el('strong', {}, 'Offline'), ' to disconnected agents; filters stack with AND and a count line ("3 af 47 agenter") appears above the table. ', el('strong', {}, 'Fleet health'), ' does not filter — it sorts the grid by health score, worst-first. A chip row above the cards shows every active filter (✕ to drop one, "Ryd alle" to clear); the filter is mirrored into the URL, so a filtered view can be shared as a link (e.g. ', el('code', {}, '?severity=CRIT&site=vest'), ') and opens pre-filtered.'),
      el('h4', {}, 'Two independent verdicts'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Health '), '— is the monitored network OK right now? Driven by active reachability, loss, latency, jitter and interface/link state.'),
        el('li', {}, el('strong', {}, 'Data quality '), '— can we trust the numbers this agent sends? A separate check of collector packet drops, agent⇄server clock skew and agent version. ', el('em', {}, 'It never looks at link state'), ' — so an agent can read CRITICAL (a link is down) while data quality stays OK (the reading itself is reliable). The two are not in conflict; they answer different questions.')),
      el('h4', {}, 'How health is calculated'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Reachability: '), 'does the agent\'s probe target respond? A target with no reply pulls health down immediately.'),
        el('li', {}, el('strong', {}, 'Packet loss: '), 'loss in % (≥2% = warning, ≥20% = critical).'),
        el('li', {}, el('strong', {}, 'Latency: '), 'latest RTT compared against the target\'s OWN baseline (robust median + MAD) — “slow” is relative to what is normal for that specific target, not a fixed threshold.'),
        el('li', {}, el('strong', {}, 'Jitter: '), 'variation in RTT (≥30 ms = warning, ≥100 ms = critical).'),
        el('li', {}, el('strong', {}, 'Interfaces: '), 'a physical link reported down, interface errors or saturation also pull health down. A down virtual/idle port (docker0, veth…, VPN tunnels) is expected and does ', el('em', {}, 'not'), ' count.')),
      el('h4', {}, 'Status stamps'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'HEALTHY: '), 'all targets reachable, low latency/loss, links OK.'),
        el('li', {}, el('strong', {}, 'WARNING / CRITICAL: '), 'one or more signals above threshold — heavy loss, a latency spike, or a real link down/errored. Hover the stamp for the exact reason.'),
        el('li', {}, el('strong', {}, 'DOWN: '), 'no probe targets respond at all.'),
        el('li', {}, el('strong', {}, 'STALE: '), 'no fresh measurements (> 15 min), or the agent is disconnected — its readings can no longer be trusted, so it is never shown HEALTHY off old data.'),
        el('li', {}, el('strong', {}, 'UNKNOWN: '), 'agent has not run any probe yet (a healthy link alone does not make it HEALTHY).')),
      el('h4', {}, 'KPI strip & network path'),
      el('p', {}, 'Above the list, a strip of live KPIs (latency, loss, jitter, active agents, monitored paths, alerts) and a network-path diagram (Origin → ISP → Cloud → SaaS) summarise the selected scope at a glance. The diagram is data-driven: the origin node names the site (or the whole fleet) and its online agents, and each segment\'s colour, label and hover tooltip come from that scope\'s own probe metrics — worst packet loss on the local access link, median RTT and jitter on the WAN uplink, and target reachability on the SaaS leg (the SaaS node shows the real count of monitored targets). A segment turns amber at a warning threshold and red when critical. Both the KPIs and the path summarise ', el('strong', {}, 'all'), ' agents by default; use the ', el('strong', {}, 'Location'), ' selector to scope them to a single site — which recomputes every segment and drops the fleet-only "Branch" origin, so the picture changes with your selection.'),
      el('h4', {}, 'Open issues (Professional+)'),
      el('p', {}, 'On Professional licences and above, the page ends with an ', el('strong', {}, 'Open issues'), ' rollup: the currently-active ', el('strong', {}, 'probe outages'), ' (derived from the probe thresholds — click one to drill into the affected agent) beside the most recent unacknowledged analysis ', viewLink('findings', 'findings'), ', each with its explanation. It is composed from data the server already holds — no new collection — and is gated by the ', el('strong', {}, 'dashboard_advanced'), ' licence feature; below Professional the rollup is simply omitted and the rest of the page is unchanged.'),
      el('p', { class: 'muted' }, 'Health is based on active probes — run a few per agent on ', viewLink('probes'), ' (or schedule them fleet-wide via ', viewLink('tests'), ') for a complete picture; the interface signal comes from ', viewLink('interfaces'), '. Metadata only: targets and timings, never packet contents.'),
    ],
  },
  location: {
    hero: 'Everything for one site in one place: its agents with health verdicts, a scoped health summary, and the site\'s data flows on a map — click any flow to inspect it in Flows.',
    title: 'Location — site drill-down',
    body: () => [
      el('p', {}, 'The combined page for one location. Reached by clicking a location on the ', viewLink('locations', 'Locations'), ' list, the site name on an agent page, or a site pin on a traffic map.'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Health summary'), ' — the Overview KPI cards scoped to just this site\'s agents: online count, median latency/jitter, worst packet loss, monitored targets and alerts.'),
        el('li', {}, el('strong', {}, 'Agents'), ' — every agent at the site with connection state, health verdict, loss/latency/jitter, throughput, agent version and last-seen. Click a row for the agent\'s own page.'),
        el('li', {}, el('strong', {}, 'Data flows'), ' — the site\'s external traffic as colored directional arrows (color = traffic type, moving dashes = direction, width = volume) plus a top-flows list. Clicking a flow opens ', viewLink('flows', 'Flows'), ' in Map mode scoped to this site.')),
      el('p', { class: 'muted' }, 'Public destinations are placed at country level; internal (RFC1918) traffic is never geolocated.'),
    ],
  },
  agent: {
    hero: 'Everything for one agent in one place: health summary, probes (latency/loss/jitter), interface health and traffic.',
    title: 'Agent — details',
    body: () => [
      el('p', {}, 'The combined troubleshooting page for one agent. At the top a health summary with the numbers driving the assessment; below you can expand the individual data sources.'),
      el('h4', {}, 'Reading the top summary'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Health stamp '), '(HEALTHY / WARNING / CRITICAL / DOWN / STALE) — the worst of reachability, loss, latency, jitter and interface/link state. A disconnected agent reads STALE (not HEALTHY) — with no fresh probes, its last readings cannot vouch for current health. The line beside it is the single reason that drove it (e.g. “Link down (eth0)”).'),
        el('li', {}, el('strong', {}, 'Data quality '), '(OK / WARN / BAD) — a separate verdict on whether the agent\'s readings can be trusted: collector packet drops, clock skew vs. the server, and agent version. This is why you can see CRITICAL up top and “Data quality: OK” just below — the first judges the network, the second judges the measurement.')),
      el('h4', {}, 'Data sources'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Probes: '), 'run ping/TCP/DNS/traceroute/path-MTU against a target. Each result says what IT measured — latency and loss for a ping, hop count for a trace, packet size for a path-MTU check — and clicking the row opens its detail in place: history, path map, or per-hop verdict.'),
        el('li', {}, el('strong', {}, 'Interfaces: '), 'per-interface utilization, errors, discards and link status from the latest measurement. A virtual/idle port that is simply down (docker0, veth…, tunnels) shows a neutral IDLE — only a real link down reads DOWN.'),
        el('li', {}, el('strong', {}, 'Traffic: '), 'current bandwidth — most useful here when you are already investigating a specific agent.')),
      el('p', { class: 'muted' }, 'Return to the fleet overview with “← Overview”. Fleet-wide views of the same data sources: ', viewLink('probes'), ' · ', viewLink('interfaces'), ' · ', viewLink('overview', 'Traffic'), '.'),
    ],
  },
  overview: {
    hero: 'Aggregated live traffic picture for all agents — select series, inspect a time window and review consumption.',
    title: 'Traffic — overview',
    body: () => [
      el('p', {}, 'A wide live chart of traffic across all agents. It updates every 3 seconds and shows the last ~3 minutes with timestamps (HH:MM:SS) along the x-axis.'),
      el('h4', {}, 'Select what is shown'),
      el('ul', {},
        el('li', {}, 'Chips in the chart toolbar toggle Total RX and Total TX on/off.'),
        el('li', {}, '”Per agent ▾” opens a menu where you can add RX/TX for each individual agent.'),
        el('li', {}, '”↺ Reset zoom” returns to the live rolling view after you have zoomed into a window (see below).')),
      el('h4', {}, 'Inspect a time window'),
      el('p', {}, 'Drag across the chart to zoom into that timespan — the chart freezes to the selected window so you can read it. Click ”↺ Reset zoom” (or right-click the chart) to return to the live view.'),
      el('h4', {}, 'Rest of the page'),
      el('ul', {},
        el('li', {}, 'KPI strip at the top: current RX/TX, online agents and number of locations.'),
        el('li', {}, 'The storage line shows disk usage + estimated consumption per day (“Details” expands the split breakdown: the drive plus the MySQL and TimescaleDB databases side by side — TimescaleDB shows “not configured” until the telemetry store is wired).'),
        el('li', {}, 'At the bottom you can expand Top agents, History (select agent + period) and Traffic type (DNS, Facebook etc.) — those categories are defined under ', settingsLink('types', 'Settings → Traffic types'), '.')),
      el('p', { class: 'muted' }, 'Related views: ', viewLink('geo'), ' (where the traffic goes on a map) and ', viewLink('flows'), ' (individual conversations).'),
    ],
  },
  map: {
    hero: 'Your sites on a map — each marker coloured by the worst agent health at that site.',
    title: 'Sites',
    body: () => [
      el('p', {}, 'Each location with coordinates is a marker, coloured by the worst health verdict among its agents (green = healthy, amber = warning, red = critical, grey = unknown/offline) — the same verdict as ', viewLink('fleet', 'Overview'), '. The page refreshes itself so the colours stay live.'),
      el('p', {}, 'Click a marker for the site\'s agents and how many are online; click an agent in the popup to open it.'),
      el('p', { class: 'muted' }, 'Add coordinates per location under ', viewLink('locations'), ' (Edit). Map tiles come from the server\'s configured (EU/self-hosted) source. If the map is missing, the library could not be reached — a list is shown instead.'),
    ],
  },
  agents: {
    hero: 'Monitor the agents that report traffic to this server.',
    title: 'Agents',
    body: () => [
      el('p', {}, 'Agents are installed on customer machines and report network traffic to the server.'),
      el('h4', {}, 'Status & health'),
      el('ul', {},
        el('li', {}, 'Status: online/offline based on the WebSocket connection. Click the badge for a connection diagnosis — why the agent is offline, the evidence behind it, and a “Force reconnect” for connected agents (connections are agent-initiated, so an offline agent is revived from its own host).'),
        el('li', {}, 'Health: “healthy” = online and reported within 5 min., “delayed” = online but stale report, “down” = offline.'),
        el('li', {}, 'Last reported: the time of the agent\'s most recent traffic measurement.')),
      el('h4', {}, 'Actions'),
      el('ul', {},
        el('li', {}, '”+ New agent” (operator+) opens ', viewLink('enrollment'), ', where you generate a code and a ready-to-run install one-liner.'),
        el('li', {}, '”Run test” asks the agent to measure immediately; “Traffic” shows the measurements.'),
        el('li', {}, '”Edit” sets name, location, notes and traffic source (proc, SNMP, NetFlow or sFlow).'),
        el('li', {}, '”Upgrade” (admin) rebuilds a systemd-managed agent from the server\'s published source and restarts it — always available for a manual re-deploy; it shows as a highlighted “Update” when the agent is behind.'),
        el('li', {}, 'A ', el('strong', {}, 'Windows'), ' agent can\'t be upgraded from the server (it runs as a scheduled task). When it is behind, “Update” hands you a PowerShell one-liner to run on that host: it updates the installed agent in place, keeps its token and identity, and never enrolls a second agent — no re-install.'),
        el('li', {}, 'Docker/unmanaged agents can\'t self-update either: their version line shows an “update · installer” badge (and an “Installer” button) — update those by re-running the installer on the host.')),
      el('p', { class: 'muted' }, 'Group agents by site under ', viewLink('locations'), '; see them all with a single health verdict on ', viewLink('fleet', 'Overview'), '.'),
    ],
  },
  interfaces: {
    hero: 'Interface health per agent: utilization, errors, discards, link status and speed.',
    title: 'Interfaces',
    body: () => [
      el('p', {}, 'Shows each agent\'s network interfaces based on the latest measurement — what network/firewall engineers look at when something is wrong physically or on a link.'),
      el('h4', {}, 'Columns'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Status: '), 'DOWN (a real link is down), ERR (input/output errors or ≥90% utilized), WARN (discards or ≥75% utilized), IDLE (a virtual/idle port — docker0, veth…, VPN tunnels — that is down only because nothing is using it, which is normal), OK.'),
        el('li', {}, el('strong', {}, 'Utilization: '), 'rate against link speed (only when speed is known).'),
        el('li', {}, el('strong', {}, 'Errors/s and Discards/s: '), 'CRC/input errors and dropped packets (congestion) respectively.')),
      el('p', { class: 'muted' }, 'Data comes from the agent\'s traffic source: /proc/net/dev (host) or SNMP IF-MIB (device). Errors/discards/link status require an updated agent. An IDLE virtual interface never escalates an agent to CRITICAL — only a real link going down does. Interface state also feeds the health verdict on ', viewLink('fleet', 'Overview'), '.'),
    ],
  },
  nics: {
    hero: 'NIC driver & firmware inventory across the fleet — with automatic firmware-drift detection.',
    title: 'NICs — firmware drift',
    body: () => [
      el('p', {}, 'Each Linux agent reports its physical network cards (driver, driver version, firmware version, bus) using ', el('code', {}, 'ethtool -i'), '. This page groups identical NIC models across all agents and highlights when units that should be identical are running ', el('strong', {}, 'different firmware'), ' — the classic “out of 50 access points, 3 are on an odd firmware and only those misbehave” situation.'),
      el('h4', {}, 'Firmware drift'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Majority '), '— the firmware most units of a model run; treated as the baseline.'),
        el('li', {}, el('strong', {}, 'Outlier '), '— any unit on a different firmware than the majority of the same model. Click a unit to open its agent page.')),
      el('h4', {}, 'Group by'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Models '), '— aggregate identical NICs across the fleet, drift first. Best for spotting firmware mismatches.'),
        el('li', {}, el('strong', {}, 'Agents '), '— list every agent reporting NIC data with its per-interface specs (driver, driver version, firmware, bus).')),
      el('p', { class: 'muted' }, 'Models are keyed by driver + PCI/USB id, so a Wi-Fi card is never compared against an Ethernet NIC. Metadata only — driver/firmware strings and hardware ids, never MAC or payload. Needs an agent new enough to collect NIC info on a Linux host; older agents simply show nothing here. Per-agent details are also on the ', viewLink('agents', 'agent'), ' page.'),
    ],
  },
  probes: {
    hero: 'Run a single active check from one agent, right now: ping, TCP-connect, DNS, traceroute, TCP traceroute, path MTU, cURL content check or page load — with RTT, loss, path and history.',
    title: 'Probes',
    body: () => [
      el('div', { class: 'callout' },
        el('strong', {}, 'Probes vs. Tests: '),
        el('span', {}, 'This tab is for ', el('strong', {}, 'one-off, on-demand'), ' checks from a single agent — you pick agent + type + target and click “Run probe”. To run the same checks ', el('strong', {}, 'on a recurring schedule across many agents'), ', use the ', viewLink('tests', 'Test packages'), ' tab. Same probe engine; Tests add naming, fleet targeting and recurrence.')),
      el('p', {}, 'While the other pages measure traffic passively, probes run an active test from a selected agent against a target, so you can answer “can site A reach host B — and how quickly?”.'),
      el('h4', {}, 'Types'),
      el('ul', {},
        el('li', {}, 'Ping (ICMP): RTT min/avg/max + packet loss + jitter.'),
        el('li', {}, 'TCP-connect: opens host:port and measures connection time (no payload sent).'),
        el('li', {}, 'DNS: time to resolve a name (and which address was returned).'),
        el('li', {}, 'Traceroute: the path (hops) to the target. Each hop is probed several times (set “Queries/hop”), so you get per-hop loss, latency and jitter — rendered as an interactive path map (hover a hop for its metrics + ASN/country) plus a hop table. Repeated traceroutes are aggregated so the verdict is stable.'),
        el('li', {}, el('strong', {}, 'Path MTU: '), 'the largest packet the path will carry, hop by hop. Reach for it when a service connects and then loses data — a mail server that opens a session and stalls mid-message is the classic case. Every other test here uses small packets, which is exactly why they all come back clean. It searches by packet size with the don\u2019t-fragment bit set and separates three things that look identical from the outside: a ', el('strong', {}, 'reduced'), ' MTU where the router sends ICMP \u201cfragmentation needed\u201d (normal \u2014 tunnels do this and Path MTU Discovery copes), a ', el('strong', {}, 'blackhole'), ' where large packets vanish with no ICMP at all (the fault \u2014 the sender is never told to send less), and a hop that simply does not answer ICMP (neither, and never counted as one). Ordinary packet loss is told apart by probing each size several times. The result names the hop the path narrows at and the TCP MSS to clamp to; on Linux it can also open a connection to a port and read the MSS actually negotiated, which shows a missing clamp directly.'),
        el('li', {}, el('strong', {}, 'TCP traceroute: '), 'the same path, traced with TCP SYN packets to a port instead of ICMP/UDP. Reach for it when the ordinary traceroute goes dark part-way but the service itself works: firewalls and transit providers routinely drop or rate-limit ICMP while passing the TCP session the application actually uses, so the SYN trace follows the path the real traffic takes. Same per-hop loss/latency/jitter and the same path map. The two are kept apart — a target is stored as ', el('span', { class: 'mono' }, 'host:port'), ' — because an ICMP path that dies at hop 4 next to a TCP path that completes IS the finding. Needs ', el('span', { class: 'mono' }, 'tcptraceroute'), ' on the host, or falls back to ', el('span', { class: 'mono' }, 'traceroute -T'), ', which the traceroute package already provides; either way it needs root for the raw socket.'),
        el('li', {}, el('strong', {}, 'cURL (content check): '), 'goes beyond “is it up” — the agent runs ', el('span', { class: 'mono' }, 'curl'), ' against an http(s) URL and verifies the received traffic: the HTTP status code, that the response body contains an expected substring or ', el('span', { class: 'mono' }, '/regex/'), ', the received byte count, and a response header. Leave the expectation fields blank for a plain status<400 check. The agent inspects the body locally but reports only metadata — status, byte count, content-type and pass/fail — never the body itself.'),
        el('li', {}, el('strong', {}, 'Page load: '), 'measures how a whole page loads — the agent fetches the URL, then its sub-resources (scripts, stylesheets, images) and reports a per-element waterfall (status · size · load time) plus totals: element count, page weight and total load time. The total load time is charted over time. Browser-free (no JS execution), so it can\'t see real DOM/load events; metadata only — resource URLs, sizes and timings, never contents.'),
        el('li', {}, el('strong', {}, 'Transaction (multi-step): '), 'simulates a user journey or scripted API call — an ordered list of HTTP steps, each with optional status/body assertions. A step can ', el('strong', {}, 'extract'), ' a value (regex capture) that later steps reference as ', el('span', { class: 'mono' }, '{{name}}'), ' in their URL, header or request body — e.g. log in, capture a token, then call an authenticated endpoint. It stops at the first failing step and reports a per-step waterfall plus the total journey time (charted over time). Extracted values stay on the agent and are never reported.')),
      el('p', {}, 'Select agent + type + target and click “Run probe”. The agent must be connected; the result comes back a moment later and is added to the history so you can see RTT / load time over time.'),
      el('p', { class: 'muted' }, 'To run the same probes on a schedule across many agents, use ', viewLink('tests'), '; probe results also drive the health verdict on ', viewLink('fleet', 'Overview'), '. Metadata only: targets, timings and content verdicts — never packet or response contents.'),
    ],
  },
  connectionTest: {
    hero: 'One address, the whole battery: type an IP or a DNS name and run every check at once — resolution, ICMP, the ports, the path and the packet size — once, a number of times, or on a repeat.',
    title: 'Connection test',
    body: () => [
      el('div', { class: 'callout' },
        el('strong', {}, 'Probe · Connection test · Test package: '),
        el('span', {}, 'A ', viewLink('probes', 'probe'), ' answers one question about one target. A connection test asks all of them at once, from one agent, against one address — the screen you reach for when somebody says “I cannot reach X”. A ', viewLink('tests', 'test package'), ' is the same thing saved: named, aimed at many agents, and repeating.')),
      el('p', {}, 'Type the address, press Run, and each selected check is pushed to the agent in one request. The number in the button is how many ROUNDS to run: every selected check, that many times, one round after the other — useful when a fault comes and goes and a single sample proves nothing.'),
      el('h4', {}, 'What gets run'),
      el('p', {}, 'The arrow opens the list. Everything the agent can run is selected by default; clear what you do not want. Two rows are always disabled: ', el('strong', {}, 'reverse DNS'), ' and the ', el('strong', {}, 'TLS certificate'), ' check are catalogue entries the agent cannot run yet, and they are shown rather than hidden so the list says what a connection test will cover. A ', el('strong', {}, 'DNS lookup'), ' is disabled when the target is an IP address — there is nothing to resolve, and a green tick for a question nobody asked is worse than no row at all.'),
      el('h4', {}, 'Stop'),
      el('p', {}, 'Stop ends the run: no further rounds are sent. A check already handed to the agent finishes on the agent — nothing can call it back — so its result may still arrive a moment later.'),
      el('h4', {}, 'Repeat'),
      el('p', {}, 'Repeat saves the same test as a scheduled ', viewLink('tests', 'test package'), ': a period (hourly / daily / weekly / monthly), how often to repeat inside that period, when it starts, and how many times the battery runs per scheduled run. The dialog writes the schedule out as a sentence before you save it. Times are the server\u2019s clock. Edit or delete it afterwards on the Test packages tab — closing this page does not stop it.'),
      el('p', { class: 'muted' }, 'Every check is an ordinary probe, so the full result — path map, per-hop measurement, history — opens on the Run-a-probe tab, and the same results drive the health verdict on ', viewLink('fleet', 'Overview'), ' and availability in ', viewLink('reporting', 'Reporting'), '. Metadata only: targets and timings, never packet contents.'),
    ],
  },
  flows: {
    hero: 'Inspect conversations: who talks to whom, on which ports, and who is scanning. Bidirectional mode splits ingress/egress; Map mode draws the traffic as colored directional arrows on a world map.',
    title: 'Flows — conversations, bidirectional inspector & traffic map',
    body: () => [
      el('p', {}, 'While ', viewLink('overview', 'Traffic'), ' shows volumes and the ', viewLink('geo', 'Destinations'), ' map shows where it goes, Flows lets you drill into individual conversations (5-tuple metadata from NetFlow/sFlow) for one agent.'),
      el('h4', {}, 'Map mode'),
      el('ul', {},
        el('li', {}, 'Draws each flow as an arrow between your site and the destination country: ', el('strong', {}, 'color = traffic type'), ' (DNS, Web, VPN, … — the same admin-editable categories as the traffic-type breakdown), ', el('strong', {}, 'moving dashes = direction'), ' (solid = both ways), ', el('strong', {}, 'width = volume'), '.'),
        el('li', {}, 'Scope it to the selected agent, one site, or the whole fleet; click a traffic-type chip to hide/show that category; click a site pin to open its location page.'),
        el('li', {}, 'Privacy: public destinations are placed at country centroids only; internal (RFC1918) traffic is never geolocated.')),
      el('h4', {}, 'Unified mode'),
      el('ul', {},
        el('li', {}, 'Top talkers: the largest conversations (source→destination) by bytes — click any row to filter by that peer.'),
        el('li', {}, 'Top ports / protocols — the Service column names the traffic type for well-known ports (443 → HTTPS, 53 → DNS, …) from a static port lookup (metadata only, no payload inspection); ephemeral/unknown ports show "–". Plus a bytes-over-time chart with anomaly findings overlaid as markers. Drag across the chart to zoom into a time range; "Reset zoom" restores the full window.'),
        el('li', {}, 'Scans / fan-out: sources hitting many different ports (port scan) or many hosts (fan-out).'),
        el('li', {}, 'Filters: Peer, Port, Proto, Direction (in/out), Scope (internal/external).')),
      el('h4', {}, 'Bidirectional mode'),
      el('ul', {},
        el('li', {}, 'Ingress (↓) and egress (↑) side-by-side with separate charts, top talkers and protocol breakdowns.'),
        el('li', {}, 'Asymmetry banner: flags when one direction carries ≥80% of traffic — a sign of asymmetric routing.'),
        el('li', {}, 'Anomaly findings overlaid as markers on both charts.')),
      el('p', { class: 'muted' }, 'Metadata only (5-tuple + bytes/flows), never packet contents. Internal RFC1918 addresses are shown but never geolocated. Requires NetFlow/sFlow + the geo pipeline.'),
    ],
  },
  geo: {
    hero: 'Where your traffic goes: internal sites and external destinations (country/ASN) on a map.',
    title: 'Destinations',
    body: () => [
      el('p', {}, 'Internal hosts are shown based on their site coordinates (set per location) — never via GeoIP. External destinations are aggregated per country/ASN from GeoIP-enriched flows; private/RFC1918 addresses are never shown as geo points.'),
      el('p', { class: 'muted' }, 'This is the traffic-destination map. For just your sites and their health, see the ', el('strong', {}, 'Sites'), ' tab.'),
      el('h4', {}, 'Markers'),
      el('ul', {},
        el('li', {}, 'Ringed dots = internal sites, coloured by agent health (green/amber/red); click for status + findings.'),
        el('li', {}, 'Circles = external destinations; size by traffic volume, colour by deviation (neutral → yellow → red).')),
      el('h4', {}, 'Get an external destination'),
      el('ol', {},
        el('li', {}, 'Click a circle on the map — or press ', el('strong', {}, '“Select region”'), ' and drag a box to aggregate every destination in an area.'),
        el('li', {}, 'The side panel then shows that destination\'s breakdown: bytes/flows, direction (in/out), protocol and ASN, plus any related findings.'),
        el('li', {}, 'To see the individual conversations behind it (per-peer 5-tuple, ports, scans/fan-out), open ', viewLink('flows'), '.')),
      el('h4', {}, 'Selection buttons'),
      el('ul', {},
        el('li', {}, el('strong', {}, '“Select region” '), '— drag a box to aggregate all destinations inside it (with combined findings).'),
        el('li', {}, el('strong', {}, '“Clear selection” '), '— return to the overview summary.')),
      el('h4', {}, 'Traceroute path overlay'),
      el('p', {}, 'Pick an agent and one of its recent traceroute targets, then ', el('strong', {}, '“Show path”'), ' to draw that path on this map: the agent site → transit countries → destination, as a severity-coloured line with a per-stop popup (hops · ASN · latency · loss). Geo is country-level, so same-country hops collapse to one stop — for the full per-hop topology, run it in ', viewLink('probes'), '. ', el('strong', {}, '“Clear path”'), ' removes the overlay.'),
      el('p', { class: 'muted' }, 'Map tiles are fetched from the server\'s config (EU/self-hosted), not a hardcoded US source. Destinations come from the same NetFlow/sFlow flows you drill into on ', viewLink('flows'), '; volumes by type are on ', viewLink('overview', 'Traffic'), '.'),
    ],
  },
  findings: {
    hero: 'Locally computed errors & anomalies — with explanation, documentation and root-cause hints.',
    title: 'Analysis — errors & anomalies',
    body: () => [
      el('p', {}, 'The server analyses agent measurements locally (no cloud, no ML library) and raises a finding when a metric deviates significantly from its own baseline, flatlines (sensor/agent stop) or correlates with other errors.'),
      el('h4', {}, 'Overview & filtering'),
      el('p', {}, 'The page opens with an ', el('strong', {}, 'Overview'), ' — total and unacknowledged counts, a severity breakdown, and per-metric / per-host tables with average and peak deviation (σ). Filter by host, severity or metric from the header (or by clicking a severity chip / metric row in the overview), and click any column header to sort the list.'),
      el('h4', {}, 'Severity'),
      el('ul', {},
        el('li', {}, 'CRIT: large deviation (default ≥ 4σ — adjustable in ', settingsLink('analyse', 'Settings → Analysis'), ').'),
        el('li', {}, 'WARN: notable deviation (default ≥ 3σ) or flatline.'),
        el('li', {}, 'INFO: lower severity.')),
      el('h4', {}, 'Acknowledgement'),
      el('p', {}, 'Operators and administrators can acknowledge a finding once it has been seen/handled.'),
      el('h4', {}, 'AI assistant'),
      el('p', {}, 'If enabled (opt-in) you can ask in natural language — the assistant replies based on the latest findings, not raw data. Turn it on and pick the provider (Mistral or another EU / self-hosted endpoint) and model under ', settingsLink('ai', 'Settings → AI'), '.'),
      el('p', { class: 'muted' }, 'New findings appear live via WebSocket and can also be fetched via REST.'),
    ],
  },
  locations: {
    hero: 'Group agents into locations and see correlated live traffic per location.',
    title: 'Locations',
    body: () => [
      el('p', {}, 'A location groups multiple agents (e.g. an office or a site).'),
      el('h4', {}, 'Live traffic'),
      el('p', {}, '”Traffic” opens a live panel that sums all agent traffic in the location and updates every 3 seconds — useful for seeing overall load and spotting problems.'),
      el('p', { class: 'muted' }, 'Give a location coordinates here to place it on the ', viewLink('map', 'Sites map'), '; the fleet-wide live picture is on ', viewLink('overview', 'Traffic'), '.'),
    ],
  },
  enrollment: {
    hero: 'Add an agent with a single command — the code, server address and checksum are already set.',
    title: 'Enrollment',
    body: () => [
      el('p', {}, '”Add agent” generates a code and a ready-to-run install command. Run the one-liner on the machine — it downloads the agent binary from this server, verifies the SHA-256, exchanges the code for a permanent token and starts a service. You never need to enter the server address yourself.'),
      el('p', {}, 'Prerequisite: an ', settingsLink('agentkey', 'agent signing key'), ' must be set (Settings → Agent key) — it is the trust anchor for secure agent management, so without it you cannot add agents.'),
      el('h4', {}, 'Three variants'),
      el('ul', {},
        el('li', {}, 'One-liner: curl … | sh — fastest.'),
        el('li', {}, 'Manual: download URL + checksum + command — for inspection before running.'),
        el('li', {}, 'Ansible: same one-liner, rolled out to many machines.')),
      el('h4', {}, 'Security'),
      el('ul', {},
        el('li', {}, 'Codes are short-lived (default 1 hour) and can be bulk (N machines).'),
        el('li', {}, 'The source bundle is always verified against the checksum before building or running.'),
        el('li', {}, 'The cert fingerprint is pinned on the agent (when the server runs behind TLS).')),
      el('p', { class: 'muted' }, 'The agent runs natively on the target (Node + systemd by default; Docker optional) — no pre-built binaries. Also works on air-gapped networks: the source is served from the BlueEyes server itself.'),
      el('h4', {}, 'Code status vs. the agent'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'active: '), 'still usable — has uses left and has not expired.'),
        el('li', {}, el('strong', {}, 'used: '), 'fully redeemed — an agent enrolled with it. Shown for a consumed code even after its time runs out.'),
        el('li', {}, el('strong', {}, 'expired: '), 'ran out of time WITHOUT being used up.')),
      el('p', { class: 'muted' }, 'The code only opens the install window. Each agent it enrols gets its own permanent token that stays valid until the agent is deleted (or its token revoked) — so an agent stays online regardless of whether its code later reads "used" or "expired". The Agents column shows each enrolled agent’s live online/offline state; click one to open it.'),
      el('p', { class: 'muted' }, 'Once enrolled, agents appear under ', viewLink('agents'), ' and on ', viewLink('fleet', 'Overview'), '.'),
    ],
  },
  users: {
    hero: 'Manage staff users and their roles (admin only).',
    title: 'Users',
    body: () => [
      el('h4', {}, 'Roles'),
      el('ul', {},
        el('li', {}, 'admin: everything, including user management.'),
        el('li', {}, 'operator: create/edit agents, locations and enrollment codes.'),
        el('li', {}, 'viewer: read-only access.')),
      el('p', {}, 'The last admin cannot be deleted or demoted.'),
      el('h4', {}, 'Password policy'),
      el('p', {}, `New and reset passwords must be at least ${PW_MIN_LENGTH} characters and use at least ${PW_MIN_CLASSES} of the four character classes (lowercase, uppercase, digit, symbol). The create/reset dialog shows a live strength bar and ticks each rule as it is met; the server enforces the same policy.`),
      el('p', { class: 'muted' }, 'Operators manage those resources under ', viewLink('agents'), ', ', viewLink('locations'), ' and ', viewLink('enrollment'), '.'),
    ],
  },
  license: {
    hero: 'View this server\'s licence status, validated against the central licence server.',
    title: 'License',
    body: () => [
      el('p', {}, 'The server fetches a signed proof from the licence server and verifies it offline using an embedded key.'),
      el('ul', {},
        el('li', {}, 'valid: fresh and valid.'),
        el('li', {}, 'grace: cannot reach the licence server, but cached proof < 14 days old.'),
        el('li', {}, 'unlicensed: no valid licence — new agent connections are rejected.')),
    ],
  },
  settings: {
    hero: 'Configuration and administration — one tab per topic.',
    title: 'Settings',
    body: () => [
      el('p', {}, 'Each tab covers one topic. Most settings can be edited here and take effect immediately without a restart; a few are read-only and controlled via the server\'s .env because they contain secrets.'),
      el('h4', {}, 'Editable here (stored in the database)'),
      el('ul', {},
        el('li', {}, settingsLink('analyse', 'Analysis'), ': thresholds for anomaly detection — CRIT/WARN in σ, baseline window and how many measurements are required before alerting.'),
        el('li', {}, settingsLink('alerting', 'Alerting'), ': channels (e-mail/webhook/syslog) — enable, set a minimum severity, and fill in the connection details. Secrets (SMTP password, webhook HMAC) are write-only: stored on the server, never shown again.'),
        el('li', {}, settingsLink('retention', 'Retention'), ': how long raw/aggregated data and findings are kept before being cleaned up.'),
        el('li', {}, settingsLink('types', 'Traffic types'), ': define the categories (DNS, Facebook …) from service ports and destination ASN. Shown on ', viewLink('overview', 'Traffic'), ' → Traffic type.'),
        el('li', {}, settingsLink('map', 'Map'), ': tile and geocoder source for the maps (use an EU/self-hosted source in production).'),
        el('li', {}, settingsLink('auth', 'Authentication'), ': connect an LDAP / Active Directory server so users log in with their directory account and get a role from their group membership. Requires the Professional licence and the server flag LDAP_AUTH_ENABLED; the bind password is write-only. Local accounts remain as a fallback.')),
      el('h4', {}, 'Read-only (set in .env / requires restart)'),
      el('ul', {},
        el('li', {}, settingsLink('database', 'Database'), ': status of the MySQL primary store and the optional TimescaleDB telemetry node, plus how to wire up TimescaleDB. Database connections are set in the server environment (deploy-time infrastructure), so they are read-only here.'),
        el('li', {}, settingsLink('users', 'Users'), ': create/edit staff and roles (admin only).'),
        el('li', {}, settingsLink('license', 'License'), ': status + “Revalidate now”.')),
      el('p', { class: 'muted' }, 'Editable changes are stored in app_settings and are reloaded on startup, so they survive a restart.'),
    ],
  },
};

// Screens migrated onto the UI contract (docs/ui-contract.md). Their help lives
// in the PageHeader's (?) popover, so the legacy hero banner must not also draw
// one above them — two copies of the same paragraph, one of which the contract
// deleted. The gate reads this set too: a migrated view is allowed to have no
// PAGE_INFO entry precisely because its module carries the help instead.
// view key -> the module in public/views/ that draws it. Usually the same word;
// Analysis is the exception, because the view key is `findings` (the records it
// lists) while the product calls the screen Analysis.
const CONTRACT_VIEWS = new Map([
  ['changes', 'changes'],
  ['probes', 'probes'],
  ['findings', 'analysis'],
  ['fleet', 'fleet'],
  ['map', 'sites'],
  ['overview', 'traffic'],
  ['geo', 'destinations'],
  ['delta', 'topologyDelta'],
  ['investigation', 'investigate'],
  ['diagnose', 'diagnose'],
  ['deviceLog', 'deviceLog'],
  ['troubleshooting', 'troubleshooting'],
  ['topology', 'topology'],
  ['flows', 'flows'],
  ['transactions', 'transactions'],
  ['serviceAssurance', 'serviceAssurance'],
  ['events', 'events'],
  ['clusters', 'situations'],
  ['reporting', 'reporting'],
  ['guide', 'guides'],
  ['locations', 'locations'],
  ['enrollment', 'enrollment'],
  ['discovery', 'discovery'],
  ['logs', 'systemLogs'],
  ['userLogs', 'userLogs'],
  ['settings', 'settings'],
]);

function hero(viewKey) {
  if (CONTRACT_VIEWS.has(viewKey)) return null;
  // Probes & Tests is one view with two sub-tabs; show the matching help for each.
  let info = PAGE_INFO[viewKey];
  if (viewKey === 'probes' && probesTab === 'packages') info = PAGE_INFO.tests;
  if (viewKey === 'probes' && probesTab === 'connection') info = PAGE_INFO.connectionTest;
  if (!info) return null;
  return el('div', { class: 'hero' },
    el('div', { class: 'hero-text' }, info.hero),
    el('button', { class: 'ghost small', onclick: () => openDrawer(info.title, info.body) }, 'More info'));
}

// ---- Framed page section --------------------------------------------------
// The Overview page sets the pattern every page follows: data lives inside a
// framed panel with its heading (and its actions) on top, never loose on the
// page background. `body` is usually a table, which runs flush to the card's
// edges — the card carries the frame (see .data-card in styles.css).
function dataCard(title, { actions = null, note = null } = {}, ...body) {
  const head = el('div', { class: 'dc-head' }, el('h3', {}, title));
  const acts = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);
  if (acts.length) head.append(el('div', { class: 'dc-actions' }, ...acts));
  const card = el('div', { class: 'card data-card' }, head);
  if (note) card.append(el('p', { class: 'muted dc-note' }, note));
  card.append(...body.filter(Boolean));
  return card;
}

let drawerEls = null;
function openDrawer(title, bodyFn) {
  closeDrawer();
  const backdrop = el('div', { class: 'drawer-backdrop', onclick: closeDrawer });
  const panel = el('div', { class: 'drawer' },
    el('button', { class: 'ghost small close-x', onclick: closeDrawer }, '✕'),
    el('h3', {}, title),
    ...bodyFn());
  document.body.append(backdrop, panel);
  drawerEls = { backdrop, panel };
  // Trigger the slide-in transition on the next frame.
  requestAnimationFrame(() => { backdrop.classList.add('open'); panel.classList.add('open'); });
  document.addEventListener('keydown', onDrawerKey);
}
function closeDrawer() {
  document.removeEventListener('keydown', onDrawerKey);
  if (!drawerEls) return;
  const { backdrop, panel } = drawerEls;
  drawerEls = null;
  backdrop.classList.remove('open'); panel.classList.remove('open');
  setTimeout(() => { backdrop.remove(); panel.remove(); }, 250);
}
function onDrawerKey(e) { if (e.key === 'Escape') closeDrawer(); }

const views = {};
let locationCache = [];

// Test area — consolidated connectivity + security screening of every outbound
// integration. Admin-only (the nav button + the /api/diagnostics routes both gate
// on admin). Each subsystem's own test primitive is reused via the diagnostics API.
const SCREEN_SEV_LABEL = { ok: 'OK', info: 'Info', warn: 'Warning', bad: 'Critical' };
const SCREEN_SEV_BADGE = { ok: 'badge ok', info: 'badge', warn: 'badge warn', bad: 'badge bad' };

// Deep-link from a Test-area target to where it is configured. Every target maps
// to a Settings sub-tab (integrations get their own page, implemented below).
function screenSetupLink(t) {
  let tab = null;
  if (t.id.startsWith('alert:')) tab = 'alerting';
  else if (t.id === 'cmdb' || t.category === 'cmdb') tab = 'cmdb';
  else if (t.category === 'itsm') tab = 'integrations';
  else if (t.category === 'auth') tab = 'auth';
  else if (t.id === 'assistant') tab = 'ai';
  else if (t.id === 'map') tab = 'map';
  else if (t.id === 'license') tab = 'license';
  if (!tab) return null;
  return settingsLink(tab, 'Set up →');
}

views.screening = async () => {
  const root = el('div');
  let catalog = [];
  let groupOrder = [];
  const results = new Map(); // target id -> last run result

  const runAllBtn = el('button', {}, 'Run full screening');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Test Settings'),
    el('span', { class: 'spacer' }),
    runAllBtn));

  const summaryBar = el('div', { class: 'screen-summary' });
  const bodyEl = el('div', { class: 'empty' }, 'Loading…');
  root.append(summaryBar, bodyEl);

  const chip = (label, n, cls) => el('span', { class: `badge ${cls || ''}`.trim() }, `${label}: ${n}`);

  function renderSummary() {
    const counts = { ok: 0, info: 0, warn: 0, bad: 0 };
    for (const t of catalog) {
      const r = results.get(t.id);
      counts[(r ? r.severity : t.posture)] += 1;
    }
    summaryBar.replaceChildren(
      chip('Targets', catalog.length, ''),
      chip('OK', counts.ok, 'ok'),
      chip('Warnings', counts.warn, 'warn'),
      chip('Critical', counts.bad, 'bad'));
  }

  function targetRow(t) {
    const r = results.get(t.id);
    const sev = r ? r.severity : t.posture;
    const statusBadge = el('span', { class: SCREEN_SEV_BADGE[sev] || 'badge' }, SCREEN_SEV_LABEL[sev] || sev);

    const checks = el('div', { class: 'screen-checks' },
      ...(t.security || []).map((c) => el('span',
        { class: `screen-chip ${c.status}`, title: c.note || '' },
        `${c.label}: ${SCREEN_SEV_LABEL[c.status] || c.status}`)));

    const detailLine = el('div', { class: 'screen-detail muted' });
    if (r) detailLine.textContent = `${r.ran ? (r.ok ? '✓ ' : '✗ ') : ''}${r.detail || ''}${r.ran && r.durationMs != null ? ` · ${r.durationMs} ms` : ''}`;
    else if (!t.runnable) detailLine.textContent = 'Configuration screened only — no live test for this target.';

    const runBtn = el('button', { class: 'small ghost' }, 'Run');
    if (t.licensed === false) { runBtn.disabled = true; runBtn.textContent = 'Not licensed'; }
    else if (!t.runnable) runBtn.disabled = true;
    else runBtn.addEventListener('click', () => runTargets([t.id], runBtn));

    return el('div', { class: 'screen-row' },
      el('div', { class: 'screen-row-main' },
        el('div', { class: 'screen-row-head' },
          statusBadge,
          el('strong', {}, t.name),
          el('span', { class: 'muted screen-row-detail' }, t.detail)),
        checks,
        detailLine),
      el('div', { class: 'screen-row-actions' }, runBtn, screenSetupLink(t)));
  }

  function renderBody() {
    if (!catalog.length) { bodyEl.className = 'empty'; bodyEl.replaceChildren('No targets to screen.'); return; }
    const byGroup = new Map();
    for (const t of catalog) { if (!byGroup.has(t.group)) byGroup.set(t.group, []); byGroup.get(t.group).push(t); }
    const order = groupOrder.length ? groupOrder.map((g) => g.label) : [...byGroup.keys()];
    const cards = [];
    for (const label of order) {
      const items = byGroup.get(label);
      if (!items || !items.length) continue;
      cards.push(el('div', { class: 'settings-card' },
        el('h3', {}, label),
        el('div', { class: 'screen-list' }, ...items.map(targetRow))));
    }
    bodyEl.className = 'screen-groups';
    bodyEl.replaceChildren(...cards);
    renderSummary();
  }

  async function runTargets(ids, btn) {
    const all = !ids;
    const restore = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    try {
      const data = await api('/api/diagnostics/run', { method: 'POST', body: all ? {} : { targets: ids } });
      for (const t of data.targets || []) results.set(t.id, t.result);
      renderBody();
      if (all) toast(`Screening complete — ${data.summary.bad || 0} critical, ${data.summary.warn || 0} warning(s)`, (data.summary.bad || 0) > 0);
    } catch (e) {
      toast(errText(e), true);
      if (btn) { btn.disabled = false; btn.textContent = restore || 'Run'; }
    }
  }

  runAllBtn.addEventListener('click', async () => {
    runAllBtn.disabled = true; runAllBtn.textContent = 'Running…';
    await runTargets(null, null);
    runAllBtn.disabled = false; runAllBtn.textContent = 'Run full screening';
  });

  try {
    const data = await api('/api/diagnostics/targets');
    catalog = data.targets || [];
    groupOrder = data.groups || [];
    renderBody();
  } catch (e) {
    bodyEl.className = 'empty error';
    bodyEl.replaceChildren(errText(e));
  }
  return root;
};

views.agents = async () => {
  const [agents, locations, ver] = await Promise.all([api('/agents'), api('/locations'), api('/system/version').catch(() => null)]);
  // Two served versions: `offered` is what a systemd one-click Update pushes (a
  // signed release, else the source bundle); `source` is what installer-based
  // agents can reach (always the source bundle). They diverge when a signed
  // release is newer than the packaged source — each agent is judged against the
  // one IT can actually reach (agentUpdateTarget), so an installer-only agent
  // that's on the newest installable build isn't flagged as forever "behind".
  const offered = ver && ver.agent ? ver.agent : null;
  const versions = { offered, source: (ver && ver.agentSource) || offered };
  locationCache = locations;
  // Only systemd agents can be rebuilt-and-restarted from here; Docker/unmanaged/
  // Windows agents would just decline, so the bulk action targets (and counts)
  // the self-updatable ones — the rest are flagged with an "installer" badge.
  const outdated = agents.filter((a) => agentSelfUpdatable(a) && agentIsBehind(a, agentUpdateTarget(a, versions)));
  const root = el('div');
  const countLabel = el('span', { class: 'muted' }, `${agents.length} total`);
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Agents'),
    countLabel,
    canWrite() ? el('button', { class: 'small', onclick: () => newAgent() }, '+ New agent') : null,
    (canDelete() && outdated.length)
      ? el('button', { class: 'small', onclick: () => bulkUpdateAgents(outdated, offered), title: 'Rebuild every self-updatable (systemd) outdated agent from the server source, one at a time' }, `Update outdated (${outdated.length})`)
      : null));
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'No agents yet. Click "+ New agent" to get an enrollment code for installation.')); return root; }

  // Client-side filter + sort over the already-loaded agents (no refetch).
  let filter = '';
  let sortKey = 'id';
  let sortDir = 'asc';

  // Columns: { label, key, get }. key:null = not sortable (Source, actions).
  const columns = [
    { label: 'ID', key: 'id', get: (a) => a.id },
    { label: 'Name / hostname', key: 'name', get: (a) => (a.display_name || a.hostname || '').toLowerCase() },
    { label: 'Platform', key: 'platform', get: (a) => `${a.platform}/${a.arch}`.toLowerCase() },
    { label: 'Status', key: 'status', get: (a) => a.status || '' },
    { label: 'Health', key: 'health', get: agentHealthRank },
    { label: 'Location', key: 'location', get: (a) => (a.location_name || '').toLowerCase() },
    { label: 'Source', key: null },
    { label: 'Last reported', key: 'last', get: (a) => (a.last_report_at ? new Date(a.last_report_at).getTime() : 0) },
    { label: '', key: null },
  ];

  const search = el('input', {
    type: 'search', class: 'table-filter',
    placeholder: 'Filter agents — name, IP, platform, location, source…',
    oninput: (e) => { filter = e.target.value.trim().toLowerCase(); update(); },
  });
  root.append(el('div', { class: 'table-toolbar' }, search));

  const headerEls = columns.map((c) => (c.key
    ? el('th', {
      class: 'sortable', scope: 'col', tabindex: '0', 'aria-sort': 'none',
      title: `Sort by ${c.label}`,
      onclick: () => sortBy(c.key),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(c.key); } },
    })
    : el('th', { scope: 'col' }, c.label)));
  const tbody = el('tbody');
  root.append(el('table', { class: 'agents-table' },
    el('thead', {}, el('tr', {}, ...headerEls)),
    tbody));

  function sortBy(key) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = key; sortDir = 'asc'; }
    update();
  }
  function matchesFilter(a) {
    if (!filter) return true;
    return [a.id, a.display_name, a.hostname, a.platform, a.arch, a.status,
      a.location_name, a.monitor_config && a.monitor_config.source,
      a.capabilities && a.capabilities.agentVersion]
      .filter((v) => v != null).join(' ').toLowerCase().includes(filter);
  }
  function update() {
    const col = columns.find((c) => c.key === sortKey) || columns[0];
    const list = agents.filter(matchesFilter).sort((x, y) => {
      const vx = col.get(x);
      const vy = col.get(y);
      const r = (typeof vx === 'number' && typeof vy === 'number')
        ? vx - vy
        : String(vx).localeCompare(String(vy));
      return sortDir === 'asc' ? r : -r;
    });
    tbody.replaceChildren(...(list.length
      ? list.map((a) => agentRow(a, versions))
      : [el('tr', {}, el('td', { colspan: String(columns.length), class: 'muted' }, 'No agents match your filter.'))]));
    columns.forEach((c, i) => {
      if (!c.key) return;
      const on = sortKey === c.key;
      headerEls[i].textContent = c.label + (on ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
      headerEls[i].classList.toggle('sorted', on);
      headerEls[i].setAttribute('aria-sort', on ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    countLabel.textContent = filter ? `${list.length} of ${agents.length}` : `${agents.length} total`;
  }

  update();
  return root;
};

// One agent table row (extracted so the agents view can re-render on filter/sort).
function agentRow(a, versions) {
  const target = agentUpdateTarget(a, versions);
  const behind = agentIsBehind(a, target);
  return el('tr', {},
    el('td', {}, String(a.id)),
    el('td', {}, el('div', {}, a.display_name || a.hostname), a.display_name ? el('div', { class: 'muted' }, a.hostname) : null),
    el('td', {}, `${a.platform} / ${a.arch}`, agentVersionLine(a, target)),
    el('td', {}, el('span', {
      class: `badge ${a.status} clickable`,
      role: 'button',
      tabindex: '0',
      title: 'Connection diagnosis — why this agent is online/offline, with a reconnect option',
      onclick: () => showConnection(a),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showConnection(a); } },
    }, a.status)),
    el('td', {}, agentHealthCell(a)),
    el('td', {}, a.location_name || '–'),
    el('td', {}, agentSourceCell(a)),
    el('td', { class: 'muted' }, fmtDate(a.last_report_at)),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'small ghost', onclick: () => showResults(a) }, 'Traffic'),
      (a.monitor_config && (a.monitor_config.source === 'netflow' || a.monitor_config.source === 'sflow'))
        ? el('button', { class: 'small ghost', onclick: () => showAgentFlows(a) }, 'Flows')
        : null,
      el('button', { class: 'small ghost', onclick: () => pingAgent(a), title: 'Confirm the live connection to this agent' }, 'Ping'),
      el('button', { class: 'small ghost', onclick: () => diagnoseAgent(a), title: 'Flow-pipeline self-check: source, collector counters, exporter state' }, 'Diagnose'),
      el('button', { class: 'small ghost', onclick: () => showSpeedtest(a), title: 'Active download/upload speed test to the server' }, 'Speed'),
      canWrite() ? el('button', { class: 'small', onclick: () => runTest(a) }, 'Run test') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => editAgent(a) }, 'Edit') : null,
      canDelete() ? agentUpdateButton(a, target, behind) : null,
      canDelete() ? el('button', { class: 'small danger', onclick: () => deleteAgent(a) }, 'Delete') : null,
    )),
  );
}

// Health ordering for sorting: healthy(0) < delayed / no-data(1) < down(2).
// Mirrors agentHealthCell so the column sorts the way it reads.
function agentHealthRank(a) {
  const last = a.last_report_at ? new Date(a.last_report_at).getTime() : 0;
  const ageMs = last ? Date.now() - last : Infinity;
  if (a.status !== 'online') return 2;
  if (ageMs <= 5 * 60 * 1000) return 0;
  return 1;
}

// Small "v<x>" line under the platform, with an "update" badge when the agent is
// behind the version the server currently serves. Version comes from the agent's
// reported capabilities (capabilities.agentVersion). Only systemd agents can be
// upgraded with one click from here — for Docker/unmanaged/Windows agents the
// badge is neutral and says the update comes from the host installer, so the
// flag doesn't imply an action that would just silently decline.
function agentVersionLine(a, current) {
  const v = a.capabilities && a.capabilities.agentVersion;
  if (!v) return null;
  if (!agentIsBehind(a, current)) return el('div', { class: 'muted' }, `v${v}`);
  if (agentSelfUpdatable(a)) {
    return el('div', { class: 'muted' }, `v${v} `,
      el('span', { class: 'badge warn', title: `Current agent version is ${current}` }, 'update'));
  }
  // A Windows agent isn't stuck: the Update button hands out a one-liner that
  // updates it in place, so its badge points at that rather than at a reinstall.
  if (agentIsWindows(a)) {
    return el('div', { class: 'muted' }, `v${v} `,
      el('span', { class: 'badge warn', title: t('agentUpdate.win.badgeTitle', { version: current }) }, t('agentUpdate.win.badge')));
  }
  return el('div', { class: 'muted' }, `v${v} `,
    el('span', { class: 'badge neutral', title: `${agentUpdateHint(a)} (current version is ${current})` }, 'update · installer'));
}

// The row-actions button for pushing an agent onto the current version. Solid
// "Update" when a systemd agent is behind; a subtle "Upgrade" (manual re-deploy)
// when it's already current. Docker/unmanaged/Windows agents can't self-update
// from here, so we don't push a command that would just decline: a behind Windows
// agent gets an "Update" that hands over the update-in-place one-liner for its
// host, and any other non-self-updatable one gets an "installer" affordance whose
// click explains where the update comes from instead.
function agentUpdateButton(a, current, behind) {
  if (!agentSelfUpdatable(a) && agentIsWindows(a) && behind) {
    return el('button', {
      class: 'small',
      onclick: () => showWindowsUpdateCommand(a, current),
      title: t('agentUpdate.win.buttonTitle'),
    }, t('agentUpdate.win.button'));
  }
  if (agentSelfUpdatable(a)) {
    return el('button', {
      // Always available to admins as a manual upgrade link; emphasised (solid)
      // when the agent is behind the published version, otherwise a subtle ghost
      // link that re-deploys the current server source.
      class: behind ? 'small' : 'small ghost',
      onclick: () => updateAgent(a, current),
      title: behind
        ? `Update this agent to v${current} — rebuild from the server source and restart`
        : 'Manually rebuild this agent from the server source and restart it',
    }, behind ? 'Update' : 'Upgrade');
  }
  if (!behind) return null; // up-to-date + can't self-update from here → no action
  return el('button', {
    class: 'small ghost',
    onclick: () => updateAgent(a, current),
    title: agentUpdateHint(a),
  }, 'Installer');
}

// Compare dotted versions: <0 if a<b, 0 if equal, >0 if a>b. Ignores any
// pre-release/build suffix; non-numeric segments count as 0.
function compareVersions(a, b) {
  const parse = (s) => String(s).split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// True only when the agent reports a version STRICTLY OLDER than the one the
// server serves. An agent that's ahead of the server (e.g. hand-rebuilt before
// the server's source was refreshed) is NOT "behind" — don't offer it a update.
function agentIsBehind(a, current) {
  const v = a.capabilities && a.capabilities.agentVersion;
  return !!(v && current && compareVersions(v, current) < 0);
}

// Whether the server's one-click Update can actually upgrade this agent. Only
// systemd-managed agents self-update from here (rebuild-from-source + restart);
// Docker, unmanaged and Windows agents report managed 'docker'/'unmanaged' and
// must be updated by re-running the host installer. An agent that never reported
// a managed-state (a very old agent, pre-capabilities.managed) is treated as
// updatable so we don't hide an action we're merely unsure about.
function agentSelfUpdatable(a) {
  // A Windows agent never self-updates whatever it reports as `managed`: the agent
  // only accepts the pushed update under systemd, which Windows can't be.
  if (agentIsWindows(a)) return false;
  const managed = a && a.capabilities && a.capabilities.managed;
  return managed !== 'docker' && managed !== 'unmanaged';
}

// Windows hosts (the agent reports process.platform, i.e. 'win32'). They update
// from the host with the update-in-place one-liner, not from the server.
function agentIsWindows(a) {
  return !!(a && typeof a.platform === 'string' && /^win/i.test(a.platform));
}

// The newest version THIS agent can actually reach, so "behind" compares against
// what its own update path delivers — not a version it can never get to. A
// systemd agent one-click-updates to the offered version (a signed release, else
// the source bundle); a Docker/Windows/unmanaged agent can only re-run its
// installer, which downloads the SOURCE bundle. When the server publishes a
// signed release newer than the packaged source these differ, and judging an
// installer-only agent against the release would flag it as forever "behind"
// even when it's on the newest build its installer can produce. `versions` is
// { offered, source }; falls back gracefully when only one is known.
function agentUpdateTarget(a, versions) {
  if (!versions) return null;
  return agentSelfUpdatable(a) ? versions.offered : (versions.source || versions.offered);
}

// Why a non-self-updatable agent's version won't change from here, and how to
// update it — used for the neutral badge tooltip and the "Installer" button.
function agentUpdateHint(a) {
  const managed = a && a.capabilities && a.capabilities.managed;
  return managed === 'docker'
    ? 'Runs under Docker — update it by re-running the install one-liner on the host (it rebuilds the container there, not from the server).'
    : "Isn't service-managed (a bare-process agent) — update it by re-running the installer on the host.";
}

// Health derived from how recently the agent last reported in. online + a fresh
// report = healthy; online but stale (or never reported) = degraded; offline = down.
function agentHealthCell(a) {
  const last = a.last_report_at ? new Date(a.last_report_at).getTime() : 0;
  const ageMs = last ? Date.now() - last : Infinity;
  const FRESH = 5 * 60 * 1000; // 5 min
  let cls;
  let label;
  if (a.status !== 'online') { cls = 'offline'; label = 'down'; }
  else if (ageMs <= FRESH) { cls = 'online'; label = 'healthy'; }
  else { cls = 'grace'; label = last ? 'delayed' : 'no data'; }
  const title = last ? `Last reported ${fmtDate(a.last_report_at)}` : 'Has not reported yet';
  return el('span', { class: `badge ${cls}`, title }, label);
}

// "+ New agent" jumps to the Enrollment screen, where the wizard generates a code
// and a ready-to-run install command (with live "connected" feedback).
async function newAgent() {
  currentView = 'enrollment';
  await render();
}

async function runTest(a) {
  try {
    const res = await api(`/agents/${a.id}/run-test`, { method: 'POST', body: { intervalMs: 1000 } });
    toast(`Test sent to ${a.hostname} (delivered: ${res.delivered}). Fetching result…`);
    setTimeout(() => showResults(a), 2000);
  } catch (err) { toast(err.message, true); }
}

// Liveness check: round-trips a "ping" to the agent over the live WebSocket and
// reports the result (latency + reported version/sources). Distinct from "Run
// test" (which measures traffic): this just confirms the agent is reachable now.
async function pingAgent(a) {
  const name = a.display_name || a.hostname;
  try {
    const r = await api(`/agents/${a.id}/ping`, { method: 'POST' });
    if (!r.connected) { toast(`${name}: not connected`, true); return; }
    if (r.timedOut) { toast(`${name}: connected but did not reply (timed out)`, true); return; }
    const bits = [`responded in ${r.latencyMs} ms`];
    if (r.agentVersion) bits.push(`v${r.agentVersion}`);
    if (r.sources && r.sources.length) bits.push(r.sources.join('/'));
    if (r.managed) bits.push(r.managed);
    toast(`${name}: ${bits.join(' · ')}`);
  } catch (err) { toast(`${name}: ${err.message}`, true); }
}

// Connection diagnosis (GET /agents/:id/connection): why the agent is
// (dis)connected — verdict, explanation, evidence, next steps — plus a "Force
// reconnect" for connected agents (the server closes the socket; the agent
// re-dials with a clean session). Connections are agent-initiated, so a truly
// offline agent can't be revived from here; the modal explains what will.
async function showConnection(a) {
  const name = a.display_name || a.hostname;
  let d;
  try { d = await api(`/agents/${a.id}/connection`); } catch (err) { toast(`${name}: ${err.message}`, true); return; }
  renderConnectionModal(a, d);
}

// Badge styling per diagnosis state (renderConnectionModal).
const CONNECTION_STATE_BADGES = {
  connected: 'badge online',
  reconnecting: 'badge grace',
  'license-blocked': 'badge warn',
  'auth-rejected': 'badge offline',
  unreachable: 'badge offline',
  'never-connected': 'badge grace',
};

function renderConnectionModal(a, d) {
  const card = $('#modal-card');
  const name = a.display_name || a.hostname;
  const body = [el('h3', {}, `Connection — ${name}`)];
  body.push(el('p', {}, el('span', { class: CONNECTION_STATE_BADGES[d.state] || 'badge' }, d.state), ' ', d.explanation));
  if (d.hints && d.hints.length) {
    body.push(el('p', { class: 'muted' }, 'What to do:'));
    body.push(el('ul', {}, ...d.hints.map((h) => el('li', {}, h))));
  }
  if (d.evidence && d.evidence.length) {
    body.push(el('details', {},
      el('summary', { class: 'muted' }, 'Evidence'),
      el('ul', {}, ...d.evidence.map((e) => el('li', {}, `${e.label}: ${e.value}`)))));
  }
  const actions = [];
  if (canWrite() && d.connected) {
    const btn = el('button', { class: 'small' }, 'Force reconnect');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Reconnecting…';
      try {
        const r = await api(`/agents/${a.id}/reconnect`, { method: 'POST' });
        if (r.reconnected) toast(`${name}: socket closed and re-established in ${(r.waitedMs / 1000).toFixed(1)} s.`);
        else toast(`${name}: socket closed, but the agent had not reconnected after ${Math.round(r.waitedMs / 1000)} s — re-check in a moment.`, true);
      } catch (err) {
        toast(`${name}: ${err.message}`, true);
      }
      showConnection(a); // refresh the modal with the post-reconnect diagnosis
    });
    actions.push(btn);
  }
  // Admin-only: the server-initiated action trail (upgrade/delete) for this
  // agent. This is where a one-click Update that was accepted but then FAILED
  // during the agent's rebuild (bad signature, missing release key, download
  // blocked, npm failure…) shows its reason — the outcome the agent reports back
  // lands here, not as a toast. Lazily loaded when the section is opened.
  if (canDelete()) {
    const auditBox = el('div', {}, el('p', { class: 'muted' }, 'Open to load the update/delete outcomes for this agent.'));
    const details = el('details', { class: 'conn-audit' }, el('summary', { class: 'muted' }, 'Update / delete history'), auditBox);
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      auditBox.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
      try {
        const rows = await api(`/agents/${a.id}/audit`);
        auditBox.replaceChildren(renderActionAuditList(rows));
      } catch (err) { loaded = false; auditBox.replaceChildren(el('p', { class: 'muted' }, errText(err))); }
    });
    body.push(details);
  }
  const recheck = el('button', { class: 'small ghost', onclick: () => showConnection(a) }, 'Re-check');
  actions.push(recheck);
  body.push(el('div', { class: 'form-actions' }, ...actions, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
  card.replaceChildren(...body);
  $('#modal').classList.remove('hidden');
}

// Renders the agent_action_audit trail (upgrade/delete, requested -> completed/
// failed) as a table. A `failed` row's Detail carries the agent's own error text
// — the answer to "I clicked Update and nothing happened". Newest first.
function renderActionAuditList(rows) {
  if (!rows || !rows.length) {
    return el('p', { class: 'muted' }, 'No update or delete actions have been sent to this agent yet.');
  }
  const stateBadge = (s) => el('span', { class: `badge ${s === 'completed' ? 'active' : s === 'failed' ? 'bad' : 'warn'}` }, s);
  return el('table', { class: 'audit-table' },
    el('thead', {}, el('tr', {}, ...['When', 'Action', 'Target', 'Result', 'Detail'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      el('td', { class: 'muted' }, fmtDate(r.requested_at)),
      el('td', {}, r.action),
      el('td', {}, r.target_version ? `v${r.target_version}` : '–'),
      el('td', {}, stateBadge(r.state)),
      el('td', { class: 'muted' }, r.result_detail || (r.state === 'requested' ? 'awaiting agent…' : '–')),
    ))));
}

// Round-trips a "diagnose" to the agent and shows where its flow pipeline stands
// — source, collector receive/decode counters, local exporter state — with a
// plain verdict on why flows might be missing. Read-only (no agent side effects).
async function diagnoseAgent(a) {
  const name = a.display_name || a.hostname;
  try {
    const r = await api(`/agents/${a.id}/diagnose`, { method: 'POST' });
    showDiagnostic(a, r.diagnostic);
  } catch (err) { toast(`${name}: ${err.message}`, true); }
}

// One-line "where do flows stop?" verdict from a diagnostic snapshot.
function diagnoseVerdict(d) {
  const c = d.collector;
  if (!c) return { ok: true, text: `Source is "${d.source}" — not a flow source, so there are no conversation flows by design. Set the source to sflow/netflow (with an exporter) to collect flows.` };
  if (!c.listening) return { ok: false, text: 'The flow collector is not listening — the agent did not open its sFlow/NetFlow port.' };
  const hs = d.hsflowd ? ` Local hsflowd: ${d.hsflowd.state}.` : '';
  if (!c.datagrams) return { ok: false, text: `The collector is up but has received 0 datagrams — nothing is exporting ${d.source} to it. Enable the Local hsflowd exporter for this agent (Edit), or point a switch/host at the agent's collector.${hs}` };
  if (!c.decodedFlows) return { ok: false, text: `Datagrams are arriving (${c.datagrams}) but no flow samples were decoded — the exporter is sending, but not flow samples (check the sampling rate / that hsflowd was built with FEATURES=PCAP).${hs}` };
  return { ok: true, text: `Flow pipeline healthy — decoded ${c.decodedFlows} flow records from ${c.datagrams} datagrams.${hs}` };
}

// Modal: the agent's flow-pipeline snapshot + verdict (from POST /diagnose).
function showDiagnostic(a, d) {
  const card = $('#modal-card');
  const body = [el('h3', {}, `Diagnose — ${a.display_name || a.hostname}`)];
  if (!d) {
    body.push(el('p', { class: 'muted' }, 'The agent did not return a diagnostic.'));
  } else {
    const v = diagnoseVerdict(d);
    body.push(el('p', {}, el('span', { class: v.ok ? 'badge active' : 'badge offline' }, v.ok ? 'OK' : 'ATTENTION'), ' ', v.text));
    body.push(el('div', { class: 'cards' },
      stat('Source', d.source || '–'),
      stat('Version', d.agentVersion ? `v${d.agentVersion}` : '–'),
      stat('Managed', d.managed || '–'),
      stat('Last report', d.lastReportAt ? fmtDate(d.lastReportAt) : 'never')));

    const c = d.collector;
    if (c) {
      const num = (n) => Number(n || 0).toLocaleString();
      body.push(el('p', { class: 'muted' }, `Collector — ${c.kind || d.source}`));
      body.push(el('div', { class: 'cards' },
        stat('Listening', c.listening ? 'yes' : 'no'),
        stat('Datagrams', num(c.datagrams)),
        stat('Flows decoded', num(c.decodedFlows)),
        stat('Buffered', num(c.bufferedFlows)),
        stat('Last datagram', c.lastDatagramAt ? fmtDate(c.lastDatagramAt) : 'never')));
    }
    if (d.hsflowd) {
      body.push(el('p', { class: 'muted' }, 'Local hsflowd exporter: ',
        el('span', { class: hsflowdBadgeClass(d.hsflowd.state) }, d.hsflowd.state || 'unknown')));
      if (d.hsflowd.detail) body.push(el('p', { class: 'muted' }, d.hsflowd.detail));
    }
    body.push(el('details', {}, el('summary', { class: 'muted' }, 'Raw JSON'), el('pre', {}, JSON.stringify(d, null, 2))));

    // Opt-in AI explanation of this snapshot. Reuses the assistant (Mistral, EU);
    // degrades to a hint on 403 so it never looks broken when the feature is off.
    const aiOut = el('div', { class: 'assistant-out muted' }, 'Optional: explain this diagnostic in plain language with the AI assistant (if enabled).');
    const aiBtn = el('button', { class: 'small' }, 'Explain with AI');
    aiBtn.addEventListener('click', async () => {
      aiBtn.disabled = true;
      aiOut.className = 'assistant-out muted';
      aiOut.textContent = 'Thinking…';
      try {
        const res = await api('/api/assistant/diagnose-explain', { method: 'POST', body: { diagnostic: d, hostId: a.id } });
        aiOut.className = 'assistant-out';
        aiOut.replaceChildren(
          el('div', {}, res.answer || '(empty response)'),
          el('div', { class: 'assistant-meta muted' }, `${res.model || ''} · ${res.usedFindings ?? 0} findings in context`));
      } catch (err) {
        aiOut.className = 'assistant-out muted';
        aiOut.textContent = err.status === 403
          ? 'The AI assistant is disabled. An administrator can enable it under Settings → AI.'
          : err.message;
      } finally {
        aiBtn.disabled = false;
      }
    });
    body.push(el('div', { class: 'assistant' }, el('div', { class: 'assistant-row' }, aiBtn), aiOut));
  }
  body.push(el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
  card.replaceChildren(...body);
  $('#modal').classList.remove('hidden');
}

// Why an update went out unsigned, in the operator's terms. The server decides
// which one applies (`signedReason` on the update response); each has a different
// fix, which is the whole reason it is not one message.
const UNSIGNED_REASON_KEY = {
  'no-key': 'agentUpdate.unsigned.noKey',
  'verify-only': 'agentUpdate.unsigned.verifyOnly',
  undecryptable: 'agentUpdate.unsigned.undecryptable',
  'sign-failed': 'agentUpdate.unsigned.signFailed',
};

// An agent refuses an update it cannot authenticate, and says so in these words.
// That refusal is not a mystery to debug — it is the pinned key disagreeing with
// the server's, and it has one fix: re-pin the host.
function isPinnedKeyRefusal(detail) {
  return /unsigned update|signature downgrade|signature did not verify|release public key/i.test(String(detail || ''));
}

// The way out of a pinned-key deadlock, done FROM HERE: the server sends the
// agent its current release key over the same channel it sends updates on, and
// the agent replaces its own trust anchor. No shell on the host, no re-install,
// no second agent — and the update can be retried immediately afterwards.
//
// The one-liner is kept as a fallback for an agent that is not connected (a
// command cannot reach it), not as the way this is normally done.
async function showRepinCommand(a, detail, { retryUpdate = false } = {}) {
  const name = a.display_name || a.hostname;
  let data;
  try {
    data = await api('/api/enroll/repin-command');
  } catch (err) {
    toast(t('agentUpdate.repin.error', { message: errText(err) }), true);
    return;
  }
  const card = $('#modal-card');
  card.classList.add('wide');

  const status = el('div', { class: 'muted small' });
  const fallback = el('div', { class: 'enroll-manual hidden' },
    el('p', { class: 'muted small' }, t('agentUpdate.repin.fallbackIntro')),
    el('div', { class: 'enroll-cmd-row' },
      el('pre', { class: 'enroll-cmd' }, data.oneLiner),
      el('button', { class: 'small', onclick: () => { copyText(data.oneLiner); } }, t('agentUpdate.repin.copy'))),
    el('p', { class: 'muted small' }, t('agentUpdate.repin.run', { host: a.hostname })));

  const go = el('button', {}, t('agentUpdate.repin.send'));
  go.addEventListener('click', async () => {
    go.disabled = true;
    status.textContent = t('agentUpdate.repin.sending');
    try {
      const r = await api(`/agents/${a.id}/rekey`, { method: 'POST' });
      if (!r.accepted) {
        status.className = 'error small';
        status.textContent = t('agentUpdate.repin.declined', { reason: r.reason || '—' });
        fallback.classList.remove('hidden');
        go.disabled = false;
        return;
      }
      toast(t('agentUpdate.repin.done', { name }));
      closeModal();
      // The whole point of re-keying is the update that was refused, so offer to
      // run it again rather than making the operator find the button twice.
      if (retryUpdate) updateAgent(a, null, { confirmed: true });
      else render();
    } catch (err) {
      status.className = 'error small';
      status.textContent = errText(err);
      // An agent that is offline cannot be re-keyed over the channel; that is
      // exactly when the host-side fallback is worth showing.
      fallback.classList.remove('hidden');
      go.disabled = false;
    }
  });

  card.replaceChildren(
    el('h3', {}, t('agentUpdate.repin.title', { name })),
    detail ? el('p', { class: 'muted small' }, t('agentUpdate.repin.refused', { detail })) : null,
    el('p', {}, t('agentUpdate.repin.intro')),
    data.fingerprint
      ? el('p', { class: 'muted small' }, t('agentUpdate.repin.fingerprint'), ' ', el('code', {}, data.fingerprint))
      : null,
    data.canSign ? null : el('p', { class: 'muted small' }, t('agentUpdate.repin.cannotSign')),
    el('p', { class: 'muted small' }, t('agentUpdate.repin.keepsIdentity')),
    el('div', { class: 'form-actions' },
      go,
      el('button', { class: 'small ghost', onclick: () => fallback.classList.toggle('hidden') }, t('agentUpdate.repin.fallback')),
      el('button', { class: 'ghost', onclick: closeModal }, t('agentUpdate.close'))),
    status,
    fallback);
  $('#modal').classList.remove('hidden');
}

// Asks a systemd-managed agent to rebuild from the server's source and restart.
// Docker/unmanaged agents decline (their host rebuilds them) — surface why.
async function updateAgent(a, target, { confirmed = false } = {}) {
  const name = a.display_name || a.hostname;
  const verText = target ? `to v${target}` : 'from the server source';
  // `confirmed` is the retry straight after a re-pin: the operator already said
  // yes to this update once, and asking again for the same action is friction.
  if (!confirmed && !confirm(`Update ${name} ${verText}?\n\nThe agent will rebuild from the server's source bundle and restart, briefly interrupting monitoring on that host.`)) return;
  try {
    const r = await api(`/agents/${a.id}/update`, { method: 'POST' });
    if (r.accepted) {
      // An UNSIGNED push is the one an agent pinned to a release key refuses,
      // and it refuses it after accepting the command — so say it here, while
      // the operator is still looking, not only in the audit trail. Say WHY, too:
      // "no signing key" and "a key that cannot sign" look the same from here and
      // need different fixes.
      if (r.signed === false) {
        toast(`${name}: ${t(UNSIGNED_REASON_KEY[r.signedReason] || UNSIGNED_REASON_KEY['no-key'])}`, true);
      } else {
        toast(`${name}: update sent — rebuilding and restarting.`);
      }
      // "Update sent" is not "update done". The agent rebuilds, restarts and
      // echoes the outcome back into its action-audit row; until now that
      // outcome only existed behind the connection modal, which is how a failed
      // rebuild looked exactly like a successful one. Follow the row.
      if (r.auditId) followAgentAction(a, r.auditId);
      return;
    }
    if (r.reason === 'docker-managed') { toast(`${name} runs under Docker — update it by re-running the host installer.`, true); return; }
    if (r.reason === 'unmanaged') { toast(`${name} isn't service-managed — update it manually (re-run the installer).`, true); return; }
    toast(`${name}: the agent did not accept the update.`, true);
  } catch (err) { toast(`${name}: ${err.message}`, true); }
}

// Polls one agent-action audit row until it goes terminal, then says what
// happened. A rebuild takes a minute or two on a small host, so this watches for
// three, backing off; past that it stops rather than polling forever and points
// at the trail, which keeps the answer whether or not this tab is still open.
const ACTION_POLL_MS = [5000, 5000, 10000, 10000, 15000, 15000, 20000, 20000, 30000, 30000, 30000];
async function followAgentAction(a, auditId) {
  const name = a.display_name || a.hostname;
  for (const wait of ACTION_POLL_MS) {
    await new Promise((r) => setTimeout(r, wait));
    let rows;
    try { rows = await api(`/agents/${a.id}/audit`); } catch { return; } // not admin, or gone — the trail still has it
    const row = (rows || []).find((x) => String(x.id) === String(auditId));
    if (!row || row.state === 'requested') continue;
    if (row.state === 'completed') {
      toast(`${name}: updated${row.target_version ? ` to v${row.target_version}` : ''}.`);
    } else {
      const detail = row.result_detail || 'the agent gave no reason';
      toast(`${name}: the update FAILED — ${detail}.`, true);
      // A refusal over the release key is the one failure with a known fix, so
      // hand it over instead of leaving the operator to read the audit trail.
      if (isPinnedKeyRefusal(detail)) showRepinCommand(a, detail, { retryUpdate: true });
    }
    render();
    return;
  }
  toast(`${name}: the update has not reported back yet. Click the agent's status badge → `
    + '"Update / delete history" for the outcome.', true);
}

// A Windows agent can't be upgraded from the server (it runs under a scheduled
// task, so the pushed update command is declined on the host). Instead of sending
// a command that would just decline, hand the operator the one-liner that updates
// that host IN PLACE. It carries no enrollment code, so it can only ever upgrade
// the agent already on the machine — it never enrolls a second one.
async function showWindowsUpdateCommand(a, target) {
  const name = a.display_name || a.hostname;
  let data;
  try {
    data = await api('/api/enroll/update-command?platform=windows-amd64');
  } catch (err) {
    toast(t('agentUpdate.win.error', { message: errText(err) }), true);
    return;
  }
  const oneLiner = data.oneLiner;
  const from = (a.capabilities && a.capabilities.agentVersion) || '?';
  const to = data.version || target || '?';
  const card = $('#modal-card');
  card.classList.add('wide'); // the one-liner is long — closeModal drops this again
  const manual = el('div', { class: 'enroll-manual hidden' },
    enrollKv(t('agentUpdate.win.download'), el('code', {}, data.manual.downloadUrl)),
    enrollKv(t('agentUpdate.win.checksum'), el('code', {}, data.manual.checksum || '–')),
    data.certFingerprint ? enrollKv('Cert-fingerprint', el('code', {}, data.certFingerprint)) : null);
  card.replaceChildren(
    el('h3', {}, t('agentUpdate.win.title', { name, version: to })),
    el('p', { class: 'muted small' }, t('agentUpdate.win.currentVersion', { from, to })),
    el('p', {}, t('agentUpdate.win.intro')),
    el('div', { class: 'enroll-cmd-row' },
      el('pre', { class: 'enroll-cmd' }, oneLiner),
      el('button', { class: 'small', onclick: () => { copyText(oneLiner); } }, t('agentUpdate.win.copy'))),
    el('p', { class: 'muted small' }, t('agentUpdate.win.run', { host: a.hostname })),
    el('p', { class: 'muted small' }, t('enroll.win.note')),
    el('p', { class: 'muted small' }, t('agentUpdate.win.keepsIdentity')),
    enrollWinStepsBlock(data.steps),
    el('div', { class: 'form-actions' },
      el('button', { class: 'small ghost', onclick: () => manual.classList.toggle('hidden') }, t('agentUpdate.win.manual')),
      el('button', { class: 'ghost', onclick: closeModal }, t('agentUpdate.close'))),
    manual);
  $('#modal').classList.remove('hidden');
}

// Re-pins a set of agents in one go: each is sent this server's current release
// key over its own connection. Sequential rather than parallel — a rekey is a
// trust change, and a per-agent outcome an operator can read beats a single
// "done". An agent that is offline cannot be reached; it is reported, not
// retried, and it picks the key up the next time it is re-pinned.
async function bulkRepinAgents(list) {
  if (!list || !list.length) { toast('No systemd agent is behind, so there is nothing to re-pin.', true); return; }
  const n = list.length;
  if (!confirm(`Re-pin ${n} agent${n > 1 ? 's' : ''} to this server's current signing key?\n\nEach agent replaces the key it verifies updates against. It keeps its token and identity, and monitoring is not interrupted.`)) return;
  let done = 0;
  let offline = 0;
  let failed = 0;
  for (const a of list) {
    try {
      const r = await api(`/agents/${a.id}/rekey`, { method: 'POST' });
      if (r.accepted) done += 1; else failed += 1;
    } catch (err) {
      if (err.status === 409) offline += 1; else failed += 1;
    }
  }
  const bits = [`${done} re-pinned`];
  if (offline) bits.push(`${offline} offline`);
  if (failed) bits.push(`${failed} failed`);
  toast(`Re-pin — ${bits.join(' · ')}.`, offline > 0 || failed > 0);
  render();
}

// Bulk "update all outdated": rebuild every behind agent from the server's
// source. STAGGERED — we wait between agents so they don't all pull the new
// source bundle from the server at the same instant (thundering herd). Each
// agent's managed-state is still honoured (Docker/unmanaged decline on their
// own). Versions refresh on the next agent report, so no forced re-render here.
const BULK_UPDATE_STAGGER_MS = 5000;
async function bulkUpdateAgents(list, target) {
  if (!list || !list.length) return;
  const n = list.length;
  if (!confirm(`Update ${n} outdated agent${n > 1 ? 's' : ''} to v${target || '?'}?\n\nThey're updated one at a time, ${BULK_UPDATE_STAGGER_MS / 1000}s apart, so they don't all download the new build at once. Each rebuilds and restarts, briefly interrupting monitoring on that host.`)) return;
  let sent = 0;
  let declined = 0;
  let failed = 0;
  for (let i = 0; i < list.length; i += 1) {
    try {
      const r = await api(`/agents/${list[i].id}/update`, { method: 'POST' });
      if (r.accepted) sent += 1;
      else declined += 1;
    } catch { failed += 1; }
    // Space out the rest so their downloads don't land on the server together.
    if (i < list.length - 1) await new Promise((resolve) => setTimeout(resolve, BULK_UPDATE_STAGGER_MS));
  }
  const bits = [`${sent} updating`];
  if (declined) bits.push(`${declined} declined (Docker/unmanaged)`);
  if (failed) bits.push(`${failed} failed`);
  toast(`Bulk update — ${bits.join(' · ')}.`, declined > 0 || failed > 0);
}

// ---- Tests (server-defined test packages pushed to agents to run) ---------
// A "test package" is a named set of probe/traffic tests + a target selector
// (all / specific agents / by location) + an optional schedule. The server
// pushes the items to the chosen, connected agents; results land in the usual
// Probes/Traffic views. Read for everyone; operator+ may create/edit/run.

// One-click predefined tests for the editor. They produce ordinary items, so
// the server validates them like any hand-built test. 9.9.9.9 = Quad9 (EU).
const TEST_TEMPLATES = [
  { key: 'latency', label: 'Internet latency — ping 9.9.9.9', item: { type: 'probe', probe: { type: 'ping', host: '9.9.9.9', count: 5 } } },
  { key: 'dns', label: 'DNS resolution — example.com', item: { type: 'probe', probe: { type: 'dns', host: 'example.com' } } },
  { key: 'web', label: 'Web reachability — TCP 443 example.com', item: { type: 'probe', probe: { type: 'tcp', host: 'example.com', port: 443, count: 3 } } },
  { key: 'path', label: 'Path trace — traceroute 9.9.9.9', item: { type: 'probe', probe: { type: 'traceroute', host: '9.9.9.9' } } },
  { key: 'content', label: 'Content check — cURL 200 from example.com', item: { type: 'probe', probe: { type: 'curl', url: 'https://example.com', expectStatus: 200 } } },
  { key: 'pageload', label: 'Page load — example.com (elements + load time)', item: { type: 'probe', probe: { type: 'pageload', url: 'https://example.com' } } },
  { key: 'transaction', label: 'Transaction — 2-step journey (example.com)', item: { type: 'probe', probe: { type: 'transaction', steps: [{ url: 'https://example.com/', expectStatus: 200 }, { url: 'https://example.com/', expectStatus: 200 }] } } },
  { key: 'throughput', label: 'Throughput snapshot — current bandwidth', item: { type: 'run-test', intervalMs: 1000 } },
  { key: 'speed', label: 'Speed test — download/upload to server (Mbps)', item: { type: 'speedtest' } },
];

const SCHEDULE_PRESETS = [
  ['0', 'Manual only'],
  ['60000', 'Every 1 minute'],
  ['300000', 'Every 5 minutes'],
  ['900000', 'Every 15 minutes'],
  ['3600000', 'Every hour'],
  ['21600000', 'Every 6 hours'],
  ['86400000', 'Every 24 hours'],
];

async function testPackagesView() {
  const [packages, agents, locations] = await Promise.all([
    api('/api/test-packages'),
    api('/agents').catch(() => []),
    api('/locations').catch(() => []),
  ]);
  const root = el('div');
  root.append(el('div', { class: 'history-controls' },
    el('span', { class: 'muted' }, `Reusable packages run on a schedule across agents · ${packages.length} package${packages.length === 1 ? '' : 's'}`),
    el('span', { class: 'spacer' }),
    canWrite() ? el('button', { class: 'small', onclick: () => editTestPackage(null, agents, locations) }, '+ New test package') : null));

  if (!packages.length) {
    root.append(el('div', { class: 'empty' }, 'No test packages yet. A test package is a set of probe/traffic tests the server sends to chosen agents to run — on a schedule or on demand.'));
    return root;
  }

  const tbody = el('tbody');
  root.append(el('table', { class: 'tests-table' },
    el('thead', {}, el('tr', {}, ...['Name', 'Tests', 'Targets', 'Schedule', 'Status', 'Last run', ''].map((h) => el('th', {}, h)))),
    tbody));
  tbody.append(...packages.map((p) => testPackageRow(p, agents, locations)));
  return root;
};

function testPackageRow(p, agents, locations) {
  return el('tr', {},
    el('td', {}, el('div', {}, p.name), p.created_by ? el('div', { class: 'muted' }, `by ${String(p.created_by)}`) : null),
    el('td', {}, testItemsSummary(p.items)),
    el('td', {}, testTargetsSummary(p.targets, agents, locations)),
    el('td', {}, testScheduleLabel(p)),
    el('td', {}, el('span', { class: `badge ${p.enabled ? 'active' : 'neutral'}` }, p.enabled ? 'enabled' : 'disabled')),
    el('td', { class: 'muted' }, testLastRun(p)),
    el('td', {}, el('div', { class: 'row-actions' },
      canWrite() ? el('button', { class: 'small', onclick: () => runTestPackage(p) }, 'Run now') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => editTestPackage(p, agents, locations) }, 'Edit') : null,
      canWrite() ? el('button', { class: 'small danger', onclick: () => deleteTestPackage(p) }, 'Delete') : null,
    )),
  );
}

function testItemsSummary(items) {
  if (!items || !items.length) return el('span', { class: 'muted' }, '–');
  const labels = items.map((it) => {
    if (it.type === 'run-test') return 'throughput';
    if (it.type === 'speedtest') return 'speed test';
    if (it.probe.type === 'curl') return `curl ${it.probe.url || it.probe.host}${it.probe.expectStatus ? ' →' + it.probe.expectStatus : ''}`;
    if (it.probe.type === 'pageload') return `pageload ${it.probe.url || it.probe.host}`;
    if (it.probe.type === 'transaction') return `transaction (${(it.probe.steps || []).length} steps)`;
    return `${it.probe.type} ${it.probe.host}${it.probe.port ? ':' + it.probe.port : ''}`;
  });
  return el('span', { class: 'muted small' }, labels.join(', '));
}

function testTargetsSummary(t, agents, locations) {
  if (!t) return '–';
  if (t.mode === 'all') return `All agents (${agents.length})`;
  if (t.mode === 'agents') return `${(t.agentIds || []).length} agent${(t.agentIds || []).length === 1 ? '' : 's'}`;
  if (t.mode === 'location') {
    const names = (t.locationIds || []).map((id) => { const l = locations.find((x) => x.id === id); return l ? l.name : `#${id}`; });
    return `Locations: ${names.join(', ') || '–'}`;
  }
  return '–';
}

// A package carries an interval OR a calendar recurrence — the column says
// which, in the same words the Repeat dialog used to save it.
function testScheduleLabel(pkg) {
  const p = (pkg && typeof pkg === 'object') ? pkg : { schedule_ms: pkg };
  if (p.schedule_spec) return repeatSummary(p.schedule_spec, 1).split(' · ').slice(0, 2).join(' · ');
  const ms = p.schedule_ms;
  const found = SCHEDULE_PRESETS.find(([v]) => Number(v) === Number(ms || 0));
  if (found) return found[1];
  return ms ? `Every ${Math.round(ms / 1000)}s` : t('pkg.schedule.manual');
}

function testLastRun(p) {
  if (!p.last_run_at) return 'never';
  const s = p.last_run_summary;
  const when = fmtDate(p.last_run_at);
  return s ? `${when} · ${s.reached}/${s.targeted} reached` : when;
}

async function runTestPackage(p) {
  try {
    const s = await api(`/api/test-packages/${p.id}/run`, { method: 'POST' });
    if (!s.targeted) { toast(`"${p.name}": no matching agents to run on.`, true); return; }
    toast(`"${p.name}": ${s.reached}/${s.targeted} agents reached, ${s.delivered} test(s) sent.`);
    setTimeout(() => { if (currentView === 'probes' && probesTab === 'packages') render(); }, 1500);
  } catch (err) { toast(errText(err), true); }
}

async function deleteTestPackage(p) {
  if (!confirm(`Delete test package "${p.name}"?`)) return;
  try { await api(`/api/test-packages/${p.id}`, { method: 'DELETE' }); toast('Deleted'); render(); }
  catch (err) { toast(err.message, true); }
}

// Create/edit modal. Builds the form by hand (it's richer than openModal's
// flat field list): targets selector + an items builder with predefined tests.
function editTestPackage(pkg, agents, locations) {
  const card = $('#modal-card');
  const isEdit = !!pkg;
  const data = pkg || { name: '', enabled: true, schedule_ms: 0, targets: { mode: 'all', agentIds: [], locationIds: [] }, items: [] };

  const nameInput = el('input', { type: 'text', value: data.name, placeholder: 'e.g. Daily reachability' });
  const enabledInput = el('input', { type: 'checkbox', ...(data.enabled ? { checked: 'checked' } : {}) });
  // Interval or calendar. Until migration 099 a package could only say "every N
  // ms since the last run", which cannot express a time of day and cannot reach
  // past 24 hours — so "daily at 08:00" and "Mondays" were not sayable here at
  // all. Choosing the calendar option reveals the same recurrence editor the
  // Repeat dialogs use, and stores a spec instead of an interval.
  const hasSpec = !!(data.schedule_spec && data.schedule_spec.period);
  const scheduleSel = el('select', {},
    ...SCHEDULE_PRESETS.map(([v, l]) => el('option', { value: v, ...(!hasSpec && Number(v) === Number(data.schedule_ms || 0) ? { selected: 'selected' } : {}) }, l)),
    el('option', { value: 'calendar', ...(hasSpec ? { selected: 'selected' } : {}) }, t('pkg.schedule.calendar')));
  const recurrence = recurrenceFields({ spec: hasSpec ? data.schedule_spec : null, showRuns: false });
  const recurrenceWrap = el('div', { class: 'pkg-recurrence' }, recurrence.node);
  const syncSchedule = () => { recurrenceWrap.hidden = scheduleSel.value !== 'calendar'; };
  scheduleSel.addEventListener('change', syncSchedule);
  syncSchedule();

  const modeSel = el('select', {}, ...[['all', 'All agents'], ['agents', 'Specific agents'], ['location', 'By location']]
    .map(([v, l]) => el('option', { value: v, ...(data.targets.mode === v ? { selected: 'selected' } : {}) }, l)));
  const agentsBox = el('div', { class: 'check-list' }, ...agents.map((a) => checkRow(a.id, a.display_name || a.hostname, (data.targets.agentIds || []).includes(a.id))));
  const locsBox = el('div', { class: 'check-list' }, ...locations.map((l) => checkRow(l.id, l.name, (data.targets.locationIds || []).includes(l.id))));
  const agentsWrap = el('label', {}, 'Agents', agentsBox);
  const locsWrap = el('label', {}, 'Locations', locations.length ? locsBox : el('span', { class: 'muted small' }, 'No locations defined yet.'));
  const syncMode = () => { agentsWrap.style.display = modeSel.value === 'agents' ? '' : 'none'; locsWrap.style.display = modeSel.value === 'location' ? '' : 'none'; };
  modeSel.addEventListener('change', syncMode);

  const itemsBox = el('div', { class: 'tc-list' });
  const itemRows = [];
  function addItemRow(item) {
    const typeSel = el('select', {}, ...[['ping', 'Ping'], ['tcp', 'TCP'], ['dns', 'DNS'], ['traceroute', 'Traceroute'], ['tcptraceroute', t('probe.tcptraceroute')], ['curl', 'cURL'], ['pageload', 'Page load'], ['transaction', 'Transaction'], ['run-test', 'Throughput'], ['speedtest', 'Speed test']].map(([v, l]) => el('option', { value: v }, l)));
    const host = el('input', { type: 'text', placeholder: 'host / target' });
    const port = el('input', { type: 'number', min: '1', max: '65535', placeholder: 'port' });
    const count = el('input', { type: 'number', min: '1', max: '40', placeholder: 'count' });
    // curl-only: assert the received HTTP status code, a body match, and a header.
    const status = el('input', { type: 'number', min: '100', max: '599', placeholder: 'HTTP code', style: 'width:7em' });
    const body = el('input', { type: 'text', placeholder: 'body: substring or /regex/' });
    const header = el('input', { type: 'text', placeholder: 'header: Name or Name: value' });
    const isTxItem = item && item.type === 'probe' && item.probe && item.probe.type === 'transaction';
    const tx = transactionStepsEditor(isTxItem ? item.probe.steps : []);
    if (item) {
      if (item.type === 'run-test' || item.type === 'speedtest') { typeSel.value = item.type; }
      else {
        typeSel.value = item.probe.type;
        host.value = item.probe.url || item.probe.host || '';
        if (item.probe.port) port.value = item.probe.port;
        if (item.probe.count) count.value = item.probe.count;
        if (item.probe.maxElements) count.value = item.probe.maxElements;
        if (item.probe.expectStatus != null) status.value = item.probe.expectStatus;
        if (item.probe.expectBody) body.value = item.probe.expectBody;
        if (item.probe.expectHeader) header.value = item.probe.expectHeader;
      }
    }
    const ctrl = { typeSel, host, port, count, status, body, header, tx };
    const del = el('button', { type: 'button', class: 'small ghost danger', title: 'Remove', onclick: () => { const i = itemRows.indexOf(ctrl); if (i >= 0) itemRows.splice(i, 1); node.remove(); } }, '×');
    const txWrap = el('div', { class: 'tx-wrap' }, tx.node);
    const node = el('div', { class: 'test-item-row' }, typeSel, host, port, count, status, body, header, del, txWrap);
    const sync = () => {
      const t = typeSel.value;
      const noTarget = t === 'run-test' || t === 'speedtest';
      const isCurl = t === 'curl';
      const isPageload = t === 'pageload';
      const isTx = t === 'transaction';
      const isUrl = isCurl || isPageload;
      host.style.display = (noTarget || isTx) ? 'none' : '';
      host.placeholder = isUrl ? 'https://host/path' : 'host / target';
      port.style.display = t === 'tcp' ? '' : 'none';
      count.style.display = (t === 'ping' || t === 'tcp' || isCurl || isPageload) ? '' : 'none';
      count.placeholder = isPageload ? 'max elements' : 'count';
      count.max = isCurl ? '10' : (isPageload ? '40' : '20');
      for (const f of [status, body, header]) f.style.display = isCurl ? '' : 'none';
      txWrap.style.display = isTx ? '' : 'none';
    };
    typeSel.addEventListener('change', sync); sync();
    itemRows.push(ctrl);
    itemsBox.append(node);
    return ctrl;
  }
  (data.items || []).forEach(addItemRow);

  const tplSel = el('select', {}, el('option', { value: '' }, '+ Add a predefined test…'),
    ...TEST_TEMPLATES.map((t) => el('option', { value: t.key }, t.label)));
  tplSel.addEventListener('change', () => { const t = TEST_TEMPLATES.find((x) => x.key === tplSel.value); if (t) addItemRow(JSON.parse(JSON.stringify(t.item))); tplSel.value = ''; });
  const addCustomBtn = el('button', { type: 'button', class: 'small ghost', onclick: () => addItemRow(null) }, '+ Custom test');

  const err = el('p', { class: 'error' });
  const saveBtn = el('button', { type: 'button', class: 'small' }, isEdit ? 'Save changes' : 'Create');

  function collect() {
    const targets = { mode: modeSel.value, agentIds: [], locationIds: [] };
    if (modeSel.value === 'agents') targets.agentIds = checkedValues(agentsBox);
    if (modeSel.value === 'location') targets.locationIds = checkedValues(locsBox);
    const items = itemRows.map((c) => {
      const t = c.typeSel.value;
      if (t === 'run-test') return { type: 'run-test' };
      if (t === 'speedtest') return { type: 'speedtest' };
      if (t === 'curl') {
        const probe = { type: 'curl', url: c.host.value.trim() };
        if (c.status.value) probe.expectStatus = Number(c.status.value);
        const b = c.body.value.trim(); if (b) probe.expectBody = b;
        const h = c.header.value.trim(); if (h) probe.expectHeader = h;
        if (c.count.value) probe.count = Number(c.count.value);
        return { type: 'probe', probe };
      }
      if (t === 'pageload') {
        const probe = { type: 'pageload', url: c.host.value.trim() };
        if (c.count.value) probe.maxElements = Number(c.count.value);
        return { type: 'probe', probe };
      }
      if (t === 'transaction') {
        return { type: 'probe', probe: { type: 'transaction', steps: c.tx.collect() } };
      }
      const probe = { type: t, host: c.host.value.trim() };
      if (t === 'tcp' && c.port.value) probe.port = Number(c.port.value);
      if ((t === 'ping' || t === 'tcp') && c.count.value) probe.count = Number(c.count.value);
      return { type: 'probe', probe };
    });
    const calendar = scheduleSel.value === 'calendar';
    return {
      name: nameInput.value.trim(),
      enabled: enabledInput.checked,
      schedule_ms: calendar ? 0 : Number(scheduleSel.value),
      schedule_spec: calendar ? recurrence.spec() : null,
      targets,
      items,
    };
  }

  saveBtn.addEventListener('click', async () => {
    err.textContent = '';
    const body = collect();
    if (!body.name) { err.textContent = 'Name is required.'; return; }
    if (!body.items.length) { err.textContent = 'Add at least one test.'; return; }
    if (body.targets.mode === 'agents' && !body.targets.agentIds.length) { err.textContent = 'Select at least one agent.'; return; }
    if (body.targets.mode === 'location' && !body.targets.locationIds.length) { err.textContent = 'Select at least one location.'; return; }
    saveBtn.disabled = true;
    try {
      if (isEdit) await api(`/api/test-packages/${pkg.id}`, { method: 'PUT', body });
      else await api('/api/test-packages', { method: 'POST', body });
      toast('Test package saved');
      closeModal();
      render();
    } catch (e2) { err.textContent = errText(e2); saveBtn.disabled = false; }
  });

  const form = el('div', { class: 'form-grid test-form' },
    el('label', {}, 'Name', nameInput),
    el('label', { class: 'inline' }, enabledInput, ' Enabled'),
    el('label', {}, 'Schedule', scheduleSel),
    recurrenceWrap,
    el('label', {}, 'Targets', modeSel),
    agentsWrap, locsWrap,
    el('div', { class: 'test-items' },
      el('div', { class: 'muted small' }, 'Tests in this package'),
      itemsBox,
      el('div', { class: 'form-actions' }, tplSel, addCustomBtn)),
    err,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'ghost', onclick: closeModal }, 'Cancel'),
      saveBtn));
  syncMode();
  card.replaceChildren(el('h3', {}, isEdit ? 'Edit test package' : 'New test package'), form);
  card.classList.add('wide');
  $('#modal').classList.remove('hidden');
}

function checkRow(id, label, checked) {
  const cb = el('input', { type: 'checkbox', value: String(id), ...(checked ? { checked: 'checked' } : {}) });
  return el('label', { class: 'check-row' }, cb, ' ', label);
}
function checkedValues(box) {
  return [...box.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => Number(c.value));
}

// Per-agent speed-test modal: latest download/upload Mbps + recent history, with
// a "Run speed test now" button (operator+). Results come from /api/speedtest.
async function showSpeedtest(a) {
  const card = $('#modal-card');
  const title = `Speed test — ${a.display_name || a.hostname}`;
  const host = el('div', {}, el('p', { class: 'muted' }, 'Loading…'));
  card.replaceChildren(el('h3', {}, title), host);
  $('#modal').classList.remove('hidden');

  async function load() {
    let data;
    try { data = await api(`/api/speedtest?agentId=${a.id}&limit=20`); }
    catch (err) { host.replaceChildren(el('p', { class: 'error' }, err.message)); return; }
    const rows = data.results || [];
    const kids = [];
    if (canWrite()) {
      const runBtn = el('button', { class: 'small' }, 'Run speed test now');
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true; runBtn.textContent = 'Running…';
        try {
          const r = await api(`/agents/${a.id}/run-speedtest`, { method: 'POST' });
          toast(`Speed test sent to ${a.hostname} (delivered: ${r.delivered}). Result in a few seconds…`);
          setTimeout(load, 6000);
        } catch (err) { toast(err.message, true); runBtn.disabled = false; runBtn.textContent = 'Run speed test now'; }
      });
      // Repeat: the same speed test, on a schedule, as an ordinary test package.
      // The dialog takes over this modal, so a save comes back here rather than
      // leaving the operator on a closed dialog.
      const repeatBtn = el('button', { class: 'small ghost' }, t('repeat.button'));
      repeatBtn.addEventListener('click', () => openRepeatModal({
        what: t('repeat.what.speedtest', { agent: a.display_name || a.hostname }),
        onSave: (spec, runs) => saveRepeatPackage({
          name: `Speed test — ${a.display_name || a.hostname}`.slice(0, 120),
          agentId: a.id,
          item: { type: 'speedtest' },
          spec,
          runs,
        }),
        onSaved: (pkg) => { toast(t('repeat.saved', { name: pkg.name })); showSpeedtest(a); },
      }));
      kids.push(el('div', { class: 'form-actions' }, runBtn, repeatBtn));
    }
    if (!rows.length) {
      kids.push(el('p', { class: 'muted' }, 'No speed-test results yet. Run one now, or add a "Speed test" item to a package on the Tests tab.'));
    } else {
      const latest = rows[0];
      kids.push(el('div', { class: 'cards' },
        stat('Download', latest.down_mbps != null ? `${latest.down_mbps} Mbps` : '–'),
        stat('Upload', latest.up_mbps != null ? `${latest.up_mbps} Mbps` : '–'),
        stat('Measured', fmtDate(latest.ts))));
      kids.push(el('table', {},
        el('thead', {}, el('tr', {}, ...['When', 'Download', 'Upload', 'Status'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...rows.map((r) => el('tr', {},
          el('td', { class: 'muted' }, fmtDate(r.ts)),
          el('td', {}, r.down_mbps != null ? `${r.down_mbps} Mbps` : '–'),
          el('td', {}, r.up_mbps != null ? `${r.up_mbps} Mbps` : '–'),
          el('td', {}, el('span', { class: `badge ${r.ok ? 'ok' : 'bad'}` }, r.ok ? 'ok' : 'failed')))))));
    }
    kids.push(el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
    host.replaceChildren(...kids);
  }
  load();
}

async function showResults(a) {
  try {
    const results = await api(`/agents/${a.id}/results`);
    const card = $('#modal-card');
    const body = [el('h3', {}, `Traffic — ${a.display_name || a.hostname}`)];
    if (!results.length) {
      body.push(el('p', { class: 'muted' }, 'No results yet. Click "Run test".'));
    } else {
      const latest = results[0];
      const t = latest.payload && latest.payload.traffic;
      body.push(el('p', { class: 'muted' }, `Latest: ${fmtDate(latest.created_at)} · ${results.length} measurements`));

      // Flow sources (netflow/sflow) are push-based: a device must export to the
      // agent's UDP collector. When nothing arrives every number is zero, which
      // looks like broken data — call it out explicitly, with how to fix it.
      if (t && (t.source === 'sflow' || t.source === 'netflow')) {
        const received = t.source === 'sflow' ? (t.datagrams || 0) : (t.packets || 0);
        const unit = t.source === 'sflow' ? 'datagrams' : 'packets';
        const port = t.source === 'sflow' ? 6343 : 2055;
        body.push(received === 0
          ? el('div', { class: 'empty' },
            `No ${t.source} ${unit} received — is a device exporting ${t.source} to this agent (UDP ${port})? `
            + `To measure this host's own traffic instead, set the agent's source to "proc" via Edit.`)
          : el('p', { class: 'muted' }, `${t.source}: ${received} ${unit} received · ${fmtBytes(t.totals ? t.totals.bytes : 0)} total.`));
      }

      // Host performance (CPU/memory/load/uptime), when reported.
      const sys = latest.payload && latest.payload.system;
      if (sys) {
        body.push(el('div', { class: 'cards' },
          stat('CPU', `${sys.cpuPercent ?? '–'} %`),
          stat('Memory', sys.memUsedPercent != null ? `${sys.memUsedPercent} % (${fmtBytes(sys.memUsedBytes)} / ${fmtBytes(sys.memTotalBytes)})` : '–'),
          stat('Load (1m)', sys.loadavg ? Number(sys.loadavg[0]).toFixed(2) : '–'),
          stat('Uptime', sys.uptimeSec != null ? fmtDuration(sys.uptimeSec) : '–')));
        // CPU% / memory% over time.
        const sysSeries = results.slice().reverse()
          .filter((r) => r.payload && r.payload.system)
          .map((r) => ({ rx: r.payload.system.cpuPercent || 0, tx: r.payload.system.memUsedPercent || 0 }));
        if (sysSeries.length >= 2) {
          body.push(el('p', { class: 'muted' }, 'CPU % (blue) and memory % (green) over time:'));
          body.push(trafficChart(sysSeries));
        }
      }

      // Traffic over time: oldest -> newest, rate per measurement. Only byte-rate
      // sources (proc/snmp) carry per-measurement RX/TX rates; flow sources
      // (sflow/netflow) report flow aggregates (flows/packets/bytes) with no
      // rx/txBytesPerSec, so this chart would render empty (a NaN axis / "max –")
      // for them — skip it and let the flow breakdown below stand in.
      const flowSource = t && (t.source === 'sflow' || t.source === 'netflow');
      if (!flowSource) {
        const series = results
          .slice()
          .reverse()
          .map((r) => ({
            at: r.created_at,
            rx: Number(r.payload && r.payload.traffic && r.payload.traffic.totals && r.payload.traffic.totals.rxBytesPerSec) || 0,
            tx: Number(r.payload && r.payload.traffic && r.payload.traffic.totals && r.payload.traffic.totals.txBytesPerSec) || 0,
          }));
        if (series.length >= 2) body.push(trafficChart(series));
      }

      if (t && t.interfaces && t.interfaces.length) {
        body.push(el('table', {},
          el('thead', {}, el('tr', {}, ...['Interface', 'RX', 'TX', 'RX/s', 'TX/s'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...t.interfaces.map((i) => el('tr', {},
            el('td', {}, i.iface),
            el('td', {}, fmtBytes(i.rxBytes)),
            el('td', {}, fmtBytes(i.txBytes)),
            el('td', {}, `${fmtBytes(i.rxBytesPerSec)}/s`),
            el('td', {}, `${fmtBytes(i.txBytesPerSec)}/s`),
          )))));
      } else if (t && (t.totals || t.source)) {
        // Flow source (sflow/netflow): no per-interface counters, so summarise the
        // flow aggregate — totals + top breakdowns — instead of dumping raw JSON.
        const num = (n) => Number(n || 0).toLocaleString();
        // Totals are authoritative when present; otherwise reconstruct them from a
        // breakdown (the shape /flows reads). topTalkers/byPort/byProtocol each
        // partition all flows, so summing one recovers the totals — a capped list
        // can undercount, but never collapse real flow data to a misleading "0".
        const sumRows = (rows) => (rows || []).reduce((a, r) => ({
          bytes: a.bytes + (Number(r.bytes) || 0),
          packets: a.packets + (Number(r.packets) || 0),
          flows: a.flows + (Number(r.flows) || 0),
        }), { bytes: 0, packets: 0, flows: 0 });
        const tot = t.totals || sumRows(
          (t.topTalkers && t.topTalkers.length) ? t.topTalkers
            : ((t.byPort && t.byPort.length) ? t.byPort : t.byProtocol));
        const hasFlows = (Number(tot.flows) || 0) > 0 || (Number(tot.bytes) || 0) > 0;
        const cards = [
          stat('Source', t.source || '–'),
          stat('Flows', num(tot.flows)),
          stat('Packets', num(tot.packets)),
          stat('Bytes', fmtBytes(tot.bytes || 0)),
        ];
        if (t.datagrams != null) cards.push(stat('Datagrams', num(t.datagrams)));
        if (t.droppedDatagrams) cards.push(stat('Dropped', num(t.droppedDatagrams)));
        body.push(el('div', { class: 'cards' }, ...cards));

        // Empty window is the common confusing case — say why, in words. Only when
        // there's genuinely no flow data (no totals AND no breakdown rows), so a
        // payload with breakdowns but no totals isn't mislabelled "no data".
        if (!hasFlows) {
          body.push(el('p', { class: 'muted' }, t.datagrams
            ? 'Datagrams are arriving but no flow samples were decoded in this window.'
            : `No ${t.source || 'flow'} data sampled yet — confirm the exporter is sending to the agent's collector (try Diagnose).`));
        }

        const flowTable = (title, rows, keyLabel, keyName, fmtKey) => {
          if (!rows || !rows.length) return;
          body.push(el('p', { class: 'muted' }, title));
          body.push(el('table', {},
            el('thead', {}, el('tr', {}, ...[keyLabel, 'Bytes', 'Packets', 'Flows'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows.slice(0, 10).map((r) => el('tr', {},
              el('td', {}, fmtKey ? fmtKey(r[keyName]) : String(r[keyName])),
              el('td', {}, fmtBytes(r.bytes || 0)),
              el('td', {}, num(r.packets)),
              el('td', {}, num(r.flows)),
            )))));
        };
        flowTable('Top talkers', t.topTalkers, 'Source → destination', 'pair', (p) => String(p).replace('->', ' → '));
        flowTable('By port', t.byPort, 'Port', 'port');
        flowTable('By protocol', t.byProtocol, 'Protocol', 'protocol');

        // Full payload still available, collapsed. NB: el() appends children as
        // text nodes (already XSS-safe), so it must NOT be esc()'d — doing so is
        // what rendered literal &quot; in the old raw dump.
        body.push(el('details', {},
          el('summary', { class: 'muted' }, 'Raw JSON'),
          el('pre', {}, JSON.stringify(latest.payload, null, 2))));
      } else {
        body.push(el('pre', {}, JSON.stringify(latest.payload, null, 2)));
      }
    }
    body.push(el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
    card.replaceChildren(...body);
    $('#modal').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}

// NetFlow search for an agent: filter by port and/or protocol over a time range,
// see top ports/protocols and (when filtered) a bytes-over-time series.
function showAgentFlows(a) {
  const card = $('#modal-card');
  const portInput = el('input', { type: 'number', placeholder: 'e.g. 443', min: '1', max: '65535' });
  const protoInput = el('input', { type: 'text', placeholder: 'e.g. tcp / udp' });
  const result = el('div', {});

  async function search() {
    result.replaceChildren(el('div', { class: 'empty' }, 'Searching…'));
    const qs = new URLSearchParams();
    if (portInput.value.trim()) qs.set('port', portInput.value.trim());
    if (protoInput.value.trim()) qs.set('protocol', protoInput.value.trim());
    let data;
    try {
      data = await api(`/agents/${a.id}/flows?${qs.toString()}`);
    } catch (err) {
      result.replaceChildren(el('p', { class: 'error' }, err.message));
      return;
    }
    const portRows = data.byPort.slice(0, 20).map((p) => el('tr', {},
      el('td', {}, String(p.port)), el('td', {}, fmtBytes(p.bytes)), el('td', {}, String(p.flows))));
    const protoRows = data.byProtocol.slice(0, 20).map((p) => el('tr', {},
      el('td', {}, p.protocol), el('td', {}, fmtBytes(p.bytes)), el('td', {}, String(p.flows))));
    const kids = [el('p', { class: 'muted' }, `${data.measurements} measurements`)];
    if (data.series && data.series.length >= 2) {
      kids.push(trafficChart(data.series.map((s) => ({ rx: s.bytes, tx: 0 }))));
    }
    kids.push(
      el('h4', {}, 'Top ports'),
      data.byPort.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ...['Port', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))), el('tbody', {}, ...portRows))
        : el('div', { class: 'empty' }, 'No flow data. Is NetFlow export enabled on the device pointing to this agent?'),
      el('h4', {}, 'Top protocols'),
      data.byProtocol.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ...['Protocol', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))), el('tbody', {}, ...protoRows))
        : el('div', { class: 'empty' }, '–'));
    result.replaceChildren(...kids);
  }

  card.replaceChildren(
    el('h3', {}, `Flows — ${a.display_name || a.hostname}`),
    el('div', { class: 'form-grid' },
      el('label', {}, 'Port (optional)', portInput),
      el('label', {}, 'Protocol (optional)', protoInput),
      el('div', { class: 'form-actions' },
        el('button', { onclick: search }, 'Search'),
        el('button', { class: 'ghost', onclick: closeModal }, 'Close'))),
    result);
  $('#modal').classList.remove('hidden');
  search();
}

// Inline SVG line chart of RX/TX rate over a series of measurements.
function trafficChart(series) {
  const W = 460;
  const H = 140;
  const pad = { l: 8, r: 8, t: 10, b: 10 };
  const max = Math.max(1, ...series.map((p) => Math.max(p.rx, p.tx)));
  const n = series.length;
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (n - 1);
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const path = (key) => series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const mk = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  // baseline + max gridline
  svg.append(mk('line', { class: 'grid', x1: pad.l, y1: y(0), x2: W - pad.r, y2: y(0) }));
  svg.append(mk('line', { class: 'grid', x1: pad.l, y1: y(max), x2: W - pad.r, y2: y(max) }));
  svg.append(mk('path', { class: 'rx', d: path('rx') }));
  svg.append(mk('path', { class: 'tx', d: path('tx') }));

  return el('div', { class: 'chart' },
    svg,
    el('div', { class: 'legend' },
      el('span', {}, el('span', { class: 'dot rx' }), `RX (max ${fmtBytes(max)}/s)`),
      el('span', {}, el('span', { class: 'dot tx' }), `TX (max ${fmtBytes(max)}/s)`)));
}

// Distinct colours for many simultaneous series.
const SERIES_COLORS = ['#38bdf8', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899',
  '#14b8a6', '#eab308', '#fb923c', '#60a5fa', '#34d399', '#f472b6'];

// Attaches a drag-to-select brush to a chart SVG. onSelect receives the start
// and end as fractions (0..1) of the plot area; right-click triggers onClear.
// Shared by the live overview chart and the history chart.
function attachBrush(svg, { W, padL, padR, padT, padB, H, onSelect, onClear }) {
  const ns = 'http://www.w3.org/2000/svg';
  const rect = document.createElementNS(ns, 'rect');
  const attrs = { class: 'brush', x: 0, y: padT, width: 0, height: H - padT - padB, fill: 'rgba(56,189,248,.15)', stroke: '#38bdf8', 'stroke-width': 1, visibility: 'hidden' };
  for (const [k, v] of Object.entries(attrs)) rect.setAttribute(k, v);
  svg.append(rect);
  let startX = null;
  const toViewX = (clientX) => { const r = svg.getBoundingClientRect(); return Math.max(padL, Math.min(W - padR, ((clientX - r.left) / r.width) * W)); };
  svg.addEventListener('mousedown', (e) => { startX = toViewX(e.clientX); rect.setAttribute('x', startX); rect.setAttribute('width', 0); rect.setAttribute('visibility', 'visible'); });
  svg.addEventListener('mousemove', (e) => { if (startX === null) return; const cx = toViewX(e.clientX); rect.setAttribute('x', Math.min(startX, cx)); rect.setAttribute('width', Math.abs(cx - startX)); });
  svg.addEventListener('mouseup', (e) => {
    if (startX === null) return;
    const cx = toViewX(e.clientX); const x0 = Math.min(startX, cx); const x1 = Math.max(startX, cx);
    startX = null; rect.setAttribute('visibility', 'hidden');
    if (x1 - x0 < 6) return;
    const denom = W - padL - padR;
    onSelect((x0 - padL) / denom, (x1 - padL) / denom);
  });
  svg.addEventListener('mouseleave', () => { startX = null; rect.setAttribute('visibility', 'hidden'); });
  if (onClear) svg.addEventListener('contextmenu', (e) => { e.preventDefault(); onClear(); });
}

// A large, full-width multi-series line chart. `series` is an array of
// { id, label, color, points:[{x,y}] }. Time (x) is shared; y auto-scales.
// Pass onBrush(f0,f1) (fractions) to enable drag-to-mark; right-click clears it.
function multiChart(seriesList, { height = 320, xLabels = null, onBrush = null, area = false } = {}) {
  const W = 1000;
  const H = height;
  const pad = { l: 60, r: 12, t: 14, b: 22 };
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const all = seriesList.flatMap((s) => s.points.map((p) => p.y));
  const max = Math.max(1, ...all);
  const maxLen = Math.max(2, ...seriesList.map((s) => s.points.length));
  const x = (i, n) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, (n - 1));
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);

  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, class: 'big-chart-svg', preserveAspectRatio: 'none' });
  // y gridlines + labels (0, 50%, 100%).
  for (const frac of [0, 0.5, 1]) {
    const yy = y(max * frac);
    svg.append(mk('line', { class: 'grid', x1: pad.l, y1: yy, x2: W - pad.r, y2: yy }));
    const label = mk('text', { x: 6, y: yy + 4, class: 'axis' });
    label.textContent = `${fmtBytes(max * frac)}/s`;
    svg.append(label);
  }
  // Optional x (time) gridlines at each non-empty tick — drawn under the data.
  if (Array.isArray(xLabels) && xLabels.length > 1) {
    xLabels.forEach((text, i) => {
      if (!text) return;
      const frac = i / (xLabels.length - 1);
      const xx = pad.l + frac * (W - pad.l - pad.r);
      svg.append(mk('line', { class: 'grid', x1: xx, y1: pad.t, x2: xx, y2: H - pad.b }));
    });
  }
  // Optional area fill under each line (drawn first, so lines sit on top).
  if (area) {
    for (const s of seriesList) {
      if (!s.points.length) continue;
      const n = s.points.length;
      const top = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i, n).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
      const d = `${top} L${x(n - 1, n).toFixed(1)},${y(0).toFixed(1)} L${x(0, n).toFixed(1)},${y(0).toFixed(1)} Z`;
      svg.append(mk('path', { d, fill: s.color, 'fill-opacity': '0.12', stroke: 'none' }));
    }
  }
  for (const s of seriesList) {
    if (!s.points.length) continue;
    const n = s.points.length;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i, n).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    svg.append(mk('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2 }));
  }
  // Optional x-axis time hints (start / mid / end).
  if (Array.isArray(xLabels)) {
    xLabels.forEach((text, i) => {
      if (!text) return;
      const frac = xLabels.length === 1 ? 0 : i / (xLabels.length - 1);
      const xx = pad.l + frac * (W - pad.l - pad.r);
      const t = mk('text', { x: xx, y: H - 6, class: 'axis', 'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle' });
      t.textContent = text;
      svg.append(t);
    });
  }
  if (onBrush) {
    attachBrush(svg, { W, padL: pad.l, padR: pad.r, padT: pad.t, padB: pad.b, H, onSelect: (f0, f1) => onBrush(f0, f1), onClear: () => onBrush(null, null) });
  }
  return el('div', { class: 'big-chart' }, svg);
}

// Metric/traffic types selectable in the history view.
const METRIC_DEFS = [
  ['rx', 'RX (bytes/s)'], ['tx', 'TX (bytes/s)'],
  ['cpu', 'CPU %'], ['mem', 'Mem %'], ['load1', 'Load1'],
];
const histState = { agentId: '', metrics: new Set(['rx', 'tx']) };

// (toLocalInput(Date) lives with the other datetime-local helpers below.)
function fmtNum(v) { return v >= 1024 ? fmtBytes(v) : String(Math.round(v * 10) / 10); }
function fmtTimeShort(ms) {
  return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
// Clock with seconds — for the live overview's running time ticks.
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Legend row for a chart: a coloured dot + label per series.
function legendFor(seriesList) {
  return el('div', { class: 'legend' }, ...seriesList.map((s) =>
    el('span', {}, el('span', { class: 'dot', style: `background:${s.color}` }), s.label)));
}

// Time-axis line chart with a drag-to-zoom brush. `series`: [{id,label,color,
// points:[{t(ms),y}]}]. onBrush(fromMs,toMs) fires when the user marks an area.
// Linear-interpolated percentile of a sorted ascending array.
function pctl(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// A robust "normal range" for a single series: median ± k·MAD (≈σ), so an outlier
// stands out against what's typical for the shown window. Local + explainable —
// same median/MAD basis the server analysis uses. null when too few points.
function robustBand(points, k = 3) {
  const ys = (points || []).map((p) => p.y).filter(Number.isFinite).sort((a, b) => a - b);
  if (ys.length < 4) return null;
  const med = pctl(ys, 0.5);
  const dev = ys.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const spread = (pctl(dev, 0.5) * 1.4826 * k) || (med * 0.1) || 1;
  return { mid: med, lo: Math.max(0, med - spread), hi: med + spread };
}
// Findings → chart markers (vertical event lines).
function findingMarkers(findings) {
  return (findings || []).filter((f) => f && f.createdAt).map((f) => ({
    t: new Date(f.createdAt).getTime(),
    kind: f.severity || 'INFO',
    label: `${f.severity || ''} · ${f.metric || ''}${f.explanation ? ': ' + f.explanation : ''}`.slice(0, 140),
  }));
}

// Time-axis chart. Optional `band` ({lo,hi,mid}) shades a normal range (#6);
// optional `markers` ([{t,kind,label}]) draws event lines (#7).
function historyChart(seriesList, { fromMs, toMs, onBrush, height = 300, band = null, markers = null }) {
  const W = 1000;
  const H = height;
  const pad = { l: 64, r: 12, t: 14, b: 28 };
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const all = seriesList.flatMap((s) => s.points.map((p) => p.y));
  if (band) all.push(band.hi);
  const max = Math.max(1, ...all);
  const span = Math.max(1, toMs - fromMs);
  const xOf = (t) => pad.l + ((t - fromMs) / span) * (W - pad.l - pad.r);
  const yOf = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const yClamp = (v) => Math.max(pad.t, Math.min(H - pad.b, yOf(v)));
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, class: 'big-chart-svg', preserveAspectRatio: 'none' });

  for (const frac of [0, 0.5, 1]) {
    const yy = yOf(max * frac);
    svg.append(mk('line', { class: 'grid', x1: pad.l, y1: yy, x2: W - pad.r, y2: yy }));
    const lbl = mk('text', { x: 6, y: yy + 4, class: 'axis' }); lbl.textContent = fmtNum(max * frac); svg.append(lbl);
  }
  for (const frac of [0, 0.5, 1]) {
    const t = fromMs + frac * span; const xx = xOf(t);
    svg.append(mk('line', { class: 'grid', x1: xx, y1: pad.t, x2: xx, y2: H - pad.b }));
    const lbl = mk('text', { x: xx, y: H - 8, class: 'axis', 'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle' });
    lbl.textContent = fmtTimeShort(t); svg.append(lbl);
  }
  // Normal-range band (drawn under the data lines).
  if (band && band.hi != null && band.lo != null) {
    const yHi = yClamp(band.hi); const yLo = yClamp(band.lo);
    svg.append(mk('rect', { x: pad.l, y: Math.min(yHi, yLo), width: W - pad.l - pad.r, height: Math.max(1, Math.abs(yLo - yHi)), fill: '#38bdf8', 'fill-opacity': '0.10' }));
    if (band.mid != null) svg.append(mk('line', { x1: pad.l, y1: yClamp(band.mid), x2: W - pad.r, y2: yClamp(band.mid), stroke: '#38bdf8', 'stroke-opacity': '0.5', 'stroke-dasharray': '4 4', 'stroke-width': 1 }));
  }
  for (const s of seriesList) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(' ');
    svg.append(mk('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2 }));
  }
  // Event markers (drawn on top), CLUSTERED by position.
  //
  // One line per marker is fine for a handful and ruinous past that. An ongoing
  // problem raises a finding every cooldown window — roughly one every half hour
  // per (metric, target) — so a ten-day view of a target that has been unhappy
  // carries several hundred. Drawn individually they cover every pixel column:
  // the chart becomes a red hatch with the data line somewhere underneath, and
  // the triangles merge into a solid strip along the axis. That is not a dense
  // chart, it is a destroyed one.
  //
  // The answer is not to draw fewer and pretend. Markers closer together than a
  // triangle is wide collapse into ONE marker that carries the count and the
  // worst severity among them, so the chart says "forty events here, worst
  // CRIT" instead of drawing forty indistinguishable lines or hiding
  // thirty-nine. The number of marks is then bounded by the chart's width, which
  // is the only bound that actually holds.
  if (Array.isArray(markers) && markers.length) {
    const colOf = (k) => (k === 'CRIT' ? '#dc2626' : k === 'WARN' ? '#d97706' : k === 'probe' ? '#dc2626' : '#64748b');
    // Severity wins over recency when a cluster is summarised: a CRIT hidden
    // inside a run of INFOs is the one thing somebody is looking for.
    const RANK = { CRIT: 4, probe: 3, WARN: 2, INFO: 1 };
    const rank = (k) => RANK[k] || 1;
    const SLOT = 8; // the triangle is 8px wide; anything closer cannot be told apart
    const clusters = new Map();
    for (const m of markers) {
      if (!Number.isFinite(m.t) || m.t < fromMs || m.t > toMs) continue;
      const xx = xOf(m.t);
      const key = Math.round(xx / SLOT);
      let c = clusters.get(key);
      if (!c) { c = { x: xx, n: 0, kind: 'INFO', labels: [] }; clusters.set(key, c); }
      c.n += 1;
      if (rank(m.kind) > rank(c.kind)) c.kind = m.kind;
      if (c.labels.length < 4 && m.label) c.labels.push(m.label);
    }
    for (const c of clusters.values()) {
      const col = colOf(c.kind);
      svg.append(mk('line', { x1: c.x, y1: pad.t, x2: c.x, y2: H - pad.b, stroke: col, 'stroke-opacity': '0.45', 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
      // A cluster is drawn a little taller than a single event, so "a lot
      // happened here" is legible without opening the tooltip.
      const h = c.n > 1 ? 10 : 7;
      const tri = mk('path', { class: 'chart-marker', d: `M${c.x - 4},${H - pad.b} L${c.x + 4},${H - pad.b} L${c.x},${H - pad.b - h} Z`, fill: col });
      const title = mk('title', {});
      title.textContent = c.n > 1
        ? `${c.n} events${c.labels.length ? `\n${c.labels.join('\n')}` : ''}${c.n > c.labels.length ? `\n+${c.n - c.labels.length} more` : ''}`
        : (c.labels[0] || '');
      tri.append(title);
      svg.append(tri);
    }
  }

  if (onBrush) {
    attachBrush(svg, { W, padL: pad.l, padR: pad.r, padT: pad.t, padB: pad.b, H, onSelect: (f0, f1) => onBrush(Math.round(fromMs + f0 * span), Math.round(fromMs + f1 * span)) });
  }
  return el('div', { class: 'big-chart' }, svg);
}

// Historical traffic for one agent over a date range, with selectable metric
// types and a drag-to-zoom brush to investigate a specific timeframe.
function trafficHistorySection({ onData = () => {} } = {}) {
  const wrap = el('div', { class: 'history' });
  const agentSel = el('select', {}, el('option', { value: '' }, 'Select agent…'));
  const fromI = el('input', { type: 'datetime-local' });
  const toI = el('input', { type: 'datetime-local' });
  const now = Date.now();
  toI.value = toLocalInput(new Date(now));
  fromI.value = toLocalInput(new Date(now - 3600000));

  const metricBoxes = METRIC_DEFS.map(([key, label]) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = histState.metrics.has(key);
    cb.addEventListener('change', () => { if (cb.checked) histState.metrics.add(key); else histState.metrics.delete(key); renderChart(); });
    return el('label', { class: 'check' }, cb, label);
  });

  const chartHost = el('div', { class: 'overview-chart' });
  const status = el('div', { class: 'muted' });
  let baseFrom = null;
  let baseTo = null;
  // Cache of the last fetch so ticking/unticking a metric re-renders the chart
  // WITHOUT refetching — the samples, window and finding markers don't change,
  // only which series are drawn.
  let lastPoints = null;
  let lastFromMs = null;
  let lastToMs = null;
  let lastMarkers = [];

  const fetchBtn = el('button', { class: 'small', onclick: () => { baseFrom = fromI.value; baseTo = toI.value; load(); } }, 'Fetch');
  const resetBtn = el('button', { class: 'small ghost', onclick: () => { if (baseFrom) { fromI.value = baseFrom; toI.value = baseTo; load(); } } }, 'Reset zoom');

  wrap.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Agent ', agentSel),
    el('label', { class: 'inline muted' }, 'From ', fromI),
    el('label', { class: 'inline muted' }, 'To ', toI),
    fetchBtn, resetBtn));
  wrap.append(el('div', { class: 'history-metrics' }, ...metricBoxes));
  wrap.append(chartHost, status);

  agentSel.addEventListener('change', () => { histState.agentId = agentSel.value; });
  api('/agents').then((agents) => {
    for (const a of agents) agentSel.append(el('option', { value: String(a.id) }, a.display_name || a.hostname));
    if (histState.agentId) agentSel.value = histState.agentId;
  }).catch(() => {});

  // Pass an explicit { fromMs, toMs } to bypass the minute-granular inputs — a
  // brush/drill-in keeps sub-minute precision (otherwise from===to → invalid).
  async function load(range) {
    const agentId = agentSel.value;
    histState.agentId = agentId;
    if (!agentId) { onData({ state: 'prompt' }); status.textContent = 'Select an agent.'; return; }
    let fromMs = range ? range.fromMs : (fromI.value ? new Date(fromI.value).getTime() : NaN);
    let toMs = range ? range.toMs : (toI.value ? new Date(toI.value).getTime() : NaN);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) { onData({ state: 'prompt' }); status.textContent = 'Invalid period.'; return; }
    if (toMs < fromMs) { const tmp = fromMs; fromMs = toMs; toMs = tmp; }
    // Guarantee a usable window even for a tiny brush (agents report ~every 60s).
    const MIN_MS = 60 * 1000;
    if (toMs - fromMs < MIN_MS) { const mid = (fromMs + toMs) / 2; fromMs = Math.round(mid - MIN_MS / 2); toMs = Math.round(mid + MIN_MS / 2); }
    status.textContent = 'Fetching…';
    chartHost.replaceChildren();
    lastPoints = null; // a failed/empty fetch must not leave stale data for a toggle
    let rows;
    try {
      rows = await api(`/agents/${agentId}/results?from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}&limit=5000`);
    } catch (err) { status.textContent = err.message; return; }
    const points = rows.map((r) => {
      const p = r.payload || {}; const sys = p.system || {}; const tot = (p.traffic && p.traffic.totals) || {};
      return {
        t: new Date(r.created_at).getTime(),
        rx: Number(tot.rxBytesPerSec) || 0, tx: Number(tot.txBytesPerSec) || 0,
        cpu: Number(sys.cpuPercent) || 0, mem: Number(sys.memUsedPercent) || 0,
        load1: Array.isArray(sys.loadavg) ? Number(sys.loadavg[0]) || 0 : 0,
      };
    }).sort((a, b) => a.t - b.t);
    if (!points.length) { onData({ state: 'empty', agentId, fromMs, toMs }); status.textContent = 'No data in this period.'; return; }
    status.textContent = `${points.length} measurements`;
    // Feed the companion Traffic types card the same samples (no extra fetch).
    onData({ state: 'data', agentId, fromMs, toMs, points });
    // #7 event timeline: findings for this agent in the window as markers.
    let markers = [];
    try { const fs = await api(`/api/findings?hostId=${encodeURIComponent(agentId)}&since=${new Date(fromMs).toISOString()}`); markers = findingMarkers(fs); } catch { markers = []; }
    // Cache the window so the metric checkboxes can redraw it live, then draw.
    lastPoints = points; lastFromMs = fromMs; lastToMs = toMs; lastMarkers = markers;
    renderChart();
  }

  // Draws the chart from the LAST fetched samples and the current metric
  // selection, so ticking/unticking a type updates the chart instantly without
  // refetching. A no-op until something has been fetched.
  function renderChart() {
    if (!lastPoints || !lastPoints.length) return;
    const chosen = METRIC_DEFS.filter(([k]) => histState.metrics.has(k));
    if (!chosen.length) { chartHost.replaceChildren(el('div', { class: 'empty' }, 'Select at least one type.')); return; }
    const seriesList = chosen.map(([k, label], idx) => ({ id: k, label, color: SERIES_COLORS[idx % SERIES_COLORS.length], points: lastPoints.map((p) => ({ t: p.t, y: p[k] })) }));
    const legend = legendFor(seriesList);
    // Band (#6) only when a single metric is shown (otherwise scales clash).
    const band = seriesList.length === 1 ? robustBand(seriesList[0].points) : null;
    chartHost.replaceChildren(historyChart(seriesList, { fromMs: lastFromMs, toMs: lastToMs, band, markers: lastMarkers, onBrush: (f, t) => { fromI.value = toLocalInput(new Date(f)); toI.value = toLocalInput(new Date(t)); load({ fromMs: f, toMs: t }); } }), legend);
  }

  // Called from the live graph's brush: load the actual stored data for the
  // marked window (per agent). Pre-fills the period and runs the query.
  function focus(fromMs, toMs) {
    // The live-marked window can be only seconds wide; pad it so there are
    // actually stored measurements to show (report interval ~60s).
    let a = fromMs;
    let b = toMs;
    const MIN = 10 * 60 * 1000;
    if (b - a < MIN) { const mid = (a + b) / 2; a = Math.round(mid - MIN / 2); b = Math.round(mid + MIN / 2); }
    baseFrom = toLocalInput(new Date(a));
    baseTo = toLocalInput(new Date(b));
    fromI.value = baseFrom;
    toI.value = baseTo;
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (agentSel.value) {
      load({ fromMs: a, toMs: b });
    } else {
      status.className = 'muted';
      status.textContent = 'Select an agent to see the stored data for the marked window.';
    }
  }

  return { node: wrap, focus };
}

// Compact aggregate companion shown beside the History panel. It derives total
// / peak / split RX·TX from the SAME samples the history chart already fetched
// (no extra API call) and, best-effort, lists the top traffic-type categories
// from /api/flows/categories. Driven by the history section via update() — see
// trafficHistorySection({ onData }).
function trafficTypesCard() {
  const body = el('div', { class: 'tt-body' });
  const card = el('details', { class: 'sec tt-card', open: '' },
    el('summary', {}, 'Traffic types ', el('span', { class: 'muted' }, '· aggregated for selected period')),
    body);
  let reqToken = 0; // guards against out-of-order /categories responses

  const statNode = (label, value, sub) => el('div', { class: 'tt-stat' },
    el('div', { class: 'l' }, label),
    el('div', { class: 'v' }, value),
    sub ? el('div', { class: 's' }, sub) : null);

  // Representative sample interval (seconds): robust median of the gaps between
  // consecutive samples (agents report ~every 60s). Used to turn bytes/s
  // samples into a byte total for the window (Σ samples × interval).
  function intervalSec(points) {
    if (points.length < 2) return 60;
    const gaps = [];
    for (let i = 1; i < points.length; i += 1) {
      const d = (points[i].t - points[i - 1].t) / 1000;
      if (d > 0) gaps.push(d);
    }
    if (!gaps.length) return 60;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  // Best-effort top traffic types. Server-side classification exists
  // (/api/flows/categories: port + ASN categories); if it is empty or fails we
  // note that a protocol breakdown is not yet available.
  function renderTypes(payload) {
    const host = el('div', { class: 'tt-types' }, el('h4', {}, 'Top types'), el('div', { class: 'muted' }, 'Loading…'));
    body.append(host);
    const myToken = (reqToken += 1);
    const unavailable = () => host.replaceChildren(el('h4', {}, 'Top types'), el('div', { class: 'muted' }, 'Protocol breakdown is not yet available'));
    api(`/api/flows/categories?agentId=${encodeURIComponent(payload.agentId)}&from=${new Date(payload.fromMs).toISOString()}&to=${new Date(payload.toMs).toISOString()}`)
      .then((data) => {
        if (myToken !== reqToken) return; // superseded by a newer load
        const cats = (data && data.categories) || [];
        if (!cats.length) { unavailable(); return; }
        const top = cats.slice(0, 5);
        const max = Math.max(1, ...top.map((c) => c.total));
        host.replaceChildren(el('h4', {}, 'Top types'), el('ul', {}, ...top.map((c, i) => el('li', {},
          el('span', { class: 'sw', style: `background:${SERIES_COLORS[i % SERIES_COLORS.length]}` }),
          el('span', { class: 'nm' }, c.label),
          el('span', { class: 'tt-mini' }, el('span', { class: 'tt-mini-fill', style: `width:${Math.round((c.total / max) * 100)}%` })),
          el('span', { class: 'by' }, fmtBytes(c.total))))));
      })
      .catch(() => { if (myToken === reqToken) unavailable(); });
  }

  // Called by the history section after every load() (Fetch / brush / focus).
  function update(payload) {
    reqToken += 1; // cancel any in-flight categories request
    const state = payload && payload.state;
    if (state !== 'data') {
      body.replaceChildren(el('div', { class: 'empty' }, state === 'prompt' ? 'Select an agent and load data' : 'No traffic data in the selected period'));
      return;
    }
    const points = payload.points || [];
    const sec = intervalSec(points);
    let totalRx = 0;
    let totalTx = 0;
    let peakRx = { y: -1, t: 0 };
    let peakTx = { y: -1, t: 0 };
    for (const p of points) {
      totalRx += p.rx * sec;
      totalTx += p.tx * sec;
      if (p.rx > peakRx.y) peakRx = { y: p.rx, t: p.t };
      if (p.tx > peakTx.y) peakTx = { y: p.tx, t: p.t };
    }
    const sum = totalRx + totalTx;
    const rxPct = sum > 0 ? Math.round((totalRx / sum) * 100) : 0;
    const txPct = sum > 0 ? 100 - rxPct : 0;

    body.replaceChildren(
      el('div', { class: 'tt-totals' },
        statNode('Total RX', fmtBytes(totalRx)),
        statNode('Total TX', fmtBytes(totalTx))),
      el('div', { class: 'tt-split' },
        el('div', { class: 'l' }, 'RX/TX split'),
        el('div', { class: 'split-bar' },
          el('span', { class: 'rx', style: `width:${rxPct}%` }),
          el('span', { class: 'tx', style: `width:${txPct}%` })),
        el('div', { class: 'split-legend' }, `RX ${rxPct}% · TX ${txPct}%`)),
      el('div', { class: 'tt-peaks' },
        statNode('Peak RX', peakRx.y >= 0 ? `${fmtBytes(peakRx.y)}/s` : '–', peakRx.y > 0 ? fmtTimeShort(peakRx.t) : null),
        statNode('Peak TX', peakTx.y >= 0 ? `${fmtBytes(peakTx.y)}/s` : '–', peakTx.y > 0 ? fmtTimeShort(peakTx.t) : null)));
    renderTypes(payload);
  }

  update({ state: 'prompt' });
  return { node: card, update };
}

// Traffic-type breakdown for one agent over a period: bytes per category
// (DNS, Web, Facebook, ...) from flow metadata — toggle each type on/off.
// Separate from the live RX/TX chart; opt-in (the section is collapsed).
function trafficTypeSection() {
  const wrap = el('div', { class: 'history traffic-type' });
  const agentSel = el('select', {}, el('option', { value: '' }, 'Select agent…'));
  const fromI = el('input', { type: 'datetime-local' });
  const toI = el('input', { type: 'datetime-local' });
  const now = Date.now();
  toI.value = toLocalInput(new Date(now));
  fromI.value = toLocalInput(new Date(now - 6 * 3600000));
  const status = el('div', { class: 'muted' });
  const chips = el('div', { class: 'bar tt-chips' });
  const chartHost = el('div', { class: 'overview-chart' });
  const selection = new Set();
  let last = null; // last /api/flows/categories response

  const fetchBtn = el('button', { class: 'small', onclick: () => load() }, 'Fetch');
  wrap.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Agent ', agentSel),
    el('label', { class: 'inline muted' }, 'From ', fromI),
    el('label', { class: 'inline muted' }, 'To ', toI),
    fetchBtn));
  wrap.append(chips, chartHost, status);

  api('/agents').then((agents) => {
    for (const a of agents) agentSel.append(el('option', { value: String(a.id) }, a.display_name || a.hostname));
  }).catch(() => {});

  const colorAt = (i) => SERIES_COLORS[i % SERIES_COLORS.length];

  function renderChips() {
    if (!last || !last.categories.length) { chips.replaceChildren(); return; }
    chips.replaceChildren(el('span', { class: 'muted' }, 'Types:'), ...last.categories.map((c, i) => {
      const on = selection.has(c.id);
      return el('button', {
        class: `chip${on ? ' on' : ''}`,
        style: on ? `border-color:${colorAt(i)};color:${colorAt(i)}` : '',
        onclick: () => { if (selection.has(c.id)) selection.delete(c.id); else selection.add(c.id); renderChips(); renderChart(); },
      }, `${c.label} · ${fmtBytes(c.total)}`);
    }));
  }

  function renderChart() {
    if (!last || !last.categories.length) {
      chartHost.replaceChildren(el('div', { class: 'empty' }, 'No traffic type data in this period.'));
      return;
    }
    const fromMs = Date.parse(last.from);
    const toMs = Date.parse(last.to);
    const chosen = last.categories.filter((c) => selection.has(c.id));
    const seriesList = chosen.map((c) => ({
      id: c.id, label: c.label, color: colorAt(last.categories.indexOf(c)),
      points: last.buckets.map((iso, k) => ({ t: Date.parse(iso), y: Number(c.points[k]) || 0 })),
    }));
    const legend = legendFor(seriesList);
    chartHost.replaceChildren(
      seriesList.length ? historyChart(seriesList, { fromMs, toMs }) : el('div', { class: 'empty' }, 'Select one or more types above.'),
      legend);
  }

  async function load() {
    const agentId = agentSel.value;
    if (!agentId) { status.className = 'muted'; status.textContent = 'Select an agent.'; return; }
    const fromMs = fromI.value ? new Date(fromI.value).getTime() : NaN;
    const toMs = toI.value ? new Date(toI.value).getTime() : NaN;
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) { status.textContent = 'Invalid period.'; return; }
    status.className = 'muted'; status.textContent = 'Fetching…';
    chartHost.replaceChildren(); chips.replaceChildren();
    let data;
    try {
      data = await api(`/api/flows/categories?agentId=${encodeURIComponent(agentId)}&from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}`);
    } catch (err) { status.textContent = err.message; return; }
    last = data;
    selection.clear();
    for (const c of data.categories.slice(0, 6)) selection.add(c.id); // default: top types on
    status.textContent = data.categories.length
      ? `${data.categories.length} traffic types in this period`
      : 'No traffic types in this period — requires a NetFlow/sFlow source (port types) or geo data (organisations).';
    renderChips();
    renderChart();
  }

  return { node: wrap };
}

// Full-width traffic overview: pick which series to show via checkboxes and
// watch them live. Polls every 3s while open.
// Server storage cards: disk usage (where Docker/DB lives) + database size.
function fmtTimeToFull(days) {
  if (!Number.isFinite(days) || days <= 0) return '–';
  if (days >= 730) return `~${Math.round(days / 365)} yr`;
  if (days >= 60) return `~${Math.round(days / 30)} mo`;
  if (days >= 1) return `~${Math.round(days)} days`;
  return '< 1 day';
}

// Slim one-line storage summary (the parts of a <summary> row): disk usage bar +
// a terse "· MySQL … · TSDB … · ~…/dag · disk fuld …". The split breakdown folds
// open below. Telemetry is being split across two stores (MySQL + TimescaleDB,
// see docs/storage-split-audit.md), so both DB sizes are surfaced here.
function storageLineParts(s) {
  const d = s.disk || {};
  const db = s.database || {};
  const tsdb = s.tsdb || null;
  const ing = s.ingest || null;
  const parts = [el('span', { class: 'muted' }, 'Storage')];
  if (d.available) {
    parts.push(usageBar(d.usedPercent));
    parts.push(el('span', { class: 'num' }, `${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)} (${d.usedPercent}%)`));
  } else {
    parts.push(el('span', { class: 'muted' }, 'drive unavailable'));
  }
  const extra = [];
  // Label the store as "MySQL" (not just "DB") only when the TSDB half is
  // actually in use, so single-store installs keep the terser wording.
  const tsdbActive = tsdb && tsdb.configured && !tsdb.error;
  if (!db.error && db.totalBytes != null) extra.push(`${tsdbActive ? 'MySQL' : 'DB'} ${fmtBytes(db.totalBytes)}`);
  if (tsdbActive && tsdb.totalBytes != null) extra.push(`TSDB ${fmtBytes(tsdb.totalBytes)}`);
  else if (tsdb && tsdb.configured && tsdb.error) extra.push('TSDB unavailable');
  if (ing) {
    const perSec = ing.minutes > 0 ? ing.bytes / (ing.minutes * 60) : 0;
    extra.push(`~${fmtBytes(ing.bytesPerDay)}/day`);
    if (d.available && perSec > 0 && d.freeBytes > 0) extra.push(`disk full ${fmtTimeToFull(d.freeBytes / (perSec * 86400))}`);
  }
  if (extra.length) parts.push(el('span', { class: 'muted num' }, `· ${extra.join(' · ')}`));
  parts.push(el('span', { class: 'spacer' }));
  parts.push(el('span', { class: 'fold-cta muted' }, 'Details'));
  return parts;
}

// One store's rows inside the split card: total size + a "N tables · largest …"
// summary. Shared by the MySQL and TimescaleDB columns so both render alike.
function storeSection(opts) {
  const { label, sub, info, kind } = opts;
  const col = el('div', { class: 'storage-store' });
  col.append(el('div', { class: 'storage-store-h' }, el('span', { class: 'badge' }, label), sub ? el('span', { class: 'muted small' }, sub) : ''));
  if (!info || info.configured === false) {
    col.append(el('div', { class: 'small muted' }, 'not configured'));
    return col;
  }
  if (info.error || info.available === false) {
    col.append(el('div', { class: 'storage-row' }, el('span', { class: 'k' }, 'Size'), el('span', { class: 'v muted' }, 'unavailable')));
    if (info.error) col.append(el('div', { class: 'small muted' }, info.error));
    return col;
  }
  const biggest = (info.tables && info.tables[0]) || null;
  const counts = [`${info.tableCount} tables`];
  if (kind === 'tsdb' && info.hypertableCount) counts.push(`${info.hypertableCount} hypertables`);
  col.append(
    el('div', { class: 'storage-row' }, el('span', { class: 'k' }, `Database ${info.name || ''}`), el('span', { class: 'v' }, fmtBytes(info.totalBytes))),
    el('div', { class: 'small muted' }, `${counts.join(' · ')}${biggest ? ` · largest: ${biggest.name} (${fmtBytes(biggest.bytes)})` : ''}`));
  return col;
}

// One combined storage card: shared disk, a MySQL | TimescaleDB split of the
// database sizes, and a consumption estimate derived from how much was actually
// stored in the last few minutes.
function storageCards(s) {
  const wrap = el('div', { class: 'storage' });
  wrap.append(el('h3', { class: 'storage-h' }, 'Server storage'));
  const card = el('div', { class: 'stat storage-card' });
  const d = s.disk || {};
  const db = s.database || {};
  const tsdb = s.tsdb || null;
  const ing = s.ingest || null;

  // Disk (shared physical drive under both stores in a single-host deploy).
  if (d.available) {
    card.append(
      el('div', { class: 'storage-row' }, el('span', { class: 'k' }, `Drive ${d.path || ''}`), el('span', { class: 'v' }, `${fmtBytes(d.freeBytes)} free`)),
      usageBar(d.usedPercent),
      el('div', { class: 'small muted' }, `${fmtBytes(d.usedBytes)} used of ${fmtBytes(d.totalBytes)} (${d.usedPercent}%)`));
  } else {
    card.append(el('div', { class: 'storage-row' }, el('span', { class: 'k' }, 'Drive'), el('span', { class: 'v muted' }, 'unavailable')));
  }

  card.append(el('hr', { class: 'storage-sep' }));

  // Database split: MySQL (inventory/auth/config) alongside TimescaleDB
  // (telemetry). The TSDB column shows "not configured" until the telemetry node
  // is wired — see docs/storage-split-audit.md.
  const mysqlInfo = db.error ? { error: db.error } : { configured: true, ...db };
  card.append(el('div', { class: 'storage-split' },
    storeSection({ label: 'MySQL', sub: 'inventory · auth · config', info: mysqlInfo, kind: 'mysql' }),
    storeSection({ label: 'TimescaleDB', sub: 'telemetry', info: tsdb, kind: 'tsdb' })));

  // Consumption estimate from the last few minutes of stored measurements.
  if (ing) {
    card.append(el('hr', { class: 'storage-sep' }));
    const perSec = ing.minutes > 0 ? ing.bytes / (ing.minutes * 60) : 0;
    const detail = [`${fmtBytes(ing.bytes)} stored in the last ${ing.minutes} min (${ing.rows} measurements)`];
    if (d.available && perSec > 0 && d.freeBytes > 0) {
      detail.push(`disk full in ${fmtTimeToFull(d.freeBytes / (perSec * 86400))}`);
    } else if (perSec === 0) {
      detail.push('no new ingest to estimate from');
    }
    card.append(
      el('div', { class: 'storage-row' }, el('span', { class: 'k' }, 'Estimated consumption'), el('span', { class: 'v' }, `≈ ${fmtBytes(ing.bytesPerDay)}/day`)),
      el('div', { class: 'small muted' }, detail.join(' · ')));
  }

  wrap.append(card);
  return wrap;
}

function usageBar(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const cls = p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok';
  return el('div', { class: 'usagebar' }, el('div', { class: `fill ${cls}`, style: `width:${p}%` }));
}

// ---- Sortable / filterable tables (shared: Analysis + Events) -------------
// Severity ordering so a "Severity" column sorts by urgency, not alphabetically.
const SEVERITY_RANK = { CRIT: 3, WARN: 2, INFO: 1 };
// Format a robust z-score (median/MAD σ) for the overview tables; null → dash.
const fmtSigma = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}σ` : '–');

// A reusable client-side sortable table, styled like the Agents table:
// clickable headers toggle asc/desc with an arrow indicator + aria-sort.
//   columns: [{ label, key, get(row), class, sortable, } ]
//     key null / sortable:false → a plain (non-sortable) header (actions etc.).
//   opts: { className, sortKey, sortDir, emptyText, renderRow(row) }
// Returns { table, setRows(rows), setLoading(msg), setError(msg), sortKey }.
// Sorting is stable-ish, numeric-aware, and always sinks null/empty values last.
function sortableTable(columns, opts = {}) {
  const isSortable = (c) => c.key && c.sortable !== false;
  let sortKey = opts.sortKey || (columns.find(isSortable) || {}).key || null;
  let sortDir = opts.sortDir || 'desc';
  let rows = [];

  const headerEls = columns.map((c) => (isSortable(c)
    ? el('th', {
      class: `sortable${c.class ? ` ${c.class}` : ''}`, scope: 'col', tabindex: '0', 'aria-sort': 'none',
      title: `Sort by ${c.label}`,
      onclick: () => sortBy(c.key),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(c.key); } },
    }, c.label)
    : el('th', { class: c.class || '', scope: 'col' }, c.label)));
  const tbody = el('tbody');
  // Optional second header row of per-column filter controls (columns[i].filter
  // → a DOM node, or null for no control). Makes the header both sort AND filter.
  const hasFilters = columns.some((c) => c.filter);
  const filterRow = hasFilters
    ? el('tr', { class: 'filter-row' }, ...columns.map((c) => el('th', { class: c.class || '', scope: 'col' }, c.filter || null)))
    : null;
  const thead = el('thead', {}, el('tr', {}, ...headerEls));
  if (filterRow) thead.append(filterRow);
  const table = el('table', { class: opts.className || 'data' }, thead, tbody);

  function sortBy(key) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = key; sortDir = 'desc'; }
    draw();
  }
  function draw() {
    const col = columns.find((c) => c.key === sortKey);
    const list = rows.slice();
    if (col && col.get) {
      list.sort((x, y) => {
        const vx = col.get(x); const vy = col.get(y);
        const nx = vx == null || vx === ''; const ny = vy == null || vy === '';
        if (nx && ny) return 0;
        if (nx) return 1; // nulls last, regardless of direction
        if (ny) return -1;
        const r = (typeof vx === 'number' && typeof vy === 'number')
          ? vx - vy : String(vx).localeCompare(String(vy), undefined, { numeric: true });
        return sortDir === 'asc' ? r : -r;
      });
    }
    tbody.replaceChildren(...(list.length
      ? list.map((row) => opts.renderRow(row))
      : [el('tr', {}, el('td', { colspan: String(columns.length), class: 'muted' }, opts.emptyText || 'Nothing to show.'))]));
    columns.forEach((c, i) => {
      if (!isSortable(c)) return;
      const on = sortKey === c.key;
      headerEls[i].textContent = c.label + (on ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
      headerEls[i].classList.toggle('sorted', on);
      headerEls[i].setAttribute('aria-sort', on ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }
  draw();
  return {
    table,
    setRows(next) { rows = Array.isArray(next) ? next : []; draw(); },
    setLoading(msg) { tbody.replaceChildren(el('tr', {}, el('td', { colspan: String(columns.length), class: 'muted' }, msg || 'Loading…'))); },
    setError(msg) { tbody.replaceChildren(el('tr', {}, el('td', { colspan: String(columns.length), class: 'error' }, msg))); },
    get tbody() { return tbody; },
    get sortKey() { return sortKey; },
  };
}

// ---- Analysis (findings + AI assistant) ----------------------------------
// hostId of a finding is the agent id (the analysis pipeline keys on it).
const findingsState = { hostId: '', severity: '', metric: '', sort: { key: 'time', dir: 'desc' } };

// Authenticated download of a server export (CSV/JSON) → triggers a file save.
async function downloadExport(resource, format, params = {}) {
  const qs = new URLSearchParams({ format, ...params }).toString();
  try {
    const res = await fetch(`/api/export/${resource}?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      let msg; try { msg = (await res.json()).error; } catch { /* non-JSON */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `blueeye-${resource}.${format}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) { toast(err.message, true); }
}
function exportButtons(resource, getParams) {
  return el('span', { class: 'export-btns' },
    el('span', { class: 'muted' }, 'Export:'),
    el('button', { class: 'small ghost', onclick: () => downloadExport(resource, 'csv', getParams ? getParams() : {}) }, 'CSV'),
    el('button', { class: 'small ghost', onclick: () => downloadExport(resource, 'json', getParams ? getParams() : {}) }, 'JSON'));
}

// ---- Analysis (MIGRATED — see public/views/analysis.js) ---------------------
// Built lazily: `ui` is declared far down this file and is in the temporal dead
// zone up here. app.js keeps the filter state (it outlives the view, so leaving
// the page and coming back does not silently widen the scope somebody set) and
// the live-finding subscription.
let analysisView = null;
let onLiveFindingRow = null;
function getAnalysisView() {
  if (analysisView) return analysisView;
  if (typeof window === 'undefined' || !window.AnalysisView || !ui) return null;
  analysisView = window.AnalysisView.create({
    el, api, t, errText, ui, openAgent,
    state: findingsState,
    isAdmin: () => isAdmin(),
    help: () => {
      const info = PAGE_INFO.findings || {};
      return { lead: info.hero || '', title: info.title || t('analysis.title'), body: info.body || (() => []) };
    },
    // At most one primary in a PageHeader, and an export is not it: the two
    // export buttons are the page's secondary actions.
    headerActions: () => [
      ui.button('secondary', t('analysis.export.csv'), {
        onclick: () => downloadExport('findings', 'csv', findingsState.hostId ? { hostId: findingsState.hostId } : {}),
      }),
      ui.button('secondary', t('analysis.export.json'), {
        onclick: () => downloadExport('findings', 'json', findingsState.hostId ? { hostId: findingsState.hostId } : {}),
      }),
    ],
    toolbarActions: () => [],
    newSeverityRule: (f) => editSeverityRule(null, {
      source: 'finding', match_metric: f.metric, match_kind: f.kind, match_host_id: f.hostId,
    }),
    // One subscriber at a time: the view registers on every render, and an old
    // closure would go on writing into a table that is no longer on screen.
    onLive: (fn) => { onLiveFindingRow = fn; },
  });
  return analysisView;
}

views.findings = async () => {
  const v = getAnalysisView();
  if (!v) return el('div', { class: 'empty error' }, t('analysis.err.title'));
  const node = await v.view();
  // The assistant box is not part of the contract's components yet, so it is
  // appended rather than composed — it migrates with the rest of Insights.
  if (featureEnabled('assistant')) node.append(assistantBox(() => findingsState.hostId));
  return node;
};

// AI-assistant box. Posts to /api/assistant/explain; degrades gracefully when
// the feature is disabled (403) so it never looks broken.
function assistantBox(getHostId) {
  const input = el('input', { type: 'text', placeholder: 'Ask e.g.: why is CPU high on this host?' });
  const btn = el('button', { class: 'small' }, 'Ask assistant');
  const out = el('div', { class: 'assistant-out muted' }, 'Ask a question about a host based on the latest findings.');
  async function ask() {
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    btn.disabled = true;
    out.className = 'assistant-out muted';
    out.textContent = 'Thinking…';
    try {
      const res = await api('/api/assistant/explain', { method: 'POST', body: { question, hostId: getHostId() || undefined } });
      out.className = 'assistant-out';
      out.replaceChildren(
        el('div', {}, res.answer || '(empty response)'),
        el('div', { class: 'assistant-meta muted' }, `${res.model || ''} · ${res.usedFindings ?? 0} findings in context`));
    } catch (err) {
      out.className = 'assistant-out muted';
      out.textContent = err.status === 403
        ? 'The AI assistant is disabled. An administrator can enable it under Settings → AI.'
        : err.message;
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  return el('div', { class: 'assistant' },
    el('div', { class: 'assistant-row' }, input, btn),
    out);
}

// ---- Events (stored in event_cases) -------------------------------------
// An event is a correlated condition on ONE device, wrapping the anomalies that
// evidence it. It is what a connected ITSM opens an *event* from — the
// event lives there, with its own number and SLA. See docs/events.md.
let selectedEventId = null;
// Opens the EVENT detail view (the record lives in `event_cases`; the name is
// kept on the internal helper so every existing call site stays valid).
function openEvent(id) { selectedEventId = id; currentView = 'event'; render(); }

const INC_STATUS_LABEL = { open: 'Open', investigating: 'Investigating', resolved: 'Resolved', closed: 'Closed' };
const INC_TRANSITIONS = { open: ['investigating'], investigating: ['resolved'], resolved: ['closed'], closed: ['open'] };
const incStatusBadge = (s) => el('span', { class: `badge inc-status-${s}` }, INC_STATUS_LABEL[s] || s);
const incSevBadge = (s) => el('span', { class: `badge inc-sev-${s}` }, s);

// ---- "Where is this event?" ---------------------------------------------
// An event's device is stored as `hostId` (the agent id). On its own it does
// not tell an operator which machine or which site to go to, so every surface
// that names an event pairs the agent with its location. The server joins
// both onto the event (agentName/locationName); when the agent has been
// deleted or has no site set, the pieces degrade one at a time instead of the
// row going blank.
// `hostId` on the event API, `deviceId` on the Overview rollup — both name
// the same agent id, and either is better than falling through to "unknown".
const incHostId = (i) => (i && i.hostId != null && i.hostId !== '' ? i.hostId : (i && i.deviceId != null && i.deviceId !== '' ? i.deviceId : null));
const incAgentLabel = (i) => (i && i.agentName) || (incHostId(i) != null ? t('events.deviceId', { id: incHostId(i) }) : t('events.deviceUnknown'));
const incLocationLabel = (i) => (i && i.locationName) || t('events.noLocation');

// "core-sw · Copenhagen HQ" — one line for compact rows (rollups, list cells).
function eventWhere(i) {
  return `${incAgentLabel(i)} · ${incLocationLabel(i)}`;
}

// The device label the SERVER baked into the stored title — formatDeviceLabel's
// "name (site)". Needed to recognise (and drop) that tail in the events table,
// where device and location are already columns of their own.
function incTitleDeviceLabel(i) {
  const who = (i && i.agentName) || (incHostId(i) != null ? `device ${incHostId(i)}` : 'unknown device');
  return i && i.locationName ? `${who} (${i.locationName})` : who;
}

// What the title says that the table's own columns do not. Falls back to the
// full stored title whenever the pattern is not recognised.
function incCondition(i) {
  return window.EventTitle.conditionOf(i && i.title, i && i.severity, incTitleDeviceLabel(i));
}

PAGE_INFO.events = {
  hero: 'Events group related anomalies on the same device into one thing you can track from open to closed — with a timeline, the config change that may have triggered it, similar past events, and an opt-in AI assistant. A connected ITSM opens its own event from an event.',
  title: 'Events — grouped anomalies, tracked end-to-end',
  body: () => [
    el('p', {}, 'Each event wraps the analysis findings (anomalies) that fired close together on one device. Status moves open → investigating → resolved → closed; a closed event can be reopened with a comment (recorded in the audit trail).'),
    el('p', {}, 'BlueEyes deliberately stops at the event. An event is a technical observation the monitoring owns; an ', el('strong', {}, 'event'), ' is a service-desk record with a number, an SLA and an owner, and it belongs in your ITSM. Connect one under Settings → Integrations and an event can open an event there.'),
    el('p', {}, 'The detail page shows the event timeline, the device-config change suspected to have triggered it, similar past events, and — when the EU AI assistant is enabled — a chat that answers questions using only masked, aggregated context.'),
    el('p', { class: 'muted' }, 'Status changes, config history and the AI chat are operator/admin only.'),
  ],
};

// ---- Events (MIGRATED — see public/views/events.js) -------------------------
let eventsPage = null;
const eventsPageState = {};

function getEventsPage() {
  if (eventsPage) return eventsPage;
  if (typeof window === 'undefined' || !window.EventsPage || !ui) return null;
  eventsPage = window.EventsPage.create({
    el, t, ui, errText, gotoView, openEvent, canWrite,
    state: eventsPageState,
    condition: incCondition,
    agentLabel: incAgentLabel,
    locationLabel: incLocationLabel,
    guide: guideFromList,
    help: () => {
      const info = PAGE_INFO.events || {};
      return { lead: info.hero || '', title: info.title || t('events.title'), body: info.body || (() => []) };
    },
    // Status, severity and device narrow the QUERY: the server keys events by
    // device. Location does not, so the view filters it client-side.
    fetchEvents: async ({ status, severity, device }) => {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (severity) qs.set('severity', severity);
      if (device) qs.set('device', String(device).trim());
      const r = await api(`/api/events${qs.toString() ? `?${qs}` : ''}`);
      return r.events || [];
    },
  });
  return eventsPage;
}

views.events = async () => {
  const v = getEventsPage();
  if (!v) return el('div', { class: 'empty error' }, t('events.err.title'));
  return v.view();
};


async function loadEventTimeline(id, card, deviceId) {
  const head = el('h3', {}, 'Timeline');
  const devNum = Number(deviceId);
  // Anomaly + config-change events link to the device page (its findings/health
  // and, for config, the Config history card). Status changes have no target.
  const canLink = Number.isInteger(devNum);
  try {
    const { events } = await api(`/api/events/${id}/timeline`);
    if (!events.length) { card.replaceChildren(head, el('p', { class: 'muted' }, 'No events yet.')); return; }
    card.replaceChildren(head, el('ul', { class: 'timeline' }, ...events.map((e) => {
      const linkable = canLink && (e.type === 'anomaly' || e.type === 'config_change');
      return el('li', {
        class: `tl tl-${e.type}${linkable ? ' clickable' : ''}`,
        ...(linkable ? { title: 'Open device', onclick: () => openAgent(devNum) } : {}),
      },
        el('span', { class: 'tl-time muted' }, fmtDate(e.timestamp)),
        el('span', { class: `tl-dot tl-dot-${e.type}` }),
        el('span', { class: 'tl-desc' }, e.description || e.type,
          e.severity ? el('span', { class: 'muted' }, ` [${e.severity}]`) : null,
          e.status ? el('span', { class: 'muted' }, ` [${e.status}]`) : null));
    })));
  } catch (err) { card.replaceChildren(head, el('p', { class: 'error' }, err.message)); }
}

// ---- Per-target activity timeline (Phase 2) --------------------------------
// Consumes GET /api/targets/:id/timeline. Pure state/mapping logic lives in
// public/timelineView.js (TimelineView, unit-tested); this is just the DOM.

// Shared options for the timeline render layer (TimelineView.renderRow/
// renderInto, unit-tested under jsdom). Rows deep-link to the device page; time
// is formatted with the app's fmtDate.
function timelineRenderOpts(agentId, extra) {
  return Object.assign({ agentId, onOpen: (id) => openAgent(id), formatTime: fmtDate }, extra || {});
}

// The per-target timeline card, embedded on the device detail page. Time-range
// selector (1h/24h/7d/custom) + manual refresh; explicit loading/empty/error/
// partial states. No polling in this phase.
function targetTimelineCard(agentId) {
  const card = el('div', { class: 'card agent-timeline' });
  const body = el('div', { class: 'tl-body' });
  let rangeKey = '24h';
  const customFrom = el('input', { type: 'datetime-local', class: 'tl-dt' });
  const customTo = el('input', { type: 'datetime-local', class: 'tl-dt' });
  const customWrap = el('span', { class: 'tl-custom hidden' }, customFrom, el('span', { class: 'muted' }, ' → '), customTo);
  const rangeSel = el('select', { class: 'tl-range' },
    ...TimelineView.RANGE_PRESETS.map((p) => el('option', { value: p.key }, p.label)));
  rangeSel.value = rangeKey;
  const refreshBtn = el('button', { class: 'small ghost' }, '↻ Refresh');
  const setBusy = (b) => { refreshBtn.disabled = b; };
  const draw = (view) => TimelineView.renderInto(document, body, view,
    timelineRenderOpts(agentId, { onRetry: load, emptyText: 'No events in this window.' }));

  async function load() {
    const win = TimelineView.rangeToWindow(rangeKey, Date.now(), customFrom.value, customTo.value);
    if (!win) { body.replaceChildren(el('p', { class: 'muted' }, 'Pick a valid custom range (from ≤ to).')); return; }
    draw(TimelineView.resolveState({ loading: true }));
    setBusy(true);
    let view;
    try {
      const data = await api(`/api/targets/${agentId}/timeline${TimelineView.timelineQuery(win, 500)}`);
      view = TimelineView.resolveState({ data });
    } catch (err) {
      view = TimelineView.resolveState({ error: err });
    } finally { setBusy(false); }
    draw(view);
  }

  rangeSel.onchange = (e) => {
    rangeKey = e.target.value;
    customWrap.classList.toggle('hidden', rangeKey !== 'custom');
    if (rangeKey !== 'custom') load();
  };
  customFrom.onchange = () => { if (rangeKey === 'custom') load(); };
  customTo.onchange = () => { if (rangeKey === 'custom') load(); };
  refreshBtn.onclick = load;

  card.append(
    el('div', { class: 'tl-head' }, el('h3', {}, 'Activity timeline'), rangeSel, customWrap, refreshBtn),
    body);
  load();
  return card;
}

async function loadEventSimilar(id, card) {
  const head = el('h3', {}, 'Similar past events');
  try {
    const { similar } = await api(`/api/events/${id}/similar`);
    if (!similar.length) { card.replaceChildren(head, el('p', { class: 'muted' }, 'No similar events found.')); return; }
    card.replaceChildren(head, el('ul', { class: 'inc-similar' }, ...similar.map((s) => el('li', {
      class: 'clickable', onclick: () => openEvent(s.id),
    },
      el('span', { class: 'badge' }, `score ${s.score}`), ' ', s.title || `#${s.id}`,
      el('span', { class: 'muted' }, ` · ${(s.matchedOn || []).join(', ')} · resolved ${fmtDate(s.resolvedAt)}${s.closedBy ? ` by ${s.closedBy}` : ''}`)))));
  } catch (err) { card.replaceChildren(head, el('p', { class: 'error' }, err.message)); }
}

async function loadEventConfigContext(id, card) {
  const head = el('h3', {}, 'Config context');
  try {
    const ctx = await api(`/api/events/${id}/config-context`);
    if (!ctx.configChangeId) { card.replaceChildren(head, el('p', { class: 'muted' }, 'No correlated config change.')); return; }
    const st = ctx.suspectedTrigger;
    const diff = ctx.diff || {};
    card.replaceChildren(head,
      st ? el('p', { class: 'callout' }, `⚠ ${st.note}`) : null,
      el('p', { class: 'muted' }, `Risk: ${diff.risk || 'n/a'}${(diff.riskReasons || []).length ? ` (${diff.riskReasons.join(', ')})` : ''} · +${(diff.stats && diff.stats.added) || 0}/-${(diff.stats && diff.stats.removed) || 0} lines · captured ${fmtDate(ctx.change && ctx.change.capturedAt)} (${(ctx.change && ctx.change.capturedVia) || ''})`),
      diff.changedLines && diff.changedLines.length
        ? el('pre', { class: 'config-diff' }, diff.changedLines.map((l) => `${l.op} ${l.text}`).join('\n'))
        : null);
  } catch (err) {
    card.replaceChildren(head, el('p', { class: err.status === 403 ? 'muted' : 'error' }, err.status === 403 ? 'Requires operator/admin.' : err.message));
  }
}

function eventAssistantCard(id) {
  const out = el('div', { class: 'assistant-out muted' }, 'Ask a question about this event.');
  const input = el('input', { type: 'text', placeholder: 'e.g. what likely triggered this?', class: 'inc-ask-input' });
  const askBtn = el('button', { class: 'small' }, 'Ask AI');
  async function ask() {
    const q = input.value.trim();
    if (!q) return;
    out.className = 'assistant-out muted';
    out.textContent = 'Thinking…';
    askBtn.disabled = true;
    try {
      const res = await api(`/api/events/${id}/ask`, { method: 'POST', body: { question: q } });
      out.className = 'assistant-out';
      out.replaceChildren(
        el('div', { class: 'ai-badge' }, '⚠ AI-generated'),
        el('div', {}, res.answer || '(empty response)'),
        el('div', { class: 'assistant-meta muted' }, `${res.model || 'no provider call'}${res.cached ? ' · cached' : ''}${res.dataAvailable === false ? ' · insufficient context' : ''}`));
    } catch (err) {
      out.className = 'assistant-out muted';
      out.textContent = err.status === 403
        ? 'The AI assistant is disabled or not licensed. Enable it in Settings → AI.'
        : (err.status === 404 ? 'Event not found.' : err.message);
    } finally { askBtn.disabled = false; }
  }
  askBtn.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  return el('div', { class: 'card' },
    el('h3', {}, 'Ask AI about this event'),
    el('p', { class: 'muted' }, 'Answers use only masked, aggregated context (timeline, config diff, similar events). No raw config or secrets are sent.'),
    el('div', { class: 'inc-ask' }, input, askBtn),
    out);
}

// The per-event detail page (no tab — reached via openEvent).
// ---- Guided troubleshooting ("Guide me") -----------------------------------
let guideAutoOpen = false;
function guideFromList(id) { guideAutoOpen = true; openEvent(id); }

// Deep-link a guide step's suggested action into the existing tools.
function guideNavigate(action, event) {
  if (!action) return;
  // 'event' is what the guide emits now; 'event' is accepted so a step built by
  // an older server (or a cached response) still routes.
  if (action.view === 'event' || action.view === 'event') { openEvent(action.targetId); return; }
  const dev = Number(action.view === 'config-context' ? event.hostId : action.targetId);
  if (!Number.isInteger(dev)) return;
  if (action.view === 'flows') { openFlows(dev); return; }
  openAgent(dev); // agent / interfaces / config-context all live on the device page
}

async function loadGuide(event, body) {
  try {
    const guide = await api(`/api/events/${event.id}/guide`);
    if (!guide.steps || !guide.steps.length) { body.replaceChildren(el('p', { class: 'muted' }, 'No guidance available for this event.')); return; }
    const doneKey = `blueeye.guide.${event.id}`;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(doneKey) || '[]'); } catch { done = []; }
    const progress = el('div', { class: 'guide-progress muted' });
    const aiOut = el('div', { class: 'assistant-out muted' });
    aiOut.style.display = 'none';
    const refresh = () => { progress.textContent = `${done.length}/${guide.steps.length} steps done`; };
    const save = () => { try { localStorage.setItem(doneKey, JSON.stringify(done)); } catch { /* storage off */ } refresh(); };

    async function askAbout(seed) {
      aiOut.style.display = '';
      aiOut.className = 'assistant-out muted';
      aiOut.textContent = 'Thinking…';
      try {
        const res = await api(`/api/events/${event.id}/ask`, { method: 'POST', body: { question: seed } });
        aiOut.className = 'assistant-out';
        aiOut.replaceChildren(
          el('div', { class: 'ai-badge' }, '⚠ AI-generated'),
          el('div', {}, res.answer || '(empty response)'),
          el('div', { class: 'assistant-meta muted' }, `${res.model || 'no provider call'}${res.dataAvailable === false ? ' · insufficient context' : ''}`));
      } catch (err) {
        aiOut.className = 'assistant-out muted';
        aiOut.textContent = err.status === 403 ? 'The AI assistant is disabled or not licensed (Settings → AI).' : err.message;
      }
    }

    const steps = guide.steps.map((s) => {
      const cb = el('input', { type: 'checkbox' });
      if (done.includes(s.id)) cb.checked = true;
      const li = el('li', { class: `guide-step guide-${s.kind}${cb.checked ? ' done' : ''}` });
      cb.addEventListener('change', () => {
        if (cb.checked) { if (!done.includes(s.id)) done.push(s.id); } else { done = done.filter((x) => x !== s.id); }
        li.classList.toggle('done', cb.checked); save();
      });
      const actionBtn = s.action ? el('button', { class: 'small ghost', onclick: () => guideNavigate(s.action, event) }, s.action.label) : null;
      const askBtn = el('button', { class: 'small ghost', onclick: () => askAbout(`Help me with this troubleshooting step for the event: "${s.title}". ${s.detail}`) }, 'Ask AI');
      li.append(
        el('label', { class: 'guide-step-head' }, cb, el('span', { class: 'guide-step-title' }, s.title), el('span', { class: `badge kind-${s.kind}` }, s.kind)),
        el('p', { class: 'guide-detail' }, s.detail),
        el('p', { class: 'guide-rationale muted' }, '↳ ', s.rationale),
        el('div', { class: 'guide-actions' }, actionBtn, askBtn));
      return li;
    });

    const freeQ = el('input', { type: 'text', placeholder: 'Ask BlueEyes AI about this event…', class: 'inc-ask-input' });
    const freeBtn = el('button', { class: 'small', onclick: () => { if (freeQ.value.trim()) askAbout(freeQ.value.trim()); } }, 'Ask AI');
    freeQ.addEventListener('keydown', (e) => { if (e.key === 'Enter' && freeQ.value.trim()) askAbout(freeQ.value.trim()); });

    refresh();
    body.replaceChildren(
      progress,
      el('ol', { class: 'guide-steps' }, ...steps),
      el('div', { class: 'guide-ai' },
        el('p', { class: 'muted' }, 'BlueEyes built these steps from this event. Ask the AI to explain a step or the likely cause — it uses only masked context.'),
        el('div', { class: 'inc-ask' }, freeQ, freeBtn), aiOut));
  } catch (err) {
    body.replaceChildren(el('p', { class: err.status === 403 ? 'muted' : 'error' }, err.status === 403 ? 'Guided troubleshooting requires operator/admin.' : err.message));
  }
}

// A collapsible "Guide me" card that lazy-loads the step-by-step guide on open.
function eventGuideCard(event) {
  const body = el('div', { class: 'guide-body' }, el('p', { class: 'muted' }, 'Loading…'));
  let loaded = false;
  const openAndLoad = () => { if (!loaded) { loaded = true; loadGuide(event, body); } };
  const details = el('details', { class: 'card guide-card' },
    el('summary', { class: 'guide-summary' },
      el('span', { class: 'pill guide-pill' }, '🧭 Guide me'),
      el('span', { class: 'muted' }, ' — step-by-step troubleshooting, BlueEyes + AI')),
    body);
  details.addEventListener('toggle', () => { if (details.open) openAndLoad(); });
  if (guideAutoOpen) { guideAutoOpen = false; details.open = true; openAndLoad(); }
  return details;
}

views.event = async () => {
  const id = selectedEventId;
  const back = el('button', { class: 'small ghost', onclick: () => { currentView = 'events'; render(); } }, '← Events');
  if (id == null) return el('div', { class: 'empty' }, back, el('p', {}, 'No event selected.'));

  let data;
  try {
    data = await api(`/api/events/${id}`);
  } catch (err) {
    if (err.status === 404) return el('div', { class: 'empty' }, back, el('p', { class: 'error' }, 'Event not found.'));
    return el('div', { class: 'empty error' }, back, ' ', err.message);
  }
  const inc = data.event;
  const anomalies = data.anomalies || [];

  // Where the event is, stated before anything else on the page: the agent
  // (clickable through to the device) and the site it stands at. Older cases
  // carry a title that names only the agent id, so the header is what makes them
  // placeable too.
  const devNum = Number.parseInt(inc.hostId, 10);
  const agentEl = Number.isInteger(devNum) && devNum > 0
    ? el('a', { class: 'inc-where-agent', href: '#', onclick: (e) => { e.preventDefault(); openAgent(devNum); } }, incAgentLabel(inc))
    : el('span', {}, incAgentLabel(inc));

  const header = el('div', { class: 'inc-header' },
    el('div', {},
      el('h2', {}, inc.title),
      el('div', { class: 'inc-meta' }, incSevBadge(inc.severity), ' ', incStatusBadge(inc.status),
        el('span', { class: 'muted' }, ' · '), agentEl,
        el('span', { class: 'muted' }, ` · ${incLocationLabel(inc)} · opened ${fmtDate(inc.firstEventAt)}`))),
    back);

  const controls = el('div', { class: 'inc-actions' });
  if (canWrite()) {
    for (const to of (INC_TRANSITIONS[inc.status] || [])) {
      const label = to === 'open' ? 'Reopen' : `Mark ${INC_STATUS_LABEL[to]}`;
      controls.append(el('button', {
        class: 'small',
        onclick: async () => {
          let comment;
          if (inc.status === 'closed' && to === 'open') {
            comment = window.prompt('Reason for reopening (required):');
            if (!comment) return;
          }
          try {
            await api(`/api/events/${id}`, { method: 'PATCH', body: { status: to, ...(comment ? { comment } : {}) } });
            toast(`Event ${INC_STATUS_LABEL[to].toLowerCase()}`);
            render();
          } catch (err) { toast(errText(err), true); }
        },
      }, label));
    }
  }

  const anomaliesCard = el('div', { class: 'card' },
    el('h3', {}, `Anomalies (${anomalies.length})`),
    anomalies.length
      ? el('ul', { class: 'inc-anoms' }, ...anomalies.map((a) => el('li', {},
          incSevBadge(a.severity), ' ', el('strong', {}, a.metric), ' — ', a.explanation || '',
          el('span', { class: 'muted' }, ` (${fmtDate(a.createdAt)})`))))
      : el('p', { class: 'muted' }, 'No linked anomalies.'));

  const timelineCard = el('div', { class: 'card' }, el('h3', {}, 'Timeline'), el('div', { class: 'muted' }, 'Loading…'));
  loadEventTimeline(id, timelineCard, inc.hostId);
  const similarCard = el('div', { class: 'card' }, el('h3', {}, 'Similar past events'), el('div', { class: 'muted' }, 'Loading…'));
  loadEventSimilar(id, similarCard);

  const extra = [];
  if (canWrite()) {
    const cfgCard = el('div', { class: 'card' }, el('h3', {}, 'Config context'), el('div', { class: 'muted' }, 'Loading…'));
    loadEventConfigContext(id, cfgCard);
    extra.push(cfgCard);
    if (featureEnabled('assistant')) extra.push(eventAssistantCard(id));
  }

  // "Guide me" — operator/admin (the guide endpoint + its config/AI steps are).
  const guideCard = canWrite() ? eventGuideCard(inc) : null;

  // Affected path — the shared Path Visualization pre-filtered to the event
  // window, with the problem hop pre-highlighted. Mounted only when the event
  // has a numeric device (agent) and a derivable target (from a linked anomaly).
  let pathCard = null;
  const pathTarget = (anomalies.find((a) => a.target) || {}).target || inc.target || null;
  const pathSource = devNum;
  if (pathTarget && Number.isInteger(pathSource) && pathSource > 0) {
    pathCard = el('div', { class: 'card' }, el('h3', {}, 'Affected path'), el('div', { class: 'muted' }, 'Loading…'));
    (async () => {
      const fromMs = inc.firstEventAt ? Date.parse(inc.firstEventAt) : (Date.now() - 24 * 3600 * 1000);
      try {
        const viz = await pathVisualization({ sourceId: pathSource, targetId: pathTarget, eventId: id, timeRange: { fromMs, toMs: Date.now() } });
        pathCard.replaceChildren(el('h3', {}, 'Affected path'), viz);
      } catch (e) { pathCard.replaceChildren(el('h3', {}, 'Affected path'), el('div', { class: 'error' }, errText(e))); }
    })();
  }

  // Blast radius — which downstream hosts/services fail if this device goes down
  // (enrichment already on the event response). Both tiers with justifying
  // paths; each host links into the topology map focused on it.
  let blastCard = null;
  if (inc.blastRadius) {
    blastCard = el('div', { class: 'card' }, el('h3', {}, 'Blast radius'), el('div', { class: 'muted' }, 'Loading…'));
    (async () => {
      let agents = [];
      try { agents = await api('/agents'); } catch { /* labels best-effort */ }
      const nameById = {};
      (agents || []).forEach((a) => { nameById[a.id] = a.display_name || a.hostname || `host ${a.id}`; });
      const nameFor = (hid) => nameById[hid] || `host ${hid}`;
      blastCard.replaceChildren(el('h3', {}, 'Blast radius'),
        blastRadiusPanel(inc.blastRadius, { nameFor, onFocusHost: (hid) => openTopologyFocus(hid) }));
    })();
  }

  // Work log — the shift handover. Mounted high (right after the status
  // controls) because "what has already been tried and excluded" is what the
  // next shift must read before anything else, not a footnote below six cards.
  const notesCard = eventNotesCard(id);

  return el('div', { class: 'event-detail' }, header, controls, notesCard, guideCard, anomaliesCard, blastCard, timelineCard, similarCard, pathCard, ...extra);
};

// ---- Event work log (Fase 3) -----------------------------------------------
// Append-only log of observations, actions taken and — the reason this exists —
// causes that have been RULED OUT. The ruled-out entries render as a separate,
// pinned list above the chronological log: the next shift's first question is
// "what has already been disproved?", and they should not have to read a
// timeline to answer it.
//
// The server serves ruledOut as its own array (indexed, never truncated), so
// this does not client-side filter the log — the exclusions must not be the rows
// that fall off a cap.
const NOTE_KINDS = ['observation', 'action', 'ruled_out'];

function noteEntryEl(note) {
  return el('li', { class: `wl-entry wl-${note.kind}` },
    el('div', { class: 'wl-entry-head' },
      el('span', { class: `badge wl-kind-${note.kind}` }, t(`notes.kind.${note.kind}`)),
      el('span', { class: 'muted small' },
        t('notes.byline', { author: note.author || '—', when: fmtDate(note.createdAt) }))),
    el('p', { class: 'wl-text' }, note.text));
}

function eventNotesCard(eventId) {
  const card = el('div', { class: 'card work-log' });
  const body = el('div', {}, el('div', { class: 'muted' }, t('search.loading')));
  card.append(el('h3', {}, t('notes.title')), body);

  async function load() {
    let data;
    try {
      data = await api(`/api/events/${eventId}/notes`);
    } catch (err) {
      body.replaceChildren(
        el('p', { class: 'error' }, t('notes.loadError', { message: errText(err) })),
        el('button', { class: 'small ghost', onclick: load }, t('common.retry')));
      return;
    }

    const kids = [];

    // Pinned exclusions first — this is the whole point of the panel.
    const ruledOut = data.ruledOut || [];
    kids.push(el('div', { class: `wl-ruled-out${ruledOut.length ? '' : ' is-empty'}` },
      el('h4', {}, t('notes.ruledOutTitle')),
      el('p', { class: 'muted small' }, t('notes.ruledOutHint')),
      ruledOut.length
        ? el('ul', { class: 'wl-list' }, ...ruledOut.map(noteEntryEl))
        : el('p', { class: 'muted' }, t('notes.ruledOutEmpty'))));

    // Then the full log, chronological (as served).
    const notes = data.notes || [];
    kids.push(notes.length
      ? el('ul', { class: 'wl-list wl-log' }, ...notes.map(noteEntryEl))
      : el('p', { class: 'empty' }, t('notes.empty')));

    if (canWrite()) kids.push(noteComposer(eventId, load));
    else kids.push(el('p', { class: 'muted small' }, t('notes.readOnly')));

    kids.push(el('p', { class: 'muted small wl-note' }, t('notes.appendOnly')));
    body.replaceChildren(...kids);
  }

  load();
  return card;
}

// The add-entry form. `kind` is an explicit choice with no default selected —
// the server rejects an omitted kind rather than guessing, and the UI must not
// paper over that by pre-picking "observation" for someone who meant "ruled out".
function noteComposer(eventId, onSaved) {
  const form = el('form', { class: 'wl-composer' });
  const textarea = el('textarea', {
    rows: '3',
    id: `wl-text-${eventId}`,
    placeholder: t('notes.textPlaceholder'),
    required: 'required',
  });
  const errorLine = el('p', { class: 'error hidden' });

  const kindRadios = NOTE_KINDS.map((kind) => el('label', { class: 'wl-kind-choice' },
    el('input', { type: 'radio', name: `wl-kind-${eventId}`, value: kind }),
    el('span', {}, t(`notes.kind.${kind}`)),
    el('span', { class: 'muted small' }, t(`notes.kind.${kind}.help`))));

  const submit = el('button', { type: 'submit', class: 'small' }, t('notes.submit'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorLine.classList.add('hidden');
    const checked = form.querySelector(`input[name="wl-kind-${eventId}"]:checked`);
    const text = textarea.value.trim();
    // Mirror the server's two rules locally so the common mistakes are caught
    // before a round-trip — the server still enforces both.
    if (!text || !checked) {
      errorLine.textContent = !text ? t('notes.text') : t('notes.kind');
      errorLine.classList.remove('hidden');
      return;
    }
    submit.disabled = true;
    submit.textContent = t('notes.saving');
    try {
      await api(`/api/events/${eventId}/notes`, { method: 'POST', body: { text, kind: checked.value } });
      textarea.value = '';
      checked.checked = false;
      if (typeof onSaved === 'function') await onSaved();
    } catch (err) {
      errorLine.textContent = t('notes.error', { message: errText(err) });
      errorLine.classList.remove('hidden');
    } finally {
      submit.disabled = false;
      submit.textContent = t('notes.submit');
    }
  });

  form.append(
    el('h4', {}, t('notes.add')),
    el('label', { for: `wl-text-${eventId}` }, t('notes.text')),
    textarea,
    el('fieldset', { class: 'wl-kinds' }, el('legend', {}, t('notes.kind')), ...kindRadios),
    errorLine,
    el('div', { class: 'form-actions' }, submit));
  return form;
}

// ---- Situation View (one condition across several devices) -----------------
// "ét fælles billede": one page per cluster answering what/where/since-when,
// what changed just before, and what the evidence says. Backed by
// /api/event-clusters (Fase 1) + /api/event-clusters/:id/timeline. Page
// assembly + panel rendering live in the pure, jsdom-tested public/clusterView.js
// (window.ClusterView); this wires fetch, navigation and the write actions.
let selectedClusterId = null;
function openCluster(id) { selectedClusterId = id; currentView = 'cluster'; render(); }

const CLUSTER_STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved', closed: 'Closed' };
const CLUSTER_CONF_LABEL = { low: 'Low', medium: 'Medium', high: 'High' };
const clusterStatusBadge = (s) => el('span', { class: `badge inc-status-${s}` }, CLUSTER_STATUS_LABEL[s] || s);
const clusterConfBadge = (c) => el('span', { class: `badge conf-${c}` }, `${CLUSTER_CONF_LABEL[c] || c}`);

PAGE_INFO.clusters = {
  hero: 'Situations group findings that fired on SEVERAL agents at once into one cross-agent event — with the change that came just before, a plain-language evidence breakdown, and one merged timeline.',
  title: 'Situations — cross-agent events, one common picture',
  body: () => [
    el('p', {}, 'When a fault hits many agents at the same time, BlueEyes clusters their findings into one situation instead of N look-alike alerts. Each situation carries a confidence tier (how independent the grouping signals were) and a suspected common cause.'),
    el('p', {}, 'The detail page is the “one common picture”: what changed in the minutes before the first finding, the evidence that drove the grouping, and a single timeline merging findings, agent events, playbook runs and config changes across every affected agent.'),
    el('p', { class: 'muted' }, 'Everyone can view; acknowledging and resolving are operator/admin and are recorded in the audit trail.'),
  ],
};

// ---- Situations (MIGRATED — see public/views/situations.js) -----------------
let situationsPage = null;
const situationsPageState = {};

function getSituationsPage() {
  if (situationsPage) return situationsPage;
  if (typeof window === 'undefined' || !window.SituationsPage || !ui) return null;
  situationsPage = window.SituationsPage.create({
    el, t, ui, errText, gotoView, openCluster,
    state: situationsPageState,
    help: () => {
      const info = PAGE_INFO.clusters || {};
      return { lead: info.hero || '', title: info.title || t('sit.title'), body: info.body || (() => []) };
    },
    fetchClusters: async (status) => {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      const r = await api(`/api/event-clusters${qs.toString() ? `?${qs}` : ''}`);
      return r.clusters || [];
    },
  });
  return situationsPage;
}

views.clusters = async () => {
  const v = getSituationsPage();
  if (!v) return el('div', { class: 'empty error' }, t('sit.err.title'));
  return v.view();
};

// Options passed to the ClusterView render layer: time formatting + per-event
// deep-link to the affected agent's device page (which aggregates its findings,
// flows, probes and config history — the closest thing to per-record views).
function clusterRenderOpts(extra) {
  return Object.assign({ formatTime: fmtDate, onOpen: (agentId) => { const n = Number(agentId); if (Number.isInteger(n)) openAgent(n); } }, extra || {});
}

views.cluster = async () => {
  const id = selectedClusterId;
  const back = el('button', { class: 'small ghost', onclick: () => { currentView = 'clusters'; render(); } }, '← Situations');
  if (id == null) return el('div', { class: 'empty' }, back, el('p', {}, 'No situation selected.'));

  let detail;
  try {
    ({ cluster: detail } = await api(`/api/event-clusters/${id}`));
  } catch (err) {
    if (err.status === 404) return el('div', { class: 'empty' }, back, el('p', { class: 'error' }, 'Situation not found.'));
    return el('div', { class: 'empty error' }, back, ' ', err.message);
  }

  // The timeline + recommended actions are INDEPENDENT fetches — their failure
  // must not blank the page (each renders its own error state).
  let timeline = null;
  let timelineError = false;
  try {
    timeline = await api(`/api/event-clusters/${id}/timeline`);
  } catch { timelineError = true; }

  let actions = null;
  let actionsError = false;
  try {
    actions = await api(`/api/event-clusters/${id}/recommended-actions`);
  } catch { actionsError = true; }

  const container = el('div', { class: 'cluster-detail' });

  // Write actions (operator+), driven through ClusterView's buttons.
  async function doAck() {
    try { await api(`/api/event-clusters/${id}/ack`, { method: 'POST' }); toast('Situation acknowledged'); render(); }
    catch (err) { toast(errText(err), true); }
  }
  async function doResolve() {
    const note = window.prompt('Resolution note (required):');
    if (!note || !note.trim()) return;
    try { await api(`/api/event-clusters/${id}/resolve`, { method: 'POST', body: { note: note.trim() } }); toast('Situation resolved'); render(); }
    catch (err) { toast(errText(err), true); }
  }
  // Explicit, confirmed, audit-logged playbook execution from the event page.
  async function doRunPlaybook(rb) {
    if (!confirm(`Run playbook "${rb.linkedPlaybookName || rb.title}" against this situation's targets? It will be verified after the settle window.`)) return;
    try {
      const { verification } = await api(`/api/event-clusters/${id}/run-playbook`, { method: 'POST', body: { runbookId: rb.id } });
      const mins = verification ? Math.round((verification.settleSeconds || 300) / 60) : 5;
      toast(`Playbook queued — verification in ~${mins} min`);
      render();
    } catch (err) { toast(errText(err), true); }
  }

  ClusterView.renderPage(document, container, { detail, timeline, timelineError, actions, actionsError }, clusterRenderOpts({
    canWrite: canWrite(), back, onAck: doAck, onResolve: doResolve, onRunPlaybook: doRunPlaybook,
  }));
  return container;
};

// ---- Traffic (MIGRATED — see public/views/traffic.js) -----------------------
// The chart plotter, the storage fold, the history explorer and the traffic-type
// breakdown stay here: each is its own unmigrated component, and Traffic is the
// only screen that mounts them. The view asks for them and app.js hands them over.
let trafficView = null;
// ovState is declared below this block, so the state object is built on first
// use rather than at module level.
const trafficViewState = {};

function getTrafficView() {
  if (trafficView) return trafficView;
  if (typeof window === 'undefined' || !window.TrafficView || !ui) return null;
  trafficViewState.selection = ovState.selection;
  // The three folds are built once per view entry and handed to the view to
  // append. They carry their own polling and their own state.
  let extras = null;
  const buildExtras = () => {
    const storageSummary = el('summary', { class: 'storage-line' }, el('span', { class: 'muted' }, 'Storage …'));
    const storageBody = el('div', { class: 'storage-detail-body' });
    const typesCard = trafficTypesCard();
    const histSection = trafficHistorySection({ onData: (d) => typesCard.update(d) });
    const typeSection = trafficTypeSection();
    return {
      storageSummary,
      storageBody,
      nodes: [
        el('details', { class: 'storage-fold' }, storageSummary, storageBody),
        el('div', { class: 'hist-row' },
          el('details', { class: 'sec hist-main' },
            el('summary', {}, 'History — inspect time window ', el('span', { class: 'muted' }, '· select agent + period')),
            histSection.node),
          typesCard.node),
        el('details', { class: 'sec' },
          el('summary', {}, 'Traffic type ', el('span', { class: 'muted' }, '· per agent · DNS, Facebook, …')),
          typeSection.node),
      ],
    };
  };

  trafficView = window.TrafficView.create({
    el, t, ui, errText, fmtBytes, gotoView, openAgent,
    state: trafficViewState,
    plot: (series, opts) => multiChart(series, opts),
    help: () => {
      const info = PAGE_INFO.overview || {};
      return { lead: info.hero || '', title: info.title || t('traffic.title'), body: info.body || (() => []) };
    },
    // One tick: every agent's latest traffic totals, in parallel. An agent that
    // has not reported counts as zero rather than dropping out of the total.
    fetchTick: async () => {
      const agents = await api('/agents');
      const latest = await Promise.all(agents.map(async (a) => {
        try {
          const rows = await api(`/agents/${a.id}/results?limit=1`);
          const tr = rows[0] && rows[0].payload && rows[0].payload.traffic && rows[0].payload.traffic.totals;
          return { a, rx: tr ? Number(tr.rxBytesPerSec) || 0 : 0, tx: tr ? Number(tr.txBytesPerSec) || 0 : 0 };
        } catch { return { a, rx: 0, tx: 0 }; }
      }));
      return { agents, latest };
    },
    fetchAlert: async () => {
      const list = await api(`/api/findings?since=${new Date(Date.now() - 3600000).toISOString()}`);
      return list.find((f) => (f.severity === 'CRIT' || f.severity === 'WARN') && !f.acked) || null;
    },
    fetchSites: async () => {
      const locs = await api('/locations');
      const mapped = locs.filter((l) => l.latitude != null).length;
      return { count: locs.length, hint: t('traffic.stat.sitesHint', { mapped }) };
    },
    mountExtras: (page) => { extras = buildExtras(); page.append(...extras.nodes); },
    refreshExtras: () => {
      if (!extras) return;
      api('/system/storage').then((s) => {
        extras.storageSummary.replaceChildren(...storageLineParts(s));
        extras.storageBody.replaceChildren(storageCards(s));
      }).catch(() => { /* the line keeps its placeholder */ });
    },
    startPolling: (refresh) => {
      stopOverview();
      ovState.timer = setInterval(() => {
        if (currentView !== 'overview') { stopOverview(); return; }
        if (modalOpen()) return;
        refresh();
      }, 3000);
    },
  });
  return trafficView;
}

views.overview = async () => {
  const v = getTrafficView();
  if (!v) return el('div', { class: 'empty error' }, t('traffic.err.title'));
  stopOverview();
  return v.view();
};

// Overview polling state, so switching tabs stops it.
const ovState = { timer: null, selection: new Set() };
function stopOverview() { if (ovState.timer) { clearInterval(ovState.timer); ovState.timer = null; } }

// Probes polling state (the "Probes" view auto-refreshes its latest results).
const probeState = { timer: null };
function stopProbes() { if (probeState.timer) { clearInterval(probeState.timer); probeState.timer = null; } }

// Interfaces polling state.
const ifaceState = { timer: null };
function stopIfaces() { if (ifaceState.timer) { clearInterval(ifaceState.timer); ifaceState.timer = null; } }

// ---- Shared probe + interface renderers -----------------------------------
// Used by the per-agent tabs (Interfaces, Probes) AND the combined agent page,
// so there is one source of truth for each table.

const IFACE_RANK = { down: 0, bad: 1, warn: 2, ok: 3 };
function ifaceStatusBadge(i) {
  // Accepts an interface object (preferred) or a bare status string.
  const iface = i && typeof i === 'object' ? i : null;
  const s = iface ? iface.status : i;
  // A virtual/idle port that is merely down (docker0, veth…, VPN tunnels) is not
  // a fault — show a neutral IDLE chip rather than a red DOWN.
  if (iface && iface.virtual && iface.linkDown) {
    return el('span', { class: 'badge grace', title: 'Virtual/idle interface — link down is expected, not a fault' }, 'IDLE');
  }
  // Severity palette: bad/down read red (consistent with the rest of the UI).
  const map = { ok: ['online', 'OK'], warn: ['warn', 'WARN'], bad: ['error', 'ERR'], down: ['down', 'DOWN'] };
  const [cls, label] = map[s] || ['grace', s];
  return el('span', { class: `badge ${cls}` }, label);
}
function ifaceLinkText(i) {
  if (!i.speedMbps && !i.operStatus) return '–';
  const sp = i.speedMbps ? (i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gb/s` : `${i.speedMbps} Mb/s`) : '';
  return [sp, i.operStatus].filter(Boolean).join(' · ');
}
// Interface health table (worst first). Empty-state when there is no data;
// `source` (the agent's traffic source) tailors that message.
function interfaceTable(interfaces, source = null) {
  const ifs = (interfaces || []).slice().sort((a, b) => (IFACE_RANK[a.status] - IFACE_RANK[b.status]) || ((b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec)));
  if (!ifs.length) {
    // Flow sources (sflow/netflow) report sampled flow records (5-tuple
    // conversations), not per-interface byte-rates/errors/discards — so this
    // table is ALWAYS empty for them, however healthy the flow pipeline looks
    // on Diagnose. Say so plainly instead of implying an agent update would
    // help (it won't), and point to the source switch + the views that do use
    // the flow data this agent reports.
    if (source === 'sflow' || source === 'netflow') {
      return el('div', { class: 'empty' },
        `This agent's traffic source is “${source}”, which reports sampled flow records (conversations) — not per-interface counters, so there is nothing to show here even when the flow pipeline is healthy. `,
        'Per-interface health (utilisation / errors / discards / link) needs a ',
        el('b', {}, 'proc'), ' or ', el('b', {}, 'snmp'),
        ' source — switch it under ', el('b', {}, 'Agents → Edit → Traffic source'),
        '. The flow data this agent does report appears on the ',
        viewLink('overview', 'Traffic'), ', ', viewLink('flows'), ' and ', viewLink('geo', 'Destinations'), ' pages.');
    }
    return el('div', { class: 'empty' }, 'No interface data yet — requires an agent measurement (update the agent for errors/discards/link).');
  }
  return el('table', { class: 'iface-table' },
    el('thead', {}, el('tr', {}, ...['Interface', 'Status', 'Link', 'Utilization', '↓ RX', '↑ TX', 'Errors/s', 'Discards/s'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...ifs.map((i) => el('tr', {},
      el('td', {}, i.iface),
      el('td', {}, ifaceStatusBadge(i)),
      el('td', { class: 'muted' }, ifaceLinkText(i)),
      el('td', {}, i.utilPct != null ? el('div', { class: 'util' }, usageBar(i.utilPct), el('span', { class: 'muted num' }, `${i.utilPct}%`)) : el('span', { class: 'muted' }, '–')),
      el('td', { class: 'num' }, `${fmtBytes(i.rxBytesPerSec)}/s`),
      el('td', { class: 'num' }, `${fmtBytes(i.txBytesPerSec)}/s`),
      el('td', { class: `num${i.errPerSec > 0 ? ' bad-text' : ''}` }, String(i.errPerSec)),
      el('td', { class: `num${i.dropPerSec > 0 ? ' warn-text' : ''}` }, String(i.dropPerSec))))));
}

// Latest probe results (newest per target). onDetail(r) fires from each row.
// Diagnostic tools the agent can install on request (mirrors the server's
// allowlist). Used to turn a "<tool> not installed" probe failure into an offer
// to install it.
const INSTALLABLE_TOOLS = ['traceroute', 'mtr', 'tcptraceroute'];

// If a failed probe says a tool is missing (e.g. "traceroute not installed"),
// returns that (installable) tool name, else null.
function missingToolOf(r) {
  if (!r || r.ok || !r.detail) return null;
  const m = /([a-z][a-z0-9_-]*)\s+not installed/i.exec(String(r.detail));
  const tool = m ? m[1].toLowerCase() : null;
  return tool && INSTALLABLE_TOOLS.includes(tool) ? tool : null;
}

// Builds the cURL content-check controls (method + expectations) shared by both
// probe forms. Returns { wrap, apply }: apply(body) copies any set expectation
// onto the run-probe payload. Empty fields are omitted (no assertion made), so a
// bare curl probe is just a status<400 reachability check.
function curlInputs() {
  const method = el('select', {}, ...['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => el('option', { value: m }, m)));
  const expectStatus = el('input', { type: 'number', min: '100', max: '599', placeholder: '200', style: 'width:5em' });
  const expectBody = el('input', { type: 'text', placeholder: 'substring or /regex/' });
  const expectHeader = el('input', { type: 'text', placeholder: 'Name or Name: value' });
  const wrap = el('span', { class: 'inline muted curl-opts' },
    el('label', { class: 'inline muted' }, 'Method ', method),
    el('label', { class: 'inline muted' }, 'Expect status ', expectStatus),
    el('label', { class: 'inline muted' }, 'Body ', expectBody),
    el('label', { class: 'inline muted' }, 'Header ', expectHeader));
  function apply(body) {
    if (method.value && method.value !== 'GET') body.method = method.value;
    if (expectStatus.value) body.expectStatus = Number(expectStatus.value);
    const eb = expectBody.value.trim(); if (eb) body.expectBody = eb;
    const eh = expectHeader.value.trim(); if (eh) body.expectHeader = eh;
  }
  return { wrap, apply };
}

// Builds the multi-step transaction editor (shared by the Probe runner and the
// test-package editor). Returns { node, collect }: collect() yields the steps
// array. Each step is an http(s) request with optional assertions and an optional
// value extraction; later steps reference an extracted value as {{name}}.
function transactionStepsEditor(initial) {
  const list = el('div', { class: 'tx-steps' });
  const rows = [];
  const renumber = () => rows.forEach((c, i) => { c.num.textContent = `Step ${i + 1}`; });
  function addStep(s) {
    s = s || {};
    const method = el('select', {}, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => el('option', { value: m, ...(String(s.method || 'GET').toUpperCase() === m ? { selected: 'selected' } : {}) }, m)));
    const url = el('input', { type: 'text', class: 'tx-url', placeholder: 'https://api/… (may use {{var}})', value: s.url || '' });
    const stat = el('input', { type: 'number', min: '100', max: '599', placeholder: 'expect status', value: s.expectStatus != null ? s.expectStatus : '' });
    const bodyM = el('input', { type: 'text', placeholder: 'expect body (substring or /regex/)', value: s.expectBody || '' });
    const header = el('input', { type: 'text', placeholder: 'send header — e.g. Authorization: Bearer {{token}}', value: s.header || '' });
    const data = el('input', { type: 'text', placeholder: 'request body (POST/PUT)', value: s.data || '' });
    const exName = el('input', { type: 'text', placeholder: 'extract → variable', value: (s.extract && s.extract.name) || '' });
    const exPat = el('input', { type: 'text', placeholder: 'extract regex (capture group 1)', value: (s.extract && s.extract.pattern) || '' });
    const num = el('span', { class: 'tx-step-num' }, '');
    const ctrl = { method, url, stat, bodyM, header, data, exName, exPat, num };
    const del = el('button', { type: 'button', class: 'small ghost danger', title: 'Remove step', onclick: () => { const i = rows.indexOf(ctrl); if (i >= 0) rows.splice(i, 1); block.remove(); renumber(); } }, '×');
    const block = el('div', { class: 'tx-step' },
      el('div', { class: 'tx-step-line' }, num, method, url, del),
      el('div', { class: 'tx-step-line' }, stat, bodyM),
      el('div', { class: 'tx-step-line' }, header, data),
      el('div', { class: 'tx-step-line' }, exName, exPat));
    rows.push(ctrl); list.append(block); renumber();
    return ctrl;
  }
  (initial && initial.length ? initial : [{}]).forEach(addStep);
  const node = el('div', { class: 'tx-editor' }, list,
    el('button', { type: 'button', class: 'small ghost', onclick: () => addStep({}) }, '+ Step'));
  function collect() {
    return rows.map((c) => {
      const step = { url: c.url.value.trim() };
      if (c.method.value && c.method.value !== 'GET') step.method = c.method.value;
      if (c.stat.value) step.expectStatus = Number(c.stat.value);
      const b = c.bodyM.value.trim(); if (b) step.expectBody = b;
      const h = c.header.value.trim(); if (h) step.header = h;
      const d = c.data.value.trim(); if (d) step.data = d;
      const en = c.exName.value.trim(); const ep = c.exPat.value.trim();
      if (en && ep) step.extract = { name: en, pattern: ep };
      return step;
    }).filter((s) => s.url);
  }
  return { node, collect };
}

// What a result actually MEASURED, in that probe type's own terms.
//
// The table used to carry three fixed columns — RTT, Loss, Jitter — which fit
// ping and nothing else. Four of the nine types (traceroute, tcptraceroute,
// path_mtu, and any probe that failed to run) left all three empty, and two
// more put a number in the RTT column that is not an RTT: pageload reports a
// whole-page load time there, transaction the total time across every step. So
// half the table was blank and part of the rest was mislabelled.
//
// One column that says what this probe measures is both narrower and more
// honest. Returns a plain string; `null` means there is genuinely nothing to
// report, which renders as an em dash rather than an invented zero.
function probeMeasured(r) {
  const ms = (v) => `${v} ms`;
  const loss = r.lossPct != null && r.lossPct > 0 ? ` · ${r.lossPct}% loss` : '';
  switch (r.type) {
    case 'path_mtu': {
      const m = r.mtu || {};
      if (m.pathMtu == null) return null;
      // The recommended MSS is the number an operator acts on, so it travels
      // with the MTU rather than waiting behind a click.
      return `${m.pathMtu} B${m.recommendedMss != null ? ` · MSS ${m.recommendedMss}` : ''}`;
    }
    case 'traceroute':
    case 'tcptraceroute': {
      const hops = Array.isArray(r.hops) ? r.hops : [];
      if (!hops.length) return null;
      const worst = hops.reduce((w, h) => (h.lossPct != null && (w == null || h.lossPct > w) ? h.lossPct : w), null);
      return `${hops.length} hops${worst ? ` · ${worst}% worst hop loss` : ''}`;
    }
    case 'tls': {
      // The expiry is the number people come for; the faults are named next to
      // it because a certificate with 300 days left and an untrusted chain is
      // not a healthy certificate.
      const c = r.tls || {};
      const parts = [];
      if (c.expiryDays != null) parts.push(c.expiryDays <= 0 ? `expired ${Math.abs(Math.round(c.expiryDays))}d ago` : `${Math.round(c.expiryDays)}d left`);
      if (c.authorized === false) parts.push('untrusted');
      if (c.hostnameMatches === false) parts.push('name mismatch');
      if (c.protocol) parts.push(c.protocol);
      return parts.length ? parts.join(' · ') : null;
    }
    case 'rdns': {
      const d = r.rdns || {};
      if (!d.ptrNames || !d.ptrNames.length) return r.ok ? null : 'no PTR';
      return `${d.ptrNames[0]}${d.forwardConfirmed ? '' : ' · unconfirmed'}`;
    }
    case 'pageload':
      return r.rttMs == null ? null
        : `${ms(r.rttMs)} load${r.bytes != null ? ` · ${fmtBytes(r.bytes)}` : ''}`;
    case 'transaction': {
      const steps = Array.isArray(r.elements) ? r.elements.length : 0;
      return r.rttMs == null ? null : `${ms(r.rttMs)} total${steps ? ` · ${steps} steps` : ''}`;
    }
    case 'curl':
      return r.rttMs == null ? null
        : `${ms(r.rttMs)}${r.status != null ? ` · ${r.status}` : ''}${r.bytes != null ? ` · ${fmtBytes(r.bytes)}` : ''}`;
    case 'http':
      return r.rttMs == null ? null : `${ms(r.rttMs)}${r.status != null ? ` · ${r.status}` : ''}`;
    default:
      // ping / tcp / dns — the three the old columns were built for.
      if (r.rttMs == null) return r.lossPct != null ? `${r.lossPct}% loss` : null;
      return `${ms(r.rttMs)}${loss}${r.jitterMs != null ? ` · ${r.jitterMs} ms jitter` : ''}`;
  }
}

// The sub-lines under the target: what happened, in the probe's own words.
function probeWhat(r) {
  const lines = [];
  // curl/http carry a verification/cert explanation; a probe that could not RUN
  // carries its reason ("traceroute not installed", "ping failed: …").
  if (r.detail) lines.push(el('div', { class: 'muted small' }, r.detail));
  if (r.type === 'curl' && r.contentType) {
    lines.push(el('div', { class: 'muted small' }, r.contentType));
  }
  // A blackhole is the one finding that must not wait behind a click: it is the
  // reason this probe type exists, and a row that hides it is a row that gets
  // scrolled past.
  if (r.type === 'path_mtu' && r.mtu && r.mtu.blackholeDetected) {
    lines.push(el('div', { class: 'error small' }, t('probe.mtu.status.blackhole')));
  }
  return lines;
}

// The latest-results table: one row per (type, target), each opening its own
// detail in place.
//
// IN PLACE, not below the table, because comparing a result with the ones
// around it is the diagnostic move, and a detail pane that replaces itself
// somewhere else makes that impossible — the same reasoning as the Monitors
// results table, whose disclosure mechanics this copies.
//
// `loadDetail(r)` returns a Promise of the detail node. It is a callback rather
// than a direct probeDetail() call because probeDetail also renders standalone
// (the topology "Show route" modal), and because the caller owns the agent id.
// `onOpenChange(isOpen)` lets the caller pause its refresh loop — replacing the
// tbody under an open row would close it.
function probeLatestTable(rows, loadDetail, onInstall = null, onOpenChange = null) {
  if (!rows.length) return el('div', { class: 'muted' }, 'No probe results yet — run one above.');
  const COLS = 6;
  // One open at a time. Two open traceroutes would each mount a path
  // visualisation, and those write the brush window to the URL — the second
  // would overwrite the first's, silently.
  let openRow = null;
  const announce = () => { if (onOpenChange) onOpenChange(!!openRow); };

  const body = el('tbody');
  for (const r of rows) {
    const tool = onInstall ? missingToolOf(r) : null;
    const measured = probeMeasured(r);
    const detailCell = el('td', { colspan: String(COLS) });
    const detail = el('tr', { class: 'probe-detail-row', hidden: true }, detailCell);
    const caret = el('span', { class: 'sa-disclosure' }, '▸');
    let loaded = false;
    let loading = false;

    async function open() {
      row.classList.add('open');
      caret.textContent = '▾';
      detail.hidden = false;
      // Fetched once and kept: re-opening a row should not re-run two or three
      // HTTP calls, and the guard is what stops a double click from starting a
      // second fetch while the first is still in flight.
      if (loaded || loading) return;
      loading = true;
      detailCell.replaceChildren(el('div', { class: 'pv-skel', style: 'height:120px' }));
      try {
        detailCell.replaceChildren(await loadDetail(r));
        // probeDetail renders a failed history fetch as an error NODE rather than
        // throwing, so "it resolved" is not the same as "it loaded". A cached
        // error is a dead end — the row stays unloaded and tries again on the
        // next open, which is what a person does after a blip anyway.
        loaded = !detailCell.querySelector('.error');
      } catch (e) {
        detailCell.replaceChildren(el('div', { class: 'error' }, errText(e)));
      } finally { loading = false; }
    }
    function close() {
      row.classList.remove('open');
      caret.textContent = '▸';
      detail.hidden = true;
    }
    function toggle() {
      if (openRow === entry) { close(); openRow = null; announce(); return; }
      if (openRow) openRow.close();
      openRow = entry;
      announce();
      open();
    }

    const row = el('tr', {
      class: 'probe-result-row',
      tabindex: '0',
      title: t('probe.row.open'),
      onclick: (e) => { if (!e.target.closest('button')) toggle(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
    },
      el('td', {}, caret, el('span', { class: `badge ${r.ok ? 'online' : 'offline'}`, title: !r.ok && r.detail ? r.detail : null }, r.ok ? 'ok' : 'error')),
      el('td', {}, r.type),
      el('td', {}, r.target, ...probeWhat(r)),
      el('td', { class: 'num' }, measured == null ? '–' : measured),
      el('td', { class: 'muted' }, r.ts ? fmtTimeShort(new Date(r.ts).getTime()) : '–'),
      el('td', {}, tool
        ? el('button', { class: 'small', title: `Install ${tool} on the agent host`, onclick: (e) => { e.stopPropagation(); onInstall(tool, r, e.target); } }, `Install ${tool}`)
        : null));
    const entry = { close };
    body.append(row, detail);
  }

  return el('table', { class: 'probe-results' },
    el('thead', {}, el('tr', {}, ...[
      t('probe.col.status'), t('probe.col.type'), t('probe.col.target'),
      t('probe.col.measured'), t('probe.col.time'), '',
    ].map((h) => el('th', {}, h)))),
    body);
}

// Posts an install-tool request for one agent and reflects the outcome on the
// clicked button. Shared by the Probes view and the agent detail page.
async function requestToolInstall(agentId, tool, btn) {
  if (btn) { btn.disabled = true; btn.textContent = `Installing ${tool}…`; }
  try {
    const res = await api(`/agents/${encodeURIComponent(agentId)}/install-tool`, { method: 'POST', body: { tool } });
    if (res && res.accepted) toast(`Installing ${tool} on the agent — watch Reporting → Audit for the result.`);
    else toast(`Agent could not start the install${res && res.reason ? ` (${res.reason})` : ''}.`, true);
  } catch (e) {
    toast(e.status === 409 ? 'The agent is not connected right now.' : errText(e), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = `Install ${tool}`; }
  }
}

// Interactive path map: a directed, weighted hop graph for a traceroute target
// (agent → hops → destination). Nodes are TTL positions coloured by severity;
// links carry the downstream loss + incremental latency. Hovering/focusing a node
// fills the detail panel with its full per-hop metrics + GeoIP/ASN. Pure SVG, no
// libs — same vanilla approach as networkPath()/historyChart().
function pathGraph(graph, pgOpts = {}) {
  const nodes = graph.nodes || [];
  const onNodeClick = typeof pgOpts.onNodeClick === 'function' ? pgOpts.onNodeClick : null;
  if (nodes.length <= 1) return el('div', { class: 'empty' }, 'No traceroute path yet — run a traceroute above.');
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) if (v != null) e.setAttribute(a, v);
    for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const NW = 122, NH = 70, GAP = 56, top = 20, cy = top + NH / 2;
  const xOf = (i) => 10 + i * (NW + GAP);
  const width = xOf(nodes.length - 1) + NW + 10;
  const height = NH + top * 2;

  const fmtMs = (v) => (v == null ? '–' : `${v} ms`);
  const fmtPct = (v) => (v == null ? '–' : `${v}%`);
  const stat = (k, v) => el('span', { class: 'pg-stat' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
  const panel = el('div', { class: 'pg-panel' });
  function showNode(n) {
    const loc = [n.asnName ? `AS${n.asn ?? '?'} ${n.asnName}` : (n.asn != null ? `AS${n.asn}` : null), n.country].filter(Boolean).join(' · ');
    panel.replaceChildren(
      el('div', { class: 'pg-panel-head' },
        el('span', { class: `pg-dot ${n.severity}` }),
        el('strong', {}, n.kind === 'source' ? 'Agent (origin)' : (n.kind === 'dest' ? `Destination · hop ${n.hop}` : `Hop ${n.hop}`)),
        el('span', { class: 'mono' }, n.ip || (n.unresponsive ? '* * * (silent)' : '–'))),
      el('div', { class: 'muted' }, n.explain),
      loc ? el('div', {}, loc) : (n.private ? el('div', { class: 'muted' }, 'Private / RFC1918 — not geolocated') : null),
      el('div', { class: 'pg-stats' },
        stat('Latency', fmtMs(n.rttMs)),
        stat('Loss', fmtPct(n.lossPct)),
        stat('Worst loss', fmtPct(n.worstLossPct)),
        stat('Jitter', fmtMs(n.jitterMs)),
        stat('Replied', `${n.responded}/${n.runs}`)));
  }

  const svg = mk('svg', { viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), role: 'img', 'aria-label': `Network path to ${graph.target || 'target'}` });
  (graph.links || []).forEach((lk) => {
    const x1 = xOf(lk.from) + NW;
    const x2 = xOf(lk.to);
    const lab = lk.lossPct ? `${lk.lossPct}% loss` : (lk.latencyMs != null ? `+${lk.latencyMs} ms` : null);
    svg.append(mk('line', { x1, y1: cy, x2, y2: cy, class: `pg-link ${lk.severity}`, 'stroke-linecap': 'round' }));
    if (lab) svg.append(mk('text', { x: (x1 + x2) / 2, y: cy - 9, 'text-anchor': 'middle', class: `pg-llab ${lk.severity}` }, lab));
  });
  // Problem hop (the highest-severity hop) gets a red ring so it stands out even
  // before hovering — used by the Troubleshooting view's pre-highlight.
  const worstIdx = graph.worstHopIndex != null ? graph.worstHopIndex : null;
  nodes.forEach((n, i) => {
    const x = xOf(i);
    const top3 = n.kind === 'source' ? 'AGENT' : (n.kind === 'dest' ? `DEST · #${n.hop}` : `HOP #${n.hop}`);
    const meta = n.asn != null ? `AS${n.asn}${n.country ? ' · ' + n.country : ''}` : (n.rttMs != null ? `${n.rttMs} ms` : (n.unresponsive ? 'no reply' : ''));
    const flags = `${n.index === worstIdx ? ' worst' : ''}${n.severity === 'bad' ? ' problem' : ''}${onNodeClick ? ' clickable' : ''}`;
    const g = mk('g', { class: `pg-node ${n.severity} ${n.kind}${flags}`, tabindex: '0', role: 'button', 'aria-label': `${top3} ${n.ip || ''} ${n.explain}` },
      mk('rect', { x, y: top, width: NW, height: NH, rx: 10 }),
      mk('text', { x: x + 11, y: top + 19, class: 'pg-hop' }, top3),
      mk('text', { x: x + 11, y: top + 38, class: 'pg-ip' }, (n.ip || (n.unresponsive ? '* * *' : '—')).slice(0, 17)),
      mk('text', { x: x + 11, y: top + 56, class: 'pg-meta' }, meta));
    g.addEventListener('mouseenter', () => showNode(n));
    g.addEventListener('focus', () => showNode(n));
    if (onNodeClick) {
      g.addEventListener('click', () => onNodeClick(n));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNodeClick(n); } });
    }
    svg.append(g);
  });
  showNode(nodes[nodes.length - 1]); // default to the destination

  // ECMP / multipath: when a hop load-balances across several next-hops, draw the
  // branches as separate bezier curves that fan out from the shared upstream node
  // and rejoin downstream, each alternate keeping its own hop node. Built from the
  // server's `branches` structure (distinct IPs per TTL + observed transitions).
  const branches = graph.branches && graph.branches.multipath ? graph.branches : null;
  function buildBranchSvg() {
    const ALT_H = 46, BH = 44;
    const nodeByHop = new Map();
    for (const n of nodes) if (n.kind !== 'source') nodeByHop.set(n.hop, n);
    const source = nodes[0];
    // Per hop, assign a y-centre to each IP: primary at the main row, alternates
    // stacked below. posY: hop -> Map(ip -> yCentre); posMeta: hop -> Map(ip -> ipEntry).
    const posY = new Map();
    const posMeta = new Map();
    let maxAlt = 0;
    for (const h of branches.hops) {
      const ym = new Map(); const mm = new Map();
      h.ips.forEach((ipEntry, k) => {
        const yc = k === 0 ? cy : (top + NH + (k - 1) * ALT_H + BH / 2);
        ym.set(ipEntry.ip, yc); mm.set(ipEntry.ip, ipEntry);
      });
      maxAlt = Math.max(maxAlt, h.ips.length - 1);
      posY.set(h.hop, ym); posMeta.set(h.hop, mm);
    }
    const bh = NH + top * 2 + maxAlt * ALT_H;
    const s = mk('svg', { viewBox: `0 0 ${width} ${bh}`, width: String(width), height: String(bh), role: 'img', 'aria-label': `ECMP path to ${graph.target || 'target'}` });
    const xOfHop = (hop) => (hop === 0 ? xOf(0) : (nodeByHop.has(hop) ? xOf(nodeByHop.get(hop).index) : null));
    const bez = (x1, y1, x2, y2) => { const mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; };
    // Source → each IP of the earliest hop (transitions from the agent aren't recorded).
    const firstHop = branches.hops.length ? branches.hops[0].hop : null;
    if (firstHop != null && source) {
      const x1 = xOf(0) + NW; const ym = posY.get(firstHop);
      for (const [ip, y2] of ym) {
        const sev = (posMeta.get(firstHop).get(ip) || {}).severity || 'ok';
        s.append(mk('path', { d: bez(x1, cy, xOfHop(firstHop), y2), class: `pg-link ${sev}`, fill: 'none' }));
      }
    }
    // Observed transitions become the branch edges.
    for (const e of branches.edges) {
      const x1 = xOfHop(e.fromHop); const x2 = xOfHop(e.toHop);
      if (x1 == null || x2 == null) continue;
      const y1 = (posY.get(e.fromHop) || new Map()).get(e.fromIp);
      const y2 = (posY.get(e.toHop) || new Map()).get(e.toIp);
      if (y1 == null || y2 == null) continue;
      const sev = ((posMeta.get(e.toHop) || new Map()).get(e.toIp) || {}).severity || 'ok';
      s.append(mk('path', { d: bez(x1 + NW, y1, x2, y2), class: `pg-link ${sev}`, fill: 'none' }));
    }
    // Draw the source node + every branch node.
    const drawNode = (x, yTop, w, hgt, sev, kind, line1, line2, line3, pseudo) => {
      const g = mk('g', { class: `pg-node ${sev} ${kind}${sev === 'bad' ? ' problem' : ''}${onNodeClick ? ' clickable' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${line1} ${line2}` },
        mk('rect', { x, y: yTop, width: w, height: hgt, rx: 10 }),
        mk('text', { x: x + 11, y: yTop + 18, class: 'pg-hop' }, line1),
        mk('text', { x: x + 11, y: yTop + 34, class: 'pg-ip' }, String(line2).slice(0, 17)),
        line3 != null ? mk('text', { x: x + 11, y: yTop + (hgt > 50 ? 52 : 42), class: 'pg-meta' }, String(line3).slice(0, 18)) : null);
      if (pseudo) {
        g.addEventListener('mouseenter', () => showNode(pseudo));
        g.addEventListener('focus', () => showNode(pseudo));
        if (onNodeClick) g.addEventListener('click', () => onNodeClick(pseudo));
      }
      s.append(g);
    };
    drawNode(xOf(0), top, NW, NH, 'ok', 'source', 'AGENT', source.label || 'Agent', 'origin', source);
    for (const h of branches.hops) {
      const x = xOfHop(h.hop);
      h.ips.forEach((ip, k) => {
        const isDest = nodeByHop.get(h.hop) && nodeByHop.get(h.hop).kind === 'dest' && k === 0;
        const yc = posY.get(h.hop).get(ip.ip);
        const yTop = k === 0 ? top : yc - BH / 2;
        const hgt = k === 0 ? NH : BH;
        const kind = isDest ? 'dest' : 'hop';
        const label1 = isDest ? `DEST · #${h.hop}` : (k === 0 ? `HOP #${h.hop}` : `ALT #${h.hop}`);
        const meta = ip.asn != null ? `AS${ip.asn}${ip.country ? ' · ' + ip.country : ''}` : (ip.rttMs != null ? `${ip.rttMs} ms` : '');
        const isWorst = k === 0 && nodeByHop.get(h.hop) && nodeByHop.get(h.hop).index === graph.worstHopIndex;
        const pseudo = { ...ip, kind, hop: h.hop, worstLossPct: ip.lossPct, responded: ip.responded, runs: ip.runs, unresponsive: false };
        drawNode(x, yTop, NW, hgt, ip.severity, `${kind}${ip.primary ? '' : ' alt'}${isWorst ? ' worst' : ''}`, label1, ip.ip || '—', meta, pseudo);
      });
    }
    return s;
  }
  const branchSvg = branches ? buildBranchSvg() : null;

  const legend = el('div', { class: 'pg-legend' },
    ...[['ok', 'Healthy'], ['warn', 'Degraded'], ['bad', 'Critical'], ['muted', 'Silent hop']].map(([c, l]) =>
      el('span', { class: 'lg' }, el('span', { class: `pg-dot ${c}` }), l)));

  // AS-level projection: the same path collapsed to AS hops (the observed
  // FORWARDING AS-path — not the BGP AS_PATH attribute). A toggle swaps the hop
  // graph for the AS graph (graph.asGraph, built server-side). Only offered when
  // GeoIP/ASN resolved at least one transit/destination AS.
  const asg = graph.asGraph && (graph.asGraph.nodes || []).length > 1 ? graph.asGraph : null;
  function showAs(n) {
    panel.replaceChildren(
      el('div', { class: 'pg-panel-head' },
        el('span', { class: `pg-dot ${n.severity}` }),
        el('strong', {}, n.kind === 'source' ? 'Agent (origin)' : (n.kind === 'dest' ? 'Destination AS' : 'Transit AS')),
        el('span', { class: 'mono' }, n.asn != null ? `AS${n.asn}` : '—')),
      n.asnName ? el('div', {}, n.asnName) : null,
      n.country ? el('div', { class: 'muted' }, n.country) : null,
      el('div', { class: 'pg-stats' },
        stat('Hops', n.hops && n.hops.length ? `#${n.hops.join(', #')}` : '–'),
        stat('Latency', fmtMs(n.rttMs)),
        stat('Loss', fmtPct(n.lossPct))));
  }
  function buildAsSvg(g) {
    const an = g.nodes || [];
    const w = xOf(an.length - 1) + NW + 10;
    const s = mk('svg', { viewBox: `0 0 ${w} ${height}`, width: String(w), height: String(height), role: 'img', 'aria-label': `AS path to ${graph.target || 'target'}` });
    (g.links || []).forEach((lk) => {
      const x1 = xOf(lk.from) + NW; const x2 = xOf(lk.to);
      s.append(mk('line', { x1, y1: cy, x2, y2: cy, class: `pg-link ${lk.severity}`, 'stroke-linecap': 'round' }));
    });
    an.forEach((n, i) => {
      const x = xOf(i);
      const top3 = n.kind === 'source' ? 'AGENT' : (n.kind === 'dest' ? 'DEST AS' : 'TRANSIT');
      const mid = n.kind === 'source' ? (n.label || 'Agent') : (n.asn != null ? `AS${n.asn}` : '—');
      const meta = n.asnName || n.country || (n.rttMs != null ? `${n.rttMs} ms` : '');
      const gg = mk('g', { class: `pg-node ${n.severity} ${n.kind}`, tabindex: '0', role: 'button', 'aria-label': `${top3} ${mid} ${meta}` },
        mk('rect', { x, y: top, width: NW, height: NH, rx: 10 }),
        mk('text', { x: x + 11, y: top + 19, class: 'pg-hop' }, top3),
        mk('text', { x: x + 11, y: top + 38, class: 'pg-ip' }, String(mid).slice(0, 17)),
        mk('text', { x: x + 11, y: top + 56, class: 'pg-meta' }, String(meta).slice(0, 18)));
      gg.addEventListener('mouseenter', () => showAs(n));
      gg.addEventListener('focus', () => showAs(n));
      s.append(gg);
    });
    return s;
  }

  // Two scroll panes (hop graph + optional AS graph); a toggle flips between them.
  // When the path is multipath, the hop pane shows the branch-aware graph.
  const hopWrap = el('div', { class: 'pg-scroll' }, branchSvg || svg);
  const asWrap = asg ? el('div', { class: 'pg-scroll' }, buildAsSvg(asg)) : null;
  if (asWrap) asWrap.style.display = 'none';
  let toggle = null;
  if (asg) {
    toggle = el('div', { class: 'pg-toggle', role: 'tablist' });
    const setView = (mode) => {
      const hop = mode === 'hop';
      hopWrap.style.display = hop ? '' : 'none';
      asWrap.style.display = hop ? 'none' : '';
      [...toggle.children].forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
      if (hop) showNode(nodes[nodes.length - 1]); else showAs(asg.nodes[asg.nodes.length - 1]);
    };
    for (const [m, label] of [['hop', 'Hop view'], ['as', 'AS view']]) {
      const b = el('button', { class: `pg-toggle-btn${m === 'hop' ? ' active' : ''}`, 'data-mode': m, type: 'button' }, label);
      b.addEventListener('click', () => setView(m));
      toggle.append(b);
    }
  }

  // Geographic overlay: the same path on the Destinations map. Public hops sit at
  // country-centroid precision, so consecutive hops in one country collapse to a
  // single stop. Lazily built on first open (Leaflet needs a sized container).
  const geoStops = pathGeoStops(nodes);
  const mapHost = el('div', { class: 'pg-map' });
  const mapSection = el('details', { class: 'sec pg-mapsec' },
    el('summary', {}, 'Geographic map ',
      el('span', { class: 'muted' }, geoStops.length >= 2 ? `· ${geoStops.length} located stops` : '· needs GeoIP + a public hop')),
    mapHost);
  let mapBuilt = false;
  mapSection.addEventListener('toggle', () => {
    if (!mapSection.open || mapBuilt) return;
    mapBuilt = true;
    drawPathMap(mapHost, geoStops);
  });

  return el('div', { class: 'pathmap' },
    el('div', { class: 'pg-head' },
      el('span', { class: 'muted' }, `${graph.samples} traceroute${graph.samples === 1 ? '' : 's'} aggregated · hover for detail`),
      branches ? el('span', { class: 'pg-ecmp', title: 'This path load-balances across multiple next-hops (ECMP)' }, 'ECMP · multipath') : null,
      toggle,
      legend),
    hopWrap,
    asWrap,
    panel,
    mapSection);
}

// Leaflet fill colour for a hop/segment severity (concrete hex — markers can't use
// CSS vars). Mirrors the path-graph legend.
function pgColor(sev) {
  return sev === 'bad' ? '#ef4444' : sev === 'warn' ? '#f59e0b' : sev === 'muted' ? '#94a3b8' : '#16a34a';
}

// Collapses the ordered path nodes into geolocated "stops": consecutive nodes
// sharing a coordinate (same country centroid) merge into one, carrying the worst
// severity and the hops they cover. Nodes without coordinates are skipped.
function pathGeoStops(nodes) {
  const rank = { ok: 0, muted: 0, warn: 1, bad: 2 };
  const stops = [];
  for (const n of nodes || []) {
    if (n.lat == null || n.lng == null) continue;
    const last = stops[stops.length - 1];
    if (last && last.lat === n.lat && last.lng === n.lng) { last.nodes.push(n); continue; }
    stops.push({ lat: n.lat, lng: n.lng, nodes: [n] });
  }
  for (const s of stops) s.severity = s.nodes.reduce((w, n) => ((rank[n.severity] || 0) > rank[w] ? n.severity : w), 'ok');
  return stops;
}

// Popup HTML for one map stop (esc-escaped — IPs/ASN come from GeoIP + traceroute).
function pathStopPopup(s, i, total) {
  const head = i === 0 ? 'Origin' : (i === total - 1 ? 'Destination' : 'Transit');
  const place = s.nodes[0].country ? ` · ${esc(s.nodes[0].country)}` : '';
  const lines = s.nodes.map((n) => {
    const who = n.kind === 'source' ? esc(n.label || 'Agent') : `Hop ${n.hop}${n.ip ? ' · ' + esc(n.ip) : ''}`;
    const asn = n.asn != null ? ` · AS${n.asn}${n.asnName ? ' ' + esc(n.asnName) : ''}` : '';
    const met = n.rttMs != null ? ` · ${n.rttMs} ms` : '';
    const loss = n.lossPct ? ` · ${n.lossPct}% loss` : '';
    return `<div>${who}${asn}${met}${loss}</div>`;
  }).join('');
  return `<div class="pg-pop"><strong>${head}${place}</strong>${lines}</div>`;
}

// Draws a path's geolocated stops into a Leaflet layer group: a polyline (each
// segment coloured by its downstream stop's severity) through circle markers with
// per-stop popups. Returns the ordered [lat,lng] list so the caller can fitBounds.
// Shared by the probe-detail map and the Destinations path picker.
function renderPathStops(layer, stops) {
  const latlngs = stops.map((s) => [s.lat, s.lng]);
  for (let i = 1; i < stops.length; i += 1) {
    L.polyline([latlngs[i - 1], latlngs[i]], { color: pgColor(stops[i].severity), weight: 3, opacity: 0.85 }).addTo(layer);
  }
  stops.forEach((s, i) => {
    const isSrc = s.nodes.some((n) => n.kind === 'source');
    L.circleMarker([s.lat, s.lng], {
      radius: isSrc ? 9 : 7, weight: 2, color: '#fff',
      fillColor: isSrc ? '#38bdf8' : pgColor(s.severity), fillOpacity: 0.95,
    }).addTo(layer).bindPopup(pathStopPopup(s, i, stops.length));
  });
  return latlngs;
}

// Draws the path on its own Leaflet map (the Probes traceroute detail). Reuses the
// Destinations tile config.
async function drawPathMap(host, stops) {
  if (typeof L === 'undefined') { host.replaceChildren(el('div', { class: 'error' }, 'Map library failed to load.')); return; }
  if (!stops || stops.length < 2) {
    host.replaceChildren(el('div', { class: 'empty' }, 'Not enough geolocated hops to map. Public hops are placed at country level, so this needs the GeoIP database plus the agent site and at least one public hop.'));
    return;
  }
  let cfg = {};
  try { cfg = await api('/api/map/config'); } catch { /* fall back to default tiles */ }
  const map = createLeafletMap(host, cfg, { center: [stops[0].lat, stops[0].lng], zoom: 3 });
  if (!map) return;
  const layer = L.layerGroup().addTo(map);
  const latlngs = renderPathStops(layer, stops);
  try { map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 7 }); } catch { /* single point */ }
  setTimeout(() => { try { map.invalidateSize(); } catch { /* ignore */ } }, 60);
}

// ==========================================================================
// Path Visualization — one shared component (path graph + brushable metric
// timeline) mounted in Topology (drawer), Probes, Tests and Troubleshooting.
// Props contract: pathVisualization({ sourceId, targetId, probeId, testId,
//   eventId, timeRange:{fromMs,toMs}, metric, overlay, problemHop,
//   onSelectionChange }). Vanilla JS, no build step — matches the SPA.
// ==========================================================================

const PATHVIZ_PALETTE = ['#06b6d4', '#f59e0b', '#8b5cf6', '#ec4899', '#10b981', '#ef4444', '#3b82f6', '#eab308'];

// Shareable brush state (from/to/metric/overlay) round-trips through the URL
// query string so a view can be linked — the SPA's filter-persistence pattern.
function pathVizReadParams() {
  try {
    const q = new URLSearchParams(window.location.search || '');
    return { from: q.get('from'), to: q.get('to'), metric: q.get('metric'), overlay: q.get('overlay') };
  } catch { return {}; }
}
function pathVizWriteParams(patch) {
  try {
    const q = new URLSearchParams(window.location.search || '');
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') q.delete(k); else q.set(k, String(v)); }
    const qs = q.toString();
    history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  } catch { /* URL API off — persistence is best-effort */ }
}

function pvFmtTime(ms) { return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

// A compact metric chart used for both the overview strip (low-opacity, no axes)
// and the detail chart. `render`: 'bars' (loss), 'line' (latency/jitter) or
// 'area' (throughput). Multiple series (per-agent overlay) always draw as lines.
// seriesList: [{ label, color, points:[{t(ms), y}] }]. onBrush(fromMs,toMs).
function pvChart(seriesList, { fromMs, toMs, render = 'line', unit = '', height = 180, onBrush = null, overview = false } = {}) {
  const W = 1000, H = height;
  const pad = overview ? { l: 8, r: 8, t: 6, b: 6 } : { l: 58, r: 12, t: 12, b: 24 };
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const all = seriesList.flatMap((s) => s.points.map((p) => p.y)).filter(Number.isFinite);
  const max = Math.max(1, ...all);
  const span = Math.max(1, toMs - fromMs);
  const xOf = (t) => pad.l + ((t - fromMs) / span) * (W - pad.l - pad.r);
  const yOf = (v) => H - pad.b - (Math.max(0, v) / max) * (H - pad.t - pad.b);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, class: 'big-chart-svg', preserveAspectRatio: 'none' });
  if (!overview) {
    for (const frac of [0, 0.5, 1]) {
      const yy = yOf(max * frac);
      svg.append(mk('line', { class: 'grid', x1: pad.l, y1: yy, x2: W - pad.r, y2: yy }));
      const lbl = mk('text', { x: 6, y: yy + 4, class: 'axis' }); lbl.textContent = fmtNum(max * frac); svg.append(lbl);
    }
    for (const frac of [0, 0.5, 1]) {
      const t = fromMs + frac * span; const xx = xOf(t);
      const lbl = mk('text', { x: xx, y: H - 8, class: 'axis', 'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle' });
      lbl.textContent = pvFmtTime(t); svg.append(lbl);
    }
  }
  const multi = seriesList.length > 1;
  seriesList.forEach((s) => {
    if (!s.points.length) return;
    const eff = (multi && render === 'bars') ? 'line' : render;
    const op = overview ? 0.5 : 1;
    if (eff === 'bars') {
      const bw = Math.max(1, ((W - pad.l - pad.r) / Math.max(1, s.points.length)) * 0.7);
      for (const p of s.points) {
        if (!Number.isFinite(p.y)) continue;
        const x = xOf(p.t) - bw / 2; const y = yOf(p.y);
        svg.append(mk('rect', { x: x.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: Math.max(0, (H - pad.b - y)).toFixed(1), fill: s.color, 'fill-opacity': String(op * 0.8) }));
      }
    } else if (eff === 'area') {
      const n = s.points.length;
      const line = s.points.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(' ');
      const d = `${line} L${xOf(s.points[n - 1].t).toFixed(1)},${yOf(0).toFixed(1)} L${xOf(s.points[0].t).toFixed(1)},${yOf(0).toFixed(1)} Z`;
      svg.append(mk('path', { d, fill: s.color, 'fill-opacity': String(op * 0.18), stroke: 'none' }));
      svg.append(mk('path', { d: line, fill: 'none', stroke: s.color, 'stroke-width': overview ? 1 : 2, 'stroke-opacity': String(op) }));
    } else {
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(' ');
      svg.append(mk('path', { d, fill: 'none', stroke: s.color, 'stroke-width': overview ? 1 : 2, 'stroke-opacity': String(op) }));
    }
  });
  if (onBrush) attachBrush(svg, { W, padL: pad.l, padR: pad.r, padT: pad.t, padB: pad.b, H, onSelect: (f0, f1) => onBrush(Math.round(fromMs + f0 * span), Math.round(fromMs + f1 * span)), onClear: () => onBrush(null, null) });
  return el('div', { class: `pv-chart${overview ? ' pv-ov' : ''}` }, svg);
}

// Turns a server timeseries response into chart series (per-agent overlay gets
// palette colours + a legend label).
function pvSeries(resp, overlay) {
  const list = (resp && resp.series) || [];
  return list.map((s, i) => ({
    label: overlay === 'agents' ? (s.agentName || `Agent ${s.agentId}`) : (resp.label || 'value'),
    color: PATHVIZ_PALETTE[i % PATHVIZ_PALETTE.length],
    points: (s.points || []).filter((p) => p.value != null).map((p) => ({ t: Date.parse(p.t), y: p.value })),
  }));
}

// The metric timeline: overview strip (brush) on top, detail chart below, with a
// metric selector, per-agent overlay toggle and an opt-in "Explain Selection".
function pathVizTimeline({ agentId, target, metrics, metric, overlay, fullFromMs, fullToMs, windowFromMs, windowToMs, onWindow }) {
  const root = el('div', { class: 'pv-timeline' });
  const state = { metric, overlay, from: windowFromMs, to: windowToMs };

  const metricSel = el('select', { class: 'small' },
    ...(metrics.length ? metrics : [{ id: 'latency', label: 'Latency' }]).map((m) => el('option', { value: m.id }, m.label)));
  metricSel.value = state.metric;
  const overlayBtn = el('button', { class: 'small ghost', 'aria-pressed': String(overlay === 'agents') }, overlay === 'agents' ? 'Overlay: Agents' : 'Overlay: Off');
  const explainBtn = featureEnabled('assistant') ? el('button', { class: 'small ghost' }, 'Explain selection') : null;
  const controls = el('div', { class: 'pv-controls' },
    el('label', { class: 'inline muted' }, 'Metric ', metricSel),
    overlayBtn, explainBtn);

  const ovHost = el('div', { class: 'pv-ovhost' });
  const detailHost = el('div', { class: 'pv-detailhost' });
  const legendHost = el('div', { class: 'legend pv-legend' });
  const explainHost = el('div', { class: 'pv-explain hidden' });
  root.append(controls, el('div', { class: 'pv-strip-label muted' }, 'Overview — drag to select a window'), ovHost, detailHost, legendHost, explainHost);

  let lastDetail = null;
  const metricDef = () => (metrics.find((m) => m.id === state.metric) || { render: 'line', unit: '' });

  async function loadOverview() {
    ovHost.replaceChildren(el('div', { class: 'pv-skel', style: 'height:60px' }));
    try {
      const resp = await api(`/api/probes/path/timeseries?agentId=${encodeURIComponent(agentId)}&target=${encodeURIComponent(target)}&metric=${state.metric}&overlay=off&from=${new Date(fullFromMs).toISOString()}&to=${new Date(fullToMs).toISOString()}`);
      const series = pvSeries(resp, 'off');
      const chart = pvChart(series, { fromMs: fullFromMs, toMs: fullToMs, render: resp.render, unit: resp.unit, height: 60, overview: true, onBrush: (f, t) => { if (f == null) setWindow(fullFromMs, fullToMs); else setWindow(f, t); } });
      // Shade the current window on the strip.
      const marker = el('div', { class: 'pv-ov-window' });
      const pctFrom = ((state.from - fullFromMs) / Math.max(1, fullToMs - fullFromMs)) * 100;
      const pctTo = ((state.to - fullFromMs) / Math.max(1, fullToMs - fullFromMs)) * 100;
      marker.style.left = `${Math.max(0, pctFrom)}%`;
      marker.style.width = `${Math.max(1, Math.min(100, pctTo) - Math.max(0, pctFrom))}%`;
      ovHost.replaceChildren(el('div', { class: 'pv-ov-wrap' }, chart, marker));
    } catch (e) {
      ovHost.replaceChildren(el('div', { class: 'error' }, `Overview failed: ${e.message}`));
    }
  }

  async function loadDetail() {
    detailHost.replaceChildren(el('div', { class: 'pv-skel', style: 'height:180px' }));
    try {
      const resp = await api(`/api/probes/path/timeseries?agentId=${encodeURIComponent(agentId)}&target=${encodeURIComponent(target)}&metric=${state.metric}&overlay=${state.overlay}&from=${new Date(state.from).toISOString()}&to=${new Date(state.to).toISOString()}`);
      lastDetail = resp;
      const series = pvSeries(resp, state.overlay);
      if (!series.some((s) => s.points.length)) {
        detailHost.replaceChildren(el('div', { class: 'empty' }, 'No data in the selected window.'));
        legendHost.replaceChildren();
        return;
      }
      detailHost.replaceChildren(pvChart(series, { fromMs: state.from, toMs: state.to, render: resp.render, unit: resp.unit, height: 200 }));
      legendHost.replaceChildren(...(state.overlay === 'agents' ? series.map((s) => el('span', {}, el('span', { class: 'dot', style: `background:${s.color}` }), s.label)) : []));
    } catch (e) {
      detailHost.replaceChildren(el('div', { class: 'error' }, `Detail failed: ${e.message}`));
    }
  }

  function setWindow(f, t) {
    state.from = f; state.to = t;
    pathVizWriteParams({ from: new Date(f).toISOString(), to: new Date(t).toISOString() });
    loadOverview(); loadDetail();
    if (typeof onWindow === 'function') onWindow(f, t);
  }

  metricSel.addEventListener('change', () => { state.metric = metricSel.value; pathVizWriteParams({ metric: state.metric }); loadOverview(); loadDetail(); });
  overlayBtn.addEventListener('click', () => {
    state.overlay = state.overlay === 'agents' ? 'off' : 'agents';
    overlayBtn.setAttribute('aria-pressed', String(state.overlay === 'agents'));
    overlayBtn.textContent = state.overlay === 'agents' ? 'Overlay: Agents' : 'Overlay: Off';
    pathVizWriteParams({ overlay: state.overlay === 'agents' ? 'agents' : null });
    loadDetail();
  });
  if (explainBtn) explainBtn.addEventListener('click', async () => {
    explainHost.classList.remove('hidden');
    explainHost.replaceChildren(el('div', { class: 'muted' }, 'Asking the advisor…'));
    const def = metricDef();
    const agg = (lastDetail && lastDetail.series || []).map((s) => {
      const vals = (s.points || []).map((p) => p.value).filter((v) => v != null);
      if (!vals.length) return null;
      const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
      return `${s.agentName || 'agent'}: avg ${avg}${def.unit || ''} (min ${Math.min(...vals)}, max ${Math.max(...vals)}, n=${vals.length})`;
    }).filter(Boolean).join('; ');
    const question = `For the path to ${target} between ${pvFmtTime(state.from)} and ${pvFmtTime(state.to)}, the ${def.label || state.metric} was — ${agg || 'no samples'}. What is the likely cause and what should I check?`;
    try {
      const res = await api('/api/assistant/explain', { method: 'POST', body: { question, hostId: agentId } });
      explainHost.replaceChildren(el('div', { class: 'pv-explain-head' }, 'Advisor'), el('div', {}, res.answer || res.text || 'No answer.'));
    } catch (e) {
      explainHost.replaceChildren(el('div', { class: 'muted' }, e.status === 403 ? 'The AI advisor is disabled. An administrator can enable it under Settings → AI.' : `Advisor error: ${e.message}`));
    }
  });

  loadOverview(); loadDetail();
  return root;
}

// Loading skeleton for the whole component.
function pathVizSkeleton() {
  return el('div', { class: 'pv-loading' },
    el('div', { class: 'pv-skel', style: 'height:110px' }),
    el('div', { class: 'pv-skel', style: 'height:60px;margin-top:10px' }),
    el('div', { class: 'pv-skel', style: 'height:200px;margin-top:6px' }));
}

// The shared component. Returns a container node; fetches the path graph + the
// metric catalogue, wires the brush window to a graph refetch, and node clicks to
// the selection callback.
async function pathVisualization(opts = {}) {
  const { sourceId, targetId, probeId, probeType, timeRange, onSelectionChange } = opts;
  const root = el('div', { class: 'pathviz' });
  if (sourceId == null || !targetId) {
    root.append(el('div', { class: 'empty' }, 'Select a source agent and a destination to see its path.'));
    return root;
  }
  root.append(pathVizSkeleton());

  const urlp = pathVizReadParams();
  const nowMs = Date.now();
  const fullFromMs = (timeRange && timeRange.fromMs) || (nowMs - 7 * 24 * 3600 * 1000);
  const fullToMs = (timeRange && timeRange.toMs) || nowMs;
  const windowFromMs = urlp.from ? Date.parse(urlp.from) : ((timeRange && timeRange.fromMs) || (nowMs - 24 * 3600 * 1000));
  const windowToMs = urlp.to ? Date.parse(urlp.to) : fullToMs;
  const metric = urlp.metric || opts.metric || 'latency';
  const overlay = urlp.overlay === 'agents' ? 'agents' : (opts.overlay || 'off');

  const graphHost = el('div', { class: 'pv-graphhost' });
  // The graph endpoint filters by trace type: an ICMP path and a TCP path to the
  // same host are two different measurements and must not be averaged together.
  const probeQ = (probeId != null ? `&probeId=${encodeURIComponent(probeId)}` : '')
    + (probeType ? `&probeType=${encodeURIComponent(probeType)}` : '');

  async function loadGraph(fromMs, toMs) {
    graphHost.replaceChildren(el('div', { class: 'pv-skel', style: 'height:110px' }));
    try {
      const graph = await api(`/api/probes/path?agentId=${encodeURIComponent(sourceId)}&target=${encodeURIComponent(targetId)}${probeQ}&from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}`);
      if (!graph || (graph.nodes || []).length <= 1) {
        graphHost.replaceChildren(el('div', { class: 'empty' }, `No path data for ${targetId} in this window. Run a ${probeType === 'tcptraceroute' ? 'TCP traceroute' : 'traceroute'} from this agent to populate it.`));
        return;
      }
      const onNodeClick = (n) => {
        if (typeof onSelectionChange === 'function') onSelectionChange({ hop: n.hop, ip: n.ip, node: n });
        // Scroll the timeline into view — the click "focuses" this hop's series.
        const tl = root.querySelector('.pv-timeline');
        if (tl) tl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        graphHost.querySelectorAll('.pg-node.selected').forEach((g) => g.classList.remove('selected'));
      };
      graphHost.replaceChildren(pathGraph(graph, { onNodeClick }));
    } catch (e) {
      graphHost.replaceChildren(el('div', { class: 'error' }, `Path graph failed: ${e.message}`));
    }
  }

  let metricsList = [];
  try { metricsList = (await api('/api/probes/path/metrics')).metrics || []; } catch { metricsList = []; }

  await loadGraph(windowFromMs, windowToMs);
  const timeline = pathVizTimeline({
    agentId: sourceId, target: targetId, metrics: metricsList, metric, overlay,
    fullFromMs, fullToMs, windowFromMs, windowToMs,
    onWindow: (f, t) => loadGraph(f, t), // brush is the single source of truth
  });

  // "Test MTU on this path" — the shortest route from "this path looks wrong"
  // to the measurement that says whether it is. It starts the probe against the
  // SAME target the path is drawn for, from the same agent, so the answer lands
  // beside the picture that raised the question. Operator+ only: a viewer's
  // request would come back 403, so the button is not offered to one.
  if (canWrite()) root.replaceChildren(graphHost, timeline, mtuShortcut(sourceId, targetId));
  else root.replaceChildren(graphHost, timeline);
  return root;
}

// A path target is stored as `host:port` when the path was traced with TCP, and
// the MTU probe takes a host. Stripping a trailing `:<digits>` unconditionally
// is wrong: `2001:db8::1` ends in `:1` and would become `2001:db8:`. So a port
// is only recognised in the two forms that unambiguously carry one — a
// bracketed IPv6 literal, and a name or IPv4 address with exactly one colon.
function hostOfPathTarget(target) {
  const s = String(target == null ? '' : target).trim();
  const bracketed = s.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  if (s.split(':').length === 2 && /:\d+$/.test(s)) return s.slice(0, s.lastIndexOf(':'));
  return s;
}

// The shortcut button plus its own status line. Kept next to pathVisualization
// because it only makes sense there — everywhere else the Probes view's form is
// the right way in.
function mtuShortcut(agentId, target) {
  const status = el('span', { class: 'muted small' });
  const btn = el('button', { class: 'small ghost', onclick: async () => {
    btn.disabled = true;
    status.className = 'muted small';
    status.textContent = '…';
    try {
      await api(`/agents/${encodeURIComponent(agentId)}/probe`, {
        method: 'POST',
        body: { type: 'path_mtu', host: hostOfPathTarget(target), per_hop: true },
      });
      status.textContent = 'Sent — open Probes & Tests for the result.';
    } catch (e) {
      status.className = 'error small';
      status.textContent = e.status === 409 ? 'The agent is not connected right now.' : errText(e);
    } finally { btn.disabled = false; }
  } }, t('probe.mtu.testThisPath'));
  return el('div', { class: 'pv-actions' }, btn, status);
}

// Detail node for one probe result: a path map for either trace type (fetches +
// aggregates that type's recent runs into a hop graph — scoped by probeType, so an
// ICMP path and a TCP path to the same host stay apart) or RTT history (the
// per-agent time series).
// Path-MTU detail: the verdict first, then the per-hop bar chart.
//
// The verdict leads because it is the answer — an operator who reads only the
// top line should still learn whether this is a fault. The bars exist to show
// WHERE, which a column of numbers does badly: an MTU that steps down at one
// hop and stays there is a shape, and a shape is read faster than it is parsed.
//
// Bars are scaled against the largest MTU measured anywhere on the path, not
// against 1500, so a jumbo-frame path does not render as four identical
// full-width bars.
function mtuDetail(r) {
  const m = r.mtu || {};
  const hops = Array.isArray(r.hops) ? r.hops : [];
  const pathMtu = m.pathMtu ?? null;
  const dropAt = m.mtuDropAtHop ?? null;
  const dropHop = dropAt != null ? hops.find((h) => h.hop === dropAt) : null;
  const where = dropHop && dropHop.ip ? `hop ${dropAt} (${dropHop.ip})` : (dropAt != null ? `hop ${dropAt}` : '—');
  const mss = m.recommendedMss ?? null;

  // The headline. Four mutually exclusive states, in the order of how much they
  // should worry somebody.
  //
  // "Not measured" comes first because it is not a verdict at all. Without it a
  // run that never got an answer fell through to the good branch and announced
  // "No MTU restriction found" over a path nothing had been learned about —
  // the most confident possible way to say nothing.
  const verdict = pathMtu == null
    ? el('div', { class: 'mtu-verdict unknown' },
      el('h4', {}, t('probe.mtu.unmeasuredTitle')),
      el('p', {}, r.detail ? t('probe.mtu.unmeasuredReason', { reason: r.detail }) : t('probe.mtu.unmeasuredBody')))
    : m.blackholeDetected
    ? el('div', { class: 'mtu-verdict bad' },
      el('h4', {}, t('probe.mtu.blackholeTitle')),
      el('p', {}, t('probe.mtu.blackholeBody', { mtu: pathMtu ?? '?', where })),
      mss != null ? el('p', { class: 'mtu-fix' }, t('probe.mtu.blackholeFix', { mss })) : null)
    : (m.icmpFragNeededSeen && dropAt != null)
      ? el('div', { class: 'mtu-verdict warn' },
        el('h4', {}, t('probe.mtu.reducedTitle')),
        el('p', {}, t('probe.mtu.reducedBody', { mtu: pathMtu ?? '?', where, mss: mss ?? '?' })))
      : el('div', { class: 'mtu-verdict good' },
        el('h4', {}, t('probe.mtu.okTitle')),
        el('p', {}, t('probe.mtu.okBody', { mtu: pathMtu ?? '?' })));

  const stat = (label, value) => el('div', { class: 'mtu-stat' },
    el('span', { class: 'k' }, label), el('span', { class: 'v' }, value));
  const stats = el('div', { class: 'mtu-stats' },
    stat(t('probe.mtu.pathMtu'), pathMtu != null ? `${pathMtu} B` : '–'),
    stat(t('probe.mtu.recommendedMss'), mss != null ? `${mss} B` : '–'),
    stat(t('probe.mtu.observedMss'), m.mssSupported
      ? (m.mssObserved != null ? `${m.mssObserved} B` : '–')
      : el('span', { class: 'muted', title: t('probe.mtu.noMss') }, '–')),
    stat(dropAt != null ? t('probe.mtu.dropAt', { hop: dropAt }) : t('probe.mtu.noDrop'), ''));

  // An MSS above what the path carries is its own warning: the path can be
  // entirely well-behaved and the sender still be building segments that cannot
  // arrive whole.
  const clamp = (m.mssSupported && m.mssObserved != null && mss != null && m.mssObserved > mss)
    ? el('div', { class: 'mtu-verdict warn' }, el('p', {}, t('probe.mtu.clampWarning', { observed: m.mssObserved, recommended: mss })))
    : null;

  const scale = hops.reduce((max, h) => Math.max(max, h.maxMtu || 0), pathMtu || 1) || 1;
  const hopRow = (h) => {
    const measured = h.maxMtu != null;
    const pct = measured ? Math.max(2, Math.round((h.maxMtu / scale) * 100)) : 0;
    const cls = h.status === 'blackhole' ? 'bad' : h.status === 'reduced' ? 'warn'
      : h.status === 'ok' ? 'good' : 'unknown';
    return el('tr', { class: h.hop === dropAt ? 'mtu-drop' : null },
      el('td', { class: 'muted' }, `#${h.hop}`),
      el('td', { class: 'mono' }, h.ip || '* * *'),
      el('td', { class: 'mtu-bar-cell' },
        el('div', { class: 'mtu-bar' }, el('div', { class: `mtu-bar-fill ${cls}`, style: `width:${pct}%` })),
        // The hop the path narrows at is marked in text as well as colour —
        // colour alone is not a label.
        h.hop === dropAt ? el('span', { class: 'mtu-drop-marker' }, '▼') : null),
      el('td', { class: 'num' }, measured ? `${h.maxMtu} B` : '–'),
      el('td', {}, el('span', { class: `badge mtu-${cls}` }, t(`probe.mtu.status.${h.status || 'skipped'}`))));
  };

  const table = el('table', { class: 'probe-hops mtu-hops' },
    el('thead', {}, el('tr', {}, ...[t('probe.mtu.hop'), 'IP', '', t('probe.mtu.maxMtu'), t('probe.mtu.status')].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...(hops.length ? hops.map(hopRow)
      : [el('tr', {}, el('td', { class: 'muted', colspan: '5' }, t('probe.mtu.noHops')))])));

  return el('details', { class: 'sec', open: true },
    el('summary', {}, t('probe.mtu.title', { target: r.target })),
    verdict, clamp, stats, table);
}


// The certificate a port presented, read back in the order an operator needs
// it: what is wrong first, what it is second, and the identifying detail last.
// The four faults are kept apart here exactly as they are stored, because they
// have four different fixes — renew, reissue, install the intermediate, or
// point the client at the right name.
function tlsDetail(r) {
  // `c` rather than `t`: the translation function is called `t` in this file,
  // and shadowing it here would break every label in the table.
  const c = r.tls || {};
  const rows = [];
  const kv = (label, value, cls = null) => rows.push(el('tr', {},
    el('td', { class: 'muted' }, label),
    el('td', cls ? { class: cls } : {}, value)));

  const days = c.expiryDays;
  if (days != null) {
    kv(t('probe.tls.expires'),
      days <= 0 ? t('probe.tls.expiredAgo', { days: String(Math.abs(Math.round(days))) })
        : `${t('probe.tls.expiresIn', { days: String(Math.round(days)) })}${c.validTo ? ` · ${fmtDate(c.validTo)}` : ''}`,
      days <= 0 ? 'error' : (days <= 30 ? 'warn' : null));
  }
  kv(t('probe.tls.chain'),
    c.authorized ? t('probe.tls.chainOk')
      : t('probe.tls.chainBad', { reason: c.selfSigned ? t('probe.tls.selfSigned') : (c.authorizationError || '—') }),
    c.authorized ? null : 'error');
  kv(t('probe.tls.name'),
    c.hostnameMatches === true ? t('probe.tls.nameOk')
      : c.hostnameMatches === false ? t('probe.tls.nameBad') : t('probe.tls.nameUnchecked'),
    c.hostnameMatches === false ? 'error' : null);
  if (c.subject) kv(t('probe.tls.subject'), c.subject);
  if (c.issuer) kv(t('probe.tls.issuer'), c.issuer);
  if (c.protocol) kv(t('probe.tls.protocol'), c.protocol);
  if (c.cipher) kv(t('probe.tls.cipher'), c.cipher);
  if (c.chainLength != null) kv(t('probe.tls.links'), String(c.chainLength));
  if (c.altNames && c.altNames.length) {
    kv(t('probe.tls.altNames'), el('span', { class: 'mono small' }, c.altNames.join(', ')));
  }
  if (c.serialNumber) kv(t('probe.tls.serial'), el('span', { class: 'mono small' }, c.serialNumber));
  if (c.fingerprint256) kv(t('probe.tls.fingerprint'), el('span', { class: 'mono small' }, c.fingerprint256));

  return el('details', { class: 'sec', open: true },
    el('summary', {}, t('probe.tls.title', { target: r.target })),
    el('table', { class: 'kv tls-detail' }, el('tbody', {}, ...rows)));
}

// The reverse lookup, and the confirmation that is the actual question.
function rdnsDetail(r) {
  const d = r.rdns || {};
  const names = d.ptrNames || [];
  const rows = [];
  const kv = (label, value, cls = null) => rows.push(el('tr', {},
    el('td', { class: 'muted' }, label),
    el('td', cls ? { class: cls } : {}, value)));

  if (d.address) kv(t('probe.rdns.address'), el('span', { class: 'mono' }, d.address));
  kv(t('probe.rdns.ptr'),
    names.length ? el('span', { class: 'mono' }, names.join(', ')) : t('probe.rdns.none'),
    names.length ? null : 'error');
  if (names.length) {
    kv(t('probe.rdns.confirmed'),
      d.forwardConfirmed ? t('probe.rdns.confirmedYes') : t('probe.rdns.confirmedNo'),
      d.forwardConfirmed ? null : 'error');
  }
  return el('details', { class: 'sec', open: true },
    el('summary', {}, t('probe.rdns.title', { target: r.target })),
    el('table', { class: 'kv' }, el('tbody', {}, ...rows)),
    el('p', { class: 'muted small' }, t('probe.rdns.why')));
}

async function probeDetail(r, agentId) {
  if (r.type === 'path_mtu') return mtuDetail(r);
  // Both of these ARE their result — there is no history worth charting for a
  // certificate's subject or a PTR name, and the numbers that do move (days to
  // expiry) are read in the row itself.
  if (r.type === 'tls') return tlsDetail(r);
  if (r.type === 'rdns') return rdnsDetail(r);
  if (r.type === 'traceroute' || r.type === 'tcptraceroute') {
    const hops = r.hops || [];
    const hopRow = (h) => el('tr', {},
      el('td', { class: 'muted' }, `#${h.hop}`),
      el('td', { class: 'mono' }, h.ip || '* * *'),
      el('td', { class: 'num' }, h.rttMs != null ? `${h.rttMs} ms` : '–'),
      el('td', { class: 'num' }, h.lossPct != null ? `${h.lossPct}%` : '–'),
      el('td', { class: 'num' }, h.jitterMs != null ? `${h.jitterMs} ms` : '–'));
    // Full-width shared Path Visualization (path graph + brushable metric timeline)
    // under the probe detail header.
    const viz = await pathVisualization({ sourceId: agentId, targetId: r.target, probeType: r.type });
    // Say WHICH probe drew this path — the whole point of having two is that they
    // can disagree, so a hop table with no attribution is a trap.
    const how = r.type === 'tcptraceroute' ? t('probe.traceTcp') : t('probe.traceIcmp');
    return el('details', { class: 'sec', open: true }, el('summary', {}, `Path to ${r.target} `, el('span', { class: 'muted' }, `· ${t('probe.tracePath')} ${how} · loss · latency · jitter per hop`)),
      viz,
      el('table', { class: 'probe-hops' },
        el('thead', {}, el('tr', {}, ...['Hop', 'IP', 'RTT', 'Loss', 'Jitter'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...(hops.length ? hops.map(hopRow) : [el('tr', {}, el('td', { class: 'muted', colspan: '5' }, 'No hops.'))]))));
  }
  let data;
  try { data = await api(`/api/probes?agentId=${encodeURIComponent(agentId)}&type=${r.type}`); } catch (e) { return el('div', { class: 'error' }, e.message); }
  const pts = (data.results || []).filter((x) => x.target === r.target && x.rttMs != null).map((x) => ({ t: new Date(x.ts).getTime(), y: x.rttMs }));
  const fromMs = pts.length ? pts[0].t : Date.now() - 3600000;
  const toMs = pts.length ? pts[pts.length - 1].t : Date.now();
  // #6 normal-range band (metric vs. its own median±MAD) + #7 markers: probe
  // failures (ok→fail flips) and recent findings for this agent.
  const band = robustBand(pts);
  const markers = [];
  for (const x of (data.results || []).filter((x) => x.target === r.target)) {
    if (x.ok === false && x.ts) markers.push({ t: new Date(x.ts).getTime(), kind: 'probe', label: `Probe error${x.detail ? ': ' + x.detail : ''}` });
  }
  try { const fs = await api(`/api/findings?hostId=${encodeURIComponent(agentId)}&since=${new Date(fromMs).toISOString()}`); markers.push(...findingMarkers(fs)); } catch { /* findings optional */ }
  // pageload/transaction graph their total time over time and add a step/element
  // waterfall for the selected run; everything else is the RTT-over-time chart.
  const isPageload = r.type === 'pageload';
  const isTx = r.type === 'transaction';
  const metricLabel = isPageload ? 'Load time (ms)' : isTx ? 'Total time (ms)' : 'RTT (ms)';
  const histTitle = isPageload ? 'Load-time history' : isTx ? 'Transaction-time history' : 'RTT history';
  const chart = el('details', { class: 'sec', open: true }, el('summary', {}, `${histTitle} — ${r.type} → ${r.target} `, el('span', { class: 'muted' }, '· band = normal range (median±MAD)')),
    el('div', { class: 'overview-chart' }, pts.length ? historyChart([{ id: 'rtt', label: metricLabel, color: '#06b6d4', points: pts }], { fromMs, toMs, band, markers }) : el('div', { class: 'empty' }, 'No history yet — run a few measurements.')));
  if (!isPageload && !isTx) return chart;
  return el('div', {},
    el('details', { class: 'sec', open: true }, el('summary', {}, `${isTx ? 'Steps' : 'Page elements'} — ${r.target} `, el('span', { class: 'muted' }, isTx ? '· per-step status · size · time' : '· per-resource status · size · load time')), pageloadWaterfall(r)),
    chart);
}

// pageload/transaction waterfall: one row per fetched resource / step, with a bar
// scaled to the slowest one so the long poles stand out at a glance.
function pageloadWaterfall(r) {
  const els = (r && r.elements) || [];
  if (!els.length) return el('div', { class: 'muted' }, 'No breakdown for this run (older agent, or it failed before the first step).');
  const maxMs = Math.max(1, ...els.map((e) => e.ms || 0));
  const row = (e) => el('tr', {},
    el('td', { class: 'muted' }, e.kind || '–'),
    el('td', { class: 'mono small pl-url', title: e.url || '' }, e.url || '–'),
    el('td', {}, e.status != null ? el('span', { class: `badge ${e.status < 400 ? 'online' : 'offline'}` }, String(e.status)) : '–'),
    el('td', { class: 'num' }, e.bytes != null ? fmtBytes(e.bytes) : '–'),
    el('td', { class: 'num' }, e.ms != null ? `${e.ms} ms` : '–'),
    el('td', {}, el('div', { class: 'pl-bar', style: `width:${Math.max(2, Math.round(((e.ms || 0) / maxMs) * 100))}%` })));
  return el('table', { class: 'probe-hops pl-waterfall' },
    el('thead', {}, el('tr', {}, ...['Element', 'URL', 'Status', 'Size', 'Time', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...els.map(row)));
}

// Force-directed layout for the topology diagram (Fruchterman-Reingold): nodes
// repel each other, edges pull their endpoints together, cooled over a fixed
// number of iterations. Pure geometry — no physics/graph library. Deterministic
// (initial placement is index-based, not random) so the diagram doesn't jump
// around on every refresh. Fine for the capped node/edge counts this feeds on.
function topoForceLayout(nodes, edges, width, height) {
  const pos = new Map();
  const n = Math.max(1, nodes.length);
  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    const r = Math.min(width, height) / 2.6;
    pos.set(node.id, { x: width / 2 + r * Math.cos(angle), y: height / 2 + r * Math.sin(angle) });
  });
  if (nodes.length <= 1) return pos;

  const k = Math.sqrt((width * height) / n); // ideal edge length
  const disp = new Map();
  let temp = width / 10;
  const iterations = 200;
  for (let iter = 0; iter < iterations; iter += 1) {
    nodes.forEach((node) => disp.set(node.id, { x: 0, y: 0 }));
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const pa = pos.get(nodes[i].id), pb = pos.get(nodes[j].id);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (k * k) / dist;
        dx = (dx / dist) * force; dy = (dy / dist) * force;
        const da = disp.get(nodes[i].id); da.x += dx; da.y += dy;
        const db = disp.get(nodes[j].id); db.x -= dx; db.y -= dy;
      }
    }
    edges.forEach((e) => {
      const pa = pos.get(e.from), pb = pos.get(e.to);
      if (!pa || !pb) return;
      let dx = pa.x - pb.x, dy = pa.y - pb.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      dx = (dx / dist) * force; dy = (dy / dist) * force;
      const da = disp.get(e.from); da.x -= dx; da.y -= dy;
      const db = disp.get(e.to); db.x += dx; db.y += dy;
    });
    nodes.forEach((node) => {
      const d = disp.get(node.id);
      const dist = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      const p = pos.get(node.id);
      // Bottom/side margins leave room for the node's radius and its text
      // label (drawn below the circle) so neither gets clipped by the SVG edge.
      p.x = Math.min(width - 30, Math.max(30, p.x + (d.x / dist) * Math.min(dist, temp)));
      p.y = Math.min(height - 46, Math.max(24, p.y + (d.y / dist) * Math.min(dist, temp)));
    });
    temp *= 0.96;
  }
  return pos;
}

// Renders the topology diagram: nodes sized by traffic volume and coloured by
// kind (internal/external), edges weighted by bytes. Click a node to highlight
// its neighbourhood and open a detail panel (reuses the pathGraph pg-panel
// styling) with Ping/Vis rute actions, same as the table rows below it.
function topoGraphSvg(nodes, edges, { label, kindBadge, actionBtns } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) if (v != null) e.setAttribute(a, v);
    for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const W = 760, H = 480;
  const pos = topoForceLayout(nodes, edges, W, H);

  const maxBytes = Math.max(1, ...nodes.map((n) => n.bytes || 0));
  const radiusOf = (n) => 6 + Math.round((Math.log2(1 + (n.bytes || 0)) / Math.log2(1 + maxBytes)) * 16);
  const maxEdgeBytes = Math.max(1, ...edges.map((e) => e.bytes || 0));
  const widthOf = (e) => 1 + (Math.log2(1 + (e.bytes || 0)) / Math.log2(1 + maxEdgeBytes)) * 5;

  const panel = el('div', { class: 'pg-panel' }, el('div', { class: 'muted' }, 'Click a host to see its details and run a live check.'));
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Topology diagram' });
  const wrap = el('div', { class: 'topo-graph' }, svg, panel);

  const nodeGroups = new Map();
  const edgeLines = [];
  const neighbours = new Map(); // id -> Set of connected node ids
  nodes.forEach((n) => neighbours.set(n.id, new Set()));
  edges.forEach((e) => {
    if (neighbours.has(e.from)) neighbours.get(e.from).add(e.to);
    if (neighbours.has(e.to)) neighbours.get(e.to).add(e.from);
  });

  function clearSelection() {
    wrap.classList.remove('has-selection');
    nodeGroups.forEach((g) => g.classList.remove('active', 'selected'));
    edgeLines.forEach((l) => l.el.classList.remove('active'));
    panel.replaceChildren(el('div', { class: 'muted' }, 'Click a host to see its details and run a live check.'));
  }

  function selectNode(n) {
    wrap.classList.add('has-selection');
    const near = neighbours.get(n.id) || new Set();
    nodeGroups.forEach((g, id) => g.classList.toggle('active', id === n.id || near.has(id)));
    nodeGroups.get(n.id).classList.add('selected');
    edgeLines.forEach((l) => l.el.classList.toggle('active', l.from === n.id || l.to === n.id));

    const rows = [
      el('div', { class: 'pg-stat' }, el('span', { class: 'k' }, 'Peers'), el('span', { class: 'v' }, String(n.degree))),
      el('div', { class: 'pg-stat' }, el('span', { class: 'k' }, 'In'), el('span', { class: 'v' }, fmtBytes(n.bytesIn))),
      el('div', { class: 'pg-stat' }, el('span', { class: 'k' }, 'Out'), el('span', { class: 'v' }, fmtBytes(n.bytesOut))),
    ];
    const peerInfo = label(n.id) === n.id ? null : el('span', { class: 'mono' }, label(n.id));
    panel.replaceChildren(
      ...[el('div', { class: 'pg-panel-head' }, kindBadge(n.kind), el('strong', {}, n.id), peerInfo),
        el('div', { class: 'pg-stats' }, ...rows),
        actionBtns ? actionBtns(n.id) : null].filter(Boolean));
  }

  edges.forEach((e) => {
    const pa = pos.get(e.from), pb = pos.get(e.to);
    if (!pa || !pb) return;
    const line = mk('line', { class: 'topo-link', x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, 'stroke-width': widthOf(e).toFixed(1) });
    svg.append(line);
    edgeLines.push({ from: e.from, to: e.to, el: line });
  });

  nodes.forEach((n) => {
    const p = pos.get(n.id);
    if (!p) return;
    const r = radiusOf(n);
    const short = n.kind === 'external' && n.asnName ? n.asnName : n.id;
    const g = mk('g', { class: `topo-node ${n.kind}`, tabindex: '0', role: 'button', 'aria-label': `${n.id} ${n.kind}` },
      mk('circle', { cx: p.x, cy: p.y, r }),
      mk('text', { x: p.x, y: p.y + r + 12, 'text-anchor': 'middle' }, short.length > 16 ? `${short.slice(0, 15)}…` : short),
      mk('title', {}, `${label(n.id)}\n${n.kind} · ${fmtBytes(n.bytes)} · ${n.degree} peer${n.degree === 1 ? '' : 's'}`));
    g.addEventListener('click', () => selectNode(n));
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(n); } });
    svg.append(g);
    nodeGroups.set(n.id, g);
  });

  svg.addEventListener('click', (ev) => { if (ev.target === svg) clearSelection(); });

  const legend = el('div', { class: 'pg-legend' },
    el('span', { class: 'lg' }, el('span', { class: 'pg-dot ok' }), 'Internal host'),
    el('span', { class: 'lg' }, el('span', { class: 'pg-dot warn' }), 'External peer'),
    el('span', { class: 'lg muted' }, 'Circle size = traffic · line width = bytes between hosts'));

  return el('div', {}, el('div', { class: 'pg-head' }, legend), wrap);
}

// Navigate to the Topology map in Layers mode focused on one host — the map
// reads ?layer/?focus from the URL on load, opens straight into Layers and (for
// operator+) previews that host's blast radius. Shared by the event view's
// "show on map" links.
function openTopologyFocus(hostId) {
  try {
    const q = new URLSearchParams(window.location.search || '');
    q.set('layer', 'both');
    q.set('focus', String(hostId));
    window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
  } catch { /* URL API off */ }
  currentView = 'topology';
  render();
}

// Reusable blast-radius result panel: the two tiers (directly-isolated L2 +
// dependency-affected), each host carrying the path that justifies it. Shared by
// the topology what-if preview and the event view. `nameFor` resolves a host
// id → label; `onFocusHost` (optional) makes each host a link (e.g. into the map
// focused on it).
function blastRadiusPanel(blast, { nameFor, onFocusHost } = {}) {
  const name = nameFor || ((hid) => String(hid));
  const iso = (blast && blast.directly_isolated) || [];
  const aff = (blast && blast.dependency_affected) || [];
  const l2Path = (p) => (Array.isArray(p) ? p : []).map(name).join(' → ');
  const depPath = (p) => (Array.isArray(p) ? p : []).map((s) => (s && typeof s === 'object' ? name(s.hostId) + (s.viaPort ? `:${s.viaPort}` : '') : name(s))).join(' → ');
  const hostCell = (hid) => (onFocusHost
    ? el('button', { class: 'linklike mono', title: 'Show on the topology map', onclick: () => onFocusHost(hid) }, name(hid))
    : el('span', { class: 'mono' }, name(hid)));
  const tier = (title, cls, list, pathFn) => el('div', { class: `blast-tier ${cls}` },
    el('div', { class: 'blast-tier-head' }, el('strong', {}, title), el('span', { class: 'badge' }, String(list.length))),
    list.length
      ? el('ul', { class: 'blast-list' }, ...list.slice(0, 100).map((x) => el('li', {}, hostCell(x.hostId), el('span', { class: 'muted small' }, ' — ', pathFn(x.path)))))
      : el('div', { class: 'muted small' }, 'None'));
  return el('div', { class: 'blast-panel' },
    el('div', { class: 'blast-head' }, el('strong', {}, `If ${name(blast.failingNode)} fails`),
      TopologyGraph.blastIsEmpty(blast) ? el('span', { class: 'muted small' }, ' — nothing downstream is isolated') : null),
    tier('Directly isolated (L2)', 'iso', iso, l2Path),
    tier('Dependency-affected', 'aff', aff, depPath));
}

// Renders the UNIFIED resilience graph (the "Layers" mode) from GET
// /api/topology/graph: monitored hosts as nodes, physical LLDP adjacencies
// (l2_link) as SOLID lines and observed TCP dependencies (service_dep) as DASHED,
// arrowed lines weighted by byte volume. Distinct from the flow-derived diagram
// above (external peers). Layer selection + the view-model are computed by the
// pure window.TopologyGraph module; this only lays out and draws. Returns helpers
// ({ setHighlight, neighbourhood, clear, nodeEls }) so blast-radius/what-if mode
// can dim + emphasise nodes without a redraw.
function topoLayersSvg(vm, { onNodeClick, focusId } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) if (v != null) e.setAttribute(a, v);
    for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const W = 760, H = 480;
  const layoutEdges = vm.edges.map((e) => ({ from: e.source, to: e.target }));
  const pos = topoForceLayout(vm.nodes, layoutEdges, W, H);
  const maxDeg = Math.max(1, ...vm.nodes.map((n) => n.degree || 0));
  const radiusOf = (n) => 6 + Math.round((Math.log2(1 + (n.degree || 0)) / Math.log2(1 + maxDeg)) * 12);

  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Topology layers' });
  svg.append(mk('defs', {}, mk('marker', { id: 'topo-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' }, mk('path', { d: 'M0 0 L10 5 L0 10 z' }))));

  const neighbours = new Map();
  vm.nodes.forEach((n) => neighbours.set(n.id, new Set()));
  const edgeEls = [];
  vm.edges.forEach((e) => {
    const pa = pos.get(e.source), pb = pos.get(e.target);
    if (!pa || !pb) return;
    if (neighbours.has(e.source)) neighbours.get(e.source).add(e.target);
    if (neighbours.has(e.target)) neighbours.get(e.target).add(e.source);
    const style = TopologyGraph.edgeStyle(e);
    const w = TopologyGraph.edgeWeight(e, vm.maxBytes, { min: 1, max: 6, l2: 1.75 });
    const line = mk('line', {
      class: `topo-edge ${style.cls}`, x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y,
      'stroke-width': w.toFixed(1), 'marker-end': style.directed ? 'url(#topo-arrow)' : null,
    });
    line.append(mk('title', {}, style.cls === 'dep'
      ? `${e.source} → ${e.target} :${e.dstPort} · ${fmtBytes(e.bytes)}`
      : `${e.source} — ${e.target} · physical link`));
    svg.append(line);
    edgeEls.push({ from: e.source, to: e.target, cls: style.cls, el: line });
  });

  const nodeEls = new Map();
  vm.nodes.forEach((n) => {
    const p = pos.get(n.id);
    if (!p) return;
    const r = radiusOf(n);
    const short = String(n.label);
    const g = mk('g', { class: `topo-node${focusId === n.id ? ' focus' : ''}`, tabindex: '0', role: 'button', 'aria-label': short },
      mk('circle', { cx: p.x, cy: p.y, r }),
      mk('text', { x: p.x, y: p.y + r + 12, 'text-anchor': 'middle' }, short.length > 16 ? `${short.slice(0, 15)}…` : short),
      mk('title', {}, `${short}\n${n.degree} link${n.degree === 1 ? '' : 's'}`));
    if (onNodeClick) {
      g.addEventListener('click', () => onNodeClick(n.id));
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onNodeClick(n.id); } });
    }
    svg.append(g);
    nodeEls.set(n.id, g);
  });

  const wrap = el('div', { class: 'topo-graph topo-layers' }, svg);

  function clear() {
    wrap.classList.remove('has-selection');
    nodeEls.forEach((g) => g.classList.remove('active', 'selected', 'iso', 'aff', 'dim'));
    edgeEls.forEach((x) => x.el.classList.remove('active', 'dim'));
  }
  // Local neighbourhood highlight (default click behaviour): emphasise the node,
  // its direct neighbours and their edges; dim the rest.
  function neighbourhood(id) {
    const near = neighbours.get(id) || new Set();
    wrap.classList.add('has-selection');
    nodeEls.forEach((g, nid) => g.classList.toggle('active', nid === id || near.has(nid)));
    if (nodeEls.get(id)) nodeEls.get(id).classList.add('selected');
    edgeEls.forEach((x) => x.el.classList.toggle('active', x.from === id || x.to === id));
  }
  // Blast-radius highlight (what-if / event): { focus, isolated:Set, affected:Set }.
  function setHighlight(sets) {
    if (!sets) { clear(); return; }
    wrap.classList.add('has-selection');
    nodeEls.forEach((g, id) => {
      const iso = sets.isolated && sets.isolated.has(id);
      const aff = sets.affected && sets.affected.has(id);
      const focus = id === sets.focus;
      g.classList.toggle('focus', focus);
      g.classList.toggle('iso', !!iso && !focus);
      g.classList.toggle('aff', !!aff && !focus && !iso);
      g.classList.toggle('dim', !focus && !iso && !aff);
    });
    edgeEls.forEach((x) => {
      const inSet = (nid) => nid === sets.focus || (sets.isolated && sets.isolated.has(nid)) || (sets.affected && sets.affected.has(nid));
      const hot = inSet(x.from) && inSet(x.to);
      x.el.classList.toggle('active', hot);
      x.el.classList.toggle('dim', !hot);
    });
  }

  return { wrap, svg, nodeEls, edgeEls, neighbours, clear, neighbourhood, setHighlight };
}

// Flow-derived dependency / topology map — who-talks-to-whom built from the
// ingested 5-tuple flows. Internal (RFC1918) hosts vs external peers (with ASN/
// country). Read-only: a summary + the heaviest dependencies and busiest hosts.
// Site filter scopes the graph to one location; window selector adjusts depth.
// Action buttons (Ping / Vis rute) let an operator run live diagnostics against
// any observed host directly from this view, using a selectable online agent.
// ---- Topology (MIGRATED — see public/views/topology.js) ---------------------
// The three drawing primitives and the probe modals stay here: topoGraphSvg and
// topoLayersSvg are their own components, the Leaflet map carries the reader's
// pan and zoom, and the path visualisation is shared with Probes & Tests.
const EXT_COLOR = '#f59e0b'; // external peer (matches the diagram's amber)
const SITE_COLOR = '#38bdf8'; // internal site anchor

let topologyPage = null;
const topologyPageState = {};

// Send a probe and poll until a result newer than sentAt appears (or timeout).
async function topoProbeAndWait(agentId, type, host, maxAttempts, intervalMs) {
  const sentAt = Date.now();
  await api(`/agents/${agentId}/probe`, { method: 'POST', body: { type, host } });
  for (let i = 0; i < maxAttempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, intervalMs));
    // eslint-disable-next-line no-await-in-loop
    const d = await api(`/api/probes/latest?agentId=${encodeURIComponent(agentId)}`);
    const r = (d.results || []).find(
      (x) => x.type === type && x.target === host && new Date(x.ts).getTime() > sentAt - 500);
    if (r) return r;
  }
  throw new Error(t('topo.probe.noResult'));
}

// Ping / Show route / Path, each in the shared modal. Ping is a summary; the
// other two open the full panel the Probes screen uses.
async function topoProbeModal(kind, host, agentId) {
  const card = $('#modal-card');
  const title = { ping: t('topo.ping'), route: t('topo.route'), path: t('topo.path') }[kind];
  const heading = `${title} → ${host}`;
  const status = el('p', { class: 'muted' }, t('topo.probe.working'));
  const close = () => el('div', { class: 'form-actions' },
    el('button', { class: 'ghost', onclick: closeModal }, t('common.close')));
  card.replaceChildren(el('h3', {}, heading), status, close());
  $('#modal').classList.remove('hidden');
  if (kind !== 'ping') $('#modal-card').classList.add('wide');
  try {
    if (kind === 'ping') {
      const r = await topoProbeAndWait(agentId, 'ping', host, 8, 2500);
      status.className = r.ok ? '' : 'error';
      status.textContent = r.ok
        ? t('topo.probe.ping', { rtt: r.rttMs, loss: r.lossPct == null ? 0 : r.lossPct, jitter: r.jitterMs == null ? '–' : `${r.jitterMs} ms` })
        : t('topo.probe.failed', { detail: r.detail || t('topo.probe.noReply') });
      return;
    }
    if (kind === 'route') {
      const r = await topoProbeAndWait(agentId, 'traceroute', host, 12, 3000);
      status.replaceWith(await probeDetail(r, agentId));
      return;
    }
    const viz = await pathVisualization({ sourceId: agentId, targetId: host });
    card.replaceChildren(el('h3', {}, heading), viz, close());
  } catch (e) {
    status.className = 'error';
    status.textContent = errText(e);
  }
}

// Map mode: the PUBLIC peers by country (circles sized by traffic) over the
// shared EU/self-hosted tiles, your sites as anchor pins, and the observed
// dependencies as routes. Internal (RFC1918) hosts are never geolocated, so the
// map deliberately shows only the external subset; the diagram remains the tool
// for the internal structure. Routes internal→external are drawn from a single
// anchor site — the selected Site, or the only located site — because the graph
// does not tie each internal IP to a site; when the fleet spans several sites
// the peers are shown without those lines and the page says so.
async function drawTopoMapInto(host, { data, locations, siteId }) {
  stopTopoMap();
  if (typeof L === 'undefined') {
    host.replaceChildren(el('div', { class: 'empty' }, t('topo.map.noLibrary')));
    return;
  }
  const nodes = (data && data.nodes) || [];
  const edges = (data && data.edges) || [];
  const nodeById = {};
  nodes.forEach((n) => { nodeById[n.id] = n; });
  const located = locations.filter((l) => l.latitude != null && l.longitude != null);
  const extNodes = nodes.filter((n) => n.kind === 'external');
  const geoNodes = extNodes.filter((n) => n.lat != null && n.lng != null);

  // Aggregate the geolocated peers to their country centroid — many peer IPs
  // stack on one point otherwise.
  const byCountry = new Map();
  for (const n of geoNodes) {
    const e = byCountry.get(n.country) || { country: n.country, lat: n.lat, lng: n.lng, bytes: 0, peers: 0, asns: new Set() };
    e.bytes += n.bytes || 0;
    e.peers += 1;
    if (n.asnName) e.asns.add(n.asnName);
    byCountry.set(n.country, e);
  }

  const selLoc = siteId ? located.find((l) => String(l.id) === String(siteId)) : null;
  const anchor = selLoc || (located.length === 1 ? located[0] : null);

  if (!geoNodes.length && !located.length) {
    host.replaceChildren(el('div', { class: 'empty' },
      extNodes.length ? t('topo.map.noGeoip') : t('topo.map.allInternal')));
    return;
  }

  let cfg = {};
  try { cfg = await api('/api/map/config'); } catch { /* fall back to default tiles */ }
  if (!host.isConnected) return; // the reader left while we awaited

  const canvas = el('div', { class: 'map' });
  const banner = (extNodes.length && !geoNodes.length)
    ? el('div', { class: 'empty' }, t('topo.map.noGeoip'))
    : null;
  const note = (!anchor && located.length > 1)
    ? el('p', { class: 'muted small' }, t('topo.map.manySites'))
    : null;
  host.replaceChildren(...[banner, canvas, note].filter(Boolean));

  const centre = anchor ? [anchor.latitude, anchor.longitude]
    : (geoNodes.length ? [geoNodes[0].lat, geoNodes[0].lng] : [20, 0]);
  const map = createLeafletMap(canvas, cfg, { center: centre, zoom: 3 });
  if (!map) return;
  topoMapState.map = map;

  const pts = [];
  for (const l of located) {
    L.circleMarker([l.latitude, l.longitude], {
      radius: 7, color: SITE_COLOR, fillColor: SITE_COLOR, fillOpacity: 0.9, weight: 2,
    }).addTo(map).bindTooltip(l.name);
    pts.push([l.latitude, l.longitude]);
  }

  // External↔external edges are always drawn; internal→external only from the
  // anchor site.
  for (const e of edges) {
    const from = nodeById[e.from];
    const to = nodeById[e.to];
    if (!to || to.lat == null || to.lng == null) continue;
    const isExtExt = from && from.lat != null && from.lng != null;
    const a = isExtExt ? [from.lat, from.lng] : (anchor ? [anchor.latitude, anchor.longitude] : null);
    if (!a) continue;
    L.polyline([a, [to.lat, to.lng]], { color: EXT_COLOR, weight: 1, opacity: 0.35 }).addTo(map);
  }

  for (const c of byCountry.values()) {
    const asns = [...c.asns].slice(0, 4).join(', ');
    L.circleMarker([c.lat, c.lng], {
      radius: radiusForBytes(c.bytes), color: EXT_COLOR, fillColor: EXT_COLOR, fillOpacity: 0.5, weight: 1,
    }).addTo(map).bindTooltip(
      `${c.country} · ${t('topo.map.peers', { n: c.peers })} · ${fmtBytes(c.bytes)}${asns ? ` · ${asns}` : ''}`);
    pts.push([c.lat, c.lng]);
  }

  if (pts.length > 1) { try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 7 }); } catch { /* single point */ } }
  setTimeout(() => { try { map.invalidateSize(); } catch { /* ignore */ } }, 60);
}

// Layers mode: the unified resilience graph (LLDP l2_link + service_dep). The
// graph is fetched once and cached; the layer choice re-renders locally.
const topoLayersState = { graph: null, changeSets: null, api: null };

async function drawTopoLayersInto(host, opts) {
  const render = () => {
    const graphData = topoLayersState.graph;
    if (!graphData) { host.replaceChildren(el('div', { class: 'muted' }, t('topo.layers.loading'))); return; }
    if (!(graphData.edges || []).length) {
      host.replaceChildren(el('div', { class: 'empty' }, t('topo.layers.empty')));
      topoLayersState.api = null;
      return;
    }
    const vm = TopologyGraph.buildViewModel(graphData, opts.layer, { focus: opts.focus });
    if (!vm.nodes.length) {
      host.replaceChildren(el('div', { class: 'empty' }, t('topo.layers.emptyLayer')));
      topoLayersState.api = null;
      return;
    }
    const api2 = topoLayersSvg(vm, {
      focusId: opts.focus,
      onNodeClick: (id) => {
        if (opts.whatIf) runTopoBlast(host, id, opts);
        else if (topoLayersState.api) topoLayersState.api.neighbourhood(id);
      },
    });
    topoLayersState.api = api2;
    // Recently-changed + flapping hosts (operator+ data) flagged on their nodes.
    if (topoLayersState.changeSets) {
      api2.nodeEls.forEach((g, id) => {
        g.classList.toggle('flapping', topoLayersState.changeSets.flapping.has(id));
        g.classList.toggle('changed', topoLayersState.changeSets.changed.has(id));
      });
    }
    const totals = graphData.totals || { nodes: 0, l2_link: 0, service_dep: 0 };
    const legend = el('div', { class: 'pg-legend' },
      el('span', { class: 'lg' }, el('span', { class: 'topo-swatch l2' }), t('topo.legend.l2')),
      el('span', { class: 'lg' }, el('span', { class: 'topo-swatch dep' }), t('topo.legend.dep')),
      topoLayersState.changeSets && (topoLayersState.changeSets.changed.size || topoLayersState.changeSets.flapping.size)
        ? el('span', { class: 'lg' }, el('span', { class: 'topo-dot flapping' }), t('topo.legend.changed'))
        : null,
      el('span', { class: 'lg muted' }, t('topo.legend.totals', {
        nodes: totals.nodes, links: totals.l2_link, deps: totals.service_dep,
      })));
    const children = [el('div', { class: 'pg-head' }, legend), api2.wrap];
    if (opts.whatIf) children.push(el('div', { class: 'blast-slot' }, el('div', { class: 'muted small' }, t('topo.whatIf.prompt'))));
    host.replaceChildren(...children);
    if (opts.whatIf && opts.focus != null) runTopoBlast(host, opts.focus, opts);
  };

  render();
  if (topoLayersState.graph) return;
  try {
    topoLayersState.graph = await api('/api/topology/graph');
  } catch (e) {
    host.replaceChildren(el('div', { class: 'error' }, errText(e)));
    return;
  }
  if (canWrite() && topoLayersState.changeSets === null) {
    try {
      const cg = await api('/api/topology/changes?limit=200');
      topoLayersState.changeSets = TopologyGraph.changedHostSets(cg.events || []);
    } catch { topoLayersState.changeSets = { changed: new Set(), flapping: new Set() }; }
  }
  if (host.isConnected) render();
}

async function runTopoBlast(host, id, opts) {
  if (!topoLayersState.api) return;
  if (opts.onFocus) opts.onFocus(id);
  const slot = host.querySelector('.blast-slot');
  if (slot) slot.replaceChildren(el('div', { class: 'muted small' }, t('topo.whatIf.computing', { id })));
  let blast;
  try {
    blast = await api(`/api/topology/blast-radius/${encodeURIComponent(id)}`);
  } catch (e) {
    topoLayersState.api.setHighlight({ focus: id, isolated: new Set(), affected: new Set() });
    if (slot) slot.replaceChildren(el('div', { class: 'error small' }, errText(e)));
    return;
  }
  topoLayersState.api.setHighlight(TopologyGraph.blastSets(blast));
  const nameFor = (nid) => {
    const n = ((topoLayersState.graph && topoLayersState.graph.nodes) || []).find((x) => x.id === Number(nid));
    return n ? n.label : String(nid);
  };
  if (slot) slot.replaceChildren(blastRadiusPanel(blast, { nameFor }));
}

function getTopologyPage() {
  if (topologyPage) return topologyPage;
  if (typeof window === 'undefined' || !window.TopologyPage || !ui) return null;
  topologyPage = window.TopologyPage.create({
    el, t, ui, errText, fmtBytes, gotoView,
    state: topologyPageState,
    TopologyGraph,
    canWrite,
    params: () => TopologyGraph.parseParams(window.location.search),
    modeParam: () => {
      try { return new URLSearchParams(window.location.search || '').get('mode'); } catch { return null; }
    },
    // parseParams defaults `layer` to 'both', so only the raw query can say
    // whether a layer (or a focus) was actually deep-linked.
    wantsLayers: () => /[?&](layer|focus)=/.test(window.location.search || ''),
    // Only the topology-owned params are written, so an unrelated one on the
    // URL survives — the SPA's replaceState persistence pattern.
    syncParams: (patch) => {
      try {
        const q = new URLSearchParams(window.location.search || '');
        for (const [k, v] of Object.entries(patch)) { if (v == null) q.delete(k); else q.set(k, String(v)); }
        const qs = q.toString();
        window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
      } catch { /* URL API off — best-effort */ }
    },
    help: () => {
      const info = PAGE_INFO.topology || {};
      return { lead: info.hero || '', title: info.title || t('topo.title'), body: info.body || (() => []) };
    },
    fetchScope: async () => {
      const [agents, locations] = await Promise.all([
        api('/agents').catch(() => []),
        api('/locations').catch(() => []),
      ]);
      return { agents, locations };
    },
    // Agent scope wins over Site, mirroring the backend precedence.
    fetchTopology: async ({ minutes, agentId, siteId }) => {
      const qp = new URLSearchParams({ minutes });
      if (agentId) qp.set('agentId', agentId);
      else if (siteId) qp.set('locationId', siteId);
      return api(`/api/topology?${qp}`);
    },
    graphSvg: topoGraphSvg,
    drawLayers: drawTopoLayersInto,
    drawMap: drawTopoMapInto,
    stopMap: stopTopoMap,
    recompute: async () => {
      await api('/api/topology/dependencies/recompute', { method: 'POST' });
      topoLayersState.graph = null;
    },
    probe: topoProbeModal,
  });
  return topologyPage;
}

views.topology = async () => {
  const v = getTopologyPage();
  if (!v) return el('div', { class: 'empty error' }, t('topo.err.title'));
  return v.view();
};

// ---- Delta / Changes view (topology change feed) ---------------------------
// The recorded topology changes (neighbour add/remove, link-state, port-move,
// flapping) from GET /api/topology/changes, newest first. The view owns a
// change-TYPE filter; the site + severity come from the SHARED global filter
// (the same fleetFilter the Overview uses) — not a separate filter state.
// Operator+ (changes are evidence records; the endpoint is operator+).
PAGE_INFO.delta = {
  hero: 'Topology changes — neighbour add/remove, link-state changes, port moves and flaps, newest first.',
  title: 'Changes — the topology delta feed',
  body: () => [
    el('p', {}, 'Each LLDP poll is compared against the previous snapshot and every difference is recorded as an immutable change (also written to the hash-chained audit log). A change that reverts within the flap window collapses into a single “flapping” record.'),
    el('p', {}, 'Filter by change type here; the Site and severity come from the shared global filter (the same one the Overview uses), so a filtered feed is one deep-link.'),
    el('p', { class: 'muted' }, 'Operator/admin — topology changes are evidence records.'),
  ],
};

// ---- Topology delta (MIGRATED — see public/views/topologyDelta.js) ----------
let topologyDeltaView = null;
const topologyDeltaState = {};

function getTopologyDeltaView() {
  if (topologyDeltaView) return topologyDeltaView;
  if (typeof window === 'undefined' || !window.TopologyDeltaView || !ui) return null;
  topologyDeltaView = window.TopologyDeltaView.create({
    el, t, ui, errText, openAgent, gotoView,
    state: topologyDeltaState,
    Delta: DeltaView,
    search: () => window.location.search,
    help: () => {
      const info = PAGE_INFO.delta || {};
      return { lead: info.hero || '', title: info.title || t('delta.title'), body: info.body || (() => []) };
    },
    // The site and severity are the SHARED global filter, not a second copy:
    // editing them here moves the same fleetFilter the Overview uses.
    filter: () => fleetFilter,
    setSite: (site) => { fleetFilter = FleetFilter.setSite(fleetFilter, site); syncFleetUrl(); },
    // FleetFilter has no setter for the whole list, and writing the array in
    // by hand would skip its normalisation. Toggling off, then on, does not.
    setSeverity: (tokens) => {
      let next = fleetFilter;
      for (const tok of next.severity.slice()) next = FleetFilter.toggleSeverity(next, tok);
      for (const tok of tokens) next = FleetFilter.toggleSeverity(next, tok);
      fleetFilter = next;
      syncFleetUrl();
    },
    // The change types live in the URL so a filtered feed is one link.
    syncTypes: (types) => {
      try {
        const q = new URLSearchParams(window.location.search || '');
        const patch = DeltaView.changeTypesPatch(types);
        if (patch.changeTypes == null) q.delete('changeTypes'); else q.set('changeTypes', patch.changeTypes);
        const qs = q.toString();
        window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
      } catch { /* best-effort */ }
    },
    fetchAll: async () => {
      const [chg, ag, loc] = await Promise.all([
        api('/api/topology/changes?limit=500'),
        api('/agents').catch(() => []),
        api('/locations').catch(() => []),
      ]);
      return { events: chg.events || [], agents: ag || [], locations: loc || [] };
    },
  });
  return topologyDeltaView;
}

views.delta = async () => {
  const v = getTopologyDeltaView();
  if (!v) return el('div', { class: 'empty error' }, t('delta.err.title'));
  return v.view();
};

// ---- Admin → Discovery (active scan scope + candidate queue) ---------------
// Admin-only. Configure the scan scope (CIDRs / ports / rate / cap), trigger a
// sweep, promote or dismiss discovered candidates, and review sweep history.
// The section is hidden from non-admins in the nav (data-min-role="admin") and
// every /api/discovery endpoint is admin-only server-side.
PAGE_INFO.discovery = {
  hero: 'Active discovery finds devices passive collection misses — a rate-limited native scan of the CIDR scope you configure. Nothing is ever auto-enrolled.',
  title: 'Discovery — find what passive monitoring misses',
  body: () => [
    el('p', {}, 'A scheduled, rate-limited sweep probes the CIDR ranges you configure (TCP-connect on a port list + reverse DNS). Live hosts become candidates you review — promotion to a monitored device is always a manual, admin action.'),
    el('p', {}, 'The scan never leaves the configured scope and refuses to start if the scope is unconfigured or exceeds the address cap. Every sweep is written to the hash-chained audit log.'),
    el('p', { class: 'muted' }, 'Admin only. Enable the scheduled sweep with DISCOVERY_ENABLED where the server runs; scope + manual scans are managed here.'),
  ],
};

// ---- Discovery (MIGRATED — see public/views/discovery.js)
let discoveryPage = null;
const discoveryPageState = {};
function getDiscoveryPage() {
  if (discoveryPage) return discoveryPage;
  if (typeof window === 'undefined' || !window.DiscoveryPage || !ui) return null;
  discoveryPage = window.DiscoveryPage.create({
    el, t, ui, errText,
    state: discoveryPageState,
    confirm: (msg) => window.confirm(msg),
    // The agent sweeps on its own clock, so its candidates arrive after the
    // request does.
    later: (fn) => setTimeout(fn, 4000),
    help: () => ({ title: t('disc.info.title'), body: () => [
      el('p', {}, t('disc.info.p1')),
      el('p', {}, t('disc.info.p2')),
      el('p', { class: 'muted' }, t('disc.info.p3')),
    ] }),
    fetchBoot: async () => {
      const [cfg, agents] = await Promise.all([
        api('/api/discovery/config'),
        api('/agents').catch(() => []),
      ]);
      return { cfg, agents };
    },
    saveConfig: (body) => api('/api/discovery/config', { method: 'PUT', body }),
    // The server validates per field; a 400 carries `details` keyed by field.
    fieldErrors: (e) => (e && e.data && e.data.details
      ? Object.entries(e.data.details).map(([k, v]) => `${k}: ${v}`).join(' · ')
      : null),
    scan: (agentId) => api('/api/discovery/scan', { method: 'POST', body: agentId ? { agentId } : {} }),
    fetchCandidates: (status) => api(`/api/discovery/candidates${status ? `?status=${status}` : ''}`),
    fetchSweeps: () => api('/api/discovery/sweeps?limit=50'),
    promote: (c) => api(`/api/discovery/candidates/${c.id}/promote`, { method: 'POST' }),
    ignore: (c) => api(`/api/discovery/candidates/${c.id}/ignore`, { method: 'POST' }),
    openAgent,
  });
  return discoveryPage;
}

views.discovery = async () => {
  const v = getDiscoveryPage();
  if (!v) return el('div', { class: 'empty error' }, t('disc.err.config'));
  return v.view();
};

// ---- Troubleshooting (location-driven investigation) ------------------------
// Operator+ can trigger an investigation for a site/agent/interface/subnet and
// get the fault classified as LOCAL / UPSTREAM / DOWNSTREAM / APP_NOT_NET /
// INSUFFICIENT_DATA with explanation, evidence and workaround hints.

const INVESTIGATION_BADGE_CLASS = {
  LOCAL: 'CRIT',
  UPSTREAM: 'WARN',
  DOWNSTREAM: 'WARN',
  APP_NOT_NET: 'INFO',
  INSUFFICIENT_DATA: 'muted',
};

function investigationCard(inv) {
  const cls = INVESTIGATION_BADGE_CLASS[inv.classification] || 'muted';
  const conf = typeof inv.confidence === 'number' ? `${Math.round(inv.confidence * 100)} %` : '–';

  const segmentEl = inv.suspectedSegment
    ? el('div', { class: 'inv-segment' },
        el('span', { class: 'muted' }, 'Suspect segment: '),
        el('strong', {}, inv.suspectedSegment.from || '?'),
        el('span', { class: 'muted' }, ' → '),
        el('strong', {}, inv.suspectedSegment.to || '?'))
    : null;

  const evidenceRows = (Array.isArray(inv.evidence) ? inv.evidence : []).map((e) =>
    el('tr', {},
      el('td', {}, e.ref || '–'),
      el('td', {}, e.observed != null ? String(Number(e.observed).toFixed(2)) : '–'),
      el('td', {}, e.baseline != null ? String(Number(e.baseline).toFixed(2)) : '–'),
      el('td', {}, e.deviation != null ? `${Number(e.deviation).toFixed(1)}σ` : '–'),
      el('td', { class: 'muted' }, e.ts ? fmtDate(e.ts) : '–')));

  const hints = Array.isArray(inv.workaroundHints) && inv.workaroundHints.length
    ? el('div', { class: 'inv-hints' },
        el('h4', {}, 'Possible workarounds'),
        el('ul', {}, ...inv.workaroundHints.map((h) => el('li', {}, h))))
    : null;

  let narrativeEl = null;
  if (inv.narrative) {
    const details = el('details', { class: 'inv-narrative' },
      el('summary', {}, 'AI-generated summary (Mistral)'),
      el('p', {}, inv.narrative));
    narrativeEl = details;
  }

  // NIS2 draft — created server-side from the same context; shown read-only here.
  // A human must review it in Reporting → NIS2 Incidents before submission.
  let nis2El = null;
  if (inv.nis2Draft) {
    const d = inv.nis2Draft;
    const sevCls = { low: 'INFO', medium: 'WARN', high: 'CRIT', critical: 'CRIT' }[d.severity] || 'muted';
    nis2El = el('details', { class: 'inv-nis2-draft' },
      el('summary', {},
        el('span', { class: 'badge inv-badge INFO' }, 'NIS2'),
        ` Draft created (${d.eventId || '?'}) — review before submission`),
      el('div', { class: 'inv-nis2-draft-body' },
        el('p', { class: 'muted inv-nis2-notice' },
          'AI-generated draft · Requires human review · Never auto-submitted'),
        el('dl', { class: 'inv-nis2-dl' },
          el('dt', {}, 'Title'), el('dd', {}, d.title || '–'),
          el('dt', {}, 'Severity'), el('dd', {},
            el('span', { class: `badge inv-badge ${sevCls}` }, d.severity || '–')),
          el('dt', {}, 'Detected'), el('dd', {}, d.detectedAt ? fmtDate(new Date(d.detectedAt).getTime()) : '–'),
          el('dt', {}, 'Affected systems'), el('dd', {}, d.affectedSystems || '–'),
          el('dt', {}, 'Description'), el('dd', {}, d.businessImpact || '–')),
        el('p', { class: 'muted' },
          'Edit the draft under ',
          el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); switchView('reporting'); } },
            'Reporting → NIS2 Incidents'), '.')));
  } else if (inv.nis2DraftError) {
    nis2El = el('div', { class: 'inv-nis2-error muted' },
      `NIS2 draft could not be created: ${inv.nis2DraftError}`);
  }

  return el('div', { class: 'inv-card' },
    el('div', { class: 'inv-header' },
      el('span', { class: `badge inv-badge ${cls}` }, inv.classification),
      el('span', { class: 'inv-conf muted' }, `Confidence: ${conf}`),
      el('span', { class: 'muted' }, fmtDate(inv.createdAt || inv.window && inv.window.to))),
    el('p', { class: 'inv-explanation' }, inv.explanation || '–'),
    segmentEl,
    evidenceRows.length
      ? el('div', { class: 'inv-evidence' },
          el('h4', {}, 'Evidence'),
          el('table', { class: 'agents-table' },
            el('thead', {}, el('tr', {},
              el('th', {}, 'Metric'), el('th', {}, 'Observed'),
              el('th', {}, 'Baseline'), el('th', {}, 'Deviation'), el('th', {}, 'Time'))),
            el('tbody', {}, ...evidenceRows)))
      : null,
    hints,
    narrativeEl,
    nis2El);
}

// Help text for the Investigate view (i18n-backed: the getters re-read the
// active locale on every render, so a language switch is reflected at once).
PAGE_INFO.investigation = {
  get hero() { return t('pageInfo.investigation.hero'); },
  get title() { return t('pageInfo.investigation.title'); },
  body: () => [
    el('p', {}, t('pageInfo.investigation.body1')),
    el('p', { class: 'muted' }, t('pageInfo.investigation.body2')),
  ],
};

PAGE_INFO.diagnose = {
  get hero() { return t('diag.info.hero'); },
  get title() { return t('diag.info.title'); },
  body: () => [
    el('p', {}, t('diag.info.p1')),
    el('p', {}, t('diag.info.p2')),
    el('p', {}, t('diag.info.p3')),
    el('p', { class: 'muted' }, t('diag.info.p4')),
  ],
};

// Symptom-first diagnosis. One screen: describe the fault, read the plan, run
// it, and see each cause marked from the measurements.
//
// The state lives in this closure and the page re-renders from it, rather than
// being patched in place — a plan is small, and a screen somebody is reading
// mid-outage must never show two halves of two different answers.
let diagnoseState = null;

// ---- Diagnose (MIGRATED — see public/views/diagnose.js) ---------------------
let diagnoseView = null;

function getDiagnoseView() {
  if (diagnoseView) return diagnoseView;
  if (typeof window === 'undefined' || !window.DiagnoseView || !ui) return null;
  // The plan, the scope and the selection survive a view switch, which is what
  // diagnoseState has always been for.
  if (!diagnoseState) diagnoseState = {};
  diagnoseView = window.DiagnoseView.create({
    el, t, ui, errText, plural,
    state: diagnoseState,
    navigate: diagnoseNavigate,
    isViewer: () => role === 'viewer',
    help: () => {
      const info = PAGE_INFO.diagnose || {};
      return { lead: info.hero || '', title: info.title || t('diag.title'), body: info.body || (() => []) };
    },
    fetchAgents: async () => api('/agents').catch(() => []),
    // The examples are the catalogue's own symptoms, so they can never drift
    // from what the matcher actually knows.
    fetchExamples: async () => {
      const r = await api(`/api/playbooks?locale=${encodeURIComponent(window.I18n.getLocale())}`);
      return (r.playbooks || []).slice(0, 4).map((p) => (p.symptoms || [])[0]).filter(Boolean);
    },
    ask: async ({ description, agentId, peerAgentId, target }) => {
      const body = { description, locale: window.I18n.getLocale() };
      if (agentId != null) body.agentId = agentId;
      if (peerAgentId != null) body.peerAgentId = peerAgentId;
      if (target) body.target = target;
      return api('/api/diagnose', { method: 'POST', body });
    },
    fetchSession: async (sessionId) => {
      const d = await api(`/api/diagnose/${sessionId}`);
      return (d.session && d.session.tests) || [];
    },
    runTests: async (sessionId, body) => api(`/api/diagnose/${sessionId}/run`, { method: 'POST', body }),
    evaluate: async (sessionId) => api(`/api/diagnose/${sessionId}/evaluate`, { method: 'POST', body: {} }),
    // One package per agent: a test package pushes every item to every target,
    // so a single package would run each reverse test from the wrong end.
    repeat: (rows, st, chipEl) => {
      const byAgent = new Map();
      for (const r of rows) {
        if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, []);
        byAgent.get(r.agentId).push({ type: 'probe', probe: { type: r.probeType, host: r.target, ...(r.params || {}) } });
      }
      openRepeatModal({
        what: t('repeat.what.diagnose'),
        onSave: async (spec, runs) => {
          const made = [];
          for (const [agentId, items] of byAgent) {
            const repeated = [];
            for (let i = 0; i < runs; i += 1) repeated.push(...items);
            // eslint-disable-next-line no-await-in-loop
            made.push(await api('/api/test-packages', {
              method: 'POST',
              body: {
                name: `Diagnosis #${st.plan.sessionId} — ${st.target || st.plan.target}`.slice(0, 120),
                enabled: true,
                schedule_spec: spec,
                targets: { mode: 'agents', agentIds: [Number(agentId)] },
                items: repeated,
              },
            }));
          }
          return { name: made.map((m) => m.name).join(', '), packages: made };
        },
        onSaved: (pkg, summary) => repeatChip(chipEl, pkg, summary),
      });
    },
  });
  return diagnoseView;
}

views.diagnose = async () => {
  const v = getDiagnoseView();
  if (!v) return el('div', { class: 'empty error' }, t('diag.err.ask'));
  return v.view();
};

PAGE_INFO.burst = {
  get hero() { return t('burst.info.hero'); },
  get title() { return t('burst.info.title'); },
  body: () => [
    el('p', {}, t('burst.info.p1')),
    el('p', {}, t('burst.info.p2')),
    el('p', { class: 'muted' }, t('burst.info.p3')),
  ],
};

PAGE_INFO.deviceLog = {
  get hero() { return t('devlog.info.hero'); },
  get title() { return t('devlog.info.title'); },
  body: () => [
    el('p', {}, t('devlog.info.p1')),
    el('p', {}, t('devlog.info.p2')),
    el('p', { class: 'muted' }, t('devlog.info.p3')),
  ],
};

// ---- Device log (MIGRATED — see public/views/deviceLog.js) ------------------
//
// The filter survives a view switch: somebody who narrowed to "critical, last
// 15 minutes, Gi0/1" and stepped away to read a finding must come back to the
// list they built, not to the default.
let deviceLogState = null;
let deviceLogView = null;

function getDeviceLogView() {
  if (deviceLogView) return deviceLogView;
  if (typeof window === 'undefined' || !window.DeviceLogView || !ui) return null;
  if (!deviceLogState) deviceLogState = {};
  deviceLogView = window.DeviceLogView.create({
    el, t, ui, errText,
    state: deviceLogState,
    help: () => {
      const info = PAGE_INFO.deviceLog || {};
      return { lead: info.hero || '', title: info.title || t('devlog.title'), body: info.body || (() => []) };
    },
    fetchEvents: async (f) => {
      const qs = new URLSearchParams();
      if (f.minutes != null) qs.set('minutes', String(f.minutes));
      if (f.maxSeverity != null) qs.set('maxSeverity', String(f.maxSeverity));
      if (f.eventType) qs.set('eventType', f.eventType);
      if (f.transport) qs.set('transport', f.transport);
      if (f.q) qs.set('q', f.q);
      return api(`/api/device-events?${qs.toString()}`);
    },
    fetchCatalog: async () => api('/api/device-events/catalog'),
    openTimeline: (deviceId) => openAgent(deviceId),
  });
  return deviceLogView;
}

views.deviceLog = async () => {
  const v = getDeviceLogView();
  if (!v) return el('div', { class: 'empty error' }, t('devlog.err.title'));
  return v.view();
};

function diagnoseNavigate(view, state) {
  const agentId = state && state.agentId != null ? Number(state.agentId) : null;
  switch (view.view) {
    case 'flows':
      if (agentId != null) { openFlows(agentId); return; }
      break;
    case 'interfaces':
    case 'agents':
    case 'nics':
      if (agentId != null) { openAgent(agentId); return; }
      break;
    case 'probes':
      if (view.params && view.params.tab) probesTab = view.params.tab;
      if (agentId != null) selectedAgentId = agentId;
      break;
    default:
      break;
  }
  currentView = view.view;
  render();
}

// ---- Investigate (MIGRATED — see public/views/investigate.js) ---------------
// investigationCard() stays here: it carries the NIS2 draft block and the
// AI-narrative fold, each of which migrates on its own terms.
let investigateView = null;
const investigateState = {};

function getInvestigateView() {
  if (investigateView) return investigateView;
  if (typeof window === 'undefined' || !window.InvestigateView || !ui) return null;
  investigateView = window.InvestigateView.create({
    el, t, ui, errText,
    state: investigateState,
    card: investigationCard,
    help: () => {
      const info = PAGE_INFO.investigation || {};
      return { lead: info.hero || '', title: info.title || t('inv.title'), body: info.body || (() => []) };
    },
    fetchTargets: async () => {
      const [agents, locations] = await Promise.all([
        api('/agents').catch(() => []),
        api('/locations').catch(() => []),
      ]);
      return { agents, locations };
    },
    fetchHistory: async () => {
      const list = await api('/api/investigation');
      return Array.isArray(list) ? list : [];
    },
    run: async ({ type, value, windowMinutes }) => api('/api/investigation/run', {
      method: 'POST',
      body: { locationRef: { type, value }, windowMinutes },
    }),
  });
  return investigateView;
}

views.investigation = async () => {
  const v = getInvestigateView();
  if (!v) return el('div', { class: 'empty error' }, t('inv.err.run'));
  return v.view();
};

// ---------------------------------------------------------------------------
// Consolidated Troubleshooting Dashboard.
//
// One screen answering three questions without a view switch: what is failing,
// what does it affect, and when did it start. Everything comes from the SINGLE
// aggregate read GET /api/troubleshooting/overview — no per-panel fan-out.
//
// The state→colour contract is the same one the backend derives:
//   green = ok · red = down · grey = unreachable downstream (we cannot hear it,
//   which is NOT a claim that it is broken).
//
// Pure logic (models, filters, layout) lives in public/troubleshootingView.js so
// it can be unit-tested; this function is DOM + fetch only.
// ---------------------------------------------------------------------------

// State-coloured topology graph. Nodes are monitored hosts; links carry their
// layer (L2 adjacency vs. L3 service dependency) and the worse endpoint state.
function tshootTopologySvg(topology, { onSelect, layerFilter } = {}) {
  const TV = window.TroubleshootingView;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) if (v != null) e.setAttribute(a, v);
    for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };

  const W = 760;
  const H = 460;
  const nodes = topology.nodes || [];
  const links = (topology.links || []).filter((l) => layerFilter === 'all' || !layerFilter || l.layer === layerFilter);
  const wrap = el('div', { class: 'ts-topo' });

  if (!nodes.length) {
    wrap.append(el('div', { class: 'empty' }, 'No topology yet — LLDP neighbours and service dependencies appear once agents report them.'));
    return wrap;
  }

  const pos = TV.layoutNodes(nodes, links, W, H);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Network topology by state' });
  const nodeEls = new Map();
  const linkEls = [];

  for (const l of links) {
    const a = pos[l.source];
    const b = pos[l.target];
    if (!a || !b) continue;
    const line = mk('line', {
      class: `ts-link ${TV.stateClass(l.state)} layer-${l.layer}`,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
    }, mk('title', {}, `${l.layer.toUpperCase()} · ${TV.stateLabel(l.state)}${l.dstPort ? ` · port ${l.dstPort}` : ''}`));
    svg.append(line);
    linkEls.push({ source: l.source, target: l.target, el: line });
  }

  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    const short = String(n.label || n.id);
    const g = mk('g', {
      class: `ts-node ${TV.stateClass(n.state)}`,
      tabindex: '0', role: 'button',
      'aria-label': `${short} — ${TV.stateLabel(n.state)}`,
    },
    mk('circle', { cx: p.x, cy: p.y, r: 11 }),
    mk('text', { x: p.x, y: p.y + 26, 'text-anchor': 'middle' }, short.length > 16 ? `${short.slice(0, 15)}…` : short),
    mk('title', {}, `${short}\n${TV.stateLabel(n.state)}`));
    const pick = () => onSelect && onSelect(n);
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    svg.append(g);
    nodeEls.set(n.id, g);
  }

  wrap.append(svg);

  // Highlight a blast-radius path returned by /api/topology/blast-radius.
  wrap.highlightPath = (ids) => {
    const set = new Set((ids || []).map(Number));
    nodeEls.forEach((g, id) => g.classList.toggle('on-path', set.has(Number(id))));
    linkEls.forEach((l) => l.el.classList.toggle('on-path', set.has(Number(l.source)) && set.has(Number(l.target))));
  };
  wrap.clearPath = () => {
    nodeEls.forEach((g) => g.classList.remove('on-path'));
    linkEls.forEach((l) => l.el.classList.remove('on-path'));
  };
  return wrap;
}

// ---- Troubleshooting (MIGRATED — see public/views/troubleshooting.js) -------
// The topology SVG, the timeline rows and the brush geometry stay here: they
// are their own components, and two of them are shared with other screens.
let troubleshootingView = null;
const troubleshootingState = {};

// The event timeline's drag-to-brush, as an object the view can paint into: one
// marker per event, a selection rectangle, and pointer coords mapped through the
// viewBox so the selection lines up regardless of the rendered width.
function tshootBrushSvg(events, bounds, { onBrush }) {
  const W = 900;
  const H = 60;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) if (v != null) e.setAttribute(a, v);
    for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const span = Math.max(1, bounds.toMs - bounds.fromMs);
  const xOf = (ms) => ((ms - bounds.fromMs) / span) * W;

  const svg = mk('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'ts-brush', role: 'img',
    'aria-label': t('tshoot.timeline.label'),
  });
  svg.append(mk('line', { class: 'ts-axis', x1: 0, y1: H - 14, x2: W, y2: H - 14 }));
  const sel = mk('rect', { class: 'ts-brush-sel', x: 0, y: 0, width: 0, height: H - 14 });
  svg.append(sel);
  for (const e of events) {
    const ms = Date.parse(e.timestamp);
    if (Number.isNaN(ms)) continue;
    svg.append(mk('line', {
      class: `ts-marker sev-${window.TimelineView.severityClass(e.severity)}${window.TroubleshootingView.isChangeEvent(e) ? ' is-change' : ''}`,
      x1: xOf(ms), y1: 8, x2: xOf(ms), y2: H - 14,
    }, mk('title', {}, `${fmtDate(e.timestamp)} — ${e.summary}`)));
  }

  let dragFrom = null;
  const msAt = (ev) => {
    const rect = svg.getBoundingClientRect();
    const ratio = rect.width ? (ev.clientX - rect.left) / rect.width : 0;
    return bounds.fromMs + Math.max(0, Math.min(1, ratio)) * span;
  };
  svg.addEventListener('pointerdown', (ev) => { dragFrom = msAt(ev); svg.setPointerCapture(ev.pointerId); });
  svg.addEventListener('pointermove', (ev) => {
    if (dragFrom == null) return;
    onBrush({ fromMs: dragFrom, toMs: msAt(ev) });
  });
  svg.addEventListener('pointerup', (ev) => {
    if (dragFrom == null) return;
    const to = msAt(ev);
    // A click (not a drag) clears rather than selecting a zero-width window.
    const next = Math.abs(to - dragFrom) < span / 200 ? null : { fromMs: dragFrom, toMs: to };
    dragFrom = null;
    onBrush(next);
  });

  return {
    svg,
    setSelection: (b) => {
      if (!b) { sel.setAttribute('width', '0'); return; }
      sel.setAttribute('x', String(Math.min(xOf(b.fromMs), xOf(b.toMs))));
      sel.setAttribute('width', String(Math.abs(xOf(b.toMs) - xOf(b.fromMs))));
    },
  };
}

function getTroubleshootingView() {
  if (troubleshootingView) return troubleshootingView;
  if (typeof window === 'undefined' || !window.TroubleshootingPage || !ui) return null;
  troubleshootingView = window.TroubleshootingPage.create({
    el, t, ui, errText, openAgent, openCluster, gotoView,
    state: troubleshootingState,
    TV: window.TroubleshootingView,
    topologySvg: tshootTopologySvg,
    brushSvg: tshootBrushSvg,
    timelineRow: (e) => window.TimelineView.renderRow(document, e, { formatTime: fmtDate }),
    help: () => {
      const info = PAGE_INFO.troubleshooting || {};
      return { lead: info.hero || '', title: info.title || t('tshoot.title'), body: info.body || (() => []) };
    },
    fetchOverview: async (minutes) => api(`/api/troubleshooting/overview?minutes=${encodeURIComponent(minutes)}`),
    fetchFaults: async (limit, offset) => api(`/api/troubleshooting/faults?limit=${limit}&offset=${offset}`),
    blastRadius: async (anchorId) => {
      const radius = await api(`/api/topology/blast-radius/${encodeURIComponent(anchorId)}`);
      return window.TroubleshootingView.pathNodeIds([
        ...(radius.directly_isolated || []),
        ...(radius.dependency_affected || []),
      ]);
    },
  });
  return troubleshootingView;
}

views.troubleshooting = async () => {
  const v = getTroubleshootingView();
  if (!v) return el('div', { class: 'empty error' }, t('tshoot.err.title'));
  return v.view();
};

// Interface health per agent (utilisation, errors, discards, link state/speed)
// derived from the agent's latest measurement. Worst interfaces first.
views.interfaces = async () => {
  const root = el('div', { class: 'interfaces' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Interfaces'),
    el('span', { class: 'muted' }, 'Health per interface · utilisation · errors · discards · link')));

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'No agents yet.')); return root; }

  const agentSel = el('select', {}, ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  const status = el('span', { class: 'muted' });
  agentSel.addEventListener('change', () => refresh());
  root.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Agent ', agentSel),
    el('button', { class: 'small ghost', onclick: () => refresh() }, 'Refresh'), status));
  const host = el('div', {});
  root.append(host);

  async function refresh() {
    const id = agentSel.value;
    let data;
    try { data = await api(`/api/interfaces?agentId=${encodeURIComponent(id)}`); } catch (e) { host.replaceChildren(el('div', { class: 'error' }, e.message)); return; }
    status.textContent = data.ts ? `source: ${data.source} · measured ${fmtTimeShort(new Date(data.ts).getTime())}` : 'no measurements yet';
    host.replaceChildren(interfaceTable(data.interfaces, data.source));
  }

  refresh();
  stopIfaces();
  ifaceState.timer = setInterval(() => {
    if (currentView !== 'interfaces') { stopIfaces(); return; }
    if (!modalOpen()) refresh();
  }, 5000);
  return root;
};

// Active probes: trigger ping/tcp/dns/traceroute from an agent and watch the
// results (RTT/loss over time + traceroute path). The agent runs the probe and
// reports back, so results land a moment after triggering.
// "Probes & Tests" is one menu item with two sub-tabs: ad-hoc one-off probes
// (probeRunnerView) and reusable scheduled packages (testPackagesView). probesTab
// persists the active sub-tab across re-renders; gotoView('tests') deep-links here
// onto the packages tab (the old standalone Tests page).
let probesTab = 'run'; // 'run' | 'connection' | 'packages'
// ---- Probes & Tests (page shell MIGRATED — see public/views/probes.js) ------
// The shell is on the UI contract; the three tab bodies below are not yet, and
// they migrate in their own commits. Built lazily: `ui` is declared far down
// this file and is in the temporal dead zone up here.
let probesView = null;
function getProbesView() {
  if (probesView) return probesView;
  if (typeof window === 'undefined' || !window.ProbesView || !ui) return null;
  probesView = window.ProbesView.create({
    el, t, ui, errText,
    getTab: () => probesTab,
    setTab: (key) => {
      if (probesTab === key) return;
      // Run-a-probe owns the poller; every other tab must not leave it running.
      if (key !== 'run') stopProbes();
      probesTab = key;
      render();
    },
    rerender: () => render(),
    // Each tab answers a different question, so each brings its own lead line
    // and its own help — the three PAGE_INFO entries that used to feed three
    // different hero banners now feed one (?) popover.
    helpFor: (tab) => {
      const info = (tab === 'packages' ? PAGE_INFO.tests
        : (tab === 'connection' ? PAGE_INFO.connectionTest
          : (tab === 'burst' ? PAGE_INFO.burst : PAGE_INFO.probes))) || {};
      return { lead: info.hero || '', title: info.title || t('probes.title'), body: info.body || (() => []) };
    },
    tabBody: (tab) => (tab === 'packages' ? testPackagesView()
      : (tab === 'connection' ? connectionTestView()
        : (tab === 'burst' ? burstView() : probeRunnerView()))),
  });
  return probesView;
}

views.probes = async () => {
  const v = getProbesView();
  if (v) return v.view();
  // The module did not load: the tab bodies still work, so serve them rather
  // than a blank page.
  const root = el('div');
  const sub = probesTab === 'packages' ? testPackagesView
    : (probesTab === 'connection' ? connectionTestView
      : (probesTab === 'burst' ? burstView : probeRunnerView));
  root.append(await sub());
  return root;
};

// ---- Burst mode -----------------------------------------------------------
//
// One target, once a second, for up to two minutes — the resolution the
// 60-second reporting interval cannot give. A five-second loss event is
// invisible in the normal data, and that is exactly the fault somebody is
// standing in front of when they open this tab.
//
// THE SENTENCE UNDER THE CHART IS THE OUTPUT. A row of numbers tells a
// technician what they already knew; whether the loss is EVEN or CLUSTERED is
// the diagnostic value, and the server computes it in code and stores it with
// the run. This screen shows the sentence first and the figures beside it.
//
// The live chart draws from `burst-sample` frames on the dashboard socket, so
// the line grows while the measurement happens. A dropped frame costs one
// point; the authoritative series arrives with the finished run.
let burstWatcher = null;
const burstState = { agentId: null, target: '', seconds: 60, probe: 'ping', port: '', runId: null };

// The chart. Hand-drawn SVG like the rest of this dashboard, and it takes its
// colours from the tokens rather than naming any.
function burstChart(samples, { total, clusters = [] } = {}) {
  const W = 700;
  const H = 150;
  const L = 44;
  const R = 10;
  const T = 16;
  const B = 32;
  const n = Math.max(total || samples.length, 1);
  const rtts = samples.filter((s) => s.ok && Number.isFinite(s.rttMs)).map((s) => s.rttMs);
  const maxRtt = rtts.length ? Math.max(...rtts) : 1;
  // A little headroom so the peak is not welded to the top edge.
  const top = maxRtt * 1.15 || 1;
  const x = (i) => L + (i / Math.max(n - 1, 1)) * (W - L - R);
  const y = (v) => T + (1 - v / top) * (H - T - B);

  const svg = el('svg', {
    class: 'burst-chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': t('burst.chart.alt', { n: samples.length, lost: samples.filter((s) => !s.ok).length }),
  });

  // Gridlines at a quarter, half and three quarters of the scale, each labelled
  // with a value the chart actually reaches.
  for (const frac of [1, 0.5]) {
    const v = top * frac;
    svg.append(el('line', { x1: L, y1: y(v), x2: W - R, y2: y(v), class: 'burst-grid' }));
    svg.append(el('text', { x: L - 6, y: y(v) + 4, class: 'burst-axis', 'text-anchor': 'end' }, `${v.toFixed(1)} ms`));
  }
  svg.append(el('line', { x1: L, y1: y(0), x2: W - R, y2: y(0), class: 'burst-axis-line' }));

  // Shade the loss clusters, so the shape the verdict describes is visible
  // rather than something the reader has to find in the line.
  for (const c of clusters) {
    const x1 = x(c.start);
    const x2 = x(c.end);
    svg.append(el('rect', {
      x: String(x1), y: String(T), width: String(Math.max(x2 - x1, 2)), height: String(H - T - B),
      class: 'burst-lossband',
    }));
  }

  // The rtt line, broken at every loss: joining across a gap would draw a line
  // through a packet that never arrived.
  let run = [];
  const flush = () => {
    if (run.length > 1) svg.append(el('polyline', { points: run.join(' '), class: 'burst-line' }));
    else if (run.length === 1) {
      const [px, py] = run[0].split(',');
      svg.append(el('circle', { cx: px, cy: py, r: '1.6', class: 'burst-dot' }));
    }
    run = [];
  };
  samples.forEach((s, i) => {
    if (s.ok && Number.isFinite(s.rttMs)) run.push(`${x(i).toFixed(1)},${y(s.rttMs).toFixed(1)}`);
    else flush();
  });
  flush();

  // A marker per lost sample, on the baseline.
  samples.forEach((s, i) => {
    if (s.ok) return;
    svg.append(el('circle', { cx: String(x(i).toFixed(1)), cy: String(y(0)), r: '3', class: 'burst-lost' }));
  });

  svg.append(el('text', { x: String(L), y: String(H - 8), class: 'burst-axis' }, '0 s'));
  svg.append(el('text', { x: String(W - R), y: String(H - 8), class: 'burst-axis', 'text-anchor': 'end' },
    `${samples.length ? samples[samples.length - 1].t : 0} s`));
  return svg;
}

async function burstView() {
  const root = el('div', { class: 'burst' });
  const formHost = el('div', {});
  const outHost = el('div', {});
  root.append(formHost, outHost);

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) {
    root.append(el('div', { class: 'empty' }, t('burst.noAgents')));
    return root;
  }
  if (burstState.agentId == null) burstState.agentId = agents[0].id;

  // ---- the form -----------------------------------------------------------
  const agentSel = ui.select({
    id: 'burst-agent', label: t('burst.field.agent'), value: String(burstState.agentId),
    options: agents.map((a) => [String(a.id), a.display_name || a.hostname || `#${a.id}`]),
    onchange: (e) => { burstState.agentId = Number(e.target.value); },
  });
  const targetIn = el('input', {
    id: 'burst-target', type: 'text', maxlength: '255',
    placeholder: t('burst.field.target.placeholder'), 'aria-label': t('burst.field.target'),
  });
  targetIn.value = burstState.target;
  const secondsSel = ui.select({
    id: 'burst-seconds', label: t('burst.field.seconds'), value: String(burstState.seconds),
    options: [['30', '30 s'], ['60', '60 s'], ['120', '120 s']],
    onchange: (e) => { burstState.seconds = Number(e.target.value); },
  });
  const probeSel = ui.select({
    id: 'burst-probe', label: t('burst.field.probe'), value: burstState.probe,
    options: [['ping', 'ping (ICMP)'], ['tcp', 'TCP connect'], ['dns', 'DNS']],
    onchange: (e) => { burstState.probe = e.target.value; portIn.hidden = e.target.value !== 'tcp'; },
  });
  const portIn = el('input', {
    id: 'burst-port', type: 'number', min: '1', max: '65535',
    placeholder: t('burst.field.port'), 'aria-label': t('burst.field.port'),
  });
  portIn.value = burstState.port;
  portIn.hidden = burstState.probe !== 'tcp';

  const startBtn = ui.button('primary', t('burst.action.start'), { onclick: () => startBurst() });
  const stopBtn = ui.button('secondary', t('burst.action.stop'), { onclick: () => stopBurst() });
  stopBtn.disabled = true;
  const status = el('span', { class: 'meta-xs' });

  formHost.append(ui.panel({
    title: t('burst.form.title'),
    note: t('burst.form.note'),
    children: [ui.formActions([
      ui.filter(t('burst.field.agent'), agentSel),
      ui.filter(t('burst.field.target'), targetIn),
      ui.filter(t('burst.field.probe'), probeSel),
      portIn,
      ui.filter(t('burst.field.seconds'), secondsSel),
      startBtn, stopBtn, status,
    ])],
  }));

  // ---- the live run -------------------------------------------------------
  let live = [];
  let liveTotal = 0;

  function drawLive() {
    const lost = live.filter((s) => !s.ok).length;
    outHost.replaceChildren(ui.panel({
      title: t('burst.live.title'),
      note: t('burst.live.progress', { n: live.length, total: liveTotal || live.length }),
      children: [
        el('div', { class: 'burst-stats' },
          burstStat(t('burst.stat.loss'), live.length ? `${((lost / live.length) * 100).toFixed(1)} %` : '–', lost ? 'bad' : ''),
          burstStat(t('burst.stat.samples'), String(live.length), '')),
        burstChart(live, { total: liveTotal }),
        // No verdict yet, and it does not guess one: the shape is computed on
        // the server from the whole series, once it exists.
        ui.inlineNote ? ui.inlineNote(t('burst.live.pending')) : el('p', { class: 'muted' }, t('burst.live.pending')),
      ],
    }));
  }

  function burstStat(label, value, tone) {
    return el('div', { class: `burst-stat${tone ? ` ${tone}` : ''}` },
      el('span', { class: 'burst-stat-n' }, value),
      el('span', { class: 'burst-stat-l' }, label));
  }

  function drawRun(run) {
    const tone = run.pattern === 'clean' ? 'ok' : (run.lossPct > 0 ? 'bad' : '');
    outHost.replaceChildren(ui.panel({
      title: t('burst.result.title', { target: run.target }),
      note: `${run.probe} · ${run.seconds} s · ${run.hz} Hz`,
      children: [
        el('div', { class: 'burst-stats' },
          burstStat(t('burst.stat.loss'), run.lossPct == null ? '–' : `${run.lossPct} %`, tone),
          burstStat(t('burst.stat.median'), run.medianRttMs == null ? '–' : `${run.medianRttMs} ms`, ''),
          burstStat(t('burst.stat.p95'), run.p95RttMs == null ? '–' : `${run.p95RttMs} ms`, ''),
          burstStat(t('burst.stat.jitter'), run.jitterMs == null ? '–' : `${run.jitterMs} ms`, ''),
          burstStat(t('burst.stat.clusters'), run.lossClusters == null ? '–' : String(run.lossClusters), run.lossClusters > 1 ? 'bad' : '')),
        burstChart(run.samples || [], { total: run.sampleCount, clusters: run.clusters || [] }),
        // THE OUTPUT. Everything above it is supporting evidence.
        run.explanation
          ? el('p', { class: 'burst-verdict' }, run.explanation)
          : el('p', { class: 'muted' }, t('burst.result.noVerdict', { status: run.status })),
      ],
    }));
  }

  async function startBurst() {
    const target = targetIn.value.trim();
    if (!target) { status.textContent = t('burst.err.target'); return; }
    live = [];
    liveTotal = burstState.seconds;
    startBtn.disabled = true;
    status.textContent = t('burst.status.starting');
    drawLive();

    let run;
    try {
      const body = {
        agentId: burstState.agentId, target, seconds: burstState.seconds, probe: burstState.probe,
      };
      if (burstState.probe === 'tcp') body.port = Number(portIn.value) || undefined;
      ({ run } = await api('/api/burst', { method: 'POST', body }));
    } catch (e) {
      startBtn.disabled = false;
      status.textContent = errText(e);
      outHost.replaceChildren();
      return;
    }

    burstState.runId = run.id;
    burstState.target = target;
    stopBtn.disabled = false;
    status.textContent = t('burst.status.running');

    // Watch the live stream for THIS run only.
    burstWatcher = (payload) => {
      if (!payload || Number(payload.runId) !== Number(run.id)) return;
      live.push(payload.sample);
      if (payload.total) liveTotal = payload.total;
      drawLive();
    };

    // The finished run does not arrive on the socket — the samples do. Poll for
    // the stored verdict, which is the thing worth waiting for, and stop as
    // soon as the row is no longer running.
    const deadline = Date.now() + (burstState.seconds + 30) * 1000;
    const poll = async () => {
      if (Date.now() > deadline) { finish(t('burst.status.timeout')); return; }
      let fresh;
      try { fresh = (await api(`/api/burst/${run.id}`)).run; } catch { fresh = null; }
      if (fresh && fresh.status !== 'running') { drawRun(fresh); finish(''); return; }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  }

  function finish(message) {
    burstWatcher = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    status.textContent = message;
  }

  async function stopBurst() {
    if (!burstState.runId) return;
    stopBtn.disabled = true;
    try { await api(`/api/burst/${burstState.runId}/stop`, { method: 'POST' }); }
    catch (e) { status.textContent = errText(e); }
  }

  // ---- recent runs --------------------------------------------------------
  try {
    const { runs } = await api('/api/burst?limit=10');
    if (runs && runs.length) {
      root.append(ui.panel({
        title: t('burst.recent.title'),
        children: [ui.dataTable({
          dense: true,
          columns: [
            { key: 'when', label: t('burst.col.when'), width: '150px', time: true },
            { key: 'target', label: t('burst.col.target'), width: '180px' },
            { key: 'loss', label: t('burst.col.loss'), width: '90px', num: true },
            { key: 'verdict', label: t('burst.col.verdict') },
          ],
          rows: runs.map((r) => ({
            cells: {
              when: new Date(r.startedAt).toLocaleString(),
              target: el('code', {}, r.target),
              loss: r.lossPct == null ? '–' : `${r.lossPct} %`,
              // The sentence, again — it is what makes a list of past runs
              // readable rather than a column of percentages.
              verdict: r.explanation || el('span', { class: 'muted' }, r.status),
            },
            raw: r,
          })),
          onOpen: async (row) => {
            try { drawRun((await api(`/api/burst/${row.raw.id}`)).run); } catch (e) { toast(errText(e)); }
          },
        })],
      }));
    }
  } catch { /* the history is a courtesy; the tool is the form above */ }

  return root;
}

// ---- Connection test ------------------------------------------------------
// One address, the whole battery. The Run-a-probe tab above asks one question
// at a time; this asks all of them at once — type an IP or a DNS name, press
// Run, and every selected check is pushed to the agent in one request.
//
// The catalogue is the SERVER's (GET /api/connection-test/checks): what exists,
// what the agent can actually run, and what applies to this particular target
// (a DNS lookup of 1.1.1.1 answers nothing). The screen renders what it is
// served rather than keeping its own list, so a check offered here is always a
// check the server can dispatch.
//
// Everything a run produces is an ordinary probe result, so the full detail —
// path map, per-hop measurement, history — opens on the Run-a-probe tab and
// feeds fleet health exactly as a hand-run probe does.
const CT_MAX_ROUNDS = 20;
// How long the agent is given to report back, and how often we look. A probe
// round-trips in a second or two; a traceroute takes longer, so the last look
// is late enough to catch it without the screen sitting still in between.
const CT_POLL_MS = [2200, 4200, 7000];

async function connectionTestView() {
  const root = el('div', { class: 'probes connection-test' });
  root.append(el('div', { class: 'muted', style: 'margin:2px 0 10px' }, t('ct.lead')));

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) { root.append(el('div', { class: 'empty' }, t('ct.noAgents'))); return root; }

  // Declared up here because the list rendering reads them: the Run button is
  // disabled while a run is in flight as much as when nothing is selected.
  let running = false;
  let stopRequested = false;
  let catalogue = [];
  try { catalogue = (await api('/api/connection-test/checks')).checks || []; }
  catch (e) { root.append(el('div', { class: 'error' }, errText(e))); return root; }

  const agentSel = el('select', {}, ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  const target = el('input', { type: 'text', placeholder: t('ct.targetPlaceholder'), spellcheck: 'false' });
  const countInput = el('input', { type: 'number', min: '1', max: String(CT_MAX_ROUNDS), value: '1', class: 'run-count' });
  const runBtn = el('button', { class: 'small run-btn' });
  const stopBtn = el('button', { class: 'small ghost', disabled: 'disabled' }, t('ct.stop'));
  const repeatBtn = el('button', { class: 'small ghost' }, t('ct.repeat'));
  const status = el('span', { class: 'muted small' });
  const scheduleChip = el('span', { class: 'ct-chip', hidden: true });

  // The run count lives INSIDE the button — "Run [3] tests" is one control, and
  // the label follows the number so it never reads "Run 3 test".
  function syncRunLabel() {
    const n = Math.max(1, Math.min(CT_MAX_ROUNDS, Number(countInput.value) || 1));
    runBtn.replaceChildren(t('ct.run.prefix'), ' ', countInput, ' ', plural('ct.run.suffix', n));
  }
  countInput.addEventListener('input', syncRunLabel);
  // The number field is inside the button, so a click on it would also fire the
  // button. Stop that here rather than moving the field out of the label.
  countInput.addEventListener('click', (e) => e.stopPropagation());
  syncRunLabel();

  // --- the check list ------------------------------------------------------
  // Everything the agent can run starts selected, which is what an operator who
  // typed one address and pressed Run expects. A check that cannot run is shown
  // disabled with the reason, never quietly dropped.
  const selected = new Set(catalogue.filter((c) => c.available).map((c) => c.id));
  const rows = new Map(); // id -> { node, state }
  const listBody = el('div', { class: 'ct-rows' });
  const selectAll = el('input', { type: 'checkbox', checked: 'checked' });
  const counter = el('span', { class: 'muted small' });
  const listWrap = el('div', { class: 'ct-list', hidden: true },
    el('div', { class: 'ct-list-head' },
      el('label', { class: 'inline' }, selectAll, ' ', t('ct.selectAll')),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small' }, t('ct.defaultOn'))),
    listBody);

  const toggle = el('button', { class: 'small ghost ct-toggle', 'aria-expanded': 'false' },
    el('span', { class: 'ct-arrow' }, '▼'), ' ', t('ct.toggle'));
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    listWrap.hidden = open;
  });

  function why(c) {
    if (!c.available) return t('ct.why.notSupported');
    if (!c.applies) return t('ct.why.notApplicable');
    return null;
  }

  function setState(id, kind, label) {
    const entry = rows.get(id);
    if (!entry) return;
    entry.state.className = `ct-state ${kind}`;
    entry.state.textContent = label;
  }

  function renderRows() {
    rows.clear();
    const kids = [];
    for (const c of catalogue) {
      const blocked = why(c);
      const cb = el('input', {
        type: 'checkbox',
        ...(selected.has(c.id) && !blocked ? { checked: 'checked' } : {}),
        ...(blocked ? { disabled: 'disabled' } : {}),
      });
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(c.id); else selected.delete(c.id);
        syncCounter();
      });
      const state = el('span', { class: 'ct-state' }, '–');
      // Why it says what it says. A verdict with no reason sends the operator to
      // another screen to find out; the reason is the agent's own words when it
      // has any, and ours when it does not.
      const reason = el('div', { class: 'ct-reason', hidden: true });
      const tools = el('div', { class: 'ct-tools', hidden: true });
      // The disclosure, as on the Run-a-probe tab: the result opens IN PLACE,
      // because comparing it with the checks around it is the whole point of
      // running them together.
      const caret = el('span', { class: 'ct-caret', hidden: true }, '▸');
      const detail = el('div', { class: 'ct-detail', hidden: true });
      const node = el('div', { class: `ct-row${blocked ? ' blocked' : ''}` },
        cb,
        el('div', {},
          el('div', { class: 'ct-name' }, t(`ct.check.${c.id}`),
            c.port ? el('span', { class: 'ct-param' }, `port ${c.port}`) : null),
          el('div', { class: 'ct-desc' }, t(`ct.check.${c.id}.desc`)),
          reason, tools),
        state, caret);
      const entry = { node, state, reason, tools, caret, detail, check: c, result: null, loaded: false };
      // A row with a result behaves like a probe row: click or Enter/Space opens
      // it, and only one is open at a time — two open traceroutes would each
      // mount a path visualisation, and those write the brush window to the URL.
      const activate = (e) => {
        if (e && e.target && e.target.closest('input, button')) return;
        toggleDetail(entry);
      };
      node.addEventListener('click', activate);
      node.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target && e.target.closest('input, button')) return;
        e.preventDefault();
        activate();
      });
      rows.set(c.id, entry);
      kids.push(node, detail);
      // A check that cannot run says so from the start, before anybody presses
      // Run — that is the difference between a greyed-out row and a mystery.
      if (blocked) showReason(entry, c.available ? 'notApplicable' : 'notSupported', blocked);
    }
    listBody.replaceChildren(...kids);
    syncCounter();
  }

  // Marks a row with a short verdict in the pill and the long reason under it.
  function showReason(entry, shortKey, full, kind = null) {
    if (!entry) return;
    if (shortKey) {
      entry.state.className = `ct-state ${kind || (shortKey === 'notSupported' || shortKey === 'notApplicable' || shortKey === 'notSelected' ? 'skipped' : 'failed')}`;
      entry.state.textContent = t(`ct.reason.${shortKey}`, entry.reasonParams || {});
    }
    entry.reason.hidden = !full;
    entry.reason.textContent = full || '';
    entry.reason.className = `ct-reason${kind === 'skipped' || shortKey === 'notSupported' || shortKey === 'notApplicable' || shortKey === 'notSelected' ? ' muted' : ' bad'}`;
  }

  function clearReason(entry) {
    if (!entry) return;
    entry.reason.hidden = true;
    entry.reason.textContent = '';
    entry.tools.hidden = true;
    entry.tools.replaceChildren();
  }

  // One open at a time, and the row keeps what it fetched: re-opening must not
  // re-run three HTTP calls.
  let openDetail = null;
  async function toggleDetail(entry) {
    if (!entry || !entry.result) return;
    if (openDetail === entry) {
      entry.detail.hidden = true;
      entry.caret.textContent = '▸';
      entry.node.classList.remove('open');
      openDetail = null;
      return;
    }
    if (openDetail) {
      openDetail.detail.hidden = true;
      openDetail.caret.textContent = '▸';
      openDetail.node.classList.remove('open');
    }
    openDetail = entry;
    entry.detail.hidden = false;
    entry.caret.textContent = '▾';
    entry.node.classList.add('open');
    if (entry.loaded) return;
    entry.detail.replaceChildren(el('div', { class: 'pv-skel', style: 'height:120px' }));
    try {
      // The SAME renderer the Run-a-probe tab uses — path map, per-hop table,
      // MTU verdict, RTT history — because it is the same probe result.
      entry.detail.replaceChildren(await probeDetail(entry.result, agentSel.value));
      entry.loaded = !entry.detail.querySelector('.error');
    } catch (e) {
      entry.detail.replaceChildren(el('div', { class: 'error' }, errText(e)));
    }
  }

  function syncCounter() {
    const runnable = catalogue.filter((c) => !why(c));
    const on = runnable.filter((c) => selected.has(c.id)).length;
    counter.textContent = t('ct.selected', { n: String(on), total: String(runnable.length) });
    selectAll.checked = on > 0 && on === runnable.length;
    selectAll.indeterminate = on > 0 && on < runnable.length;
    runBtn.disabled = on === 0 || running;
  }

  selectAll.addEventListener('change', () => {
    for (const c of catalogue) {
      if (why(c)) continue;
      if (selectAll.checked) selected.add(c.id); else selected.delete(c.id);
    }
    renderRows();
  });

  // The catalogue's "does this apply" answer depends on the target, so it is
  // re-asked when the target changes — an IP literal greys the DNS row out with
  // the reason, rather than running a lookup that answers nothing.
  let lastHost = '';
  async function refreshCatalogue() {
    const host = target.value.trim();
    if (host === lastHost) return;
    lastHost = host;
    try {
      const q = host ? `?host=${encodeURIComponent(host)}` : '';
      catalogue = (await api(`/api/connection-test/checks${q}`)).checks || catalogue;
      renderRows();
    } catch { /* keep the catalogue we have — the target is checked again on run */ }
  }
  target.addEventListener('change', refreshCatalogue);

  root.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, t('ct.agent'), ' ', agentSel),
    el('label', { class: 'inline muted ct-target' }, t('ct.target'), ' ', target)));
  root.append(el('div', { class: 'history-controls ct-actions' },
    runBtn, stopBtn, canWrite() ? repeatBtn : null, scheduleChip, status));
  root.append(el('div', { class: 'ct-toggle-row' }, toggle, counter), listWrap,
    el('div', { class: 'muted small ct-note' }, t('ct.stopNote'), ' ', t('ct.resultsNote')));
  renderRows();

  // --- running -------------------------------------------------------------
  const say = (text, bad = false) => { status.className = bad ? 'error small' : 'muted small'; status.textContent = text; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Match a probe result row to the check that asked for it. A TCP probe stores
  // its target as host:port, which is also what keeps the :80 and :443 rows
  // apart — without it they would both show the same measurement.
  function resultFor(results, check, host) {
    const withPort = check.port ? `${host}:${check.port}` : null;
    return results.find((r) => r.type === check.type && (r.target === withPort || (!check.port && r.target === host))) || null;
  }

  async function collectResults(agentId, host, ids, since) {
    let results;
    try { results = (await api(`/api/probes/latest?agentId=${encodeURIComponent(agentId)}`)).results || []; }
    catch { return; }
    for (const id of ids) {
      const check = catalogue.find((c) => c.id === id);
      const r = check ? resultFor(results, check, host) : null;
      // Only a result from THIS run may claim a row; an older one for the same
      // target would otherwise report a fresh green tick for a probe that has
      // not come back yet.
      if (!r || (since && r.ts && new Date(r.ts).getTime() < since)) continue;
      const entry = rows.get(id);
      if (!entry) continue;
      // The row now HAS a result, so it opens like a probe row does.
      entry.result = r;
      entry.loaded = false;
      entry.caret.hidden = false;
      entry.node.setAttribute('tabindex', '0');
      entry.node.setAttribute('title', t('ct.openRow'));
      clearReason(entry);
      if (r.ok) {
        // The measurement itself is the verdict — "12 hops · 4% worst hop loss"
        // says more than OK, and it is already computed for the probe table.
        const m = probeMeasured(r);
        setState(id, 'ok', m || t('ct.state.ok'));
        // A path that carries small packets and drops full-size ones is `ok`
        // and still the finding; the probe table surfaces it for the same
        // reason, and a row that hides it gets scrolled past.
        if (r.type === 'path_mtu' && r.mtu && r.mtu.blackholeDetected) {
          entry.state.className = 'ct-state failed';
          entry.state.textContent = t('ct.reason.blackhole');
          showReason(entry, null, t('probe.mtu.status.blackhole'));
        }
      } else {
        const reason = ctFailureReason(r);
        entry.reasonParams = reason.params || {};
        showReason(entry, reason.short, reason.full);
        entry.reasonParams = {};
        // The agent can install the missing tool itself — the same button the
        // Run-a-probe table offers, in the row that is asking for it.
        const tool = missingToolOf(r);
        if (tool && canWrite()) {
          entry.tools.hidden = false;
          entry.tools.replaceChildren(el('button', {
            class: 'small',
            onclick: (e) => { e.stopPropagation(); requestToolInstall(agentSel.value, tool, e.target); },
          }, t('ct.install', { tool })));
        }
      }
    }
  }

  async function run() {
    const host = target.value.trim();
    if (!host) { say(t('ct.status.noTarget'), true); return; }
    const ids = catalogue.filter((c) => !why(c) && selected.has(c.id)).map((c) => c.id);
    if (!ids.length) { say(t('ct.status.noChecks'), true); return; }
    const rounds = Math.max(1, Math.min(CT_MAX_ROUNDS, Number(countInput.value) || 1));
    const agentId = agentSel.value;

    running = true; stopRequested = false;
    runBtn.disabled = true; stopBtn.disabled = false;
    if (listWrap.hidden) toggle.click();
    for (const c of catalogue) {
      const entry = rows.get(c.id);
      const blocked = why(c);
      if (!blocked && selected.has(c.id)) { clearReason(entry); setState(c.id, '', t('ct.state.waiting')); continue; }
      // Not "skipped" — WHY it was skipped: cleared by hand, not runnable by
      // this agent, or not a question this target can answer.
      if (blocked) showReason(entry, c.available ? 'notApplicable' : 'notSupported', blocked);
      else showReason(entry, 'notSelected', t('ct.reason.notSelectedFull'));
    }

    let completed = 0;
    for (let round = 1; round <= rounds && !stopRequested; round += 1) {
      const startedAt = Date.now() - 1000; // a second of slack for clock skew
      say(t('ct.status.round', { round: String(round), rounds: String(rounds), host }));
      for (const id of ids) setState(id, 'running', t('ct.state.running'));
      let res;
      try {
        res = await api('/api/connection-test/run', { method: 'POST', body: { agentId: Number(agentId), host, checks: ids } });
      } catch (e) {
        say(e.status === 409 ? t('ct.status.notConnected') : errText(e), true);
        break;
      }
      for (const d of res.dispatched || []) setState(d.id, 'running', t('ct.state.sent'));
      for (const s of res.skipped || []) setState(s.id, 'skipped', t('ct.state.skipped'));
      const dispatchedIds = (res.dispatched || []).map((d) => d.id);
      for (const wait of CT_POLL_MS) {
        if (stopRequested) break;
        await sleep(wait - (CT_POLL_MS[CT_POLL_MS.indexOf(wait) - 1] || 0));
        await collectResults(agentId, host, dispatchedIds, startedAt);
      }
      completed = round;
    }

    running = false;
    stopBtn.disabled = true;
    if (stopRequested) {
      for (const [id, entry] of rows) {
        const pending = entry.state.textContent === t('ct.state.waiting')
          || entry.state.textContent === t('ct.state.running')
          || entry.state.textContent === t('ct.state.sent');
        if (pending) setState(id, 'skipped', t('ct.state.stopped'));
      }
      say(t('ct.status.stopped'));
    } else if (completed) {
      say(t('ct.status.done', { rounds: String(completed), checks: String(ids.length), host }));
    }
    syncCounter();
  }

  runBtn.addEventListener('click', () => { if (!running) run(); });
  stopBtn.addEventListener('click', () => {
    stopRequested = true;
    stopBtn.disabled = true;
    say(t('ct.status.stopped'));
  });

  repeatBtn.addEventListener('click', () => {
    const host = target.value.trim();
    if (!host) { say(t('ct.status.noTarget'), true); return; }
    const ids = catalogue.filter((c) => !why(c) && selected.has(c.id)).map((c) => c.id);
    if (!ids.length) { say(t('ct.status.noChecks'), true); return; }
    // The connection test has its own save endpoint (the server owns the
    // catalogue, so the browser never builds the probe specs); everything else
    // the dialog does is the same.
    openRepeatModal({
      what: t('ct.title'),
      onSave: (spec, runs) => api('/api/connection-test/schedule', {
        method: 'POST',
        body: { agentId: Number(agentSel.value), host, checks: ids, runs, recurrence: spec },
      }),
      onSaved: (pkg, summary) => repeatChip(scheduleChip, pkg, summary),
    });
  });

  return root;
}

// Why a connection-test check did not succeed, in two lengths: a word for the
// pill and a sentence under the row.
//
// The agent's own `detail` is the truth when there is one — "traceroute not
// installed", "connect ECONNREFUSED" — so it is what the sentence says, and the
// word is read off it rather than invented. Everything here is a reading of
// what was measured; nothing is guessed, and a failure we cannot classify says
// so instead of dressing itself up.
function ctFailureReason(r) {
  const detail = r && r.detail ? String(r.detail) : '';
  const full = detail || null;
  const tool = missingToolOf(r);
  if (tool) return { short: 'missingTool', params: { tool }, full: full || t('ct.reason.missingToolFull', { tool }) };
  if (/not installed|command not found|ENOENT/i.test(detail)) return { short: 'failed', full };
  if (/refused|ECONNREFUSED/i.test(detail)) return { short: 'refused', full };
  if (/timed?\s?out|ETIMEDOUT/i.test(detail)) return { short: 'timeout', full };
  if (/unreachable|EHOSTUNREACH|ENETUNREACH/i.test(detail)) return { short: 'unreachable', full };
  if (/NXDOMAIN|ENOTFOUND|not known|no such host|EAI_AGAIN/i.test(detail)) return { short: 'nameNotFound', full };
  if (/permission|not permitted|EPERM|EACCES|raw socket|root/i.test(detail)) return { short: 'needsRoot', full };
  if (r && r.type === 'path_mtu' && r.mtu && r.mtu.blackholeDetected) {
    return { short: 'blackhole', full: full || t('probe.mtu.status.blackhole') };
  }
  // No words from the agent: read the measurement. 100% loss with nothing back
  // is the one case that is unambiguous.
  if (r && r.lossPct === 100) return { short: 'noReply', full: full || t('ct.reason.noReplyFull') };
  return { short: 'failed', full: full || t('ct.reason.failedFull') };
}

// ---- Repeat: the shared recurrence editor ---------------------------------
// One dialog, four screens. A connection test, a single probe, a speed test and
// a diagnosis plan all ask the same question — how often, starting when — and
// all four answer it by writing an ordinary test package. The editor below is
// the question; the caller owns the saving, because what gets scheduled differs
// and the schedule does not.

// How many runs inside one period the dialog offers, per period. The server
// accepts any divisor down to a five-minute floor (src/schedule/recurrence.js);
// these are the ones worth a menu entry, and each is rendered as the GAP it
// produces ("every 4 hours") rather than as the number it is, because that is
// the question the operator is actually answering.
const REPEAT_WITHIN = {
  hourly: [1, 2, 4, 12],
  daily: [1, 2, 3, 4, 6, 12, 24],
  weekly: [1, 7, 14],
  monthly: [1, 2, 4],
};
const REPEAT_PERIOD_MINUTES = { hourly: 60, daily: 1440, weekly: 10080, monthly: 40320 };

// "every 6" is not an answer anybody recognises — this turns it into the gap.
function repeatWithinLabel(period, every) {
  if (every === 1) return t(`repeat.every.oncePer.${period}`);
  const minutes = REPEAT_PERIOD_MINUTES[period] / every;
  if (minutes < 60) return t('repeat.every.minutes', { n: String(Math.round(minutes)) });
  if (minutes < 1440) {
    const hours = Math.round(minutes / 60);
    return hours === 1 ? t('repeat.every.hour') : t('repeat.every.hours', { n: String(hours) });
  }
  const days = Math.round(minutes / 1440);
  return days === 1 ? t('repeat.every.day') : t('repeat.every.days', { n: String(days) });
}

// The recurrence in one sentence, in the operator's language. Shown live in the
// dialog, kept beside the buttons afterwards, and used for the Schedule column
// on the Test packages tab — a schedule nobody can read back is a schedule
// nobody trusts.
function repeatSummary(spec, runs) {
  if (!spec || !spec.period) return '';
  const within = repeatWithinLabel(spec.period, Number(spec.every) || 1);
  const runsText = plural('repeat.perRun', runs, { n: String(runs) });
  if (spec.period === 'hourly') return t('repeat.summary.hourly', { within, runs: runsText });
  if (spec.period === 'daily') return t('repeat.summary.daily', { at: spec.at, within, runs: runsText });
  if (spec.period === 'weekly') return t('repeat.summary.weekly', { weekday: t(`repeat.weekday.${spec.weekday}`), at: spec.at, within, runs: runsText });
  return t('repeat.summary.monthly', { dom: String(spec.dayOfMonth), at: spec.at, within, runs: runsText });
}

// The fields themselves, as an embeddable component: the Repeat dialog wraps
// them in a modal, the test-package editor drops them straight into its form.
//   spec()  → the recurrence, in the shape the server validates
//   runs()  → how many times the payload repeats per scheduled run
//   node    → the fields, ready to append
function recurrenceFields({ spec = null, runs = 1, showRuns = true, showSummary = true, onChange = null } = {}) {
  const init = spec && spec.period ? spec : { period: 'daily', every: 1, at: '08:00', weekday: 1, dayOfMonth: 1 };
  const periodSel = el('select', {}, ...['hourly', 'daily', 'weekly', 'monthly']
    .map((p) => el('option', { value: p, ...(p === init.period ? { selected: 'selected' } : {}) }, t(`repeat.period.${p}`))));
  const withinSel = el('select', {});
  const atInput = el('input', { type: 'time', value: init.at || '08:00' });
  const weekdaySel = el('select', {}, ...[1, 2, 3, 4, 5, 6, 7]
    .map((d) => el('option', { value: String(d), ...(d === (init.weekday || 1) ? { selected: 'selected' } : {}) }, t(`repeat.weekday.${d}`))));
  const domInput = el('input', { type: 'number', min: '1', max: '28', value: String(init.dayOfMonth || 1) });
  const runsInput = el('input', { type: 'number', min: '1', max: '20', value: String(runs || 1) });
  const summary = el('div', { class: 'ct-summary' });

  const atWrap = el('label', {}, t('repeat.at'), atInput);
  const weekdayWrap = el('label', {}, t('repeat.weekdayLabel'), weekdaySel);
  const domWrap = el('label', {}, t('repeat.dayOfMonth'), domInput);
  const runsWrap = el('label', {}, t('repeat.runs'), runsInput);

  const readSpec = () => {
    const period = periodSel.value;
    const out = { period, every: Number(withinSel.value) || 1 };
    if (period !== 'hourly') out.at = atInput.value || '08:00';
    if (period === 'weekly') out.weekday = Number(weekdaySel.value);
    if (period === 'monthly') out.dayOfMonth = Number(domInput.value) || 1;
    return out;
  };
  const readRuns = () => Math.max(1, Number(runsInput.value) || 1);

  function syncSummary() {
    if (showSummary) summary.textContent = repeatSummary(readSpec(), readRuns());
    if (onChange) onChange(readSpec(), readRuns());
  }
  function syncPeriod() {
    const period = periodSel.value;
    const keep = Number(withinSel.value) || Number(init.every) || 1;
    withinSel.replaceChildren(...REPEAT_WITHIN[period]
      .map((n) => el('option', { value: String(n), ...(n === keep ? { selected: 'selected' } : {}) }, repeatWithinLabel(period, n))));
    atWrap.hidden = period === 'hourly';
    weekdayWrap.hidden = period !== 'weekly';
    domWrap.hidden = period !== 'monthly';
    syncSummary();
  }
  periodSel.addEventListener('change', syncPeriod);
  for (const node of [withinSel, atInput, weekdaySel, domInput, runsInput]) node.addEventListener('change', syncSummary);
  runsInput.addEventListener('input', syncSummary);

  const node = el('div', { class: 'repeat-fields' },
    el('label', {}, t('repeat.period'), periodSel),
    el('label', {}, t('repeat.within'), withinSel),
    el('div', { class: 'ct-two' }, atWrap, weekdayWrap, domWrap, showRuns ? runsWrap : null),
    showSummary ? summary : null);
  runsWrap.hidden = !showRuns;
  syncPeriod();
  return { node, spec: readSpec, runs: readRuns, sync: syncPeriod };
}

// The dialog. `what` names what is being repeated (it is in the title), and
// `onSave(spec, runs)` does the saving — it returns the created package, which
// this reports back through `onSaved`.
function openRepeatModal({ what, onSave, onSaved, showRuns = true }) {
  const card = $('#modal-card');
  const fields = recurrenceFields({ showRuns });
  const err = el('p', { class: 'error' });
  const saveBtn = el('button', { type: 'button' }, t('repeat.save'));

  saveBtn.addEventListener('click', async () => {
    err.textContent = '';
    saveBtn.disabled = true;
    const spec = fields.spec();
    const runs = fields.runs();
    try {
      const pkg = await onSave(spec, runs);
      closeModal();
      if (onSaved) onSaved(pkg, repeatSummary(spec, runs));
    } catch (e) { err.textContent = errText(e); saveBtn.disabled = false; }
  });

  card.replaceChildren(
    el('h3', {}, t('repeat.title', { what })),
    el('div', { class: 'form-grid' },
      fields.node,
      el('p', { class: 'muted small' }, t('repeat.hint')),
      err,
      el('div', { class: 'form-actions' },
        el('button', { type: 'button', class: 'ghost', onclick: closeModal }, t('repeat.cancel')),
        saveBtn)));
  $('#modal').classList.remove('hidden');
}

// A chip beside the buttons, so the screen says what was just scheduled and
// where it now lives. It never offers to delete: the package is real, and
// removing it belongs on the tab that owns it, not behind an × that would only
// clear the chip.
function repeatChip(chip, pkg, summary) {
  chip.hidden = false;
  chip.replaceChildren('↻ ', summary, ' · ',
    el('button', { class: 'link', title: t('repeat.openPackage'), onclick: () => gotoView('tests') }, pkg.name));
  toast(t('repeat.saved', { name: pkg.name }));
}

// Saves a package for one agent — the shape every Repeat on a probe screen
// writes: this agent, this payload, repeated `runs` times per scheduled run.
function saveRepeatPackage({ name, agentId, item, spec, runs }) {
  return api('/api/test-packages', {
    method: 'POST',
    body: {
      name,
      enabled: true,
      schedule_spec: spec,
      targets: { mode: 'agents', agentIds: [Number(agentId)] },
      items: Array.from({ length: runs }, () => item),
    },
  });
}

async function probeRunnerView() {
  const root = el('div', { class: 'probes' });
  root.append(el('div', { class: 'muted', style: 'margin:2px 0 10px' }, 'Run one check now from a single agent · ping · TCP · DNS · traceroute · TCP traceroute · path MTU · cURL · page load · transaction'));

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'No agents yet — enrol an agent first.')); return root; }

  const agentSel = el('select', {}, ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  const typeSel = el('select', {}, ...[['ping', 'Ping (ICMP)'], ['tcp', 'TCP-connect'], ['dns', 'DNS'], ['traceroute', 'Traceroute'], ['tcptraceroute', t('probe.tcptraceroute')], ['path_mtu', t('probe.pathMtu')], ['tls', t('probe.tls')], ['rdns', t('probe.rdns')], ['curl', 'cURL (content check)'], ['pageload', 'Page load'], ['transaction', 'Transaction (multi-step)']].map(([v, l]) => el('option', { value: v }, l)));
  const target = el('input', { type: 'text', placeholder: 'e.g. 1.1.1.1 or example.com' });
  const targetWrap = el('label', { class: 'inline muted' }, 'Target ', target);
  const portInput = el('input', { type: 'number', min: '1', max: '65535', value: '443' });
  const portWrap = el('label', { class: 'inline muted' }, 'Port ', portInput);
  const countInput = el('input', { type: 'number', min: '1', max: '20', value: '4' });
  const countLabelText = el('span', {}, 'Count ');
  const countWrap = el('label', { class: 'inline muted' }, countLabelText, countInput);
  // cURL content-verification inputs — only shown for the curl type. They let the
  // operator assert that the received traffic is correct, not just reachable.
  // Path-MTU inputs. Sizes are IP PACKET sizes — what an MTU is — and the same
  // bounds the server validates, so a typo is caught before it is a round trip.
  const minSize = el('input', { type: 'number', min: '576', max: '9216', value: '576' });
  const maxSize = el('input', { type: 'number', min: '576', max: '9216', value: '1500' });
  const perHop = el('input', { type: 'checkbox', checked: 'checked' });
  const mssPort = el('input', { type: 'number', min: '1', max: '65535', placeholder: 'off' });
  const mtuWrap = el('div', { class: 'mtu-inputs' },
    el('label', { class: 'inline muted' }, `${t('probe.mtu.minSize')} `, minSize),
    el('label', { class: 'inline muted' }, `${t('probe.mtu.maxSize')} `, maxSize),
    el('label', { class: 'inline muted' }, perHop, ` ${t('probe.mtu.perHop')}`),
    el('label', { class: 'inline muted' }, `${t('probe.mtu.tcpPort')} `, mssPort));
  const mtuHint = el('div', { class: 'muted small', style: 'flex-basis:100%' }, t('probe.pathMtuHint'));
  const curl = curlInputs();
  const tx = transactionStepsEditor([]);
  const txWrap = el('div', { class: 'tx-wrap' }, el('div', { class: 'muted small' }, 'Steps run in order; a step can extract a value (regex) for later steps as {{name}}. Stops at the first failure.'), tx.node);
  // Same three controls as the Connection test tab, for the same reason: one
  // sample proves nothing about a fault that comes and goes, a run that cannot
  // be called off is a run you wait out, and a probe worth running twice is
  // usually worth running on a schedule.
  const roundsInput = el('input', { type: 'number', min: '1', max: '20', value: '1', class: 'run-count' });
  const runBtn = el('button', { class: 'small run-btn' });
  const stopBtn = el('button', { class: 'small ghost', disabled: 'disabled' }, t('probe.stop'));
  const repeatBtn = canWrite() ? el('button', { class: 'small ghost' }, t('repeat.button')) : null;
  const repeatChipEl = el('span', { class: 'ct-chip', hidden: true });
  const status = el('div', { class: 'muted probe-status' });
  function syncRunLabel() {
    const n = Math.max(1, Math.min(20, Number(roundsInput.value) || 1));
    runBtn.replaceChildren(t('probe.rounds.prefix'), ' ', roundsInput, ' ', plural('probe.rounds', n, { n: String(n) }));
  }
  roundsInput.addEventListener('input', syncRunLabel);
  roundsInput.addEventListener('click', (e) => e.stopPropagation());
  syncRunLabel();
  // Why an operator would reach for the TCP trace over the plain one.
  const traceHint = el('div', { class: 'muted small', style: 'flex-basis:100%' }, t('probe.tcptracerouteHint'));
  // Both trace types take a per-hop probe count ("queries") rather than a count;
  // shared by the field toggling and the request body, so they cannot drift.
  const isTraceType = () => typeSel.value === 'traceroute' || typeSel.value === 'tcptraceroute';
  // For traceroute the count is the per-hop probe count ("queries") that MTR-style
  // sampling uses to derive per-hop loss/jitter (server caps it at 10).
  const syncPort = () => {
    // tcptraceroute also needs a port, because the port IS the question it answers.
    const isTcpTrace = typeSel.value === 'tcptraceroute';
    const tr = isTraceType();
    const isCurl = typeSel.value === 'curl';
    const isTx = typeSel.value === 'transaction';
    const isUrl = isCurl || typeSel.value === 'pageload';
    const isMtu = typeSel.value === 'path_mtu';
    mtuWrap.style.display = isMtu ? '' : 'none';
    mtuHint.style.display = isMtu ? '' : 'none';
    targetWrap.style.display = isTx ? 'none' : '';
    portWrap.style.display = (typeSel.value === 'tcp' || isTcpTrace) ? '' : 'none';
    traceHint.style.display = isTcpTrace ? '' : 'none';
    curl.wrap.style.display = isCurl ? '' : 'none';
    txWrap.style.display = isTx ? '' : 'none';
    // A path-MTU run has no "count": its repetition knob is probes-per-size,
    // which the agent defaults sensibly and the form does not need to expose.
    countWrap.style.display = (typeSel.value === 'pageload' || isTx || isMtu) ? 'none' : '';
    target.placeholder = isUrl ? 'e.g. https://example.com/' : 'e.g. 1.1.1.1 or example.com';
    countLabelText.textContent = tr ? 'Queries/hop ' : 'Count ';
    countInput.max = tr ? '10' : (isCurl ? '10' : '20');
    if (tr && Number(countInput.value) > 10) countInput.value = '3';
  };
  typeSel.addEventListener('change', syncPort); syncPort();

  root.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Agent ', agentSel),
    el('label', { class: 'inline muted' }, 'Type ', typeSel),
    targetWrap,
    portWrap,
    countWrap,
    curl.wrap,
    runBtn, stopBtn, repeatBtn, repeatChipEl, status, traceHint, mtuHint), mtuWrap, txWrap);

  const latestHost = el('div', { class: 'probe-latest' });
  // The refresh loop replaces the whole tbody, which would close an open row
  // every five seconds. Pausing is the smallest fix — but a table that has
  // quietly stopped updating is its own trap, so the pause SAYS so rather than
  // leaving the operator to wonder why the timestamps stopped moving.
  let detailOpen = false;
  const pauseNote = el('div', { class: 'muted small', hidden: true }, t('probe.row.paused'));
  root.append(el('details', { class: 'sec', open: true },
    el('summary', {}, 'Latest results ', el('span', { class: 'muted' }, '· most recent per target')),
    el('div', { class: 'muted small' }, t('probe.row.rowHelp')), pauseNote, latestHost));

  // The form as a probe spec, or the reason it is not one yet. Read by Run and
  // by Repeat, so a scheduled probe is the same probe the button would send.
  function collectProbe() {
    if (typeSel.value === 'transaction') {
      const steps = tx.collect();
      if (!steps.length) return { error: 'Add at least one step with a URL.' };
      return { body: { type: 'transaction', steps } };
    }
    const host = target.value.trim();
    if (!host) return { error: 'Enter a target.' };
    const body = { type: typeSel.value, host };
    if (typeSel.value === 'tcp' || typeSel.value === 'tcptraceroute') body.port = Number(portInput.value);
    if (typeSel.value === 'curl') curl.apply(body);
    if (typeSel.value === 'path_mtu') {
      if (minSize.value) body.min_size = Number(minSize.value);
      if (maxSize.value) body.max_size = Number(maxSize.value);
      body.per_hop = perHop.checked;
      if (mssPort.value) body.tcp_port = Number(mssPort.value);
    }
    if (isTraceType() && countInput.value) body.queries = Number(countInput.value);
    else if ((typeSel.value === 'ping' || typeSel.value === 'tcp') && countInput.value) body.count = Number(countInput.value);
    return { body };
  }

  // Rounds are spaced rather than fired back to back: N probes queued in the
  // same instant measure the same instant, which is not what "run it 5 times"
  // is asking for.
  const ROUND_GAP_MS = 3000;
  let probeStopRequested = false;
  let probeRunning = false;

  async function run() {
    const id = agentSel.value;
    const { body, error } = collectProbe();
    if (error) { status.className = 'error probe-status'; status.textContent = error; return; }
    const rounds = Math.max(1, Math.min(20, Number(roundsInput.value) || 1));
    probeRunning = true; probeStopRequested = false;
    runBtn.disabled = true; stopBtn.disabled = false;
    status.className = 'muted probe-status';
    let done = 0;
    for (let round = 1; round <= rounds && !probeStopRequested; round += 1) {
      status.textContent = rounds === 1
        ? 'Sending…'
        : t('probe.round', { round: String(round), rounds: String(rounds), what: `${body.type} ${body.host || ''}`.trim() });
      try {
        await api(`/agents/${id}/probe`, { method: 'POST', body });
      } catch (e) {
        status.className = 'error probe-status';
        status.textContent = e.status === 409 ? 'The agent is not connected right now.' : errText(e);
        break;
      }
      done = round;
      setTimeout(refreshLatest, 2500); setTimeout(refreshLatest, 6000);
      if (round < rounds && !probeStopRequested) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, ROUND_GAP_MS));
      }
    }
    probeRunning = false;
    stopBtn.disabled = true;
    runBtn.disabled = false;
    if (probeStopRequested) { status.className = 'muted probe-status'; status.textContent = t('probe.stopped'); }
    else if (done && status.className !== 'error') {
      status.textContent = done === 1
        ? 'Sent — the agent is running it now; results will arrive in a moment.'
        : t('probe.roundsDone', { rounds: String(done) });
    }
  }
  runBtn.addEventListener('click', () => { if (!probeRunning) run(); });
  stopBtn.addEventListener('click', () => {
    probeStopRequested = true;
    stopBtn.disabled = true;
    status.className = 'muted probe-status';
    status.textContent = t('probe.stopped');
  });

  // Repeat: the probe on screen, saved as a scheduled test package for this
  // agent. Same dialog, same storage, same Test packages tab as everything else.
  if (repeatBtn) {
    repeatBtn.addEventListener('click', () => {
      const { body, error } = collectProbe();
      if (error) { status.className = 'error probe-status'; status.textContent = error; return; }
      const what = t('repeat.what.probe', { type: body.type, target: body.host || '' });
      openRepeatModal({
        what,
        onSave: (spec, runs) => saveRepeatPackage({
          name: `${body.type} — ${body.host || 'transaction'}`.slice(0, 120),
          agentId: agentSel.value,
          item: { type: 'probe', probe: body },
          spec,
          runs,
        }),
        onSaved: (pkg, summary) => repeatChip(repeatChipEl, pkg, summary),
      });
    });
  }

  async function refreshLatest() {
    const id = agentSel.value;
    let data;
    try { data = await api(`/api/probes/latest?agentId=${encodeURIComponent(id)}`); } catch { return; }
    const rows = data.results || [];
    latestHost.replaceChildren(probeLatestTable(
      rows,
      (r) => probeDetail(r, agentSel.value),
      (tool, r, btn) => requestToolInstall(agentSel.value, tool, btn),
      (isOpen) => { detailOpen = isOpen; pauseNote.hidden = !isOpen; },
    ));
  }

  refreshLatest();
  stopProbes();
  // Guard against the async TOCTOU: if a tab switch happened during the awaits
  // above, render() already cleared the timer — self-clear instead of leaking.
  probeState.timer = setInterval(() => {
    if (currentView !== 'probes') { stopProbes(); return; }
    if (!modalOpen() && !detailOpen) refreshLatest();
  }, 5000);
  return root;
};

// ---- Fleet overview + combined agent page ---------------------------------

let selectedAgentId = null;
function openAgent(id) { selectedAgentId = id; currentView = 'agent'; render(); }

// Location drill-down (no tab of its own — reached by clicking a location on
// the agent page, the Locations list or a site pin on a traffic map).
let selectedLocationId = null;
function openLocation(id) { selectedLocationId = id; currentView = 'location'; render(); }

// Deep-link into the flow explorer for an agent, optionally pre-filling a
// peer/port (used by global search). views.flows consumes + clears the prefill.
let flowsPrefill = null;
function openFlows(agentId, prefill) { selectedAgentId = agentId; flowsPrefill = Object.assign({ agentId }, prefill || {}); currentView = 'flows'; render(); }

// Downloads an authenticated endpoint as a file (Bearer token; the dashboard's
// api() parses JSON, so blob downloads go through here instead).
async function downloadAuthed(path, filename) {
  try {
    const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { toast(`Export failed: ${e.message}`, true); }
}

// Opens a print-friendly investigation summary in a new window and triggers the
// browser's print dialog (→ "Save as PDF"). No server-side PDF dependency.
async function printInvestigation(id) {
  let b;
  try { b = await api(`/api/export/investigation?agentId=${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); return; }
  const e2 = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = (arr, cols, cspan) => ((arr && arr.length) ? arr.map((r) => `<tr>${cols.map((c) => `<td>${e2(typeof c === 'function' ? c(r) : r[c])}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cspan}" class="muted">None.</td></tr>`);
  const q = b.quality || {}; const h = b.health || { status: '', reason: '' };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BlueEyes investigation — ${e2(b.agent.displayName)}</title>
<style>body{font:13px/1.5 system-ui,-apple-system,sans-serif;margin:24px;color:#0f172a}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #cbd5e1;padding-bottom:4px}table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #e2e8f0;padding:4px 8px;text-align:left;font-size:12px}.muted{color:#64748b}.badge{padding:1px 7px;border-radius:4px;background:#e2e8f0;font-weight:600}</style>
</head><body>
<h1>Investigation — ${e2(b.agent.displayName)}</h1>
<p class="muted">${e2(b.agent.hostname)}${b.agent.locationName ? ' · ' + e2(b.agent.locationName) : ''} · generated ${e2(b.generatedAt)}<br>window ${e2(b.window.from)} – ${e2(b.window.to)}</p>
<h2>Health</h2><p><span class="badge">${e2(String(h.status).toUpperCase())}</span> ${e2(h.reason)}</p>
<p class="muted">Data quality: ${e2(q.status)} — ${e2(q.reason)}${q.version ? ' · agent v' + e2(q.version) : ''}</p>
<h2>Latest probes</h2><table><thead><tr><th>Type</th><th>Target</th><th>Status</th><th>RTT</th><th>Loss</th><th>Jitter</th></tr></thead><tbody>${rows(b.latestProbes, ['type', 'target', (r) => (r.ok ? 'ok' : 'error'), (r) => (r.rttMs != null ? r.rttMs + ' ms' : '–'), (r) => (r.lossPct != null ? r.lossPct + '%' : '–'), (r) => (r.jitterMs != null ? r.jitterMs + ' ms' : '–')], 6)}</tbody></table>
<h2>Interfaces</h2><table><thead><tr><th>Interface</th><th>Status</th><th>Utilisation</th><th>Errors/s</th><th>Discards/s</th></tr></thead><tbody>${rows(b.interfaces, ['iface', 'status', (r) => (r.utilPct != null ? r.utilPct + '%' : '–'), 'errPerSec', 'dropPerSec'], 5)}</tbody></table>
<h2>Findings</h2><table><thead><tr><th>Time</th><th>Severity</th><th>Metric</th><th>Explanation</th></tr></thead><tbody>${rows(b.findings, [(r) => r.createdAt, 'severity', 'metric', 'explanation'], 4)}</tbody></table>
<h2>Top talkers</h2><table><thead><tr><th>Source</th><th>Destination</th><th>Org/Country</th><th>Bytes</th></tr></thead><tbody>${rows(b.flows && b.flows.topTalkers, ['srcIp', (r) => (r.dstIp || r.extIp || '–'), (r) => (r.internal ? 'internal' : [r.asnName, r.country].filter(Boolean).join(' ')), 'bytes'], 4)}</tbody></table>
${(b.flows && b.flows.scans && b.flows.scans.length) ? `<h2>Scans / fan-out</h2><table><thead><tr><th>Source</th><th>Type</th><th>Ports</th><th>Hosts</th></tr></thead><tbody>${rows(b.flows.scans, ['srcIp', 'kind', 'distinctPorts', 'distinctHosts'], 4)}</tbody></table>` : ''}
<script>window.onload=function(){setTimeout(function(){window.print();},300);};</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print', true); return; }
  w.document.write(html);
  w.document.close();
}

// Small modal offering the investigation export formats for one agent.
function exportInvestigationMenu(id, name) {
  const card = $('#modal-card');
  card.replaceChildren(
    el('h3', {}, `Export investigation — ${name}`),
    el('p', { class: 'muted' }, 'A snapshot of the last 24 hours: health, data quality, interfaces, latest probes, findings and top talkers.'),
    el('div', { class: 'form-actions' },
      el('button', { onclick: () => downloadAuthed(`/api/export/investigation?agentId=${encodeURIComponent(id)}&format=json`, `investigation-${id}.json`) }, 'JSON'),
      el('button', { class: 'ghost', onclick: () => downloadAuthed(`/api/export/investigation?agentId=${encodeURIComponent(id)}&format=csv`, `investigation-${id}.csv`) }, 'CSV'),
      el('button', { class: 'ghost', onclick: () => { closeModal(); printInvestigation(id); } }, 'Print / PDF'),
      el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
  $('#modal').classList.remove('hidden');
}

// Global search (topbar): the universal entry point (Fase 1). One field takes
// whatever the technician knows — an IP, a MAC, a hostname, a site, an agent, a
// service — and lands them on the right screen.
//
// Results are grouped by type and every row shows its SOURCE and its AGE. That
// is not decoration: a hit built on an ARP entry from three weeks ago and one
// built on this morning's capabilities report look identical without it, and
// only one of them is worth driving to a site for.
//
// Backed by GET /api/search. Focus shortcut ("/") and the topbar pill already
// exist — see the #topbar-search wiring at the bottom of this file.

// type -> the i18n key for its group heading.
const SEARCH_GROUP_ORDER = ['ip', 'mac', 'host', 'device', 'site', 'service', 'event', 'ticket', 'ipam', 'asset', 'user'];

// Turns a hit's `target` into a navigation action, or null when the hit is
// informational only (a CMDB asset has no screen in this product).
function searchTargetAction(hit) {
  const t = String(hit.target || '');
  let m;
  if ((m = t.match(/^agent:(\d+)$/))) return () => openAgent(Number(m[1]));
  if ((m = t.match(/^location:(\d+)$/))) return () => openLocation(Number(m[1]));
  if ((m = t.match(/^flows:port:(\d+)$/))) return () => openFlows(null, { port: Number(m[1]) });
  if ((m = t.match(/^flows:(\d+):port:(\d+)$/))) return () => openFlows(Number(m[1]), { port: Number(m[2]) });
  if ((m = t.match(/^flows:(\d+):(.+)$/))) return () => openFlows(Number(m[1]), { peer: m[2] });
  if (t.startsWith('discovered:')) return () => { currentView = 'discovery'; render(); };
  if ((m = t.match(/^event:(\d+)$/))) return () => openEvent(Number(m[1]));
  if ((m = t.match(/^cluster:(\d+)$/))) return () => openCluster(Number(m[1]));
  // A hit that lives in another system (ITSM ticket, IPAM prefix) carries a deep
  // link instead of a screen here. The server only ever emits http(s) urls.
  if (hit.url && /^https?:\/\//i.test(hit.url)) return () => window.open(hit.url, '_blank', 'noopener');
  return null;
}

// One result row: name, then the provenance line the whole feature turns on.
function searchHitEl(hit, onNavigate) {
  const action = searchTargetAction(hit);
  const meta = el('span', { class: 'search-meta muted small' },
    el('span', { class: `search-conf conf-${hit.confidence}` }, t(`search.confidence.${hit.confidence}`)),
    ' · ',
    t('search.source', { source: hit.source }),
    ' · ',
    hit.last_seen ? t('search.lastSeen', { when: relTime(hit.last_seen) }) : t('search.lastSeenNever'));

  const body = el('span', { class: 'search-item-body' },
    el('span', { class: 'search-name' }, hit.display_name, hit.url ? ' ↗' : ''),
    hit.detail ? el('span', { class: 'search-detail muted small' }, hit.detail) : null,
    meta);

  // A hit with nowhere to go renders as a non-interactive row rather than a
  // button that does nothing when clicked.
  if (!action) return el('div', { class: 'search-item is-static' }, body);
  return el('button', {
    class: 'search-item',
    onclick: () => { if (typeof onNavigate === 'function') onNavigate(); action(); },
  }, body);
}

async function globalSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  const card = $('#modal-card');
  const title = () => el('h3', {}, `${t('search.title')}: ${q}`);
  const closeBtn = () => el('div', { class: 'form-actions' },
    el('button', { class: 'ghost', onclick: closeModal }, t('search.close')));

  card.replaceChildren(title(), el('div', { class: 'muted' }, t('search.loading')));
  $('#modal').classList.remove('hidden');

  let data;
  try {
    data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  } catch (e) {
    // A too-short query is a 400 with a specific message; surface it rather than
    // a generic failure, so the user knows to keep typing.
    card.replaceChildren(title(), el('p', { class: 'error' }, t('search.error', { message: errText(e) })), closeBtn());
    return;
  }

  const kids = [title()];
  const hits = data.hits || [];

  if (data.partial && (data.failedSources || []).length) {
    kids.push(el('p', { class: 'warn small' }, t('search.partial', { sources: data.failedSources.join(', ') })));
  }

  if (!hits.length) {
    kids.push(el('div', { class: 'empty' },
      el('p', {}, t('search.empty', { q: q })),
      el('p', { class: 'muted small' }, t('search.emptyHint'))));
  } else {
    kids.push(el('p', { class: 'muted small' }, t('search.resultCount', { count: data.total })));
    // Group in the fixed order above so the layout does not reshuffle between
    // searches — a moving target is harder to scan under pressure.
    const byType = new Map();
    hits.forEach((h) => {
      if (!byType.has(h.type)) byType.set(h.type, []);
      byType.get(h.type).push(h);
    });
    for (const type of SEARCH_GROUP_ORDER) {
      const group = byType.get(type);
      if (!group || !group.length) continue;
      kids.push(el('h4', {}, t(`search.group.${type}`)));
      kids.push(el('div', { class: 'search-list' }, ...group.map((h) => searchHitEl(h, closeModal))));
    }
    if (data.truncated) {
      kids.push(el('p', { class: 'muted small' },
        t('changes.truncated', { shown: hits.length, total: data.total })));
    }
  }

  kids.push(closeBtn());
  card.replaceChildren(...kids);
}


// ---- Changes: the landing page (Fase 2) ------------------------------------
// A status dashboard full of green answers a question nobody asked. The shift
// starts with "what happened while I was away", so THIS is the default route
// and the fleet grid moved to its own (it is still the right screen for bulk
// operations — it was never the right screen to open on).
//
// Backed by GET /api/changes. Rows reuse the shared timeline event shape, so
// they render through TimelineView.renderRow rather than a second row renderer
// that would drift from the timeline's.

// Window presets offered in the picker, plus the "since I last looked" mode
// that is the whole point.
const CHANGES_WINDOWS = ['30m', '6h', '24h', '7d'];
let changesWindow = '24h';
let changesSince = 'last_login';

function changesRowEl(event, nameFor, showIndication = true) {
  // formatTime: without it renderRow falls back to String(iso) and the column
  // renders raw `2026-07-31T11:05:05.000Z` — every other timeline passes fmtDate.
  const row = window.TimelineView.renderRow(document, event, { formatTime: fmtDate });
  // A current-state row must not read as "this happened in your window": we
  // know the condition, not when it began (heartbeat and agent version are not
  // transition-logged). Labelling it is the honest option; inferring a start
  // time would be inventing history.
  if (event.currentState) {
    row.classList.add('chg-current');
    // Short on the row, full sentence on hover: the long form is a whole clause
    // and reads as a paragraph when it sits inline on every stale-agent row.
    row.append(el('span', {
      class: 'badge chg-current-badge',
      title: t('changes.currentState'),
    }, t('changes.currentStateShort')));
  }

  // How many occurrences this row stands for. A condition that keeps coming back
  // is a different problem from one that fired once, and the count IS that
  // diagnosis — so it goes on the row, with the span it happened over, rather
  // than being implied by rows the reader has to count themselves.
  const count = Number(event.count) || 1;
  if (count > 1) {
    row.classList.add('chg-recurring');
    row.append(el('span', {
      class: 'badge chg-count',
      title: event.firstAt ? t('changes.recurrenceSince', { when: fmtDate(event.firstAt) }) : null,
    }, t('changes.recurrence', { count })));
  }
  // Anomalies folded into this event. Says outright that the detail exists and
  // where it is, instead of leaving the reader to wonder what the event covers.
  const folded = Number(event.findingCount) || 0;
  if (folded > 0) row.append(el('span', { class: 'badge neutral chg-folded' }, t('changes.foldedAnomalies', { count: folded })));

  // Deep-link into whatever the row is about.
  if (event.agentId != null) {
    row.append(el('button', {
      class: 'small ghost chg-open',
      onclick: () => openAgent(Number(event.agentId)),
    }, nameFor(event.agentId)));
  } else if (event.kind === 'event' && event.ref_id != null) {
    row.append(el('button', { class: 'small ghost chg-open', onclick: () => openEvent(Number(event.ref_id)) }, '→'));
  } else if (event.kind === 'cluster' && event.ref_id != null) {
    row.append(el('button', { class: 'small ghost chg-open', onclick: () => openCluster(Number(event.ref_id)) }, '→'));
  }

  // "What does this indicate?" — one local, deterministic sentence per condition
  // family (src/changes/indications.js decides the family; the wording lives in
  // the catalogues). A row with no recognised family simply carries no line,
  // which is the honest outcome: we do not invent an interpretation.
  //
  // Appended INSIDE the <li> (the row is a wrapping flexbox and .chg-indicates
  // takes a full basis) rather than as a sibling — the feed's parent is a <ul>,
  // where a bare <div> would be invalid.
  // Only on the FIRST row of a run of the same condition. The sentence is per
  // FAMILY, not per row, so a group of eight latency events repeated it verbatim
  // eight times — doubling the height of the feed to say one thing. Printed once
  // at the head of the run, it still explains every row under it.
  if (event.family && showIndication) {
    row.append(el('div', { class: 'chg-indicates muted small' }, t(`changes.indicates.${event.family}`)));
  }
  return row;
}

// ---- Changes (MIGRATED — see public/views/changes.js) ----------------------
// The first screen on the UI contract (docs/ui-contract.md). The view itself
// lives in its own file so `npm run ui:check` can hold it to the contract while
// the screens around it are still on the old chrome; app.js keeps the state the
// screen must not own — the chosen window and the reference marker both outlive
// the view, and the marker moves only on an explicit "Mark as seen".
let changesView = null;
function getChangesView() {
  if (changesView) return changesView;
  if (typeof window === 'undefined' || !window.ChangesView || !ui) return null;
  changesView = window.ChangesView.create({
    el, api, t, errText, openAgent, ui,
    WINDOWS: CHANGES_WINDOWS,
    getWindow: () => changesWindow,
    setWindow: (w) => { if (CHANGES_WINDOWS.includes(w)) changesWindow = w; },
    setSince: (s) => { changesSince = s; },
    feedPath: () => {
      const qs = new URLSearchParams({ window: changesWindow });
      if (changesSince) qs.set('since', changesSince);
      return `/api/changes?${qs.toString()}`;
    },
    exportCsv: () => exportChangesCsv(),
  });
  return changesView;
}

views.changes = async () => {
  const v = getChangesView();
  return v ? v.view() : el('div', { class: 'empty error' }, t('changes.error', { message: 'view module not loaded' }));
};

// The export the toolbar offers. A CSV of what is on screen is the answer to
// "send me that list", and it is the server's own feed rather than the rendered
// rows, so a truncated page does not become a truncated export.
async function exportChangesCsv() {
  try {
    const qs = new URLSearchParams({ window: changesWindow });
    if (changesSince) qs.set('since', changesSince);
    const data = await api(`/api/changes?${qs.toString()}`);
    const rows = [['time', 'severity', 'kind', 'type', 'summary', 'agent', 'count']];
    for (const e of data.events || []) {
      rows.push([e.timestamp, e.severity, e.kind, e.type, e.summary, e.agentId == null ? '' : e.agentId, e.count || 1]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = el('a', { href: url, download: `changes-${changesWindow}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ui.toast(t('changes.exported'), t('changes.exportedDetail', { n: (data.events || []).length }));
  } catch (err) {
    ui.toast(t('changes.err.title'), errText(err), { bad: true });
  }
}

const fleetState = { timer: null };
function stopFleet() { if (fleetState.timer) { clearInterval(fleetState.timer); fleetState.timer = null; } }

// Shared Overview filter state. Kept at module scope (not inside views.fleet) so
// it survives a view switch and the 10 s poll, and is seeded from the URL query
// string on load so a shared deep-link (…?severity=CRIT&site=vest) renders
// pre-filtered. `sortByHealth` is the "Fleet health" card's sort mode (a sort,
// not a filter, so it stays out of the persisted filter shape).
// The global cross-view filter state (severity / site / healthBelow / offline).
// Shared by the Overview and the Delta/Changes view — one state, one URL, not a
// per-view copy. Any view that reads it does so through this module-level var.
let fleetFilter = FleetFilter.parseQuery(window.location.search);
let fleetSortByHealth = false;
// The query keys the global filter owns — cleared before re-serialising so a
// dropped dimension leaves the URL, without disturbing OTHER views' params
// (topology ?layer/?focus, delta ?changeTypes). This merge is what lets the
// global filter coexist across views instead of clobbering their state.
const FLEET_PARAM_KEYS = ['severity', 'site', 'healthBelow', 'offline'];
// Mirror the current filter into the URL (replaceState so it doesn't spam the
// history stack) — this is what makes a filtered view shareable as a link.
function syncFleetUrl() {
  try {
    const q = new URLSearchParams(window.location.search || '');
    FLEET_PARAM_KEYS.forEach((k) => q.delete(k));
    new URLSearchParams(FleetFilter.toQuery(fleetFilter)).forEach((v, k) => q.set(k, v));
    const qs = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  } catch { /* non-browser / restricted */ }
}
function summaryTotal(s) {
  if (!s) return 0;
  if (typeof s.total === 'number') return s.total;
  return (s.ok || 0) + (s.warn || 0) + (s.bad || 0) + (s.down || 0) + (s.stale || 0) + (s.unknown || 0);
}
const agentState = { timer: null };
function stopAgent() { if (agentState.timer) { clearInterval(agentState.timer); agentState.timer = null; } }

// Health verdict → badge (reuses the existing badge palette). title = reason.
const HEALTH_BADGE = {
  ok: ['online', 'HEALTHY'], warn: ['warn', 'WARNING'], bad: ['crit', 'CRITICAL'],
  down: ['down', 'DOWN'], stale: ['stale', 'STALE'], unknown: ['grace', 'UNKNOWN'],
};
function healthBadge(h) {
  const [cls, label] = HEALTH_BADGE[h.status] || ['grace', h.status];
  return el('span', { class: `badge ${cls}`, title: h.reason || '' }, label);
}
// Health verdict → map-marker colour (same palette as the badges / Overview) and
// a severity rank so a site marker can take the colour of its worst agent.
const HEALTH_COLOR = { ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444', down: '#ef4444', stale: '#94a3b8', unknown: '#94a3b8' };
const HEALTH_RANK = { bad: 0, down: 0, warn: 1, stale: 2, unknown: 3, ok: 4 };
function healthColor(status) { return HEALTH_COLOR[status] || '#94a3b8'; }
function worstHealthStatus(statuses) {
  let worst = null;
  let rank = Infinity;
  for (const s of statuses) { const r = HEALTH_RANK[s] ?? 3; if (r < rank) { rank = r; worst = s; } }
  return worst;
}
// Latency cell: highlights + shows the baseline when the latest is elevated.
function latencyText(m) {
  if (!m || m.rttMs == null) return '–';
  if (m.baselineMs && m.latencyZ >= 3) return el('span', { class: 'warn-text' }, `${m.rttMs} ms `, el('span', { class: 'muted' }, `/ ~${m.baselineMs}`));
  return `${m.rttMs} ms`;
}
// Throughput cell: latest speed test as ↓down / ↑up Mbps (from the agent's last
// run). A failed test reads "failed"; no test yet reads "–".
function throughputText(t) {
  if (!t) return '–';
  if (!t.ok) return el('span', { class: 'muted', title: t.ts ? fmtDate(t.ts) : '' }, 'failed');
  const d = t.downMbps != null ? t.downMbps : '?';
  const u = t.upMbps != null ? t.upMbps : '?';
  return el('span', { title: t.ts ? fmtDate(t.ts) : '' }, `↓${d} / ↑${u}`);
}

// ---- Overview NOC dashboard (KPI cards + live network path) ----------------
// Both are derived from the same /api/fleet/health payload the Overview already
// polls, so they refresh live with the table, and both are recomputed for the
// active location scope so they reflect just that site. KPI thresholds mirror
// the health model documented in PAGE_INFO.fleet (loss ≥2/20 %, jitter ≥30/100 ms).
function fleetKpis(data) {
  const agents = (data && data.agents) || [];
  const s = (data && data.summary) || {};
  const vals = (pick) => agents
    .map((a) => (a.health && a.health.metrics ? a.health.metrics[pick] : null))
    .filter((v) => v != null && Number.isFinite(v));
  const median = (arr) => {
    if (!arr.length) return null;
    const x = [...arr].sort((a, b) => a - b);
    const m = x.length >> 1;
    return x.length % 2 ? x[m] : Math.round((x[m - 1] + x[m]) / 2);
  };
  const loss = vals('lossPct');
  const crit = (s.bad || 0) + (s.down || 0);
  return {
    latency: median(vals('rttMs')),
    loss: loss.length ? Math.max(...loss) : null,
    jitter: median(vals('jitterMs')),
    online: agents.filter((a) => a.online).length,
    total: agents.length,
    paths: vals('targets').reduce((a, b) => a + b, 0),
    crit,
    warn: s.warn || 0,
    alerts: crit + (s.warn || 0),
  };
}
// `action` is an optional node rendered under the sub-line — used where the
// figure is a doorway to a heavier read the page does not do on load (the
// Troubleshooting screen's Active faults list, for one).
function kpiCard(label, value, sub, status, action) {
  const vCls = status === 'warn' ? ' v-warn' : status === 'bad' ? ' v-bad' : status === 'ok' ? ' v-ok' : '';
  return el('div', { class: `kpi st-${status}` },
    el('div', { class: 'kpi-k' }, label),
    el('div', { class: `kpi-v${vCls}` }, value),
    el('div', { class: 'kpi-sub muted' }, sub),
    action || null);
}
// The path a scoped set of agents' traffic takes to reach its monitored
// targets, drawn as an SVG: Origin → ISP uplink → Cloud egress → SaaS. Unlike
// a fixed schematic, every element is live and genuinely reflects the current
// scope. The origin node names the selected site (or the whole fleet) and its
// online agents; each segment's colour, label and tooltip are driven by that
// scope's own probe metrics — packet loss on the local access link, median
// RTT + jitter on the WAN uplink, target reachability on the SaaS leg — and
// the SaaS node shows the real count of monitored targets. Scoping to one
// location drops the second "Branch" origin (a fleet-only concept) and
// recomputes every segment, so the picture visibly changes with the selector.
// `scopeName` is the selected location's name (null = whole fleet).
function networkPath(data, k, scopeName = null) {
  const s = (data && data.summary) || {};
  const agents = (data && data.agents) || [];
  const scoped = scopeName != null;
  const met = (a) => (a.health && a.health.metrics) || {};
  const sum = (pick) => agents.reduce((n, a) => n + (Number(met(a)[pick]) || 0), 0);
  const online = agents.filter((a) => a.online).length;
  const total = agents.length;
  const targets = sum('targets');
  const reachable = sum('reachable');
  const unreachable = sum('unreachable');
  const siteIds = new Set();
  for (const a of agents) siteIds.add(a.locationId != null ? `l${a.locationId}` : `a${a.agentId}`);
  const sites = siteIds.size;

  // Per-segment health, ok < warn < bad, from the scope's own metrics.
  const RANK = { ok: 0, warn: 1, bad: 2 };
  const worst = (...ls) => ls.reduce((m, l) => (RANK[l] > RANK[m] ? l : m), 'ok');
  const band = (v, warn, bad) => (v == null ? 'ok' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
  const accessLvl = band(k.loss, 2, 20);                       // packet loss on the local access link
  const wanLvl = worst(band(k.jitter, 30, 100), k.crit > 0 ? 'warn' : 'ok'); // jitter/critical on the uplink
  const saasLvl = targets === 0 ? 'ok' : reachable === 0 ? 'bad' : unreachable > 0 ? 'warn' : 'ok';
  const branchLvl = (s.down || 0) + (s.stale || 0) > 0 ? 'warn' : 'ok';
  const originLvl = total === 0 ? 'warn' : online === 0 ? 'bad'
    : ((s.down || 0) + (s.stale || 0) > 0 || online < total) ? 'warn' : 'ok';

  const shownUnit = (v, unit) => (v == null ? '–' : `${v}${unit}`);
  const clip = (t, n) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const originTitle = scoped ? clip(scopeName, 13) : 'Fleet';
  const originSub = scoped ? `${online}/${total} agents up`
    : `${sites} site${sites === 1 ? '' : 's'} · ${online}/${total} up`;
  const accessLab = k.loss != null ? `${k.loss}% loss` : (targets ? 'no loss' : null);
  const wanLab = k.latency != null ? `${k.latency} ms` : null;
  const saasLab = targets ? `${reachable}/${targets} up` : null;
  const originTip = `${scoped ? scopeName : 'Whole fleet'} — ${online} of ${total} agents online`
    + ` across ${sites} site${sites === 1 ? '' : 's'}`;
  const accessTip = `Local access — worst packet loss ${shownUnit(k.loss, '%')} across ${total} agent${total === 1 ? '' : 's'}`;
  const wanTip = `WAN uplink — median RTT ${shownUnit(k.latency, ' ms')}, jitter ${shownUnit(k.jitter, ' ms')}`;
  const saasTip = `SaaS reachability — ${reachable}/${targets} monitored target${targets === 1 ? '' : 's'} responding`;

  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) if (v != null) e.setAttribute(a, v);
    for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const cls = (base, lvl) => `${base}${lvl === 'warn' ? ' degraded' : lvl === 'bad' ? ' bad' : ''}`;
  // Compact strip: low nodes on one row, the Branch origin tucked underneath —
  // roughly half the height of the original schematic (see CHANGELOG 0.96.0).
  const NW = 120, NH = 44, top = 22, cy = top + NH / 2;
  const X = { HQ: 20, ISP: 220, CL: 420, SA: 620 };
  const node = (x, title, sub, lvl, edge, tip) => mk('g', { class: `np-node${edge ? ' edge' : ''}${lvl && lvl !== 'ok' ? ` ${lvl}` : ''}` },
    tip ? mk('title', {}, tip) : null,
    mk('rect', { x, y: top, width: NW, height: NH, rx: 9 }),
    mk('circle', { cx: x + 15, cy: top + 14, r: 3.5, class: 'np-ico' }),
    mk('text', { x: x + 27, y: top + 18, class: 'np-t' }, title),
    mk('text', { x: x + 12, y: top + 35, class: 'np-s' }, sub));
  const link = (x1, y1, x2, y2, lvl, label, tip) => {
    const g = mk('g', {},
      tip ? mk('title', {}, tip) : null,
      mk('line', { x1, y1, x2, y2, class: cls('np-link', lvl), 'stroke-linecap': 'round' }),
      mk('line', { x1, y1, x2, y2, class: cls('np-flow', lvl), 'stroke-linecap': 'round' }));
    if (label) g.append(mk('text', { x: (x1 + x2) / 2, y: Math.min(y1, y2) - 7, 'text-anchor': 'middle', class: cls('np-lab', lvl) }, label));
    return g;
  };
  const Bx = 320, By = 108, BNH = 38;
  const overall = worst(originLvl, accessLvl, wanLvl, saasLvl, scoped ? 'ok' : branchLvl);
  const statusTxt = overall === 'bad' ? 'Critical segment' : overall === 'warn' ? 'Degraded segment detected' : 'All segments nominal';
  const ariaLabel = `Network path for ${scoped ? scopeName : 'the whole fleet'} — origin, ISP, cloud, SaaS — ${statusTxt.toLowerCase()}`;
  const branchTip = `Other sites — ${(s.down || 0) + (s.stale || 0)} agent(s) down or stale`;
  // Scoped views drop the Branch row entirely, so the strip gets even shorter.
  const svg = mk('svg', { viewBox: `0 0 820 ${scoped ? 78 : 156}`, role: 'img', 'aria-label': ariaLabel },
    link(X.HQ + NW, cy, X.ISP, cy, accessLvl, accessLab, accessTip),
    link(X.ISP + NW, cy, X.CL, cy, wanLvl, wanLab, wanTip),
    link(X.CL + NW, cy, X.SA, cy, saasLvl, saasLab, saasTip),
    scoped ? null : link(Bx + NW / 2, By, X.ISP + NW / 2, top + NH, branchLvl, null, branchTip),
    node(X.HQ, originTitle, originSub, originLvl, true, originTip),
    node(X.ISP, 'ISP', 'WAN uplink', wanLvl, false, wanTip),
    node(X.CL, 'Cloud', 'Egress / IXP', saasLvl, false, saasTip),
    node(X.SA, 'SaaS', targets ? `${targets} target${targets === 1 ? '' : 's'}` : 'Applications', saasLvl, false, saasTip),
    scoped ? null : mk('g', { class: `np-node edge${branchLvl !== 'ok' ? ` ${branchLvl}` : ''}` },
      mk('title', {}, branchTip),
      mk('rect', { x: Bx, y: By, width: NW, height: BNH, rx: 9 }),
      mk('circle', { cx: Bx + 15, cy: By + 13, r: 3.5, class: 'np-ico' }),
      mk('text', { x: Bx + 27, y: By + 17, class: 'np-t' }, 'Branch'),
      mk('text', { x: Bx + 12, y: By + 32, class: 'np-s' }, 'Remote sites')));
  return el('div', { class: 'netpath' },
    el('div', { class: 'netpath-head' },
      el('h3', {}, 'Network path'),
      scopeName ? el('span', { class: 'netpath-scope' }, scopeName) : null,
      el('span', { class: overall === 'bad' ? 'bad-text' : overall === 'warn' ? 'warn-text' : 'muted' }, statusTxt),
      el('div', { class: 'netpath-legend' },
        el('span', { class: 'lg' }, el('span', { class: 'ln normal' }), 'Normal path'),
        el('span', { class: 'lg' }, el('span', { class: 'ln degraded' }), 'Degraded'),
        el('span', { class: 'lg' }, el('span', { class: 'ln bad' }), 'Critical'))),
    svg);
}
function nocDashboard(data, { controls = null, scopeName = null } = {}) {
  const k = fleetKpis(data);
  const lossStatus = k.loss == null ? 'accent' : k.loss >= 20 ? 'bad' : k.loss >= 2 ? 'warn' : 'ok';
  const jitStatus = k.jitter == null ? 'accent' : k.jitter >= 100 ? 'bad' : k.jitter >= 30 ? 'warn' : 'ok';
  const agStatus = k.total && k.online === 0 ? 'bad' : k.online < k.total ? 'warn' : 'ok';
  const alStatus = k.crit ? 'bad' : k.alerts ? 'warn' : 'ok';
  return el('div', { class: 'noc' },
    controls ? el('div', { class: 'noc-head' }, controls) : null,
    el('div', { class: 'noc-kpis' },
      kpiCard('Latency', k.latency == null ? '–' : `${k.latency} ms`, 'median RTT', 'accent'),
      kpiCard('Packet loss', k.loss == null ? '–' : `${k.loss}%`, 'worst agent', lossStatus),
      kpiCard('Jitter', k.jitter == null ? '–' : `${k.jitter} ms`, 'median', jitStatus),
      kpiCard('Active agents', `${k.online}`, `of ${k.total} total`, agStatus),
      kpiCard('Test paths', `${k.paths}`, 'monitored targets', 'accent'),
      kpiCard('Alerts', `${k.alerts}`, k.crit ? `${k.crit} critical` : (k.warn ? `${k.warn} warning` : 'all clear'), alStatus)),
    networkPath(data, k, scopeName));
}

// Overview "Open issues" section (licence feature dashboard_advanced, Pro+):
// the active events and the most-recent unacknowledged analysis findings,
// side by side. Composed from data the server already holds (no new collection)
// and rendered with the compact .panel-grid / .adv-table styling. Rows that map
// to an agent drill into its combined page.
function fleetIssues(w) {
  if (!w) return el('div', {});
  const count = (n) => el('span', { class: 'muted fi-count' }, n ? ` · ${n}` : '');

  const inc = el('div', { class: 'card' }, el('h3', {}, 'Active events', count(w.events.active)));
  if (!w.events.recent.length) inc.append(el('p', { class: 'muted' }, 'No active events.'));
  else inc.append(el('table', { class: 'adv-table' }, el('tbody', {}, ...w.events.recent.map((i) =>
    el('tr', i.agentId ? { class: 'clickable', onclick: () => openAgent(i.agentId) } : {},
      el('td', {}, el('span', { class: `badge ${i.severity === 'critical' ? 'crit' : 'warn'}` }, i.severity)),
      el('td', {}, i.agentName || `agent ${i.agentId}`, i.locationName ? el('span', { class: 'muted' }, ` · ${i.locationName}`) : null),
      el('td', {}, i.metric),
      el('td', { class: 'muted' }, fmtDate(i.startedAt)))))));

  const fnd = el('div', { class: 'card' }, el('h3', {}, 'Recent findings', count(w.findings.open)));
  if (!w.findings.recent.length) fnd.append(el('p', { class: 'muted' }, 'No open analysis findings.'));
  else fnd.append(el('table', { class: 'adv-table' }, el('tbody', {}, ...w.findings.recent.map((x) =>
    el('tr', {},
      el('td', {}, el('span', { class: `badge ${x.severity === 'CRIT' ? 'crit' : x.severity === 'WARN' ? 'warn' : 'grace'}` }, x.severity)),
      el('td', {}, x.hostId, el('span', { class: 'muted' }, ` · ${x.metric}`)),
      el('td', { class: 'muted' }, x.explanation || x.kind || ''))))));

  // First-class events (event_cases) — open/investigating cases; click a
  // row to open its detail page. Guarded for older servers without the widget.
  const ic = w.eventCases || { open: 0, recent: [] };
  const cases = el('div', { class: 'card' }, el('h3', {}, 'Open events', count(ic.open)));
  if (!ic.recent.length) cases.append(el('p', { class: 'muted' }, 'No open events.'));
  else cases.append(el('table', { class: 'adv-table' }, el('tbody', {}, ...ic.recent.map((c) =>
    el('tr', { class: 'clickable', onclick: () => openEvent(c.id) },
      el('td', {}, el('span', { class: `badge inc-sev-${c.severity}` }, c.severity)),
      el('td', {}, c.title,
        // Where it is — same agent · site pair the probe-outage rollup shows, so
        // a case can be placed without opening it.
        el('div', { class: 'muted inc-where' }, eventWhere(c))),
      el('td', {}, el('span', { class: `badge inc-status-${c.status}` }, INC_STATUS_LABEL[c.status] || c.status)),
      el('td', { class: 'muted' }, fmtDate(c.lastEventAt)))))));

  return el('section', { class: 'fleet-issues' },
    el('h3', { class: 'fi-head' }, 'Open issues',
      el('span', { class: 'muted' }, ' · open events, probe outages & recent analysis findings')),
    el('div', { class: 'panel-grid' }, cases, inc, fnd));
}

// The landing view: all agents with a probe-derived health verdict, worst-first.
// Click a row to pivot into that agent's combined detail page. For Professional+
// licences it also surfaces an "Open issues" rollup (events + findings).
// ---- Fleet (MIGRATED — see public/views/fleet.js) ---------------------------
// Built lazily: `ui` is declared far down this file. app.js keeps what outlives
// the view — the cross-view fleet filter, the health sort, and the 10 s poll —
// and hands the view the three panels that are not the contract's: the NOC
// header, the traffic map and the licence-gated issues rollup.
let fleetView = null;
const fleetViewState = {};
function getFleetView() {
  if (fleetView) return fleetView;
  if (typeof window === 'undefined' || !window.FleetView || !ui) return null;
  fleetView = window.FleetView.create({
    el, t, ui, FleetFilter,
    state: fleetViewState,
    errText,
    openAgent, gotoView,
    summaryTotal,
    latencyText,
    throughputText,
    // The health verdict as a contract Badge rather than the legacy .badge.
    healthBadgeUi: (h) => {
      const [cls, label] = HEALTH_BADGE[(h && h.status) || 'unknown'] || HEALTH_BADGE.unknown;
      const tone = { online: 'ok', warn: 'warn', crit: 'crit', down: 'crit', stale: 'neutral', grace: 'neutral' }[cls] || 'neutral';
      return ui.badge(tone, label);
    },
    filter: () => fleetFilter,
    setFilter: (next) => { fleetFilter = next; },
    getSortByHealth: () => fleetSortByHealth,
    setSortByHealth: (v) => { fleetSortByHealth = v; },
    syncUrl: () => syncFleetUrl(),
    help: () => {
      const info = PAGE_INFO.fleet || {};
      return { lead: info.hero || '', title: info.title || t('fleet.title'), body: info.body || (() => []) };
    },
    // Filtering is client-side on the dataset the page already holds. Only for a
    // large fleet (>500 agents) is the severity filter offloaded to the server
    // to shrink the payload; the summary stays whole-fleet either way, so the
    // StatStrip counts remain correct.
    fetchHealth: (last) => {
      const big = last && summaryTotal(last.summary) > 500;
      const q = big && fleetFilter.severity.length
        ? `?severity=${encodeURIComponent(fleetFilter.severity.join(','))}` : '';
      return api(`/api/fleet/health${q}`);
    },
    maintenance: () => api('/api/settings/maintenance').then((m) => (m && m.windows) || []),
    // Licence-gated (dashboard_advanced): when the licence excludes it the
    // panels are simply omitted, so the core Overview always renders.
    issues: async () => {
      if (!featureEntitled('dashboard_advanced')) return null;
      return fleetIssues((await api('/api/dashboard/advanced')).widgets);
    },
    noc: (data) => nocDashboard(data, {}),
    // Rendered once per view entry: the poll redraws the grid, and rebuilding
    // the Leaflet instance under the reader would throw away their pan and zoom.
    trafficMap: () => trafficMapCard({
      subtitle: t('fleet.trafficSub'),
      onArcClick: (a, site) => openFlows(null, { mode: 'map', locationId: site.locationId ?? null }),
      onSiteClick: (s) => { if (s.locationId != null) openLocation(s.locationId); },
    }),
    startPolling: (refresh) => {
      stopFleet();
      fleetState.timer = setInterval(() => {
        if (currentView !== 'fleet') { stopFleet(); return; }
        if (!modalOpen()) refresh();
      }, 10000);
    },
  });
  return fleetView;
}

views.fleet = async () => {
  const v = getFleetView();
  if (!v) return el('div', { class: 'empty error' }, t('fleet.err.title'));
  return v.view();
};

// Combined per-agent page: health résumé + probes (latency/loss/jitter) +
// interface health + recent traffic — the troubleshooting surface for one agent.
// Device config history (masked snapshots + risk-classified diffs). operator/
// admin only — a viewer gets a 403 the card explains rather than an empty box.
// A collapsible "paste the running-config" form that POSTs a snapshot, then
// reloads the card. operator/admin only (the card is already gated).
function configIngestForm(id, onAdded) {
  const ta = el('textarea', { rows: '6', placeholder: 'Paste the device running-config…', class: 'cfg-ingest-text' });
  const via = el('select', {}, ...[['manual', 'Manual'], ['agent_poll', 'Agent poll'], ['change_detected', 'Change detected']].map(([v, l]) => el('option', { value: v }, l)));
  const status = el('span', { class: 'muted' });
  const submit = el('button', { class: 'small' }, 'Add snapshot');
  submit.addEventListener('click', async () => {
    if (!ta.value.trim()) { status.textContent = 'Paste a config first.'; return; }
    submit.disabled = true;
    status.textContent = 'Saving…';
    try {
      const res = await api(`/api/devices/${id}/config-snapshots`, { method: 'POST', body: { configText: ta.value, capturedVia: via.value } });
      ta.value = '';
      status.textContent = res.unchanged ? 'No change vs. the latest snapshot.' : 'Snapshot added.';
      if (!res.unchanged && typeof onAdded === 'function') onAdded();
    } catch (err) {
      status.textContent = errText(err);
    } finally { submit.disabled = false; }
  });
  return el('details', { class: 'cfg-ingest' },
    el('summary', {}, 'Add a config snapshot'),
    el('div', { class: 'cfg-ingest-body' }, ta,
      el('div', { class: 'cfg-ingest-actions' }, el('label', { class: 'inline muted' }, 'Via ', via), submit, status)));
}

async function loadDeviceConfigHistory(id, card) {
  const head = el('h3', {}, 'Config history');
  const form = configIngestForm(id, () => loadDeviceConfigHistory(id, card));
  try {
    const { snapshots, diffs } = await api(`/api/devices/${id}/config-history`);
    if (!snapshots || !snapshots.length) {
      card.replaceChildren(head, form, el('p', { class: 'muted' }, 'No config snapshots captured for this device yet.'));
      return;
    }
    const diffEls = (diffs || []).map((d) => el('details', { class: 'cfg-diff' },
      el('summary', {}, `${fmtDate(d.capturedAt)} · `,
        el('span', { class: `badge risk-${d.risk}` }, d.risk),
        el('span', { class: 'muted' }, ` +${(d.stats && d.stats.added) || 0}/-${(d.stats && d.stats.removed) || 0}${(d.riskReasons || []).length ? ` · ${d.riskReasons.join(', ')}` : ''}`)),
      el('pre', { class: 'config-diff' }, (d.changedLines || []).map((l) => `${l.op} ${l.text}`).join('\n'))));
    card.replaceChildren(head, form,
      el('p', { class: 'muted' }, `${snapshots.length} snapshot(s); ${(diffs || []).length} change(s). Secrets are masked.`),
      (diffs || []).length ? el('div', { class: 'cfg-diffs' }, ...diffEls) : el('p', { class: 'muted' }, 'No changes between snapshots.'));
  } catch (err) {
    card.replaceChildren(head, el('p', { class: err.status === 403 ? 'muted' : 'error' }, err.status === 403 ? 'Requires operator/admin.' : err.message));
  }
}

// The per-agent CMDB card: shows the linked asset as a removable chip, or (for
// operator+) a searchable dropdown that links the agent to an asset and syncs
// the site. The search matches asset id, asset name and CMDB location, so an
// operator can type whichever of the three they happen to know.
async function loadAgentCmdbLink(id, host) {
  const writable = canWrite();
  const body = el('div', { class: 'cmdb-body' });
  host.replaceChildren(el('h3', {}, t('cmdb.cardTitle')), body);

  // Ask whether a CMDB is connected at all before offering the picker — an
  // unconfigured server should say so, not hand out a box that can only 404.
  let connected = { enabled: false, type: null };
  try { connected = await api('/api/cmdb/assets/status'); }
  catch (e) { if (e.status !== 403) connected = { enabled: false, type: null, unknown: true }; }

  let link = null;
  try { link = await api(`/api/agents/${id}/cmdb-link`); }
  catch (e) {
    if (e.status !== 404) { body.replaceChildren(el('div', { class: 'error' }, errText(e))); return; }
  }

  function showLinked(l) {
    const kids = [el('span', { class: 'cmdb-chip-name' }, l.cmdb_asset_name || l.cmdb_asset_id)];
    if (l.cmdb_asset_location) kids.push(el('span', { class: 'muted small' }, `· ${l.cmdb_asset_location}`));
    if (writable) {
      const x = el('button', { class: 'cmdb-chip-x', title: 'Remove link' }, '×');
      x.addEventListener('click', unlink);
      kids.push(x);
    }
    body.replaceChildren(el('div', { class: 'muted small' }, 'Linked asset'), el('span', { class: 'cmdb-chip' }, ...kids));
  }

  async function unlink() {
    if (!confirm('Remove the CMDB link for this agent?')) return;
    try { await api(`/api/agents/${id}/cmdb-link`, { method: 'DELETE' }); toast('CMDB link removed'); render(); }
    catch (e) { toast(errText(e), true); }
  }

  async function linkTo(a, overwrite) {
    try {
      const body = { cmdb_asset_id: a.id, cmdb_asset_name: a.name, cmdb_asset_location: a.location || null };
      if (overwrite) body.overwrite_location = true;
      const res = await api(`/api/agents/${id}/cmdb-link`, { method: 'PUT', body });
      // The agent already has a (manual) site that differs — suggest, don't clobber.
      if (res && res.location_suggestion && !overwrite) {
        const s = res.location_suggestion;
        const ok = confirm(`This agent is already assigned to site “${s.current.name || s.current.id}”.\nThe CMDB asset is in “${s.proposed.name}”.\n\nOverwrite the agent’s site with the CMDB location?`);
        if (ok) return linkTo(a, true);
        toast('Asset linked · existing site kept');
        return render();
      }
      toast(res && res.synced_location ? `Asset linked · site set to ${res.synced_location.name}` : 'Asset linked');
      render();
    } catch (e) { toast(errText(e), true); }
  }

  function showSearch() {
    if (!connected.enabled && !connected.unknown) {
      // Nothing to link to. Say so once, and point an admin at the setting
      // instead of leaving a search box that can only fail.
      body.replaceChildren(el('div', { class: 'muted' }, t('cmdb.notConnected')),
        isAdmin() ? el('p', { class: 'muted small' }, settingsLink('cmdb', t('cmdb.openSettings'))) : null);
      return;
    }
    if (!writable) { body.replaceChildren(el('div', { class: 'muted' }, t('cmdb.notLinkedReadOnly'))); return; }
    body.replaceChildren(
      el('div', { class: 'muted small' }, t('cmdb.pickHint')),
      assetPicker({ onPick: (a) => linkTo(a) }));
  }

  if (link) showLinked(link); else showSearch();
}

// A searchable dropdown over the connected CMDB's assets. One term is matched
// server-side against the asset id, the asset name AND the CMDB location, so an
// operator can type whichever they know — "srv-0142", "core-sw" or "Aarhus".
//
// Built as a combobox rather than a <select>: the option list is fetched per
// keystroke (debounced, min 2 chars) and a CMDB has far more assets than a
// select can hold. Keyboard: ↓/↑ move, Enter picks, Esc closes.
function assetPicker({ onPick }) {
  const listId = `cmdb-opts-${Math.random().toString(36).slice(2, 8)}`;
  const input = el('input', {
    type: 'search', class: 'cmdb-picker-input', autocomplete: 'off', role: 'combobox',
    'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list',
    placeholder: t('cmdb.searchPlaceholder'),
  });
  const list = el('div', { class: 'cmdb-results', id: listId, role: 'listbox', hidden: 'hidden' });
  const status = el('div', { class: 'muted small' });
  const wrap = el('div', { class: 'cmdb-picker' }, input, status, list);

  let options = [];   // the assets currently offered
  let active = -1;    // index of the highlighted option
  let timer = null;
  let seq = 0;        // guards against an older search resolving last

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    options = []; active = -1;
  }

  function highlight(next) {
    if (!options.length) return;
    active = (next + options.length) % options.length;
    [...list.children].forEach((row, i) => {
      row.classList.toggle('active', i === active);
      row.setAttribute('aria-selected', i === active ? 'true' : 'false');
    });
    const row = list.children[active];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const a = options[i];
    if (!a) return;
    close();
    onPick(a);
  }

  function optionEl(a, i) {
    // id and location are shown on every row: they are what the operator
    // searched on, and the id is how the asset is identified in the CMDB.
    const row = el('div', { class: 'cmdb-result', role: 'option', 'aria-selected': 'false' },
      el('span', { class: 'cmdb-result-name' }, a.name || a.id),
      el('span', { class: 'muted small cmdb-result-id' }, a.id),
      a.type ? el('span', { class: 'muted small' }, a.type) : null,
      el('span', { class: 'muted small cmdb-result-loc' }, a.location || t('cmdb.noLocation')));
    row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); }); // before blur
    row.addEventListener('mouseenter', () => highlight(i));
    return row;
  }

  async function run(q) {
    const my = ++seq;
    status.textContent = t('cmdb.searching');
    try {
      const data = await api(`/api/cmdb/assets/search?q=${encodeURIComponent(q)}`);
      if (my !== seq) return; // a newer keystroke already owns the list
      options = data.assets || [];
      status.textContent = options.length ? '' : t('cmdb.noMatches');
      list.replaceChildren(...options.map(optionEl));
      list.hidden = options.length === 0;
      input.setAttribute('aria-expanded', options.length ? 'true' : 'false');
      active = -1;
    } catch (e) {
      if (my !== seq) return;
      close();
      status.textContent = e.status === 404 ? t('cmdb.notConnected') : errText(e);
    }
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { close(); status.textContent = ''; return; }
    timer = setTimeout(() => run(q), 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120)); // let a click land

  return wrap;
}

// Hour-of-day baseline profile chart for one service dependency: the median
// volume per hour with the "normal range" band (median ± 3·MAD) shaded. Slots
// come from the pure TopologyGraph.baselineProfile. Hand-drawn SVG, no lib.
function baselineBandChart(slots, { title } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}, ...kids) => {
    const e = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) if (v != null) e.setAttribute(a, v);
    for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  };
  const present = (slots || []).filter((s) => s.median != null);
  if (!present.length) {
    return el('div', { class: 'empty' }, 'Not enough history yet — a pair needs ≥100 hourly observations before it is baselined.');
  }
  const W = 560, H = 190, padL = 52, padR = 10, padT = 12, padB = 26;
  const maxY = Math.max(1, ...present.map((s) => (s.hi != null ? s.hi : s.median)));
  const x = (h) => padL + (h / 23) * (W - padL - padR);
  const y = (v) => padT + (1 - (v / maxY)) * (H - padT - padB);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title || 'Baseline profile' });
  // y grid: 0 and max
  [0, maxY].forEach((v) => {
    svg.append(mk('line', { class: 'bl-grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    svg.append(mk('text', { class: 'bl-axis', x: padL - 6, y: y(v) + 3, 'text-anchor': 'end' }, fmtBytes(v)));
  });
  // x ticks (hours)
  [0, 6, 12, 18, 23].forEach((h) => svg.append(mk('text', { class: 'bl-axis', x: x(h), y: H - 8, 'text-anchor': 'middle' }, `${h}:00`)));
  // band = per-hour vertical segment lo..hi
  slots.forEach((s) => { if (s.median == null) return; const bx = x(s.hour); svg.append(mk('line', { class: 'bl-band', x1: bx, x2: bx, y1: y(s.hi), y2: y(s.lo) })); });
  // median polyline over present, contiguous points
  let d = ''; let pen = false;
  slots.forEach((s) => { if (s.median == null) { pen = false; return; } const px = x(s.hour); const py = y(s.median); d += `${pen ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)} `; pen = true; });
  svg.append(mk('path', { class: 'bl-median', d, fill: 'none' }));
  slots.forEach((s) => { if (s.median == null) return; const dot = mk('circle', { class: 'bl-dot', cx: x(s.hour), cy: y(s.median), r: '2.4' }); dot.append(mk('title', {}, `${s.hour}:00 · median ${fmtBytes(s.median)} · normal ${fmtBytes(s.lo)}–${fmtBytes(s.hi)}`)); svg.append(dot); });
  return el('div', { class: 'bl-chart' }, svg, el('div', { class: 'muted small' }, 'Normal range = median ± 3·MAD · y-axis bytes/hour, x-axis hour of day'));
}

// Host dependency list (Part 6 host detail): what this host talks to (outbound)
// and what talks to it (inbound), with ports + volume, from
// GET /api/topology/dependencies. Each outbound row links to its per-hour
// baseline band (operator+; the baselines are keyed by the source host).
async function loadAgentDependencies(id, host) {
  let data; let agents = [];
  try {
    [data, agents] = await Promise.all([
      api(`/api/topology/dependencies?host=${encodeURIComponent(id)}&direction=both&limit=100`),
      api('/agents').catch(() => []),
    ]);
  } catch (e) {
    host.replaceChildren(el('h3', {}, 'Dependencies'), el('div', { class: 'error' }, errText(e)));
    return;
  }
  const nameById = {};
  (agents || []).forEach((a) => { nameById[a.id] = a.display_name || a.hostname || `agent ${a.id}`; });
  const nameFor = (hid) => nameById[hid] || `host ${hid}`;
  const { outbound, inbound } = TopologyGraph.splitDependencies(data.edges || [], id);

  if (!outbound.length && !inbound.length) {
    host.replaceChildren(el('h3', {}, 'Dependencies'),
      el('div', { class: 'empty' }, 'No service dependencies observed for this host yet. Dependency edges are aggregated from TCP flows (NetFlow/sFlow) by a scheduled job.'));
    return;
  }

  async function openBaseline(dstHostId, dstPort, peerLabel) {
    const card = $('#modal-card');
    card.classList.add('wide');
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dowSel = el('select', { class: 'small' }, ...dowNames.map((n, i) => el('option', { value: String(i) }, n)));
    dowSel.value = String(new Date().getDay());
    const chartHost = el('div', {}, el('p', { class: 'muted' }, 'Loading baseline…'));
    const draw = (baselines) => {
      const slots = TopologyGraph.baselineProfile(baselines, dstHostId, dstPort, Number(dowSel.value), { sigma: 3 });
      chartHost.replaceChildren(baselineBandChart(slots, { title: `Baseline → ${peerLabel}:${dstPort}` }));
    };
    card.replaceChildren(
      el('h3', {}, `Baseline · ${peerLabel}:${dstPort}`),
      el('div', { class: 'history-controls' }, el('label', { class: 'inline muted' }, 'Day ', dowSel)),
      chartHost,
      el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
    $('#modal').classList.remove('hidden');
    let baselines = [];
    try {
      const r = await api(`/api/topology/flow-baselines?host=${encodeURIComponent(id)}&limit=5000`);
      baselines = r.baselines || [];
    } catch (e) {
      chartHost.replaceChildren(el('div', { class: 'error' }, errText(e)));
      return;
    }
    dowSel.addEventListener('change', () => draw(baselines));
    draw(baselines);
  }

  const depTable = (rows, dir) => el('table', { class: 'agents-table' },
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, dir === 'out' ? 'Talks to' : 'Talked to by'),
      el('th', { scope: 'col' }, 'Port'), el('th', { scope: 'col' }, 'Bytes'),
      el('th', { scope: 'col' }, 'Conns'), el('th', { scope: 'col' }, 'Last seen'),
      dir === 'out' && canWrite() ? el('th', { scope: 'col' }, '') : null)),
    el('tbody', {}, ...rows.map((e) => {
      const peerId = dir === 'out' ? e.dstHostId : e.srcHostId;
      return el('tr', {},
        el('td', {}, el('button', { class: 'linklike', onclick: () => openAgent(peerId) }, nameFor(peerId))),
        el('td', { class: 'num' }, String(e.dstPort)),
        el('td', { class: 'num' }, fmtBytes(e.bytes)),
        el('td', { class: 'num' }, String(e.connCount)),
        el('td', {}, e.lastSeen ? fmtTimeShort(new Date(e.lastSeen).getTime()) : '–'),
        dir === 'out' && canWrite()
          ? el('td', {}, el('button', { class: 'small ghost', onclick: () => openBaseline(e.dstHostId, e.dstPort, nameFor(e.dstHostId)) }, 'Baseline'))
          : null);
    })));

  const children = [el('h3', {}, 'Dependencies')];
  if (outbound.length) children.push(el('h4', { class: 'sub' }, `Talks to (${outbound.length})`), depTable(outbound, 'out'));
  if (inbound.length) children.push(el('h4', { class: 'sub' }, `Talked to by (${inbound.length})`), depTable(inbound, 'in'));
  host.replaceChildren(...children);
}

views.agent = async () => {
  const id = selectedAgentId;
  const root = el('div', { class: 'agent-detail' });
  if (id == null) { root.append(el('div', { class: 'empty' }, 'Select an agent in the overview.')); return root; }
  let agent;
  try { agent = await api(`/agents/${id}`); } catch (e) { root.append(el('div', { class: 'error' }, e.message)); return root; }

  root.append(el('div', { class: 'section-head' },
    el('button', { class: 'small ghost', onclick: () => { currentView = 'fleet'; render(); } }, '← Overview'),
    el('h2', {}, agent.display_name || agent.hostname),
    el('span', { class: `badge ${agent.status}` }, agent.status),
    agent.location_id != null
      ? el('button', { class: 'linklike', title: 'Open the location page — agents, health & data flows', onclick: () => openLocation(agent.location_id) }, '📍 ', agent.location_name || `#${agent.location_id}`)
      : (agent.location_name ? el('span', { class: 'muted' }, agent.location_name) : null),
    el('button', { class: 'small ghost', onclick: () => { currentView = 'flows'; render(); } }, 'Flows →'),
    el('button', { class: 'small ghost', onclick: () => exportInvestigationMenu(id, agent.display_name || agent.hostname) }, 'Export'),
    canWrite() ? el('button', { class: 'small ghost', onclick: () => runTest(agent) }, 'Run test') : null));

  // Health résumé (the headline + the metrics that drove it).
  const healthHost = el('div', { class: 'agent-health' });
  root.append(healthHost);

  // Config history / CMDB / Dependencies side by side in a responsive grid so
  // the page uses the full width (the global .card is a fixed 320px otherwise).
  const cardsWrap = el('div', { class: 'agent-cards' });
  root.append(cardsWrap);

  // Device config history (operator/admin) — masked snapshots + risk-classified
  // diffs from GET /api/devices/:id/config-history. Lazy-loaded.
  if (canWrite()) {
    const cfgHost = el('div', { class: 'card agent-config-history' }, el('h3', {}, 'Config history'), el('div', { class: 'muted' }, 'Loading…'));
    cardsWrap.append(cfgHost);
    loadDeviceConfigHistory(id, cfgHost);
  }

  // CMDB asset link (viewer sees the linked asset; operator+ can search/link/unlink).
  const cmdbHost = el('div', { class: 'card agent-cmdb' }, el('h3', {}, 'CMDB asset'), el('div', { class: 'muted' }, 'Loading…'));
  cardsWrap.append(cmdbHost);
  loadAgentCmdbLink(id, cmdbHost);

  // Service dependencies (viewer+): who this host talks to / who talks to it,
  // ports + volume; each outbound row links to its per-hour baseline band.
  const depsHost = el('div', { class: 'card agent-deps' }, el('h3', {}, 'Dependencies'), el('div', { class: 'muted' }, 'Loading…'));
  cardsWrap.append(depsHost);
  loadAgentDependencies(id, depsHost);

  // Unified activity timeline (findings + probe-outage events + connect/
  // disconnect + playbook runs) — GET /api/targets/:id/timeline.
  root.append(targetTimelineCard(id));
  function renderHealth(h, q, thr) {
    const m = h.metrics;
    const kv = (k, v, cls) => el('div', { class: 'ah-kv' }, el('span', { class: 'ah-k' }, k), el('span', { class: `ah-v${cls ? ' ' + cls : ''}` }, v));
    const thrCls = m.throughputStatus === 'warn' ? 'warn-text' : (m.throughputStatus === 'bad' ? 'bad-text' : '');
    const children = [
      el('div', { class: 'ah-head' }, healthBadge(h), el('span', { class: 'ah-reason' }, h.reason || '')),
      el('div', { class: 'ah-grid' },
        kv('Targets reached', m.targets ? `${m.reachable}/${m.targets}` : '–'),
        kv('Loss', m.lossPct != null ? `${m.lossPct}%` : '–', m.lossPct >= 2 ? 'warn-text' : ''),
        kv('Latency', latencyText(m)),
        kv('Baseline', m.baselineMs != null ? `~${m.baselineMs} ms` : '–'),
        kv('Jitter', m.jitterMs != null ? `${m.jitterMs} ms` : '–', m.jitterMs >= 30 ? 'warn-text' : ''),
        m.ifaceStatus ? kv('Interface', `${String(m.ifaceStatus).toUpperCase()}${m.worstIface ? ' · ' + m.worstIface : ''}`, m.ifaceStatus === 'ok' ? '' : (m.ifaceStatus === 'warn' ? 'warn-text' : 'bad-text')) : null,
        thr ? kv('Throughput', thr.ok ? `↓${thr.downMbps ?? '?'} / ↑${thr.upMbps ?? '?'} Mbps` : 'failed', thr.ok ? thrCls : 'bad-text') : null),
    ];
    if (q && q.status && q.status !== 'unknown') {
      const cls = q.status === 'ok' ? 'online' : (q.status === 'warn' ? 'warn' : 'offline');
      children.push(el('div', { class: 'ah-quality' },
        el('span', { class: `badge ${cls}` }, `Data quality: ${q.status.toUpperCase()}`),
        el('span', { class: 'muted' }, q.reason || ''),
        q.version ? el('span', { class: 'muted' }, `· agent v${q.version}`) : null,
        q.dropPct != null ? el('span', { class: 'muted' }, `· loss ${q.dropPct}%`) : null,
        q.clockSkewMs != null ? el('span', { class: 'muted' }, `· clock ${Math.round(q.clockSkewMs / 1000)} s`) : null));
    } else if (q && q.version) {
      children.push(el('div', { class: 'ah-quality muted' }, `agent v${q.version}`));
    }
    healthHost.replaceChildren(...children);
  }

  // ---- Probes (this agent) ----
  const typeSel = el('select', {}, ...[['ping', 'Ping (ICMP)'], ['tcp', 'TCP-connect'], ['dns', 'DNS'], ['traceroute', 'Traceroute'], ['tcptraceroute', t('probe.tcptraceroute')], ['curl', 'cURL (content check)'], ['pageload', 'Page load']].map(([v, l]) => el('option', { value: v }, l)));
  const target = el('input', { type: 'text', placeholder: 'e.g. 1.1.1.1 or example.com' });
  const portInput = el('input', { type: 'number', min: '1', max: '65535', value: '443' });
  const portWrap = el('label', { class: 'inline muted' }, 'Port ', portInput);
  const countInput = el('input', { type: 'number', min: '1', max: '20', value: '4' });
  const countWrap = el('label', { class: 'inline muted' }, 'Count ', countInput);
  const curl = curlInputs();
  const runBtn = el('button', { class: 'small' }, 'Run probe');
  const probeStatus = el('span', { class: 'muted' });
  const syncPort = () => {
    const isCurl = typeSel.value === 'curl';
    const isUrl = isCurl || typeSel.value === 'pageload';
    // tcptraceroute traces to a PORT, so it needs the same field the tcp probe does.
    portWrap.style.display = (typeSel.value === 'tcp' || typeSel.value === 'tcptraceroute') ? '' : 'none';
    curl.wrap.style.display = isCurl ? '' : 'none';
    countWrap.style.display = typeSel.value === 'pageload' ? 'none' : '';
    target.placeholder = isUrl ? 'e.g. https://example.com/' : 'e.g. 1.1.1.1 or example.com';
  };
  typeSel.addEventListener('change', syncPort); syncPort();
  const probeForm = el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Type ', typeSel),
    el('label', { class: 'inline muted' }, 'Target ', target),
    portWrap,
    countWrap,
    curl.wrap,
    runBtn, probeStatus);
  const probeLatestHost = el('div', { class: 'probe-latest' });

  async function runProbe() {
    const host = target.value.trim();
    if (!host) { probeStatus.className = 'error'; probeStatus.textContent = 'Enter a target.'; return; }
    const body = { type: typeSel.value, host };
    if (typeSel.value === 'tcp' || typeSel.value === 'tcptraceroute') body.port = Number(portInput.value);
    if (typeSel.value === 'curl') curl.apply(body);
    if ((typeSel.value === 'ping' || typeSel.value === 'tcp') && countInput.value) body.count = Number(countInput.value);
    probeStatus.className = 'muted'; probeStatus.textContent = 'Sending…'; runBtn.disabled = true;
    try {
      await api(`/agents/${id}/probe`, { method: 'POST', body });
      probeStatus.textContent = 'Sent — results will arrive in a moment.';
      setTimeout(refreshProbes, 2500); setTimeout(refreshProbes, 6000);
    } catch (e) {
      probeStatus.className = 'error';
      probeStatus.textContent = e.status === 409 ? 'The agent is not connected right now.' : (e.data && e.data.details ? Object.values(e.data.details).join(' · ') : e.message);
    } finally { runBtn.disabled = false; }
  }
  runBtn.addEventListener('click', runProbe);
  async function refreshProbes() {
    let data;
    try { data = await api(`/api/probes/latest?agentId=${encodeURIComponent(id)}`); } catch { return; }
    probeLatestHost.replaceChildren(probeLatestTable(data.results || [], (r) => probeDetail(r, id), (tool, r, btn) => requestToolInstall(id, tool, btn)));
  }

  // ---- Interfaces ----
  const ifaceStatus = el('span', { class: 'muted' });
  const ifaceHost = el('div', {});
  async function refreshIfaces() {
    let data;
    try { data = await api(`/api/interfaces?agentId=${encodeURIComponent(id)}`); } catch (e) { ifaceHost.replaceChildren(el('div', { class: 'error' }, e.message)); return; }
    ifaceStatus.textContent = data.ts ? `source: ${data.source} · measured ${fmtTimeShort(new Date(data.ts).getTime())}` : 'no measurements yet';
    ifaceHost.replaceChildren(interfaceTable(data.interfaces, data.source));
  }

  // ---- Recent traffic (bandwidth over the last measurements) ----
  const trafficHost = el('div', { class: 'overview-chart' });
  async function refreshTraffic() {
    let rows;
    try { rows = await api(`/agents/${id}/results?limit=60`); } catch (e) { trafficHost.replaceChildren(el('div', { class: 'error' }, e.message)); return; }
    const series = (rows || []).slice().reverse().map((r) => {
      const t = r.payload && r.payload.traffic && r.payload.traffic.totals;
      return { t: new Date(r.created_at).getTime(), rx: t ? Number(t.rxBytesPerSec) || 0 : 0, tx: t ? Number(t.txBytesPerSec) || 0 : 0 };
    });
    if (series.length < 2) { trafficHost.replaceChildren(el('div', { class: 'empty' }, 'No traffic measurements yet — press "Run test".')); return; }
    // #7 event timeline: overlay this agent's findings as markers on the axis.
    let markers = [];
    try { const fs = await api(`/api/findings?hostId=${encodeURIComponent(id)}&since=${new Date(series[0].t).toISOString()}`); markers = findingMarkers(fs); } catch { markers = []; }
    trafficHost.replaceChildren(historyChart([
      { id: 'rx', label: '↓ RX', color: '#06b6d4', points: series.map((s) => ({ t: s.t, y: s.rx })) },
      { id: 'tx', label: '↑ TX', color: '#10b981', points: series.map((s) => ({ t: s.t, y: s.tx })) },
    ], { fromMs: series[0].t, toMs: series[series.length - 1].t, markers }));
  }

  async function refreshHealth() {
    try { const d = await api(`/api/fleet/agent/${id}`); renderHealth(d.health, d.quality, d.throughput); } catch { /* keep last verdict */ }
  }

  // ---- NIC firmware (driver/firmware inventory the agent reported) ----
  const nics = agent.capabilities && Array.isArray(agent.capabilities.nic) ? agent.capabilities.nic : [];
  const nicSummary = el('span', { class: 'muted' }, nics.length ? `· ${nics.length} interface(s)` : '· none reported');

  root.append(
    el('details', { class: 'sec', open: true }, el('summary', {}, 'Probes ', el('span', { class: 'muted' }, '· ping · TCP · DNS · traceroute · cURL')), probeForm, probeLatestHost),
    el('details', { class: 'sec', open: true }, el('summary', {}, 'Interfaces ', ifaceStatus), ifaceHost),
    el('details', { class: 'sec' }, el('summary', {}, 'NIC firmware ', nicSummary), nicTable(nics)),
    el('details', { class: 'sec' }, el('summary', {}, 'Traffic ', el('span', { class: 'muted' }, '· recent bandwidth')), trafficHost));

  async function refreshAll() { await Promise.all([refreshHealth(), refreshProbes(), refreshIfaces(), refreshTraffic()]); }
  await refreshAll();
  stopAgent();
  agentState.timer = setInterval(() => {
    if (currentView !== 'agent') { stopAgent(); return; }
    if (!modalOpen()) refreshAll();
  }, 7000);
  return root;
};

// Renders one agent's reported NIC inventory (capabilities.nic): per-interface
// driver / driver version / firmware / bus. Used on the agent page.
function nicTable(nics) {
  if (!Array.isArray(nics) || !nics.length) return el('div', { class: 'empty' }, 'No NIC inventory reported yet (needs an agent that runs ethtool on Linux).');
  const head = el('tr', {}, ...['Interface', 'Driver', 'Driver ver.', 'Firmware', 'Bus'].map((h) => el('th', {}, h)));
  const rows = nics.map((n) => el('tr', {},
    el('td', {}, n.iface || '—'),
    el('td', {}, n.driver || '—'),
    el('td', { class: 'muted' }, n.driverVersion || '—'),
    el('td', {}, n.firmwareVersion || '—'),
    el('td', { class: 'muted' }, n.busInfo || n.pciId || '—')));
  return el('table', { class: 'iface-table' }, el('thead', {}, head), el('tbody', {}, ...rows));
}

// Fleet NIC inventory + firmware-drift detection. Groups identical NIC models
// across all agents and surfaces firmware-version outliers — the "47 units on
// firmware X, 3 on Y" case — so a Wi-Fi issue traced to a firmware mismatch is
// obvious. Reads capabilities.nic; no probes, no new storage.
views.nics = async () => {
  const root = el('div', { class: 'nics-view' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'NICs'),
    el('span', { class: 'muted' }, 'Driver & firmware inventory · firmware-drift detection')));

  let inv;
  try { inv = await api('/api/fleet/nics'); } catch (e) { root.append(el('div', { class: 'error' }, e.message)); return root; }

  root.append(el('div', { class: 'nics-summary muted' },
    `${inv.agents} agent(s) reporting NIC data · ${inv.totalNics} NIC(s) · `,
    el('span', { class: inv.drift.length ? 'bad-text' : '' }, `${inv.drift.length} model(s) with firmware drift`)));

  if (!inv.agents) {
    root.append(el('div', { class: 'empty' },
      'No NIC inventory yet. Agents collect driver/firmware via ', el('code', {}, 'ethtool -i'),
      ' on Linux and report it with their capabilities — redeploy/upgrade agents to populate this.'));
    return root;
  }

  // A chip per agent on a given firmware; click to open that agent.
  const agentChips = (agents) => el('div', { class: 'nic-chips' }, ...agents.map((a) =>
    el('button', { class: 'chip ghost small', title: a.location ? `${a.name} · ${a.location}` : a.name, onclick: () => openAgent(a.id) },
      a.name, a.iface ? el('span', { class: 'muted' }, ` (${a.iface})`) : null)));

  // Group-by toggle: aggregate by NIC model (drift-first) or list every agent
  // with its NIC specs. Defaults to models — the firmware-drift lens. A search box
  // filters within the active group (model/driver/firmware, or agent/location/nic).
  const body = el('div', { class: 'nics-body' });
  let nicMode = 'models';
  const filterInput = el('input', { type: 'search', class: 'nic-filter', placeholder: 'Filter…' });
  const q = () => filterInput.value.trim().toLowerCase();
  const renderBody = () => {
    filterInput.placeholder = nicMode === 'agents'
      ? 'Filter agent / location / driver / firmware…'
      : 'Filter model / firmware…';
    body.replaceChildren(nicMode === 'agents' ? renderByAgent(q()) : renderByModel(q()));
  };
  const seg = el('div', { class: 'seg' });
  const setMode = (mode) => {
    nicMode = mode;
    for (const b of seg.children) b.classList.toggle('on', b.dataset.mode === mode);
    renderBody();
  };
  for (const [mode, label] of [['models', 'Models'], ['agents', 'Agents']]) {
    seg.append(el('button', { class: 'seg-btn', 'data-mode': mode, onclick: () => setMode(mode) }, label));
  }
  filterInput.addEventListener('input', renderBody);
  root.append(el('div', { class: 'nics-controls' },
    el('span', { class: 'muted' }, 'Group by'), seg,
    el('span', { class: 'spacer' }),
    filterInput), body);

  const has = (v, needle) => String(v == null ? '' : v).toLowerCase().includes(needle);

  // ---- Models view: firmware drift first, then the full model inventory. ----
  function renderByModel(needle) {
    const modelMatch = (m) => !needle || has(m.label, needle) || (m.firmwares || []).some((f) => has(f.firmwareVersion, needle));
    const wrap = el('div', {});
    const drift = inv.drift.filter(modelMatch);
    if (drift.length) {
      const driftCard = el('div', { class: 'nic-card drift-card' }, el('h3', {}, '⚠ Firmware drift'));
      for (const model of drift) {
        const block = el('div', { class: 'drift-model' },
          el('div', { class: 'drift-head' }, el('strong', {}, model.label), el('span', { class: 'muted' }, ` · ${model.count} unit(s)`)));
        for (const f of model.firmwares) {
          block.append(el('div', { class: `fw-row${f.isOutlier ? ' fw-outlier' : ''}` },
            el('span', { class: `badge ${f.isOutlier ? 'warn' : 'online'}` }, f.isOutlier ? 'outlier' : 'majority'),
            el('span', { class: 'fw-ver' }, f.firmwareVersion),
            el('span', { class: 'muted' }, ` — ${f.count} unit(s)`),
            agentChips(f.agents)));
        }
        driftCard.append(block);
      }
      wrap.append(driftCard);
    }
    const models = inv.drivers.filter(modelMatch);
    const invCard = el('div', { class: 'nic-card' }, el('h3', {}, needle ? `NIC models (${models.length} of ${inv.drivers.length})` : 'All NIC models'));
    if (!models.length) invCard.append(el('div', { class: 'empty' }, needle ? 'No NIC models match the filter.' : 'No NIC models.'));
    for (const model of models) {
      const fwSummary = model.firmwares.map((f) => `${f.firmwareVersion} ×${f.count}`).join(' · ');
      invCard.append(el('div', { class: 'nic-model-row' },
        el('div', {}, el('strong', {}, model.label), model.hasDrift ? el('span', { class: 'badge warn', style: 'margin-left:.4rem' }, 'drift') : null),
        el('div', { class: 'muted' }, `${model.count} unit(s) · ${fwSummary}`)));
    }
    wrap.append(invCard);
    return wrap;
  }

  // ---- Agents view: each agent that reports NIC data + its NIC specs. ----
  function renderByAgent(needle) {
    const nicMatch = (n) => !needle || [n.iface, n.driver, n.driverVersion, n.firmwareVersion, n.busInfo, n.pciId].some((v) => has(v, needle));
    const agentMatch = (a) => !needle || has(a.name, needle) || has(a.location, needle) || a.nics.some(nicMatch);
    const agents = inv.byAgent.filter(agentMatch);
    const card = el('div', { class: 'nic-card' }, el('h3', {}, `Agents reporting NIC data (${needle ? `${agents.length} of ${inv.byAgent.length}` : agents.length})`));
    if (!agents.length) card.append(el('div', { class: 'empty' }, 'No agents match the filter.'));
    for (const a of agents) {
      // If the filter matched a NIC, show only the matching NICs; if it matched
      // the agent's name/location, keep all of its interfaces.
      const nics = needle && a.nics.some(nicMatch) ? a.nics.filter(nicMatch) : a.nics;
      card.append(el('div', { class: 'nic-agent-row' },
        el('div', { class: 'nic-agent-head' },
          el('button', { class: 'linklike', onclick: () => openAgent(a.id) }, a.name),
          a.location ? el('span', { class: 'muted' }, ` · ${a.location}`) : null,
          el('span', { class: 'muted' }, ` · ${a.nics.length} interface(s)`)),
        nicTable(nics)));
    }
    return card;
  }

  setMode('models');
  return root;
};

// Flow Explorer — merged conversation explorer + bidirectional inspector.
// Unified mode: top talkers, ports, protocols, scan/fan-out, anomaly markers.
// Bidirectional mode: ingress/egress side-by-side with asymmetry indicator.
// Metadata only; internal (LAN) conversations are shown — never geolocated.
// ---- Flows (MIGRATED — see public/views/flows.js) ---------------------------
// The traffic map, its legend chips and the traffic-type colour ramp stay here:
// the ramp is a per-category palette that has not been migrated, and the map
// carries the reader's pan and zoom.
let flowsPage = null;
const flowsPageState = {};

// One dot in the traffic-type colour ramp. Built here rather than in the view
// because the ramp is app.js's, and a per-category colour cannot be a class.
function trafficTypeDot(category) {
  return el('span', { class: 'tc-dot', style: `background:${trafficTypeColor(category)}` });
}

function getFlowsPage() {
  if (flowsPage) return flowsPage;
  if (typeof window === 'undefined' || !window.FlowsPage || !ui) return null;
  const iso = (ms) => new Date(ms).toISOString();
  // The findings overlay is optional: a failure there costs the markers, never
  // the chart.
  const markersFor = async (agentId, fromMs) => {
    try {
      const fs = await api(`/api/findings?hostId=${encodeURIComponent(agentId)}&since=${iso(fromMs)}`);
      return findingMarkers(fs);
    } catch { return []; }
  };
  flowsPage = window.FlowsPage.create({
    el, t, ui, errText, fmtBytes,
    state: flowsPageState,
    hasMapLibrary: () => typeof L !== 'undefined',
    selectedAgentId: () => selectedAgentId,
    takePrefill: () => { const p = flowsPrefill; flowsPrefill = null; return p; },
    syncMode: (mode) => {
      try {
        const q = new URLSearchParams(window.location.search || '');
        if (mode === 'unified') q.delete('mode'); else q.set('mode', mode);
        const qs = q.toString();
        window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
      } catch { /* best-effort */ }
    },
    help: () => {
      const info = PAGE_INFO.flows || {};
      return { lead: info.hero || '', title: info.title || t('flows.title'), body: info.body || (() => []) };
    },
    fetchAgents: async () => api('/agents').catch(() => []),
    chart: (points, { markers, onBrush }) => el('div', { class: 'overview-chart' },
      historyChart([{ id: 'b', label: t('flows.col.bytes'), color: ui.token('--series-0'), points }], {
        fromMs: points[0].t, toMs: points[points.length - 1].t,
        band: robustBand(points), markers, onBrush,
      })),
    fetchExplore: async ({ window: w, agentId, peer, port, proto, direction, internal }) => {
      const qp = new URLSearchParams({ agentId, from: iso(w.fromMs), to: iso(w.toMs) });
      if (peer) qp.set('peer', String(peer).trim());
      if (port) qp.set('port', String(port).trim());
      if (proto) qp.set('proto', String(proto).trim());
      if (direction) qp.set('direction', direction);
      if (internal) qp.set('internal', internal);
      const data = await api(`/api/flows/explore?${qp}`);
      return { data, markers: await markersFor(agentId, w.fromMs) };
    },
    fetchBidi: async ({ window: w, agentId, peer }) => {
      const qp = new URLSearchParams({ agentId, from: iso(w.fromMs), to: iso(w.toMs) });
      if (peer) qp.set('host', String(peer).trim());
      const data = await api(`/api/flows/bidirectional?${qp}`);
      return { data, markers: await markersFor(agentId, w.fromMs) };
    },
    fetchMap: async ({ window: w, agentId, scope }) => {
      const qp = new URLSearchParams({ from: iso(w.fromMs), to: iso(w.toMs) });
      if (scope === 'agent') qp.set('agentId', agentId);
      else if (scope.startsWith('l')) qp.set('locationId', scope.slice(1));
      const [data, cfg] = await Promise.all([api(`/api/flows/map?${qp}`), trafficTileConfig()]);
      return { data, cfg };
    },
    drawMap: (hostEl, cfg, data) => drawTrafficMap(hostEl, cfg, data, {
      onSiteClick: (s) => { if (s.locationId != null) openLocation(s.locationId); },
    }),
    legendChips: trafficLegendChips,
    mapKey: trafficMapKey,
    typeDot: trafficTypeDot,
    stopMaps: stopTrafficMaps,
  });
  return flowsPage;
}

views.flows = async () => {
  const v = getFlowsPage();
  if (!v) return el('div', { class: 'empty error' }, t('flows.err.title'));
  // A mode on the URL (a deep link, or coming back to the page) wins over the
  // remembered one.
  try {
    const m = new URLSearchParams(window.location.search || '').get('mode');
    if (m === 'bidi' || m === 'map' || m === 'unified') flowsPageState.mode = m;
  } catch { /* best-effort */ }
  return v.view();
};

// Map of locations with their agents. Uses Leaflet if available; otherwise falls
// back to a list. Each located location gets a marker with agent count/status.
// Creates a Leaflet map with the server-configured tiles (EU / self-hosted —
// never a hardcoded source). Shared by the Sites map and the Destinations (geo)
// map so the admin's Settings → Map tile choice is honoured everywhere. Returns
// the map, or null if Leaflet is unavailable. `config` = /api/map|geo/config.
function createLeafletMap(host, config, { center = [20, 0], zoom = 3 } = {}) {
  if (typeof L === 'undefined' || !host) return null;
  const cfg = config || {};
  const map = L.map(host).setView(center, zoom);
  L.tileLayer(cfg.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: cfg.maxZoom || 19,
    attribution: cfg.attribution || '© OpenStreetMap',
  }).addTo(map);
  return map;
}

// ---- Traffic map (colored directional flow arrows) -------------------------
// Shared by the Flows page "Map" mode, the Overview and the location page.
// Draws one arc per (site, destination country, traffic-type category) from
// GET /api/flows/map: color = traffic type, animated dashes = direction (drawn
// toward the receiving end; solid = both ways), width = volume. External
// destinations only — internal RFC1918 traffic is never geolocated.
const TRAFFIC_COLORS = {
  web: '#0ea5e9', dns: '#8b5cf6', mail: '#f59e0b', ssh: '#10b981', rdp: '#ef4444',
  ntp: '#14b8a6', voip: '#eab308', vpn: '#ec4899', facebook: '#3b82f6', google: '#22c55e',
  netflix: '#e11d48', microsoft: '#6366f1', amazon: '#f97316', apple: '#a3a3a3',
  cloudflare: '#fb923c', akamai: '#06b6d4', other: '#64748b',
};
const TRAFFIC_FALLBACK = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#eab308', '#ef4444', '#14b8a6'];
function trafficTypeColor(id) {
  if (TRAFFIC_COLORS[id]) return TRAFFIC_COLORS[id];
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TRAFFIC_FALLBACK[h % TRAFFIC_FALLBACK.length];
}

// Live traffic-map Leaflet instances — torn down centrally on view switch.
const trafficMapState = { maps: [] };
function stopTrafficMaps() {
  for (const m of trafficMapState.maps.splice(0)) { try { m.remove(); } catch { /* ignore */ } }
}

// Cached effective tile config (admin-editable; EU/self-hosted).
let trafficMapCfg = null;
async function trafficTileConfig() {
  if (!trafficMapCfg) { try { trafficMapCfg = await api('/api/map/config'); } catch { trafficMapCfg = {}; } }
  return trafficMapCfg;
}

// Resolves once `node` is actually in the document, or false if it never gets
// there (the user navigated away). A view's DOM is BUILT before render() mounts
// it, so anything async started during construction — a traffic map's fetch —
// finishes while its own container is still detached. Leaflet needs a laid-out
// container to size itself, so we wait for the mount rather than bail (bailing
// left the card stuck on "Loading…" whenever the fetch won that race).
// Polls with setTimeout rather than requestAnimationFrame: rAF is paused in a
// hidden/background tab, which would strand the map until the tab got focus.
function whenConnected(node, { timeoutMs = 15000, stepMs = 50 } = {}) {
  if (node.isConnected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (node.isConnected) { resolve(true); return; }
      if (Date.now() - started > timeoutMs) { resolve(false); return; }
      setTimeout(tick, stepMs);
    };
    setTimeout(tick, stepMs);
  });
}

// Samples a quadratic bezier between two latlngs, lifting the control point
// perpendicular to the chord for a great-circle feel. Returns [ [lat,lng], … ].
function trafficArcPoints(a, b, steps = 24) {
  const [alat, alng] = a; const [blat, blng] = b;
  const mlat = (alat + blat) / 2; const mlng = (alng + blng) / 2;
  const dlat = blat - alat; const dlng = blng - alng;
  const len = Math.sqrt(dlat * dlat + dlng * dlng) || 1;
  const lift = Math.min(14, len * 0.18);
  const clat = mlat + (-dlng / len) * lift;
  const clng = mlng + (dlat / len) * lift;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps; const u = 1 - t;
    pts.push([u * u * alat + 2 * u * t * clat + t * t * blat,
      u * u * alng + 2 * u * t * clng + t * t * blng]);
  }
  return pts;
}

// Draws sites + arcs + destination markers onto a fresh Leaflet map inside
// `hostEl`. Returns { map, setCategory(catId, visible) } or null (no Leaflet).
// opts: { onSiteClick(site), onArcClick(arc, site) } — both optional.
function drawTrafficMap(hostEl, cfg, data, opts = {}) {
  const sites = (data.sites || []).filter((s) => s.lat != null && s.lng != null);
  const siteByKey = new Map((data.sites || []).map((s) => [s.key, s]));
  const arcs = (data.arcs || []).filter((a) => a.lat != null && a.lng != null && a.siteKey && siteByKey.get(a.siteKey) && siteByKey.get(a.siteKey).lat != null);
  const center = sites.length ? [sites[0].lat, sites[0].lng] : (arcs.length ? [arcs[0].lat, arcs[0].lng] : [50, 10]);
  const map = createLeafletMap(hostEl, cfg, { center, zoom: 3 });
  if (!map) return null;
  trafficMapState.maps.push(map);
  const bounds = [];
  const layersByCat = new Map();
  const layerFor = (catId) => {
    let g = layersByCat.get(catId);
    if (!g) { g = L.layerGroup().addTo(map); layersByCat.set(catId, g); }
    return g;
  };
  const dirGlyph = { in: '⬅ inbound', out: '➡ outbound', both: '⇄ both ways' };

  // Arcs — drawn toward the receiving end so the dash animation (CSS,
  // .flowarc) always travels in the traffic's direction; 'both' renders solid.
  const maxBytes = Math.max(1, ...arcs.map((a) => a.bytes));
  for (const a of arcs) {
    const site = siteByKey.get(a.siteKey);
    const from = [site.lat, site.lng]; const to = [a.lat, a.lng];
    const pts = a.direction === 'in' ? trafficArcPoints(to, from) : trafficArcPoints(from, to);
    const weight = 1.5 + 4.5 * (Math.log2(1 + a.bytes) / Math.log2(1 + maxBytes));
    const color = trafficTypeColor(a.category);
    const line = L.polyline(pts, {
      color, weight, opacity: a.direction === 'both' ? 0.6 : 0.8,
      dashArray: a.direction === 'both' ? null : '2 9',
      className: a.direction === 'both' ? 'flowarc flowarc-bidi' : 'flowarc',
    });
    const split = a.direction === 'both' ? ` (↓${fmtBytes(a.inBytes)} / ↑${fmtBytes(a.outBytes)})` : '';
    line.bindTooltip(`${esc(site.name)} ↔ ${esc(a.country)} · ${esc(a.label)} · ${fmtBytes(a.bytes)} · ${dirGlyph[a.direction] || a.direction}${split}`
      + (a.asnNames && a.asnNames.length ? `<br><span class="muted">${esc(a.asnNames.join(', '))}</span>` : ''));
    if (opts.onArcClick) line.on('click', () => opts.onArcClick(a, site));
    layerFor(a.category).addLayer(line);
    bounds.push(from, to);
  }

  // Destination markers — one small circle per country, colored by its
  // heaviest traffic type there.
  const byCountry = new Map();
  for (const a of arcs) {
    const c = byCountry.get(a.country) || { country: a.country, lat: a.lat, lng: a.lng, bytes: 0, top: a };
    c.bytes += a.bytes; if (a.bytes > c.top.bytes) c.top = a;
    byCountry.set(a.country, c);
  }
  for (const c of byCountry.values()) {
    L.circleMarker([c.lat, c.lng], {
      radius: 4, color: trafficTypeColor(c.top.category), fillColor: trafficTypeColor(c.top.category),
      fillOpacity: 0.85, weight: 1, className: 'flowdest',
    }).addTo(map).bindTooltip(`${esc(c.country)} · ${fmtBytes(c.bytes)}`);
  }

  // Site pins — accent ringed dots; click drills into the site.
  for (const s of sites) {
    const m = L.circleMarker([s.lat, s.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.95 });
    m.bindTooltip(`${esc(s.name)} · ${s.hostIds.length} agent${s.hostIds.length === 1 ? '' : 's'}`);
    if (opts.onSiteClick) m.on('click', () => opts.onSiteClick(s));
    m.addTo(map);
    bounds.push([s.lat, s.lng]);
  }

  const fit = () => { if (bounds.length > 1) { try { map.fitBounds(bounds, { padding: [36, 36], maxZoom: 6 }); } catch { /* single point */ } } };
  fit();
  // The container may only just have been mounted (or still be laying out), so
  // re-measure and re-fit once it is — otherwise Leaflet sizes to 0×0 and the
  // arcs render off-screen.
  whenConnected(hostEl).then((ok) => {
    if (!ok) return;
    setTimeout(() => { try { map.invalidateSize(); fit(); } catch { /* ignore */ } }, 60);
  });
  return {
    map,
    setCategory(catId, visible) {
      const g = layersByCat.get(catId);
      if (!g) return;
      if (visible) g.addTo(map); else map.removeLayer(g);
    },
  };
}

// Legend chips (one per traffic type present, biggest first) that toggle the
// matching arc layer on the drawn map. `getMap()` defers to the live instance.
function trafficLegendChips(categories, getMap) {
  const off = new Set();
  return el('div', { class: 'traffic-chips' }, ...(categories || []).map((c) => {
    const chip = el('button', {
      class: 'traffic-chip', type: 'button', 'aria-pressed': 'true',
      title: `${c.label} · ${fmtBytes(c.bytes)} — click to hide/show`,
      onclick: () => {
        const mapApi = getMap();
        const hidden = off.has(c.id);
        if (hidden) off.delete(c.id); else off.add(c.id);
        chip.classList.toggle('off', !hidden);
        chip.setAttribute('aria-pressed', hidden ? 'true' : 'false');
        if (mapApi) mapApi.setCategory(c.id, hidden);
      },
    }, el('span', { class: 'tc-dot', style: `background:${trafficTypeColor(c.id)}` }), `${c.label}`,
    el('span', { class: 'muted tc-amt' }, ` ${fmtBytes(c.bytes)}`));
    return chip;
  }));
}

// The compact legend line explaining the arrow language (shared).
function trafficMapKey() {
  return el('div', { class: 'legend geo-legend' },
    el('span', {}, el('span', { class: 'dot ring', style: 'background:#38bdf8' }), ' site'),
    el('span', { class: 'muted' }, '· color = traffic type · moving dashes = direction · solid = both ways · width = volume'),
    el('span', { class: 'muted' }, '· public destinations at country level — internal traffic is never geolocated'));
}

// A self-contained traffic-map card for the Overview and location pages.
// scope: { locationId } | {} (fleet-wide). Data loads lazily; the card renders
// a friendly empty state when there are no geolocated flows.
function trafficMapCard({ scope = {}, title = 'Traffic map', subtitle = 'last 6 h · colored arrows = traffic type + direction', onArcClick = null, onSiteClick = null, onData = null } = {}) {
  const chipsHost = el('div', {});
  const statusEl = el('span', { class: 'muted tmc-status' }, 'Loading…');
  const mapHost = el('div', { class: 'map traffic-map' });
  const body = el('div', {}, mapHost);
  const root = el('div', { class: 'card traffic-card' },
    el('div', { class: 'tmc-head' },
      el('h3', {}, title),
      el('span', { class: 'muted' }, subtitle),
      statusEl),
    chipsHost, body, trafficMapKey());
  let mapApi = null;

  (async () => {
    if (typeof L === 'undefined') {
      statusEl.textContent = '';
      body.replaceChildren(el('div', { class: 'empty' }, 'Map library (Leaflet) could not be loaded — the traffic map is unavailable offline.'));
      return;
    }
    const qp = new URLSearchParams();
    if (scope.locationId != null) qp.set('locationId', String(scope.locationId));
    if (scope.agentId != null) qp.set('agentId', String(scope.agentId));
    let data; let cfg;
    try {
      [data, cfg] = await Promise.all([api(`/api/flows/map?${qp}`), trafficTileConfig()]);
    } catch (e) {
      statusEl.textContent = '';
      body.replaceChildren(el('div', { class: 'error' }, errText(e)));
      return;
    }
    // Built before the view is mounted — wait for the mount, don't bail.
    if (!(await whenConnected(root))) return; // view was left while loading
    if (onData) { try { onData(data); } catch { /* consumer's problem */ } }
    statusEl.textContent = `${fmtBytes(data.totals.bytes)} · ${data.totals.destinations} destination${data.totals.destinations === 1 ? '' : 's'}`;
    if (!data.arcs.length) {
      body.replaceChildren(el('div', { class: 'empty' },
        'No geolocated flows in the window — needs NetFlow/sFlow agents, the geo pipeline and located sites (Settings → Map).'));
      return;
    }
    mapApi = drawTrafficMap(mapHost, cfg, data, { onArcClick, onSiteClick });
    chipsHost.replaceChildren(trafficLegendChips(data.categories, () => mapApi));
  })();

  return root;
}

// Topology map-mode Leaflet instance. The Topology tab defaults to the SVG
// diagram; when the user switches to Map mode a Leaflet map is built here and
// torn down on mode switch / view leave (it rebuilds on entry).
const topoMapState = { map: null };
function stopTopoMap() {
  if (topoMapState.map) { try { topoMapState.map.remove(); } catch { /* ignore */ } topoMapState.map = null; }
}

// Sites-map polling state (mirrors stopOverview/stopGeo). Re-drawn on a timer so
// agent health/online counts stay live; torn down when leaving the view.
const mapState = { map: null, timer: null, layer: null, fitted: false, popupOpen: false, redraw: null, cfg: null };
function stopMap() {
  if (mapState.timer) { clearInterval(mapState.timer); mapState.timer = null; }
  if (mapState.map) { try { mapState.map.remove(); } catch { /* ignore */ } }
  mapState.map = null; mapState.layer = null; mapState.fitted = false; mapState.popupOpen = false;
  // The redraw closure holds the markers of the map that was just removed; a
  // poll that survived the view switch would otherwise draw into a dead layer.
  mapState.redraw = null;
}

// The "Sites" map: your locations on a map, each marker coloured by the WORST
// agent health at that site (reusing the Overview verdict), clustered, live, and
// click-through to the agents there.
// ---- Sites (MIGRATED — see public/views/sites.js) ---------------------------
// The Leaflet instance stays here: it is a live object with the reader's pan and
// zoom in it, and the 10 s poll must move its markers rather than rebuild it.
// The view asks for a canvas, and app.js mounts the map into it.
let sitesView = null;
const sitesViewState = {};
function mountSitesMap(canvas, located, byLoc, opts) {
  stopMap();
  const drawMarkers = (rolled) => {
    if (!mapState.layer) return;
    mapState.layer.clearLayers();
    const pts = [];
    for (const l of located) {
      const c = rolled[l.id] || { total: 0, online: 0, agents: [], worst: null };
      const m = L.circleMarker([l.latitude, l.longitude], {
        radius: 9,
        color: opts.ringColor,
        weight: 2,
        fillColor: opts.colorFor(c.worst || 'unknown'),
        fillOpacity: 0.95,
      });
      m.bindPopup(sitePopup(l, c, opts));
      mapState.layer.addLayer(m);
      pts.push([l.latitude, l.longitude]);
    }
    if (!mapState.fitted && pts.length) {
      if (pts.length > 1) mapState.map.fitBounds(pts, { padding: [40, 40] });
      mapState.fitted = true;
    }
  };
  mapState.redraw = drawMarkers;
  // Deferred: the canvas is not in the document until the view is returned, and
  // Leaflet measures it on init.
  setTimeout(() => {
    if (!canvas.isConnected) return;
    const map = createLeafletMap(canvas, mapState.cfg || {}, {
      center: [located[0].latitude, located[0].longitude], zoom: 6,
    });
    if (!map) return;
    mapState.map = map;
    map.on('popupopen', () => { mapState.popupOpen = true; });
    map.on('popupclose', () => { mapState.popupOpen = false; });
    mapState.layer = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({ maxClusterRadius: 50 })
      : L.layerGroup();
    mapState.layer.addTo(map);
    drawMarkers(byLoc);
  }, 0);
}

function sitePopup(l, c, opts) {
  return el('div', { class: 'ui map-pop' },
    el('strong', {}, l.name),
    el('div', { class: 'meta-xs' }, t('sites.popup.online', { online: c.online, total: c.total })),
    l.address ? el('div', { class: 'meta-xs' }, l.address) : null,
    el('div', { class: 'map-pop-agents' }, ...c.agents.slice(0, 12).map((ag) => el('button', {
      class: 'btn btn-ghost btn-xs map-pop-agent',
      title: t('sites.popup.openAgent'),
      onclick: () => opts.openAgent(ag.id),
    }, el('span', { class: `ui-legend-dot health-${HEALTH_TONE_KEY[ag.status] || 'unknown'}` }), ag.name))));
}
// The four colours a site marker and its legend can take. Anything the health
// model does not name reads as unknown rather than inventing a fifth.
const HEALTH_TONE_KEY = { ok: 'ok', warn: 'warn', bad: 'bad', down: 'bad', stale: 'unknown', unknown: 'unknown' };

function getSitesView() {
  if (sitesView) return sitesView;
  if (typeof window === 'undefined' || !window.SitesView || !ui) return null;
  sitesView = window.SitesView.create({
    el, t, ui, errText, openAgent, openLocation, gotoView,
    state: sitesViewState,
    worstHealthStatus,
    hasMapLibrary: () => typeof L !== 'undefined',
    help: () => {
      const info = PAGE_INFO.map || {};
      return { lead: info.hero || '', title: info.title || t('sites.title'), body: info.body || (() => []) };
    },
    fetchAll: async () => {
      const [locations, agents, cfg, fleet] = await Promise.all([
        api('/locations'),
        api('/agents'),
        api('/api/map/config').catch(() => ({})),
        api('/api/fleet/health').catch(() => ({ agents: [] })),
      ]);
      mapState.cfg = cfg;
      const healthByAgent = {};
      for (const a of fleet.agents || []) healthByAgent[a.agentId] = a.health && a.health.status;
      return { locations, agents, healthByAgent };
    },
    mountMap: mountSitesMap,
    redrawMarkers: (byLoc) => { if (mapState.redraw) mapState.redraw(byLoc); },
    startPolling: (refresh) => {
      mapState.timer = setInterval(() => {
        if (currentView !== 'map') { stopMap(); return; }
        // A poll that redraws while somebody is reading a popup closes it under
        // them, so it waits.
        if (modalOpen() || mapState.popupOpen || !mapState.map) return;
        refresh();
      }, 10000);
    },
  });
  return sitesView;
}

views.map = async () => {
  const v = getSitesView();
  if (!v) return el('div', { class: 'empty error' }, t('sites.err.title'));
  return v.view();
};

// ---- Destinations map (internal sites + external destinations + selection) ----
const geoState = { map: null, ext: null, hosts: null, rect: null, dests: [], internalHosts: [], sinceIso: '',
  selecting: false, rectStart: null, healthByHost: null, pathLayer: null, config: null, mapOpts: null };

// Drops the Leaflet objects, keeping the data they were drawn from: mounting a
// new map has to tear the old one down WITHOUT throwing away the overview it is
// about to draw.
function teardownGeoMap() {
  if (geoState.map) { try { geoState.map.remove(); } catch { /* ignore */ } }
  geoState.map = null; geoState.ext = null; geoState.hosts = null; geoState.rect = null;
  geoState.selecting = false; geoState.rectStart = null; geoState.pathLayer = null;
}
function stopGeo() {
  teardownGeoMap();
  geoState.dests = []; geoState.internalHosts = [];
  // mapOpts closes over the view that is going away; a redraw through a stale
  // one would draw into a layer that no longer exists.
  geoState.mapOpts = null;
}

// ---- Destinations (MIGRATED — see public/views/destinations.js) -------------
// The Leaflet instance, the two marker layers, the region rectangle and the
// traceroute path layer stay here: they are live objects carrying the reader's
// pan, zoom and selection. The view asks for a canvas and app.js mounts into it.
function radiusForBytes(b) { return Math.max(6, Math.min(28, 6 + Math.log10((Number(b) || 0) + 1) * 3)); }
function destQuery(d) {
  const qs = new URLSearchParams();
  if (d.country) qs.set('country', d.country);
  if (d.asn != null && d.asn !== '') qs.set('asn', d.asn);
  if (geoState.sinceIso) qs.set('since', geoState.sinceIso);
  return qs.toString();
}

let destinationsView = null;
const destinationsViewState = {};

// Draws both marker sets from the last overview. Called on mount and on every
// period change; the map itself is never rebuilt, so the reader keeps their view.
function drawGeoMarkers(opts) {
  if (!geoState.ext || !geoState.hosts) return;
  geoState.ext.clearLayers();
  geoState.hosts.clearLayers();
  for (const h of geoState.internalHosts || []) {
    if (h.lat == null || h.lng == null) continue;
    const status = (geoState.healthByHost && geoState.healthByHost.get(h.hostId))
      || (h.status === 'online' ? 'unknown' : 'down');
    const m = L.circleMarker([h.lat, h.lng], {
      radius: 8, color: opts.ringColor, weight: 2,
      fillColor: opts.healthColor(status), fillOpacity: 0.95,
    });
    m.bindTooltip(`${h.siteName || `host ${h.hostId}`} (${h.status || '?'})`);
    m.on('click', () => opts.onHost(h));
    geoState.hosts.addLayer(m);
  }
  for (const d of geoState.dests) {
    const colour = opts.devColor(d.deviation);
    const c = L.circleMarker([d.lat, d.lng], {
      radius: radiusForBytes(d.bytes), color: colour,
      fillColor: colour, fillOpacity: 0.5, weight: 1,
    });
    c.bindTooltip(`${destTitleOf(d)} — ${fmtBytes(d.bytes)}`);
    c.on('click', () => opts.onDestination(d));
    geoState.ext.addLayer(c);
  }
}
function destTitleOf(d) {
  return `${d.country || '??'}${d.asn ? ` · AS${d.asn}` : ''}${d.asnName ? ` ${d.asnName}` : ''}`;
}
function pickGeoCenter() {
  const h = (geoState.internalHosts || []).find((x) => x.lat != null && x.lng != null);
  if (h) return [h.lat, h.lng];
  const d = geoState.dests.find((x) => x.lat != null && x.lng != null);
  return d ? [d.lat, d.lng] : [20, 0];
}

function mountGeoMap(canvas, opts) {
  teardownGeoMap();
  geoState.mapOpts = opts;
  // Deferred: the canvas is not in the document until the view is returned, and
  // Leaflet measures it on init.
  setTimeout(() => {
    if (!canvas.isConnected) return;
    const map = createLeafletMap(canvas, geoState.config || {}, { center: pickGeoCenter(), zoom: 3 });
    if (!map) return;
    geoState.map = map;
    geoState.ext = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({ maxClusterRadius: 50 })
      : L.layerGroup();
    geoState.hosts = L.layerGroup();
    geoState.ext.addTo(map);
    geoState.hosts.addTo(map);

    // Region drawing, active only while selecting.
    map.on('mousedown', (e) => { if (geoState.selecting) { geoState.rectStart = e.latlng; } });
    map.on('mousemove', (e) => {
      if (!geoState.selecting || !geoState.rectStart) return;
      const b = L.latLngBounds(geoState.rectStart, e.latlng);
      if (geoState.rect) geoState.rect.setBounds(b);
      else geoState.rect = L.rectangle(b, { color: opts.selectColor, weight: 1, fillOpacity: 0.08 }).addTo(map);
    });
    map.on('mouseup', (e) => {
      if (!geoState.selecting || !geoState.rectStart) return;
      const b = L.latLngBounds(geoState.rectStart, e.latlng);
      geoState.rectStart = null;
      geoState.selecting = false;
      map.dragging.enable();
      map.boxZoom.enable();
      opts.onRegion(geoState.dests.filter((d) => b.contains([d.lat, d.lng])));
      clearGeoRegion();
    });

    drawGeoMarkers(opts);
  }, 0);
}

function beginRegionSelect() {
  if (!geoState.map) return;
  geoState.selecting = true;
  geoState.map.dragging.disable();
  geoState.map.boxZoom.disable();
  ui.toast(t('dest.regionPrompt'));
}
function clearGeoRegion() {
  if (geoState.rect && geoState.map) { geoState.map.removeLayer(geoState.rect); }
  geoState.rect = null;
}

function getDestinationsView() {
  if (destinationsView) return destinationsView;
  if (typeof window === 'undefined' || !window.DestinationsView || !ui) return null;
  // target -> 'traceroute' | 'tcptraceroute': a TCP trace is stored as host:port
  // and is only found by asking the graph for that type.
  const pathTargetTypes = new Map();

  // geoState.dests is what the MAP can draw; the view gets every destination.
  // A destination with no coordinates is still traffic leaving the network —
  // it belongs in the table even when it cannot be put on the map.
  const takeOverview = (overview) => {
    const all = overview.externalDestinations || [];
    geoState.internalHosts = overview.internalHosts || [];
    geoState.dests = all.filter((d) => d.lat != null && d.lng != null);
    return { destinations: all };
  };

  destinationsView = window.DestinationsView.create({
    el, t, ui, errText, fmtBytes, gotoView,
    state: destinationsViewState,
    isAdmin: () => role === 'admin',
    hasMapLibrary: () => typeof L !== 'undefined',
    help: () => {
      const info = PAGE_INFO.geo || {};
      return { lead: info.hero || '', title: info.title || t('dest.title'), body: info.body || (() => []) };
    },
    fetchFirst: async () => {
      const [config, overview, fleet, agents] = await Promise.all([
        api('/api/geo/config').catch(() => ({})),
        api('/api/geo/overview'),
        api('/api/fleet/health').catch(() => ({ agents: [] })),
        api('/agents').catch(() => []),
      ]);
      geoState.config = config;
      geoState.healthByHost = new Map((fleet.agents || []).map((a) => [a.agentId, a.health && a.health.status]));
      return Object.assign({ config, agents }, takeOverview(overview));
    },
    fetchOverview: async () => {
      const qs = geoState.sinceIso ? `?since=${encodeURIComponent(geoState.sinceIso)}` : '';
      return takeOverview(await api(`/api/geo/overview${qs}`));
    },
    setPeriod: (period) => {
      const ms = period === '7d' ? 7 * 864e5 : period === '30d' ? 30 * 864e5 : 864e5;
      geoState.sinceIso = new Date(Date.now() - ms).toISOString();
    },
    redraw: () => { if (geoState.mapOpts) drawGeoMarkers(geoState.mapOpts); },
    mountMap: mountGeoMap,
    beginRegionSelect,
    exportAs: (fmt) => downloadExport('geo', fmt, geoState.sinceIso ? { since: geoState.sinceIso } : {}),
    // A destination with no flows in the period is a 404, which is an answer
    // rather than a failure.
    fetchDestination: async (d) => {
      const qs = destQuery(d);
      const flows = await api(`/api/geo/select/flows?${qs}`).catch((e) => { if (e.status === 404) return null; throw e; });
      if (!flows) return null;
      const res = await api(`/api/geo/select/findings?${qs}`).catch((e) => { if (e.status === 404) return { findings: [] }; throw e; });
      return { flows, findings: res.findings || [] };
    },
    fetchHost: async (h) => api(`/api/findings?hostId=${encodeURIComponent(h.hostId)}`),
    // Findings across the distinct countries in the box, bounded to eight.
    fetchRegionFindings: async (inBox) => {
      const countries = [...new Set(inBox.map((d) => d.country).filter(Boolean))].slice(0, 8);
      const seen = new Set();
      const out = [];
      for (const country of countries) {
        const qs = new URLSearchParams({ country });
        if (geoState.sinceIso) qs.set('since', geoState.sinceIso);
        // eslint-disable-next-line no-await-in-loop
        const res = await api(`/api/geo/select/findings?${qs}`).catch((e) => (e.status === 404 ? { findings: [] } : Promise.reject(e)));
        for (const f of res.findings || []) { if (!seen.has(f.id)) { seen.add(f.id); out.push(f); } }
      }
      return out;
    },
    loadPathTargets: async (agentId, list) => {
      list.replaceChildren();
      pathTargetTypes.clear();
      if (!agentId) return;
      try {
        const data = await api(`/api/probes/latest?agentId=${encodeURIComponent(agentId)}`);
        for (const r of (data.results || [])) {
          if (r.type !== 'traceroute' && r.type !== 'tcptraceroute') continue;
          if (!pathTargetTypes.has(r.target)) pathTargetTypes.set(r.target, r.type);
        }
        for (const target of pathTargetTypes.keys()) list.append(el('option', { value: target }));
      } catch { /* leave the list empty */ }
    },
    // Draws the path and resolves with the graph (plus its geolocated stops),
    // or null when a fresh traceroute had to be sent and produced nothing yet.
    showPath: async (agentId, target) => {
      if (!geoState.map) return null;
      const probeType = pathTargetTypes.get(target) || 'traceroute';
      const qs = `agentId=${encodeURIComponent(agentId)}&target=${encodeURIComponent(target)}&probeType=${encodeURIComponent(probeType)}`;
      let data = await api(`/api/probes/path?${qs}`);
      if (!(data.nodes && data.nodes.length)) {
        // Nothing stored yet: ask for a run, then poll.
        //
        // The run used to be hard-coded to 'traceroute' while the QUERY filtered
        // on probeType. For a target last traced with tcptraceroute that stored
        // a traceroute result the poll was not looking for, so it never found
        // anything and the path never appeared. Run what we are asking for.
        await api(`/agents/${agentId}/probe`, { method: 'POST', body: { type: probeType, host: target } });
        // Poll for a path OR for a recorded failure, whichever lands first. A
        // probe that cannot run (no traceroute binary, -T without root) reports
        // back within seconds; waiting out the full path timeout before looking
        // meant the operator stared at nothing for a minute and a half to be
        // told something the agent had already said.
        const out = await pollForPath(qs, () => pathFailureReason(agentId, target, probeType));
        if (out && out.nodes) data = out;
        else return { empty: true, target, probeType, reason: (out && out.reason) || null };
      }
      return drawGeoPath(data);
    },
    clearPath: () => { if (geoState.pathLayer) geoState.pathLayer.clearLayers(); },
  });
  return destinationsView;
}

// Waits for a freshly-requested trace to land. A traceroute that walks 30 hops
// with a timeout on several of them routinely takes longer than a minute — the
// old 4 attempts at 4 s gave up after SIXTEEN SECONDS and reported no path for
// a probe that was still perfectly healthy and running.
const PATH_POLL_MS = 5000;
const PATH_POLL_ATTEMPTS = 18; // ~90 s
function pollForPath(qs, checkFailure) {
  return new Promise((resolve) => {
    let attempts = 0;
    const done = (v) => { clearInterval(poll); resolve(v); };
    const poll = setInterval(async () => {
      attempts += 1;
      try {
        const d = await api(`/api/probes/path?${qs}`);
        if (d.nodes && d.nodes.length) return done(d);
        // The agent may have reported a FAILURE instead of hops. That is an
        // answer, and waiting out the rest of the window cannot improve it.
        if (checkFailure) {
          const reason = await checkFailure();
          if (reason) return done({ reason });
        }
        if (attempts >= PATH_POLL_ATTEMPTS) done(null);
      } catch { done(null); }
    }, PATH_POLL_MS);
  });
}

// Why a requested trace produced no path. The agent stores its own failure text
// on the probe result, and ctFailureReason already turns that into a sentence
// (missing tool, needs root, name not found, timed out...). Without this the UI
// showed the same empty panel whether traceroute was not installed, needed root
// for -T, or was simply still running.
async function pathFailureReason(agentId, target, probeType) {
  try {
    const latest = await api(`/api/probes/latest?agentId=${encodeURIComponent(agentId)}`);
    const rows = (latest && latest.results) || [];
    const match = rows.filter((r) => r.target === target && r.type === probeType).pop()
      || rows.filter((r) => r.target === target).pop();
    if (!match) return null;            // never landed: still running, or never dispatched
    if (match.ok) return null;          // it succeeded but placed no hops — a geo problem, not a probe one
    const why = ctFailureReason(match);
    return (why && (why.full || why.short)) || match.detail || null;
  } catch { return null; }
}

// Overlays a traceroute path graph (from /api/probes/path) onto the map in a
// dedicated layer that "Clear path" wipes — the same pathGeoStops/
// renderPathStops the Probes traceroute map uses.
function drawGeoPath(graph) {
  if (!geoState.map) return null;
  const stops = pathGeoStops(graph.nodes || []);
  if (!geoState.pathLayer) geoState.pathLayer = L.layerGroup().addTo(geoState.map);
  geoState.pathLayer.clearLayers();
  if (stops.length >= 2) {
    const latlngs = renderPathStops(geoState.pathLayer, stops);
    try { geoState.map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 7 }); } catch { /* single point */ }
  }
  return Object.assign({}, graph, { stops });
}

views.geo = async () => {
  const v = getDestinationsView();
  if (!v) return el('div', { class: 'empty error' }, t('dest.err.title'));
  return v.view();
};

// Maps an hsflowd exporter state to a badge colour class.
function hsflowdBadgeClass(state) {
  if (state === 'active') return 'badge active';
  if (state === 'failed' || state === 'install_failed' || state === 'permission_denied') return 'badge offline';
  return 'badge'; // inactive / not_installed / unknown
}

// Cell showing the selected traffic source + what the agent reports it can do,
// plus the live hsflowd exporter state when the agent has reported one (the
// result of enabling/disabling "Local hsflowd exporter").
function agentSourceCell(a) {
  const mc = a.monitor_config || {};
  const source = mc.source || 'proc';
  const caps = a.capabilities && Array.isArray(a.capabilities.sources) ? a.capabilities.sources : null;
  const detail = source === 'snmp' && mc.snmp ? ` (${mc.snmp.host})` : '';
  const hs = a.hsflowd && a.hsflowd.state ? a.hsflowd : null;
  return el('div', {},
    el('span', { class: 'badge' }, source + detail),
    caps ? el('div', { class: 'muted', title: 'Agent capabilities' }, `can: ${caps.join(', ')}`) : null,
    hs ? el('div', { class: 'muted', title: hs.detail || (hs.at ? `reported ${hs.at}` : '') },
      'hsflowd: ', el('span', { class: hsflowdBadgeClass(hs.state) }, hs.state)) : null);
}

function editAgent(a) {
  const mc = a.monitor_config || {};
  const snmp = mc.snmp || {};
  const sflowHs = (mc.sflow && mc.sflow.hsflowd) || null;
  const hsObj = sflowHs && typeof sflowHs === 'object' ? sflowHs : {};
  const caps = a.capabilities && Array.isArray(a.capabilities.sources) ? a.capabilities.sources : [];
  // Only offer sources the agent says it supports (fall back to both if unknown).
  const sourceOptions = (caps.length ? caps : ['proc', 'snmp']).map((s) => ({ value: s, label: s }));
  openModal(`Edit agent ${a.id}`, [
    { name: 'display_name', label: 'Display name', value: a.display_name || '' },
    { name: 'location_id', label: 'Location', type: 'select', value: a.location_id ? String(a.location_id) : '',
      options: [{ value: '', label: '(none)' }, ...locationCache.map((l) => ({ value: String(l.id), label: l.name }))] },
    { name: 'notes', label: 'Notes', type: 'textarea', value: a.notes || '' },
    { name: 'source', label: 'Traffic source', type: 'select', value: mc.source || 'proc', options: sourceOptions },
    { name: 'snmp_host', label: 'SNMP host (only for snmp)', value: snmp.host || '' },
    { name: 'snmp_community', label: 'SNMP community', value: snmp.community || 'public' },
    { name: 'snmp_version', label: 'SNMP version', type: 'select', value: snmp.version || '2c',
      options: ['1', '2c'].map((s) => ({ value: s, label: s })) },
    { name: 'snmp_port', label: 'SNMP port', type: 'number', value: String(snmp.port || 161) },
    { name: 'netflow_port', label: 'NetFlow UDP port (only for netflow)', type: 'number',
      value: String((mc.netflow && mc.netflow.port) || 2055) },
    { name: 'sflow_port', label: 'sFlow UDP port (only for sflow)', type: 'number',
      value: String((mc.sflow && mc.sflow.port) || 6343) },
    { name: 'collector_bind', label: 'Collector bind address (netflow/sflow; blank = all interfaces, 127.0.0.1 = local hsflowd only)',
      value: (mc.netflow && mc.netflow.bindAddress) || (mc.sflow && mc.sflow.bindAddress) || '' },
    { name: 'sflow_hsflowd', label: 'Local hsflowd exporter (sflow; native installs — Docker uses the sidecar)', type: 'select',
      value: sflowHs ? 'on' : 'off',
      options: [{ value: 'off', label: 'Off (receives sFlow from a switch)' }, { value: 'on', label: 'On (sample this host)' }] },
    { name: 'sflow_sampling', label: 'hsflowd sampling (1-in-N packets)', type: 'number', value: String(hsObj.samplingRate || 256) },
    { name: 'sflow_device', label: 'hsflowd interface', value: hsObj.device || 'eth0' },
  ], async (v) => {
    let monitor_config = null;
    if (v.source === 'snmp') {
      if (!v.snmp_host.trim()) throw new Error('SNMP host is required for source "snmp"');
      monitor_config = {
        source: 'snmp',
        snmp: {
          host: v.snmp_host.trim(),
          community: v.snmp_community || 'public',
          version: v.snmp_version,
          port: Number(v.snmp_port) || 161,
        },
      };
    } else if (v.source === 'netflow') {
      const netflow = { port: Number(v.netflow_port) || 2055 };
      if (v.collector_bind && v.collector_bind.trim()) netflow.bindAddress = v.collector_bind.trim();
      monitor_config = { source: 'netflow', netflow };
    } else if (v.source === 'sflow') {
      const sflow = { port: Number(v.sflow_port) || 6343 };
      if (v.collector_bind && v.collector_bind.trim()) sflow.bindAddress = v.collector_bind.trim();
      if (v.sflow_hsflowd === 'on') {
        const hs = {};
        const rate = Number(v.sflow_sampling);
        if (Number.isInteger(rate) && rate > 0) hs.samplingRate = rate;
        if (v.sflow_device && v.sflow_device.trim()) hs.device = v.sflow_device.trim();
        sflow.hsflowd = Object.keys(hs).length ? hs : true;
      }
      monitor_config = { source: 'sflow', sflow };
    } else if (v.source === 'proc') {
      monitor_config = { source: 'proc' };
    }
    await api(`/agents/${a.id}`, { method: 'PUT', body: {
      display_name: v.display_name || null,
      location_id: v.location_id ? Number(v.location_id) : null,
      notes: v.notes || null,
      meta: a.meta || null,
      monitor_config,
    } });
    closeModal(); toast('Agent updated'); render();
  });
}

async function deleteAgent(a) {
  if (!confirm(`Delete agent ${a.hostname}?`)) return;
  try { await api(`/agents/${a.id}`, { method: 'DELETE' }); toast('Agent deleted'); render(); }
  catch (err) { toast(err.message, true); }
}

// The per-location drill-down page: every agent at the site with its health
// verdict + key metrics, a scoped health summary, and the site's outbound
// dataflows (traffic map + list). Full-width; no tab — reached via
// openLocation(id). Clicking a dataflow opens the Flows page in Map mode
// scoped to this location.
views.location = async () => {
  const id = selectedLocationId;
  const root = el('div', { class: 'location-detail' });
  if (id == null) { root.append(el('div', { class: 'empty' }, 'Pick a location first.')); return root; }

  const [locations, agents, fleet] = await Promise.all([
    api('/locations').catch(() => []),
    api('/agents').catch(() => []),
    api('/api/fleet/health').catch(() => ({ agents: [], summary: {} })),
  ]);
  const loc = locations.find((l) => String(l.id) === String(id));
  if (!loc) { root.append(el('div', { class: 'error' }, 'Location not found.')); return root; }
  const members = agents.filter((a) => String(a.location_id) === String(id));
  const fleetById = new Map((fleet.agents || []).map((a) => [a.agentId, a]));
  const scoped = members.map((m) => fleetById.get(m.id)).filter(Boolean);

  root.append(el('div', { class: 'section-head' },
    el('button', { class: 'small ghost', onclick: () => { currentView = 'locations'; render(); } }, '← Locations'),
    el('h2', {}, '📍 ', loc.name),
    loc.description ? el('span', { class: 'muted' }, loc.description) : null,
    loc.latitude != null ? el('span', { class: 'muted' }, `· ${Number(loc.latitude).toFixed(3)}, ${Number(loc.longitude).toFixed(3)}`) : null,
    el('span', { class: 'spacer' }),
    el('button', { class: 'small ghost', onclick: () => openFlows(null, { mode: 'map', locationId: id }) }, 'Flows →'),
    el('button', { class: 'small ghost', onclick: () => showLocationTraffic(loc) }, 'Live traffic'),
    featureEnabled('assistant') ? el('button', { class: 'small ghost', onclick: () => showLocationSummary(loc) }, 'AI status') : null,
    canWrite() ? el('button', { class: 'small ghost', onclick: () => editLocation(loc) }, 'Edit') : null));

  // Health summary for just this site's agents (same KPI language as Overview).
  const summary = { ok: 0, warn: 0, bad: 0, down: 0, stale: 0, unknown: 0 };
  for (const a of scoped) if (a.health && a.health.status in summary) summary[a.health.status] += 1;
  const k = fleetKpis({ agents: scoped, summary });
  const lossStatus = k.loss == null ? 'accent' : k.loss >= 20 ? 'bad' : k.loss >= 2 ? 'warn' : 'ok';
  const agStatus = k.total && k.online === 0 ? 'bad' : k.online < k.total ? 'warn' : 'ok';
  root.append(el('div', { class: 'noc-kpis loc-kpis' },
    kpiCard('Agents', `${k.online}/${k.total}`, 'online at this site', agStatus),
    kpiCard('Latency', k.latency == null ? '–' : `${k.latency} ms`, 'median RTT', 'accent'),
    kpiCard('Packet loss', k.loss == null ? '–' : `${k.loss}%`, 'worst agent', lossStatus),
    kpiCard('Jitter', k.jitter == null ? '–' : `${k.jitter} ms`, 'median', k.jitter >= 30 ? 'warn' : 'accent'),
    kpiCard('Test paths', `${k.paths}`, 'monitored targets', 'accent'),
    kpiCard('Alerts', `${k.alerts}`, k.crit ? `${k.crit} critical` : (k.warn ? `${k.warn} warning` : 'all clear'), k.crit ? 'bad' : (k.warn ? 'warn' : 'ok'))));

  // Agents at this location — the fleet table's columns, scoped. Click → agent page.
  const agentRow = (m) => {
    const a = fleetById.get(m.id);
    const h = a && a.health; const met = (h && h.metrics) || {};
    return el('tr', { class: 'fleet-row', tabindex: '0', onclick: () => openAgent(m.id), onkeydown: (e) => { if (e.key === 'Enter') openAgent(m.id); } },
      el('td', {}, el('div', {}, m.display_name || m.hostname), m.display_name && m.display_name !== m.hostname ? el('div', { class: 'muted' }, m.hostname) : null),
      el('td', {}, el('span', { class: `badge ${m.status}` }, m.status)),
      el('td', {}, h ? healthBadge(h) : el('span', { class: 'muted' }, '–')),
      el('td', { class: 'num' }, met.lossPct != null ? `${met.lossPct}%` : '–'),
      el('td', { class: 'num' }, latencyText(met)),
      el('td', { class: 'num' }, met.jitterMs != null ? `${met.jitterMs} ms` : '–'),
      el('td', { class: 'num muted' }, met.targets ? `${met.reachable}/${met.targets}` : '–'),
      el('td', { class: 'num' }, throughputText(a && a.throughput)),
      el('td', { class: 'muted' }, (a && a.quality && a.quality.version) || (m.capabilities && m.capabilities.version) || '–'),
      el('td', { class: 'muted' }, m.last_seen ? fmtDate(m.last_seen) : '–'));
  };
  const agentsCard = el('div', { class: 'card loc-card' }, el('h3', {}, `Agents (${members.length})`));
  if (!members.length) agentsCard.append(el('div', { class: 'empty' }, 'No agents at this location yet.'));
  else agentsCard.append(el('table', { class: 'agents-table' },
    el('thead', {}, el('tr', {}, ...['Agent', 'Connection', 'Health', 'Loss', 'Latency', 'Jitter', 'Targets', 'Throughput', 'Version', 'Last seen'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...members.map(agentRow))));
  root.append(agentsCard);

  // Dataflows: the site's external traffic as colored directional arrows + a
  // clickable list. Every dataflow row/arc opens Flows → Map for this site.
  const toFlows = () => openFlows(null, { mode: 'map', locationId: id });
  const flowsListHost = el('div', { class: 'flowmap-list' }, el('div', { class: 'muted' }, 'Loading…'));
  const flowsCard = el('div', { class: 'card loc-card' },
    el('h3', {}, 'Data flows ', el('span', { class: 'muted' }, '· click a flow to inspect it in Flows')),
    flowsListHost);
  const mapCard = trafficMapCard({
    scope: { locationId: id },
    title: `Traffic map — ${loc.name}`,
    onArcClick: toFlows,
    onData: (data) => {
      const siteByKey = new Map((data.sites || []).map((s) => [s.key, s]));
      if (!data.arcs.length) { flowsListHost.replaceChildren(el('div', { class: 'empty' }, 'No geolocated flows in the window.')); return; }
      flowsListHost.replaceChildren(...data.arcs.slice(0, 20).map((a) => {
        const site = siteByKey.get(a.siteKey);
        const dirTxt = a.direction === 'in' ? '◂ in' : a.direction === 'both' ? '⇄ both' : 'out ▸';
        return el('div', { class: 'flowmap-row', role: 'button', tabindex: '0', onclick: toFlows, onkeydown: (e) => { if (e.key === 'Enter') toFlows(); } },
          el('span', { class: 'tc-dot', style: `background:${trafficTypeColor(a.category)}` }),
          el('span', { class: 'fmr-dst' },
            el('span', {}, `${site ? site.name : loc.name} → ${a.country}`),
            el('span', { class: 'muted' }, `${a.label}${a.asnNames && a.asnNames.length ? ' · ' + a.asnNames[0] : ''}`)),
          el('span', { class: 'fmr-vol num' }, fmtBytes(a.bytes), el('span', { class: `fmr-dir dir-${a.direction}` }, dirTxt)));
      }));
    },
  });
  root.append(el('div', { class: 'loc-grid' }, mapCard, flowsCard));
  return root;
};

// ---- Locations (MIGRATED — see public/views/locations.js)
let locationsPage = null;
function getLocationsPage() {
  if (locationsPage) return locationsPage;
  if (typeof window === 'undefined' || !window.LocationsPage || !ui) return null;
  locationsPage = window.LocationsPage.create({
    el, t, ui,
    canWrite, canDelete,
    hasAssistant: () => featureEnabled('assistant'),
    help: () => ({ title: t('loc.info.title'), body: () => [
      el('p', {}, t('loc.info.p1')),
      el('p', {}, t('loc.info.p2')),
      el('p', { class: 'muted' }, t('loc.info.p3')),
    ] }),
    fetchAll: () => api('/locations'),
    open: openLocation,
    edit: editLocation,
    remove: deleteLocation,
    // Three modals with their own polling and charts, passed in whole.
    traffic: showLocationTraffic,
    history: showLocationHistory,
    summary: showLocationSummary,
    errText,
  });
  return locationsPage;
}

views.locations = async () => {
  const v = getLocationsPage();
  if (!v) return el('div', { class: 'empty error' }, t('loc.err.title'));
  return v.view();
};

// AI status: a brief, plain-language "what's going on at this location?" summary
// from the opt-in assistant (per-agent health verdicts + recent findings). One
// click, no question to type. Degrades gracefully when the feature is off (403).
async function showLocationSummary(l) {
  const card = $('#modal-card');
  const out = el('div', { class: 'assistant-out muted' }, 'Thinking…');
  const close = el('button', { class: 'ghost', onclick: closeModal }, 'Close');
  card.replaceChildren(
    el('h3', {}, `AI status — ${l.name}`),
    el('p', { class: 'muted' }, 'Based on the latest probe-health verdicts and findings for this location.'),
    out,
    el('div', { class: 'form-actions' }, close));
  $('#modal').classList.remove('hidden');
  try {
    const res = await api('/api/assistant/location-summary', { method: 'POST', body: { locationId: l.id } });
    out.className = 'assistant-out';
    out.replaceChildren(
      el('div', {}, res.answer || '(empty response)'),
      el('div', { class: 'assistant-meta muted' }, `${res.model || ''} · ${res.agents ?? 0} agent(s) · ${res.findings ?? 0} finding(s) in context`));
  } catch (err) {
    out.className = 'assistant-out muted';
    out.textContent = err.status === 403
      ? 'The AI assistant is disabled. Set ANALYSIS_ASSISTANT_ENABLED=true (and an API key) in the server\'s .env to use it.'
      : (err.status === 404 ? 'Location not found.' : err.message);
  }
}

// Live, correlated traffic for all agents in a location. Polls every 3s while
// the panel is open; stops cleanly on close.
function showLocationTraffic(l) {
  const card = $('#modal-card');
  let timer = null;
  // Rolling time series of the location's summed rate, built while the panel is
  // open (max 60 points = 3 min at the 3s poll interval).
  const history = [];
  const MAX_POINTS = 60;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const close = () => { stop(); closeModal(); };

  async function tick() {
    let data;
    try {
      data = await api(`/locations/${l.id}/traffic`);
    } catch (err) {
      card.replaceChildren(
        el('h3', {}, `Traffic — ${l.name}`),
        el('p', { class: 'error' }, err.message),
        el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: close }, 'Close')));
      stop();
      return;
    }
    history.push({ rx: data.totals.rxBytesPerSec || 0, tx: data.totals.txBytesPerSec || 0 });
    if (history.length > MAX_POINTS) history.shift();

    const rows = data.agents.map((a) => el('tr', {},
      el('td', {}, a.displayName || a.hostname),
      el('td', {}, el('span', { class: `badge ${a.status}` }, a.status)),
      el('td', {}, a.rxBytesPerSec == null ? '–' : `${fmtBytes(a.rxBytesPerSec)}/s`),
      el('td', {}, a.txBytesPerSec == null ? '–' : `${fmtBytes(a.txBytesPerSec)}/s`),
      el('td', { class: 'muted' }, a.at ? fmtDate(a.at) : '–'),
    ));
    card.replaceChildren(
      el('h3', {}, `Traffic — ${l.name}`),
      el('div', { class: 'cards' },
        stat('Agents', String(data.agentCount)),
        stat('Reporting', String(data.reportingCount)),
        stat('RX total', `${fmtBytes(data.totals.rxBytesPerSec)}/s`),
        stat('TX total', `${fmtBytes(data.totals.txBytesPerSec)}/s`)),
      history.length >= 2
        ? trafficChart(history)
        : el('p', { class: 'muted' }, 'Collecting data points for the chart…'),
      data.agents.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['Agent', 'Status', 'RX/s', 'TX/s', 'Last'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows))
        : el('div', { class: 'empty' }, 'No agents in this location.'),
      el('p', { class: 'muted' }, `Updated ${fmtDate(data.at)} · auto every 3 s · chart: last ${history.length} measurements`),
      el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: close }, 'Close')));
  }

  card.replaceChildren(el('h3', {}, `Traffic — ${l.name}`), el('div', { class: 'empty' }, 'Loading…'));
  $('#modal').classList.remove('hidden');
  // Stop polling if the modal is dismissed by backdrop click / Escape path.
  const modal = $('#modal');
  const onModalClick = (e) => { if (e.target.id === 'modal') { stop(); modal.removeEventListener('click', onModalClick); } };
  modal.addEventListener('click', onModalClick);
  tick();
  timer = setInterval(tick, 3000);
}

// Historical traffic for a location between two dates/times: pick from/to, see a
// summed RX/TX graph + a per-measurement table for the range.
function showLocationHistory(l) {
  const card = $('#modal-card');
  // Default range: last 24h.
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fromInput = el('input', { type: 'datetime-local', value: toLocalInput(from) });
  const toInput = el('input', { type: 'datetime-local', value: toLocalInput(now) });
  const result = el('div', {});

  async function load() {
    result.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
    const qs = new URLSearchParams();
    const f = fromLocalInput(fromInput.value);
    const t = fromLocalInput(toInput.value);
    if (f) qs.set('from', f);
    if (t) qs.set('to', t);
    let data;
    try {
      data = await api(`/locations/${l.id}/traffic/history?${qs.toString()}`);
    } catch (err) {
      result.replaceChildren(el('p', { class: 'error' }, err.message));
      return;
    }
    const series = data.series.map((p) => ({ rx: p.rxBytesPerSec, tx: p.txBytesPerSec }));
    const rows = data.points.slice(0, 200).map((p) => el('tr', {},
      el('td', { class: 'muted' }, fmtDate(p.at)),
      el('td', {}, p.hostname),
      el('td', {}, `${fmtBytes(p.rxBytesPerSec)}/s`),
      el('td', {}, `${fmtBytes(p.txBytesPerSec)}/s`),
    ));
    result.replaceChildren(
      el('p', { class: 'muted' }, `${data.count} measurements · ${data.series.length} time points`),
      series.length >= 2 ? trafficChart(series) : el('p', { class: 'muted' }, 'Too few data points for a chart in this interval.'),
      data.points.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['Timestamp', 'Agent', 'RX/s', 'TX/s'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows))
        : el('div', { class: 'empty' }, 'No data in the interval.'));
  }

  card.replaceChildren(
    el('h3', {}, `History — ${l.name}`),
    el('div', { class: 'form-grid' },
      el('label', {}, 'From', fromInput),
      el('label', {}, 'To', toInput),
      el('div', { class: 'form-actions' },
        el('button', { onclick: load }, 'Search'),
        el('button', { class: 'ghost', onclick: closeModal }, 'Close'))),
    result);
  $('#modal').classList.remove('hidden');
  load();
}

// datetime-local helpers (local time <-> ISO).
function toLocalInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v) {
  if (!v || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Location editor with an interactive map picker + address search. Click the
// map to set coordinates (and reverse-geocode the address), or search an address
// (forward-geocode) and pick a hit to fill coordinates + address. Tiles and the
// geocoder come from /api/map/config (configurable / EU-sourced).
async function editLocation(l) {
  let mapCfg = {};
  try { mapCfg = await api('/api/map/config'); } catch { mapCfg = {}; }

  const name = el('input', { type: 'text', value: l ? l.name : '' });
  const desc = el('textarea', { rows: 2 }, l ? l.description || '' : '');
  const address = el('input', { type: 'text', value: l ? l.address || '' : '' });
  const lat = el('input', { type: 'number', step: 'any', value: l && l.latitude != null ? String(l.latitude) : '' });
  const lng = el('input', { type: 'number', step: 'any', value: l && l.longitude != null ? String(l.longitude) : '' });
  const search = el('input', { type: 'text', placeholder: 'Search address…' });
  const results = el('div', { class: 'geocode-results' });
  const mapEl = el('div', { class: 'map picker-map' });
  const err = el('p', { class: 'error' });

  let map = null;
  let marker = null;
  function setPoint(la, lo, recenter) {
    lat.value = Number(la).toFixed(6);
    lng.value = Number(lo).toFixed(6);
    if (map) {
      if (marker) marker.setLatLng([la, lo]); else marker = L.marker([la, lo]).addTo(map);
      if (recenter) map.setView([la, lo], Math.max(map.getZoom(), 13));
    }
  }
  async function reverseGeocode(la, lo) {
    try {
      const data = await api(`/api/geocode/reverse?lat=${la}&lon=${lo}`);
      if (data && data.display_name) address.value = data.display_name;
    } catch { /* geocoder optional */ }
  }
  async function doSearch() {
    const q = search.value.trim();
    results.replaceChildren();
    if (!q) return;
    results.append(el('p', { class: 'muted' }, 'Searching…'));
    try {
      const list = await api(`/api/geocode/search?q=${encodeURIComponent(q)}`);
      results.replaceChildren(...(Array.isArray(list) && list.length ? list.map((r) => el('button', {
        type: 'button', class: 'geocode-hit', onclick: () => {
          setPoint(Number(r.lat), Number(r.lon), true);
          if (r.display_name) { address.value = r.display_name; search.value = r.display_name; }
          results.replaceChildren();
        },
      }, r.display_name)) : [el('p', { class: 'muted' }, 'No results.')]));
    } catch (e2) {
      const notConfigured = e2.status === 503;
      results.replaceChildren(el('p', { class: notConfigured ? 'muted' : 'error' }, notConfigured ? (e2.message || 'No geocoder configured (Settings → Map).') : 'Geocoder error.'));
    }
  }
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  async function save() {
    err.textContent = '';
    const body = {
      name: name.value.trim(),
      description: desc.value.trim() || null,
      address: address.value.trim() || null,
      latitude: lat.value.trim() === '' ? null : Number(lat.value),
      longitude: lng.value.trim() === '' ? null : Number(lng.value),
    };
    if (!body.name) { err.textContent = 'Name is required'; return; }
    try {
      if (l) await api(`/locations/${l.id}`, { method: 'PUT', body });
      else await api('/locations', { method: 'POST', body });
      closeModal(); toast('Saved'); render();
    } catch (e2) { err.textContent = e2.message; }
  }

  const form = el('div', { class: 'form-grid' },
    el('label', {}, 'Name', name),
    el('label', {}, 'Description', desc),
    el('label', {}, 'Address', address),
    el('label', {}, 'Search address', el('div', { class: 'geocode-row' }, search, el('button', { type: 'button', class: 'small', onclick: doSearch }, 'Search'))),
    results,
    mapEl,
    el('div', { class: 'coord-row' }, el('label', {}, 'Latitude', lat), el('label', {}, 'Longitude', lng)),
    el('p', { class: 'muted' }, 'Click on the map to set coordinates (and fetch the address).'),
    err,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'ghost', onclick: closeModal }, 'Cancel'),
      el('button', { type: 'button', onclick: save }, 'Save')));

  $('#modal-card').replaceChildren(el('h3', {}, l ? `Edit location ${l.id}` : 'New location'), form);
  $('#modal').classList.remove('hidden');

  if (typeof L !== 'undefined' && mapCfg.tileUrl) {
    setTimeout(() => {
      const has = l && l.latitude != null && l.longitude != null;
      map = L.map(mapEl).setView(has ? [l.latitude, l.longitude] : [20, 0], has ? 13 : 2);
      L.tileLayer(mapCfg.tileUrl, { maxZoom: mapCfg.maxZoom || 19, attribution: mapCfg.attribution || '' }).addTo(map);
      if (has) marker = L.marker([l.latitude, l.longitude]).addTo(map);
      map.on('click', (e) => { setPoint(e.latlng.lat, e.latlng.lng, false); reverseGeocode(e.latlng.lat, e.latlng.lng); });
      map.invalidateSize();
    }, 50);
  } else {
    mapEl.replaceChildren(el('p', { class: 'muted' }, 'Map unavailable (offline or no tile URL).'));
  }
}
async function deleteLocation(l) {
  if (!confirm(`Delete location "${l.name}"?`)) return;
  try { await api(`/locations/${l.id}`, { method: 'DELETE' }); toast('Deleted'); render(); }
  catch (err) { toast(err.message, true); }
}

// Platforms offered in the wizard. The command response says which are actually
// published (and the checksum); unpublished ones still produce a code + manual
// instructions, just without a verified binary yet.
const ENROLL_PLATFORMS = [
  ['linux-amd64', 'Linux (x86-64)'],
  ['linux-arm64', 'Linux (ARM64)'],
  ['linux-armv7', 'Linux (ARMv7)'],
  ['windows-amd64', 'Windows (x86-64)'],
  ['darwin-amd64', 'macOS (Intel)'],
  ['darwin-arm64', 'macOS (Apple Silicon)'],
];

// Set while a freshly generated code is on screen: the live WS handler calls it
// when any agent enrolls/comes online, flipping "Waiting for agent…" to connected.
let enrollWatch = null;

// ---- Enrollment (MIGRATED — see public/views/enrollment.js)
// The generated code + command block (renderEnrollResult) stays here: it holds
// the live "waiting for agent" socket state, the Windows two-step variant and
// the manual checksum block.
let enrollmentPage = null;
function getEnrollmentPage() {
  if (enrollmentPage) return enrollmentPage;
  if (typeof window === 'undefined' || !window.EnrollmentPage || !ui) return null;
  enrollmentPage = window.EnrollmentPage.create({
    el, t, ui, toast, errText,
    canWrite, canDelete,
    isAdmin: () => role === 'admin',
    platforms: () => ENROLL_PLATFORMS,
    help: () => ({ title: t('enroll.info.title'), body: () => [
      el('p', {}, t('enroll.info.p1')),
      el('p', {}, t('enroll.info.p2')),
      el('p', { class: 'muted' }, t('enroll.info.p3')),
    ] }),
    fetchAll: async () => {
      const [codes, locations, cfg] = await Promise.all([
        api('/enrollment-codes'),
        api('/locations').catch(() => []),
        api('/enroll/config').catch(() => ({ serverUrl: location.origin, certFingerprint: null })),
      ]);
      locationCache = locations;
      // A new render means no code is on screen yet, so nothing is waiting.
      enrollWatch = null;
      return { codes, locations, cfg };
    },
    generate: ({ platform, maxUses, ttlMinutes, locationId }) => {
      const q = new URLSearchParams({ platform, maxUses: String(maxUses), ttlMinutes: String(ttlMinutes) });
      if (locationId) q.set('locationId', locationId);
      return api(`/api/enroll/command?${q.toString()}`);
    },
    renderResult: renderEnrollResult,
    createCode,
    deleteCode,
    deleteExpired: deleteExpiredCodes,
    openAgent,
    openSettings: (tab) => { settingsTab = tab; currentView = 'settings'; render(); },
  });
  return enrollmentPage;
}

views.enrollment = async () => {
  const v = getEnrollmentPage();
  if (!v) return el('div', { class: 'empty error' }, t('enroll.err.title'));
  return v.view();
};

function enrollKv(k, v) {
  return el('div', { class: 'enroll-kv' }, el('span', { class: 'k' }, k), v);
}

function renderEnrollResult(host, data, cfg, regen) {
  host.classList.remove('hidden');
  const oneLiner = data.oneLiner;

  // Live status: correlate the next enrollment/online event with this code.
  const live = el('div', { class: 'enroll-live waiting' },
    el('span', { class: 'dot' }), el('span', { class: 'txt' }, 'Waiting for agent…'));
  enrollWatch = (kind, payload) => {
    if (kind === 'enrolled' || kind === 'online') {
      live.className = 'enroll-live ok';
      live.querySelector('.txt').textContent = `Connected ✓${payload && payload.hostname ? ' — ' + payload.hostname : ''}`;
    }
  };

  const cmdPre = el('pre', { class: 'enroll-cmd' }, oneLiner);
  const copyBtn = el('button', { class: 'small', onclick: () => copyText(oneLiner) }, 'Copy command');

  // Manual download + checksum, hidden by default for security-minded users.
  const manual = el('div', { class: 'enroll-manual hidden' },
    el('p', { class: 'muted small' }, 'Manual installation — inspect before running:'),
    enrollKv('Download', el('code', {}, data.manual.downloadUrl)),
    enrollKv('SHA-256', el('code', {}, data.manual.checksum || '(no agent source published on the server)')),
    enrollKv('Kommando', el('code', {}, data.manual.command)),
    (cfg && cfg.certFingerprint) ? enrollKv('Cert-fingerprint', el('code', {}, cfg.certFingerprint)) : null);
  const manualToggle = el('button', { class: 'small ghost', onclick: () => manual.classList.toggle('hidden') }, 'Show manual / checksum');
  const regenBtn = el('button', { class: 'small ghost', onclick: regen }, 'Generate new code');

  const usesText = data.maxUses > 1 ? ` · bulk: ${data.usesRemaining}/${data.maxUses} machines` : '';
  const meta = el('p', { class: 'muted small' }, `Code ${data.code} · expires ${fmtDate(data.expiresAt)}${usesText}`);

  // Per-OS run note: Windows needs an elevated PowerShell (curl|sh won't run);
  // Linux/macOS need root for the system service. The Ansible helper only fits
  // the Linux shell installer, so it's hidden for Windows/macOS.
  const os = data.os || 'linux';
  let runNote;
  if (os === 'windows') {
    const bits = ['Run this in an ', el('strong', {}, 'elevated PowerShell (Administrator)'), ' on the Windows host. It forces TLS 1.2 and installs the agent as a scheduled task that starts at boot.',
      el('br'), el('span', {}, t('enroll.win.note'))];
    // Without a pinned cert fingerprint, Windows PowerShell rejects a self-signed
    // server cert — tell the operator how to make the download trust it.
    if (!data.certFingerprint) {
      bits.push(el('br'));
      bits.push(el('span', {}, 'If the server uses a self-signed TLS certificate, set its SHA-256 fingerprint (', el('span', { class: 'mono' }, 'AGENT_CERT_FINGERPRINT'), ') on the server so the command can pin it — otherwise the download will fail cert validation.'));
    }
    runNote = el('p', { class: 'muted small' }, ...bits);
  } else {
    runNote = el('p', { class: 'muted small' }, 'Run on the target host; the installer needs root for the system service (', el('span', { class: 'mono' }, 'sudo'), ' — it will tell you if so).');
  }

  host.replaceChildren(
    live,
    el('div', { class: 'enroll-cmd-row' }, cmdPre, copyBtn),
    runNote,
    el('div', { class: 'form-actions' }, manualToggle, regenBtn),
    manual,
    meta,
    os === 'windows' ? enrollWinStepsBlock(data.steps) : null,
    os === 'linux' ? enrollAnsibleBlock(oneLiner) : null);
}

// The Windows install shown as the two steps it really is: download the script,
// then run the file. The one-liner above does both in a single paste; this block
// lets an operator stop in between and read the script first — and gives them a
// way through when the scripted download itself is blocked (a proxy, or endpoint
// AV that will not let PowerShell fetch anything) and the file has to be saved
// from a browser and carried over. Windows only, and only when the server sent
// the split steps.
function enrollWinStepsBlock(steps) {
  if (!steps || !steps.download || !steps.run) return null;
  const step = (label, cmd) => el('div', {},
    el('p', { class: 'muted small' }, label),
    el('div', { class: 'enroll-cmd-row' },
      el('pre', { class: 'enroll-cmd' }, cmd),
      el('button', { class: 'small', onclick: () => copyText(cmd) }, t('enroll.win.copy'))));
  return el('details', { class: 'enroll-ansible' },
    el('summary', {}, t('enroll.win.stepsSummary')),
    step(t('enroll.win.step1'), steps.download),
    step(t('enroll.win.step2'), steps.run),
    // ?download=1 so the browser saves the file instead of rendering it as text.
    el('p', { class: 'muted small' }, t('enroll.win.saveHint', { url: `${steps.scriptUrl}?download=1` })));
}

// Copy-paste Ansible task running the same one-liner. `creates:` makes it
// idempotent (skips hosts where the agent is already installed).
function enrollAnsibleBlock(oneLiner) {
  const yaml = [
    '- hosts: all',
    '  become: true',
    '  tasks:',
    '    - name: Install BlueEyes agent',
    `      ansible.builtin.shell: "${oneLiner}"`,
    '      args:',
    '        creates: /opt/blueeye-agent/blueeye-agent',
  ].join('\n');
  return el('details', { class: 'enroll-ansible' },
    el('summary', {}, 'Ansible / config-management (copy-paste)'),
    el('p', { class: 'muted small' }, 'Same one-liner, deployed to many machines. "creates" makes it idempotent.'),
    el('div', { class: 'enroll-cmd-row' },
      el('pre', { class: 'enroll-cmd' }, yaml),
      el('button', { class: 'small', onclick: () => copyText(yaml) }, 'Copy')));
}

function createCode() {
  openModal('New enrollment code (advanced)', [
    { name: 'location_id', label: 'Location (optional)', type: 'select', value: '',
      options: [{ value: '', label: '(none)' }, ...locationCache.map((l) => ({ value: String(l.id), label: l.name }))] },
    { name: 'expiresInMinutes', label: 'Lifetime (minutes)', type: 'number', value: '60' },
    { name: 'maxUses', label: 'Number of machines (bulk)', type: 'number', value: '1' },
  ], async (v) => {
    const body = {};
    if (v.location_id) body.location_id = Number(v.location_id);
    if (v.expiresInMinutes) body.expiresInMinutes = Number(v.expiresInMinutes);
    if (v.maxUses) body.maxUses = Number(v.maxUses);
    const created = await api('/enrollment-codes', { method: 'POST', body });
    closeModal();
    const card = $('#modal-card');
    card.replaceChildren(
      el('h3', {}, 'Code created'),
      el('p', { class: 'muted' }, 'Copy the code now — it is only shown this once:'),
      el('pre', {}, created.code),
      created.max_uses > 1 ? el('p', { class: 'muted small' }, `Bulk code: can be used ${created.max_uses} times.`) : null,
      el('div', { class: 'form-actions' }, el('button', {}, 'Close')));
    card.querySelector('button').addEventListener('click', () => { closeModal(); render(); });
    $('#modal').classList.remove('hidden');
  });
}
async function deleteCode(c) {
  if (!confirm('Delete code?')) return;
  try { await api(`/enrollment-codes/${c.id}`, { method: 'DELETE' }); toast('Deleted'); render(); }
  catch (err) { toast(err.message, true); }
}

// Bulk cleanup: drop every code badged "expired" (timed out with uses left).
// The server decides what qualifies — `n` is only what the list showed, used to
// word the confirmation — and answers with the number it actually deleted.
async function deleteExpiredCodes(n) {
  if (!confirm(t('enroll.codes.deleteExpiredConfirm', { n }))) return;
  try {
    const res = await api('/enrollment-codes/expired', { method: 'DELETE' });
    const deleted = (res && Number(res.deleted)) || 0;
    toast(deleted ? t('enroll.codes.deleteExpiredDone', { n: deleted }) : t('enroll.codes.deleteExpiredNone'));
    render();
  } catch (err) { toast(err.message, true); }
}

// ---- Settings (settings overview: users + license + config) ---------
let settingsTab = null;
// Which Service Assurance screen the nav last asked for. The module owns its own
// tab bar; this is only how a nav entry deep-links into one of its tabs.
let serviceAssuranceTab = null;
// Which guide the Guides nav group asked for (data-guide). Null opens the first.
let guideTrack = null;
// Settings are organised into labelled sections rather than one long row of tabs,
// so related controls sit together and the page stays scannable as it grows. Each
// tab is [key, label, adminOnly]; non-admins only ever see the personal section.
const SETTINGS_GROUPS = [
  ['Access & security', [['users', 'Users', true], ['auth', 'Authentication', true], ['apitokens', 'API tokens', true], ['agentkey', 'Agent key', true]]],
  ['Detection & alerts', [['analyse', 'Analysis', true], ['alerting', 'Alerting', true], ['severity', 'Severity rules', true], ['runbooks', 'Runbooks', true], ['integrations', 'ITSM', true], ['cmdb', 'CMDB', true], ['ai', 'AI', true], ['maintenance', 'Maintenance', true]]],
  ['Data', [['database', 'Database', true], ['retention', 'Retention', true], ['types', 'Traffic types', true], ['map', 'Map', true]]],
  ['System', [['updates', 'Updates', true], ['agents', 'Agents', true], ['snmp', 'SNMP devices', true], ['screening', 'Test Settings', true], ['assurance', 'Service Assurance', true]]],
  ['Personal', [['appearance', 'Appearance', false], ['license', 'License', false]]],
];
// ---- Logs (admin-only operational + client-error view) ----------------------
// The in-memory server operational stream (agent connect/disconnect, WS/DB
// errors, HTTP failures) merged with client-side action failures. A live
// diagnostic aid — cleared on server restart. Distinct from Reporting → Audit
// (the durable "who did what" trail).
let logsFilter = { level: '', source: '', q: '' };

function mergeLogEntries(serverEntries) {
  // Server ring already contains client errors shipped from any session (id
  // prefixed with 'c'); dedup this session's local copies against them so a
  // client error isn't shown twice.
  const shipped = new Set(serverEntries.filter((e) => e.source === 'client').map((e) => String(e.id).replace(/^c/, '')));
  const localOnly = clientLog.filter((e) => !shipped.has(e.id));
  return [...serverEntries, ...localOnly].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

// ---- System Logs (MIGRATED — see public/views/systemLogs.js)
let systemLogsPage = null;
function getSystemLogsPage() {
  if (systemLogsPage) return systemLogsPage;
  if (typeof window === 'undefined' || !window.SystemLogsPage || !ui) return null;
  systemLogsPage = window.SystemLogsPage.create({
    el, t, ui,
    state: logsFilter,
    // Typing must not fire a request per keystroke.
    debounce: (fn) => setTimeout(fn, 250),
    help: () => ({ title: t('logs.info.title'), body: () => [
      el('p', {}, t('logs.info.p1')),
      el('p', {}, t('logs.info.p2')),
      el('p', { class: 'muted' }, t('logs.info.p3')),
    ] }),
    // Level is filtered in the view so the Level dropdown can count over the
    // full, search-filtered set — only q and limit go to the server. A server
    // ring that cannot be read is reported, never thrown: the local client
    // errors are still worth showing, and a toast here would re-enter
    // recordClientLog.
    fetchLogs: async (q) => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      p.set('limit', '500');
      try {
        const resp = await api(`/api/logs?${p.toString()}`);
        return { entries: mergeLogEntries(resp.entries || []), error: null };
      } catch (e) {
        return { entries: mergeLogEntries([]), error: errText(e) };
      }
    },
  });
  return systemLogsPage;
}

views.logs = async () => {
  const v = getSystemLogsPage();
  if (!v) return el('div', { class: 'empty error' }, t('logs.system.title'));
  return v.view();
};

// ---- User Logs (admin-only "who did what", with flags) ---------------------
// The other half of the Logs split, and THE audit log: System Logs answers "is
// the server healthy?", this answers "what did people do here?" — one row per
// action a PERSON performed, with the account behind it (id, name, e-mail),
// when, what, and a flag when the row deserves a second look. It reads both
// audit stores unconditionally: an audit record that is incomplete by plan is
// one nobody can trust. The flag rules and their explanations live server-side
// in src/audit/userActivity.js; this view only renders them, so the dashboard
// and a CSV export can never disagree about why something was flagged.
let userLogsFilter = { user: '', flagged: false, q: '' };

// ---- User Logs (MIGRATED — see public/views/userLogs.js)
// The flag rules and their explanations live server-side in
// src/audit/userActivity.js, so the dashboard and the CSV export can never
// disagree about why a row was flagged.
let userLogsPage = null;
function getUserLogsPage() {
  if (userLogsPage) return userLogsPage;
  if (typeof window === 'undefined' || !window.UserLogsPage || !ui) return null;
  const query = (f) => {
    const p = new URLSearchParams();
    if (f.user) p.set('user', f.user);
    if (f.flagged) p.set('flagged', '1');
    if (f.q) p.set('q', f.q);
    p.set('limit', '300');
    return p.toString();
  };
  userLogsPage = window.UserLogsPage.create({
    el, t, ui, errText,
    state: userLogsFilter,
    debounce: (fn) => setTimeout(fn, 250),
    help: () => ({ title: t('logs.user.info.title'), body: () => [
      el('p', {}, t('logs.user.info.p1')),
      el('p', {}, t('logs.user.info.p2')),
      el('p', { class: 'muted' }, t('logs.user.info.p3')),
    ] }),
    fetchLog: (f) => api(`/api/audit/users?${query(f)}`),
    fetchUsers: () => api('/users'),
    exportCsv: (f) => nis2Download(`/api/audit/users/export.csv?${query(f)}`, 'user-logs.csv'),
  });
  return userLogsPage;
}

views.userLogs = async () => {
  const v = getUserLogsPage();
  if (!v) return el('div', { class: 'empty error' }, t('logs.user.err.title'));
  return v.view();
};

// ---- Documentation (built-in handbook / how-tos) ---------------------------
// A static, in-app documentation centre. Content lives here as DOM-builder
// functions (same style as PAGE_INFO drawers) so it stays dependency-free and
// versions with the dashboard. Two-pane layout mirrors Settings: a grouped topic
// list on the left, the selected article on the right. RBAC: the "Getting
// started" and "Troubleshooting" sections are viewer+, the "Administration &
// setup" section is admin-only (the request: admin has full access). Cross-links
// reuse viewLink/settingsLink, which degrade to plain text when the target is
// hidden by role/licence — so an article never offers a dead end.
let docsTopic = null;

// Small article-building helpers (kept local to the docs feature).
function docsLead(text) { return el('p', { class: 'docs-lead' }, text); }
function docsCode(text) { return el('pre', { class: 'docs-code' }, text); }
function docsSteps(items) {
  return el('ol', { class: 'docs-steps' }, ...items.map((it) => el('li', {}, ...(Array.isArray(it) ? it : [it]))));
}
// A "What to expect" callout — success vs. failure signals for a task.
function docsExpect(...kids) {
  return el('div', { class: 'callout docs-expect' }, el('strong', {}, 'What to expect '), ...kids);
}
// A three-column reference table: symptom / meaning / action (or you-see / etc.).
function docsTable(head, rows) {
  return el('div', { class: 'docs-tablewrap' }, el('table', { class: 'docs-table' },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, ...(Array.isArray(c) ? c : [c]))))))));
}

// The handbook. Each article: { id, title, body: () => [nodes] }. Sections carry
// an `admin` flag; admin sections are dropped for non-admins before render.
const DOCS = [
  {
    section: 'Getting started', admin: false, articles: [
      {
        id: 'what-is', title: 'What BlueEyes does', body: () => [
          docsLead('The BlueEyes Network Resilience System is an on-prem network-monitoring server. Lightweight agents run on your machines and report metadata — traffic counters, active-probe results (ping/DNS/HTTP/traceroute), interface health and flow 5-tuples — back to this server, which stores, analyses and visualises it.'),
          el('p', {}, 'Everything is ', el('strong', {}, 'metadata only'), ' (ports, ASNs, timings, the 5-tuple) — never packet payload or deep inspection. Private (RFC1918) addresses are never geolocated. Analysis runs locally with explainable robust statistics (median + MAD), so every finding carries an explanation and its evidence — there is no cloud and no black-box ML.'),
          el('h4', {}, 'The moving parts'),
          el('ul', {},
            el('li', {}, el('strong', {}, 'Agents '), '— enrolled with a one-time code, then report over a WebSocket + REST. See ', viewLink('agents', 'Agents'), ' and ', viewLink('enrollment', 'Enrollment'), '.'),
            el('li', {}, el('strong', {}, 'This server '), '— stores measurements, derives health/findings/events, and is where you manage the fleet.'),
            el('li', {}, el('strong', {}, 'Integrations '), '— optional outbound links to ITSM/IPAM/CMDB (e.g. ServiceNow), alert channels and SSO — all configured in Settings (admin).')),
          docsExpect('Once an agent is enrolled and connected it turns green on the ', viewLink('fleet', 'Overview'), ' within a minute, and its traffic/probe data starts filling the ', viewLink('overview', 'Traffic'), ' and ', viewLink('probes', 'Probes'), ' pages.'),
        ],
      },
      {
        id: 'tour', title: 'Finding your way around', body: () => [
          docsLead('The left rail is grouped by job. Here is where each thing lives.'),
          docsTable(['Group', 'Use it for'], [
            [viewLink('fleet', 'Monitoring'), 'Overview (fleet health at a glance), Traffic, Sites (map) and Destinations (external traffic by country/ASN).'],
            [el('strong', {}, 'Fleet'), ['Per-', viewLink('agents', 'Agent'), ' drill-down, ', viewLink('interfaces', 'Interfaces'), ' health and NIC firmware inventory.']],
            [el('strong', {}, 'Diagnostics'), ['Ad-hoc ', viewLink('probes', 'Probes & Tests'), ', ', viewLink('flows', 'Flows'), ', Topology, the ', viewLink('investigation', 'Troubleshooting'), ' investigator — and this Documentation.']],
            [el('strong', {}, 'Insights'), ['Anomaly ', viewLink('findings', 'Analysis'), ', ', viewLink('events', 'Events'), ', ', viewLink('clusters', 'Situations'), ' (one event across many agents) and ', viewLink('reporting', 'Reporting'), ' (incl. NIS2).']],
            [el('strong', {}, 'Administration'), ['Locations, Enrollment, Logs and ', viewLink('settings', 'Settings'), '.']],
          ]),
          el('p', {}, 'Every page has a one-line hero at the top and a ', el('strong', {}, 'More info'), ' button that opens a drawer explaining that page in depth. The topbar search jumps to an agent, host, IP or port. The 🌙/☀️ button flips light/dark; pick a colour palette in ', settingsLink('appearance', 'Settings → Appearance'), '.'),
          el('p', { class: 'muted' }, 'What you can see depends on your role (viewer < operator < admin) and the licence. Items above your role, or excluded by the licence, are hidden or locked.'),
        ],
      },
    ],
  },
  {
    section: 'Troubleshooting how-tos', admin: false, articles: [
      {
        id: 'assurance', title: 'Watch a web service with Service Assurance', body: () => [
          docsLead('Probes tell you a host answers. Service Assurance tells you whether the thing people actually use still works — signing in, looking up a customer, placing an order — by driving a real browser through that journey on a schedule.'),
          el('p', {}, 'Nothing here needs code. You describe a journey by dragging steps into order and filling in forms; selectors, timeouts and the raw engine error live behind ', el('strong', {}, 'Technical details'), ' and are never needed to build or read a test.'),

          el('h4', {}, 'The short version'),
          docsSteps([
            ['Open ', viewLink('serviceAssurance', 'Service Assurance'), ' → Applications and add the web application, with the address people open (', el('code', {}, 'https://…'), ').'],
            ['Press ', el('strong', {}, 'Discover'), '. It looks around the application without changing anything and reports what it found.'],
            ['Accept a suggested test — ', el('strong', {}, 'Login'), ' is the usual first one — or build one by hand.'],
            ['Add a login under the application if the test signs in, then select it on the test.'],
            ['Press ', el('strong', {}, 'Run'), '. Then set a schedule so it keeps running.'],
          ]),

          el('h4', {}, 'What Discovery will and will not do'),
          el('div', { class: 'callout' }, el('strong', {}, 'Read-only by design: '), 'Discovery never submits a form and never clicks anything whose effect it cannot work out. A button it cannot read is recorded and left alone rather than assumed harmless. It stays on the application\u2019s own address — an external link is noted, never followed — and stops at the page, depth, request and time budgets in ', settingsLink('assurance', 'Settings → Service Assurance'), '.'),
          el('p', {}, 'It reports a ', el('strong', {}, 'possible'), ' login flow, never a certain one, and only when a password field is actually present. A form asking for a new password looks much the same, which is why the wording is careful.'),

          el('h4', {}, 'Reading a failure'),
          el('p', {}, 'A failed run names the step, says what happened in plain language, and gives the likely cause before any technical detail:'),
          docsCode('Step 4: Click "Log ind"\nThe service was unavailable.\nLikely cause: the service behind this address\nHTTP 503 from /api/auth/login'),
          docsTable(['You see', 'It usually means', 'What to do'], [
            ['A 4xx or 5xx status', 'The server answered and refused. 500 and 502 are the application; 503 is overload, restart or maintenance.', 'The test is fine — the service is not. Check the application itself.'],
            ['Element was not found', 'None of the ways the step knows to find it matched — the page changed, or an earlier step left the wrong page open.', 'Open the test and check the step still points at something that exists.'],
            ['The page raised a script error', 'Front-end JavaScript threw, often leaving the page half-rendered.', 'Look at the console errors under Technical details.'],
            ['That host is not on the allowed list', 'The address is outside what this application may reach.', 'An administrator adds it under the application\u2019s Allowed hosts.'],
            ['Runs stay queued', 'Nothing is executing the queue.', 'A worker is not running — an administrator starts one.'],
          ]),

          el('h4', {}, 'History: how has it been going?'),
          el('p', {}, ['The ', el('strong', {}, 'History'), ' tab charts the runs instead of listing them — how many ran, how many failed, and how long they took. Pick the segmentation (', el('strong', {}, 'Day'), ', ', el('strong', {}, 'Week'), ', ', el('strong', {}, 'Month'), ' or ', el('strong', {}, 'Year'), '), then step through with ◀ ▶ or jump straight to a date. The same chart sits on each test\u2019s own History, scoped to that test.']),
          docsTable(['Segmentation', 'One bar is', 'What it answers'], [
            ['Day', 'an hour', 'which hour of the night it started failing'],
            ['Week', 'a day (Monday first)', 'how the working week went'],
            ['Month', 'a day', 'whether this month is worse than the last'],
            ['Year', 'a month', 'the trend a report quotes'],
          ]),
          el('p', {}, 'A gap in the bars means nothing ran in that bucket — usually a schedule that stopped, or a worker that was down. It is drawn as a gap on purpose, because that is a different fact from "everything passed".'),
          el('p', { class: 'muted' }, 'Days are cut in your own time zone, not the server\u2019s, so "Tuesday" means your Tuesday.'),

          el('h4', {}, 'Recording: let BlueEyes write the test'),
          el('p', {}, 'Instead of building a journey step by step, you can perform it once and let BlueEyes write it down. Open ', viewLink('serviceAssurance', 'Service Assurance'), ' → Tests → ', el('strong', {}, 'Record a journey'), ', drag the recorder button to your bookmarks bar, then open the application, sign in as yourself and click the bookmark. A badge appears and counts what it sees. Perform the journey, stop, and review — you get the same editable step list the designer uses, because a recorded test is an ordinary test.'),
          el('div', { class: 'callout' }, el('strong', {}, 'Your password is never recorded: '), 'a password field is recorded as the fact that it was filled, never as what you typed. The step reads ', el('code', {}, '{{credential.password}}'), ' and the test fills it from the login stored on the application — so the password never crosses the network and is not in the database to leak. A field counts as a password by its type or by what it is called, in any language BlueEyes knows: password, kodeord, adgangskode, PIN.'),
          el('p', {}, 'BlueEyes also tidies as it records: typing "admin" is one step, not five; the click that only moves the cursor into a field disappears; and addresses become paths, so the test runs against whichever environment you point it at.'),
          el('p', {}, 'After a full page change the badge disappears — a bookmark lives in the page it was clicked on. Click it again and the same recording continues; nothing is lost, and the new page becomes the next step. Applications that never reload the whole page need one click for the whole journey.'),
          el('p', { class: 'muted' }, 'If nothing reaches BlueEyes, the application\u2019s Content-Security-Policy is blocking the recorder from sending data back (F12 \u2192 Console names the directive). Record on a staging environment without the header, ask for your BlueEyes address to be added to connect-src, or build the test in the designer. The recording also expires, usually within 30 minutes, so the key in the bookmark is worth nothing afterwards.'),

          el('h4', {}, 'Logins'),
          el('p', {}, 'A password is stored encrypted, never shown again, never written to a log, and masked in the page before any screenshot is taken. A test refers to it as ', el('code', {}, '{{credential.password}}'), ' — the value itself is never part of the test.'),
          el('p', { class: 'muted' }, 'Use a dedicated test account, not a real person\u2019s. A synthetic test signs in every few minutes, around the clock.'),

          docsExpect('A passing test shows PASS with its step count and duration. A failing one shows which step failed, the likely cause and a screenshot. The strip beside each test — PASS PASS FAIL PASS — is its recent history at a glance.'),
        ],
      },
      {
        id: 'assurance-monitors', title: 'Check that mail arrives (and the other silent failures)', body: () => [
          docsLead('Some things break without anybody being told. Mail is accepted by the server and then quietly dropped. Somebody edits DNS and the SPF record loses a sender. The sending address lands on a blacklist. These are discovered when a customer says they never got the invoice — days late. A monitor asks one of those questions on an interval, so you hear it first.'),
          el('p', {}, ['A monitor is not a test: a test drives a browser through a journey, a monitor is one protocol exchange. They live side by side under ', viewLink('serviceAssurance', 'Service Assurance'), ' → ', el('strong', {}, 'Monitors'), ', and a monitor needs no worker — it runs in the server itself.']),

          el('h4', {}, 'What you can measure'),
          docsTable(['Check', 'It measures', 'The failure it catches'], [
            ['Mail delivery', 'seconds from send to arrival', 'mail accepted by the server and never delivered'],
            ['DNS record', 'the record still says what it should', 'SPF/DKIM/DMARC/MX gone or weakened after a DNS edit'],
            ['Blacklist (RBL)', 'how many lists name the address', 'your sending address blocked at every recipient'],
            ['Directory bind (LDAP)', 'time to bind and read', 'nobody can sign in'],
            ['Database connection', 'connect + one SELECT', 'a rotated password, a connection limit, a dead replica'],
            ['Clock offset (NTP)', 'how far the clock is out', 'drift that presents as failed logins and unmatched codes'],
            ['Certificate on a port', 'days remaining', 'the certificate on 465/636/993 nobody has a reminder for'],
            ['TCP port', 'connect time, and the greeting', 'a port that is open without the service being up'],
          ]),

          el('h4', {}, 'Set up the mail check'),
          docsSteps([
            ['Open ', viewLink('serviceAssurance', 'Service Assurance'), ' → ', el('strong', {}, 'Monitors'), ' → ', el('strong', {}, 'New monitor'), ' and pick ', el('strong', {}, 'Mail delivery'), '.'],
            ['Fill in the mail server, the port (', el('code', {}, '587'), ' with STARTTLS is the usual pair), and the account the probe sends as. The password is stored encrypted and never shown again.'],
            ['Set the sender and the recipient. Use a mailbox you own for the recipient — this sends a real message, every interval, forever.'],
            ['Save it and press ', el('strong', {}, 'Check now'), '. You get the answer in seconds, with the time each phase took.'],
          ]),
          el('div', { class: 'callout' }, el('strong', {}, 'Accepted is not delivered: '), 'left alone, the check measures whether the server took the message. Turn on ', el('strong', {}, 'roundtrip'), ' and give it the IMAP mailbox the message goes to, and it measures the whole way: the probe puts a unique token in the message, watches the mailbox until it turns up, and reports the delivery time from the receiving server\u2019s own clock. It deletes the message afterwards. That is the only setting that answers "does our mail actually arrive".'),

          el('div', { class: 'callout' }, el('strong', {}, 'It does not start until it works once: '), 'a new monitor is saved but not yet watching — it says so on its own page. Press Check now; the first check that works puts it on its schedule. That way a typo in the setup cannot page anybody at two in the morning. If the service is down right now and you want it watched anyway, ', el('strong', {}, 'Start watching'), ' schedules it regardless.'),

          el('h4', {}, 'How a monitor is scheduled'),
          el('p', {}, ['It is not scheduled on the ', el('strong', {}, 'Schedules'), ' tab — that tab is for browser tests. A monitor carries its own cadence in one field: ', el('strong', {}, 'Check every (seconds)'), '. Once the first check has worked, the server runs it on that interval, day and night, and it never stops on its own. The Schedules tab lists the monitors read-only so the answer is where the question gets asked.']),
          el('p', {}, ['Two things stop it: ', el('strong', {}, 'Pause'), ' on the monitor\u2019s page, which keeps the history, the settings and the incidents and can be resumed on the same interval — and ', el('strong', {}, 'Delete'), ', which takes the history with it. Setting the interval to 0 is not one of them: the minimum is 60 seconds, or whatever an administrator raised it to under Settings → Service Assurance, and the dialog shows the number it will accept.']),

          el('h4', {}, 'Is it getting worse?'),
          el('p', {}, ['Each monitor has a ', el('strong', {}, 'History'), ' chart: how available it was per hour, day or month, and what it measured inside that period. Step through with ◀ ▶ or jump to a date, the same way the run history works.']),
          el('p', {}, '100% available with a delivery time that tripled over a week is the reading worth having, and no single number can show it. A gap in the bars means nothing was checked in that period — drawn as a gap on purpose, because that is a different fact from "everything failed".'),

          el('h4', {}, 'Where did it break?'),
          el('p', {}, ['Click any check in the list to open its trace. You get the exchange as a waterfall — which leg cost the time, in the order it happened — the conversation with the mail server line by line, and, for a round trip, the route the message took, read off its own ', el('code', {}, 'Received'), ' headers: which relay handed it to which, and what each leg cost. The newest failing check opens itself, because that is the one you came to look at.']),
          el('p', {}, ['Every check type opens the same way, with whatever it recorded. A DNS check shows the records it actually got back next to the ones it expects. A blacklist check shows every list it asked, what each answered and how long each took — including the one that timed out, which a summary saying "not listed on 2 of 3" quietly counts as clean. A database check shows its connect and query split. The conversation and the delivery path are mail\u2019s own; the rest is shared.']),
          el('p', {}, ['Above the list, the same phases are charted across the recent checks. That is how "it got slower" becomes "the ', el('strong', {}, 'data'), ' phase got slower and nothing else did". Each step gets its own panel, scaled to its own range — six steps on one axis is a 13 ms greeting and a 5 second delivery fighting for the same scale, and neither is readable. The panels share a left-to-right timeline, so two steps rising and falling together line up. ', el('strong', {}, 'Logarithmic'), ' and ', el('strong', {}, 'Linear'), ' put them back on one axis when the absolute numbers are the point; click a step in the legend to take it out of the way.']),
          el('p', {}, ['Underneath, the steps that ', el('strong', {}, 'move together'), ' are named outright, because spotting that by eye is what people get wrong in both directions. A delivery time that tracks the data phase exactly is one fault showing up twice, not two problems — so look for what they share. It is a rank correlation over the checks where both steps were measured, which is why one 30-second outlier cannot invent a pattern, and a step that never varied is reported as having no answer rather than as moving with everything.']),
          el('div', { class: 'callout' }, el('strong', {}, 'Passwords are never in the trace: '), 'the AUTH exchange is recorded as having happened, with the answer it got. The credential itself is replaced with ', el('code', {}, '***'), ' before anything is stored — base64 is not encryption, and a transcript that kept it would put a plaintext password in the database and on this screen.'),

          el('h4', {}, 'Reading the answer'),
          docsTable(['Status', 'What it means', 'Whose problem'], [
            ['OK', 'the question was answered and the answer was good', '—'],
            ['SLOW', 'it worked, and took longer than your limit', 'load somewhere on the path'],
            ['FAILED', 'the check ran and the answer was bad', 'the monitored service'],
            ['UNREACHABLE', 'nothing answered, so there is nothing to judge', 'the host, the network or a firewall'],
            ['MISCONFIGURED', 'the monitor itself cannot run', 'ours — a credential, a mailbox, a missing driver'],
          ]),
          el('p', {}, ['The phase is the diagnosis. "Accepted in 140 ms, delivered after 90 s" is a backed-up queue; "authenticated after 4 s" is a different fault entirely, and the row shows both. A refused login on the probe\u2019s own account is reported as ', el('strong', {}, 'misconfigured'), ' and never pages anybody: it says nothing about whether real mail is flowing.']),
          el('p', {}, 'One bad check is not an outage — a failure has to repeat before an incident opens. A certificate expiring, a record that is gone or an address that is listed opens one straight away: those do not become more true by being checked twice.'),

          el('h4', {}, 'What it will not let you do'),
          el('p', {}, ['A monitor can never point at ', el('code', {}, '127.0.0.1'), ', a link-local address or a cloud metadata endpoint, whatever you type — use the host\u2019s LAN address instead. A database monitor runs a single ', el('code', {}, 'SELECT'), ' and refuses anything else. An administrator can bound the mail check further under Settings → Service Assurance by listing the domains a probe may send to; leave it empty and any address is allowed.']),

          docsExpect('A working mail round trip reads "Delivered to … in 4.1 s (accepted in 142 ms)" and the monitor shows 100% available over 24 hours. A silently lost message reads "accepted the message (250) but it never reached …" and opens a critical incident, which is the one nothing else in your stack will ever tell you.'),
          el('p', { class: 'muted' }, 'A mail probe sends a real message on a schedule: 15 minutes is a sensible interval, one minute is the floor, and the mailbox cleans itself up as long as round-trip is on.'),
        ],
      },
      {
        id: 'agent-offline', title: 'An agent is offline', body: () => [
          docsLead('An agent shows as disconnected, or dropped off the Overview. Work from the server outward.'),
          docsSteps([
            ['Open ', viewLink('fleet', 'Overview'), ' and find the agent — offline agents sort to the top with a grey/《offline》badge. Click it to open the agent page.'],
            ['On the agent page, read the ', el('strong', {}, 'Connection'), ' card. It gives an explainable verdict (last seen, last WebSocket close reason, clock skew) — this usually names the cause outright.'],
            'Check whether it is one agent or many. Many agents offline at once points at the server/network side (firewall, DNS, this server restarting); a single agent points at that host.',
            ['If the agent is up but stale, use ', el('strong', {}, 'Reconnect'), ' (operator+) on the agent page to force it to re-dial the server.'],
            ['On the host itself: confirm the agent process/service is running, and that it can reach this server’s URL and port. Re-running the installer (', el('code', {}, 'git pull && ./install.sh'), ') repairs a broken systemd install.'],
          ]),
          docsExpect(
            el('span', {}, 'A healthy agent reports within seconds of connecting and its ', el('strong', {}, 'Last seen'), ' stays under a minute. '),
            el('span', {}, 'Common close reasons: ', el('code', {}, 'auth failed'), ' → the agent token was rotated/revoked (re-enroll); ', el('code', {}, 'timeout'), '/', el('code', {}, 'ECONNREFUSED'), ' → network path or the server is down; large ', el('strong', {}, 'clock skew'), ' → fix NTP on the host, it degrades data quality.')),
          el('p', { class: 'muted' }, ['Related: ', viewLink('logs', 'Logs'), ' shows server-side connect/disconnect events, and Reporting → Audit records each agent online/offline transition.']),
        ],
      },
      {
        id: 'site-unhealthy', title: 'A site looks unhealthy', body: () => [
          docsLead('A location is amber/red on the map, or a whole office reports problems.'),
          docsSteps([
            ['Open ', viewLink('map', 'Sites'), '. Locations are coloured by the health of the agents at them — click the site to list its agents.'],
            ['Switch to ', viewLink('fleet', 'Overview'), ' and click the count chips (Critical / Warning) to filter the fleet to just the unhealthy agents — is it every agent at the site (shared uplink/DNS) or one?'],
            ['Use the ', viewLink('investigation', 'Troubleshooting'), ' investigator (operator+): pick ', el('strong', {}, 'Site/location'), ' as the scope and a time window. It correlates the anomalies at that site into one explained picture.'],
            ['Check ', viewLink('geo', 'Destinations'), ' / Topology to see whether the site lost a key dependency (a DNS resolver, a SaaS endpoint, an upstream ASN).'],
          ]),
          docsExpect('A site anomaly that hits every agent simultaneously is almost always shared infrastructure (WAN link, firewall, DNS, power). A single agent standing out while its neighbours are green is a host- or NIC-local problem — jump to “Investigate an interface”.'),
        ],
      },
      {
        id: 'latency-loss', title: 'High latency or packet loss to a destination', body: () => [
          docsLead('Users report a slow or flaky service. Confirm it, localise it, and capture evidence.'),
          docsSteps([
            ['From the affected agent, run an ad-hoc ', viewLink('probes', 'Probe'), ': a ', el('strong', {}, 'ping'), ' to the target for a quick loss/latency read, then a ', el('strong', {}, 'traceroute'), ' to see where it degrades.'],
            'Compare against a known-good target (e.g. a well-known resolver) from the same agent — if that is also bad, the problem is local/first-hop, not the destination.',
            ['Open the traceroute result and use the ', el('strong', {}, 'path view'), ': each hop shows loss/latency/jitter with GeoIP/ASN, so you can point at the exact hop and network where it turns red.'],
            ['For an HTTP service, run an ', el('strong', {}, 'HTTP'), ' or ', el('strong', {}, 'cURL'), ' probe — you get status code, TLS cert expiry and (cURL) a body/header content check, not just reachability.'],
            ['Make it ongoing: save the checks as a ', viewLink('tests', 'Test'), ' package aimed at the relevant agents on a schedule, so you catch it next time and build an availability history.'],
          ]),
          docsExpect(
            el('span', {}, 'Loss/latency that starts at a specific hop and persists downstream localises the fault to that hop’s network (often an ASN boundary). '),
            el('span', {}, 'Loss only at the final hop with clean transit usually means the destination host/service itself. First-hop loss points at the local LAN/NIC — see the interface how-to.')),
        ],
      },
      {
        id: 'interface', title: 'Investigate an interface', body: () => [
          docsLead('Errors, discards, saturation or a flapping link on a monitored interface.'),
          docsSteps([
            ['Open ', viewLink('interfaces', 'Interfaces'), ' (or the Interfaces card on the agent page). Rows are health-rated on utilisation, errors, discards and link state.'],
            'Read the four signals separately: high utilisation = capacity/QoS; rising errors = physical layer (cabling, SFP, duplex mismatch); discards = buffer/queue pressure; link down/flap = physical or driver.',
            ['Cross-check the NIC: the ', viewLink('nics', 'NICs'), ' page flags firmware/driver outliers — a single NIC on old firmware among identical peers is a strong lead.'],
            ['Correlate with time: interface anomalies raise ', viewLink('findings', 'findings'), ' with a normal-range band and event markers, so you can line up the errors against a change or a traffic spike.'],
          ]),
          docsExpect('Errors and discards should sit at ~0 on a healthy link. A steady error rate that scales with traffic is classic duplex/cabling; bursty discards under load are congestion. Link flaps almost always mean a physical or driver fault — check the NIC firmware first.'),
        ],
      },
      {
        id: 'findings', title: 'Reading findings & events', body: () => [
          docsLead('The Analysis and Events pages turn raw metrics into explained problems. Here is how to read them.'),
          el('p', {}, ['A ', viewLink('findings', 'finding'), ' is one detected anomaly on one host/metric. Because detection is robust-statistical (median + MAD z-score), each finding states what was ', el('strong', {}, 'observed'), ', the ', el('strong', {}, 'baseline'), ' it deviated from, the ', el('strong', {}, 'deviation'), ', and an evidence array — so you can judge it, not just trust it. Acknowledge a finding to mute repeats.']),
          el('p', {}, ['An ', viewLink('events', 'event'), ' groups related findings on a device within a correlation window into one case, and auto-correlates a device config change from just before it as the suspected trigger. Open a case for its timeline, a plain-language what/where/why, similar past cases, and a combined recommendation (matching playbook → resolved-case history → optional EU-hosted AI).']),
          docsTable(['On the page', 'Means'], [
            [el('span', {}, el('strong', {}, 'CRIT'), ' / red'), 'A strong, high-confidence deviation — act now.'],
            [el('span', {}, el('strong', {}, 'WARN'), ' / amber'), 'A moderate deviation — worth a look, may be transient.'],
            [el('span', {}, el('strong', {}, 'Config change'), ' link'), 'A device config snapshot captured shortly before the event — the likely cause; open it to see the risk-classified diff.'],
          ]),
          docsExpect('If a finding looks wrong, read its evidence — a legitimate baseline shift (a planned change, a new service) explains most “false” anomalies. Acknowledge it and, if it recurs by design, tune thresholds in Settings → Analysis.'),
        ],
      },
      {
        id: 'situations', title: 'Situations — one event across many agents', body: () => [
          docsLead('When the same fault hits several agents at once, BlueEyes groups their findings into one Situation (a cross-agent cluster) instead of N look-alike alerts — so you chase one root cause, not a wall of duplicates.'),
          el('p', {}, ['Open ', viewLink('clusters', 'Situations'), ' (Insights group). Each row is one cross-agent event with a confidence tier, a suspected common cause and how many findings it groups. It is distinct from an ', viewLink('events', 'event'), ', which groups findings on a ', el('strong', {}, 'single'), ' device.']),
          el('h4', {}, 'How confident is the grouping?'),
          el('p', {}, 'The confidence tier says how independent the signals tying the agents together were — not how severe the fault is:'),
          docsTable(['Tier', 'What tied the agents together'], [
            [el('strong', {}, 'High'), 'Same time window + shared topology (same site, or an LLDP-adjacent link) + the same finding type — very likely one shared cause.'],
            [el('strong', {}, 'Medium'), 'Same time window + shared topology, but mixed finding types.'],
            [el('strong', {}, 'Low'), 'Only close in time (no shared site and/or no common type) — a weak, watch-it correlation.'],
          ]),
          el('p', { class: 'muted' }, 'Topology today means a shared site or an LLDP-adjacent link — it is never guessed: agents with no known relationship do not raise the tier.'),
          el('h4', {}, 'Working a Situation'),
          docsSteps([
            ['Open the Situation for the “one common picture”: the suspected common cause, the per-agent evidence that drove the grouping, and a single ', el('strong', {}, 'timeline'), ' merging findings, agent events, config changes and playbook runs across every affected agent.'],
            ['Check ', el('strong', {}, 'Recommended actions'), ' — a matching playbook, similar resolved Situations, and (opt-in) an EU-hosted AI advisory. Advice is always shown WITH the evidence behind it, never on its own.'],
            'Acknowledge it (operator+) so colleagues know someone owns it; resolve it with a note when fixed. Both are recorded in the audit trail. A Situation also auto-resolves once its findings stop recurring.',
          ]),
          el('div', { class: 'callout' }, el('strong', {}, 'One alert, not N: '), 'a Situation raises a SINGLE cross-agent alert through your configured channels and references the member findings already alerted individually — it never re-sends their alerts. Alerting needs a channel set up in Settings → Alerting; the AI advisory needs the assistant enabled in Settings → AI.'),
          docsExpect('A high-confidence Situation usually means ONE thing to fix (a shared uplink, switch, power event or upstream dependency) rather than many — start from its suspected common cause and the change that landed just before the first finding.'),
        ],
      },
      {
        id: 'dependencies', title: 'Map service dependencies', body: () => [
          docsLead('The service dependency graph shows which monitored hosts depend on which — directed “host → host : port” edges built from observed TCP traffic. It is one half of the unified topology graph.'),
          el('p', {}, ['Open ', viewLink('topology', 'Topology'), ' (Diagnostics group). The graph carries ', el('strong', {}, 'two edge types'), ':']),
          docsTable(['Edge', 'Means'], [
            [el('strong', {}, 'l2_link'), 'A physical LLDP/CDP adjacency between two monitored devices (undirected — “these two are wired together”).'],
            [el('strong', {}, 'service_dep'), 'An observed TCP dependency: the source host talks to the destination host on a service port (directed — “source depends on destination:port”).'],
          ]),
          el('h4', {}, 'How service_dep edges are built'),
          docsSteps([
            'Agents report TCP flow 5-tuples (source/destination IP, destination port, byte/packet counts) plus their own IP addresses.',
            ['A background job (every ~10 min) aggregates the last 24h by ', el('strong', {}, '(source host, destination host, destination port)'), ', resolves each IP to a monitored host, and keeps each host’s heaviest ', el('strong', {}, 'N'), ' edges (default 50).'],
            ['Both ends must be monitored hosts — a known agent (by its reported IPs) or an SNMP-polled device (by its configured host). Edges to anything unknown (the internet, an unmonitored box) are ', el('strong', {}, 'dropped'), ', by design.'],
          ]),
          docsExpect('A newly-enrolled fleet shows edges within an hour or two, once agents have reported flows and their IPs. Purely-internal LAN dependencies appear; traffic to external/unmonitored endpoints does not (that lives under Destinations). No ports on the edges usually means the agents predate the flow-detail reporting — update them.'),
          el('p', { class: 'muted' }, ['Worked example — a host’s top dependencies via the API: ', el('code', {}, 'GET /api/topology/dependencies?host=42'), ' returns that host’s heaviest edges, each with ', el('code', {}, 'dstPort'), ', ', el('code', {}, 'bytes'), ', ', el('code', {}, 'connCount'), ' and first/last-seen.']),
        ],
      },
      {
        id: 'blast-radius', title: 'Blast radius — what a failure takes down', body: () => [
          docsLead('Blast radius answers “if this device/host fails, what else is affected?” — computed from the topology graph, in two tiers, each with the path that justifies it.'),
          docsTable(['Tier', 'What it lists'], [
            [el('strong', {}, 'directly_isolated'), 'Hosts that lose L2 connectivity when the node fails — found by walking l2_link edges out from the failure point.'],
            [el('strong', {}, 'dependency_affected'), 'Hosts that depend (over service_dep) on any isolated/failing host — the knock-on service impact, followed transitively.'],
          ]),
          el('p', {}, ['It is bounded by a configurable ', el('strong', {}, 'depth cap'), ' (default 4 hops) and is cycle-safe, so it always terminates even on looped topologies.']),
          el('h4', {}, 'Where you see it'),
          docsSteps([
            ['On an ', viewLink('events', 'event'), ': the event detail carries a ', el('code', {}, 'blastRadius'), ' section computed for the failing device — the downstream hosts and dependent services it puts at risk. It is best-effort: if topology is unavailable the event still opens.'],
            ['Ad-hoc for any node (operator+): ', el('code', {}, 'GET /api/topology/blast-radius/<agentId>'), ' — optionally ', el('code', {}, '?depth=N'), '.'],
          ]),
          el('h4', {}, 'Worked example'),
          el('p', {}, ['Core switch ', el('strong', {}, 'agent 1'), ' fails. It is L2-adjacent to ', el('strong', {}, '2'), ' and ', el('strong', {}, '3'), '; the app server ', el('strong', {}, '4'), ' depends on ', el('strong', {}, '3'), ' on port 5432:']),
          docsCode('GET /api/topology/blast-radius/1\n\n{\n  "failingNode": 1,\n  "depthCap": 4,\n  "directly_isolated": [\n    { "hostId": 2, "path": [1, 2] },\n    { "hostId": 3, "path": [1, 2, 3] }\n  ],\n  "dependency_affected": [\n    { "hostId": 4, "path": [\n      { "hostId": 3, "viaPort": null },\n      { "hostId": 4, "viaPort": 5432 }\n    ] }\n  ],\n  "totals": { "directly_isolated": 2, "dependency_affected": 1 }\n}'),
          docsExpect('directly_isolated is your connectivity blast radius (who goes dark); dependency_affected is your service blast radius (who breaks even if still reachable). An empty result means the node has no known downstream — either it is a leaf, or the topology graph has not yet learned its links.'),
          el('p', { class: 'muted' }, 'Because l2_link (LLDP) adjacency is symmetric, “downstream” means the failing node’s L2-reachable neighbourhood within the depth cap — the hosts cut off with or behind it.'),
        ],
      },
      {
        id: 'topology-changes', title: 'Track topology changes', body: () => [
          docsLead('BlueEyes detects LLDP/CDP topology changes between poll cycles and records them — so you can see when a neighbour appeared, vanished, moved ports, or flapped, with an immutable audit trail.'),
          el('p', {}, ['Every agent capabilities report is a “poll”. Each report is diffed against the agent’s previous neighbour snapshot; the differences become change records. Four change types:']),
          docsTable(['Change', 'Means'], [
            [el('strong', {}, 'neighbour_added'), 'A neighbour appeared on a local port that had none.'],
            [el('strong', {}, 'neighbour_removed'), 'A previously-seen neighbour is gone.'],
            [el('strong', {}, 'link_state_changed'), 'A neighbour’s link state flipped (e.g. up→down). Requires agents that report link state.'],
            [el('strong', {}, 'port_moved'), 'The same neighbour chassis id is now seen on a different local port.'],
          ]),
          el('h4', {}, 'Flap suppression'),
          el('p', {}, ['A change that reverts within a window (default 300s) does not spam the feed — the pair ', el('strong', {}, 'collapses to a single '), el('code', {}, 'flapping'), el('strong', {}, ' record'), '. So a link bouncing every few seconds shows up once, as flapping, not as hundreds of add/remove events.']),
          el('h4', {}, 'Where changes show up'),
          docsSteps([
            ['On the device page ', el('strong', {}, 'activity timeline'), ': topology changes appear inline with findings, events and agent events, tagged ', el('strong', {}, 'Topology change'), ' — the same feed, one shape.'],
            ['Directly (operator+): ', el('code', {}, 'GET /api/topology/changes?host=<agentId>'), ' returns the change events.'],
            ['As evidence: every change is written to the ', el('strong', {}, 'hash-chained audit log'), ' (category ', el('code', {}, 'topology'), ', actor ', el('code', {}, 'system'), '), so the record is tamper-evident.'],
          ]),
          el('h4', {}, 'Worked example'),
          el('p', {}, 'A switch neighbour on port eth3 moves to eth4, then its link drops:'),
          docsCode('GET /api/topology/changes?host=42\n\n{\n  "host": 42,\n  "events": [\n    { "timestamp": "…:05Z", "source": "topology", "type": "topology.link_state_changed",\n      "severity": "WARN", "summary": "Link up→down for sw-c on eth4", "ref_id": 1802 },\n    { "timestamp": "…:00Z", "source": "topology", "type": "topology.port_moved",\n      "severity": "WARN", "summary": "Neighbour sw-c moved eth3→eth4", "ref_id": 1801 }\n  ]\n}'),
          docsExpect('Identical polls emit nothing — the feed only shows real changes. A neighbour that removes and re-adds within 5 minutes shows once as flapping (chase a cabling/optic fault). Link-state changes only appear once your agents report link state; add/remove/move work from the neighbour set alone.'),
        ],
      },
      {
        id: 'flow-baselines', title: 'Flow-pair traffic baselines', body: () => [
          docsLead('Beyond per-metric anomalies (CPU, latency…), BlueEyes baselines the traffic volume of each host→host:port flow pair and flags deviations — a database link that suddenly moves 50× its usual bytes, for instance.'),
          el('p', {}, ['Baselines are ', el('strong', {}, 'day-of-week and hour-of-day aware'), ': a Tuesday 14:00 volume is compared against prior Tuesdays 14:00, not a flat average — so normal business-hours peaks don’t read as anomalies.']),
          docsTable(['Aspect', 'Behaviour'], [
            ['Statistics', 'The same robust median + MAD z-score used everywhere else — explainable, no ML.'],
            ['Window', 'Rolling 14 days of hourly buckets (configurable). History builds forward from when the feature is enabled — it can’t be backfilled.'],
            ['Eligibility', 'A pair needs ≥100 hourly observations before it’s scored — new/sparse pairs are left alone until there’s enough history.'],
            ['Output', 'A deviation becomes an ordinary finding (metric flow.volume) that flows into the correlator and Situations like any other — no separate alert channel.'],
          ]),
          docsExpect('A steady flow pair produces no findings. A genuine step-change in volume for a specific weekday/hour scores WARN/CRIT and appears in Analysis/Events attributed to the source host, with the destination and port in its evidence. This is deviation only — BlueEyes never labels traffic “malicious”, it just tells you it changed.'),
          el('p', { class: 'muted' }, ['Operator+ can inspect a host’s learned baselines at ', el('code', {}, 'GET /api/topology/flow-baselines?host=<id>'), '.']),
        ],
      },
      {
        id: 'adhoc', title: 'Run an ad-hoc probe or test', body: () => [
          docsLead('The fastest way to answer “can this host reach X right now?”.'),
          docsSteps([
            ['Open ', viewLink('probes', 'Probes & Tests'), ', keep the ', el('strong', {}, 'Run'), ' sub-tab, choose the agent to run from and the probe type.'],
            ['Pick the type for the question: ', el('strong', {}, 'ping'), ' (reachability/loss/latency), ', el('strong', {}, 'tcp'), ' (is a port open), ', el('strong', {}, 'dns'), ' (resolution + timing), ', el('strong', {}, 'traceroute'), ' (path + per-hop loss), ', el('strong', {}, 'http/curl'), ' (status, TLS, content) or ', el('strong', {}, 'pageload'), ' (waterfall).'],
            'Read the result inline — it carries a pass/fail verdict with the numbers behind it. Traceroute results open into the path visualisation.',
            ['To repeat it automatically across many agents on a schedule, promote it to a ', viewLink('tests', 'Test'), ' package (the same probe engine, plus fleet targeting and recurrence).'],
          ]),
          el('div', { class: 'callout' }, el('strong', {}, 'Probe vs. Test: '), 'a probe is a one-off you run by hand from a single agent (troubleshooting); a Test is a saved, scheduled package of probes aimed at many agents (monitoring). Same engine underneath.'),
        ],
      },
    ],
  },
  {
    section: 'Administration & setup', admin: true, articles: [
      {
        id: 'assurance-worker', title: 'Starting the Service Assurance worker', body: () => [
          docsLead('Service Assurance queues its work; a separate worker process runs the browser that carries it out. Without a worker, tests and discoveries sit at "queued" and the Runs page says so. This is how you start one.'),
          el('div', { class: 'callout' }, el('strong', {}, 'Why separate: '), 'a test holds a real browser for seconds to minutes. Running that inside the API server would make the dashboard stutter for everyone, so the worker is its own process — and its own container image, which is why this server carries no browser and did not grow when Service Assurance shipped.'),

          el('h4', {}, 'In the Docker stack'),
          el('p', {}, 'The worker is behind a compose profile, so it is only built and started when you ask for it:'),
          docsCode('COMPOSE_PROFILES=service-assurance docker compose up -d --build'),
          el('p', {}, 'That is the whole thing. It picks up the database connection and the encryption key from the same ', el('code', {}, '.env'), ' the server uses, and stores screenshots in a volume both share.'),
          el('p', {}, 'To run several at once — useful when tests start queueing behind each other:'),
          docsCode('COMPOSE_PROFILES=service-assurance docker compose up -d --scale service-assurance-worker=3'),
          el('p', { class: 'muted' }, 'Each worker claims a queued run with a conditional database update, so several never run the same job twice.'),

          el('h4', {}, 'On a deploy'),
          el('p', {}, [el('code', {}, 'scripts/deploy.sh'), ' rebuilds the worker along with the server on any host that already runs one, and keeps the number you scaled to — so a worker never sits on last week\u2019s code while the server updates. The first time, ask for it:']),
          docsCode('BLUEEYE_SERVICE_ASSURANCE=1 ./scripts/deploy.sh    # start one\nBLUEEYE_ASSURANCE_WORKERS=3 ./scripts/deploy.sh   # start three\nBLUEEYE_ASSURANCE_WORKERS=0 ./scripts/deploy.sh   # stop them again'),
          el('p', { class: 'muted' }, 'A deployment that does not use Service Assurance builds nothing extra — the worker image is Debian with Chromium, and it is not part of the default stack.'),

          el('h4', {}, 'Outside Docker'),
          el('p', {}, 'On a host with Node and Chromium installed, from the blueeye-server directory:'),
          docsCode('PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \\\n  SERVICE_TEST_ARTIFACT_ROOT=/var/lib/blueeye/service-assurance \\\n  npm run service-test-worker'),
          el('p', {}, 'It needs ', el('code', {}, 'playwright-core'), ' (', el('code', {}, 'npm install playwright-core'), ') and a Chromium binary. Install Chromium from your distribution — ', el('code', {}, 'apt install chromium'), ' on Debian/Ubuntu — rather than letting Playwright download one; you then get security updates through the normal channel.'),

          el('h4', {}, 'Two things must match the server'),
          docsTable(['What', 'Why it matters', 'What goes wrong'], [
            [el('code', {}, 'SECRET_ENCRYPTION_KEY'), 'The worker decrypts the logins this server encrypted. Both fall back to JWT_SECRET when it is unset.', 'Every test with a login fails with "credential unavailable" — and nothing else points at the cause.'],
            [el('code', {}, 'SERVICE_TEST_ARTIFACT_ROOT'), 'The worker writes failure screenshots there; this server reads them back to show you.', 'Screenshots are captured but the run page says the screenshot is no longer stored.'],
          ]),
          el('p', { class: 'muted' }, 'In the Docker stack both are already wired to the same values — there is nothing to keep in step by hand.'),

          el('h4', {}, 'Where the screenshots actually live'),
          el('p', {}, [el('code', {}, 'SERVICE_TEST_ARTIFACT_ROOT'), ' is a path ', el('strong', {}, 'inside the container'), ', not a path on the Docker host. Both the worker and this server set it to ', el('code', {}, '/var/lib/blueeye/service-assurance'), ' and mount the same named volume there. The shared volume is what makes a screenshot written by the worker readable here — the path string on its own would not.']),
          el('p', {}, ['Setting ', el('code', {}, 'SERVICE_TEST_ARTIFACT_ROOT'), ' in ', el('code', {}, '.env'), ' has no effect on the Docker stack: the compose file sets the container path explicitly, because it has to stay in step with the mount point. To see where the bytes sit on the host:']),
          docsCode('docker volume inspect blueeye_service-assurance-artifacts'),
          el('p', { class: 'muted' }, 'Running the worker outside Docker is the case where you do set it — and there it IS a host path, which must be a directory the worker can write and this server can read.'),

          el('h4', {}, 'Checking it works'),
          docsSteps([
            ['Open ', settingsLink('assurance', 'Settings → Service Assurance'), '. Every running worker is listed under ', el('strong', {}, 'Workers'), ' with its host, version and last heartbeat — a worker appears there within seconds of starting, before it has run anything.'],
            ['Run any test. It should move from queued to running within a few seconds.'],
            ['If it stays queued, check the worker log: ', el('code', {}, 'docker compose logs -f service-assurance-worker'), '. A worker that started cleanly logs "polling for work".'],
          ]),
          docsExpect('A healthy worker claims a queued run within its poll interval (five seconds by default, adjustable in ', settingsLink('assurance', 'Settings → Service Assurance'), '). A run left running longer than the claim timeout is given back automatically, so a worker that dies mid-test never leaves a test stuck.'),
        ],
      },
      {
        id: 'discovery', title: 'Active device discovery', body: () => [
          docsLead('Passive collection (LLDP, sFlow, agents) only sees devices that announce themselves. Active discovery probes an IP range you configure to find the rest — printers, switches, appliances — and lists them as candidates for you to promote.'),
          el('div', { class: 'callout' }, el('strong', {}, 'Safe by design: '), 'discovery only ever probes the CIDR ranges you configure — never outside them, never auto-expanding. It refuses to start if no scope is set or the scope exceeds the address cap (default 65,536). Nothing is auto-enrolled: candidates become monitored devices only when you promote them.'),
          el('h4', {}, 'Configure the scope'),
          docsSteps([
            ['Open ', el('strong', {}, 'Administration → Discovery'), ' and set the CIDR ranges, port list, rate and address cap in the Scan scope form. Scope changes take effect on the next sweep — no restart.'],
            ['Turning the SCHEDULED sweep on is an operator decision made where the server runs (', el('code', {}, 'DISCOVERY_ENABLED=true'), '); scope + manual sweeps are managed in the UI. The env vars (', el('code', {}, 'DISCOVERY_CIDRS'), ', ', el('code', {}, 'DISCOVERY_PORTS'), ', ', el('code', {}, 'DISCOVERY_RATE_LIMIT'), ', ', el('code', {}, 'DISCOVERY_ADDRESS_CAP'), ') still provide the defaults.'],
            ['Discovery uses native probes only — TCP connect + reverse DNS (and ICMP where the host OS permits a raw socket). It never shells out to nmap or ping.'],
            ['A sweep runs on a schedule, or on demand from the Discovery page (', el('code', {}, 'POST /api/discovery/scan'), ', admin). Every sweep is written to the hash-chained audit log with its scope, start, end and result count — shown under Sweep history.'],
          ]),
          el('h4', {}, 'Promote a candidate'),
          docsSteps([
            ['Review candidates on the Discovery page (', el('code', {}, 'GET /api/discovery/candidates'), ') — each shows its IP, reverse-DNS hostname, open ports and status.'],
            ['Promote one to create a monitored SNMP device (an agents row with an SNMP monitor config aimed at that IP), or Dismiss it to hide it from future sweeps.'],
          ]),
          docsExpect('A sweep of a /24 finds the live hosts within it and lists them as “discovered”. They do NOT appear on the fleet or count toward monitoring until promoted. All of this is admin-only — operator and viewer accounts get 403 on every discovery endpoint.'),
        ],
      },
      {
        id: 'servicenow', title: 'Connect ServiceNow (ITSM)', body: () => [
          docsLead('Push BlueEyes events/anomalies into ServiceNow as Event records. Configured under Settings → Integrations as a “servicenow” connector. This is the outbound ITSM link; for asset lookup see “Connect a CMDB”.'),
          el('h4', {}, 'What you need first (in ServiceNow)'),
          el('ul', {},
            el('li', {}, el('strong', {}, 'Instance URL '), '— e.g. ', el('code', {}, 'https://acme.service-now.com'), ' (HTTPS, no trailing path).'),
            el('li', {}, el('strong', {}, 'A service account '), 'with REST Table API access to the target table. For the default ', el('code', {}, 'event'), ' table it needs to create/read/update events — typically the ', el('code', {}, 'itil'), ' role (plus ', el('code', {}, 'web_service_admin'), ' / SOAP access if your instance restricts the REST API).'),
            el('li', {}, el('strong', {}, 'Credentials '), '— Basic auth (username + password) or OAuth2 (a bearer token). Store them in the connector; they are encrypted at rest (AES-256-GCM) and write-only — never shown back.'),
            el('li', {}, el('strong', {}, 'Table '), '(optional) — defaults to ', el('code', {}, 'event'), '. Override only to a valid table name (', el('code', {}, '[a-z0-9_]'), ', ≤64 chars).')),
          el('h4', {}, 'Set it up'),
          docsSteps([
            [settingsLink('integrations', 'Open Settings → Integrations'), ' and add a connector of type ', el('strong', {}, 'ServiceNow'), '.'],
            ['Fill in the ', el('strong', {}, 'Base URL'), ', pick the ', el('strong', {}, 'auth type'), ' (basic/oauth2) and enter the credentials. Optionally set the table and which events fire it (', el('code', {}, 'event'), ', ', el('code', {}, 'anomaly'), ').'],
            ['Save, then click ', el('strong', {}, 'Test'), '. The test does a bounded read of the table (', el('code', {}, 'GET /api/now/table/<table>?sysparm_limit=1'), ') — it proves URL + auth + table access without creating anything.'],
            ['Verify end-to-end from ', settingsLink('screening', 'Settings → Test Settings'), ', which screens every outbound integration for connectivity and security posture in one place.'],
          ]),
          el('h4', {}, 'How a fire behaves'),
          el('p', {}, ['When a qualifying event fires, the connector is ', el('strong', {}, 'idempotent by '), el('code', {}, 'correlation_id'), ': it first looks up an existing record with that id and ', el('strong', {}, 'PATCHes'), ' it if found, otherwise ', el('strong', {}, 'POSTs'), ' a new one — so a recurring condition updates one ticket instead of spawning duplicates. Severity maps to impact/urgency: CRIT→1/1, WARN→2/2, else 3/3. Every ticket is tagged ', el('code', {}, 'u_source = BlueEye'), ' so your ServiceNow admins can filter them.']),
          docsExpect(
            el('div', {}, el('strong', {}, 'Success — '), 'the Test returns ', el('code', {}, 'reached ServiceNow (200)'), '. A real fire returns e.g. ', el('code', {}, 'create event INC0012345 (201)'), ' or ', el('code', {}, 'update event INC0012345 (200)'), ', and the per-fire result is recorded in the integration audit.')),
          el('h4', {}, 'When it fails — reading the error'),
          docsTable(['Status / detail', 'Likely cause', 'Fix'], [
            [el('code', {}, '401'), 'Bad username/password or an expired OAuth2 token.', 'Re-enter the credentials; for OAuth2 refresh the token.'],
            [el('code', {}, '403'), 'Authenticated but the account lacks rights on that table (ACL/role).', ['Grant ', el('code', {}, 'itil'), ' / REST access, or point at a table the account can use.']],
            [el('code', {}, '400'), 'Invalid table name or a field the instance rejects.', 'Check the table exists and is spelled correctly.'],
            [el('span', {}, el('code', {}, 'ENOTFOUND'), ' / ', el('code', {}, 'ETIMEDOUT'), ' / TLS error'), 'DNS, firewall/proxy, or a TLS trust problem reaching the instance.', 'Confirm the URL and that this server can egress to it over HTTPS; check any proxy/CA.'],
            [el('span', {}, el('code', {}, 'lookup failed: …')), 'The idempotency read before a write failed (auth/network) — BlueEyes will not blind-create.', 'Resolve the underlying auth/network error above; the write retries next fire.'],
          ]),
          el('p', { class: 'muted' }, 'No secrets are ever returned by the API or shown on the Test Settings page.'),
        ],
      },
      {
        id: 'cmdb', title: 'Connect a CMDB (single source of truth)', body: () => [
          docsLead('Link agents to their asset in a CMDB so BlueEyes can enrich them and keep each agent’s site in sync. One CMDB source at a time: ServiceNow, Nautobot, or a config-driven custom HTTP/JSON source. Configured under Settings → CMDB.'),
          el('p', {}, ['This is separate from the outbound ITSM integration above — a CMDB connector is ', el('strong', {}, 'read-only'), ' (test + asset search), not a ticket writer. For ServiceNow the asset table defaults to ', el('code', {}, 'cmdb_ci'), '; a service account scoped only to the CMDB (but not to events) is enough, because the test reads the CI table, not ', el('code', {}, 'event'), '.']),
          docsSteps([
            [settingsLink('cmdb', 'Open Settings → CMDB'), ' and choose the source type (ServiceNow / Nautobot / custom).'],
            'Enter the base URL + credentials (encrypted at rest, never returned). For custom, provide the request/JSON mapping the page describes.',
            ['Click ', el('strong', {}, 'Test connection'), ' — a bounded read of the asset table (', el('code', {}, 'sysparm_limit=1'), ' for ServiceNow).'],
            ['On an agent page, open the ', el('strong', {}, 'CMDB asset'), ' card and pick the matching asset from the dropdown — type an ', el('strong', {}, 'asset ID'), ', an ', el('strong', {}, 'asset name'), ' or a ', el('strong', {}, 'location'), ' and it searches all three. Linking ', el('strong', {}, 'syncs the agent’s location'), ': BlueEyes matches a site by the asset’s CMDB location name (creating one if absent).'],
          ]),
          docsExpect('A working connection returns ', [el('code', {}, 'reached ServiceNow (200)')], ' (or the equivalent) and asset search returns rows. 401/403/network errors read exactly as in the ServiceNow ITSM table above. The CMDB is also a target in ', [settingsLink('screening', 'Test Settings')], '.'),
        ],
      },
      {
        id: 'alerting', title: 'Configure alerting', body: () => [
          docsLead('Deliver findings/events to email, a webhook, or syslog. Configured under Settings → Alerting; changes apply live to the running dispatcher.'),
          el('ul', {},
            el('li', {}, el('strong', {}, 'Email (SMTP) '), '— host, port, TLS, from-address and (optional) credentials. Use a EU/self-hosted relay in keeping with the no-US-vendor rule.'),
            el('li', {}, el('strong', {}, 'Webhook '), '— a receiver URL; sign it with a shared secret so the receiver can verify authenticity. An unsigned webhook is flagged as a warning in Test Settings.'),
            el('li', {}, el('strong', {}, 'Syslog '), '— host/port/protocol; prefer TLS over plaintext.')),
          docsSteps([
            [settingsLink('alerting', 'Open Settings → Alerting'), ', enable the channel(s) and fill in the fields. Secrets are write-only.'],
            ['Use the per-channel ', el('strong', {}, 'Test'), ' to send a real test message, or screen all channels at once from ', settingsLink('screening', 'Test Settings'), '.'],
            ['Optionally set ', settingsLink('maintenance', 'Maintenance windows'), ' to silence alerts during planned work.'],
          ]),
          docsExpect('A successful email/webhook/syslog test delivers an actual message to the destination — check the inbox/receiver/collector to confirm. A failure reports the transport error (SMTP auth, connection refused, TLS). Test Settings additionally flags insecure posture (plaintext, unsigned, no auth) even when delivery “works”.'),
        ],
      },
      {
        id: 'sso', title: 'Set up SSO & LDAP', body: () => [
          docsLead('Let staff sign in with your directory/IdP and get a BlueEyes role from their group/claim. Three options, each licence-gated (Professional): LDAP/AD, OIDC and SAML.'),
          docsTable(['Method', 'Configured in', 'Connection from', 'Maps role by'], [
            ['LDAP/AD', settingsLink('auth', 'Settings → Authentication'), ['env ', el('code', {}, 'LDAP_AUTH_ENABLED'), ' + bind config'], 'directory group → role'],
            ['SSO (OIDC)', settingsLink('auth', 'Settings → Authentication'), ['env ', el('code', {}, 'OIDC_*'), ' (issuer/client)'], 'token claim → role'],
            ['SSO (SAML)', settingsLink('auth', 'Settings → Authentication'), ['env ', el('code', {}, 'SAML_*'), ' (IdP/SP)'], 'assertion attribute → role'],
          ]),
          el('p', {}, ['The connection itself (bind host, issuer, IdP metadata) comes from server ', el('strong', {}, 'environment variables'), ' — set those on the server. The dashboard tab is where you map groups/claims/attributes to BlueEyes roles and read the login audit. Local accounts always remain as a fallback, so you can never lock yourself out.']),
          docsExpect('Each method has a built-in test: an LDAP bind check, OIDC discovery, and a SAML reachability probe (all also surfaced in Test Settings). A successful test + a correct role map means a directory user lands on the right role on first login (just-in-time provisioning). Failures name the step: bind failed (credentials/DN), discovery failed (issuer/URL), signature/audience mismatch (SAML metadata).'),
        ],
      },
      {
        id: 'enroll-key', title: 'Agent enrollment & the signing key', body: () => [
          docsLead('How new agents join, and the key that underpins secure agent management.'),
          el('p', {}, ['New agents enroll with a one-time (or bulk/multi-use) code from ', viewLink('enrollment', 'Enrollment'), ' (operator+). The one-liner installer verifies the agent source and installs natively (Node + systemd) by default. Each enrolled agent links back to the code it used, so the Enrollment page shows each code’s agents and their live status.']),
          el('p', {}, ['Secure agent management rests on the ', settingsLink('agentkey', 'agent signing key'), ' (Settings → Agent key, admin). It is generated on the server and ', el('strong', {}, 'never shown again'), ' — only whether it exists (+ a non-secret fingerprint). It is the trust anchor for signed agent releases and one-click updates.']),
          docsExpect('With a signing key present you can add agents and push signed upgrades. Delete it and you cannot add new agents or upgrade existing ones from the server until you generate a new one — so treat deletion as deliberate.'),
        ],
      },
      {
        id: 'retention', title: 'Data retention & storage', body: () => [
          docsLead('Control how long raw measurements are kept and how they roll up, plus where data is stored.'),
          el('p', {}, ['BlueEyes down-samples over time (raw → rollups) and purges on a nightly schedule. Tune windows in ', settingsLink('retention', 'Settings → Retention'), '. Config snapshots have their own retention (default 180 days).']),
          el('p', {}, ['Storage is MySQL, optionally with TimescaleDB for time-series. Status and live sizes are shown in ', settingsLink('database', 'Settings → Database'), ' (read-only — the backends are boot-time infra configured via env + install scripts).']),
          docsExpect('Shorter retention lowers storage but shortens history for baselines and reports; the Database page shows current MySQL/TimescaleDB sizes and an ingest estimate so you can size the trade-off before changing it.'),
        ],
      },
    ],
  },
];

views.docs = async () => {
  const root = el('div');
  // Drop the admin-only section for non-admins (RBAC: admin has full access).
  const sections = DOCS.filter((s) => !s.admin || isAdmin());
  const allIds = sections.flatMap((s) => s.articles.map((a) => a.id));
  if (!docsTopic || !allIds.includes(docsTopic)) docsTopic = allIds[0];

  // Left rail: grouped topic list (mirrors the Settings nav).
  const nav = el('div', { class: 'settings-nav docs-nav' }, ...sections.map((s) =>
    el('div', { class: 'settings-nav-group' },
      el('span', { class: 'settings-nav-label' }, s.section),
      el('div', { class: 'navlist docs-navlist' }, ...s.articles.map((a) =>
        el('button', { class: `small ghost${a.id === docsTopic ? ' active' : ''}`, onclick: () => { docsTopic = a.id; render(); } }, a.title))))));

  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Documentation'),
    el('span', { class: 'muted' }, 'Guides, how-tos & setup — with worked examples')), nav);

  const article = sections.flatMap((s) => s.articles).find((a) => a.id === docsTopic);
  const body = el('article', { class: 'docs-article' });
  if (article) {
    body.append(el('h3', { class: 'docs-title' }, article.title));
    try { body.append(...article.body()); }
    catch (err) { body.append(el('div', { class: 'empty error' }, err.message)); }
  }
  root.append(body);
  return root;
};

// ---- Settings (SHELL MIGRATED — see public/views/settings.js)
// The twenty-two section bodies stay here; the page they sit on is the
// contract's.
let settingsPage = null;
const SETTINGS_SECTIONS = {
  users: () => views.users(),
  license: () => views.license(),
  appearance: settingsAppearanceView,
  database: settingsDatabaseView,
  map: settingsMapView,
  types: settingsTypesView,
  analyse: settingsAnalyseView,
  alerting: settingsAlertingView,
  severity: settingsSeverityRulesView,
  runbooks: settingsRunbooksView,
  integrations: settingsIntegrationsView,
  cmdb: settingsCmdbView,
  ai: settingsAiView,
  maintenance: settingsMaintenanceView,
  updates: settingsUpdatesView,
  agentkey: settingsAgentKeyView,
  agents: settingsAgentsView,
  snmp: settingsSnmpDevicesView,
  retention: settingsRetentionView,
  auth: settingsAuthView,
  apitokens: settingsApiTokensView,
  screening: () => views.screening(),
  assurance: settingsAssuranceView,
};

function settingsGroups() {
  // Drop admin-only sections for non-admins, then drop any group left empty.
  return SETTINGS_GROUPS
    .map(([label, tabs]) => [label, tabs.filter(([, , adminOnly]) => isAdmin() || !adminOnly)])
    .filter(([, tabs]) => tabs.length > 0);
}
function settingsLabel(key) {
  for (const [, tabs] of SETTINGS_GROUPS) {
    for (const [k, label] of tabs) if (k === key) return label;
  }
  return key;
}

function getSettingsPage() {
  if (settingsPage) return settingsPage;
  if (typeof window === 'undefined' || !window.SettingsPage || !ui) return null;
  settingsPage = window.SettingsPage.create({
    el, t, ui, errText,
    groups: settingsGroups,
    label: settingsLabel,
    tab: () => settingsTab,
    setTab: (k) => { settingsTab = k; syncLocation(); },
    licence: settingsLicence,
    help: () => ({ title: t('set.info.title'), body: () => [
      el('p', {}, t('set.info.p1')),
      el('p', {}, t('set.info.p2')),
      el('p', { class: 'muted' }, t('set.info.p3')),
    ] }),
    render: (key) => (SETTINGS_SECTIONS[key] || settingsAnalyseView)(),
  });
  return settingsPage;
}

views.settings = async () => {
  const v = getSettingsPage();
  if (!v) return el('div', { class: 'empty error' }, t('set.title'));
  // The licence pill on each section reads the cached feature + plan maps.
  await Promise.all([loadFeatures(), loadPlan()]);
  // A section holds its own open form, so the page is rebuilt per entry.
  settingsPage = null;
  return v.view();
};

// A small "Licence: <feature> yes/no" badge so each feature tab shows whether the
// licence covers it. Green when included, red when not.
function licenseBadge(license, feature) {
  const ok = license && license[feature] === true;
  return el('span', { class: `badge ${ok ? 'active' : 'bad'}` }, `Licence: ${feature} ${ok ? 'yes' : 'no'}`);
}

// Which licence feature (if any) governs each Settings tab. A tab not listed
// here is baseline — always included in every licence, never gateable — and
// shows a green "included" pill. Gated tabs show green when the active licence
// entitles them and red when it doesn't (via featureEntitled, which ORs the
// legacy module map with the packaged-plan feature map). Keys mirror
// SETTINGS_GROUPS.
const SETTINGS_FEATURE = {
  users: { feature: 'rbac', label: 'Role-based access' },
  apitokens: { feature: 'api_access', label: 'API access' },
  analyse: { feature: 'analysis', label: 'Analysis' },
  alerting: { feature: 'alerting', label: 'Alerting' },
  ai: { feature: 'assistant', label: 'AI assistant' },
  map: { feature: 'geo', label: 'Destinations / geo' },
  assurance: { feature: 'service_tests', label: 'Service Assurance' },
};

// Settings → Service Assurance. These are SYSTEM-WIDE limits — discovery
// budgets, the allowed-hosts caps, runner timeouts, screenshot retention — so
// they belong here with the rest of the global configuration rather than inside
// the feature's own screens. What is per-application (base URL, environments,
// logins, allowed hosts) stays on the application page.
//
// The panel is built by the module and handed the shared helpers, the same seam
// views.serviceAssurance uses, so nothing about it leaks into app.js.
async function settingsAssuranceView() {
  if (!window.ServiceAssurance || typeof window.ServiceAssurance.settingsPanel !== 'function') {
    return el('div', { class: 'empty' }, 'Service Assurance kunne ikke indlæses.');
  }
  return window.ServiceAssurance.settingsPanel({ el, api, t, toast, isAdmin });
}

// The green/red licence pill shown at the top of every Settings section.
// What the licence says about one Settings section. A section not in
// SETTINGS_FEATURE is baseline — always included, never gateable. The view
// renders this as a contract Badge on the section's own panel head, so the
// answer sits with the thing it is about.
function settingsLicence(tabKey) {
  const info = SETTINGS_FEATURE[tabKey];
  if (!info) return { ok: true, text: t('set.lic.included'), title: t('set.lic.baseline') };
  const ok = featureEntitled(info.feature);
  return {
    ok,
    text: ok ? t('set.lic.on', { label: info.label }) : t('set.lic.off', { label: info.label }),
    title: ok ? t('set.lic.onHint', { label: info.label }) : lockedHint(info.label, info.feature),
  };
}

// Settings → Agent key: generate / show / delete the agent-release SIGNING key.
// Generated on the server; the private key is never shown or downloadable — the page
// only reports that a key exists (+ a non-secret fingerprint). It's the trust anchor
// for secure agent management: without it no agents can be added and none can be
// upgraded from the server. Admin-only.
async function settingsAgentKeyView() {
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'The agent signing key is generated here, on the server, and underlies secure agent communication. '
    + 'For security it is created once and never shown again — only whether it exists. You can delete it, but then no new agents can be added and existing agents can no longer be upgraded from the server until a new key is generated.'));

  let status;
  try {
    status = await api('/api/settings/agent-release-key');
  } catch (err) {
    root.append(el('div', { class: 'empty error' }, errText(err)));
    return root;
  }

  if (status.configured) {
    root.append(el('div', { class: 'section-head' }, el('h3', {}, 'Agent signing key'), el('span', { class: 'badge active' }, 'Created ✓')));
    root.append(el('p', {}, 'A signing key is set and underlies secure agent management.'));
    const bits = [el('li', {}, el('strong', {}, 'Source: '), status.source === 'managed' ? 'generated on this server' : 'server environment')];
    if (status.createdAt) bits.push(el('li', {}, el('strong', {}, 'Created: '), fmtDate(status.createdAt)));
    if (status.fingerprint) bits.push(el('li', {}, el('strong', {}, 'Fingerprint: '), el('code', {}, `${String(status.fingerprint).slice(0, 32)}…`)));
    bits.push(el('li', {}, el('strong', {}, 'Can sign releases: '), status.canSign ? 'yes' : `no (${status.signBlocked === 'undecryptable' ? 'key unreadable' : 'verify-only'})`));
    root.append(el('ul', {}, ...bits));
    // A key that exists but cannot sign is the state that quietly breaks every
    // one-click update: the dashboard said "Created ✓", the updates went out
    // unsigned, and every pinned agent refused them. Say it here, where an admin
    // comes to check the key.
    if (!status.canSign) {
      const box = el('div', { class: 'callout' });
      box.append(el('p', {}, el('strong', {}, '⚠ This key cannot sign agent releases.')));
      box.append(el('p', { class: 'muted' }, status.keyError
        || 'Only the public half is available here, so the server can verify releases but not produce one. One-click updates go out unsigned, and an agent that pinned a release key refuses them.'));
      box.append(el('p', { class: 'muted' },
        'Fix: delete this key, generate a new one, then re-pin the agents to it (Updates panel → “Re-pin agents”, or the button on an agent that refused its update). Re-pinning is sent to each agent over its own connection — nothing to do on the host — and keeps the agent, its token and its identity.'));
      root.append(box);
    }
    if (status.source === 'managed') {
      root.append(el('div', { class: 'form-actions' }, el('button', { class: 'danger', onclick: () => removeKey() }, 'Delete signing key')));
    } else {
      root.append(el('p', { class: 'muted' }, 'This key comes from the server environment (', el('code', {}, 'AGENT_RELEASE_PUBLIC_KEY'), ') — the public half only, so this server can verify releases but never sign one.'));
      // Without this button a verify-only deployment had no way out from the
      // dashboard at all: "configured" hid the Generate button, and the env key
      // can never sign. A managed key can be generated alongside it and takes
      // precedence — the agents then have to be re-pinned to it.
      root.append(el('div', { class: 'form-actions' },
        el('button', { onclick: () => genKey() }, 'Generate a managed signing key')));
      root.append(el('p', { class: 'muted small' },
        'Generating stores a key pair on this server and uses it in place of the environment key. Agents pinned to the environment key must be re-pinned afterwards (Updates panel → “Re-pin agents”), or they will refuse the releases it signs.'));
    }
  } else {
    root.append(el('div', { class: 'section-head' }, el('h3', {}, 'Agent signing key'), el('span', { class: 'badge offline' }, 'Not set')));
    root.append(el('div', { class: 'empty error' }, 'No signing key is set — you cannot add agents until you generate it.'));
    root.append(el('p', { class: 'muted' }, 'Generating creates the key on the server. It cannot be viewed or changed afterwards — only deleted.'));
    root.append(el('div', { class: 'form-actions' }, el('button', { onclick: () => genKey() }, 'Generate signing key')));
  }

  async function genKey() {
    try {
      await api('/api/settings/agent-release-key', { method: 'POST' });
      toast('Signing key generated — you can now add agents.');
      render();
    } catch (err) { toast(errText(err), true); }
  }

  async function removeKey() {
    if (!confirm('Delete the agent signing key?\n\nThis CANNOT be undone. Afterwards you will NOT be able to add new agents, and existing agents can no longer be upgraded from the server, until you generate a new key. (Agents already enrolled keep running.)')) return;
    try {
      await api('/api/settings/agent-release-key', { method: 'DELETE' });
      toast('Signing key deleted — agent management is disabled until a new key is generated.');
      render();
    } catch (err) { toast(errText(err), true); }
  }

  return root;
}

// Settings → Appearance: pick a dashboard colour theme. The choice is saved to
// the signed-in user's account (so it follows them across browsers) and cached
// locally for instant apply. Available to every role — it's a personal setting.
function settingsAppearanceView() {
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'Choose a colour theme. Each comes in light and dark — the 🌙/☀️ button in the top bar switches brightness while keeping your palette. Your choice is saved to your account, so it follows you to any browser you sign in from.'));

  const grid = el('div', { class: 'theme-grid' });
  const currentTheme = () => document.documentElement.dataset.theme || 'light';
  const swatchStrip = (variant) => el('span', { class: 'theme-swatch' }, ...variant.swatch.map((c) => el('span', { style: `background:${c}` })));

  function paint() {
    grid.replaceChildren(...PALETTES.map((p) => {
      const selected = p.key === paletteOf(currentTheme());
      return el('button', {
        class: `theme-card${selected ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': selected ? 'true' : 'false',
        onclick: async () => {
          // Keep the current brightness; the topbar toggle is what changes it.
          const target = themeMeta(currentTheme()).family === 'light' ? p.light.key : p.dark.key;
          try { await setTheme(target); toast(`Theme: ${p.label}`); }
          catch (e) { toast(errText(e) || 'Could not save theme', true); }
          paint();
        },
      },
        el('span', { class: 'theme-duo' }, swatchStrip(p.light), swatchStrip(p.dark)),
        el('span', { class: 'theme-meta' },
          el('span', { class: 'theme-name' }, p.label),
          el('span', { class: 'theme-fam muted' }, 'Light + dark')),
      );
    }));
  }
  paint();
  root.append(grid);

  // Language picker. The catalogue in public/i18n.js only covers the newer
  // screens, so the help text says so rather than promising a fully localised
  // dashboard. Saved to the account alongside the theme.
  if (window.I18n) {
    const langRow = el('div', { class: 'lang-picker' });
    const select = el('select', {
      id: 'locale-select',
      onchange: async (e) => {
        const next = e.target.value;
        try { await setLocale(next); }
        catch (err) { toast(errText(err) || 'Could not save language', true); }
        render();
      },
    }, ...window.I18n.LOCALES.map((code) => el('option', {
      value: code,
      ...(code === window.I18n.getLocale() ? { selected: 'selected' } : {}),
    }, window.I18n.LOCALE_LABELS[code] || code)));

    langRow.append(
      el('h3', {}, t('settings.language')),
      el('label', { for: 'locale-select', class: 'sr-only' }, t('settings.language')),
      select,
      el('p', { class: 'muted small' }, t('settings.languageHelp')));
    root.append(langRow);
  }
  return root;
}

// "Available from the vendor": the newest server/agent versions, as reported by
// the license server INSIDE the signed licence proof this server already fetches
// every few hours. No extra outbound connection, and nothing on the path can
// fake an update (it would break the signature). Absent = the license server
// doesn't publish versions; the section then just says so.
function upstreamUpdateSection(ver) {
  const up = ver.upstream || { known: false };
  const box = el('div', { class: 'settings-block' });
  box.append(el('h4', {}, 'Available from the vendor'));

  if (!up.known) {
    box.append(el('p', { class: 'muted' },
      'The license server has not reported any published versions. Newly published versions arrive with the next licence validation (Settings → License → "Re-validate now" fetches one immediately).'));
    return box;
  }

  const serverLatest = up.server && up.server.version ? up.server.version : null;
  const agentLatest = up.agent && up.agent.version ? up.agent.version : null;
  box.append(el('div', { class: 'cards' },
    stat('Newest server', serverLatest ? `v${serverLatest}` : '–'),
    stat('Newest agent', agentLatest ? `v${agentLatest}` : '–'),
    stat('Reported', up.checkedAt ? fmtDate(up.checkedAt) : '–')));

  if (!up.serverUpdateAvailable && !up.agentUpdateAvailable) {
    box.append(el('p', { class: 'muted' }, 'This server and the agent source it serves are on the newest published versions.'));
    return box;
  }

  if (up.serverUpdateAvailable) {
    const callout = el('div', { class: 'callout' });
    callout.append(el('p', {}, el('strong', {},
      `Server update ready to deploy: v${ver.server} → v${serverLatest}${up.server.releasedAt ? ` (released ${up.server.releasedAt})` : ''}.`)));
    callout.append(...serverUpdateActions(ver, serverLatest));
    box.append(callout);
  }

  if (up.agentUpdateAvailable) {
    box.append(el('p', {},
      `A newer agent has been published: v${agentLatest} (this server serves v${ver.agentSource || ver.agent || '–'}). `,
      'Update the agent source on the server host, then "Reload agent source" below — after that the agents listed here can be updated.'));
  }
  return box;
}

// What an admin can actually DO about a published server update. The button only
// exists when the installer configured an update command (SERVER_UPDATE_COMMAND)
// — otherwise this shows the manual route, because the server must never invent
// a command to run on someone's host.
function serverUpdateActions(ver, targetVersion) {
  const update = ver.update || { configured: false };
  const out = [];

  if (update.lastRun) {
    const r = update.lastRun;
    const cls = r.outcome === 'success' ? 'active' : (r.outcome === 'failed' ? 'invalid' : 'warn');
    out.push(el('p', { class: 'muted' },
      'Last update run: ', el('span', { class: `badge ${cls}` }, r.outcome),
      ` started ${fmtDate(r.startedAt)}${r.targetVersion ? ` (target v${r.targetVersion})` : ''}`,
      r.requestedBy ? ` by ${r.requestedBy}` : '',
      r.note ? el('span', { class: 'muted' }, ` — ${r.note}`) : ''));
  }

  if (!update.configured) {
    out.push(el('p', { class: 'muted' },
      'To deploy, run the update script on the server host (in the blueeye-server checkout):'));
    out.push(el('pre', {}, el('code', {}, './scripts/deploy.sh')));
    out.push(el('p', { class: 'muted' },
      'To be able to start that from here instead, set ', el('code', {}, 'SERVER_UPDATE_COMMAND'),
      ' to the script\'s absolute path on the host and restart the server. It is the only command this button can ever run.'));
    return out;
  }

  out.push(el('p', { class: 'muted' }, 'Runs on the server host: ', el('code', {}, update.command),
    '. The server restarts as part of the update, so the dashboard reconnects when it comes back.'));

  if (!canDelete()) {
    out.push(el('p', { class: 'muted' }, 'Only an admin can start an update.'));
    return out;
  }

  const logBox = el('pre', { class: 'log-tail hidden' });
  const btn = el('button', { class: 'small' }, update.running ? 'Update running…' : `Run update to v${targetVersion}`);
  btn.disabled = !!update.running;
  btn.addEventListener('click', async () => {
    if (!window.confirm(`Run the update script on this server host now?\n\n${update.command}\n\nThe server restarts during the update and the dashboard briefly goes offline.`)) return;
    btn.disabled = true; btn.textContent = 'Starting…';
    try {
      await api('/system/server-update', { method: 'POST' });
      toast('Update started — following the log.');
      logBox.classList.remove('hidden');
      pollServerUpdate(logBox, btn);
    } catch (err) {
      btn.disabled = false; btn.textContent = `Run update to v${targetVersion}`;
      toast(err.message, true);
    }
  });
  out.push(el('div', { class: 'row-actions' }, btn));
  out.push(logBox);
  if (update.running) pollServerUpdate(logBox, btn);
  return out;
}

// Follows a running update: tails the log until the run ends — or until the
// server stops answering, which is the NORMAL outcome (the update restarts it).
// Keep saying so rather than showing an error the operator can't act on.
function pollServerUpdate(logBox, btn) {
  logBox.classList.remove('hidden');
  let misses = 0;
  const tick = async () => {
    try {
      const s = await api('/system/server-update');
      misses = 0;
      logBox.textContent = s.log || '(no output yet)';
      logBox.scrollTop = logBox.scrollHeight;
      if (s.running) return setTimeout(tick, 3000);
      const outcome = s.lastRun ? s.lastRun.outcome : 'unknown';
      btn.disabled = false;
      btn.textContent = 'Run update';
      toast(outcome === 'success' ? 'Update finished.' : `Update ${outcome} — see the log.`, outcome === 'failed');
      return undefined;
    } catch {
      // Expected while the server restarts itself mid-update.
      misses += 1;
      logBox.textContent = `${logBox.textContent}\n[dashboard] server not answering (restarting?) — retrying…`;
      if (misses < 40) return setTimeout(tick, 5000);
      btn.disabled = false;
      btn.textContent = 'Run update';
      toast('Lost contact with the server during the update — reload the page to check its version.', true);
      return undefined;
    }
  };
  setTimeout(tick, 1500);
}

// Settings -> Updates: the server's version and the agent version it serves, plus
// which enrolled agents are behind. Admins can push a one-click update to
// systemd-managed agents from here. The only external input is what the license
// server signed into the licence proof this server already fetches — this page
// itself never calls out.
async function settingsUpdatesView() {
  const [ver, agents] = await Promise.all([api('/system/version'), api('/agents')]);
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'Version of this server and the agent it ships, plus which enrolled agents are out of date. Newly published versions arrive inside the signed licence proof — no extra outbound connection.'));

  root.append(upstreamUpdateSection(ver));

  const offered = ver.agent || null;
  const source = ver.agentSource || offered;
  const versions = { offered, source };
  // The "one-click" (release) and "installer" (source) targets can diverge in
  // EITHER direction, and the two cases need opposite advice — so the copy is
  // chosen from the comparison instead of asserting one of them. The old text
  // always read "a signed release is newer than the packaged source", which on
  // a host whose agent checkout had moved ahead printed a sentence with the two
  // numbers the wrong way round and no hint of what was actually wrong.
  const drift = offered && source ? compareVersions(offered, source) : 0;
  root.append(el('div', { class: 'cards' },
    stat('Server', ver.server ? `v${ver.server}` : '–'),
    stat('Agent (one-click)', offered ? `v${offered}` : '–'),
    drift !== 0 ? stat('Agent (installer)', `v${source}`) : null));
  if (drift > 0) {
    root.append(el('p', { class: 'muted' },
      `A signed release (v${offered}) is newer than the packaged source (v${source}). Systemd agents one-click-update to v${offered}; Docker/Windows/unmanaged agents re-run their installer and reach v${source}. To lift the installer target, pull the new agent source on the server host and "Reload agent source" below.`));
  } else if (drift < 0) {
    root.append(el('p', { class: 'warn-note' },
      `The agent source on this host (v${source}) is newer than the newest SIGNED release (v${offered}) — the signed bundle was never re-signed after the source moved. One-click Update pushes v${source} and falls back to an unsigned bundle when this server has no release signing key, which an agent pinned to a key will refuse. Fix it with "Reload agent source" below (it re-signs), or generate a signing key under Settings → License.`));
  }

  // Re-read the agent source from disk so a freshly-pulled version is served
  // without restarting the server. admin only.
  if (canDelete()) {
    root.append(el('div', { class: 'row-actions' },
      el('button', {
        class: 'small',
        title: 'Re-read the agent source from disk so a freshly-pulled version is served — no server restart needed',
        onclick: async () => {
          try {
            const r = await api('/system/agent-source/reload', { method: 'POST' });
            // A reload that packaged the new source but could NOT re-sign it is
            // a half-success: one-click Update still pushes the old signed
            // release (or an unsigned bundle a pinned agent refuses). Say so
            // rather than reporting a plain "reloaded".
            const note = r && r.releaseNote;
            const head = r && r.version ? `Agent source reloaded — now serving v${r.version}.` : 'Agent source reloaded.';
            if (note) toast(`${head} ${note}`, true);
            else toast(r && r.releaseVersion ? `${head} Signed release v${r.releaseVersion} published.` : head);
            render();
          } catch (err) { toast(err.message, true); }
        },
      }, 'Reload agent source')));
    root.append(el('p', { class: 'muted' }, 'After pulling a new agent version on the server host, reload to publish it without restarting the server.'));
  }

  const withVer = agents.filter((a) => a.capabilities && a.capabilities.agentVersion);
  // Judge each agent against the version IT can reach: systemd agents vs the
  // one-click (release) target, installer-based agents vs the source target.
  const behind = withVer.filter((a) => agentIsBehind(a, agentUpdateTarget(a, versions)));
  // Split "behind" by whether one click here can actually fix it: only systemd
  // agents self-update — Docker/unmanaged/Windows update from their host
  // installer, so counting them under a plain "click Update" is misleading.
  const installerOnly = behind.filter((a) => !agentSelfUpdatable(a));

  // Signed-release gate: a one-click Update is only ACCEPTED by an agent that
  // pinned a release key when the server has a SIGNED release to push. With none
  // published the command goes out unsigned and those agents refuse it (the exact
  // "accepted 202, then Self-update failed: refusing unsigned update" case). This
  // failure is otherwise invisible on the server, so surface it — and offer the
  // one-click fix (sign the current source) when the server holds a signing key.
  const signedRelease = ver.agentReleaseVersion || null;
  const canSign = !!ver.canSignReleases;
  const selfUpdatableBehind = behind.filter((a) => agentSelfUpdatable(a));
  if (!signedRelease && selfUpdatableBehind.length) {
    const box = el('div', { class: 'callout' });
    if (canSign && ver.releaseStoreReady === false) {
      // Can sign, but there's nowhere to STORE the release (no AGENT_RELEASE_DIR).
      // Publishing would fail, so show the config fix instead of a doomed button.
      box.append(el('p', {}, el('strong', {}, '⚠ One-click updates are blocked: no release storage is configured.')));
      box.append(el('p', { class: 'muted' },
        `${selfUpdatableBehind.length} systemd agent(s) are behind. This server can sign releases, but it has no ` , el('code', {}, 'AGENT_RELEASE_DIR'), ' set, so a signed release can\'t be saved — publishing fails and updates go out unsigned (which key-pinning agents refuse).'));
      box.append(el('p', { class: 'muted' },
        'Set ', el('code', {}, 'AGENT_RELEASE_DIR'), ' to a writable path on the server host and restart. On startup the server then auto-publishes a signed release, and one-click updates work.'));
    } else if (canSign) {
      // Not blocked — the Update button mints a signed release from source on
      // demand and pushes THAT. Explain, and offer the explicit publish too.
      box.append(el('p', {}, el('strong', {}, 'No signed release is published yet.')));
      box.append(el('p', { class: 'muted' },
        'Clicking Update on a systemd agent now signs the current source with this server\'s agent key, publishes it as a release, and pushes that — so a key-pinning agent accepts it. You can also publish it up front:'));
      if (canDelete()) {
        const label = `Publish signed release (v${source})`;
        const btn = el('button', { class: 'small' }, label);
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = 'Publishing…';
          try {
            const r = await api('/system/agent-release/publish', { method: 'POST' });
            toast(`Signed release v${r.version} published — one-click updates are enabled.`);
            render();
          } catch (err) { btn.disabled = false; btn.textContent = label; toast(err.message, true); }
        });
        box.append(el('div', { class: 'row-actions' }, btn));
      }
    } else {
      // Genuinely blocked: the update goes out unsigned and key-pinning agents
      // refuse it, and this server has no key that can sign a release.
      box.append(el('p', {}, el('strong', {}, '⚠ One-click updates are blocked: no signed release, and this server can\'t sign one.')));
      box.append(el('p', { class: 'muted' },
        `${selfUpdatableBehind.length} systemd agent(s) are behind, but the server pushes an UNSIGNED update. An agent that pinned a release key accepts the command, then fails with "refusing unsigned update", so its version never advances.`));
      box.append(el('p', { class: 'muted' },
        ver.agentKeyConfigured
          ? ['The server\'s signing key is verify-only (no private key here), so it can\'t publish a signed release — a managed signing key is required. Generate one under ', settingsLink('agentkey', 'Settings → Agent key'), '.']
          : ['Generate a signing key under ', settingsLink('agentkey', 'Settings → Agent key'), ' to enable signed releases and one-click updates.']));
      // Generating a key is only half of it: an agent that pinned the OLD key
      // refuses releases signed with the new one just as firmly as it refuses an
      // unsigned push. Re-pinning is the other half, and it does not mean
      // re-installing — so say so, and hand over the command.
      box.append(el('p', { class: 'muted' },
        'Agents pinned a release key when they were installed. After generating a key here, re-pin them to it — the new key is sent to each agent over its own connection, so there is nothing to run on the hosts, and each agent keeps its token and its identity:'));
      const repinBtn = el('button', { class: 'small' }, `Re-pin agents (${selfUpdatableBehind.length})`);
      repinBtn.addEventListener('click', () => bulkRepinAgents(selfUpdatableBehind));
      box.append(el('div', { class: 'row-actions' }, repinBtn));
    }
    root.append(box);
  }

  root.append(el('div', { class: 'cards' },
    stat('Reporting a version', `${withVer.length} / ${agents.length}`),
    stat('Up to date', offered ? String(withVer.length - behind.length) : '–'),
    stat('Behind', offered ? String(behind.length) : '–')));

  if (behind.length) {
    root.append(el('h4', {}, 'Agents needing an update'));
    if (installerOnly.length) {
      root.append(el('p', { class: 'muted' },
        `${installerOnly.length} of these can't self-update from here (Docker/unmanaged/Windows) — update those by re-running the installer on the host.`));
    }
    const cols = canDelete() ? ['Agent', 'Installed', 'Target', 'Update via', ''] : ['Agent', 'Installed', 'Target', 'Update via'];
    root.append(el('table', {},
      el('thead', {}, el('tr', {}, ...cols.map((h) => el('th', {}, h)))),
      el('tbody', {}, ...behind.map((a) => {
        const selfUpdatable = agentSelfUpdatable(a);
        const target = agentUpdateTarget(a, versions);
        return el('tr', {},
          el('td', {}, a.display_name || a.hostname),
          el('td', {}, el('span', { class: 'badge warn' }, `v${a.capabilities.agentVersion}`)),
          el('td', {}, el('span', { class: 'badge active' }, `v${target}`)),
          el('td', {}, selfUpdatable
            ? el('span', { class: 'muted', title: 'systemd — one-click Update rebuilds from the server source and restarts' }, 'one-click')
            : el('span', { class: 'muted', title: agentUpdateHint(a) }, 'host installer')),
          canDelete() ? el('td', {}, selfUpdatable
            ? el('div', { class: 'row-actions' }, el('button', { class: 'small', onclick: () => updateAgent(a, target) }, 'Update'))
            : el('span', { class: 'muted', title: agentUpdateHint(a) }, '—')) : null,
        );
      }))));
  } else if (offered && withVer.length) {
    root.append(el('p', { class: 'muted' }, 'All reporting agents are on the version their update path can reach.'));
  }

  root.append(el('h4', {}, 'How to update'));
  root.append(el('ul', {},
    el('li', {}, el('strong', {}, 'Server: '), 'on the server host run ', el('code', {}, './scripts/deploy.sh'), ' (git pull + rebuild).'),
    el('li', {}, el('strong', {}, 'Agents (systemd): '), 'click ', el('strong', {}, 'Update'), ' above (or on the Agents tab) — the server tells the agent to rebuild from the published source and restart.'),
    el('li', {}, el('strong', {}, 'Agents (Docker): '), 're-run the install one-liner from ', el('strong', {}, 'Enrollment'), ' on that host (a container rebuilds on the host, not from here).'),
    el('li', {}, el('strong', {}, 'Agents (Windows / unmanaged): '), 're-run the installer on the host — these aren\'t service-managed the way systemd agents are, so the server can\'t rebuild-and-restart them remotely. Their row shows an ', el('strong', {}, 'installer'), ' badge instead of a one-click Update.')));
  return root;
}

async function settingsAnalyseView() {
  const data = await api('/api/settings');
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'The server learns a normal baseline for each metric and raises a finding when a measurement deviates enough from it. Here you set how sensitive detection is — changes take effect immediately, without restart. The opt-in AI assistant is configured on its own ', settingsLink('ai', 'Settings → AI'), ' tab.'));
  root.append(el('div', { class: 'settings-grid' }, analyseSettingsCard(data.analysis), throughputSettingsCard(data.throughput)));
  return root;
}

// Settings → AI: the opt-in LLM assistant (enable flag, provider, key, model,
// custom endpoint). Split out of Analysis into its own tab. Configurable only when
// the licence includes it (the PUT is refused server-side otherwise); an unknown
// licence (null) keeps the card, per the "allow until we know it's off" rule.
async function settingsAiView() {
  const data = await api('/api/settings');
  const root = el('div');
  const assistantLicensed = !data.license || data.license.assistant !== false;
  root.append(el('p', { class: 'muted settings-intro' }, 'The opt-in AI assistant answers natural-language questions using only the latest findings (metadata summaries — never raw data or payload). Pick any OpenAI-compatible provider — an EU-hosted, US or self-hosted endpoint — or point it at your own via the “Other” option. Which LLM you use is your choice; the region of each preset is shown so you can weigh data residency.'));
  root.append(el('div', { class: 'settings-grid' },
    assistantLicensed ? assistantSettingsCard(data.assistant) : assistantUnlicensedCard(data.license)));
  return root;
}

// Speed-test health thresholds: flag agents on the Overview when their latest
// download/upload falls below a floor (0 = that floor is off). Folded into the
// agent's health verdict like loss/latency. Admin, runtime-editable.
// Settings → Agents: agent-management toggles. Currently the opt-in for the
// server to auto-install a missing diagnostic tool when a probe reports it.
// ---- Settings → SNMP devices -----------------------------------------------
//
// The switches the server polls, and through which agent. This is what broke
// the old 1:1 binding: one agent covers a wiring closet instead of one switch.
//
// Two things the table says that a list of hosts would not:
//
//   * WHAT EACH DEVICE ACTUALLY ANSWERED. A switch that cannot serve the
//     forwarding table shows "fdb not supported" rather than an empty column —
//     the same rule the connection test follows with `available:false`. A
//     device that CANNOT answer must never look like one that answered "none".
//   * WHEN IT LAST ANSWERED, not just that it is failing. "Last answered 41
//     minutes ago" is the difference between a switch that blipped and one that
//     is gone.
const SNMP_COLLECT_KINDS = ['if', 'fdb', 'lldp', 'vlan'];

async function settingsSnmpDevicesView() {
  const host = el('div', { class: 'settings-grid' });

  async function refresh() {
    let data;
    let agents = [];
    try {
      [data, agents] = await Promise.all([
        api('/api/snmp-devices'),
        api('/agents').catch(() => []),
      ]);
    } catch (e) {
      host.replaceChildren(el('div', { class: 'error' }, errText(e)));
      return;
    }
    host.replaceChildren(addCard(agents), listCard(data.devices || []));
  }

  function agentOptions(agents) {
    return [['', t('snmpdev.agent.none')]].concat(
      agents.map((a) => [String(a.id), a.display_name || a.hostname || `#${a.id}`]),
    );
  }

  // Hand-built rather than settingsFormCard: that helper PUTs a settings object
  // and only knows checkbox/select/number fields. This creates a RESOURCE, and
  // needs a text field and a write-only credential.
  function addCard(agents) {
    const hostIn = el('input', { type: 'text', id: 'snmpdev-host', placeholder: '10.14.0.11', maxlength: '255' });
    const agentSel = el('select', { id: 'snmpdev-agent' },
      ...agentOptions(agents).map(([v, l]) => el('option', { value: v }, l)));
    // A community string is a password on the wire — the protocol's fault, and
    // not something we make worse by echoing it into a plain text field.
    const communityIn = el('input', { type: 'password', id: 'snmpdev-community', maxlength: '128', autocomplete: 'new-password' });
    const versionSel = el('select', { id: 'snmpdev-version' },
      el('option', { value: '2c' }, 'v2c'), el('option', { value: '1' }, 'v1'));
    const intervalIn = el('input', { type: 'number', id: 'snmpdev-interval', value: '300', min: '60', max: '86400' });
    const err = el('p', { class: 'error' });
    const btn = el('button', { class: 'btn btn-primary' }, t('snmpdev.add.submit'));

    btn.addEventListener('click', async () => {
      err.textContent = '';
      btn.disabled = true;
      try {
        await api('/api/snmp-devices', {
          method: 'POST',
          body: {
            host: hostIn.value.trim(),
            agentId: agentSel.value ? Number(agentSel.value) : null,
            community: communityIn.value || null,
            version: versionSel.value,
            intervalSec: Number(intervalIn.value) || 300,
          },
        });
        hostIn.value = '';
        communityIn.value = '';
        await refresh();
      } catch (e) {
        err.textContent = errText(e);
      } finally {
        btn.disabled = false;
      }
    });

    const field = (label, control, hint) => el('label', { class: 'set-field' },
      el('span', {}, label), control, hint ? el('span', { class: 'muted small' }, hint) : null);

    return el('section', { class: 'card' },
      el('h3', {}, t('snmpdev.add.title')),
      el('p', { class: 'muted' }, t('snmpdev.add.lead')),
      field(t('snmpdev.field.host'), hostIn, t('snmpdev.field.host.hint')),
      field(t('snmpdev.field.agent'), agentSel, t('snmpdev.field.agent.hint')),
      field(t('snmpdev.field.community'), communityIn, t('snmpdev.field.community.hint')),
      field(t('snmpdev.field.version'), versionSel, t('snmpdev.field.version.hint')),
      field(t('snmpdev.field.interval'), intervalIn, t('snmpdev.field.interval.hint')),
      err, el('div', { class: 'actions' }, btn));
  }

  function supportedCell(d) {
    // `supported` is NULL until the device has actually answered once. Null and
    // [] mean different things and are shown differently: "not polled yet" vs
    // "answered, and cannot do any of this".
    if (d.supported == null) return el('span', { class: 'muted' }, t('snmpdev.supported.unknown'));
    const parts = SNMP_COLLECT_KINDS
      .filter((k) => (d.collect || SNMP_COLLECT_KINDS).includes(k))
      .map((k) => (d.supported.includes(k)
        ? el('span', {}, k)
        : el('span', { class: 'muted', title: t('snmpdev.supported.no', { kind: k }) }, `${k} ✕`)));
    if (!parts.length) return el('span', { class: 'muted' }, '—');
    const out = el('span', {});
    parts.forEach((p, i) => { if (i) out.append(' · '); out.append(p); });
    return out;
  }

  function stateCell(d) {
    if (!d.enabled) return el('span', { class: 'badge-ui neutral' }, t('snmpdev.state.disabled'));
    if (d.lastError) {
      return el('span', {},
        el('span', { class: 'badge-ui crit' }, t('snmpdev.state.failing')),
        el('span', { class: 'meta-xs' }, ` ${d.lastError}`),
        // The LAST GOOD time, not just "failing" — the difference between a
        // switch that blipped and one that is gone.
        d.lastOkAt ? el('span', { class: 'meta-xs' }, ` · ${t('snmpdev.state.lastOk', { when: fmtTimeShort(new Date(d.lastOkAt).getTime()) })}`) : null);
    }
    if (!d.lastOkAt) return el('span', { class: 'badge-ui neutral' }, t('snmpdev.state.never'));
    return el('span', {},
      el('span', { class: 'badge-ui ok' }, t('snmpdev.state.ok')),
      el('span', { class: 'meta-xs' }, ` ${fmtTimeShort(new Date(d.lastOkAt).getTime())}`));
  }

  function listCard(devices) {
    const card = el('section', { class: 'card' },
      el('h3', {}, t('snmpdev.list.title')),
      el('p', { class: 'muted' }, t('snmpdev.list.lead')));
    if (!devices.length) {
      card.append(el('div', { class: 'empty' }, t('snmpdev.list.empty')));
      return card;
    }
    const table = el('table', { class: 'dt' },
      el('thead', {}, el('tr', {},
        el('th', {}, t('snmpdev.col.device')),
        el('th', {}, t('snmpdev.col.agent')),
        el('th', {}, t('snmpdev.col.collects')),
        el('th', {}, t('snmpdev.col.state')),
        el('th', {}, ''))),
      el('tbody', {}, devices.map((d) => el('tr', {},
        el('td', {}, el('strong', {}, d.displayName || d.host),
          d.displayName ? el('span', { class: 'meta-xs' }, ` ${d.host}`) : null),
        el('td', {}, d.agentName || el('span', { class: 'muted' }, t('snmpdev.agent.none'))),
        el('td', {}, supportedCell(d)),
        el('td', {}, stateCell(d)),
        el('td', {},
          el('button', {
            class: 'btn btn-secondary btn-xs',
            onclick: async () => {
              try {
                await api(`/api/snmp-devices/${d.id}/poll`, { method: 'POST' });
                toast(t('snmpdev.poll.queued'));
              } catch (e) { toast(errText(e)); }
            },
          }, t('snmpdev.action.poll')),
          isAdmin() ? el('button', {
            class: 'btn btn-ghost btn-xs',
            onclick: async () => {
              if (!confirm(t('snmpdev.delete.confirm', { host: d.host }))) return;
              try {
                await api(`/api/snmp-devices/${d.id}`, { method: 'DELETE' });
                refresh();
              } catch (e) { toast(errText(e)); }
            },
          }, t('snmpdev.action.delete')) : null)))));
    card.append(el('div', { class: 'table-wrap-ui' }, table));
    return card;
  }

  await refresh();
  return host;
}

async function settingsAgentsView() {
  const data = await api('/api/settings');
  return el('div', { class: 'settings-grid' },
    agentDefaultsCard(data.agents),
    agentsSettingsCard(data.agents));
}

// Default traffic source stamped on each agent as it enrolls (Settings → Agents).
// Both cards PUT /api/settings/agents; setAgents merges the disjoint field sets,
// so a save from one card never clobbers the other's value.
function agentDefaultsCard(a) {
  return settingsFormCard({
    title: 'New agent defaults',
    values: a || { defaultTrafficSource: 'proc', defaultSflowHsflowd: false },
    endpoint: '/api/settings/agents',
    fields: [
      { key: 'defaultTrafficSource', label: 'Default traffic source', type: 'select',
        options: [['proc', 'proc — host /proc counters'], ['netflow', 'NetFlow (v5/v9/IPFIX)'], ['sflow', 'sFlow (sampled)']],
        hint: 'Traffic source stamped on each agent when it enrolls. NetFlow/sFlow open a collector and need a device (or the local exporter below) to export to them. You can still change the source per agent under Agents → Edit.' },
      { key: 'defaultSflowHsflowd', label: 'Self-provision local sFlow exporter (hsflowd)', type: 'checkbox',
        hint: 'Only applies when the default source is sFlow. When on, a newly enrolled agent installs and configures a local Host sFlow exporter (hsflowd) so it collects flows without an external exporter. Installs software on the host — leave off if a switch/host already exports sFlow to the agent.' },
    ],
  });
}

function agentsSettingsCard(a) {
  return settingsFormCard({
    title: 'Diagnostic tools',
    values: a || { autoInstallTools: false },
    endpoint: '/api/settings/agents',
    fields: [
      { key: 'autoInstallTools', label: 'Auto-install missing tools', type: 'checkbox', hint: 'When on, a probe that fails because a tool is missing on the host (e.g. "traceroute not installed") makes the server push an install to that agent automatically. The agent only ever installs tools on its own allowlist (traceroute / mtr / tcptraceroute), never an arbitrary package. Off = install manually from the Probes page. Either way the request + outcome is recorded under Reporting → Audit.' },
    ],
  });
}

function throughputSettingsCard(t) {
  return settingsFormCard({
    title: 'Throughput (speed-test) health',
    values: t || { enabled: false },
    endpoint: '/api/settings/throughput',
    fields: [
      { key: 'enabled', label: 'Flag low throughput', type: 'checkbox', hint: 'When on, an agent whose latest speed test is below a floor is flagged on the Overview and folded into its health. Off = Mbps is shown but never flagged.' },
      { key: 'downWarnMbps', label: 'Download WARN below (Mbps)', type: 'number', min: 0, max: 1000000, step: 1, hint: '0 = no download warning floor.' },
      { key: 'downBadMbps', label: 'Download CRITICAL below (Mbps)', type: 'number', min: 0, max: 1000000, step: 1, hint: '0 = no download critical floor.' },
      { key: 'upWarnMbps', label: 'Upload WARN below (Mbps)', type: 'number', min: 0, max: 1000000, step: 1, hint: '0 = no upload warning floor.' },
      { key: 'upBadMbps', label: 'Upload CRITICAL below (Mbps)', type: 'number', min: 0, max: 1000000, step: 1, hint: '0 = no upload critical floor.' },
    ],
  });
}

// ---- Settings → ITSM (outbound API receivers) -----------------------------
// Manage outbound API integrations (ServiceNow, Jira/TOPdesk/GLPI or a custom
// ticket API, generic webhook, Nautobot CMDB/IPAM device sync): push BlueEyes
// events (events/anomalies, agent enroll/delete) to external systems.
// Backend: src/routes/integrations.js (CRUD + /meta + test-fire). Credentials are
// encrypted at rest (secret box) and never returned. Admin-only.
let integrationsEditing = null; // null = list only · 'new' · <id> being edited

async function settingsIntegrationsView() {
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'Push BlueEyes events to your ITSM and asset systems — e.g. open a ServiceNow (or Jira / TOPdesk / GLPI, or your own) event when a CRIT finding fires, or sync agents into Nautobot (CMDB/IPAM). Pick a system to pre-fill its defaults, or “Custom” to inject your own ticket API. Credentials are encrypted at rest and never shown again; changes take effect immediately.'));

  let meta; let list;
  try {
    [meta, list] = await Promise.all([api('/api/integrations/meta'), api('/api/integrations')]);
  } catch (e) {
    root.append(el('div', { class: 'empty error' }, errText(e)));
    return root;
  }

  if (!list.length) root.append(el('div', { class: 'empty' }, 'No integrations configured yet.'));
  else root.append(el('div', { class: 'settings-grid' }, ...list.map((row) => integrationCard(row))));

  if (integrationsEditing === 'new') {
    root.append(integrationEditor(meta, null));
  } else if (integrationsEditing != null) {
    const existing = list.find((r) => r.id === integrationsEditing);
    if (existing) { root.append(integrationEditor(meta, existing)); }
    else { integrationsEditing = null; root.append(integrationAddButton()); }
  } else {
    root.append(integrationAddButton());
  }
  return root;
}

function integrationAddButton() {
  const b = el('button', { class: 'small' }, '+ Add integration');
  b.addEventListener('click', () => { integrationsEditing = 'new'; render(); });
  return el('div', { class: 'form-actions' }, b);
}

function integrationCard(row) {
  const enabledBadge = el('span', { class: `badge ${row.enabled ? 'ok' : ''}` }, row.enabled ? 'Enabled' : 'Disabled');
  const result = el('p', { class: 'muted small' });

  const editBtn = el('button', { class: 'small ghost' }, 'Edit');
  editBtn.addEventListener('click', () => { integrationsEditing = row.id; render(); });

  const testBtn = el('button', { class: 'small ghost' }, 'Test');
  testBtn.addEventListener('click', async () => {
    result.className = 'muted small'; result.textContent = 'Testing…'; testBtn.disabled = true;
    try {
      const res = await api(`/api/integrations/${row.id}/test`, { method: 'POST' });
      const r = res.result || {};
      result.className = `small ${r.ok ? 'ok' : 'error'}`;
      result.textContent = `${r.ok ? '✓' : '✗'} ${r.detail || (r.ok ? 'ok' : 'failed')}${r.status != null ? ` (HTTP ${r.status})` : ''}`;
    } catch (e) { result.className = 'small error'; result.textContent = errText(e); }
    finally { testBtn.disabled = false; }
  });

  const delBtn = el('button', { class: 'small danger ghost' }, 'Delete');
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete integration "${row.name}"?`)) return;
    try {
      await api(`/api/integrations/${row.id}`, { method: 'DELETE' });
      if (integrationsEditing === row.id) integrationsEditing = null;
      toast('Integration deleted'); render();
    } catch (e) { toast(errText(e), true); }
  });

  const events = (row.config_json && row.config_json.events) || [];
  return el('div', { class: 'settings-card' },
    el('h3', {}, row.name, ' ', enabledBadge),
    el('div', { class: 'form-grid' },
      el('div', { class: 'muted small' }, `Type: ${row.type} · Auth: ${row.auth_type}`),
      el('div', { class: 'muted small screen-row-detail' }, row.base_url),
      events.length ? el('div', { class: 'muted small' }, `Events: ${events.join(', ')}`) : null,
      el('div', { class: 'form-actions' }, editBtn, testBtn, delBtn),
      result));
}

// Credential inputs for the chosen auth type (+ the webhook HMAC signing secret).
// Write-only: on edit, a blank field keeps the stored secret; a "Clear" box wipes it.
function integrationCredFields(authType, type, isEdit) {
  const inputs = {};
  const rows = [];
  const keep = isEdit ? ' Leave blank to keep the stored value.' : '';
  const text = (key, label, hint) => { const i = el('input', { type: 'text' }); inputs[key] = i; rows.push(alertField(label, i, hint)); };
  const secret = (key, label, hint) => {
    const i = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: isEdit ? 'unchanged' : '' });
    inputs[key] = i; rows.push(alertField(label, i, (hint || '') + keep));
  };
  if (authType === 'basic') { text('username', 'Username'); secret('password', 'Password'); }
  else if (authType === 'token') secret('token', 'API token', 'Sent in the Authorization header.');
  else if (authType === 'oauth2') secret('accessToken', 'Access token', 'Sent as a Bearer token.');
  if (type === 'webhook') secret('secret', 'Signing secret (HMAC)', 'Optional — signs the POST as X-BlueEye-Signature.');

  let clear = null;
  if (isEdit && rows.length) {
    clear = el('input', { type: 'checkbox' });
    rows.push(el('label', { class: 'inline muted small' }, clear, el('span', {}, 'Clear stored credentials')));
  }
  function gather() {
    if (clear && clear.checked) return { clearCredentials: true };
    const creds = {};
    for (const [k, i] of Object.entries(inputs)) { const v = i.value.trim(); if (v) creds[k] = v; }
    return Object.keys(creds).length ? { credentials: creds } : {};
  }
  return { rows, gather };
}

// Type-specific config_json fields. gather() may throw on bad JSON — the caller
// catches it and shows the message.
function integrationConfigFields(type, config) {
  const c = config || {};
  const rows = [];
  let gather = () => ({});
  if (type === 'servicenow') {
    const tableI = el('input', { type: 'text', value: c.table || 'event', placeholder: 'event' });
    rows.push(alertField('Table', tableI, 'ServiceNow table to create records in (default: event).'));
    gather = () => ({ table: tableI.value.trim() || 'event' });
  } else if (type === 'nautobot') {
    const pathI = el('input', { type: 'text', value: c.devicePath || '/api/dcim/devices', placeholder: '/api/dcim/devices' });
    const delI = el('input', { type: 'checkbox' }); delI.checked = !!c.allowDelete;
    const defI = el('textarea', { rows: '4', spellcheck: 'false', placeholder: '{ "status": {"name": "Active"}, "role": {…} }' },
      c.deviceDefaults ? JSON.stringify(c.deviceDefaults, null, 2) : '');
    rows.push(alertField('Device path', pathI, 'Nautobot device API path.'));
    rows.push(alertField('Allow delete', delI, 'Permit removing the device when an agent is deleted.'));
    rows.push(alertField('Device defaults (JSON)', defI, 'Required fields merged into every device create (device_type, role, location, status).'));
    gather = () => {
      const out = { devicePath: pathI.value.trim() || '/api/dcim/devices', allowDelete: delI.checked };
      const raw = defI.value.trim();
      if (raw) { let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error('Device defaults must be valid JSON.'); } out.deviceDefaults = parsed; }
      return out;
    };
  } else if (type === 'custom') {
    // Config-driven "bring your own ITSM" connector: build any JSON ticket body.
    const pathI = el('input', { type: 'text', value: c.path || '/', placeholder: '/rest/api/2/issue' });
    const methodSel = el('select', {}, ...['POST', 'PUT'].map((m) => el('option', { value: m }, m)));
    methodSel.value = (c.method || 'POST').toUpperCase() === 'PUT' ? 'PUT' : 'POST';
    const schemeI = el('input', { type: 'text', value: c.tokenScheme || '', placeholder: 'Bearer' });
    const testI = el('input', { type: 'text', value: c.testPath || '', placeholder: '/ (defaults to the create path)' });
    const fieldsI = el('textarea', { rows: '4', spellcheck: 'false', placeholder: '{ "short_description": "title", "description": "explanation" }' },
      c.fields ? JSON.stringify(c.fields, null, 2) : '');
    const staticI = el('textarea', { rows: '4', spellcheck: 'false', placeholder: '{ "fields": { "project": { "key": "OPS" } } }' },
      c.staticFields ? JSON.stringify(c.staticFields, null, 2) : '');
    const headersI = el('textarea', { rows: '3', spellcheck: 'false', placeholder: '{ "App-Token": "…" }' },
      c.headers ? JSON.stringify(c.headers, null, 2) : '');
    rows.push(alertField('Create path', pathI, 'Path appended to the base URL for the ticket create call.'));
    rows.push(alertField('Method', methodSel, 'HTTP method for the create call.'));
    rows.push(alertField('Field map (JSON)', fieldsI, 'Maps API fields (dotted keys build nesting, e.g. "fields.summary") to BlueEyes values: title, explanation, summary, severity, metric, host, correlationId, deviation, observed, baseline, impact, urgency.'));
    rows.push(alertField('Static fields (JSON)', staticI, 'Constant fields merged into every request body (e.g. project/queue/issue type).'));
    rows.push(alertField('Extra headers (JSON)', headersI, 'Optional static headers (the Authorization header is set from the auth type).'));
    rows.push(alertField('Token scheme', schemeI, 'Optional Authorization scheme word for token auth (default: Bearer).'));
    rows.push(alertField('Test path', testI, 'Optional path for the connection test (GET; defaults to the create path).'));
    gather = () => {
      const out = { path: pathI.value.trim() || '/', method: methodSel.value };
      if (schemeI.value.trim()) out.tokenScheme = schemeI.value.trim();
      if (testI.value.trim()) out.testPath = testI.value.trim();
      const jsonField = (raw, label) => { const s = raw.trim(); if (!s) return undefined; let p; try { p = JSON.parse(s); } catch { throw new Error(`${label} must be valid JSON.`); } return p; };
      const f = jsonField(fieldsI.value, 'Field map'); if (f !== undefined) out.fields = f;
      const s = jsonField(staticI.value, 'Static fields'); if (s !== undefined) out.staticFields = s;
      const h = jsonField(headersI.value, 'Extra headers'); if (h !== undefined) out.headers = h;
      if (c.preset) out.preset = c.preset;
      return out;
    };
  }
  return { rows, gather };
}

// Event checkboxes (which BlueEyes events the integration reacts to).
function integrationEventFields(allEvents, selected) {
  const chosen = new Set(selected || []);
  const boxes = (allEvents || []).map((ev) => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = chosen.has(ev);
    return { ev, cb };
  });
  const row = el('label', { class: 'set-field' },
    el('span', {}, 'Events'),
    el('div', { class: 'inline-checks' }, ...boxes.map((b) => el('label', { class: 'inline muted small' }, b.cb, el('span', {}, b.ev)))),
    el('span', { class: 'muted small' }, 'Which BlueEyes events this integration reacts to.'));
  return { row, gather: () => boxes.filter((b) => b.cb.checked).map((b) => b.ev) };
}

// The create/edit form. `existing` is null for a new integration, else the safe row.
function integrationEditor(meta, existing) {
  const isEdit = !!existing;
  const types = meta.types || [];
  const connectorFor = (type) => types.find((t) => t.type === type) || { authTypes: ['none'], defaultEvents: [] };

  // Preset-driven "System" dropdown on create (built-ins + Jira/TOPdesk/GLPI custom
  // templates). Falls back to bare types if the server sent no presets.
  const presets = (Array.isArray(meta.presets) && meta.presets.length)
    ? meta.presets
    : types.map((t) => ({ id: t.type, label: t.type, type: t.type, authType: (t.authTypes || ['none'])[0], config: t.custom ? { preset: 'custom' } : {}, baseUrlPlaceholder: '' }));
  const presetById = (id) => presets.find((p) => p.id === id) || presets[0];
  const presetSel = el('select', {}, ...presets.map((p) => el('option', { value: p.id }, p.label)));
  presetSel.value = presets[0].id;
  const currentType = () => (isEdit ? existing.type : presetById(presetSel.value).type);

  const nameI = el('input', { type: 'text', value: isEdit ? existing.name : '', placeholder: 'ServiceNow (prod)' });
  const urlI = el('input', { type: 'text', value: isEdit ? existing.base_url : '', placeholder: 'https://example.service-now.com' });
  const enabledI = el('input', { type: 'checkbox' }); enabledI.checked = isEdit ? !!existing.enabled : true;

  const authWrap = el('div', { class: 'form-grid' });
  const credWrap = el('div', { class: 'form-grid' });
  const cfgWrap = el('div', { class: 'form-grid' });
  const evWrap = el('div', { class: 'form-grid' });
  const hintWrap = el('div', {});
  const err = el('p', { class: 'error' });

  let authSel; let credGather; let cfgGather; let evGather;

  function rebuildCreds() {
    const c = integrationCredFields(authSel.value, currentType(), isEdit);
    credGather = c.gather;
    credWrap.replaceChildren(...c.rows);
  }
  function rebuild() {
    const preset = isEdit ? null : presetById(presetSel.value);
    const type = currentType();
    const conn = connectorFor(type);
    authSel = el('select', {}, ...conn.authTypes.map((a) => el('option', { value: a }, a)));
    authSel.value = isEdit && conn.authTypes.includes(existing.auth_type) ? existing.auth_type
      : (preset && conn.authTypes.includes(preset.authType) ? preset.authType : conn.authTypes[0]);
    authSel.addEventListener('change', rebuildCreds);
    authWrap.replaceChildren(alertField('Auth type', authSel, 'How BlueEyes authenticates to the target API.'));
    rebuildCreds();
    if (!isEdit) urlI.placeholder = (preset && preset.baseUrlPlaceholder) || 'https://example.service-now.com';
    hintWrap.replaceChildren(...(preset && preset.docsHint ? [el('p', { class: 'muted small cmdb-preset-hint' }, preset.docsHint)] : []));
    const cfg = integrationConfigFields(type, isEdit ? existing.config_json : (preset && preset.config));
    cfgGather = cfg.gather;
    cfgWrap.replaceChildren(...cfg.rows);
    const ev = integrationEventFields(meta.events || [], (isEdit && existing.config_json && existing.config_json.events) || conn.defaultEvents || []);
    evGather = ev.gather;
    evWrap.replaceChildren(ev.row);
  }
  presetSel.addEventListener('change', rebuild);
  rebuild();

  const saveBtn = el('button', { class: 'small' }, isEdit ? 'Save changes' : 'Create integration');
  const cancelBtn = el('button', { class: 'small ghost' }, 'Cancel');
  cancelBtn.addEventListener('click', () => { integrationsEditing = null; render(); });
  saveBtn.addEventListener('click', async () => {
    err.textContent = ''; saveBtn.disabled = true;
    try {
      const body = {
        name: nameI.value.trim(),
        baseUrl: urlI.value.trim(),
        authType: authSel.value,
        enabled: enabledI.checked,
        config: { ...cfgGather(), events: evGather() },
        ...credGather(),
      };
      if (isEdit) await api(`/api/integrations/${existing.id}`, { method: 'PUT', body });
      else { body.type = currentType(); await api('/api/integrations', { method: 'POST', body }); }
      toast(isEdit ? 'Integration saved' : 'Integration created');
      integrationsEditing = null; render();
    } catch (e) { err.textContent = errText(e); saveBtn.disabled = false; }
  });

  const editTypeLabel = isEdit
    ? (existing.type === 'custom' && existing.config_json && existing.config_json.preset && existing.config_json.preset !== 'custom'
      ? `${existing.type} · ${existing.config_json.preset}` : existing.type)
    : '';
  return el('div', { class: 'settings-card' },
    el('h3', {}, isEdit ? `Edit integration: ${existing.name}` : 'Add integration'),
    el('div', { class: 'form-grid' },
      isEdit ? alertField('System', el('span', { class: 'muted' }, editTypeLabel))
        : alertField('System', presetSel, 'ServiceNow, Nautobot (CMDB/IPAM sync), a generic webhook, Jira/TOPdesk/GLPI, or a Custom ticket API. Named systems pre-fill defaults you can tweak. Cannot be changed after creation.'),
      hintWrap,
      alertField('Name', nameI, 'A label for this integration.'),
      alertField('Base URL', urlI, 'https URL of the target API. Private/loopback addresses are rejected.'),
      authWrap, credWrap, cfgWrap, evWrap,
      alertField('Enabled', enabledI, 'When off, events are not dispatched to this target.'),
      err,
      el('div', { class: 'form-actions' }, saveBtn, cancelBtn)));
}

// CMDB (single source of truth) — configure the ONE CMDB source (ServiceNow or
// Nautobot), test the connection, enable it. Reuses the integrations connector
// metadata (auth types) + credential inputs. Credentials are write-only.
// The custom ("bring your own") CMDB config fields — search path + how to read
// the response. gather() returns { config: {...} } (always incl. searchPath).
function cmdbCustomConfigFields(config) {
  const c = config || {};
  const inputs = {};
  const rows = [];
  const text = (key, label, hint, ph) => { const i = el('input', { type: 'text', value: c[key] || '', placeholder: ph || '' }); inputs[key] = i; rows.push(alertField(label, i, hint)); };
  text('searchPath', 'Search path', 'Required. Path appended to the base URL for asset search.', '/api/assets');
  text('queryParam', 'Query parameter', 'Query-string param carrying the search text (default: q).', 'q');
  text('resultsPath', 'Results path', 'Dot-path to the results array in the response (blank = the body is the array).', 'result');
  text('idField', 'ID field', 'Dot-path to the asset id within a result (default: id).', 'id');
  text('nameField', 'Name field', 'Dot-path to the display name within a result (default: name).', 'name');
  text('typeField', 'Type field', 'Optional dot-path to the asset type/class.', 'sys_class_name');
  text('locationField', 'Location field', 'Optional dot-path to the location label (used for the site sync).', 'location');
  text('testPath', 'Test path', 'Optional path for the connection test (default: the search path).', '/api/assets');
  text('tokenScheme', 'Token scheme', 'Optional Authorization scheme word for token auth (default: Bearer).', 'Bearer');
  // Optional static extra headers (e.g. GLPI's App-Token) as a JSON object.
  const headersI = el('textarea', { rows: '3', spellcheck: 'false', placeholder: '{ "App-Token": "…" }' },
    c.headers ? JSON.stringify(c.headers, null, 2) : '');
  rows.push(alertField('Extra headers (JSON)', headersI, 'Optional static headers sent on every call (the Authorization header is set from the auth type above).'));
  function gather() {
    const out = {};
    for (const [k, i] of Object.entries(inputs)) { const v = i.value.trim(); if (v) out[k] = v; }
    const raw = headersI.value.trim();
    if (raw) { let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error('Extra headers must be valid JSON.'); } out.headers = parsed; }
    // Preserve the preset marker so the dropdown re-selects this template on reload.
    if (c.preset) out.preset = c.preset;
    return { config: out };
  }
  return { rows, gather };
}

async function settingsCmdbView() {
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'Configure the single CMDB source BlueEyes links agents to — ServiceNow, Nautobot, NetBox, i-doit, GLPI, or a Custom HTTP/JSON CMDB you describe yourself. Pick a system to pre-fill its defaults, or “Custom” to inject your own. Credentials are encrypted at rest and never shown again. Use “Test connection” to verify before enabling; linking an agent to an asset also syncs the agent’s site from the asset’s CMDB location.'));

  let cfg; let meta;
  try {
    [cfg, meta] = await Promise.all([api('/api/settings/cmdb'), api('/api/settings/cmdb/meta')]);
  } catch (e) { root.append(el('div', { class: 'empty error' }, errText(e))); return root; }

  const types = meta.types || [];
  const connectorFor = (type) => types.find((t) => t.type === type) || { authTypes: ['basic'], custom: type === 'custom' };
  const isSet = Boolean(cfg && cfg.type);

  // Preset-driven dropdown: built-ins (ServiceNow/Nautobot) + named custom
  // templates (NetBox/i-doit/GLPI) + a blank Custom. Falls back to bare types if
  // the server sent no presets (older build).
  const presets = (Array.isArray(meta.presets) && meta.presets.length)
    ? meta.presets
    : types.map((t) => ({ id: t.type, label: t.type, type: t.type, authType: (t.authTypes || ['basic'])[0], config: t.custom ? { preset: 'custom' } : {}, baseUrlPlaceholder: '' }));
  const presetById = (id) => presets.find((p) => p.id === id) || presets[0];
  // Which preset is active for the stored config: an explicit preset marker wins,
  // else the built-in whose type matches, else the blank Custom.
  const initialPresetId = (() => {
    if (!isSet) return presets[0].id;
    const marker = cfg.config_json && cfg.config_json.preset;
    if (marker && presets.some((p) => p.id === marker)) return marker;
    const byType = presets.find((p) => p.type === cfg.type && p.type !== 'custom');
    return byType ? byType.id : (presets.find((p) => p.type === 'custom') || presets[0]).id;
  })();

  const presetSel = el('select', {}, ...presets.map((p) => el('option', { value: p.id }, p.label)));
  presetSel.value = initialPresetId;
  const urlI = el('input', { type: 'text', value: isSet ? cfg.base_url : '', placeholder: 'https://example.service-now.com' });
  const enabledI = el('input', { type: 'checkbox' }); enabledI.checked = isSet ? !!cfg.enabled : false;

  const authWrap = el('div', { class: 'form-grid' });
  const credWrap = el('div', { class: 'form-grid' });
  const cfgWrap = el('div', { class: 'form-grid' });
  const err = el('p', { class: 'error' });
  const result = el('p', { class: 'muted small' });

  const currentType = () => presetById(presetSel.value).type;
  let authSel; let credGather; let cfgGather = null;
  function rebuildCreds() {
    const c = integrationCredFields(authSel.value, currentType(), isSet);
    credGather = c.gather;
    credWrap.replaceChildren(...c.rows);
  }
  // `keepStored` = re-render for the config already saved (initial load / same
  // preset), so we prefill from cfg; switching preset uses the template's defaults.
  function rebuild(keepStored) {
    const preset = presetById(presetSel.value);
    const conn = connectorFor(preset.type);
    const sameAsStored = keepStored && isSet && cfg.type === preset.type;
    authSel = el('select', {}, ...conn.authTypes.map((a) => el('option', { value: a }, a)));
    const preferredAuth = sameAsStored && conn.authTypes.includes(cfg.auth_type) ? cfg.auth_type
      : (conn.authTypes.includes(preset.authType) ? preset.authType : conn.authTypes[0]);
    authSel.value = preferredAuth;
    authSel.addEventListener('change', rebuildCreds);
    authWrap.replaceChildren(alertField('Auth type', authSel, 'How BlueEyes authenticates to the CMDB API.'));
    rebuildCreds();
    urlI.placeholder = preset.baseUrlPlaceholder || 'https://example.service-now.com';
    // Only the custom connector needs the free-form config block.
    if (conn.custom) {
      const initial = sameAsStored && cfg.config_json ? cfg.config_json : preset.config;
      const cc = cmdbCustomConfigFields(initial);
      cfgGather = cc.gather;
      const kids = [el('h4', { class: 'cmdb-cfg-head' }, 'Custom API settings')];
      if (preset.docsHint) kids.push(el('p', { class: 'muted small cmdb-preset-hint' }, preset.docsHint));
      cfgWrap.replaceChildren(...kids, ...cc.rows);
    } else {
      cfgGather = null;
      cfgWrap.replaceChildren();
    }
  }
  presetSel.addEventListener('change', () => rebuild(false));
  rebuild(true);

  const bodyFromForm = () => ({
    type: currentType(),
    base_url: urlI.value.trim(),
    auth_type: authSel.value,
    enabled: enabledI.checked,
    ...(cfgGather ? cfgGather() : {}),
    ...credGather(),
  });

  const saveBtn = el('button', { class: 'small' }, isSet ? 'Save changes' : 'Save CMDB');
  saveBtn.addEventListener('click', async () => {
    err.textContent = ''; saveBtn.disabled = true;
    try {
      await api('/api/settings/cmdb', { method: 'PUT', body: bodyFromForm() });
      toast('CMDB settings saved'); render();
    } catch (e) { err.textContent = errText(e); saveBtn.disabled = false; }
  });

  // Raw fetch (NOT api()) so a real HTTP 401 from the upstream test is shown
  // inline instead of triggering api()'s session-expiry logout.
  const testBtn = el('button', { class: 'small ghost' }, 'Test connection');
  testBtn.addEventListener('click', async () => {
    result.className = 'muted small'; result.textContent = 'Testing…'; testBtn.disabled = true;
    try {
      const res = await fetch('/api/settings/cmdb/test', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
      let data = null; try { data = await res.json(); } catch { /* no body */ }
      if (res.ok) {
        result.className = 'small ok';
        result.textContent = `✓ ${(data && data.detail) || 'connected'}${data && data.status != null ? ` (HTTP ${data.status})` : ''}`;
        render();
      } else {
        result.className = 'small error';
        const label = res.status === 401 ? 'Authentication failed' : ((data && data.error) || `HTTP ${res.status}`);
        result.textContent = `✗ ${label}${data && data.detail ? ` — ${data.detail}` : ''}`;
      }
    } catch (e) { result.className = 'small error'; result.textContent = `✗ ${e.message}`; }
    finally { testBtn.disabled = false; }
  });

  const statusLine = isSet
    ? el('div', { class: 'muted small' }, `Credentials: ${cfg.credentialsSet ? 'set' : 'not set'} · Last verified: ${cfg.verified_at ? new Date(cfg.verified_at).toLocaleString() : 'never'}`)
    : null;

  root.append(el('div', { class: 'settings-card' },
    el('h3', {}, 'CMDB source', ' ', el('span', { class: `badge ${isSet && cfg.enabled ? 'ok' : ''}` }, isSet && cfg.enabled ? 'Enabled' : 'Disabled')),
    el('div', { class: 'form-grid' },
      alertField('System', presetSel, 'ServiceNow, Nautobot, NetBox, i-doit, GLPI, or a Custom HTTP/JSON CMDB — the single source of truth. Named systems pre-fill sensible defaults you can tweak.'),
      alertField('Base URL', urlI, 'https URL of the CMDB API. Private/loopback addresses are rejected.'),
      authWrap, credWrap, cfgWrap,
      alertField('Enabled', enabledI, 'When off, asset search is not served.'),
      statusLine,
      err,
      el('div', { class: 'form-actions' }, saveBtn, testBtn, result))));
  return root;
}

async function settingsAlertingView() {
  const data = await api('/api/settings');
  const a = data.alerting || {};
  const ch = a.channels || {};
  const root = el('div');
  // Editable only when the licence includes alerting (the PUT is refused server-side
  // otherwise). An unknown licence (null) keeps the editor, per the "allow until we
  // know it's off" rule used for the assistant.
  const alertingLicensed = !data.license || data.license.alerting !== false;
  root.append(el('p', { class: 'muted settings-intro' },
    'When a finding is raised it can be dispatched by e-mail, webhook or syslog. Turn alerting on, then enable the channels you want and set a minimum severity for each. Settings are stored in the database and take effect immediately — no restart.'));
  if (!alertingLicensed) {
    root.append(el('div', { class: 'settings-grid' }, alertingUnlicensedCard(data.license)));
    return root;
  }
  root.append(el('div', { class: 'settings-grid' },
    alertingGeneralCard(a),
    alertingEmailCard(ch.email),
    alertingWebhookCard(ch.webhook),
    alertingSyslogCard(ch.syslog)));
  return root;
}

// Read-only placeholder shown instead of the editable alerting cards when the
// licence does not include alerting. The PUT is refused server-side too — this
// just explains why the controls are gone rather than looking broken.
function alertingUnlicensedCard(license) {
  return el('div', { class: 'settings-card' }, el('h3', {}, 'Alerting'),
    el('p', { class: 'muted' }, 'Alerting is not included in your licence, so channels cannot be configured here. Contact your provider to add it to your licence.'),
    licenseBadge(license, 'alerting'));
}

// Master switch + cooldown. Saves just { enabled, cooldownMs }; the server merges
// it onto the stored config, leaving the per-channel settings untouched.
function alertingGeneralCard(a) {
  const enabledI = el('input', { type: 'checkbox' }); enabledI.checked = !!a.enabled;
  const coolI = el('input', { type: 'number', min: '0', max: '1440', step: '1', value: String(Math.round((a.cooldownMs ?? 900000) / 60000)) });
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'small' }, 'Save');
  async function save() {
    err.textContent = '';
    // Don't silently coerce a blank/invalid cooldown to 0 — that would disable
    // throttling and let repeated findings spam every channel. An explicit 0 is
    // still allowed (a deliberate "send every finding, no cooldown").
    const raw = coolI.value.trim();
    const mins = Number(raw);
    if (raw === '' || !Number.isFinite(mins) || mins < 0 || mins > 1440) {
      err.textContent = 'Cooldown must be a number between 0 and 1440 minutes.';
      return;
    }
    btn.disabled = true;
    try { await api('/api/settings/alerting', { method: 'PUT', body: { enabled: enabledI.checked, cooldownMs: Math.round(mins * 60000) } }); toast('Alerting saved'); }
    catch (e2) { err.textContent = errText(e2); }
    finally { btn.disabled = false; }
  }
  btn.addEventListener('click', save);
  return el('div', { class: 'settings-card' }, el('h3', {}, 'Alerting'),
    el('div', { class: 'form-grid' },
      el('label', { class: 'set-field' }, el('span', {}, 'Alerting enabled'), enabledI,
        el('span', { class: 'muted small' }, 'Master switch. When off, findings are still recorded but never dispatched.')),
      el('label', { class: 'set-field' }, el('span', {}, 'Cooldown (minutes)'), coolI,
        el('span', { class: 'muted small' }, 'Minimum time between repeated alerts for the same condition on the same host. 0 = no throttling (every finding is sent).')),
      err, el('div', { class: 'form-actions' }, btn)));
}

function alertSevSelect(value) {
  const sel = el('select', {}, ...['INFO', 'WARN', 'CRIT'].map((s) => el('option', { value: s }, s)));
  sel.value = ['INFO', 'WARN', 'CRIT'].includes(value) ? value : 'WARN';
  return sel;
}

// A write-only secret field (SMTP password / webhook secret): blank by default,
// the placeholder shows whether one is stored + a masked hint, and a "Remove"
// checkbox (only when set) clears it. reset() refreshes it after a save.
function alertSecretField(label, hint, isSet, hintMask) {
  const input = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const clear = el('input', { type: 'checkbox' });
  const clearRow = el('label', { class: 'inline muted small' }, clear, el('span', {}, `Remove the stored ${label.toLowerCase()}`));
  function reset(set, mask) {
    input.value = '';
    input.placeholder = set ? `Set (${mask}) — type to replace` : 'Not set';
    clear.checked = false;
    clearRow.classList.toggle('hidden', !set);
  }
  reset(isSet, hintMask);
  const field = el('label', { class: 'set-field' }, el('span', {}, label), input, el('span', { class: 'muted small' }, hint));
  return { rows: [field, clearRow], input, clear, reset };
}

function alertField(label, input, hint) {
  return el('label', { class: 'set-field' }, el('span', {}, label), input, hint ? el('span', { class: 'muted small' }, hint) : null);
}

// One channel card. The shell renders Enabled + Minimum severity, then the
// channel-specific bodyRows, and wires Save (PUT { [name]: slice }) + Send test
// (POST /api/alerting/test). gather() returns the channel-specific slice;
// onSaved(alerting) lets a channel refresh its secret field after saving.
function alertingChannelCard({ name, title, blurb, channel, bodyRows, gather, onSaved }) {
  const c = channel || {};
  const enabledI = el('input', { type: 'checkbox' }); enabledI.checked = !!c.enabled;
  const sevI = alertSevSelect(c.minSeverity);
  const err = el('p', { class: 'error' });
  const saveBtn = el('button', { class: 'small' }, 'Save');
  const testBtn = el('button', { class: 'small ghost' }, 'Send test');
  async function save() {
    err.textContent = ''; saveBtn.disabled = true;
    const slice = gather();
    slice.enabled = enabledI.checked;
    slice.minSeverity = sevI.value;
    try {
      const res = await api('/api/settings/alerting', { method: 'PUT', body: { [name]: slice } });
      toast(`${title} saved`);
      if (onSaved) onSaved(res.alerting || {});
    } catch (e2) { err.textContent = errText(e2); }
    finally { saveBtn.disabled = false; }
  }
  async function sendTest() {
    err.textContent = ''; testBtn.disabled = true;
    try {
      const res = await api('/api/alerting/test', { method: 'POST', body: { channel: name } });
      const r = res.result || {};
      if (r.ok) toast(`${title}: test sent`);
      else err.textContent = `Test failed: ${r.detail || 'unknown error'}`;
    } catch (e2) { err.textContent = errText(e2); }
    finally { testBtn.disabled = false; }
  }
  saveBtn.addEventListener('click', save);
  testBtn.addEventListener('click', sendTest);
  return el('div', { class: 'settings-card' }, el('h3', {}, title),
    el('div', { class: 'form-grid' },
      alertField('Enabled', enabledI, blurb),
      alertField('Minimum severity', sevI, 'Only findings at or above this level go to this channel.'),
      ...bodyRows,
      err,
      el('div', { class: 'form-actions' }, saveBtn, testBtn,
        el('span', { class: 'muted small' }, 'Save before testing — the test uses the saved settings.'))));
}

function alertingEmailCard(channel) {
  const e = channel || {}; const smtp = e.smtp || {};
  const toI = el('input', { type: 'text', value: e.to || '', placeholder: 'ops@example.eu, oncall@example.eu' });
  const fromI = el('input', { type: 'text', value: e.from || '', placeholder: 'blueeye@example.eu' });
  const hostI = el('input', { type: 'text', value: smtp.host || '', placeholder: 'smtp.example.eu' });
  const portI = el('input', { type: 'number', min: '1', max: '65535', step: '1', value: String(smtp.port ?? 587) });
  const userI = el('input', { type: 'text', value: smtp.user || '' });
  const secureI = el('input', { type: 'checkbox' }); secureI.checked = !!smtp.secure;
  const pass = alertSecretField('SMTP password', 'Write-only — stored on the server, never displayed again.', !!e.smtpPassSet, e.smtpPassHint || '');
  return alertingChannelCard({
    name: 'email', title: 'E-mail', blurb: 'Send alerts by e-mail over SMTP.', channel: e,
    bodyRows: [
      alertField('To', toI, 'Recipient(s), comma-separated.'),
      alertField('From', fromI, 'Sender address.'),
      alertField('SMTP host', hostI, 'Use an EU/self-hosted mail server.'),
      alertField('SMTP port', portI),
      alertField('SMTP username', userI, 'Leave blank for an unauthenticated relay.'),
      ...pass.rows,
      alertField('Use TLS (secure)', secureI, 'On for implicit TLS (port 465); off uses STARTTLS.'),
    ],
    gather: () => {
      const slice = { to: toI.value.trim(), from: fromI.value.trim(), smtp: { host: hostI.value.trim(), port: Number(portI.value), user: userI.value.trim(), secure: secureI.checked } };
      if (pass.clear.checked) slice.clearSmtpPass = true;
      else if (pass.input.value.trim() !== '') slice.smtp.pass = pass.input.value.trim();
      return slice;
    },
    onSaved: (al) => { const ne = (al.channels && al.channels.email) || {}; pass.reset(!!ne.smtpPassSet, ne.smtpPassHint || ''); },
  });
}

function alertingWebhookCard(channel) {
  const w = channel || {};
  const urlI = el('input', { type: 'text', value: w.url || '', placeholder: 'https://hooks.example.eu/blueeye' });
  const secret = alertSecretField('Signing secret', 'HMAC-SHA256 secret — the POST is signed as X-BlueEye-Signature. Write-only.', !!w.secretSet, w.secretHint || '');
  return alertingChannelCard({
    name: 'webhook', title: 'Webhook', blurb: 'POST each finding as JSON to a URL.', channel: w,
    bodyRows: [alertField('URL', urlI, 'Endpoint that receives the JSON POST.'), ...secret.rows],
    gather: () => {
      const slice = { url: urlI.value.trim() };
      if (secret.clear.checked) slice.clearSecret = true;
      else if (secret.input.value.trim() !== '') slice.secret = secret.input.value.trim();
      return slice;
    },
    onSaved: (al) => { const nw = (al.channels && al.channels.webhook) || {}; secret.reset(!!nw.secretSet, nw.secretHint || ''); },
  });
}

function alertingSyslogCard(channel) {
  const s = channel || {};
  const hostI = el('input', { type: 'text', value: s.host || '', placeholder: 'siem.example.eu' });
  const portI = el('input', { type: 'number', min: '1', max: '65535', step: '1', value: String(s.port ?? 514) });
  const protoI = el('select', {}, el('option', { value: 'udp' }, 'UDP'), el('option', { value: 'tcp' }, 'TCP'));
  protoI.value = s.proto === 'tcp' ? 'tcp' : 'udp';
  const appI = el('input', { type: 'text', value: s.appName || 'blueeye' });
  return alertingChannelCard({
    name: 'syslog', title: 'Syslog', blurb: 'Send findings as RFC5424 syslog lines.', channel: s,
    bodyRows: [
      alertField('Host', hostI, 'Syslog collector / SIEM host.'),
      alertField('Port', portI),
      alertField('Protocol', protoI),
      alertField('App name', appI, 'APP-NAME field in the syslog line.'),
    ],
    gather: () => ({ host: hostI.value.trim(), port: Number(portI.value), proto: protoI.value, appName: appI.value.trim() }),
  });
}

// ---- Settings → Authentication (LDAP / Active Directory) ------------------
// Connect BlueEyes to an LDAP/AD directory so users sign in with their directory
// account and get a role from their group membership. Backend: src/routes/ldap.js
// (config CRUD + connectivity test + login audit) and src/auth/ldap.js (the bind
// + group→role resolution, run from src/routes/auth.js at login). Admin-only and
// licence-gated (sso_ldap, Professional) — the server returns licensed:false and
// refuses the writes when the plan doesn't include it.
async function settingsAuthView() {
  const cfgRes = await api('/api/ldap/config');
  const cfg = cfgRes.config || {};
  const licensed = cfgRes.licensed !== false; // server-computed; allow-until-known-off
  const envOn = cfgRes.authEnabledFlag === true;
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'Let users sign in with their Active Directory / LDAP account. After a successful bind, each user’s BlueEyes role is taken from their directory group membership (the highest matching role wins), so access is governed centrally in the directory. Local accounts keep working as a fallback. ',
    ldapBadge(licensed)));

  if (!licensed) {
    root.append(el('div', { class: 'settings-grid' }, ldapUnlicensedCard()));
    return root;
  }

  const roleMap = await api('/api/ldap/role-map').catch(() => []);
  if (!envOn) root.append(ldapInactiveBanner());
  root.append(el('div', { class: 'settings-grid' },
    ldapConnectionCard(cfg, cfgRes.bindPasswordSet),
    ldapRoleMapCard(Array.isArray(roleMap) ? roleMap : []),
    ldapAuditCard()));
  return root;
}

// Licence badge for the Authentication tab. Built from the server-computed flag —
// the generic licenseBadge() reads the legacy four-feature summary, which doesn't
// carry the packaged sso_ldap key.
function ldapBadge(licensed) {
  return el('span', { class: `badge ${licensed ? 'active' : 'offline'}` }, `Licence: LDAP/AD ${licensed ? 'yes' : 'no'}`);
}

// Read-only placeholder when the licence doesn't include directory auth — the
// writes are refused server-side too, so this explains the missing controls.
function ldapUnlicensedCard() {
  return el('div', { class: 'settings-card' }, el('h3', {}, 'LDAP / Active Directory'),
    el('p', { class: 'muted' }, 'Directory login is not included in your licence, so it can’t be configured here. It is part of the BlueEyes Professional plan — contact your provider to enable it. ',
      settingsLink('license', 'See Settings → License'), ' for the full feature matrix.'),
    ldapBadge(false));
}

// Shown when LDAP is configured here but the server wasn't started with
// LDAP_AUTH_ENABLED=true, so directory login isn't actually live yet.
function ldapInactiveBanner() {
  return el('div', { class: 'settings-card wide ldap-banner' },
    el('h3', {}, el('span', { class: 'badge warn' }, 'Inactive'), ' Server flag required'),
    el('p', { class: 'muted' }, 'These settings are saved, but directory login only takes effect once the server is started with the environment variable ',
      el('code', {}, 'LDAP_AUTH_ENABLED=true'), '. Until then, users sign in with local accounts.'));
}

function roleSelect(value) {
  const sel = el('select', {}, ...['viewer', 'operator', 'admin'].map((r) => el('option', { value: r }, r)));
  sel.value = ['viewer', 'operator', 'admin'].includes(value) ? value : 'viewer';
  return sel;
}

// Connection settings: host/port/TLS, the search bind account (write-only
// password), the directory base + filters, and the enable switch. Save persists
// the whole config; "Test connection" binds with the saved service account.
function ldapConnectionCard(cfg, bindPasswordSet) {
  const enabledI = el('input', { type: 'checkbox' }); enabledI.checked = cfg.enabled === true;
  const hostI = el('input', { type: 'text', value: cfg.host || '', placeholder: 'ad.example.eu' });
  const tlsI = el('input', { type: 'checkbox' }); tlsI.checked = cfg.use_tls !== false;
  const portI = el('input', { type: 'number', min: '1', max: '65535', step: '1', value: String(cfg.port ?? 636) });
  const bindDnI = el('input', { type: 'text', value: cfg.bind_dn || '', placeholder: 'cn=svc-blueeye,ou=svc,dc=example,dc=eu — blank = anonymous' });
  const baseDnI = el('input', { type: 'text', value: cfg.base_dn || '', placeholder: 'dc=example,dc=eu' });
  const userFilterI = el('input', { type: 'text', value: cfg.user_filter || '(sAMAccountName={{username}})' });
  const groupFilterI = el('input', { type: 'text', value: cfg.group_filter || '', placeholder: '(member={{dn}}) — optional, only if memberOf is absent' });
  const pass = alertSecretField('Bind password', 'Service-account password used for the search bind. Write-only — stored encrypted, never shown.', !!bindPasswordSet, '••••');
  const err = el('p', { class: 'error' });
  const saveBtn = el('button', { class: 'small' }, 'Save');
  const testBtn = el('button', { class: 'small ghost' }, 'Test connection');

  // Flip the port to the scheme's standard when TLS is toggled and the port is
  // still a default, mirroring the server's 636 (LDAPS) / 389 (LDAP) defaulting.
  tlsI.addEventListener('change', () => {
    if (['', '389', '636'].includes(portI.value)) portI.value = tlsI.checked ? '636' : '389';
  });

  function gather() {
    const body = {
      host: hostI.value.trim(), port: Number(portI.value), useTls: tlsI.checked,
      bindDn: bindDnI.value.trim(), baseDn: baseDnI.value.trim(),
      userFilter: userFilterI.value.trim(), groupFilter: groupFilterI.value.trim(),
      enabled: enabledI.checked,
    };
    if (pass.clear.checked) body.clearBindPassword = true;
    else if (pass.input.value !== '') body.bindPassword = pass.input.value;
    return body;
  }
  async function save() {
    err.textContent = ''; saveBtn.disabled = true;
    try { await api('/api/ldap/config', { method: 'PUT', body: gather() }); toast('LDAP settings saved'); render(); }
    catch (e) { err.textContent = errText(e); saveBtn.disabled = false; }
  }
  async function test() {
    err.textContent = ''; testBtn.disabled = true;
    try {
      const r = await api('/api/ldap/test', { method: 'POST' });
      if (r.ok) toast(`Connected: ${r.detail || 'ok'}`);
      else err.textContent = `Test failed: ${r.detail || 'unknown error'}`;
    } catch (e) { err.textContent = errText(e); }
    finally { testBtn.disabled = false; }
  }
  saveBtn.addEventListener('click', save);
  testBtn.addEventListener('click', test);

  return el('div', { class: 'settings-card' }, el('h3', {}, 'Directory connection'),
    el('div', { class: 'form-grid' },
      alertField('Directory login enabled', enabledI, 'Master switch for this config. Login also requires the server flag LDAP_AUTH_ENABLED and the licence.'),
      alertField('Host', hostI, 'Hostname or IP of the AD/LDAP server. Use an EU/on-prem directory.'),
      alertField('Use TLS (LDAPS)', tlsI, 'Required for any non-local host — a plaintext bind off-localhost is refused.'),
      alertField('Port', portI, 'Standard ports: 636 for LDAPS, 389 for plaintext.'),
      alertField('Bind DN', bindDnI, 'Service account for the user search. Leave blank to search anonymously.'),
      ...pass.rows,
      alertField('Base DN', baseDnI, 'Where user/group searches start, e.g. dc=example,dc=eu.'),
      alertField('User filter', userFilterI, 'Must contain {{username}}. AD: (sAMAccountName={{username}}); OpenLDAP: (uid={{username}}).'),
      alertField('Group filter (optional)', groupFilterI, 'Only used when the user entry has no memberOf. {{dn}}/{{username}} are substituted.'),
      err,
      el('div', { class: 'form-actions' }, saveBtn, testBtn,
        el('span', { class: 'muted small' }, 'Save before testing — the test uses the saved settings.'))));
}

// Group → role mapping: each LDAP/AD group DN maps to a BlueEyes role. The change
// select PUTs immediately; add/delete re-render the tab.
function ldapRoleMapCard(roleMap) {
  const card = el('div', { class: 'settings-card wide' }, el('h3', {}, 'Group → role mapping'));
  card.append(el('p', { class: 'muted small' },
    'Map a directory group (by its full DN) to a BlueEyes role. A user gets the highest role across all their matched groups; a user in no mapped group is denied access — there is no default role. Roles: viewer < operator < admin.'));
  const err = el('p', { class: 'error' });
  const listEl = el('div', { class: 'tablewrap' });

  function renderList() {
    if (!roleMap.length) {
      listEl.replaceChildren(el('div', { class: 'empty' }, 'No mappings yet. Until at least one exists, every directory login is denied — add one below.'));
      return;
    }
    listEl.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Group DN'), el('th', {}, 'Role'), el('th', {}))),
      el('tbody', {}, ...roleMap.map((m) => {
        const sel = roleSelect(m.blueeye_role);
        sel.addEventListener('change', async () => {
          err.textContent = '';
          try { await api(`/api/ldap/role-map/${m.id}`, { method: 'PUT', body: { groupDn: m.ldap_group_dn, role: sel.value } }); m.blueeye_role = sel.value; toast('Mapping updated'); }
          catch (e) { sel.value = m.blueeye_role; err.textContent = errText(e); }
        });
        const del = el('button', { class: 'small ghost danger', onclick: async () => {
          err.textContent = '';
          try { await api(`/api/ldap/role-map/${m.id}`, { method: 'DELETE' }); render(); }
          catch (e) { err.textContent = errText(e); }
        } }, 'Delete');
        return el('tr', {}, el('td', {}, el('code', {}, m.ldap_group_dn)), el('td', {}, sel), el('td', {}, del));
      }))));
  }
  renderList();

  const groupI = el('input', { type: 'text', placeholder: 'cn=NetOps,ou=Groups,dc=example,dc=eu' });
  const roleI = roleSelect('viewer');
  const addBtn = el('button', { class: 'small' }, '+ Add mapping');
  addBtn.addEventListener('click', async () => {
    err.textContent = '';
    const groupDn = groupI.value.trim();
    if (!groupDn) { err.textContent = 'Group DN is required.'; return; }
    addBtn.disabled = true;
    try { await api('/api/ldap/role-map', { method: 'POST', body: { groupDn, role: roleI.value } }); render(); }
    catch (e) { err.textContent = e.status === 409 ? 'That group is already mapped.' : errText(e); addBtn.disabled = false; }
  });

  card.append(listEl, el('div', { class: 'ldap-add' },
    el('label', { class: 'set-field' }, el('span', {}, 'Group DN'), groupI),
    el('label', { class: 'set-field' }, el('span', {}, 'Role'), roleI),
    addBtn), err);
  return card;
}

// Recent directory sign-in attempts (read-only), so an admin can confirm logins
// are flowing and see which role each grant resolved to. Lazy-loads + refreshes.
function ldapAuditCard() {
  const card = el('div', { class: 'settings-card wide' });
  const body = el('div', {}, el('p', { class: 'muted small' }, 'Loading…'));
  const refresh = el('button', { class: 'small ghost' }, '↻ Refresh');
  card.append(el('div', { class: 'section-head' }, el('h3', {}, 'Recent sign-ins'), el('span', { class: 'spacer' }), refresh), body);

  async function load() {
    body.replaceChildren(el('p', { class: 'muted small' }, 'Loading…'));
    let rows;
    try { rows = await api('/api/ldap/login-audit?limit=25'); }
    catch (e) { body.replaceChildren(el('p', { class: 'error' }, errText(e))); return; }
    if (!rows.length) { body.replaceChildren(el('div', { class: 'empty' }, 'No directory sign-in attempts recorded yet.')); return; }
    body.replaceChildren(el('div', { class: 'tablewrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['When', 'Username', 'Result', 'Role', 'Groups', 'Source IP'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((r) => el('tr', {},
        el('td', { class: 'muted' }, fmtDate(r.created_at)),
        el('td', {}, r.username || '–'),
        el('td', {}, r.ok ? el('span', { class: 'badge ok' }, 'ok') : el('span', { class: 'badge bad' }, r.reason || 'failed')),
        el('td', {}, r.granted_role || '–'),
        el('td', { class: 'muted' }, String(r.groups_matched ?? 0)),
        el('td', { class: 'muted' }, r.source_ip || '–')))))));
  }
  refresh.addEventListener('click', load);
  load();
  return card;
}

// Maintenance windows: during an active window, alert notifications are
// suppressed (findings are still recorded + shown). Global, per-location or
// per-agent. Admin only.
async function settingsMaintenanceView() {
  const [data, agents, locations] = await Promise.all([api('/api/settings'), api('/agents').catch(() => []), api('/locations').catch(() => [])]);
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'During a maintenance window alert notifications (e-mail/webhook/syslog) are suppressed — findings are still recorded and shown. Use it during planned work so nobody gets paged unnecessarily.'));
  let windows = (data.maintenance && Array.isArray(data.maintenance.windows)) ? data.maintenance.windows.slice() : [];
  const listHost = el('div', {});
  const err = el('p', { class: 'error' });

  const agentName = (id) => { const a = agents.find((x) => String(x.id) === String(id)); return a ? (a.display_name || a.hostname) : `#${id}`; };
  const locName = (id) => { const l = locations.find((x) => String(x.id) === String(id)); return l ? l.name : `#${id}`; };
  const scopeText = (w) => (w.scope === 'global' ? 'All agents' : w.scope === 'agent' ? `Agent: ${agentName(w.targetId)}` : `Location: ${locName(w.targetId)}`);
  const isActive = (w) => { const n = Date.now(); return Date.parse(w.from) <= n && n <= Date.parse(w.to); };

  async function persist() {
    err.textContent = '';
    try { const res = await api('/api/settings/maintenance', { method: 'PUT', body: { windows } }); windows = res.windows; renderList(); }
    catch (e) { err.textContent = e.data && e.data.details ? Object.values(e.data.details).join(' · ') : e.message; }
  }
  function renderList() {
    if (!windows.length) { listHost.replaceChildren(el('div', { class: 'empty' }, 'No windows. Add one below.')); return; }
    listHost.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, ...['Name', 'Scope', 'From', 'To', '', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...windows.map((w) => el('tr', {},
        el('td', {}, w.name),
        el('td', { class: 'muted' }, scopeText(w)),
        el('td', { class: 'muted' }, fmtDate(w.from)),
        el('td', { class: 'muted' }, fmtDate(w.to)),
        el('td', {}, isActive(w) ? el('span', { class: 'badge warn' }, 'active') : el('span', { class: 'muted' }, 'scheduled')),
        el('td', {}, el('button', { class: 'small danger', onclick: () => { windows = windows.filter((x) => x.id !== w.id); persist(); } }, 'Delete')))))));
  }
  renderList();

  // Add form.
  const nameI = el('input', { type: 'text', placeholder: 'e.g. Firmware upgrade' });
  const scopeSel = el('select', {}, el('option', { value: 'global' }, 'All agents'), el('option', { value: 'agent' }, 'One agent'), el('option', { value: 'location' }, 'One location'));
  const targetSel = el('select', {});
  const fromI = el('input', { type: 'datetime-local' });
  const toI = el('input', { type: 'datetime-local' });
  const syncTarget = () => {
    targetSel.style.display = scopeSel.value === 'global' ? 'none' : '';
    const opts = scopeSel.value === 'agent' ? agents.map((a) => [a.id, a.display_name || a.hostname]) : scopeSel.value === 'location' ? locations.map((l) => [l.id, l.name]) : [];
    targetSel.replaceChildren(...opts.map(([v, l]) => el('option', { value: String(v) }, l)));
  };
  scopeSel.addEventListener('change', syncTarget); syncTarget();
  const addBtn = el('button', { class: 'small' }, '+ Add window');
  addBtn.addEventListener('click', () => {
    err.textContent = '';
    if (!nameI.value.trim() || !fromI.value || !toI.value) { err.textContent = 'Name, from and to are required.'; return; }
    const w = { name: nameI.value.trim(), scope: scopeSel.value, from: new Date(fromI.value).toISOString(), to: new Date(toI.value).toISOString() };
    if (scopeSel.value !== 'global') w.targetId = Number(targetSel.value);
    windows = windows.concat([w]);
    nameI.value = '';
    persist();
  });

  root.append(el('div', { class: 'settings-grid' }, settingsCard('Maintenance windows', el('div', {}, listHost,
    el('div', { class: 'mw-form' },
      el('label', { class: 'set-field' }, el('span', {}, 'Name'), nameI),
      el('label', { class: 'set-field' }, el('span', {}, 'Scope'), scopeSel),
      el('label', { class: 'set-field' }, el('span', {}, 'Target'), targetSel),
      el('label', { class: 'set-field' }, el('span', {}, 'From'), fromI),
      el('label', { class: 'set-field' }, el('span', {}, 'To'), toI),
      addBtn),
    err))));
  return root;
}

// Runbooks admin (Fase 3): the static finding-type → recommended-action mapping
// surfaced on the event (Situations) page. Admin CRUD; clones the list + modal
// + delete-confirm pattern used elsewhere.
// Settings → Severity rules.
//
// BlueEyes decides severity at detection — the analyser from a MAD z-score,
// Service Assurance from the kind of failure. Both are reasonable defaults and
// neither knows your business: the packet loss that pages one customer at 3am is
// the wifi at another one's warehouse.
//
// A rule says "events matching this get that severity, from now on". It applies
// when an event is STORED, so alerting reads it and history records what was
// actually decided at the time. It never applies backwards on its own — that is
// the separate, counted, confirmed action on each row.
const SEVERITY_RULE_SOURCES = ['finding', 'service_assurance'];

// Spelled out rather than built from the value, because the UI gate sweeps
// literal t() keys and a key assembled at runtime is a key nobody can find.
function severityRuleSourceLabel(source) {
  return source === 'service_assurance' ? t('sev.source.serviceAssurance') : t('sev.source.finding');
}

function severityRuleScope(r) {
  const parts = [];
  if (r.match_metric) parts.push(t('sev.scope.metric', { value: r.match_metric }));
  if (r.match_kind) parts.push(t('sev.scope.kind', { value: r.match_kind }));
  if (r.match_host_id) parts.push(t('sev.scope.agent', { value: r.match_host_id }));
  if (r.match_application_id) parts.push(t('sev.scope.application', { value: r.match_application_id }));
  // Never reachable through the form (a rule with nothing pinned down is
  // refused server-side), but said plainly rather than shown as an empty cell
  // if one ever arrives from an older row or the API.
  return parts.length ? parts.join(' · ') : t('sev.scope.everything');
}

async function settingsSeverityRulesView() {
  const rules = await api('/api/severity-rules');
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, t('sev.intro')));

  root.append(el('div', { class: 'section-head' },
    el('h3', {}, t('sev.title', { count: rules.length })),
    isAdmin() ? el('button', { class: 'small', onclick: () => editSeverityRule() }, t('sev.new')) : null));

  if (!rules.length) {
    root.append(el('div', { class: 'empty' }, t('sev.empty')));
    return root;
  }

  const rows = rules.map((r) => el('tr', { class: r.enabled ? '' : 'acked' },
    el('td', { class: 'muted' }, severityRuleSourceLabel(r.source)),
    el('td', {}, severityRuleScope(r)),
    el('td', {}, el('span', { class: `badge ${r.severity}` }, r.severity)),
    el('td', {}, r.reason || '—'),
    // A rule nobody can tell is dead is a rule nobody dares delete.
    el('td', { class: 'muted' }, r.applied_count
      ? t('sev.usedCount', { count: r.applied_count, when: fmtDate(r.last_applied_at) })
      : t('sev.neverUsed')),
    el('td', {}, r.enabled
      ? el('span', { class: 'badge active' }, t('sev.on'))
      : el('span', { class: 'badge' }, t('sev.off'))),
    el('td', {}, isAdmin() ? el('div', { class: 'row-actions' },
      el('button', { class: 'small ghost', onclick: () => editSeverityRule(r) }, t('sev.edit')),
      el('button', { class: 'small ghost', onclick: () => applySeverityRuleToOpen(r) }, t('sev.applyToOpen')),
      el('button', { class: 'small ghost', onclick: () => deleteSeverityRule(r) }, t('sev.delete'))) : null)));

  root.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, t('sev.col.source')), el('th', {}, t('sev.col.matches')),
      el('th', {}, t('sev.col.severity')), el('th', {}, t('sev.col.why')),
      el('th', {}, t('sev.col.used')), el('th', {}, t('sev.col.state')), el('th', {}, ''))),
    el('tbody', {}, ...rows))));
  return root;
}

// `prefill` lets an event open this form already describing itself, so writing
// a rule is one click from the event that prompted it rather than a trip to
// Settings and a guess at what to type.
async function editSeverityRule(r, prefill) {
  const editing = r && r.id;
  const source = (r && r.source) || (prefill && prefill.source) || 'finding';
  const v = (name) => (r && r[name] != null ? String(r[name]) : ((prefill && prefill[name] != null) ? String(prefill[name]) : ''));

  // Only the fields that belong to this source. Offering the others would let
  // someone write a rule that matches far more than they believe — the server
  // refuses them, but a form should not be able to ask for one.
  const scopeFields = source === 'finding'
    ? [
      { name: 'match_metric', label: t('sev.field.metric'), type: 'text', value: v('match_metric') },
      { name: 'match_kind', label: t('sev.field.kind'), type: 'text', value: v('match_kind') },
      { name: 'match_host_id', label: t('sev.field.agent'), type: 'text', value: v('match_host_id') },
    ]
    : [
      { name: 'match_kind', label: t('sev.field.saKind'), type: 'text', value: v('match_kind') },
      { name: 'match_application_id', label: t('sev.field.application'), type: 'text', value: v('match_application_id') },
    ];

  const fields = [
    // The source decides which fields mean anything, so it is fixed once the
    // rule exists rather than silently orphaning the ones already filled in.
    ...(editing ? [] : [{
      name: 'source', label: t('sev.field.source'), type: 'select', value: source,
      options: SEVERITY_RULE_SOURCES.map((value) => ({ value, label: severityRuleSourceLabel(value) })),
      hint: t('sev.field.sourceHint'),
    }]),
    ...scopeFields,
    { name: 'severity', label: t('sev.field.severity'), type: 'select', value: v('severity') || 'WARN',
      options: ['INFO', 'WARN', 'CRIT'].map((x) => ({ value: x, label: x })) },
    { name: 'reason', label: t('sev.field.reason'), type: 'textarea', value: v('reason'),
      hint: t('sev.field.reasonHint') },
    { name: 'enabled', label: t('sev.field.state'), type: 'select',
      value: ((r && r.enabled === false) || (prefill && prefill.enabled === 'false')) ? 'false' : 'true',
      options: [{ value: 'true', label: t('sev.on') }, { value: 'false', label: t('sev.off') }] },
  ];

  const modalFields = fields;
  openModal(editing ? t('sev.editTitle') : t('sev.newTitle'), fields, async (vals) => {
    const body = {
      source: editing ? r.source : vals.source,
      severity: vals.severity,
      reason: vals.reason,
      enabled: vals.enabled === 'true',
    };
    // A blank box means "any", which the API spells as null. Sending '' would
    // be a rule that matches the empty string and therefore nothing.
    for (const f of scopeFields) body[f.name] = vals[f.name].trim() || null;
    await api(editing ? `/api/severity-rules/${r.id}` : '/api/severity-rules', {
      method: editing ? 'PUT' : 'POST', body,
    });
    closeModal();
    toast(t('sev.saved'));
    render();
  });

  // Switching the source rebuilds the form, because the fields below it BELONG
  // to the source: a Service Assurance rule has no agent, and a finding has no
  // application. Left as it was, the dialog would offer an agent box on a
  // Service Assurance rule and post a match field the server refuses — a 400
  // the person could do nothing about, on a form that looked fine.
  //
  // What has already been typed is carried across. Only the fields the new
  // source also has survive; the rest could not have meant anything there.
  if (!editing) {
    const card = $('#modal-card');
    const picker = card.querySelector('select');
    if (picker) {
      const nodes = [...card.querySelectorAll('form input, form select, form textarea')];
      picker.addEventListener('change', () => {
        const typed = {};
        modalFields.forEach((f, i) => { if (nodes[i]) typed[f.name] = nodes[i].value; });
        typed.source = picker.value;
        editSeverityRule(null, typed);
      });
    }
  }
}

// Counts first, always. "412 events" before it happens rather than after.
async function applySeverityRuleToOpen(r) {
  let dry;
  try { dry = await api(`/api/severity-rules/${r.id}/apply-to-open`, { method: 'POST', body: {} }); }
  catch (err) { toast(errText(err), true); return; }
  if (!dry.changed) { toast(t('sev.applyNone')); return; }
  if (!confirm(`${dry.note}\n\n${t('sev.applyConfirm')}`)) return;
  try {
    const done = await api(`/api/severity-rules/${r.id}/apply-to-open`, { method: 'POST', body: { confirm: true } });
    toast(done.note);
    render();
  } catch (err) { toast(errText(err), true); }
}

async function deleteSeverityRule(r) {
  // Said plainly: deleting the rule does not un-decide what it already decided.
  if (!confirm(t('sev.deleteConfirm'))) return;
  try { await api(`/api/severity-rules/${r.id}`, { method: 'DELETE' }); toast(t('sev.deleted')); render(); }
  catch (err) { toast(errText(err), true); }
}

async function settingsRunbooksView() {
  const { runbooks } = await api('/api/runbooks');
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'Runbooks map an anomaly finding-type (e.g. cpu, probe.loss) to a concrete recommended action shown on the event page. Write the action in Markdown; optionally link a remediation playbook so operators can run it (with verification) from the event.'));

  root.append(el('div', { class: 'section-head' },
    el('h3', {}, `Runbooks (${runbooks.length})`),
    el('button', { class: 'small', onclick: () => editRunbook() }, '+ New runbook')));

  if (!runbooks.length) {
    root.append(el('div', { class: 'empty' }, 'No runbooks yet. Add one to bridge a finding-type to a recommended action.'));
    return root;
  }
  const rows = runbooks.map((r) => el('tr', {},
    el('td', {}, el('span', { class: 'badge rc-type' }, r.findingType)),
    el('td', {}, el('strong', {}, r.title)),
    el('td', { class: 'muted' }, r.linkedPlaybookName ? r.linkedPlaybookName : '—'),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'small ghost', onclick: () => editRunbook(r) }, 'Edit'),
      el('button', { class: 'small ghost', onclick: () => deleteRunbook(r) }, 'Delete')))));
  root.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Finding type'), el('th', {}, 'Title'), el('th', {}, 'Linked playbook'), el('th', {}, ''))),
    el('tbody', {}, ...rows))));
  return root;
}

async function editRunbook(r) {
  // Offer the existing playbooks as link options (best-effort; empty if none).
  let playbooks = [];
  try { const resp = await api('/api/runbooks/playbooks'); playbooks = (resp && resp.playbooks) || []; } catch { playbooks = []; }
  const editing = r && r.id;
  const fields = [
    { name: 'findingType', label: 'Finding type (metric, e.g. cpu)', type: 'text', value: r ? r.findingType : '' },
    { name: 'title', label: 'Title', type: 'text', value: r ? r.title : '' },
    { name: 'bodyMarkdown', label: 'Action (Markdown)', type: 'textarea', value: r ? r.bodyMarkdown : '' },
    { name: 'linkedPlaybookId', label: 'Linked playbook (optional)', type: 'select',
      value: r && r.linkedPlaybookId != null ? String(r.linkedPlaybookId) : '',
      options: [{ value: '', label: '— none —' }, ...playbooks.map((p) => ({ value: String(p.id), label: p.name }))] },
  ];
  openModal(editing ? 'Edit runbook' : 'New runbook', fields, async (v) => {
    const body = { findingType: v.findingType, title: v.title, bodyMarkdown: v.bodyMarkdown, linkedPlaybookId: v.linkedPlaybookId || null };
    await api(editing ? `/api/runbooks/${r.id}` : '/api/runbooks', { method: editing ? 'PUT' : 'POST', body });
    closeModal(); toast('Runbook saved'); render();
  });
  $('#modal-card').classList.add('wide');
}

async function deleteRunbook(r) {
  if (!confirm(`Delete runbook "${r.title}"?`)) return;
  try { await api(`/api/runbooks/${r.id}`, { method: 'DELETE' }); toast('Runbook deleted'); render(); }
  catch (err) { toast(errText(err), true); }
}

async function settingsRetentionView() {
  const data = await api('/api/settings');
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'To keep the database healthy, raw measurements are aggregated into compact buckets after a while and old data is purged. Here you control the windows — changes take effect at the next cleanup, without restart. Unacknowledged CRIT findings are never deleted.'));
  root.append(el('div', { class: 'settings-grid' }, retentionSettingsCard(data.retention)));
  return root;
}

// Generic "edit a few fields + Save" card. fields: { key, label, type:
// 'number'|'checkbox', min, max, step, readonly, hint }. Read-only fields are
// shown (greyed) but never sent; the server validates the rest.
function settingsFormCard({ title, fields, values, endpoint }) {
  const v = values || {};
  const inputs = {};
  const rowEls = [];
  for (const f of fields) {
    let input;
    if (f.type === 'checkbox') {
      input = el('input', { type: 'checkbox' });
      input.checked = v[f.key] === true;
    } else if (f.type === 'select') {
      input = el('select', {}, ...(f.options || []).map(([val, lbl]) => el('option', { value: val }, lbl)));
      input.value = v[f.key] != null ? String(v[f.key]) : '';
    } else {
      input = el('input', { type: 'number', value: String(v[f.key] ?? ''), min: f.min ?? null, max: f.max ?? null, step: f.step ?? null });
    }
    if (f.readonly) input.disabled = true;
    inputs[f.key] = input;
    rowEls.push(el('label', { class: 'set-field' },
      el('span', {}, f.label, f.readonly ? el('span', { class: 'muted small' }, ' · env / restart') : null),
      input, f.hint ? el('span', { class: 'muted small' }, f.hint) : null));
  }
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'small' }, 'Save');
  async function save() {
    err.textContent = ''; btn.disabled = true;
    const body = {};
    for (const f of fields) {
      if (f.readonly) continue;
      if (f.type === 'checkbox') body[f.key] = inputs[f.key].checked;
      else if (f.type === 'select') body[f.key] = inputs[f.key].value;
      else body[f.key] = Number(inputs[f.key].value);
    }
    try { await api(endpoint, { method: 'PUT', body }); toast(`${title} saved`); }
    catch (e2) { err.textContent = errText(e2); }
    finally { btn.disabled = false; }
  }
  btn.addEventListener('click', save);
  return el('div', { class: 'settings-card' }, el('h3', {}, title),
    el('div', { class: 'form-grid' }, ...rowEls, err, el('div', { class: 'form-actions' }, btn)));
}

function analyseSettingsCard(a) {
  return settingsFormCard({
    title: 'Analysis',
    values: a,
    endpoint: '/api/settings/analysis',
    fields: [
      { key: 'analysisEnabled', label: 'Analysis enabled', type: 'checkbox', hint: 'Turns the entire anomaly detection on/off.' },
      { key: 'critSigma', label: 'CRIT threshold (σ from baseline)', type: 'number', min: 0.5, max: 20, step: 0.1, hint: 'How many standard deviations (σ) from normal before a CRIT finding. Higher = only large swings. Typically 4.' },
      { key: 'warnSigma', label: 'WARN threshold (σ from baseline)', type: 'number', min: 0.5, max: 20, step: 0.1, hint: 'Threshold for WARN — should be lower than CRIT. Typically 3.' },
      { key: 'baselineDays', label: 'Baseline window (days)', type: 'number', min: 1, max: 90, step: 1, hint: 'How many days of history the normal is calculated from.' },
      { key: 'minSamples', label: 'Min. samples before alerting', type: 'number', min: 10, max: 100000, step: 1, hint: 'Number of measurements before a metric is monitored — avoids false alarms right after startup.' },
      { key: 'verifySettleMinutes', label: 'Verification settle time (min)', type: 'number', min: 0, max: 1440, step: 1, hint: 'After a playbook is run from an event, how long to wait before re-checking whether the symptoms cleared. Default 5.' },
    ],
  });
}

// AI assistant (opt-in): admin-editable enable flag, PROVIDER, API key, model and
// (for the "Other"/custom provider) endpoint URL — instead of env-only. The key is
// write-only: the API only reports whether one is set (apiKeySet + a masked hint),
// so the field stays blank and a typed value replaces the stored key. The provider
// dropdown is data-driven from the server catalog (a.providers); every option is
// EU-hosted or self-hosted.
function assistantSettingsCard(a) {
  const v = a || { enabled: false, provider: 'mistral', model: '', baseUrl: '', apiKeySet: false, apiKeyHint: '', providers: [] };
  const providers = (Array.isArray(v.providers) && v.providers.length)
    ? v.providers
    : [{ id: 'mistral', label: 'Mistral AI (EU)', defaultModel: 'mistral-small-latest', keyRequired: true, custom: false }];
  const provById = (id) => providers.find((p) => p.id === id) || providers[0];

  const enabledI = el('input', { type: 'checkbox' });
  const providerI = el('select', {});
  providers.forEach((p) => providerI.append(el('option', { value: p.id }, p.label)));
  const modelI = el('input', { type: 'text', placeholder: 'mistral-small-latest' });
  const baseUrlI = el('input', { type: 'text', placeholder: 'https://…/v1/chat/completions' });
  const baseUrlField = el('label', { class: 'set-field' }, el('span', {}, 'Endpoint URL'), baseUrlI,
    el('span', { class: 'muted small' }, 'OpenAI-compatible chat-completions URL for the custom provider (e.g. an Azure or self-hosted deployment).'));
  const keyI = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const clearI = el('input', { type: 'checkbox' });
  const clearRow = el('label', { class: 'inline muted small' }, clearI, el('span', {}, 'Remove the stored key'));
  const note = el('p', { class: 'muted small' });
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'small' }, 'Save');

  function refresh() {
    const p = provById(providerI.value);
    baseUrlField.classList.toggle('hidden', !p.custom);
    modelI.placeholder = p.defaultModel || 'model id';
    if (p.custom) note.textContent = 'Calls your custom OpenAI-compatible endpoint. The key (if any) is encrypted at rest and never shown again. Only metadata summaries are sent — no raw data or payload.';
    else if (!p.keyRequired) note.textContent = `Calls ${p.label}. No API key is needed for a local endpoint.`;
    else if (enabledI.checked && !v.apiKeySet && keyI.value.trim() === '') note.textContent = '⚠ Enabled but no API key set — add one above, or the assistant returns an error.';
    else note.textContent = `Calls ${p.label}. The key is encrypted at rest and never shown again. Only metadata summaries are sent — no raw data or payload.`;
  }

  function applyState(s) {
    enabledI.checked = !!s.enabled;
    if (s.apiKeySet !== undefined) v.apiKeySet = s.apiKeySet;
    providerI.value = providers.some((p) => p.id === s.provider) ? s.provider : providers[0].id;
    const p = provById(providerI.value);
    modelI.value = s.model || '';
    baseUrlI.value = (p.custom && s.baseUrl) ? s.baseUrl : '';
    keyI.value = '';
    keyI.placeholder = v.apiKeySet ? `Key set (${s.apiKeyHint || ''}) — type to replace` : 'Paste an API key to enable';
    clearRow.classList.toggle('hidden', !v.apiKeySet);
    clearI.checked = false;
    refresh();
  }
  applyState(v);

  // Switching provider pre-fills the default model when the field is empty, and
  // shows/hides the custom endpoint field.
  providerI.addEventListener('change', () => {
    const p = provById(providerI.value);
    if (modelI.value.trim() === '' && p.defaultModel) modelI.value = p.defaultModel;
    refresh();
  });
  enabledI.addEventListener('change', refresh);
  keyI.addEventListener('input', refresh);

  async function save() {
    err.textContent = ''; btn.disabled = true;
    const p = provById(providerI.value);
    const body = { enabled: enabledI.checked, provider: providerI.value, model: modelI.value.trim() || (p.defaultModel || '') };
    if (p.custom) body.baseUrl = baseUrlI.value.trim();
    if (clearI.checked) body.clearApiKey = true;
    else if (keyI.value.trim() !== '') body.apiKey = keyI.value.trim();
    try {
      const res = await api('/api/settings/assistant', { method: 'PUT', body });
      applyState(res.assistant || res);
      toast('AI assistant saved');
    } catch (e2) { err.textContent = errText(e2); }
    finally { btn.disabled = false; }
  }
  btn.addEventListener('click', save);

  return el('div', { class: 'settings-card' }, el('h3', {}, 'AI assistant'),
    el('div', { class: 'form-grid' },
      el('label', { class: 'set-field' }, el('span', {}, 'Assistant enabled'), enabledI,
        el('span', { class: 'muted small' }, 'Opt-in natural-language assistant: host Q&A + per-location summaries.')),
      el('label', { class: 'set-field' }, el('span', {}, 'Provider'), providerI,
        el('span', { class: 'muted small' }, 'Which LLM endpoint to call — EU, US or self-hosted, your choice. Region is shown per option; prefer EU/self-hosted if data residency matters.')),
      baseUrlField,
      el('label', { class: 'set-field' }, el('span', {}, 'API key'), keyI,
        el('span', { class: 'muted small' }, 'Provider API key. Write-only — encrypted at rest on the server, never displayed again.')),
      clearRow,
      el('label', { class: 'set-field' }, el('span', {}, 'Model'), modelI,
        el('span', { class: 'muted small' }, 'Provider model id (a per-provider default is used if left blank).')),
      note, err, el('div', { class: 'form-actions' }, btn)));
}

// Read-only placeholder shown instead of the editable AI-assistant card when the
// licence does not include the assistant feature. The PUT is refused server-side
// too — this just explains why the controls are gone rather than looking broken.
function assistantUnlicensedCard(license) {
  return el('div', { class: 'settings-card' }, el('h3', {}, 'AI assistant'),
    el('p', { class: 'muted' }, 'The AI assistant is not included in your licence, so it cannot be enabled here. Contact your provider to add it to your licence.'),
    licenseBadge(license, 'assistant'));
}

function retentionSettingsCard(r) {
  return settingsFormCard({
    title: 'Retention',
    values: r,
    endpoint: '/api/settings/retention',
    fields: [
      { key: 'enabled', label: 'Cleanup enabled', type: 'checkbox', hint: 'Turns automatic aggregation + deletion on/off.' },
      { key: 'rawRetentionDays', label: 'Raw data (days)', type: 'number', min: 1, max: 3650, step: 1, hint: 'Raw measurements older than this are aggregated into compact buckets.' },
      { key: 'rollupRetentionDays', label: 'Aggregated data (days)', type: 'number', min: 1, max: 3650, step: 1, hint: 'Aggregated buckets older than this are deleted.' },
      { key: 'findingRetentionDays', label: 'Findings (days)', type: 'number', min: 1, max: 3650, step: 1, hint: 'Acknowledged findings older than this are deleted (unacknowledged CRIT are always kept).' },
      { key: 'rollupIntervalMinutes', label: 'Bucket size (min)', type: 'number', readonly: true, hint: 'How wide aggregation buckets are. Set via .env (cached at startup).' },
    ],
  });
}

// Settings → Data → Database: read-only status + how-to for the split storage
// backends — MySQL (the always-on primary store) and the OPTIONAL TimescaleDB
// telemetry node. Both connections live in the server's environment, not here: a
// database connection is deploy-time infrastructure (the pg pool is built once
// at boot, and TSDB is provisioned by deploy/install-timescale.sh). This panel
// exists so the "TimescaleDB: not configured" state comes with live status and a
// concrete how-to instead of a dead end. See docs/storage-split-audit.md.
async function settingsDatabaseView() {
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'BlueEyes keeps inventory, users and configuration in MySQL (always on) and can offload high-volume telemetry (traffic, flows, metrics) to a dedicated TimescaleDB node. Both connections are set in the server environment, not here — a database connection is deploy-time infrastructure, so this tab is read-only status plus how to configure it.'));

  let cfg = {}; let storage = {};
  try {
    [cfg, storage] = await Promise.all([api('/api/settings'), api('/system/storage')]);
  } catch (err) {
    root.append(el('div', { class: 'empty error' }, errText(err)));
    return root;
  }
  root.append(el('div', { class: 'settings-grid' },
    mysqlStatusCard(storage.database || {}),
    tsdbStatusCard(cfg.tsdb || {}, storage.tsdb || null)));
  return root;
}

// MySQL — the primary store. Always env-configured; here we only report the live
// size/health (from /system/storage) so the two stores read alike side by side.
function mysqlStatusCard(info) {
  const card = el('div', { class: 'settings-card' }, el('h3', {}, 'MySQL'));
  card.append(el('p', { class: 'muted small' }, 'Primary store — inventory, users, configuration. Configured in the server environment (DB_HOST, DB_USER, …).'));
  if (info && !info.error) {
    card.append(el('div', { class: 'section-head' }, el('span', { class: 'badge active' }, 'Connected ✓')));
    const bits = [];
    if (info.name) bits.push(el('li', {}, el('strong', {}, 'Database: '), el('code', {}, info.name)));
    if (info.totalBytes != null) bits.push(el('li', {}, el('strong', {}, 'Size: '), fmtBytes(info.totalBytes)));
    if (info.tableCount != null) bits.push(el('li', {}, el('strong', {}, 'Tables: '), String(info.tableCount)));
    if (bits.length) card.append(el('ul', {}, ...bits));
  } else {
    card.append(el('div', { class: 'section-head' }, el('span', { class: 'badge bad' }, 'Unavailable')));
    if (info && info.error) card.append(el('p', { class: 'small muted' }, info.error));
  }
  return card;
}

// TimescaleDB — the optional telemetry store. `cfg` is the effective env-driven
// target (from /api/settings, password never included); `live` is the live
// status (from /system/storage): null/`configured:false` when disabled, or
// `{ available, error, totalBytes, hypertableCount, … }` when wired.
function tsdbStatusCard(cfg, live) {
  const card = el('div', { class: 'settings-card' }, el('h3', {}, 'TimescaleDB', el('span', { class: 'muted small' }, ' · telemetry')));

  if (!cfg.enabled) {
    card.append(el('div', { class: 'section-head' }, el('span', { class: 'badge neutral' }, 'Not configured')));
    card.append(el('p', {}, 'The optional telemetry store is disabled — traffic, flows and metrics stay in MySQL. Wire up a TimescaleDB node to offload that high-volume data.'));
  } else if (live && live.available !== false && !live.error) {
    card.append(el('div', { class: 'section-head' }, el('span', { class: 'badge active' }, 'Connected ✓')));
    const bits = [el('li', {}, el('strong', {}, 'Target: '), el('code', {}, `${cfg.host || '?'}:${cfg.port || '?'}`))];
    if (cfg.user) bits.push(el('li', {}, el('strong', {}, 'User: '), el('code', {}, cfg.user)));
    if (live.name || cfg.database) bits.push(el('li', {}, el('strong', {}, 'Database: '), el('code', {}, live.name || cfg.database)));
    if (live.totalBytes != null) bits.push(el('li', {}, el('strong', {}, 'Size: '), fmtBytes(live.totalBytes)));
    if (live.hypertableCount != null) bits.push(el('li', {}, el('strong', {}, 'Hypertables: '), String(live.hypertableCount)));
    card.append(el('ul', {}, ...bits));
  } else {
    // Enabled in env but the node isn't answering — surface the reason.
    card.append(el('div', { class: 'section-head' }, el('span', { class: 'badge bad' }, 'Unavailable')));
    card.append(el('p', {}, 'Enabled in the server environment, but the telemetry node isn\'t reachable.'));
    const bits = [el('li', {}, el('strong', {}, 'Target: '), el('code', {}, `${cfg.host || '?'}:${cfg.port || '?'}`))];
    if (live && live.error) bits.push(el('li', {}, el('strong', {}, 'Error: '), live.error));
    card.append(el('ul', {}, ...bits));
  }

  // The how-to is shown in every state (folded) so the tab is self-documenting.
  const guide = el('details', { class: 'settings-help' },
    el('summary', { class: 'muted' }, cfg.enabled ? 'How TimescaleDB is configured' : 'How to configure TimescaleDB'),
    el('ol', {},
      el('li', {}, 'Provision a dedicated telemetry node with ', el('code', {}, 'deploy/install-timescale.sh'), ' (installs PostgreSQL + TimescaleDB, applies the schema, sets up backups). See ', el('code', {}, 'deploy/README-timescale.md'), '.'),
      el('li', {}, 'Point the server at it via environment variables and restart:',
        el('pre', { class: 'settings-env' },
          'TSDB_ENABLED=true\n'
          + 'TSDB_HOST=<telemetry-node-ip>\n'
          + 'TSDB_PASSWORD=<the blueeye_tsdb password>\n'
          + '# TSDB_PORT / TSDB_USER / TSDB_NAME default to 5432 / blueeye_tsdb / blueeye_telemetry')),
      el('li', {}, 'Once connected, ', el('code', {}, 'GET /health'), ' pings the telemetry node too, and the live size appears here and on the Server-storage card.')),
    el('p', { class: 'muted small' }, 'The connection (including the password) is set in the server environment, never in the database — so it is read-only here.'));
  card.append(guide);
  return card;
}

async function settingsMapView() {
  const data = await api('/api/settings');
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'The maps (Sites, Destinations and the location picker) fetch background tiles from the tile URL, and address search uses the geocoder URL. Use an EU/self-hosted source in production — no hardcoded US service. Stored in the database and works without restart.'));
  root.append(el('div', { class: 'settings-grid' }, mapSettingsCard(data.map), geoipSettingsCard(data.geoip)));
  return root;
}

async function settingsTypesView() {
  const data = await api('/api/settings');
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'Group traffic by ', el('b', {}, 'port'), ' (e.g. DNS = 53) or destination ', el('b', {}, 'ASN'), ' (e.g. Facebook/Meta = 32934). Types appear as toggle-on/off series on the Traffic page under “Traffic type”. Port types are precise; ASN types are approximate (CDN/cloud can blur). Requires a NetFlow/sFlow source (ports) or geo data (ASN).'));
  root.append(el('div', { class: 'settings-grid' }, flowCategoriesCard(data.flowCategories || [])));
  return root;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

// Editor for the traffic-type categories. Each row is a name + a kind (port or
// ASN) + a free-text list of numbers; the server validates on save.
function flowCategoriesCard(categories) {
  const card = el('div', { class: 'settings-card wide' }, el('h3', {}, 'Traffic types'));
  card.append(el('p', { class: 'muted small' }, 'Port types are precise (port 53 = DNS). ASN types are approximate — CDN/cloud can blur, and one ASN covers several services. Changes take effect without restart.'));
  const head = el('div', { class: 'tc-row tc-head muted' }, el('span', {}, 'Name'), el('span', {}, 'Kind'), el('span', {}, 'Ports / ASN numbers (comma-separated)'), el('span', {}));
  const listEl = el('div', { class: 'tc-list' });
  const err = el('p', { class: 'error' });
  const rows = [];

  function makeRow(cat = {}) {
    const id = cat.id || '';
    const label = el('input', { type: 'text', value: cat.label || '', placeholder: 'e.g. DNS' });
    const kind = el('select', {}, el('option', { value: 'port' }, 'Port'), el('option', { value: 'asn' }, 'Organisation (ASN)'));
    kind.value = cat.kind === 'asn' ? 'asn' : 'port';
    const nums = el('input', { type: 'text', value: ((cat.kind === 'asn' ? cat.asns : cat.ports) || []).join(', ') });
    const setPh = () => { nums.placeholder = kind.value === 'asn' ? 'fx 32934, 54115' : 'fx 53, 853'; };
    setPh();
    kind.addEventListener('change', setPh);
    const ctrl = { id, label, kind, nums };
    const del = el('button', { class: 'small ghost danger', title: 'Remove', onclick: () => { const i = rows.indexOf(ctrl); if (i >= 0) rows.splice(i, 1); node.remove(); } }, '×');
    const node = el('div', { class: 'tc-row' }, label, kind, nums, del);
    ctrl.node = node;
    rows.push(ctrl);
    listEl.append(node);
    return ctrl;
  }

  for (const c of categories) makeRow(c);
  if (!categories.length) makeRow();

  const addBtn = el('button', { class: 'small ghost', onclick: () => makeRow() }, '+ Add type');
  const resetBtn = el('button', { class: 'small ghost' }, 'Reset to defaults');
  const saveBtn = el('button', { class: 'small' }, 'Save traffic types');

  async function save() {
    err.textContent = '';
    const seen = new Set();
    const out = [];
    for (const ctrl of rows) {
      const lbl = ctrl.label.value.trim();
      const list = ctrl.nums.value.split(/[\s,]+/).filter(Boolean).map(Number);
      if (!lbl && !list.length) continue; // skip empty rows
      let cid = ctrl.id || slugify(lbl) || 'type';
      let n = 2;
      const base = cid;
      while (seen.has(cid)) cid = `${base}-${n++}`;
      seen.add(cid);
      const item = { id: cid, label: lbl, kind: ctrl.kind.value };
      if (ctrl.kind.value === 'asn') item.asns = list; else item.ports = list;
      out.push(item);
    }
    saveBtn.disabled = true;
    try {
      await api('/api/settings/flow-categories', { method: 'PUT', body: { categories: out } });
      toast('Traffic types saved');
      render();
    } catch (e2) {
      err.textContent = errText(e2);
    } finally { saveBtn.disabled = false; }
  }
  async function reset() {
    if (!confirm('Reset traffic types to the default list?')) return;
    try { await api('/api/settings/flow-categories', { method: 'PUT', body: { reset: true } }); toast('Reset to defaults'); render(); }
    catch (e2) { err.textContent = e2.message; }
  }
  saveBtn.addEventListener('click', save);
  resetBtn.addEventListener('click', reset);

  card.append(head, listEl, el('div', { class: 'form-actions' }, addBtn, el('span', { class: 'spacer' }), resetBtn, saveBtn), err);
  return card;
}
function settingsCard(title, ...body) { return el('div', { class: 'settings-card' }, el('h3', {}, title), ...body); }

// Shared placeholder for a settings tab whose licence feature isn't included —
// the server refuses the API too (403 feature_not_available), so this explains
// the missing controls and points at the matrix.
function featureUpsell(title, message) {
  return el('div', {}, el('div', { class: 'settings-grid' },
    el('div', { class: 'settings-card' }, el('h3', {}, title),
      el('p', { class: 'muted' }, message, ' ', settingsLink('license', 'See Settings → License'), ' for the full feature matrix.'),
      el('span', { class: 'badge offline' }, 'Not included in your plan'))));
}

// One-shot holder for a freshly minted API token, shown once after creation
// (the server never returns the plaintext again).
let apiTokenJustCreated = null;

// Settings → API tokens: mint/list/revoke programmatic tokens (licence feature
// api_access, Professional+). Admin-only. The secret is shown exactly once.
async function settingsApiTokensView() {
  const root = el('div');
  let tokens;
  try {
    tokens = await api('/api/api-tokens');
  } catch (err) {
    if (err.status === 403) return featureUpsell('API access', 'Programmatic API tokens are part of the BlueEyes Professional plan and above, so they can’t be managed here.');
    throw err;
  }

  root.append(el('p', { class: 'muted settings-intro' },
    'Issue tokens for programmatic access to the BlueEyes API (CI jobs, scripts, integrations). A token authenticates with a fixed role and is sent as ',
    el('code', {}, 'Authorization: Bearer <token>'), ' or ', el('code', {}, 'X-API-Key: <token>'), '. The secret is shown only once, on creation.'));

  // Banner with the just-created secret (cleared on the next render).
  if (apiTokenJustCreated) {
    const secret = apiTokenJustCreated;
    apiTokenJustCreated = null;
    root.append(el('div', { class: 'settings-card', style: 'border-color: var(--ok)' },
      el('h3', {}, 'New API token — copy it now'),
      el('p', { class: 'muted' }, 'This is the only time the token is shown. Store it securely; it cannot be retrieved again.'),
      el('pre', { class: 'token-secret', style: 'white-space: pre-wrap; word-break: break-all;' }, secret),
      el('button', { class: 'small', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(secret); toast('Token copied'); } }, 'Copy')));
  }

  // Create form.
  const nameInput = el('input', { type: 'text', placeholder: 'e.g. CI pipeline', maxlength: '120' });
  const roleSelect = el('select', {}, ...['viewer', 'operator', 'admin'].map((r) => el('option', { value: r }, r)));
  const expInput = el('input', { type: 'date' });
  const createBtn = el('button', { class: 'small', onclick: async () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Name is required', true); return; }
    const bodyReq = { name, role: roleSelect.value };
    if (expInput.value) bodyReq.expiresAt = new Date(`${expInput.value}T00:00:00Z`).toISOString();
    try {
      const created = await api('/api/api-tokens', { method: 'POST', body: bodyReq });
      apiTokenJustCreated = created.token;
      toast('API token created');
      render();
    } catch (err) { toast(err.message, true); }
  } }, 'Create token');
  root.append(settingsCard('Create a token',
    el('div', { class: 'form-row' }, el('label', {}, 'Name', nameInput)),
    el('div', { class: 'form-row' }, el('label', {}, 'Role', roleSelect)),
    el('div', { class: 'form-row' }, el('label', {}, 'Expires (optional)', expInput)),
    createBtn));

  // Existing tokens.
  const rows = (tokens || []).map((t) => el('tr', { class: t.revoked ? 'muted' : '' },
    el('td', {}, t.name),
    el('td', {}, el('code', {}, t.token_prefix + '…')),
    el('td', {}, el('span', { class: `badge role-${t.role}` }, t.role)),
    el('td', {}, fmtDate(t.created_at)),
    el('td', {}, t.last_used_at ? fmtDate(t.last_used_at) : '–'),
    el('td', {}, t.expires_at ? fmtDate(t.expires_at) : 'never'),
    el('td', {}, t.revoked
      ? el('span', { class: 'badge revoked' }, 'revoked')
      : el('button', { class: 'small danger', onclick: async () => {
          if (!confirm(`Revoke token "${t.name}"? Any client using it will stop working.`)) return;
          try { await api(`/api/api-tokens/${t.id}`, { method: 'DELETE' }); toast('Token revoked'); render(); }
          catch (err) { toast(err.message, true); }
        } }, 'Revoke'))));
  root.append(settingsCard('Tokens',
    tokens && tokens.length
      ? el('div', { class: 'tablewrap' }, el('table', {},
          el('thead', {}, el('tr', {}, ...['Name', 'Prefix', 'Role', 'Created', 'Last used', 'Expires', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...rows)))
      : el('p', { class: 'muted' }, 'No API tokens yet.')));
  return root;
}

function boolText(v) { return v === true ? 'yes' : v === false ? 'no' : String(v ?? '–'); }
function kvList(obj, labels) {
  if (!obj) return el('p', { class: 'muted' }, '–');
  const rows = Object.entries(labels).map(([k, label]) => el('tr', {}, el('td', { class: 'muted' }, label), el('td', {}, boolText(obj[k]))));
  return el('table', { class: 'kv' }, el('tbody', {}, ...rows));
}
function featureBadges(features) {
  if (!features) return el('p', { class: 'muted' }, '–');
  return el('div', { class: 'badges' }, ...['analysis', 'assistant', 'alerting', 'geo'].map((f) =>
    el('span', { class: `badge ${features[f] ? 'active' : 'offline'}` }, `${f}: ${features[f] ? 'yes' : 'no'}`)));
}
function mapSettingsCard(map) {
  const m = map || {};
  const url = el('input', { type: 'text', value: m.tileUrl || '' });
  const attr = el('input', { type: 'text', value: m.attribution || '' });
  const zoom = el('input', { type: 'number', value: String(m.maxZoom ?? 19), min: '1', max: '22' });
  const geo = el('input', { type: 'text', value: m.geocodeUrl || '' });
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'small' }, 'Save map settings');
  async function save() {
    err.textContent = ''; btn.disabled = true;
    try {
      await api('/api/settings/map', { method: 'PUT', body: { tileUrl: url.value.trim(), attribution: attr.value.trim(), maxZoom: Number(zoom.value), geocodeUrl: geo.value.trim() } });
      toast('Map settings saved');
    } catch (e2) {
      err.textContent = errText(e2);
    } finally { btn.disabled = false; }
  }
  btn.addEventListener('click', save);
  return el('div', { class: 'settings-card' }, el('h3', {}, 'Map (tiles + geocoder)'),
    el('div', { class: 'form-grid' },
      el('label', {}, 'Tile-URL ({z}/{x}/{y})', url),
      el('label', {}, 'Attribution', attr),
      el('label', {}, 'Max zoom', zoom),
      el('label', {}, 'Geocoder URL (address search)', geo),
      err, el('div', { class: 'form-actions' }, btn)));
}

// Settings → Map: the offline GeoIP/ASN range database (admin). It places public
// destination/hop IPs by country; without it the maps show only sites. We store
// just a server-side path (the DB is a large file) and reload it live — the
// response says how many ranges loaded so a wrong path shows as 0, not a silent
// no-op. Build the CSV with scripts/build-geoip.js (see docs/geo.md).
function geoipSettingsCard(geoip) {
  const path = el('input', { type: 'text', value: (geoip && geoip.dbPath) || '', placeholder: '/data/geoip.csv' });
  const err = el('p', { class: 'error' });
  const status = el('p', { class: 'muted small' });
  const built = el('p', { class: 'muted small' });
  const btn = el('button', { class: 'small' }, 'Save & reload');
  const updateBtn = el('button', { class: 'small' }, 'Update now (download latest)');
  const autoChk = el('input', { type: 'checkbox' });
  if (geoip && geoip.autoUpdate) autoChk.checked = true;

  function renderStatus(s) {
    const ok = s && s.configured;
    status.replaceChildren(
      el('span', ok ? { style: 'color:var(--ok);font-weight:600' } : { class: 'warn-text' },
        ok ? `Loaded ${s.ranges} IP range${s.ranges === 1 ? '' : 's'}` : 'Not configured — geo enrichment disabled'),
      s && s.source ? el('span', { class: 'muted' }, ` · source: ${s.source}`) : null,
      s && s.error ? el('span', { class: 'warn-text' }, ` · ${s.error}`) : null);
    const b = s && s.lastBuild;
    built.textContent = b ? `Last downloaded: ${b.month || '?'} · ${b.ranges} ranges · ${fmtDate(b.builtAt)}` : '';
    if (s && typeof s.dbPath === 'string' && s.dbPath !== path.value) path.value = s.dbPath;
  }
  renderStatus(geoip);

  async function save() {
    err.textContent = ''; btn.disabled = true;
    try {
      const res = await api('/api/settings/geoip', { method: 'PUT', body: { dbPath: path.value.trim() } });
      renderStatus(res.geoip);
      toast(res.geoip && res.geoip.configured ? `GeoIP loaded — ${res.geoip.ranges} ranges` : 'Saved, but no ranges loaded — check the path and CSV format.', !(res.geoip && res.geoip.configured));
    } catch (e2) { err.textContent = errText(e2); } finally { btn.disabled = false; }
  }

  // Kicks off the server-side download+build, then polls the job until it settles
  // (it writes into the server's own /data volume, so no host path is needed).
  let polling = null;
  async function refreshGeoip() { try { const d = await api('/api/settings'); renderStatus(d.geoip); } catch { /* ignore */ } }
  function setUpdating(on) { updateBtn.disabled = on; updateBtn.textContent = on ? 'Downloading + building…' : 'Update now (download latest)'; }
  async function pollUpdate() {
    try {
      const { update: u } = await api('/api/settings/geoip/update');
      if (u.state === 'running') return; // keep polling
      clearInterval(polling); polling = null; setUpdating(false);
      if (u.state === 'ok') { await refreshGeoip(); toast(`GeoIP updated to ${u.month} — ${u.ranges} ranges`); }
      else if (u.state === 'error') { err.textContent = `Update failed: ${u.error || 'unknown error'}`; toast('GeoIP update failed', true); }
    } catch (e2) { clearInterval(polling); polling = null; setUpdating(false); err.textContent = errText(e2); }
  }
  async function updateNow() {
    err.textContent = ''; setUpdating(true);
    try {
      await api('/api/settings/geoip/update', { method: 'POST', body: {} });
      if (!polling) polling = setInterval(pollUpdate, 2000);
    } catch (e2) { setUpdating(false); err.textContent = errText(e2); }
  }
  async function toggleAuto() {
    try { await api('/api/settings/geoip', { method: 'PUT', body: { autoUpdate: autoChk.checked } }); toast(autoChk.checked ? 'Monthly auto-update on' : 'Monthly auto-update off'); }
    catch (e2) { autoChk.checked = !autoChk.checked; toast(errText(e2), true); }
  }

  btn.addEventListener('click', save);
  updateBtn.addEventListener('click', updateNow);
  autoChk.addEventListener('change', toggleAuto);

  return el('div', { class: 'settings-card' }, el('h3', {}, 'GeoIP database (country + ASN)'),
    el('p', { class: 'muted small' }, 'Offline, EU-sourced IP→country/ASN range CSV used to place external destinations and traceroute hops on the maps. Without it the maps show only your sites. ', el('strong', {}, '“Update now”'), ' downloads the latest DB-IP Lite release (db-ip.com, CC-BY) and builds it on the server — no host file needed. Or point the path at a file you built with scripts/build-geoip.js. Reloads live, no restart. See docs/geo.md.'),
    el('div', { class: 'form-grid' },
      el('label', {}, 'GeoIP CSV path (server-side file)', path),
      status, built, err,
      el('label', { class: 'inline' }, autoChk, ' Auto-update monthly (the server fetches a fresh DB-IP release; needs outbound internet)'),
      el('div', { class: 'form-actions' }, btn, updateBtn)));
}

views.users = async () => {
  const [users, avail] = await Promise.all([
    api('/users'),
    api('/users/local-availability').catch(() => ({ available: false, ssoActive: false, mailerReady: false })),
  ]);
  const root = el('div');
  const headBtns = [el('button', { class: 'small', onclick: () => editUser() }, '+ New user')];
  // Local user creation with a one-time password — only offered when no SSO/LDAP
  // is active. The server enforces the same rule (403); this just hides the UI.
  if (avail.available) {
    headBtns.unshift(el('button', { class: 'small', onclick: () => createLocalUser() }, '+ Invite user (one-time password)'));
  }
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Users'), ...headBtns));
  root.append(el('p', { class: 'muted' }, ['Roles: viewer (read), operator (create/edit), admin (all). Only admins see this tab. A name is optional and display-only — it is what ', viewLink('userLogs', 'User Logs'), ' shows next to each action instead of an email address.']));
  if (!avail.available && avail.ssoActive) {
    root.append(el('p', { class: 'muted' }, 'Local user invitations are disabled while SSO/LDAP is active — manage users in your directory.'));
  } else if (!avail.available && !avail.mailerReady) {
    root.append(el('p', { class: 'muted' }, ['One-time-password invitations need SMTP configured in ', settingsLink('alerting', 'Settings → Alerting'), '.']));
  }
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Name', 'Email', 'Role', 'Status', 'Created', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...users.map((u) => el('tr', {},
      el('td', {}, String(u.id)),
      // The name is display only — the email stays the identity. It is what
      // User Logs shows next to an action, so an unnamed account is worth
      // pointing out here rather than leaving blank.
      el('td', {}, u.name || el('span', { class: 'muted' }, '—')),
      el('td', {}, u.email),
      el('td', {}, el('span', { class: 'badge' }, u.role),
        u.protected ? el('span', { class: 'badge', title: 'Superadmin — cannot be changed/deleted, password only', style: 'margin-left:6px' }, 'superadmin') : null),
      el('td', {}, u.must_change_password
        ? el('span', { class: 'badge', title: u.temp_password_expires_at ? `One-time password expires ${fmtDate(u.temp_password_expires_at)}` : 'Awaiting first password change' }, 'pending first login')
        : el('span', { class: 'badge active', title: 'Account active — first-login password change completed' }, 'Active')),
      el('td', { class: 'muted' }, fmtDate(u.created_at)),
      el('td', {}, el('div', { class: 'row-actions' },
        (avail.available && u.must_change_password)
          ? el('button', { class: 'small ghost', title: 'Generate and email a new one-time password', onclick: () => resendTempPassword(u) }, 'Resend password')
          : null,
        el('button', { class: 'small ghost', onclick: () => editUser(u) }, u.protected ? 'Change password' : 'Edit'),
        u.protected ? null : el('button', { class: 'small danger', onclick: () => deleteUser(u) }, 'Delete'))),
    )))));
  return root;
};

// Invite a local user: the server generates a one-time password and emails it;
// the user must change it on first login. No password field here.
function createLocalUser() {
  openModal('Invite user (one-time password)', [
    { name: 'email', label: 'Email', type: 'email', value: '' },
    { name: 'name', label: 'Name (optional)', type: 'text', optional: true, value: '' },
    { name: 'role', label: 'Role', type: 'select', value: 'viewer', options: ROLE_OPTIONS },
  ], async (v) => {
    if (!v.email) throw new Error('Enter an email address');
    await api('/users/local', { method: 'POST', body: { email: v.email, name: v.name || undefined, role: v.role } });
    closeModal();
    toast('Invitation sent — a one-time password was emailed');
    render();
  });
}

async function resendTempPassword(u) {
  if (!confirm(`Email a new one-time password to ${u.email}? Any current one-time password stops working.`)) return;
  try { await api(`/users/${u.id}/resend-temp-password`, { method: 'POST', body: {} }); toast('New one-time password emailed'); render(); }
  catch (err) { toast(err.message, true); }
}

const ROLE_OPTIONS = ['viewer', 'operator', 'admin'].map((r) => ({ value: r, label: r }));

function editUser(u) {
  if (u && u.protected) {
    // Super-admin: only a password reset is allowed.
    openModal(`Change password — ${u.email}`, [
      { name: 'password', label: 'New password', type: 'password-strength', value: '' },
    ], async (v) => {
      if (!v.password) throw new Error('Enter a new password');
      if (!evaluatePassword(v.password).meetsPolicy) throw new Error('Password does not meet the requirements below');
      await api(`/users/${u.id}`, { method: 'PUT', body: { role: 'admin', password: v.password } });
      closeModal(); toast('Password changed'); render();
    });
  } else if (u) {
    // Update: email, role + optional password reset.
    openModal(`Edit ${u.email}`, [
      { name: 'email', label: 'Email', type: 'email', value: u.email },
      { name: 'name', label: 'Name (optional — shown in User Logs)', type: 'text', optional: true, value: u.name || '' },
      { name: 'role', label: 'Role', type: 'select', value: u.role, options: ROLE_OPTIONS },
      { name: 'password', label: 'New password (optional — leave blank to keep)', type: 'password-strength', optional: true, value: '' },
    ], async (v) => {
      // '' is sent as null on purpose: clearing the field clears the name.
      const body = { email: v.email, role: v.role, name: v.name ? v.name : null };
      if (v.password) {
        if (!evaluatePassword(v.password).meetsPolicy) throw new Error('Password does not meet the requirements below');
        body.password = v.password;
      }
      await api(`/users/${u.id}`, { method: 'PUT', body });
      closeModal(); toast('User updated'); render();
    });
  } else {
    openModal('New user', [
      { name: 'email', label: 'Email', type: 'email', value: '' },
      { name: 'name', label: 'Name (optional — shown in User Logs)', type: 'text', optional: true, value: '' },
      { name: 'password', label: 'Password', type: 'password-strength', value: '' },
      { name: 'role', label: 'Role', type: 'select', value: 'viewer', options: ROLE_OPTIONS },
    ], async (v) => {
      if (!evaluatePassword(v.password).meetsPolicy) throw new Error('Password does not meet the requirements below');
      await api('/users', { method: 'POST', body: { email: v.email, name: v.name || undefined, password: v.password, role: v.role } });
      closeModal(); toast('User created'); render();
    });
  }
}
async function deleteUser(u) {
  if (!confirm(`Delete user ${u.email}?`)) return;
  try { await api(`/users/${u.id}`, { method: 'DELETE' }); toast('Deleted'); render(); }
  catch (err) { toast(err.message, true); }
}

// Formats a plan limit for display: null/undefined means "unlimited".
const fmtLimit = (v) => (v === null || v === undefined ? 'Unlimited' : String(v));
// "used / max (pct%)" plus a usage bar; unlimited limits show just the count.
function limitStat(label, used, max) {
  if (max === null || max === undefined) return stat(label, `${used} / ∞`);
  const pct = max > 0 ? Math.round((used / max) * 100) : 0;
  return stat(label, el('div', {}, el('div', {}, `${used} / ${max} (${pct}%)`), usageBar(pct)));
}

// Human labels for the licence status badge (the raw status still drives the
// badge colour via its CSS class). 'expired' reads as a clear, distinct state
// rather than the catch-all 'invalid'.
const LICENSE_STATUS_LABELS = {
  valid: 'Valid',
  grace: 'Valid (grace)',
  expired: 'License expired',
  not_yet_valid: 'Not yet valid',
  invalid: 'Invalid',
  unlicensed: 'Unlicensed',
  unknown: 'Unknown',
};
const licenseStatusLabel = (status) => LICENSE_STATUS_LABELS[status] || status;

views.license = async () => {
  const s = await api('/license/status');
  // Plan / usage / matrix are best-effort — a server without the plan layer (or
  // a 503) must still render the classic status block.
  let plan = null;
  let usage = null;
  let matrix = null;
  try { plan = await api('/license/plan'); } catch { /* optional */ }
  try { usage = await api('/license/usage'); } catch { /* optional */ }
  try { matrix = await api('/license/matrix'); } catch { /* optional */ }

  const root = el('div');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'License status'),
    canWrite() ? el('button', { class: 'small', onclick: refreshLicense }, 'Re-validate now') : null));
  // A misconfigured trust anchor makes every proof fail signature verification
  // (reason: 'invalid_signature') the same way a genuinely bad proof would —
  // "Re-validate now" then keeps returning 200 while silently sitting on
  // whatever was last cached, which looks like "revalidation doesn't pick up
  // license changes" rather than "verifying against the wrong public key".
  // Say so plainly instead of letting that look like a stuck refresh.
  const trust = s.publicKeyTrust;
  if (trust && (trust.source === 'blocked' || !trust.configured)) {
    root.append(el('div', { class: 'alert-banner sev-WARN' },
      el('span', { class: 'alert-ic' }, '⚠'),
      el('span', {},
        el('strong', {}, 'License verification is misconfigured. '),
        !trust.configured
          ? 'The embedded public key in src/license/publicKey.js is still the placeholder — no proof can ever verify, so "Re-validate now" will never reflect changes made on the license server. '
          : 'LICENSE_PUBLIC_KEY is set but ignored in production (no TRUST_ANCHOR_OVERRIDE_ACK) — verification falls back to the embedded key instead. ',
        'See docs/licensing.md.')));
  }
  // Offline mode reports a different evidence trail (a local signed file with a
  // validity window) instead of the online grace window.
  const offline = s.mode === 'offline';
  // The licence's own expiry, shown for both modes. null = perpetual / none.
  const expiryText = s.validUntil ? fmtDate(s.validUntil) : (s.licensed ? 'No expiry' : '–');
  root.append(el('div', { class: 'cards' },
    stat('Status', el('span', { class: `badge ${s.status}` }, licenseStatusLabel(s.status))),
    stat('Licensed', s.licensed ? 'Yes' : 'No'),
    plan ? stat('Plan', `BlueEyes ${plan.plan_name}`) : stat('Max. agents', String(s.maxAgents)),
    offline ? stat('Validation', 'Offline (local file)') : stat('Server ID', s.serverId || '–'),
    stat('Last validated', fmtDate(s.verifiedAt)),
    stat('License expires', expiryText),
    // Grace is an online-only concept (running on a cached proof while offline).
    offline ? null : stat('Grace expires', fmtDate(s.graceUntil)),
  ));
  if (offline && s.organizationId) root.append(el('p', { class: 'muted' }, `Organization: ${s.organizationId}`));
  if (offline && !s.licensed) root.append(el('p', { class: 'muted' }, 'Restricted mode — the local licence is missing, expired or invalid. Install a valid licence file and press "Re-validate now".'));
  if (s.reason) root.append(el('p', { class: 'muted' }, `Note: ${s.reason}`));

  // ---- License overview (active plan limits + support) --------------------
  if (plan) {
    root.append(el('h3', {}, 'Plan overview'));
    root.append(el('div', { class: 'cards' },
      stat('Plan', `BlueEyes ${plan.plan_name}${plan.is_trial ? ' (trial)' : ''}`),
      stat('Support level', plan.support_level),
      stat('Max. agents', fmtLimit(plan.limits.max_agents)),
      stat('Max. active test paths', fmtLimit(plan.limits.max_test_paths)),
      stat('History retention', plan.limits.history_days === null ? 'Unlimited' : `${plan.limits.history_days} days`),
    ));
  }

  // ---- Usage overview -----------------------------------------------------
  if (usage) {
    root.append(el('h3', {}, 'Usage'));
    root.append(el('div', { class: 'cards' },
      limitStat('Agents', usage.agents.used, usage.agents.max),
      limitStat('Active test paths', usage.test_paths.used, usage.test_paths.max),
      stat('History limit', usage.history_days === null ? 'Unlimited' : `${usage.history_days} days`),
      stat('Last validation', fmtDate(usage.lastValidation)),
    ));
  }

  // ---- Feature matrix (active plan + upgrade hints) -----------------------
  if (matrix) {
    root.append(el('h3', {}, 'Feature matrix'));
    const active = matrix.activePlan;
    const head = el('tr', {}, el('th', {}, 'Feature'),
      ...matrix.plans.map((p) => el('th', { class: p.plan_key === active ? 'active' : '' }, p.plan_name)));
    const body = matrix.features.map((f) => {
      const roadmap = f.status === 'roadmap';
      const cells = matrix.plans.map((p) => {
        const on = p.features[f.key];
        // A roadmap feature is priced into the plan but not built yet: show
        // "Roadmap" where the tier would include it, never a tick.
        const mark = on ? (roadmap ? el('span', { class: 'badge roadmap' }, 'Roadmap') : '✓') : '–';
        return el('td', { class: p.plan_key === active ? 'active' : '' }, mark);
      });
      const activePlan = matrix.plans.find((p) => p.plan_key === active);
      const entitled = activePlan && activePlan.features[f.key];
      const label = roadmap
        ? el('td', {}, f.label, ' ', el('span', { class: 'badge roadmap' }, 'Roadmap'))
        : el('td', {}, f.label);
      return el('tr', { class: (entitled && !roadmap) ? '' : 'muted' }, label, ...cells);
    });
    root.append(el('div', { class: 'tablewrap' },
      el('table', { class: 'matrix' }, el('thead', {}, head), el('tbody', {}, ...body))));
    root.append(el('p', { class: 'muted' }, 'Features not included in your plan are greyed out — contact your administrator or upgrade the licence to enable them. Rows marked ', el('span', { class: 'badge roadmap' }, 'Roadmap'), ' are planned and not available yet (tracked in ROADMAP.md).'));
  }

  root.append(el('p', { class: 'muted' }, 'License renewal is done with the provider. Once renewed, press "Re-validate now" to fetch the updated status immediately (otherwise it is checked automatically every 6 hours).'));
  return root;
};

async function refreshLicense() {
  try {
    const s = await api('/license/refresh', { method: 'POST' });
    invalidateFeatures(); // entitlements may have changed — refresh module visibility now
    toast(`Re-validated: ${s.status}`);
    render();
  } catch (err) { toast(err.message, true); }
}
function stat(k, v) {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

// ---- Render ---------------------------------------------------------------
// ---- Live findings (WebSocket) --------------------------------------------
// Subscribes to the server's dashboard channel and surfaces findings as they
// happen. Idempotent connect; auto-reconnects while logged in.
let liveWs = null;
let liveReconnect = null;
// Consecutive attempts that never reached an open socket. Reset on a successful
// connect, and used both to back off and to decide when to question the session.
let liveAttempts = 0;

// Schedules the next attempt with exponential backoff, capped at a minute. A
// fixed short retry is wrong for the two things that actually happen: a server
// that is down stays down for longer than four seconds, and a refused upgrade
// costs the server a handshake every time.
function scheduleLive() {
  if (!token || liveReconnect) return;
  const delay = Math.min(4000 * (2 ** Math.max(0, liveAttempts - 1)), 60000);
  liveReconnect = setTimeout(() => { liveReconnect = null; connectLive(); }, delay);
}

function connectLive() {
  if (!token) return;
  if (liveWs && (liveWs.readyState === WebSocket.OPEN || liveWs.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let sock;
  try { sock = new WebSocket(`${proto}://${location.host}/ws/dashboard?token=${encodeURIComponent(token)}`); }
  catch { return; }
  liveWs = sock;
  // Whether THIS socket ever opened. A socket that closes without opening means
  // the upgrade was refused rather than a live connection dropping — and the
  // browser cannot tell us which, since a rejected upgrade surfaces only as a
  // generic "can't establish a connection".
  let opened = false;
  sock.addEventListener('open', () => { opened = true; liveAttempts = 0; });
  sock.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;
    if (msg.type === 'finding') onLiveFinding(msg.payload);
    else if (msg.type === 'agent-enrolled') onAgentEvent('enrolled', msg.payload);
    else if (msg.type === 'agent-status') onAgentEvent(msg.payload && msg.payload.status, msg.payload);
    else if (msg.type === 'event_cluster') onEventCluster(msg.payload);
    // A burst sample, as it happens. Delivered to whoever is watching the
    // chart right now; nobody watching means the frame is simply dropped —
    // the authoritative series arrives with the finished run.
    else if (msg.type === 'burst-sample' && burstWatcher) burstWatcher(msg.payload);
  });
  sock.addEventListener('close', () => {
    liveWs = null;
    if (!token || liveReconnect) return;

    // An expired token is the commonest reason an upgrade is refused: the server
    // answers 401 and destroys the socket (src/ws/dashboardSocket.js). Retrying
    // that on a timer never succeeds — it just hammers the server and fills the
    // console with errors that look like a proxy or network fault, which is
    // exactly the wrong place to send someone looking.
    //
    // So after a few refusals, ask the REST API who we are. api() runs the
    // shared logout() on a 401, which clears `token` — so a dead session ends
    // here with the same "Session expired" path every other call uses, instead
    // of reconnecting forever.
    if (!opened && ++liveAttempts >= 3) {
      api('/me')
        .then(() => { liveAttempts = 0; scheduleLive(); })
        .catch(() => { if (token) scheduleLive(); });
      return;
    }
    scheduleLive();
  });
  sock.addEventListener('error', () => { try { sock.close(); } catch { /* ignore */ } });
}
function disconnectLive() {
  if (liveReconnect) { clearTimeout(liveReconnect); liveReconnect = null; }
  if (liveWs) { try { liveWs.close(); } catch { /* ignore */ } liveWs = null; }
  liveAttempts = 0;
}
// Live agent enrollment / online-status events. Surfaces a toast, and (when the
// enrollment wizard is showing a fresh code) flips its "Waiting for agent…" panel.
function onAgentEvent(kind, payload) {
  if (kind === 'enrolled') toast(`New agent connected${payload && payload.hostname ? ': ' + payload.hostname : ''}`);
  if (currentView === 'enrollment' && typeof enrollWatch === 'function') enrollWatch(kind, payload);
}

// Live cross-agent cluster events (open/updated/resolved). Toast, and when the
// Situations list is on screen, refresh it so the new/updated cluster shows;
// otherwise the next REST fetch will pick it up.
function onEventCluster(c) {
  if (!c) return;
  if (c.status === 'resolved') toast('Situation resolved');
  else toast(`Cross-agent situation ${c.updated ? 'updated' : 'detected'}${c.confidence ? ` (${c.confidence} confidence)` : ''}`, c.confidence === 'high');
  if (currentView === 'clusters') render(true);
}

function onLiveFinding(f) {
  if (!f) return;
  const sev = f.severity || 'INFO';
  toast(`New finding: ${f.metric} ${sev}`, sev === 'CRIT' || sev === 'WARN');
  // Hand it to the Analysis screen when that screen is the one on display. The
  // view decides whether the row passes the active filters and re-reads the
  // totals either way — they move whether or not the row is shown.
  if (currentView === 'findings' && onLiveFindingRow) onLiveFindingRow(f);
}

// ---- NIS2 Reporting Center ------------------------------------------------
// A self-contained compliance module: readiness dashboard, risk register,
// control evidence, security events, generated management reports and an
// audit trail. Talks to /api/nis2/*; PDF export opens the server's print-ready
// HTML in a new window (authed fetch → window.print), CSV downloads as a file.

const NIS2_CATEGORIES = [
  'Governance', 'Risk Management', 'Event Response', 'Backup/Recovery', 'Access Control',
  'Supplier Management', 'Network Security', 'Logging/Monitoring', 'Vulnerability Management', 'Documentation',
];
const NIS2_RISK_STATUS = ['open', 'mitigating', 'accepted', 'closed'];
const NIS2_CONTROL_STATUS = ['OK', 'Partial', 'Missing', 'Overdue'];
const NIS2_FREQ = ['daily', 'weekly', 'monthly', 'quarterly', 'annually', 'ad-hoc'];
const NIS2_SEVERITY = ['low', 'medium', 'high', 'critical'];
const NIS2_EVENT_STATUS = ['open', 'investigating', 'contained', 'resolved', 'closed'];

const reportingState = { section: 'nis2' }; // 'nis2' (stationary) | 'generator' (custom)
const nis2State = { tab: 'dashboard' };

// Maps a value to one of the shared badge palette classes (ok/warn/crit/INFO/neutral).
const NIS2_BAND_CLASS = { Critical: 'crit', High: 'warn', Medium: 'INFO', Low: 'ok' };
const NIS2_CTRL_CLASS = { OK: 'ok', Partial: 'warn', Missing: 'crit', Overdue: 'crit' };
const NIS2_SEV_CLASS = { critical: 'crit', high: 'warn', medium: 'INFO', low: 'neutral' };
const NIS2_CATSTATUS_CLASS = { good: 'ok', partial: 'warn', weak: 'crit', 'no-data': 'neutral' };
const NIS2_PRIO_CLASS = { critical: 'crit', high: 'warn', medium: 'INFO' };

const nbadge = (text, cls) => el('span', { class: `badge ${cls || 'neutral'}` }, text);

// A short "what is this and why does it matter for NIS2" explainer shown at the
// top of each register, so a first-time user understands what to capture — and
// why it belongs in a NIS2 report — before filling it in.
function nis2Explain(what, why) {
  return el('div', { class: 'nis2-explain' },
    el('div', {}, el('strong', {}, 'What: '), what),
    el('div', { class: 'nis2-explain-why' }, el('strong', {}, 'Why: '), why));
}
function selField(name, label, options, value, hint) {
  return { name, label, type: 'select', value, hint, options: options.map((o) => (typeof o === 'object' ? o : { value: o, label: o })) };
}
const yesNo = () => [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }];

// Opens the standard edit modal, then widens it (NIS2 records have many fields).
function nis2Modal(title, fields, onSubmit) {
  openModal(title, fields, onSubmit);
  $('#modal-card').classList.add('wide');
}

// Authenticated file download (CSV) — fetch with the bearer token, save a blob.
async function nis2Download(path, filename) {
  try {
    // No locale here: /export/*.csv is a raw register dump keyed by the stored
    // column names, meant to be re-read by a spreadsheet, not by a person.
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) { toast(`Export failed: ${err.message}`, true); }
}

// The NIS2 report documents are rendered server-side, so the server has to be
// told which language to render in — it cannot see the dashboard's choice. A
// NIS2 report goes to management and, for an Article 23 notification, to an
// authority; it is the one export where the language is not cosmetic.
function withLocale(path) {
  const loc = window.I18n && window.I18n.getLocale ? window.I18n.getLocale() : null;
  if (!loc) return path;
  return `${path}${path.includes('?') ? '&' : '?'}locale=${encodeURIComponent(loc)}`;
}

// Authenticated print: fetch the server's print-ready HTML and open it in a new
// window for the browser's "Save as PDF". The document carries its own print CSS.
async function nis2Print(path) {
  try {
    const res = await fetch(withLocale(path), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const w = window.open('', '_blank');
    if (!w) { toast('Pop-up blocked — allow pop-ups to export PDF', true); return; }
    w.document.open(); w.document.write(html); w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 400);
  } catch (err) { toast(`Export failed: ${err.message}`, true); }
}

// ---- Reporting (SHELL MIGRATED — see public/views/reporting.js)
// Top-level Reporting view: NIS2 (a stationary page with fixed parameters), the
// Report Generator (a flexible, selector-driven custom report builder), the
// schedules and the audit trail. The four bodies stay here; the page they sit
// on is the contract's.
let reportingPage = null;

function reportingSections() {
  // Audit is RBAC-gated: only admins may see who did what on the server.
  return role === 'admin'
    ? ['nis2', 'generator', 'schedules', 'audit']
    : ['nis2', 'generator', 'schedules'];
}

function getReportingPage() {
  if (reportingPage) return reportingPage;
  if (typeof window === 'undefined' || !window.ReportingPage || !ui) return null;
  reportingPage = window.ReportingPage.create({
    el, t, ui,
    sections: reportingSections,
    section: () => reportingState.section,
    setSection: (key) => { reportingState.section = key; syncLocation(); },
    help: () => {
      const info = PAGE_INFO.reporting || {};
      return { lead: info.hero || '', title: info.title || t('rep.title'), body: info.body || (() => []) };
    },
    render: (key) => (key === 'generator' ? reportGenerator()
      : key === 'schedules' ? reportSchedulesPanel()
        : key === 'audit' ? auditModule()
          : nis2Module()),
    errText,
  });
  return reportingPage;
}

views.reporting = async () => {
  const v = getReportingPage();
  if (!v) return el('div', { class: 'empty error' }, t('rep.err.load'));
  // The bodies hold their own open detail, so the page is rebuilt per entry.
  reportingPage = null;
  return v.view();
};

// The NIS2 module — a fixed set of pages (Dashboard, Risk Register, Controls,
// Incidents, Reports, Audit). Rendered inside the Reporting view.
async function nis2Module() {
  const wrap = el('div', { class: 'nis2-inner' });
  const tabs = [
    ['dashboard', 'Dashboard'], ['risks', 'Risk Register'], ['controls', 'Controls'],
    ['incidents', 'Incidents'], ['reports', 'Reports'],
  ];
  if (role === 'admin') tabs.push(['audit', 'Audit Trail']);
  wrap.append(tabStrip(tabs, {
    active: nis2State.tab,
    className: 'nis2-subtabs nis2-inner-tabs',
    ariaLabel: 'NIS2',
    onPick: (key) => { nis2State.tab = key; render(); },
  }));

  const body = el('div', { class: 'nis2-body' }, el('div', { class: 'empty' }, 'Loading…'));
  wrap.append(body);
  const renderers = {
    dashboard: nis2Dashboard, risks: nis2Risks, controls: nis2Controls,
    incidents: nis2Incidents, reports: nis2Reports, audit: nis2Audit,
  };
  try { body.replaceChildren(await renderers[nis2State.tab]()); }
  catch (err) { body.replaceChildren(el('div', { class: 'empty error' }, err.message)); }
  return wrap;
}

// ---- NIS2: Dashboard -------------------------------------------------------
async function nis2Dashboard() {
  const d = await api('/api/nis2/dashboard');
  const wrap = el('div');

  // First-run "get started" guide when there is no data yet.
  if (!d.totals.risks && !d.totals.controls && !d.totals.events) {
    wrap.append(nis2GetStarted());
  }

  // Readiness hero + KPI cards.
  const readinessClass = d.readinessScore >= 80 ? 'ok' : d.readinessScore >= 50 ? 'warn' : 'crit';
  wrap.append(el('div', { class: 'nis2-readiness' },
    el('div', { class: 'nis2-gauge' },
      el('div', { class: `nis2-gauge-v ${readinessClass}` }, `${d.readinessScore}%`),
      el('div', { class: 'nis2-gauge-bar' }, el('span', { class: readinessClass, style: `width:${d.readinessScore}%` }))),
    el('div', { class: 'nis2-gauge-label' }, el('strong', {}, 'NIS2 readiness'),
      el('div', { class: 'muted' }, `${d.totals.controls} controls · ${d.totals.risks} risks · ${d.totals.events} events`))));

  wrap.append(nis2Explain(
    'A single self-assessment score for how prepared you are under the NIS2 directive — the mean of the ten risk-management areas below, each scored from how complete its controls’ evidence is.',
    'It is a planning aid, not a certificate. Work the weak categories and the recommended actions until you can stand behind the number, then generate a report for the board or the authority.'));

  const kpi = (k, v, cls, title) => el('div', { class: 'kpi', ...(title ? { title } : {}) },
    el('div', { class: 'kpi-k' }, k), el('div', { class: `kpi-v ${cls || ''}` }, String(v)));
  wrap.append(el('div', { class: 'kpi-grid' },
    kpi('Open critical risks', d.openCriticalRisks, d.openCriticalRisks ? 'crit-text' : '',
      'Risks in the Critical band (likelihood × impact ≥ 15) still open or only being mitigated — each warrants a documented management decision.'),
    kpi('High/medium findings', d.openHighMediumFindings, '',
      'Open risks in the High or Medium band — the next tier to work down once the critical ones are handled.'),
    kpi('Events (30 days)', d.eventsLast30Days, '',
      'Security events detected in the last 30 days. Any flagged “notification required” carry a reporting duty to the authority within the NIS2 (Art. 23) deadlines.'),
    kpi('Controls without evidence', d.controlsWithoutEvidence, d.controlsWithoutEvidence ? 'warn-text' : '',
      'Controls with no evidence reference on file (or marked Missing/Overdue). Evidence is what an auditor asks for — these are what pull the readiness score down.')));

  // Category status grid. Each card drills into the controls behind its score
  // (a read-only list) — so the "N control(s) · X%" figure is explorable rather
  // than a dead end.
  wrap.append(el('h3', { class: 'nis2-h3' }, 'Status by category'));
  wrap.append(el('div', { class: 'nis2-cats' }, ...d.categories.map((c) => el('div', {
    class: 'nis2-cat nis2-cat-link',
    role: 'button',
    tabindex: '0',
    title: `View the ${c.controlCount} control(s) that make up ${c.category}`,
    onclick: () => nis2CategoryControlsModal(c.category),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nis2CategoryControlsModal(c.category); } },
  },
    el('div', { class: 'nis2-cat-top' }, el('span', {}, c.category), nbadge(c.status, NIS2_CATSTATUS_CLASS[c.status])),
    el('div', { class: 'nis2-gauge-bar sm' }, el('span', { class: NIS2_CATSTATUS_CLASS[c.status], style: `width:${c.score}%` })),
    el('div', { class: 'muted nis2-cat-sub' }, `${c.controlCount} control(s) · ${c.score}% `, el('span', { class: 'nis2-cat-arrow' }, '→'))))));

  // Top recommended actions.
  wrap.append(el('h3', { class: 'nis2-h3' }, 'Top recommended actions'));
  if (!d.topActions.length) wrap.append(el('div', { class: 'empty' }, 'No outstanding actions — nice work.'));
  else wrap.append(el('ol', { class: 'nis2-actions' }, ...d.topActions.map((a) =>
    el('li', {}, nbadge(a.priority, NIS2_PRIO_CLASS[a.priority] || 'neutral'), ' ', a.text))));

  // Export shortcuts.
  wrap.append(el('div', { class: 'nis2-exports' },
    el('button', { class: 'small', onclick: () => nis2Print('/api/nis2/export/readiness.html') }, '⤓ Readiness PDF'),
    el('button', { class: 'small', onclick: () => nis2Print('/api/nis2/export/executive.html') }, '⤓ Executive PDF')));
  return wrap;
}

// Read-only drill-down from a dashboard category card. The dashboard payload
// only carries per-category counts/scores, so we (re)fetch the controls in this
// area and list them — name, status, evidence, cadence and description — letting
// a reader see *which* controls sit behind the "N control(s) · X%" figure and
// read about them without leaving the dashboard.
async function nis2CategoryControlsModal(category) {
  const card = $('#modal-card');
  card.classList.add('wide');
  const title = `Controls — ${category}`;
  const withClose = (...body) => {
    body.push(el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
    card.replaceChildren(...body);
  };
  card.replaceChildren(el('h3', {}, title), el('div', { class: 'empty' }, 'Loading…'));
  $('#modal').classList.remove('hidden');
  let controls;
  try {
    controls = await api(`/api/nis2/controls?area=${encodeURIComponent(category)}`);
  } catch (err) {
    withClose(el('h3', {}, title), el('div', { class: 'empty error' }, errText(err)));
    return;
  }
  const body = [
    el('h3', {}, title),
    el('p', { class: 'muted' }, 'The controls whose evidence completeness make up this category’s readiness score.'),
  ];
  if (!controls.length) {
    body.push(el('div', { class: 'empty' }, 'No controls recorded in this category yet.'));
  } else {
    body.push(el('div', { class: 'nis2-cat-controls' }, ...controls.map((c) => el('div', { class: 'nis2-cat-control' },
      el('div', { class: 'nis2-cat-control-head' },
        el('strong', {}, c.controlName),
        nbadge(c.status, NIS2_CTRL_CLASS[c.status]),
        c.hasEvidence ? nbadge('evidence', 'ok') : nbadge('no evidence', 'crit')),
      el('div', { class: 'muted nis2-cat-control-meta' },
        `Owner: ${c.owner || '–'} · Frequency: ${c.frequency || '–'} · Last: ${c.lastPerformed || '–'} · Next due: ${c.nextDue || '–'}`),
      c.description ? el('div', { class: 'nis2-cat-control-desc' }, c.description) : null,
      c.comment ? el('div', { class: 'muted nis2-cat-control-desc' }, c.comment) : null))));
  }
  withClose(...body);
}

// ---- NIS2: Risk Register ---------------------------------------------------
function nis2RiskFields(r) {
  r = r || {};
  return [
    { name: 'title', label: 'Title', value: r.title, hint: 'Short, recognisable name for the risk (e.g. “Unpatched internet-facing VPN gateway”).' },
    selField('category', 'Category', NIS2_CATEGORIES, r.category || NIS2_CATEGORIES[0], 'Which NIS2 risk-management area this risk belongs to.'),
    { name: 'affectedAsset', label: 'Affected asset', value: r.affectedAsset, hint: 'The system, service or data the risk threatens.' },
    selField('likelihood', 'Likelihood (1–5)', ['1', '2', '3', '4', '5'], String(r.likelihood || 1), 'How probable is it? 1 = rare, 5 = almost certain.'),
    selField('impact', 'Impact (1–5)', ['1', '2', '3', '4', '5'], String(r.impact || 1), 'How damaging if it happens? 1 = negligible, 5 = severe. The score (likelihood × impact, 1–25) and its band are computed for you.'),
    { name: 'owner', label: 'Owner', value: r.owner, hint: 'Who is accountable for treating this risk.' },
    selField('status', 'Status', NIS2_RISK_STATUS, r.status || 'open', 'open = untreated · mitigating = treatment under way · accepted = consciously tolerated · closed = resolved.'),
    { name: 'dueDate', label: 'Due date', type: 'date', value: r.dueDate || '', hint: 'Target date for the mitigation to be in place.' },
    selField('managementAcceptance', 'Management acceptance', yesNo(), String(!!r.managementAcceptance), 'Yes only when management has formally decided to tolerate this risk. NIS2 expects such decisions to be documented and owned at management level.'),
    { name: 'evidenceLink', label: 'Evidence link', value: r.evidenceLink, hint: 'Link (URL or absolute path) to the assessment or decision record that backs this entry.' },
    { name: 'mitigationPlan', label: 'Mitigation plan', type: 'textarea', value: r.mitigationPlan, hint: 'What you are doing to reduce the likelihood or impact.' },
    { name: 'description', label: 'Description', type: 'textarea', value: r.description, hint: 'Context: what the risk is and how it could materialise.' },
  ];
}
function nis2RiskBody(v) {
  return {
    title: v.title, category: v.category, affectedAsset: v.affectedAsset,
    likelihood: Number(v.likelihood), impact: Number(v.impact), owner: v.owner,
    status: v.status, dueDate: v.dueDate || null, managementAcceptance: v.managementAcceptance === 'true',
    evidenceLink: v.evidenceLink, mitigationPlan: v.mitigationPlan, description: v.description,
  };
}
async function nis2Risks() {
  const risks = await api('/api/nis2/risks');
  const wrap = el('div');
  wrap.append(el('div', { class: 'section-head' },
    el('h3', { class: 'nis2-h3' }, `Risk register (${risks.length})`),
    el('span', { class: 'spacer', style: 'flex:1' }),
    el('button', { class: 'small ghost', onclick: () => nis2Download('/api/nis2/export/risks.csv', 'nis2-risks.csv') }, '⤓ CSV'),
    el('button', { class: 'small ghost', onclick: () => nis2Print('/api/nis2/export/risk.html') }, '⤓ PDF'),
    canWrite() ? el('button', { class: 'small', onclick: () => nis2EditRisk() }, '+ New risk') : null));
  wrap.append(nis2Explain(
    'Your inventory of cyber risks to the systems and services in scope. Each is scored likelihood × impact (1–25), banded Low→Critical, and given an owner, a due date and — where a risk is tolerated — explicit management sign-off.',
    'NIS2 (Article 21) requires risk-based security measures. This register is the documented evidence that risks are identified, assessed and being treated — and it feeds the Risk and Executive reports.'));
  if (!risks.length) { wrap.append(el('div', { class: 'empty' }, 'No risks recorded yet.')); return wrap; }
  const head = ['Title', 'Category', 'Asset', 'L×I', 'Score', 'Owner', 'Status', 'Due', ''];
  const rows = risks.map((r) => el('tr', {},
    el('td', {}, el('strong', {}, r.title), r.managementAcceptance ? el('div', { class: 'muted' }, 'Mgmt accepted') : null),
    el('td', {}, r.category),
    el('td', {}, r.affectedAsset || '–'),
    el('td', {}, `${r.likelihood}×${r.impact}`),
    el('td', {}, nbadge(`${r.riskScore} ${r.band}`, NIS2_BAND_CLASS[r.band])),
    el('td', {}, r.owner || '–'),
    el('td', {}, nbadge(r.status, 'neutral')),
    el('td', {}, r.dueDate || '–'),
    el('td', {}, el('div', { class: 'row-actions' },
      canWrite() ? el('button', { class: 'small ghost', onclick: () => nis2EditRisk(r) }, 'Edit') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => nis2DeleteRisk(r) }, 'Delete') : null))));
  wrap.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows))));
  return wrap;
}
function nis2EditRisk(r) {
  const editing = r && r.id;
  nis2Modal(editing ? 'Edit risk' : 'New risk', nis2RiskFields(r), async (v) => {
    const path = editing ? `/api/nis2/risks/${r.id}` : '/api/nis2/risks';
    await api(path, { method: editing ? 'PUT' : 'POST', body: nis2RiskBody(v) });
    closeModal(); toast('Risk saved'); render();
  });
}
async function nis2DeleteRisk(r) {
  if (!confirm(`Delete risk "${r.title}"?`)) return;
  try { await api(`/api/nis2/risks/${r.id}`, { method: 'DELETE' }); toast('Risk deleted'); render(); }
  catch (err) { toast(errText(err), true); }
}

// ---- NIS2: Controls --------------------------------------------------------
function nis2ControlFields(c) {
  c = c || {};
  return [
    { name: 'controlName', label: 'Control name', value: c.controlName, hint: 'The assurance activity itself (e.g. “Quarterly restore test of backups”).' },
    selField('nis2Area', 'NIS2 area', NIS2_CATEGORIES, c.nis2Area || NIS2_CATEGORIES[0], 'Which of the ten NIS2 areas this control supports — it drives that area’s readiness score.'),
    { name: 'owner', label: 'Owner', value: c.owner, hint: 'Who is responsible for performing the control.' },
    selField('frequency', 'Frequency', NIS2_FREQ, c.frequency || 'quarterly', 'How often the control is performed. Frequency plus “Next due” is what makes a control fall Overdue.'),
    selField('status', 'Status', NIS2_CONTROL_STATUS, c.status || 'Missing', 'OK = performed, with evidence · Partial = partly in place · Missing = not done yet · Overdue = past its due date. Toward readiness, OK counts 100%, Partial 50%, the rest 0%.'),
    { name: 'lastPerformed', label: 'Last performed', type: 'date', value: c.lastPerformed || '', hint: 'When the control was last carried out.' },
    { name: 'nextDue', label: 'Next due', type: 'date', value: c.nextDue || '', hint: 'When it is next due. Past this date with status not OK marks the control Overdue.' },
    { name: 'evidenceFile', label: 'Evidence (link/reference)', value: c.evidenceFile, hint: 'Reference (URL or absolute path) to the proof it ran — test report, review minutes, ticket. This is what an auditor asks to see; controls without it are flagged.' },
    { name: 'description', label: 'Description', type: 'textarea', value: c.description, hint: 'What the control does and how it is performed.' },
    { name: 'comment', label: 'Comment', type: 'textarea', value: c.comment, hint: 'Optional notes — last outcome, exceptions, follow-ups.' },
  ];
}
function nis2ControlBody(v) {
  return {
    controlName: v.controlName, nis2Area: v.nis2Area, owner: v.owner, frequency: v.frequency,
    status: v.status, lastPerformed: v.lastPerformed || null, nextDue: v.nextDue || null,
    evidenceFile: v.evidenceFile, description: v.description, comment: v.comment,
  };
}
async function nis2Controls() {
  const [all, missing] = await Promise.all([api('/api/nis2/controls'), api('/api/nis2/controls?withoutEvidence=true')]);
  const wrap = el('div');
  wrap.append(el('div', { class: 'section-head' },
    el('h3', { class: 'nis2-h3' }, `Controls (${all.length})`),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'small ghost', onclick: () => nis2Download('/api/nis2/export/controls.csv', 'nis2-controls.csv') }, '⤓ CSV'),
    el('button', { class: 'small ghost', onclick: () => nis2Print('/api/nis2/export/control.html') }, '⤓ PDF'),
    canWrite() ? el('button', { class: 'small', onclick: () => nis2EditControl() }, '+ New control') : null));
  wrap.append(nis2Explain(
    'The recurring technical and organisational security measures you operate — backups, patching, access reviews, log monitoring, etc. — each tied to a NIS2 area, with an owner, a cadence and a reference to the evidence that proves it was performed.',
    'NIS2 (Article 21) obliges you to implement these measures and keep them effective; the evidence link is what an auditor or the authority asks to see. Controls marked Missing/Overdue or without evidence are flagged here — they are the gaps that lower your readiness score.'));

  if (missing.length) {
    wrap.append(el('div', { class: 'nis2-alert' },
      el('strong', {}, `${missing.length} control(s) need attention`),
      ' — missing/overdue or without evidence.'));
  }
  if (!all.length) { wrap.append(el('div', { class: 'empty' }, 'No controls recorded yet.')); return wrap; }
  const head = ['Control', 'Area', 'Owner', 'Frequency', 'Last', 'Next due', 'Evidence', 'Status', ''];
  const rows = all.map((c) => el('tr', {},
    el('td', {}, el('strong', {}, c.controlName)),
    el('td', {}, c.nis2Area),
    el('td', {}, c.owner || '–'),
    el('td', {}, c.frequency),
    el('td', {}, c.lastPerformed || '–'),
    el('td', {}, c.nextDue || '–'),
    el('td', {}, c.hasEvidence ? nbadge('yes', 'ok') : nbadge('none', 'crit')),
    el('td', {}, nbadge(c.status, NIS2_CTRL_CLASS[c.status])),
    el('td', {}, el('div', { class: 'row-actions' },
      canWrite() ? el('button', { class: 'small ghost', onclick: () => nis2EditControl(c) }, 'Edit') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => nis2DeleteControl(c) }, 'Delete') : null))));
  wrap.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows))));
  return wrap;
}
function nis2EditControl(c) {
  const editing = c && c.id;
  nis2Modal(editing ? 'Edit control' : 'New control', nis2ControlFields(c), async (v) => {
    const path = editing ? `/api/nis2/controls/${c.id}` : '/api/nis2/controls';
    await api(path, { method: editing ? 'PUT' : 'POST', body: nis2ControlBody(v) });
    closeModal(); toast('Control saved'); render();
  });
}
async function nis2DeleteControl(c) {
  if (!confirm(`Delete control "${c.controlName}"?`)) return;
  try { await api(`/api/nis2/controls/${c.id}`, { method: 'DELETE' }); toast('Control deleted'); render(); }
  catch (err) { toast(errText(err), true); }
}

// ---- NIS2: Events -------------------------------------------------------
function nis2IncidentFields(i) {
  i = i || {};
  const dt = (v) => (v ? new Date(v).toISOString().slice(0, 16) : '');
  return [
    { name: 'title', label: 'Title', value: i.title, hint: 'Short description of the event.' },
    selField('severity', 'Severity', NIS2_SEVERITY, i.severity || 'medium', 'Your impact assessment, low → critical. High/critical events surface in the Executive report.'),
    selField('status', 'Status', NIS2_INCIDENT_STATUS, i.status || 'open', 'Where the incident is in its lifecycle: open → investigating → contained → resolved → closed.'),
    { name: 'detectedAt', label: 'Detected at', type: 'datetime-local', value: dt(i.detectedAt), hint: 'When you became aware of it — the moment the NIS2 (Art. 23) reporting deadlines start counting from.' },
    { name: 'startedAt', label: 'Started at', type: 'datetime-local', value: dt(i.startedAt), hint: 'When the event actually began, if known (may precede detection).' },
    { name: 'resolvedAt', label: 'Resolved at', type: 'datetime-local', value: dt(i.resolvedAt), hint: 'When normal service was restored.' },
    selField('nis2Relevant', 'NIS2 relevant', yesNo(), String(!!i.nis2Relevant), 'Yes if the event falls within the scope of the NIS2 directive for your organisation.'),
    selField('notificationRequired', 'Notification required', yesNo(), String(!!i.notificationRequired), 'Yes if the event is “significant” and must be reported to the authority/CSIRT. This is the duty that starts the 24-hour early warning / 72-hour notification / one-month final-report clock under NIS2 (Art. 23).'),
    { name: 'affectedSystems', label: 'Affected systems', type: 'textarea', value: i.affectedSystems, hint: 'Which systems, services or sites were involved.' },
    { name: 'businessImpact', label: 'Business impact', type: 'textarea', value: i.businessImpact, hint: 'What it meant in practice — downtime, users/customers affected, data exposed. Needed for the authority notification.' },
    { name: 'rootCause', label: 'Root cause', type: 'textarea', value: i.rootCause, hint: 'What ultimately caused it, once known — required for the final report.' },
    { name: 'actionsTaken', label: 'Actions taken', type: 'textarea', value: i.actionsTaken, hint: 'Containment, remediation and recovery steps taken.' },
    { name: 'lessonsLearned', label: 'Lessons learned', type: 'textarea', value: i.lessonsLearned, hint: 'What you will change to prevent a recurrence.' },
  ];
}
function nis2IncidentBody(v) {
  return {
    title: v.title, severity: v.severity, status: v.status,
    detectedAt: v.detectedAt || null, startedAt: v.startedAt || null, resolvedAt: v.resolvedAt || null,
    nis2Relevant: v.nis2Relevant === 'true', notificationRequired: v.notificationRequired === 'true',
    affectedSystems: v.affectedSystems, businessImpact: v.businessImpact, rootCause: v.rootCause,
    actionsTaken: v.actionsTaken, lessonsLearned: v.lessonsLearned,
  };
}
async function nis2Incidents() {
  const incidents = await api('/api/nis2/incidents');
  const wrap = el('div');
  wrap.append(el('div', { class: 'section-head' },
    el('h3', { class: 'nis2-h3' }, `Security incidents (${incidents.length})`),
    el('span', { style: 'flex:1' }),
    el('button', { class: 'small ghost', onclick: () => nis2Download('/api/nis2/export/incidents.csv', 'nis2-incidents.csv') }, '⤓ CSV'),
    el('button', { class: 'small ghost', onclick: () => nis2Print('/api/nis2/export/incident.html') }, '⤓ PDF'),
    canWrite() ? el('button', { class: 'small', onclick: () => nis2EditIncident() }, '+ New incident') : null));
  wrap.append(nis2Explain(
    'Your log of significant security incidents — what happened, when it was detected, the systems and business affected, the root cause and the actions taken. These are incidents you record by hand, distinct from the network events BlueEyes derives automatically from probes.',
    'NIS2 (Article 23) makes incident notification a legal duty. Flag “Notification required” for a significant incident: you then owe the national CSIRT/authority an early warning within 24 hours, a full notification within 72 hours, and a final report within one month. Capturing the timeline, impact and root cause here is what lets you produce that report.'));
  if (!incidents.length) { wrap.append(el('div', { class: 'empty' }, 'No incidents recorded yet.')); return wrap; }
  const head = ['Ref', 'Title', 'Severity', 'Detected', 'Status', 'NIS2', 'Notify', ''];
  const rows = incidents.map((i) => el('tr', {},
    el('td', {}, el('code', {}, i.incidentId)),
    el('td', {}, el('strong', {}, i.title)),
    el('td', {}, nbadge(i.severity, NIS2_SEV_CLASS[i.severity])),
    el('td', {}, i.detectedAt ? fmtDate(i.detectedAt) : '–'),
    el('td', {}, nbadge(i.status, 'neutral')),
    el('td', {}, i.nis2Relevant ? nbadge('yes', 'warn') : '–'),
    el('td', {}, i.notificationRequired ? nbadge('required', 'crit') : '–'),
    el('td', {}, el('div', { class: 'row-actions' },
      canWrite() ? el('button', { class: 'small ghost', onclick: () => nis2EditIncident(i) }, 'Edit') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => nis2DeleteIncident(i) }, 'Delete') : null))));
  wrap.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows))));
  return wrap;
}
function nis2EditIncident(i) {
  const editing = i && i.id;
  nis2Modal(editing ? `Edit incident ${i.incidentId}` : 'New incident', nis2IncidentFields(i), async (v) => {
    const path = editing ? `/api/nis2/incidents/${i.id}` : '/api/nis2/incidents';
    await api(path, { method: editing ? 'PUT' : 'POST', body: nis2IncidentBody(v) });
    closeModal(); toast('Incident saved'); render();
  });
}
async function nis2DeleteIncident(i) {
  if (!confirm(`Delete incident "${i.title}"?`)) return;
  try { await api(`/api/nis2/incidents/${i.id}`, { method: 'DELETE' }); toast('Incident deleted'); render(); }
  catch (err) { toast(errText(err), true); }
}

// ---- NIS2: Reports ---------------------------------------------------------
const NIS2_REPORT_TYPES = [
  ['executive', 'Executive Report'], ['readiness', 'Readiness Report'],
  ['risk', 'Risk Register Report'], ['control', 'Control Evidence Report'], ['event', 'Event Report'],
];
async function nis2Reports() {
  const reports = await api('/api/nis2/reports');
  const wrap = el('div');
  wrap.append(el('div', { class: 'section-head' },
    el('h3', { class: 'nis2-h3' }, 'Management reports'),
    el('span', { style: 'flex:1' }),
    canWrite() ? el('button', { class: 'small', onclick: () => nis2GenerateReport() }, '+ Generate report') : null));

  wrap.append(nis2Explain(
    'Point-in-time management reports — Executive, Readiness, Risk, Control or Event — built from the current data and viewable as a print-ready PDF for the board or the authority.',
    'Each report freezes today’s metrics, so the next report of the same type can show the trend (“since last report”). An admin/compliance role signs a report off by approving the draft — the record that it was reviewed.'));

  if (!reports.length) wrap.append(el('div', { class: 'empty' }, 'No reports generated yet.'));
  else {
    const head = ['Type', 'Title', 'Readiness', 'Generated', 'By', 'Status', ''];
    const rows = reports.map((r) => el('tr', {},
      el('td', {}, (NIS2_REPORT_TYPES.find((t) => t[0] === r.reportType) || [r.reportType, r.reportType])[1]),
      el('td', {}, r.title),
      el('td', {}, r.snapshot && r.snapshot.readinessScore != null ? `${r.snapshot.readinessScore}%` : '–'),
      el('td', {}, fmtDate(r.createdAt)),
      el('td', {}, r.generatedByEmail || '–'),
      el('td', {}, r.status === 'approved'
        ? nbadge(`approved · ${r.approvedByEmail || ''}`, 'ok') : nbadge('draft', 'warn')),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'small ghost', onclick: () => nis2PrintReportType(r.reportType) }, 'PDF'),
        (role === 'admin' && r.status === 'draft') ? el('button', { class: 'small', onclick: () => nis2ApproveReport(r) }, 'Approve') : null,
        canWrite() ? el('button', { class: 'small ghost', onclick: () => nis2DeleteReport(r) }, 'Delete') : null))));
    wrap.append(el('div', { class: 'tablewrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows))));
  }
  return wrap;
}
function nis2PrintReportType(type) {
  const map = { executive: 'executive', readiness: 'readiness', risk: 'risk', control: 'control', event: 'event' };
  nis2Print(`/api/nis2/export/${map[type] || 'executive'}.html`);
}
function nis2GenerateReport() {
  nis2Modal('Generate report', [
    selField('reportType', 'Report type', NIS2_REPORT_TYPES.map((t) => ({ value: t[0], label: t[1] })), 'executive',
      'Executive = board summary + trend · Readiness = the scorecard · Risk / Control / Event = the full register for that area.'),
    { name: 'title', label: 'Title (optional)', value: '', hint: 'Leave blank to use a sensible default for the chosen type.' },
  ], async (v) => {
    await api('/api/nis2/reports', { method: 'POST', body: { reportType: v.reportType, title: v.title || undefined } });
    closeModal(); toast('Report generated'); render();
  });
}
async function nis2ApproveReport(r) {
  try { await api(`/api/nis2/reports/${r.id}/approve`, { method: 'POST' }); toast('Report approved'); render(); }
  catch (err) { toast(errText(err), true); }
}
async function nis2DeleteReport(r) {
  if (!confirm(`Delete report "${r.title}"?`)) return;
  try { await api(`/api/nis2/reports/${r.id}`, { method: 'DELETE' }); toast('Report deleted'); render(); }
  catch (err) { toast(errText(err), true); }
}

// ---- NIS2: Audit trail -----------------------------------------------------
async function nis2Audit() {
  const entries = await api('/api/nis2/audit');
  const wrap = el('div');
  wrap.append(el('h3', { class: 'nis2-h3' }, 'Audit trail'));
  if (!entries.length) { wrap.append(el('div', { class: 'empty' }, 'No changes recorded yet.')); return wrap; }
  const head = ['When', 'User', 'Action', 'Entity', 'ID'];
  const rows = entries.map((e) => el('tr', {},
    el('td', {}, fmtDate(e.createdAt)),
    el('td', {}, e.userEmail || (e.userId != null ? `#${e.userId}` : '–')),
    el('td', {}, nbadge(e.action, e.action === 'delete' ? 'crit' : e.action === 'approve' ? 'ok' : 'neutral')),
    el('td', {}, e.entityType),
    el('td', {}, e.entityId != null ? `#${e.entityId}` : '–')));
  wrap.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows))));
  return wrap;
}

// ---- Audit (server-wide trail, admin only) --------------------------------
// Surfaced under Reporting → Audit. Shows who did what on the server (user
// actions) and what each agent performed (traffic/probes). Recurring activity
// is folded onto one row annotated "Repeats every …", per the audit design.
const auditState = { actorType: '', action: '' };

function fmtInterval(ms) {
  if (!ms || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return fmtDuration(s);
}

async function auditModule() {
  const wrap = el('div', { class: 'nis2-inner' });
  wrap.append(el('h3', { class: 'nis2-h3' }, 'Audit trail'));
  wrap.append(el('p', { class: 'muted' }, 'Actions performed by users on the server, and what each agent reported — with when, who and what. Repeated activity (continuous reporting, scheduled probes) is recorded once and annotated with how often it repeats.'));

  // Filters: actor type + action, plus refresh / CSV export.
  const actorSel = el('select', { class: 'small', onchange: () => { auditState.actorType = actorSel.value; load(); } },
    ...[['', 'All actors'], ['user', 'Users'], ['agent', 'Agents'], ['system', 'System']]
      .map(([v, l]) => el('option', { value: v, selected: auditState.actorType === v }, l)));
  const actionSel = el('select', { class: 'small', onchange: () => { auditState.action = actionSel.value; load(); } },
    el('option', { value: '' }, 'All actions'));
  const csvHref = () => {
    const p = new URLSearchParams();
    if (auditState.actorType) p.set('actorType', auditState.actorType);
    if (auditState.action) p.set('action', auditState.action);
    return `/api/audit/export.csv${p.toString() ? `?${p}` : ''}`;
  };
  const exportBtn = el('button', { class: 'small ghost', onclick: () => nis2Download(csvHref(), 'audit.csv') }, '⤓ CSV');
  wrap.append(el('div', { class: 'history-controls' },
    actorSel, actionSel, el('button', { class: 'small ghost', onclick: () => load() }, '↻ Refresh'), exportBtn));

  const body = el('div', { class: 'nis2-body' }, el('div', { class: 'empty' }, 'Loading…'));
  wrap.append(body);

  // Populate the action dropdown once.
  try {
    const actions = await api('/api/audit/actions');
    for (const a of actions) actionSel.append(el('option', { value: a, selected: auditState.action === a }, a));
  } catch { /* dropdown stays "All actions" */ }

  async function load() {
    body.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
    const p = new URLSearchParams();
    if (auditState.actorType) p.set('actorType', auditState.actorType);
    if (auditState.action) p.set('action', auditState.action);
    p.set('limit', '300');
    let entries;
    try { entries = await api(`/api/audit?${p}`); }
    catch (err) {
      if (err.status === 403) { body.replaceChildren(featureUpsell('Audit trail', 'The audit trail is part of the BlueEyes Professional plan and above, so it isn\'t available here.')); return; }
      body.replaceChildren(el('div', { class: 'empty error' }, err.message)); return;
    }
    if (!entries.length) { body.replaceChildren(el('div', { class: 'empty' }, 'No audited activity yet.')); return; }

    const head = ['When', 'Actor', 'Action', 'Target', 'Repeats', 'Details'];
    const rows = entries.map((e) => {
      const actorCls = e.actorType === 'agent' ? 'neutral' : e.actorType === 'system' ? 'warn' : 'ok';
      const target = e.targetLabel || (e.targetType ? `${e.targetType}${e.targetId ? ` #${e.targetId}` : ''}` : (e.targetId ? `#${e.targetId}` : '–'));
      let repeats = '–';
      if (e.occurrences > 1 || e.repeatIntervalMs) {
        const iv = fmtInterval(e.repeatIntervalMs);
        repeats = `Repeats${iv ? ` every ${iv}` : ''} · ×${e.occurrences}${e.lastSeenAt ? ` · last ${fmtDate(e.lastSeenAt)}` : ''}`;
      }
      const detailBits = [];
      if (e.method && e.path) detailBits.push(`${e.method} ${e.path}`);
      // A failed probe carries a plain reason ("traceroute not installed") —
      // show it as text, not raw JSON.
      if (e.detail && e.detail.reason) detailBits.push(String(e.detail.reason));
      else if (e.detail && Object.keys(e.detail).length) detailBits.push(JSON.stringify(e.detail));
      if (e.ip) detailBits.push(e.ip);
      return el('tr', {},
        el('td', {}, fmtDate(e.ts)),
        el('td', {}, nbadge(e.actorType, actorCls), ' ', el('span', {}, e.actorLabel || (e.actorId != null ? `#${e.actorId}` : '–')),
          e.actorRole ? el('span', { class: 'muted' }, ` (${e.actorRole})`) : null),
        el('td', {}, nbadge(e.action, e.action.endsWith('.delete') ? 'crit' : (e.action.endsWith('-failed') || e.action.endsWith('.error') ? 'warn' : 'neutral'))),
        el('td', {}, target),
        el('td', { class: e.occurrences > 1 ? 'muted' : '' }, repeats),
        el('td', { class: 'muted', style: 'max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: detailBits.join(' · ') }, detailBits.join(' · ') || '–'));
    });
    body.replaceChildren(el('div', { class: 'tablewrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows))));
  }

  await load();
  return wrap;
}

// ---- NIS2: Get-started guide (shown when there is no data yet) -------------
function nis2GetStarted() {
  const step = (n, title, desc, btn) => el('li', { class: 'nis2-gs-step' },
    el('span', { class: 'nis2-gs-num' }, String(n)),
    el('div', {}, el('strong', {}, title), el('div', { class: 'muted' }, desc), btn || null));
  const goto = (tab) => () => { nis2State.tab = tab; render(); };
  const card = el('div', { class: 'nis2-getstarted' },
    el('h3', {}, '👋 Get started with NIS2 reporting'),
    el('p', { class: 'muted' }, 'There is no data yet. Follow these steps to build up your NIS2 picture — or seed a set of starter controls (one per category) to begin from a baseline.'),
    el('ol', { class: 'nis2-gs-steps' },
      step(1, 'Add controls', 'Record your recurring assurance activities (one per NIS2 area) and attach evidence.',
        canWrite() ? el('button', { class: 'small', onclick: goto('controls') }, 'Go to Controls') : null),
      step(2, 'Build the risk register', 'Capture risks with likelihood × impact; the score and band are computed for you.',
        canWrite() ? el('button', { class: 'small', onclick: goto('risks') }, 'Go to Risk Register') : null),
      step(3, 'Log security events', 'Record events and flag the ones that may carry a NIS2 notification obligation.',
        canWrite() ? el('button', { class: 'small', onclick: goto('events') }, 'Go to Events') : null),
      step(4, 'Generate a report', 'Produce an executive/readiness report (PDF), or build a custom one in the Report Generator.',
        el('button', { class: 'small ghost', onclick: goto('reports') }, 'Go to Reports'))));
  if (canWrite()) {
    card.append(el('div', { class: 'nis2-gs-seed' },
      el('button', { class: 'small', onclick: () => nis2Seed() }, '✨ Seed starter controls'),
      el('span', { class: 'muted' }, 'Creates one baseline control per NIS2 category (status “Missing”) so you have something to evidence against.')));
  }
  return card;
}
async function nis2Seed() {
  if (!confirm('Create one starter control per NIS2 category? You can edit or delete them afterwards.')) return;
  try {
    const r = await api('/api/nis2/seed', { method: 'POST' });
    toast(`Seeded ${r.created} starter control(s)`);
    nis2State.tab = 'controls';
    render();
  } catch (err) { toast(errText(err), true); }
}

// ---- Report Generator (custom, selector-driven) ---------------------------
async function reportGenerator() {
  const { sources } = await api(withLocale('/api/nis2/custom-reports/sources'));
  const wrap = el('div', { class: 'rg' });
  wrap.append(el('p', { class: 'muted nis2-note' },
    'Build your own report: pick the sections to include, set filters and columns, then preview or export as PDF, CSV or JSON.'));

  // Report-level options.
  const titleInput = el('input', { type: 'text', placeholder: 'Custom Report', value: '' });
  const orgInput = el('input', { type: 'text', placeholder: 'Organisation', value: '' });
  const formatSel = el('select', {}, ...[['html', 'PDF (print)'], ['csv', 'CSV'], ['json', 'JSON']].map(([v, l]) => el('option', { value: v }, l)));
  wrap.append(el('div', { class: 'rg-opts' },
    el('label', {}, 'Report title', titleInput),
    el('label', {}, 'Organisation', orgInput),
    el('label', {}, 'Export format', formatSel)));

  // Per-source cards. Each tracks include + filter inputs + column checkboxes.
  const reg = []; // [{ source, includeCb, filterInputs:{key:node}, colChecks:{key:node} }]
  const cards = el('div', { class: 'rg-sources' });
  for (const src of sources) {
    const includeCb = el('input', { type: 'checkbox' });
    const filterInputs = {};
    const colChecks = {};

    const filterRow = el('div', { class: 'rg-filters' });
    for (const f of src.filters || []) {
      let input;
      if (f.type === 'enum') input = el('select', {}, ...f.options.map((o) => el('option', { value: o.value }, o.label)));
      else if (f.type === 'date') input = el('input', { type: 'date' });
      else if (f.type === 'number') input = el('input', { type: 'number', min: '0' });
      else input = el('input', { type: 'text' });
      filterInputs[f.key] = input;
      filterRow.append(el('label', { class: 'rg-filter' }, f.label, input));
    }

    const colRow = el('div', { class: 'rg-cols' });
    for (const c of src.columns || []) {
      const cb = el('input', { type: 'checkbox', ...(src.defaultColumns.includes(c.key) ? { checked: 'checked' } : {}) });
      colChecks[c.key] = cb;
      colRow.append(el('label', { class: 'rg-col' }, cb, c.label));
    }

    const card = el('div', { class: 'rg-card' },
      el('label', { class: 'rg-head' }, includeCb, el('strong', {}, src.label),
        src.adminOnly ? el('span', { class: 'badge neutral' }, 'admin') : null),
      el('div', { class: 'muted rg-desc' }, src.description),
      (src.filters && src.filters.length) ? filterRow : null,
      (src.columns && src.columns.length) ? el('details', { class: 'rg-coldetails' }, el('summary', {}, 'Columns'), colRow) : null);
    cards.append(card);
    reg.push({ source: src.key, includeCb, filterInputs, colChecks });
  }
  wrap.append(cards);

  // Build the spec from the current form state.
  function buildSpec() {
    const sectionsSel = [];
    for (const r of reg) {
      if (!r.includeCb.checked) continue;
      const filters = {};
      for (const [k, node] of Object.entries(r.filterInputs)) {
        if (node.value !== '' && node.value != null) filters[k] = node.value;
      }
      const columns = Object.entries(r.colChecks).filter(([, cb]) => cb.checked).map(([k]) => k);
      sectionsSel.push({ source: r.source, filters, columns });
    }
    return { title: titleInput.value || undefined, org: orgInput.value || undefined, format: formatSel.value, sections: sectionsSel };
  }

  const preview = el('div', { class: 'rg-preview' });
  const actions = el('div', { class: 'rg-actions' },
    el('button', { class: 'small', onclick: doPreview }, 'Preview'),
    el('button', { class: 'small', onclick: doExport }, '⤓ Export'));
  wrap.append(actions, preview);

  async function doPreview() {
    const spec = buildSpec();
    if (!spec.sections.length) { toast('Select at least one section', true); return; }
    preview.replaceChildren(el('div', { class: 'empty' }, 'Building preview…'));
    try {
      const report = await api(withLocale('/api/nis2/custom-reports/preview'), { method: 'POST', body: spec });
      preview.replaceChildren(renderRgPreview(report));
    } catch (err) { preview.replaceChildren(el('div', { class: 'empty error' }, errText(err))); }
  }

  async function doExport() {
    const spec = buildSpec();
    if (!spec.sections.length) { toast('Select at least one section', true); return; }
    try {
      const res = await fetch(withLocale('/api/nis2/custom-reports/export'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(spec),
      });
      if (!res.ok) { let m = `HTTP ${res.status}`; try { m = (await res.json()).error || m; } catch { /* ignore */ } throw new Error(m); }
      if (spec.format === 'html') {
        const html = await res.text();
        const w = window.open('', '_blank');
        if (!w) { toast('Pop-up blocked — allow pop-ups to export PDF', true); return; }
        w.document.open(); w.document.write(html); w.document.close(); w.focus();
        setTimeout(() => { try { w.print(); } catch { /* manual */ } }, 400);
      } else {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: spec.format === 'csv' ? 'custom-report.csv' : 'custom-report.json' });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (err) { toast(`Export failed: ${err.message}`, true); }
  }

  return wrap;
}

function renderRgPreview(report) {
  const out = el('div');
  out.append(el('div', { class: 'section-head' }, el('h3', { class: 'nis2-h3' }, report.title || 'Custom Report'),
    el('span', { class: 'muted' }, `Generated ${fmtDate(report.generatedAt)}`)));
  if (!report.sections.length) { out.append(el('div', { class: 'empty' }, 'No sections.')); return out; }
  for (const s of report.sections) {
    out.append(el('h4', { class: 'rg-sec-h' }, s.heading, s.truncated ? el('span', { class: 'muted' }, `  (showing first ${s.rows.length} of ${s.rowCount})`) : null));
    if (!s.rows.length) { out.append(el('div', { class: 'empty' }, 'No matching rows.')); continue; }
    const thead = el('thead', {}, el('tr', {}, ...s.headers.map((h) => el('th', {}, h))));
    const tbody = el('tbody', {}, ...s.rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, String(c ?? ''))))));
    out.append(el('div', { class: 'tablewrap' }, el('table', {}, thead, tbody)));
  }
  return out;
}

PAGE_INFO.reporting = {
  hero: 'Reporting — the NIS2 readiness module plus a Report Generator for building your own reports.',
  title: 'Reporting',
  body: () => [
    el('p', {}, 'Two ways to report:'),
    el('h4', {}, 'NIS2'),
    el('p', {}, 'A stationary module with fixed parameters: a readiness dashboard, risk register, control evidence, security events, generated management/executive reports and an audit trail.'),
    el('h4', {}, 'Report Generator'),
    el('p', {}, 'Build your own report from selectable sections (readiness summary, category status, risks, controls, events, and — for admins — the audit trail). Set per-section filters and choose the columns, then preview on screen or export as PDF, CSV or JSON.'),
    el('h4', {}, 'Inside NIS2 — Dashboard'),
    el('p', {}, 'A single readiness percentage (the mean of the ten category scores, each derived from its controls’ evidence health), plus headline counts and the top recommended actions.'),
    el('h4', {}, 'Risk register'),
    el('p', {}, 'Your inventory of cyber risks to the systems in scope, each scored likelihood × impact (1–25) and banded Low/Medium/High/Critical, with an owner and treatment status. NIS2 (Article 21) requires risk-based security measures — this register is the evidence that risks are identified, assessed and being treated. Export to CSV or PDF.'),
    el('h4', {}, 'Controls'),
    el('p', {}, 'The recurring technical and organisational security measures you operate (backups, patching, access reviews, logging…), each tied to a NIS2 area with an owner, a cadence and an evidence reference. NIS2 (Article 21) requires these measures to be kept effective; the evidence is what an auditor asks for, so controls lacking it — or marked Missing/Overdue — are flagged.'),
    el('h4', {}, 'Events'),
    el('p', {}, 'Security events you record by hand (distinct from the network events derived automatically from probes), with timeline, impact and root cause. Flag “notification required” for a significant event — NIS2 (Article 23) then obliges you to alert the national CSIRT/authority within 24 hours, file a full notification within 72 hours and a final report within one month.'),
    el('h4', {}, 'Reports & audit'),
    el('p', {}, 'Generate snapshot reports (the frozen metrics let the next report show the trend). Reports are approved by an admin/compliance role. Every change to a risk, control or event is written to the audit trail.'),
    el('p', { class: 'muted' }, 'PDF export opens a clean, print-ready document — use your browser’s “Save as PDF”.'),
    el('h4', {}, 'Audit (admin only)'),
    el('p', {}, 'A server-wide audit trail: which user did what (login, and every create/update/delete) and what each agent performed (traffic measurements, probes) — each with when, who and what. Repeated activity such as continuous reporting or scheduled probes is recorded once and annotated “Repeats every …” rather than spamming the log. Visible only to administrators; exportable to CSV.'),
  ],
};

PAGE_INFO.logs = {
  hero: 'System Logs — the live server diagnostic stream (agent connects, WebSocket/DB errors, HTTP failures) merged with the dashboard errors you were shown. In-memory: cleared when the server restarts.',
  title: 'System Logs — operational diagnostics',
  body: () => [
    el('p', {}, 'This is the operational/diagnostic stream — the same lines the server writes to its console (', el('code', {}, 'docker compose logs'), ') — kept in an in-memory ring buffer (the most recent ~1000 records) so you can read them here without shell access. It is merged with client-side failures: any error a dashboard action showed you (e.g. “Agent not connected”) is captured here too, so a toast that flashed past can still be found.'),
    el('p', {}, el('strong', {}, 'This is the system half of the Logs menu. '), 'What people did — logins, create/update/delete, and anything that looks wrong — is the other half: ', viewLink('userLogs', 'User Logs'), '. That record is durable; this one is ephemeral and resets on restart.'),
    el('h4', {}, 'Filters'),
    el('ul', {},
      el('li', {}, el('strong', {}, 'Level '), '— show a minimum severity (Errors only, Warn+, …).'),
      el('li', {}, el('strong', {}, 'Source '), '— Server (the diagnostic stream) or Dashboard (browser-side action failures).'),
      el('li', {}, el('strong', {}, 'Search '), '— free-text match over the message and its structured detail.')),
    el('p', { class: 'muted' }, 'Admin-only: operational logs can contain internal detail (hostnames, error messages, request ids).'),
  ],
};

PAGE_INFO.userLogs = {
  hero: 'User Logs — the audit log: every action a person performed on this server, which account, when, and a flag on anything that looks wrong.',
  title: 'User Logs — the audit log: who did what',
  body: () => [
    el('p', {}, 'The durable record of human activity on this server \u2014 this is the audit log. One row per action, with the account behind it (', el('strong', {}, 'user id'), ', name and e-mail), the ', el('strong', {}, 'time'), ' it happened, and the ', el('strong', {}, 'action'), ' in plain language with the raw action key and the request underneath it.'),
    el('p', {}, el('strong', {}, 'This is not the system log. '), 'The server\u2019s own diagnostic stream lives in ', viewLink('logs', 'System Logs'), ' and is cleared on restart. This view is drawn from the audit stores and survives restarts.'),
    el('h4', {}, 'Where the rows come from'),
    el('p', {}, 'Two stores, merged: the automatic capture of every state-changing request (login, and each create/update/delete), and the hash-chained trail that also records sign-ins, licence actions and API-token management. Both are read on every plan \u2014 an audit list that drops rows depending on what you bought is one nobody can trust. What the Professional licence adds is the compliance API on top of the same rows (chain verification and the category/actor query surface), not permission to see your own users\u2019 activity.'),
    el('h4', {}, 'The flags'),
    el('p', {}, 'A flag means \u201cworth a look\u201d, not \u201csomeone did wrong\u201d. Each one states its own reason on the row, so nothing is marked for a rule you cannot read:'),
    el('ul', {},
      el('li', {}, el('span', { class: 'badge crit' }, 'Needs attention'), ' \u2014 the action was refused because the role did not allow it, or the account failed to sign in three times inside fifteen minutes.'),
      el('li', {}, el('span', { class: 'badge warn' }, 'Did not work'), ' \u2014 the server rejected it (4xx) or failed while doing it (5xx). A 5xx is the one to check twice: the action may be half-applied.'),
      el('li', {}, el('span', { class: 'badge neutral' }, 'Worth a look'), ' \u2014 it worked, and it was either irreversible (a delete, a reset, a revoke) or it changed access and trust (accounts, roles, tokens, licence, sign-in configuration). Also a sign-in from an address the account has not used elsewhere in the list.')),
    el('h4', {}, 'Filters and export'),
    el('ul', {},
      el('li', {}, el('strong', {}, 'User '), '\u2014 one account. The dropdown lists every account that exists now, so you can pick someone with no rows in view.'),
      el('li', {}, el('strong', {}, 'Flagged only '), '\u2014 drop everything that ran cleanly.'),
      el('li', {}, el('strong', {}, 'Search '), '\u2014 free text over the name, e-mail, action, target and address.'),
      el('li', {}, el('strong', {}, 'CSV '), '\u2014 the rows as filtered, flag level and reasons included, for a review that has to leave the product.')),
    el('p', { class: 'muted' }, 'Admin-only. Names come from the account as it is now, while the e-mail is the one recorded at the time \u2014 so a renamed user reads correctly and a deleted one still shows the address that acted, marked \u201caccount deleted since\u201d. Set names in Settings \u2192 Users.'),
  ],
};

PAGE_INFO.transactions = {
  hero: 'Transaction tests — http/tcp/dns/icmp run from assigned agents on an interval, with latency, baseline deviation, and failure diagnosis per step.',
  title: 'Transaction tests',
  body: () => [
    el('p', {}, 'A transaction test runs from selected agents on its own interval. HTTP tests are a sequence of steps (method, URL, headers, body) that can validate the status code and a keyword, and extract values (regex/JSON-path/cookie) for subsequent steps. Secrets are referenced as ', el('span', { class: 'mono' }, '{{secret:name}}'), ' — they are write-only and never shown again.'),
    el('h4', {}, 'Matrix'), el('p', {}, 'Agents × tests with the latest status as a coloured cell. An arrow (↑/↓) shows that the latest run deviated from the baseline (slower/faster).'),
    el('h4', {}, 'Time heatmap'), el('p', {}, 'Pure SVG: X = time buckets (5m/15m/1h), Y = agents. Colour reflects average latency (green→yellow→red); dark cells = failures. Tooltip: avg latency, failures, runs.'),
    el('h4', {}, 'Trend per step'), el('p', {}, 'Median per day per step over 7/30 days. The line for the whole test is dashed.'),
    el('h4', {}, 'Diagnosis'), el('p', {}, 'Failures are shown with a readable diagnosis based on the failure phase (DNS, connect, TLS, HTTP status, keyword, timeout) — same text as the server alerts.'),
  ],
};

// ---- Transaction tests ------------------------------------------------------
// Phase → diagnosis. MUST match src/analysis/transactionAlerts.js so the
// UI diagnosis and the server alert text read identically.
const TX_PHASE_LABELS = {
  dns: 'DNS lookup failed — the hostname could not be resolved',
  connect: 'TCP connection failed — network, firewall, or host down',
  tls: 'TLS handshake failed — certificate or protocol problem',
  http_status: 'Unexpected HTTP status code',
  keyword: 'Response was missing the expected content',
  timeout: 'The step timed out',
  error: 'The test could not be run',
};
const TX_TYPES = ['http', 'tcp', 'dns', 'icmp'];
const TX_DNS_RECORDS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'PTR', 'SRV'];
const TX_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const TX_STATUS_COLOR = { ok: '#2e7d32', fail: '#c62828', timeout: '#e65100', error: '#6a1b9a' };

function txDiagnose(detail, status) {
  const d = detail && typeof detail === 'object' ? detail : {};
  if (status === 'ok') return 'OK';
  const base = TX_PHASE_LABELS[d.phase] || `Failed (${status || 'unknown'})`;
  const step = d.step != null ? ` (step ${d.step})` : '';
  const errno = d.errno ? ` [${d.errno}]` : '';
  return `${base}${step}${errno}`;
}
function txDeviationArrow(dev) {
  if (dev === 'slower') return el('span', { class: 'tx-arrow', title: 'Slower than baseline', style: 'color:#e65100' }, ' ↑');
  if (dev === 'faster') return el('span', { class: 'tx-arrow', title: 'Faster than baseline', style: 'color:#1565c0' }, ' ↓');
  return null;
}
function txAgentName(agents, id) { const a = agents.find((x) => x.id === id); return a ? (a.display_name || a.hostname || `#${id}`) : `#${id}`; }

// Heatmap cell colour: dark red on fails, else green→yellow→red by avg latency.
function txHeatColor(cell, maxLatency) {
  if (cell.fail_count > 0) return '#3a0d0d';
  if (cell.avg_latency == null) return 'var(--panel-2, #eee)';
  const t = Math.max(0, Math.min(1, cell.avg_latency / (maxLatency || 1)));
  return `hsl(${120 - Math.round(120 * t)}, 62%, 45%)`;
}

// Swaps a container's content, catching errors (incl. 404 for an unknown test)
// into a tidy error panel so the UI never crashes.
async function txMount(host, builder) {
  host.replaceChildren(el('div', { class: 'muted' }, 'Loading …'));
  try {
    host.replaceChildren(await builder());
  } catch (e) {
    const msg = e && e.status === 404 ? 'The transaction test does not exist (perhaps deleted).' : (errText ? errText(e) : e.message);
    host.replaceChildren(el('div', { class: 'error' }, msg));
  }
}

let txTab = 'list';
// BlueEye Service Assurance — the module lives in public/serviceAssurance.js and
// is handed the shared helpers here, so it never reaches into app.js globals.
// That is the same seam the backend keeps (docs/service-assurance.md §2).
// ---- Service Assurance (SHELL MIGRATED — see public/views/serviceAssurance.js)
// The eight tab bodies stay in public/serviceAssurance.js; the page they sit on
// is the contract's.
let serviceAssurancePage = null;

function mountServiceAssurance() {
  if (!window.ServiceAssurance) return null;
  return window.ServiceAssurance.create({
    el, api, t, dataCard, toast,
    isAdmin,
    isOperator: canWrite,
    // Which of the module's screens the nav entry asked for.
    tab: serviceAssuranceTab,
    // An <img src> cannot carry the Authorization header this dashboard
    // authenticates with, so a screenshot loaded that way arrives anonymous and
    // answers 401 — which the browser renders as a broken image. Fetched here
    // with the header and handed over as an object URL, the same way the CSV
    // export already does it.
    apiBlob: async (path) => {
      const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) {
        let msg; try { msg = (await res.json()).error; } catch { /* non-JSON body */ }
        throw new Error(msg || `HTTP ${res.status}`);
      }
      return URL.createObjectURL(await res.blob());
    },
    // "No worker is connected" is only useful if it says where to look.
    openDocs: () => gotoDocs('assurance-worker'),
    // "This should be a warning for us" is a thought people have while looking
    // at the incident, not while sitting in Settings later trying to remember
    // what it said. The module describes the incident; the form lives here with
    // the rest of the severity-rule screens.
    editSeverityRule: (prefill) => editSeverityRule(null, prefill),
    // The host draws the page header and the tab strip; the module draws the
    // body. Without this the module owns its own shell, which is how it ships
    // standalone.
    mode: 'embedded',
  });
}

function getServiceAssurancePage() {
  if (serviceAssurancePage) return serviceAssurancePage;
  if (typeof window === 'undefined' || !window.ServiceAssurancePage || !ui) return null;
  serviceAssurancePage = window.ServiceAssurancePage.create({
    el, t, ui,
    mount: mountServiceAssurance,
    setTab: (tab) => { serviceAssuranceTab = tab; syncLocation(); },
    help: () => {
      const info = PAGE_INFO.serviceAssurance || {};
      return { lead: info.hero || '', title: info.title || t('sa.title'), body: info.body || (() => []) };
    },
  });
  return serviceAssurancePage;
}

views.serviceAssurance = async () => {
  const v = getServiceAssurancePage();
  if (!v) return el('div', { class: 'empty error' }, t('sa.err.load'));
  // The module is rebuilt per view entry (it holds the open detail), so the
  // page is too.
  serviceAssurancePage = null;
  return getServiceAssurancePage().view();
};

// The in-app guides (nav group: Guides).
//
// Five next-next walkthroughs — Monitoring, Fleet, Diagnostics, Service
// Assurance, Insights — of what to do, in what order, and which VALUES to put
// in each field. Their own module in public/guides.js, handed the same shared
// helpers Service Assurance itself gets, plus the deep links it needs so every
// step can open the screen it is describing.
// ---- Guides (SHELL MIGRATED — see public/views/guides.js)
// The five walkthroughs stay in public/guides.js, which ships standalone; the
// page they sit on is the contract's.
function mountGuides() {
  if (!window.Guides) return null;
  return window.Guides.create({
    el, api, t, toast,
    // Counted lines pick their own singular/plural form.
    plural: (key, n, params) => (window.I18n && window.I18n.plural ? window.I18n.plural(key, n, params) : t(key, { count: String(n), ...(params || {}) })),
    isAdmin,
    isOperator: canWrite,
    // Which of the five guides the nav entry asked for.
    track: guideTrack,
    // A step that names a screen the reader cannot open says so, rather than
    // offering a button that lands them somewhere else.
    viewBlockedReason,
    // Every step can open the screen it is describing. A plain view, a Service
    // Assurance sub-tab, a Settings sub-tab, or a handbook article.
    openView: (viewKey) => gotoView(viewKey),
    openTab: (tab) => { serviceAssuranceTab = tab; currentView = 'serviceAssurance'; render(); },
    openSettings: (tab) => { settingsTab = tab; currentView = 'settings'; render(); },
    openDocs: (topic) => gotoDocs(topic),
    // The host draws the heading, the state advisory and the Back/Next row.
    mode: 'embedded',
  });
}

views.guide = async () => {
  if (typeof window === 'undefined' || !window.GuidesPage || !ui) {
    return el('div', { class: 'empty error' }, t('guide.unavailable'));
  }
  const v = window.GuidesPage.create({
    el, t, ui,
    mount: mountGuides,
    help: () => {
      const info = PAGE_INFO.guide || {};
      return { title: info.title || t('guide.title.monitoring'), body: info.body || (() => []) };
    },
  });
  // Each entry builds a fresh module (it holds the track and the step), so the
  // page is built fresh too.
  return v.view() || el('div', { class: 'empty error' }, t('guide.unavailable'));
};

// About (account menu → About).
//
// What this build is, and what the product grew into: the version this host
// runs, and a dated feature history grouped by month. The history itself lives
// in public/about.js — one line per thing that changed what the product can do,
// with the version it shipped in and the date that version landed.
//
// The build line is read from GET /system/version (viewer+, the same call that
// stamps the sidebar foot). A 403/404/500 there costs the version line, never
// the page: the history is the point and the live build is the garnish.
PAGE_INFO.about = {
  get hero() { return t('about.info.hero'); },
  get title() { return t('about.info.title'); },
  body: () => [
    el('p', {}, t('about.info.p1')),
    el('p', {}, t('about.info.p2')),
    el('p', { class: 'muted' }, t('about.info.p3')),
  ],
};

views.about = async () => {
  if (!window.About) return el('div', { class: 'empty' }, t('about.unavailable'));
  const ver = await api('/system/version').catch(() => null);
  return window.About.create({
    el,
    t,
    plural: (key, n, params) => (window.I18n && window.I18n.plural ? window.I18n.plural(key, n, params) : t(key, { count: String(n), ...(params || {}) })),
    locale: window.I18n ? window.I18n.getLocale() : 'en',
    version: ver && ver.server ? ver.server : null,
    releaseDate: ver && ver.releaseDate ? ver.releaseDate : null,
  });
};

// ---- Transaction tests (MIGRATED — see public/views/transactions.js) --------
// A SHELL migration: the create/edit form, the matrix and the per-test detail
// are ~350 lines with their own machinery and are passed in whole.
let transactionsPage = null;
const transactionsPageState = {};
let txRenderList = null;
function txListView(host) {
  return txRenderList ? txRenderList(host) : el('div', { class: 'empty' }, t('tx.none'));
}

function getTransactionsPage() {
  if (transactionsPage) return transactionsPage;
  if (typeof window === 'undefined' || !window.TransactionsPage || !ui) return null;
  transactionsPage = window.TransactionsPage.create({
    el, t, ui,
    state: transactionsPageState,
    isAdmin,
    tab: () => txTab,
    setTab: (k) => { txTab = k; syncLocation(); },
    help: () => {
      const info = PAGE_INFO.transactions || {};
      return { lead: info.hero || '', title: info.title || t('tx.title'), body: info.body || (() => []) };
    },
    fetchTests: async () => api('/api/transactions'),
    // The unmigrated builders navigate back to the list, which is the view's
    // now — so it hands it over and txListView() forwards to it.
    exposeList: (fn) => { txRenderList = fn; },
    mount: txMount,
    form: txForm,
    matrix: txMatrixView,
    detail: txDetailView,
    remove: txDelete,
  });
  return transactionsPage;
}

views.transactions = async () => {
  const v = getTransactionsPage();
  if (!v) return el('div', { class: 'empty error' }, t('tx.err.title'));
  return v.view();
};

async function txDelete(test, host) {
  if (!confirm(`Delete transaction test "${test.name}"?`)) return;
  try { await api(`/api/transactions/${test.id}`, { method: 'DELETE' }); toast('Deleted'); txMount(host, () => txListView(host)); }
  catch (e) { toast(errText(e), true); }
}

// Create/edit form (view-based, so the multi-step editor + secrets + agent
// assignment fit). Admin-only; the server also enforces RBAC.
async function txForm(test, host) {
  const agents = await api('/agents').catch(() => []);
  const isEdit = !!test;
  const model = test ? JSON.parse(JSON.stringify(test)) : { name: '', type: 'http', target: '', config: { steps: [{ method: 'GET', url: '' }] }, interval_sec: 60, enabled: true, agent_ids: [], secret_names: [] };
  model.config = model.config || {};
  const newSecrets = {}; // write-only: name -> value

  const nameIn = el('input', { type: 'text', value: model.name });
  const typeSel = el('select', {}, ...TX_TYPES.map((t) => el('option', { value: t, ...(t === model.type ? { selected: 'selected' } : {}) }, t)));
  const targetIn = el('input', { type: 'text', value: model.target || '', placeholder: 'host / URL' });
  const intervalIn = el('input', { type: 'number', value: model.interval_sec || 60, min: 5 });
  const enabledIn = el('input', { type: 'checkbox', ...(model.enabled ? { checked: 'checked' } : {}) });
  const cfgHost = el('div', { class: 'tx-config' });
  const thr = (model.config.thresholds) || {};
  const consecIn = el('input', { type: 'number', value: thr.consecutive_fails ?? '', min: 1, placeholder: 'fx 3' });
  const latIn = el('input', { type: 'number', value: thr.latency_ms ?? '', min: 1, placeholder: 'ms' });
  const devSel = el('select', {}, ...[['', '—'], ['slower', 'slower'], ['faster', 'faster'], ['any', 'any']].map(([v, l]) => el('option', { value: v, ...(v === (thr.deviation || '') ? { selected: 'selected' } : {}) }, l)));

  // http multi-step editor
  const stepsHost = el('div', { class: 'tx-steps' });
  function stepRow(s) {
    const methodSel = el('select', {}, ...TX_METHODS.map((m) => el('option', { value: m, ...(m === (s.method || 'GET') ? { selected: 'selected' } : {}) }, m)));
    const nameI = el('input', { type: 'text', value: s.name || '', placeholder: 'name' });
    const urlI = el('input', { type: 'text', value: s.url || '', placeholder: 'https://… ({{secret:x}}/{{var}})' });
    const headersI = el('textarea', { rows: 2, placeholder: 'Header: value per line' }, s.headers ? Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '');
    const bodyI = el('textarea', { rows: 2, placeholder: 'body' }, s.body || '');
    const statusI = el('input', { type: 'number', value: s.expect_status ?? '', placeholder: 'expect status' });
    const kwI = el('input', { type: 'text', value: s.expect_keyword || '', placeholder: 'expect keyword' });
    const exNameI = el('input', { type: 'text', value: s.extract && s.extract.name || '', placeholder: 'extract name' });
    const exTypeSel = el('select', {}, ...['regex', 'json', 'cookie'].map((t) => el('option', { value: t, ...(s.extract && s.extract.type === t ? { selected: 'selected' } : {}) }, t)));
    const exPatI = el('input', { type: 'text', value: s.extract && s.extract.pattern || '', placeholder: 'pattern / path / cookie' });
    const row = el('div', { class: 'tx-step-row' },
      el('div', { class: 'tx-step-line' }, methodSel, nameI, urlI, el('button', { type: 'button', class: 'ghost small danger', title: 'Delete', onclick: () => { row.remove(); } }, icon('trash'))),
      el('div', { class: 'tx-step-line' }, headersI, bodyI),
      el('div', { class: 'tx-step-line' }, statusI, kwI, exNameI, exTypeSel, exPatI));
    row._collect = () => {
      const headers = {};
      String(headersI.value || '').split('\n').forEach((ln) => { const i = ln.indexOf(':'); if (i > 0) headers[ln.slice(0, i).trim()] = ln.slice(i + 1).trim(); });
      const step = { method: methodSel.value, url: urlI.value.trim() };
      if (nameI.value.trim()) step.name = nameI.value.trim();
      if (Object.keys(headers).length) step.headers = headers;
      if (bodyI.value) step.body = bodyI.value;
      if (statusI.value) step.expect_status = Number(statusI.value);
      if (kwI.value) step.expect_keyword = kwI.value;
      if (exNameI.value.trim() && exPatI.value) step.extract = { name: exNameI.value.trim(), type: exTypeSel.value, pattern: exPatI.value };
      return step;
    };
    return row;
  }
  function renderConfig() {
    cfgHost.replaceChildren();
    stepsHost.replaceChildren();
    const type = typeSel.value;
    targetIn.parentElement && (targetIn.closest('label').style.display = type === 'http' ? 'none' : '');
    if (type === 'http') {
      (model.config.steps && model.config.steps.length ? model.config.steps : [{ method: 'GET', url: '' }]).forEach((s) => stepsHost.append(stepRow(s)));
      cfgHost.append(el('label', {}, 'HTTP steps'), stepsHost, el('button', { type: 'button', class: 'ghost small', onclick: () => stepsHost.append(stepRow({ method: 'GET', url: '' })) }, '+ Step'));
    } else if (type === 'tcp') {
      cfgHost.append(el('label', {}, 'Port', el('input', { type: 'number', id: 'tx-port', value: model.config.port || '', min: 1, max: 65535 })));
    } else if (type === 'dns') {
      cfgHost.append(el('label', {}, 'Record', el('select', { id: 'tx-record' }, ...TX_DNS_RECORDS.map((r) => el('option', { value: r, ...(r === (model.config.record || 'A') ? { selected: 'selected' } : {}) }, r)))),
        el('label', {}, 'Expected response (optional)', el('input', { type: 'text', id: 'tx-expect', value: model.config.expect || '' })));
    }
  }
  typeSel.addEventListener('change', renderConfig);

  // Agent assignment (checkboxes)
  const agentChecks = agents.map((a) => {
    const cb = el('input', { type: 'checkbox', value: String(a.id), ...((model.agent_ids || []).includes(a.id) ? { checked: 'checked' } : {}) });
    cb._id = a.id;
    return el('label', { class: 'tx-agent' }, cb, ` ${a.display_name || a.hostname || a.id}`);
  });

  // Secrets (write-only): existing shown as "sat" chips + add new name/value rows.
  const secretsHost = el('div', { class: 'tx-secrets' });
  (model.secret_names || []).forEach((n) => secretsHost.append(el('span', { class: 'chip', title: 'Set (hidden)' }, `${n} ✓`)));
  const newSecHost = el('div', {});
  function addSecretRow() {
    const nI = el('input', { type: 'text', placeholder: 'name' });
    const vI = el('input', { type: 'password', placeholder: 'value (write-only)' });
    const r = el('div', { class: 'tx-secret-row' }, nI, vI, el('button', { type: 'button', class: 'ghost small danger', title: 'Delete', onclick: () => r.remove() }, icon('trash')));
    r._collect = () => (nI.value.trim() ? { name: nI.value.trim(), value: vI.value } : null);
    newSecHost.append(r);
  }

  const errP = el('p', { class: 'error' });
  const form = el('div', { class: 'form-grid' },
    el('label', {}, 'Name', nameIn),
    el('label', {}, 'Type', typeSel),
    el('label', {}, 'Target (host)', targetIn),
    cfgHost,
    el('label', {}, 'Interval (sec)', intervalIn),
    el('label', { class: 'tx-inline' }, enabledIn, ' Active'),
    el('h4', {}, 'Alert thresholds'),
    el('div', { class: 'tx-thresholds' },
      el('label', {}, 'Consecutive failures', consecIn),
      el('label', {}, 'Latency (ms)', latIn),
      el('label', {}, 'Deviation', devSel)),
    el('h4', {}, 'Secrets'), el('div', { class: 'muted' }, 'Write-only — values are never shown again, only name + ✓.'), secretsHost, newSecHost,
    el('button', { type: 'button', class: 'ghost small', onclick: addSecretRow }, '+ Secret'),
    el('h4', {}, 'Agents'), el('div', { class: 'tx-agents' }, ...(agentChecks.length ? agentChecks : [el('div', { class: 'muted' }, 'No agents.')])),
    errP,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'ghost', onclick: () => txMount(host, () => txListView(host)) }, 'Cancel'),
      el('button', { type: 'button', class: 'primary', onclick: save }, isEdit ? 'Save' : 'Create')));

  async function save() {
    errP.textContent = '';
    const type = typeSel.value;
    const config = {};
    if (type === 'http') config.steps = [...stepsHost.querySelectorAll('.tx-step-row')].map((r) => r._collect()).filter((s) => s.url);
    else if (type === 'tcp') config.port = Number(cfgHost.querySelector('#tx-port') && cfgHost.querySelector('#tx-port').value);
    else if (type === 'dns') { config.record = cfgHost.querySelector('#tx-record').value; const ex = cfgHost.querySelector('#tx-expect').value; if (ex) config.expect = ex; }
    const thresholds = {};
    if (consecIn.value) thresholds.consecutive_fails = Number(consecIn.value);
    if (latIn.value) thresholds.latency_ms = Number(latIn.value);
    if (devSel.value) thresholds.deviation = devSel.value;
    if (Object.keys(thresholds).length) config.thresholds = thresholds;
    const secrets = {};
    [...newSecHost.querySelectorAll('.tx-secret-row')].forEach((r) => { const s = r._collect(); if (s) secrets[s.name] = s.value; });
    const payload = { name: nameIn.value.trim(), type, target: targetIn.value.trim() || null, config, interval_sec: Number(intervalIn.value) || 60, enabled: enabledIn.checked };
    if (Object.keys(secrets).length) payload.secrets = secrets;
    const agentIds = agentChecks.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c._id);
    try {
      const saved = isEdit ? await api(`/api/transactions/${test.id}`, { method: 'PUT', body: payload }) : await api('/api/transactions', { method: 'POST', body: payload });
      await api(`/api/transactions/${saved.id}/agents`, { method: 'PUT', body: { agent_ids: agentIds } });
      toast('Saved');
      txMount(host, () => txListView(host));
    } catch (e) { errP.textContent = errText(e); }
  }

  renderConfig();
  return el('div', { class: 'tx-form' }, el('h3', {}, isEdit ? 'Edit transaction test' : 'New transaction test'), form);
}

// Matrix: agents × tests, latest status as a coloured cell (+ deviation arrow).
async function txMatrixView(host) {
  const [tests, agents] = await Promise.all([api('/api/transactions'), api('/agents').catch(() => [])]);
  if (!tests.length) return el('div', { class: 'empty' }, 'No transaction tests yet.');
  // Latest result per (test, agent) from each test's recent results.
  const latest = {}; // `${testId}:${agentId}` -> result
  await Promise.all(tests.map(async (t) => {
    try {
      const { results } = await api(`/api/transactions/${t.id}/results`);
      for (const r of results) { const k = `${t.id}:${r.agent_id}`; if (!latest[k]) latest[k] = r; }
    } catch { /* skip a test that fails to load */ }
  }));
  const agentIds = [...new Set(Object.keys(latest).map((k) => Number(k.split(':')[1])))].sort((a, b) => a - b);
  if (!agentIds.length) return el('div', { class: 'empty' }, 'No results yet.');
  const header = el('tr', {}, el('th', {}, 'Test'), ...agentIds.map((id) => el('th', {}, txAgentName(agents, id))));
  const rows = tests.map((t) => el('tr', {},
    el('td', { class: 'clickable', onclick: () => txMount(host, () => txDetailView(t.id, host)) }, t.name),
    ...agentIds.map((aid) => {
      const r = latest[`${t.id}:${aid}`];
      if (!r) return el('td', { class: 'tx-cell', style: 'background:var(--panel-2,#eee)' }, '');
      return el('td', { class: 'tx-cell clickable', title: `${r.status} · ${r.latency_ms ?? '?'} ms · ${txDiagnose(r.detail, r.status)}`, style: `background:${TX_STATUS_COLOR[r.status] || '#777'};color:#fff`, onclick: () => txMount(host, () => txDetailView(t.id, host)) },
        r.latency_ms != null ? `${r.latency_ms}ms` : r.status, txDeviationArrow(r.deviation));
    })));
  return el('div', { class: 'tx-matrix-wrap', style: 'overflow-x:auto' }, el('table', { class: 'data-table tx-matrix' }, el('thead', {}, header), el('tbody', {}, ...rows)));
}

// Per-test detail: SVG time-heatmap + per-step trend + recent results/diagnosis.
async function txDetailView(id, host) {
  const test = await api(`/api/transactions/${id}`); // throws 404 -> txMount shows a tidy error
  const agents = await api('/agents').catch(() => []);
  const root = el('div', { class: 'tx-detail' });
  root.append(el('button', { class: 'ghost small', onclick: () => txMount(host, () => txListView(host)) }, '← Back'),
    el('h3', {}, test.name, ' ', el('span', { class: 'chip' }, test.type), test.target ? el('span', { class: 'muted' }, ` · ${test.target}`) : null));

  // Heatmap with a bucket selector.
  const bucketSel = el('select', {}, ...[['5m', '5 min'], ['15m', '15 min'], ['1h', '1 hour']].map(([v, l]) => el('option', { value: v }, l)));
  const heatHost = el('div', {});
  async function drawHeat() {
    try {
      const { rows } = await api(`/api/transactions/${id}/heatmap?bucket=${bucketSel.value}`);
      heatHost.replaceChildren(txHeatmapSvg(rows, agents));
    } catch (e) { heatHost.replaceChildren(el('div', { class: 'error' }, errText(e))); }
  }
  bucketSel.addEventListener('change', drawHeat);
  root.append(el('div', { class: 'section-head' }, el('h4', {}, 'Time heatmap'), bucketSel), heatHost);

  // Trend per step (per agent, with day range).
  const agentSel = el('select', {}, ...(test.agent_ids || []).map((aid) => el('option', { value: aid }, txAgentName(agents, aid))));
  const daysSel = el('select', {}, ...[['7', '7 days'], ['30', '30 days']].map(([v, l]) => el('option', { value: v }, l)));
  const trendHost = el('div', {});
  async function drawTrend() {
    if (!agentSel.value) { trendHost.replaceChildren(el('div', { class: 'muted' }, 'Assign an agent to see the trend.')); return; }
    try {
      const { rows } = await api(`/api/transactions/${id}/trend?agent_id=${agentSel.value}&days=${daysSel.value}`);
      trendHost.replaceChildren(txTrendSvg(rows));
    } catch (e) { trendHost.replaceChildren(el('div', { class: 'error' }, errText(e))); }
  }
  agentSel.addEventListener('change', drawTrend);
  daysSel.addEventListener('change', drawTrend);
  root.append(el('div', { class: 'section-head' }, el('h4', {}, 'Trend per step'), agentSel, daysSel), trendHost);

  // Recent results + diagnosis.
  const resHost = el('div', {});
  try {
    const { results } = await api(`/api/transactions/${id}/results`);
    const recent = results.slice(0, 15);
    resHost.replaceChildren(recent.length ? el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {}, ...['Time', 'Agent', 'Status', 'Latency', 'Diagnosis'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...recent.map((r) => el('tr', {},
        el('td', {}, new Date(r.time).toLocaleString('en-GB')),
        el('td', {}, txAgentName(agents, r.agent_id)),
        el('td', {}, el('span', { style: `color:${TX_STATUS_COLOR[r.status] || '#777'};font-weight:600` }, r.status), txDeviationArrow(r.deviation)),
        el('td', {}, r.latency_ms != null ? `${r.latency_ms} ms` : '—'),
        el('td', { class: r.status === 'ok' ? 'muted' : '' }, txDiagnose(r.detail, r.status)))))) : el('div', { class: 'empty' }, 'No results yet.'));
  } catch (e) { resHost.replaceChildren(el('div', { class: 'error' }, errText(e))); }
  root.append(el('h4', {}, 'Latest results'), resHost);

  // Network path for this test run: the shared Path Visualization, sourced from
  // the first assigned agent to the test's target. Shows the path graph +
  // brushable metric timeline when traceroute data to that target exists.
  const pathSrc = (test.agent_ids || [])[0];
  if (test.target && pathSrc != null) {
    const pathHost = el('div', {});
    root.append(el('div', { class: 'section-head' }, el('h4', {}, 'Network path')), pathHost);
    (async () => {
      try { pathHost.replaceChildren(await pathVisualization({ sourceId: pathSrc, targetId: test.target, testId: id })); }
      catch (e) { pathHost.replaceChildren(el('div', { class: 'error' }, errText(e))); }
    })();
  }

  drawHeat(); drawTrend();
  return root;
}

// Pure SVG heatmap: X = time buckets, Y = agents. Colour by avg latency; dark on fails.
function txHeatmapSvg(rows, agents) {
  if (!rows || !rows.length) return el('div', { class: 'empty' }, 'No data in the period.');
  const buckets = [...new Set(rows.map((r) => r.bucket))].sort((a, b) => a - b);
  const agentIds = [...new Set(rows.map((r) => r.agent_id))].sort((a, b) => a - b);
  const maxLat = Math.max(1, ...rows.map((r) => r.avg_latency || 0));
  const cell = 18; const padL = 120; const padT = 4;
  const w = padL + buckets.length * cell; const h = padT + agentIds.length * cell + 20;
  const svg = [`<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">`];
  agentIds.forEach((aid, y) => {
    svg.push(`<text x="0" y="${padT + y * cell + 13}" font-size="11" fill="currentColor">${esc(txAgentName(agents, aid)).slice(0, 18)}</text>`);
    buckets.forEach((b, x) => {
      const c = rows.find((r) => r.agent_id === aid && r.bucket === b);
      if (!c) return;
      const title = `avg ${c.avg_latency ?? '?'} ms · ${c.fail_count} failures · ${c.sample_count} runs`;
      svg.push(`<rect x="${padL + x * cell}" y="${padT + y * cell}" width="${cell - 1}" height="${cell - 1}" fill="${txHeatColor(c, maxLat)}"><title>${esc(title)}</title></rect>`);
    });
  });
  svg.push('</svg>');
  const wrap = el('div', { class: 'tx-heat', style: 'overflow-x:auto' });
  wrap.innerHTML = svg.join('');
  return wrap;
}

// Pure SVG trend: one polyline per step, median per day. step 0 dashed = baseline
// reference is implied by the whole-test line; each step is a separate series.
function txTrendSvg(rows) {
  if (!rows || !rows.length) return el('div', { class: 'empty' }, 'No ok results in the period.');
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const steps = [...new Set(rows.map((r) => r.step))].sort((a, b) => a - b);
  const maxMs = Math.max(1, ...rows.map((r) => r.median_ms || 0));
  const w = 560; const h = 200; const padL = 44; const padB = 24; const padT = 8;
  const xOf = (d) => padL + (days.length <= 1 ? 0 : (days.indexOf(d) / (days.length - 1)) * (w - padL - 8));
  const yOf = (v) => padT + (1 - v / maxMs) * (h - padT - padB);
  const palette = ['#1565c0', '#2e7d32', '#e65100', '#6a1b9a', '#00838f', '#c62828'];
  const svg = [`<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">`];
  svg.push(`<line x1="${padL}" y1="${h - padB}" x2="${w - 8}" y2="${h - padB}" stroke="currentColor" opacity="0.3"/>`);
  svg.push(`<text x="2" y="${padT + 8}" font-size="10" fill="currentColor" opacity="0.6">${maxMs}ms</text>`);
  steps.forEach((step, i) => {
    const pts = days.map((d) => { const r = rows.find((x) => x.day === d && x.step === step); return r ? `${xOf(d).toFixed(1)},${yOf(r.median_ms).toFixed(1)}` : null; }).filter(Boolean).join(' ');
    const color = palette[i % palette.length];
    const dash = step === 0 ? ' stroke-dasharray="4 3"' : '';
    if (pts) svg.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"${dash}/>`);
  });
  svg.push('</svg>');
  const legend = el('div', { class: 'tx-legend' }, ...steps.map((s, i) => el('span', { style: `color:${palette[i % palette.length]}` }, s === 0 ? '— hele testen' : ` — trin ${s}`)));
  const wrap = el('div', {});
  const chart = el('div', { style: 'overflow-x:auto' });
  chart.innerHTML = svg.join('');
  wrap.append(chart, legend);
  return wrap;
}

// The landing route is the CHANGES page, not the fleet grid: a screen full of
// green does not tell a shift what happened while they were away. The fleet grid
// is still the right screen for bulk operations, so it keeps its own route.
let currentView = 'changes';


// ---- Routing ---------------------------------------------------------------
// Every screen has an address (see public/routes.js). Two rules keep the URL and
// `currentView` honest without rewriting the ~25 places that assign it directly:
//
//   1. render() is the single writer. Whatever set currentView, by the time the
//      view is drawn the address is brought in line with it — pushed onto the
//      history stack when the path actually changes, so Back steps through the
//      screens the user visited.
//   2. popstate is the single reader. Going Back parses the address and sets
//      currentView from it, with the push suppressed so the step is not undone.
//
// The query string is left alone: several views own it for their own filters
// (fleet ?severity, topology ?layer, delta ?changeTypes) and all of them
// preserve window.location.pathname, so paths and filters do not collide.
const Routes = (typeof window !== 'undefined' && window.AppRoutes) || null;
// The screen a preview route stands in for: it has no rail entry of its own, so
// without this the sidebar marks nothing and the breadcrumb prints a view key.
const PREVIEW_OF = { uiPreviewChanges: 'changes', uiPreviewProbes: 'probes' };
// A screen with no rail entry at all still needs a name in the crumb, or the
// topbar prints a view key at the reader.
const CRUMB_ONLY = { kitchenSink: 'route.crumb.kitchenSink' };
// Set while a popstate is being applied: the address is already correct, so
// render() must replace rather than push (a push would strand the Back button).
let routerReplacing = false;
// The address the user asked for when it turned out not to exist — shown by the
// not-found view so the message can name it.
let notFoundPath = '';
// The role the blocked address needs, so the forbidden screen can name it.
let forbiddenRole = '';

// The sub-tab state variable each tabbed view reports its position through.
// `let` declarations below this line are hoisted but in the temporal dead zone,
// so this is a function rather than a table built at load time.
function routeTabFor(view) {
  switch (view) {
    case 'probes': return probesTab;
    case 'transactions': return txTab;
    case 'serviceAssurance': return serviceAssuranceTab;
    case 'settings': return settingsTab;
    case 'guide': return guideTrack;
    case 'reporting': return reportingState.section;
    default: return null;
  }
}
function routeIdFor(view) {
  switch (view) {
    case 'agent': return selectedAgentId;
    case 'location': return selectedLocationId;
    case 'event': return selectedEventId;
    case 'cluster': return selectedClusterId;
    default: return null;
  }
}
function setRouteTab(view, tab) {
  if (!tab) return;
  if (view === 'probes') probesTab = tab;
  else if (view === 'transactions') txTab = tab;
  else if (view === 'serviceAssurance') serviceAssuranceTab = tab;
  else if (view === 'settings') settingsTab = tab;
  else if (view === 'guide') guideTrack = tab;
  else if (view === 'reporting') reportingState.section = tab;
}
function setRouteId(view, id) {
  if (id == null) return;
  if (view === 'agent') selectedAgentId = id;
  else if (view === 'location') selectedLocationId = id;
  else if (view === 'event') selectedEventId = id;
  else if (view === 'cluster') selectedClusterId = id;
}

// Read the address into view state. Returns false when the path names no screen
// (the server already answered 404 with this same shell) or when the screen is
// above the reader's role — a typed URL does not pass the nav rail, so the check
// that hides the tab has to happen here as well.
function applyRoute(loc) {
  if (!Routes) return true;
  const hit = Routes.match((loc || window.location).pathname);
  if (!hit) {
    notFoundPath = (loc || window.location).pathname;
    currentView = Routes.NOT_FOUND;
    return false;
  }
  const min = Routes.MIN_ROLE[hit.view];
  if (min && !roleAtLeast(min)) {
    // A typed URL does not pass the nav rail, so the role gate that hides the
    // tab has to be applied here too. It is NOT a 404: saying "no such page"
    // about a page that does exist is the kind of half-truth that sends people
    // to support. The API behind every one of these screens refuses the same
    // reader with a real 403, so the screen says the same thing.
    notFoundPath = (loc || window.location).pathname;
    forbiddenRole = min;
    currentView = 'forbidden';
    return false;
  }
  currentView = hit.view;
  setRouteTab(hit.view, hit.tab);
  setRouteId(hit.view, hit.id);
  return true;
}

// Bring the address in line with the view being drawn. Called from render().
function syncLocation() {
  // notFound and forbidden are answers ABOUT an address, not screens with one:
  // rewriting the bar to '/' would hide the very address the message names.
  if (!Routes || !Routes.VIEWS[currentView]) return;
  try {
    const target = Routes.pathFor(currentView, { tab: routeTabFor(currentView), id: routeIdFor(currentView) });
    if (Routes.normalise(window.location.pathname) === target) return;
    const url = target + (window.location.search || '') + (window.location.hash || '');
    if (routerReplacing) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
  } catch { /* URL/History API off — the app still works, the address does not follow */ }
}

// Section / page / sub-page, rebuilt from the route on every render. The labels
// come from the sidebar the route points at, so the crumb and the rail can never
// disagree, and a language switch relabels both.
function syncCrumb() {
  const host = $('#crumb');
  if (!host || !Routes) return;
  // The two answers ABOUT an address rather than screens with one.
  if (currentView === Routes.NOT_FOUND || currentView === 'forbidden') {
    host.replaceChildren(el('span', { class: 'crumb-here' },
      currentView === 'forbidden' ? t('route.forbidden.crumb') : t('route.notFound.crumb')));
    return;
  }
  if (CRUMB_ONLY[currentView]) {
    host.replaceChildren(el('span', { class: 'crumb-here' }, t(CRUMB_ONLY[currentView])));
    return;
  }
  const marks = PREVIEW_OF[currentView] || currentView;
  const tab = routeTabFor(currentView);
  const btn = [...document.querySelectorAll(NAV_BUTTONS)].find((b) => b.dataset.view === marks
    && (!b.dataset.saTab || b.dataset.saTab === tab)
    && (!b.dataset.guide || b.dataset.guide === tab))
    || document.querySelector(`[data-view="${marks}"]`);
  const group = btn && btn.closest('.nav-group');
  const groupLabel = group && group.querySelector('.nav-group-label');
  const parts = [];
  if (groupLabel) parts.push(groupLabel.textContent.trim());
  parts.push(btn ? btn.textContent.trim() : (VIEW_LABELS[currentView] || currentView));
  // A sub-page the rail does not name: the open record, or a tab of its own.
  const id = routeIdFor(currentView);
  if (PREVIEW_OF[currentView]) parts.push(t('uip.crumb'));
  else if (id != null) parts.push(`#${id}`);
  else if (tab && !(btn && (btn.dataset.saTab || btn.dataset.guide))) parts.push(crumbTabLabel(currentView, tab));

  const kids = [];
  parts.filter(Boolean).forEach((text, i) => {
    if (i) kids.push(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
    kids.push(i === parts.length - 1
      ? el('span', { class: 'crumb-here', 'aria-current': 'page' }, text)
      : el('span', { class: 'crumb-step' }, text));
  });
  host.replaceChildren(...kids);
}
// A sub-tab's own label. Falls back to the segment itself, which is already the
// word in the URL, so an untranslated tab reads as its address rather than blank.
function crumbTabLabel(view, tab) {
  // Settings' twenty-two section labels already live in SETTINGS_GROUPS, so
  // they are read from there rather than copied into both catalogues.
  if (view === 'settings') return settingsLabel(tab);
  const key = `route.tab.${view}.${tab}`;
  const label = t(key);
  return label === key ? tab : label;
}

if (typeof window !== 'undefined' && Routes) {
  window.addEventListener('popstate', () => {
    closeDrawer();
    routerReplacing = true;
    applyRoute(window.location);
    Promise.resolve(render()).finally(() => { routerReplacing = false; });
  });
}

// The address that did not resolve. Rendered inside the ordinary shell — the
// sidebar, the topbar and the search are all still there, because a mistyped
// URL is not a reason to take the way out away.
views.notFound = async () => el('div', { class: 'ui ui-page' },
  el('header', { class: 'page-head' },
    el('div', {},
      el('h1', {}, t('route.notFound.title')),
      el('p', {}, t('route.notFound.lead')))),
  el('section', { class: 'panel-ui' },
    el('div', { class: 'state is-error' },
      el('div', { class: 'state-ico' }, '404'),
      el('h3', {}, t('route.notFound.heading')),
      el('p', {}, t('route.notFound.body'), ' ', el('code', {}, notFoundPath || '/')),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => { currentView = Routes ? Routes.HOME : 'changes'; render(); },
      }, t('route.notFound.home')))));

// The address exists; this reader may not open it. Same shell, same way out.
views.forbidden = async () => el('div', { class: 'ui ui-page' },
  el('header', { class: 'page-head' },
    el('div', {},
      el('h1', {}, t('route.forbidden.title')),
      el('p', {}, t('route.forbidden.lead')))),
  el('section', { class: 'panel-ui' },
    el('div', { class: 'state is-error' },
      el('div', { class: 'state-ico' }, '403'),
      el('h3', {}, t('route.forbidden.heading', { role: forbiddenRole || 'admin' })),
      el('p', {}, t('route.forbidden.body', { role: forbiddenRole || 'admin' }), ' ', el('code', {}, notFoundPath || '/')),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => { currentView = Routes ? Routes.HOME : 'changes'; render(); },
      }, t('route.notFound.home')))));

// ---- UI-contract preview (Phase 1, admin only) ------------------------------
// Two example screens built from the contract's components, on their own routes
// so nothing live changes while the direction is reviewed. Deleted once Changes
// and Probes & Tests are migrated onto their real routes.
// The contract's components, built once and handed to every screen that has been
// migrated. See public/ui.js and docs/ui-contract.md.
const ui = (typeof window !== 'undefined' && window.Ui)
  ? window.Ui.create({
    el, t, plural, tabStrip,
    getLocale: () => (window.I18n ? window.I18n.getLocale() : 'en'),
    relativeTime: (v) => (window.I18n ? window.I18n.relativeTime(v) : String(v)),
  })
  : null;

const uiPreview = (typeof window !== 'undefined' && window.UiPreview && ui)
  ? window.UiPreview.create({ el, api, t, plural, errText, openAgent, gotoView, ui })
  : null;
views.uiPreviewChanges = async () => (uiPreview
  ? uiPreview.changes()
  : el('div', { class: 'empty' }, t('uip.unavailable')));
views.uiPreviewProbes = async () => (uiPreview
  ? uiPreview.probes()
  : el('div', { class: 'empty' }, t('uip.unavailable')));

// ---- Component reference ----------------------------------------------------
// /ui-kitchen-sink, admin only. Every component in every state, built from the
// same ui.js a migrated screen uses. Stays after the migration: it is the visual
// reference for docs/ui-contract.md and the surface the component tests read.
const kitchenSink = (typeof window !== 'undefined' && window.KitchenSink && ui)
  ? window.KitchenSink.create({ el, t, ui })
  : null;
views.kitchenSink = async () => (kitchenSink
  ? kitchenSink.view()
  : el('div', { class: 'empty' }, t('uip.unavailable')));

// Every control that navigates: the sidebar rail, the rail's foot (Documentation)
// and the account menu (About). One selector, so a new home for a nav entry is
// wired for both the click and the active-state pass.
const NAV_BUTTONS = '.tabs button[data-view], #sidebar-foot button[data-view], #user-menu-panel button[data-view]';

const modalOpen = () => !$('#modal').classList.contains('hidden');

// One-time per session: stamp the sidebar foot with this server's build —
// "BlueEyes server · v<version> · <release date>" — from /system/version.
let footStamped = false;
async function stampFooter() {
  if (footStamped) return;
  footStamped = true;
  const foot = $('#sidebar-version') || $('#sidebar-foot');
  if (!foot) return;
  try {
    const ver = await api('/system/version');
    const parts = ['BlueEyes server'];
    if (ver && ver.server) parts.push(`v${ver.server}`);
    if (ver && ver.releaseDate) parts.push(ver.releaseDate);
    foot.textContent = parts.join(' · ');
  } catch { footStamped = false; /* retry on the next render */ }
}

// Initial focus on the login form: straight to the password when the username
// (email) is already filled — it is prefilled by default — otherwise to the
// username. Never steals focus once the user is already typing in the form.
function focusLoginField() {
  const emailEl = $('#email');
  const passEl = $('#password');
  if (!emailEl || !passEl) return;
  const active = document.activeElement;
  if (active && active !== document.body && $('#login-form').contains(active)) return;
  if (emailEl.value.trim()) passEl.focus();
  else emailEl.focus();
}

async function render({ silent = false } = {}) {
  if (!token) {
    $('#login').classList.remove('hidden');
    $('#force-change').classList.add('hidden');
    $('#app').classList.add('hidden');
    focusLoginField();
    return;
  }
  // A user still holding a one-time password is locked to the change screen —
  // the server refuses every other route until they pick a new password.
  if (needsPasswordChange()) {
    $('#login').classList.add('hidden');
    $('#app').classList.add('hidden');
    $('#force-change').classList.remove('hidden');
    const cur = $('#fc-current');
    if (cur && document.activeElement !== cur) cur.focus();
    return;
  }
  $('#login').classList.add('hidden');
  $('#force-change').classList.add('hidden');
  $('#app').classList.remove('hidden');
  connectLive(); // live findings channel (idempotent)
  await loadProfile(); // apply the user's saved colour theme (once per session)
  await Promise.all([loadFeatures(), loadPlan()]);
  applyFeatureVisibility(); // dim modules the licence excludes (tied to the active plan)
  applyRoleVisibility(); // hide nav items above the user's role + collapse empty groups
  // Show who is logged in: email + role.
  $('#whoami').replaceChildren(
    el('span', { class: 'who-email' }, email || '—'),
    el('span', { class: `badge role-${role}` }, role));
  stampFooter(); // sidebar foot: BlueEyes server · version · release date
  // Admin-only, once per session: nudge to set the agent signing key if it's missing.
  maybePromptSigningKey();

  // Stop the overview poller when leaving that view (it restarts itself when shown).
  // The preview screens own their drawer, popover and row menu; they are
  // appended to <body>, so leaving the view does not remove them.
  if (ui && currentView !== 'uiPreviewChanges' && currentView !== 'uiPreviewProbes'
    && currentView !== 'kitchenSink') ui.closeOverlays();
  if (currentView !== 'overview') stopOverview();
  if (currentView !== 'probes') stopProbes();
  if (currentView !== 'interfaces') stopIfaces();
  if (currentView !== 'fleet') stopFleet();
  if (currentView !== 'agent') stopAgent();
  // Tear down the Leaflet maps when leaving their views (they rebuild on entry).
  if (currentView !== 'geo') stopGeo();
  if (currentView !== 'map') stopMap();
  if (currentView !== 'topology') stopTopoMap();
  stopTrafficMaps(); // traffic maps always rebuild with their view

  // Admin-only tabs (e.g. Users); send non-admins back to agents if needed.
  for (const b of document.querySelectorAll('.tabs button[data-admin]')) {
    b.classList.toggle('hidden', role !== 'admin');
  }
  if (currentView === 'users' && role !== 'admin') currentView = 'overview';
  for (const b of document.querySelectorAll(NAV_BUTTONS)) {
    // Several entries can share one data-view when they deep-link to different
    // sub-tabs; the sub-tab is what tells them apart.
    const marks = PREVIEW_OF[currentView] || currentView;
    const active = b.dataset.view === marks
      && (!b.dataset.saTab || b.dataset.saTab === serviceAssuranceTab)
      && (!b.dataset.guide || b.dataset.guide === guideTrack);
    b.classList.toggle('active', active);
    // The section you are in is open. Groups start collapsed and the collapsed
    // set is remembered per browser, so without this a deep link (or a reload
    // on any page) marks an item inside a folded group — a "you are here" that
    // nobody can see. Unfolding does not touch the remembered set: close it
    // again and the choice still sticks.
    if (active) {
      const group = b.closest('.nav-group');
      if (group && group.classList.contains('collapsed')) {
        group.classList.remove('collapsed');
        const label = group.querySelector('.nav-group-label');
        if (label) label.setAttribute('aria-expanded', 'true');
      }
    }
  }

  syncLocation();
  syncCrumb();

  const view = $('#view');
  if (!silent) view.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
  try {
    const node = await views[currentView]();
    const h = hero(currentView);
    view.replaceChildren(...(h ? [h, node] : [node]));
    // On user navigation (not the silent auto-refresh) move focus to the new
    // content, so keyboard/screen-reader users land on it instead of being left
    // on the nav button. #view has tabindex="-1" to be programmatically focusable.
    if (!silent && typeof view.focus === 'function') view.focus();
  } catch (err) {
    if (!silent) view.replaceChildren(el('div', { class: 'empty error' }, err.message));
  }
}

// ---- Auto-refresh ---------------------------------------------------------
let autoTimer = null;
function setAutoRefresh(on) {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (on) {
    autoTimer = setInterval(() => {
      // Don't disrupt an open editing modal; refresh quietly otherwise.
      if (token && !modalOpen()) render({ silent: true });
    }, 5000);
  }
}

// ---- Wire up --------------------------------------------------------------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try { await login($('#email').value, $('#password').value); render(); }
  catch (err) { $('#login-error').textContent = err.message; }
});

// Forced password change (first login with a one-time password). Posts the
// current + new password; on success the server returns a fresh, unflagged token
// so the user drops straight into the app. Client-side confirm-match check only;
// the server enforces the real policy (422) and current-password check (401).
$('#force-change-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#fc-error');
  errEl.textContent = '';
  const currentPassword = $('#fc-current').value;
  const newPassword = $('#fc-new').value;
  const confirm = $('#fc-confirm').value;
  if (newPassword !== confirm) { errEl.textContent = t('auth.fc.mismatch'); return; }
  try {
    const data = await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    token = data.token;
    role = data.user.role;
    email = data.user.email;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    localStorage.setItem(EMAIL_KEY, email);
    $('#force-change-form').reset();
    toast(t('auth.fc.done'));
    render();
  } catch (err) {
    errEl.textContent = errText(err);
  }
});
$('#fc-logout').addEventListener('click', () => logout());

// Federated sign-in buttons on the login screen. Asks the server which SSO
// methods are live (GET /auth/sso) and shows a button per method; each is just a
// link to the provider-initiated flow. Local login always stays as the fallback.
async function renderSsoOptions() {
  const host = $('#sso-options');
  if (!host) return;
  if (ssoLoginError) $('#login-error').textContent = t('auth.sso.failed', { message: ssoLoginError });
  let sso = null;
  try { sso = await (await fetch('/auth/sso')).json(); } catch { sso = null; }
  const methods = [];
  if (sso && sso.oidc && sso.oidc.enabled) methods.push({ label: t('auth.sso.oidc'), url: sso.oidc.loginUrl });
  if (sso && sso.saml && sso.saml.enabled) methods.push({ label: t('auth.sso.saml'), url: sso.saml.loginUrl });
  if (!methods.length) { host.classList.add('hidden'); return; }
  host.replaceChildren(
    el('div', { class: 'sso-divider' }, el('span', {}, t('auth.sso.or'))),
    ...methods.map((m) => el('a', { class: 'btn btn-secondary auth-submit', href: m.url }, m.label)));
  host.classList.remove('hidden');
}
renderSsoOptions();
$('#logout').addEventListener('click', () => { setAutoRefresh(false); stopOverview(); stopFleet(); stopAgent(); stopProbes(); stopIfaces(); stopMap(); stopGeo(); stopTopoMap(); stopTrafficMaps(); $('#autorefresh').checked = false; logout(); });
// Refresh row: the main action does a real, full page reload (not a soft
// re-render), so it always reflects the freshest server state.
$('#refresh').addEventListener('click', () => window.location.reload());
// Auto-refresh toggle (in the account menu): persist the new setting, then
// reload — the reload restarts the interval from the restored state below.
$('#autorefresh').addEventListener('change', (e) => {
  try { localStorage.setItem(AUTOREFRESH_KEY, e.target.checked ? '1' : '0'); } catch { /* storage off */ }
  window.location.reload();
});
// Restore the persisted auto-refresh preference once at load: reflect it on the
// (hidden) checkbox and start/stop the 5s interval accordingly.
{
  let autoOn = false;
  try { autoOn = localStorage.getItem(AUTOREFRESH_KEY) === '1'; } catch { /* storage off */ }
  const cb = $('#autorefresh');
  if (cb) cb.checked = autoOn;
  setAutoRefresh(autoOn);
}
// The language switch in the account menu. One button per locale, the active one
// marked — two locales make a segmented pair, and a select would be a dropdown
// inside a dropdown. Picking one applies it immediately, saves it to the account
// (setLocale) and re-renders; the panel stays open, like the theme toggle, so the
// effect is visible where the click happened.
function renderLangSwitch() {
  const host = $('#lang-switch');
  if (!host || !window.I18n) return;
  const label = $('#lang-label');
  if (label) label.textContent = t('settings.language');
  const active = window.I18n.getLocale();
  host.replaceChildren(...window.I18n.LOCALES.map((code) => el('button', {
    type: 'button',
    class: `lang-switch-btn${code === active ? ' active' : ''}`,
    role: 'menuitemradio',
    'aria-checked': code === active ? 'true' : 'false',
    title: window.I18n.LOCALE_LABELS[code] || code,
    onclick: async (e) => {
      e.stopPropagation();
      if (code === window.I18n.getLocale()) return;
      try { await setLocale(code); }
      catch (err) { toast(errText(err) || 'Could not save language', true); }
      render();
    },
  }, code.toUpperCase())));
}

// Account menu: click the trigger to open/close; closes on outside-click and
// Escape. Item clicks that reload/navigate (refresh, auto toggle, log out) tear
// the panel down on their own; theme and language toggles intentionally leave it
// open.
// Closing the account menu is also the nav handler's job: the menu holds a
// data-view entry (About), and a panel left hanging over the page it just
// opened is the bug this avoids.
function closeUserMenu() {
  const panel = $('#user-menu-panel');
  const trigger = $('#user-menu-trigger');
  if (!panel || panel.classList.contains('hidden')) return;
  panel.classList.add('hidden');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}
{
  const menu = $('#user-menu');
  const trigger = $('#user-menu-trigger');
  const panel = $('#user-menu-panel');
  if (menu && trigger && panel) {
    const isOpen = () => !panel.classList.contains('hidden');
    const open = () => { panel.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); };
    trigger.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? closeUserMenu() : open(); });
    document.addEventListener('click', (e) => { if (isOpen() && !menu.contains(e.target)) closeUserMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { closeUserMenu(); trigger.focus(); } });
    renderLangSwitch();
  }
}
function closeNav() { $('#app').classList.remove('nav-open'); }
for (const b of document.querySelectorAll(NAV_BUTTONS)) {
  b.addEventListener('click', () => {
    closeDrawer(); closeNav(); closeUserMenu();
    // Locked (licence-excluded) items don't open — they nudge to the licence page.
    if (b.classList.contains('locked')) {
      toast(`${lockedHint((b.textContent || 'This module').trim(), b.dataset.feature)} — see License.`);
      settingsTab = 'license'; currentView = 'settings'; render();
      return;
    }
    // A nav entry may deep-link into a sub-tab of the view it opens (Service
    // Assurance has five screens of its own). Recorded before render so the view
    // opens where the operator clicked rather than on its default tab.
    if (b.dataset.saTab) serviceAssuranceTab = b.dataset.saTab;
    if (b.dataset.guide) guideTrack = b.dataset.guide;
    currentView = b.dataset.view; render();
  });
}
// Foldable nav categories: clicking a category label collapses/expands its group.
// The set of collapsed categories is remembered per browser (localStorage), so the
// rail comes back the way the user left it. Independent of the mobile off-canvas nav.
// Default (no stored preference yet): every category starts collapsed, so the rail
// opens compact and the user unfolds only the groups they care about — their choices
// are remembered from the first toggle on. `null` distinguishes "never chosen" from a
// stored-but-empty set (which means the user has expanded everything).
function loadCollapsedCategories() {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
    if (raw === null) return null;
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return null; }
}
function saveCollapsedCategories(set) {
  try { localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* storage off */ }
}
function setupNavGroups() {
  const groups = [...document.querySelectorAll('.tabs .nav-group')];
  const catOf = (g) => g.dataset.category || g.querySelector('.nav-group-label')?.textContent.trim();
  let collapsed = loadCollapsedCategories();
  if (collapsed === null) {
    // First visit: fold every category. Nothing is persisted until the user
    // toggles a group, at which point the full set is saved.
    collapsed = new Set(groups.map(catOf).filter(Boolean));
  }
  for (const g of groups) {
    const label = g.querySelector('.nav-group-label');
    if (!label) continue;
    const cat = g.dataset.category || label.textContent.trim();
    const setState = (isCollapsed) => {
      g.classList.toggle('collapsed', isCollapsed);
      label.setAttribute('aria-expanded', String(!isCollapsed));
    };
    setState(collapsed.has(cat));
    label.addEventListener('click', () => {
      const nowCollapsed = !g.classList.contains('collapsed');
      setState(nowCollapsed);
      if (nowCollapsed) collapsed.add(cat); else collapsed.delete(cat);
      saveCollapsedCategories(collapsed);
    });
  }
}
setupNavGroups();
// Off-canvas sidebar (mobile/tablet): the ☰ button opens it; tapping the dimmed
// backdrop or anything outside the sidebar closes it again.
{
  const navToggle = $('#nav-toggle');
  if (navToggle) navToggle.addEventListener('click', (e) => { e.stopPropagation(); $('#app').classList.toggle('nav-open'); });
  $('#app').addEventListener('click', (e) => {
    if ($('#app').classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('#nav-toggle')) closeNav();
  });
}
// Collapsing global search: a magnifier button that expands into a search
// pill. The icon toggles it; ✕, Escape or an outside click collapse it; "/"
// opens it from anywhere. The typed query survives an outside-click collapse
// (so re-opening restores it); ✕/Escape clear it.
{
  const box = $('#topbar-search');
  const sq = $('#search-q');
  const toggle = $('#search-toggle');
  const clear = $('#search-clear');
  if (box && sq && toggle) {
    const isOpen = () => box.classList.contains('open');
    const openSearch = () => {
      box.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      sq.tabIndex = 0; if (clear) clear.tabIndex = 0;
      sq.focus();
    };
    const closeSearch = (clearText) => {
      box.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      if (clearText) sq.value = '';
      sq.tabIndex = -1; if (clear) clear.tabIndex = -1;
      sq.blur();
    };
    toggle.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? closeSearch(false) : openSearch(); });
    if (clear) clear.addEventListener('click', (e) => { e.stopPropagation(); closeSearch(true); });
    sq.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); globalSearch(sq.value); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearch(true); }
    });
    // Outside click collapses the pill (query is kept for next time).
    document.addEventListener('click', (e) => {
      if (isOpen() && !e.target.closest('#topbar-search')) closeSearch(false);
    });
    // "/" opens search from anywhere — unless the user is already typing.
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault(); openSearch();
    });
  }
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
installModalA11y(); // focus management + trap + Escape for every modal flow

// The first paint comes from the address bar, not from a default. A reload, a
// bookmark and a shared link all land on the screen they name; the bare '/'
// lands on Changes as before. The address is already correct at this point, so
// the first render replaces rather than pushes — otherwise Back would have to
// step past an entry the user never navigated to.
routerReplacing = true;
applyRoute(window.location);
Promise.resolve(render()).finally(() => { routerReplacing = false; });

// ---- Scheduled reports ----------------------------------------------------
// The exports answer a question somebody asked. This answers the recurring
// obligation the same two reports usually serve — the monthly SLA figure for a
// customer, the weekly outage list for a service review — by sending it on its
// own. Storage and the job are src/services/reportScheduler.js; the schedule
// itself is the same recurrence the test packages use, edited in the same
// fields, so "the 1st at 06:00" means one thing in this product.
const RS_REPORTS = ['availability', 'probe_outages'];
const RS_FORMATS = ['csv', 'html'];
const RS_SEVERITIES = ['info', 'warning', 'critical'];

async function reportSchedulesPanel() {
  const wrap = el('div', { class: 'rs' });
  wrap.append(el('p', { class: 'muted nis2-note' }, t('rs.lead')));

  const [schedules, locations] = await Promise.all([
    api('/api/report-schedules'),
    api('/locations').catch(() => []),
  ]);

  if (role === 'admin') {
    wrap.append(el('div', { class: 'form-actions' },
      el('button', { class: 'small', onclick: () => editReportSchedule(null, locations) }, t('rs.new'))));
  }

  if (!schedules.length) {
    wrap.append(el('div', { class: 'empty' }, t('rs.none')));
    return wrap;
  }

  const head = ['rs.col.name', 'rs.col.report', 'rs.col.window', 'rs.col.recipients', 'rs.col.schedule', 'rs.col.lastRun', ''];
  const tbody = el('tbody', {}, ...schedules.map((s) => reportScheduleRow(s, locations)));
  wrap.append(el('table', { class: 'tests-table rs-table' },
    el('thead', {}, el('tr', {}, ...head.map((k) => el('th', {}, k ? t(k) : '')))),
    tbody));
  return wrap;
}

function reportScheduleRow(s, locations) {
  const actions = el('div', { class: 'row-actions' },
    canWrite() ? el('button', { class: 'small', onclick: (e) => sendReportScheduleNow(s, e.target) }, t('rs.sendNow')) : null,
    role === 'admin' ? el('button', { class: 'small ghost', onclick: () => editReportSchedule(s, locations) }, t('rs.edit')) : null,
    role === 'admin' ? el('button', { class: 'small danger', onclick: () => deleteReportSchedule(s) }, t('rs.delete')) : null);
  return el('tr', {},
    el('td', {}, el('div', {}, s.name),
      s.enabled ? null : el('span', { class: 'badge neutral' }, t('rs.disabled'))),
    el('td', {}, t(`rs.report.${s.report}`), el('div', { class: 'muted small' }, t(`rs.format.${s.format}`))),
    el('td', {}, t('rs.days', { n: String(s.window_days) })),
    el('td', { class: 'muted small' }, (s.recipients || []).join(', ')),
    el('td', {}, repeatSummary(s.schedule_spec, 1).split(' · ').slice(0, 2).join(' · ')),
    // What happened last time, in the words the job recorded — a schedule that
    // has been failing for three weeks must not look healthy here.
    el('td', { class: `muted small${/^failed/.test(s.last_run_status || '') ? ' error' : ''}` },
      s.last_run_at ? `${fmtDate(s.last_run_at)} · ${s.last_run_status || ''}` : t('rs.never')),
    el('td', {}, actions));
}

async function sendReportScheduleNow(s, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/api/report-schedules/${s.id}/send-now`, { method: 'POST' });
    toast(t('rs.sent', { detail: r.detail }));
  } catch (err) {
    // A mail server nobody configured answers 409 with the reason — show it
    // rather than a generic failure.
    toast(t('rs.sendFailed', { detail: errText(err) }), true);
  } finally {
    if (btn) btn.disabled = false;
    render();
  }
}

async function deleteReportSchedule(s) {
  if (!confirm(t('rs.confirmDelete', { name: s.name }))) return;
  try { await api(`/api/report-schedules/${s.id}`, { method: 'DELETE' }); toast(t('rs.deleted')); render(); }
  catch (err) { toast(errText(err), true); }
}

function editReportSchedule(schedule, locations) {
  const card = $('#modal-card');
  const isEdit = !!schedule;
  const data = schedule || {
    name: '', report: 'availability', format: 'csv', window_days: 7,
    params: {}, recipients: [], schedule_spec: null, enabled: true,
  };

  const nameInput = el('input', { type: 'text', value: data.name, placeholder: 'Monthly SLA' });
  const reportSel = el('select', {}, ...RS_REPORTS.map((r) => el('option', { value: r, ...(data.report === r ? { selected: 'selected' } : {}) }, t(`rs.report.${r}`))));
  const formatSel = el('select', {}, ...RS_FORMATS.map((f) => el('option', { value: f, ...(data.format === f ? { selected: 'selected' } : {}) }, t(`rs.format.${f}`))));
  const windowInput = el('input', { type: 'number', min: '1', max: '400', value: String(data.window_days || 7) });
  const recipientsInput = el('textarea', { rows: '3', placeholder: 'ops@acme.dk' }, (data.recipients || []).join('\n'));
  const locationSel = el('select', {},
    el('option', { value: '' }, t('rs.location.all')),
    ...locations.map((l) => el('option', { value: String(l.id), ...(Number(data.params && data.params.locationId) === l.id ? { selected: 'selected' } : {}) }, l.name)));
  const severitySel = el('select', {},
    el('option', { value: '' }, t('rs.severity.all')),
    ...RS_SEVERITIES.map((sv) => el('option', { value: sv, ...(data.params && data.params.severity === sv ? { selected: 'selected' } : {}) }, sv)));
  const severityWrap = el('label', {}, t('rs.severity'), severitySel);
  const enabledInput = el('input', { type: 'checkbox', ...(data.enabled ? { checked: 'checked' } : {}) });
  const recurrence = recurrenceFields({ spec: data.schedule_spec, showRuns: false });
  const err = el('p', { class: 'error' });
  const saveBtn = el('button', { type: 'button' }, t('rs.save'));

  // Severity only exists on the outage report; hiding it is not cosmetic — a
  // filter that silently applies to a report without that column is a schedule
  // whose output nobody can explain.
  const syncReport = () => { severityWrap.hidden = reportSel.value !== 'probe_outages'; };
  reportSel.addEventListener('change', syncReport);
  syncReport();

  saveBtn.addEventListener('click', async () => {
    err.textContent = '';
    const recipients = recipientsInput.value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
    const params = {};
    if (locationSel.value) params.location_id = Number(locationSel.value);
    if (reportSel.value === 'probe_outages' && severitySel.value) params.severity = severitySel.value;
    const body = {
      name: nameInput.value.trim(),
      report: reportSel.value,
      format: formatSel.value,
      window_days: Number(windowInput.value) || 7,
      params,
      recipients,
      schedule_spec: recurrence.spec(),
      enabled: enabledInput.checked,
    };
    saveBtn.disabled = true;
    try {
      if (isEdit) await api(`/api/report-schedules/${schedule.id}`, { method: 'PUT', body });
      else await api('/api/report-schedules', { method: 'POST', body });
      toast(t('rs.saved'));
      closeModal();
      render();
    } catch (e) { err.textContent = errText(e); saveBtn.disabled = false; }
  });

  card.replaceChildren(
    el('h3', {}, isEdit ? t('rs.edit') : t('rs.new')),
    el('div', { class: 'form-grid' },
      el('label', {}, t('rs.name'), nameInput),
      el('label', {}, t('rs.reportLabel'), reportSel),
      el('label', {}, t('rs.format'), formatSel),
      el('label', {}, t('rs.window'), windowInput, el('span', { class: 'field-hint' }, t('rs.windowHint'))),
      el('label', {}, t('rs.location'), locationSel),
      severityWrap,
      el('label', {}, t('rs.recipients'), recipientsInput, el('span', { class: 'field-hint' }, t('rs.recipientsHint'))),
      recurrence.node,
      el('label', { class: 'inline' }, enabledInput, ' ', t('rs.enabled')),
      err,
      el('div', { class: 'form-actions' },
        el('button', { type: 'button', class: 'ghost', onclick: closeModal }, t('rs.cancel')),
        saveBtn)));
  $('#modal').classList.remove('hidden');
}
