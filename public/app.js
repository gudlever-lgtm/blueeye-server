'use strict';

// BlueEye server dashboard — dependency-free vanilla JS over the JSON API.
const TOKEN_KEY = 'blueeye.server.token';
const ROLE_KEY = 'blueeye.server.role';
const EMAIL_KEY = 'blueeye.server.email';
const THEME_KEY = 'blueeye.server.theme';
const NAV_COLLAPSE_KEY = 'blueeye.server.navCollapsed';

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
    btn.textContent = isDark ? '☀️' : '🌙';
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
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
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
const canWrite = () => role === 'operator' || role === 'admin';
const canDelete = () => role === 'admin';
const isAdmin = () => role === 'admin';

// ---- API helper -----------------------------------------------------------
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
  // A 401 on an authenticated call means the session expired; on the login call
  // itself it just means wrong credentials — surface the server's message.
  if (res.status === 401 && path !== '/auth/login') {
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
// The active licence package (Pilot/Starter/Professional/Enterprise). Locked
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
    if (!allowed && currentView === b.dataset.view) currentView = 'fleet';
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

// The user's saved preferences (currently just the colour theme). Loaded once
// per session; the server value wins over the local cache so the chosen theme
// follows the user across browsers. Best-effort — a failure keeps the cache.
let profileLoaded = false;
async function loadProfile() {
  if (profileLoaded) return;
  profileLoaded = true;
  try {
    const me = await api('/me');
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
};
function gotoView(viewKey) {
  closeDrawer();
  // Probes and Tests share one view now; a 'tests' link opens the packages sub-tab.
  if (viewKey === 'tests') { probesTab = 'packages'; viewKey = 'probes'; }
  else if (viewKey === 'probes') { probesTab = 'run'; }
  currentView = viewKey;
  render();
}
function viewLink(viewKey, label) {
  const text = label || VIEW_LABELS[viewKey] || viewKey;
  const tab = document.querySelector(`.tabs button[data-view="${viewKey}"]`);
  if (tab && (tab.classList.contains('hidden') || tab.classList.contains('locked'))) return document.createTextNode(text);
  return el('a', { href: '#', class: 'drawer-link', onclick: (e) => { e.preventDefault(); gotoView(viewKey); } }, text);
}
// Deep-link into a specific Settings sub-tab (Analysis, Retention, Traffic types…).
function settingsLink(tab, label) {
  return el('a', { href: '#', class: 'drawer-link',
    onclick: (e) => { e.preventDefault(); closeDrawer(); settingsTab = tab; currentView = 'settings'; render(); } }, label);
}

const PAGE_INFO = {
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
    hero: 'Test Settings — one place to verify every outbound integration: send a test email, reach your ITSM/IPAM receivers, check SSO and the other services BlueEye talks to — each with a security check.',
    title: 'Test Settings — connectivity & security screening',
    body: () => [
      el('p', {}, 'A consolidated, admin-only screening of everything BlueEye reaches OUTWARD to. Each target gets two verdicts: a live connectivity test and a security-posture check (HTTPS vs plaintext, TLS, signed webhooks, authentication, certificate/secret presence, licence state).'),
      el('div', { class: 'callout' },
        el('strong', {}, 'Running a test sends real traffic: '),
        el('span', {}, 'the email / webhook / syslog tests deliver an actual test message, and an ITSM/IPAM test performs a real (read-only) connectivity call to the receiver. SSO and the other services are probed for reachability.')),
      el('h4', {}, 'What is screened'),
      el('ul', {},
        el('li', {}, el('strong', {}, 'Email & alert channels '), '— SMTP email, webhook and syslog. Configure under ', viewLink('settings', 'Settings → Alerting'), '.'),
        el('li', {}, el('strong', {}, 'Remote API receivers (ITSM/IPAM) '), '— ServiceNow, Nautobot and generic webhook connectors (Settings → Integrations).'),
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
      el('p', {}, 'The landing page collects all agents with a single health stamp, so you immediately see where something is wrong. Rows are sorted worst-first and refresh continuously. Click an agent to drill into its measurements, or click a count chip (Healthy, Critical, …) to filter the list to just those agents.'),
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
      el('p', {}, 'On Professional licences and above, the page ends with an ', el('strong', {}, 'Open issues'), ' rollup: the currently-active ', el('strong', {}, 'incidents'), ' (derived from the probe thresholds — click one to drill into the affected agent) beside the most recent unacknowledged analysis ', viewLink('findings', 'findings'), ', each with its explanation. It is composed from data the server already holds — no new collection — and is gated by the ', el('strong', {}, 'dashboard_advanced'), ' licence feature; below Professional the rollup is simply omitted and the rest of the page is unchanged.'),
      el('p', { class: 'muted' }, 'Health is based on active probes — run a few per agent on ', viewLink('probes'), ' (or schedule them fleet-wide via ', viewLink('tests'), ') for a complete picture; the interface signal comes from ', viewLink('interfaces'), '. Metadata only: targets and timings, never packet contents.'),
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
        el('li', {}, el('strong', {}, 'Probes: '), 'run ping/TCP/DNS/traceroute against a target and see RTT/loss/jitter — click “History” for RTT over time or “Path” for traceroute hops.'),
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
        el('li', {}, '”+ New agent” issues a one-time code for installation (operator+) — or use ', viewLink('enrollment'), ' for a ready-to-run one-liner.'),
        el('li', {}, '”Run test” asks the agent to measure immediately; “Traffic” shows the measurements.'),
        el('li', {}, '”Edit” sets name, location, notes and traffic source (proc, SNMP, NetFlow or sFlow).'),
        el('li', {}, '”Upgrade” (admin) rebuilds a systemd-managed agent from the server\'s published source and restarts it — always available for a manual re-deploy; it shows as a highlighted “Update” when the agent is behind. Docker/unmanaged agents decline (re-run the host installer).')),
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
    hero: 'Run a single active check from one agent, right now: ping, TCP-connect, DNS, traceroute, cURL content check or page load — with RTT, loss, path and history.',
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
        el('li', {}, el('strong', {}, 'cURL (content check): '), 'goes beyond “is it up” — the agent runs ', el('span', { class: 'mono' }, 'curl'), ' against an http(s) URL and verifies the received traffic: the HTTP status code, that the response body contains an expected substring or ', el('span', { class: 'mono' }, '/regex/'), ', the received byte count, and a response header. Leave the expectation fields blank for a plain status<400 check. The agent inspects the body locally but reports only metadata — status, byte count, content-type and pass/fail — never the body itself.'),
        el('li', {}, el('strong', {}, 'Page load: '), 'measures how a whole page loads — the agent fetches the URL, then its sub-resources (scripts, stylesheets, images) and reports a per-element waterfall (status · size · load time) plus totals: element count, page weight and total load time. The total load time is charted over time. Browser-free (no JS execution), so it can\'t see real DOM/load events; metadata only — resource URLs, sizes and timings, never contents.'),
        el('li', {}, el('strong', {}, 'Transaction (multi-step): '), 'simulates a user journey or scripted API call — an ordered list of HTTP steps, each with optional status/body assertions. A step can ', el('strong', {}, 'extract'), ' a value (regex capture) that later steps reference as ', el('span', { class: 'mono' }, '{{name}}'), ' in their URL, header or request body — e.g. log in, capture a token, then call an authenticated endpoint. It stops at the first failing step and reports a per-step waterfall plus the total journey time (charted over time). Extracted values stay on the agent and are never reported.')),
      el('p', {}, 'Select agent + type + target and click “Run probe”. The agent must be connected; the result comes back a moment later and is added to the history so you can see RTT / load time over time.'),
      el('p', { class: 'muted' }, 'To run the same probes on a schedule across many agents, use ', viewLink('tests'), '; probe results also drive the health verdict on ', viewLink('fleet', 'Overview'), '. Metadata only: targets, timings and content verdicts — never packet or response contents.'),
    ],
  },
  flows: {
    hero: 'Inspect conversations: who talks to whom, on which ports, and who is scanning. Switch to Bidirectional mode for an ingress/egress split with asymmetry detection.',
    title: 'Flows — conversations & bidirectional inspector',
    body: () => [
      el('p', {}, 'While ', viewLink('overview', 'Traffic'), ' shows volumes and the ', viewLink('geo', 'Destinations'), ' map shows where it goes, Flows lets you drill into individual conversations (5-tuple metadata from NetFlow/sFlow) for one agent.'),
      el('h4', {}, 'Unified mode'),
      el('ul', {},
        el('li', {}, 'Top talkers: the largest conversations (source→destination) by bytes — click any row to filter by that peer.'),
        el('li', {}, 'Top ports / protocols + a bytes-over-time chart with anomaly findings overlaid as markers.'),
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
      el('h4', {}, 'Severity'),
      el('ul', {},
        el('li', {}, 'CRIT: large deviation (default ≥ 4σ — adjustable in ', settingsLink('analyse', 'Settings → Analysis'), ').'),
        el('li', {}, 'WARN: notable deviation (default ≥ 3σ) or flatline.'),
        el('li', {}, 'INFO: lower severity.')),
      el('h4', {}, 'Acknowledgement'),
      el('p', {}, 'Operators and administrators can acknowledge a finding once it has been seen/handled.'),
      el('h4', {}, 'AI assistant'),
      el('p', {}, 'If enabled (opt-in) you can ask in natural language — the assistant replies based on the latest findings, not raw data. Turn it on and pick the provider (Mistral or another EU / self-hosted endpoint) and model under ', settingsLink('analyse', 'Settings → Analysis'), '.'),
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
      el('p', { class: 'muted' }, 'The agent runs natively on the target (Node + systemd by default; Docker optional) — no pre-built binaries. Also works on air-gapped networks: the source is served from the BlueEye server itself.'),
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
        el('li', {}, settingsLink('auth', 'Authentication'), ': connect an LDAP / Active Directory server so users log in with their directory account and get a role from their group membership. Requires the Enterprise licence and the server flag LDAP_AUTH_ENABLED; the bind password is write-only. Local accounts remain as a fallback.')),
      el('h4', {}, 'Read-only (set in .env / requires restart)'),
      el('ul', {},
        el('li', {}, settingsLink('users', 'Users'), ': create/edit staff and roles (admin only).'),
        el('li', {}, settingsLink('license', 'License'), ': status + “Revalidate now”.')),
      el('p', { class: 'muted' }, 'Editable changes are stored in app_settings and are reloaded on startup, so they survive a restart.'),
    ],
  },
};

function hero(viewKey) {
  // Probes & Tests is one view with two sub-tabs; show the matching help for each.
  let info = PAGE_INFO[viewKey];
  if (viewKey === 'probes' && probesTab === 'packages') info = PAGE_INFO.tests;
  if (!info) return null;
  return el('div', { class: 'hero' },
    el('div', { class: 'hero-text' }, info.hero),
    el('button', { class: 'ghost small', onclick: () => openDrawer(info.title, info.body) }, 'More info'));
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
  else if (t.category === 'itsm') tab = 'integrations';
  else if (t.category === 'auth') tab = 'auth';
  else if (t.id === 'assistant') tab = 'analyse';
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
  const currentAgentVersion = ver && ver.agent ? ver.agent : null;
  locationCache = locations;
  const outdated = agents.filter((a) => agentIsBehind(a, currentAgentVersion));
  const root = el('div');
  const countLabel = el('span', { class: 'muted' }, `${agents.length} total`);
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Agents'),
    countLabel,
    canWrite() ? el('button', { class: 'small', onclick: () => newAgent() }, '+ New agent') : null,
    (canDelete() && outdated.length)
      ? el('button', { class: 'small', onclick: () => bulkUpdateAgents(outdated, currentAgentVersion), title: 'Rebuild every outdated agent from the server source, one at a time' }, `Update outdated (${outdated.length})`)
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
      ? list.map((a) => agentRow(a, currentAgentVersion))
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
function agentRow(a, currentAgentVersion) {
  const behind = agentIsBehind(a, currentAgentVersion);
  return el('tr', {},
    el('td', {}, String(a.id)),
    el('td', {}, el('div', {}, a.display_name || a.hostname), a.display_name ? el('div', { class: 'muted' }, a.hostname) : null),
    el('td', {}, `${a.platform} / ${a.arch}`, agentVersionLine(a, currentAgentVersion)),
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
      canDelete()
        ? el('button', {
            // Always available to admins as a manual upgrade link; emphasised
            // (solid) when the agent is behind the published version, otherwise a
            // subtle ghost link that re-deploys the current server source.
            class: behind ? 'small' : 'small ghost',
            onclick: () => updateAgent(a, currentAgentVersion),
            title: behind
              ? `Update this agent to v${currentAgentVersion} — rebuild from the server source and restart`
              : 'Manually rebuild this agent from the server source and restart it',
          }, behind ? 'Update' : 'Upgrade')
        : null,
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
// reported capabilities (capabilities.agentVersion).
function agentVersionLine(a, current) {
  const v = a.capabilities && a.capabilities.agentVersion;
  if (!v) return null;
  const behind = agentIsBehind(a, current);
  return el('div', { class: 'muted' },
    `v${v}${behind ? ' ' : ''}`,
    behind ? el('span', { class: 'badge warn', title: `Current agent version is ${current}` }, 'update') : null);
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
  const body = [el('h3', {}, `Connection — ${esc(name)}`)];
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
  const recheck = el('button', { class: 'small ghost', onclick: () => showConnection(a) }, 'Re-check');
  actions.push(recheck);
  body.push(el('div', { class: 'form-actions' }, ...actions, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
  card.replaceChildren(...body);
  $('#modal').classList.remove('hidden');
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
  const body = [el('h3', {}, `Diagnose — ${esc(a.display_name || a.hostname)}`)];
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
          el('div', { class: 'assistant-meta muted' }, `${esc(res.model || '')} · ${res.usedFindings ?? 0} findings in context`));
      } catch (err) {
        aiOut.className = 'assistant-out muted';
        aiOut.textContent = err.status === 403
          ? 'The AI assistant is disabled. An administrator can enable it under Settings → Analysis → AI assistant.'
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

// Asks a systemd-managed agent to rebuild from the server's source and restart.
// Docker/unmanaged agents decline (their host rebuilds them) — surface why.
async function updateAgent(a, target) {
  const name = a.display_name || a.hostname;
  const verText = target ? `to v${target}` : 'from the server source';
  if (!confirm(`Update ${name} ${verText}?\n\nThe agent will rebuild from the server's source bundle and restart, briefly interrupting monitoring on that host.`)) return;
  try {
    const r = await api(`/agents/${a.id}/update`, { method: 'POST' });
    if (r.accepted) { toast(`${name}: update sent — rebuilding and restarting.`); return; }
    if (r.reason === 'docker-managed') { toast(`${name} runs under Docker — update it by re-running the host installer.`, true); return; }
    if (r.reason === 'unmanaged') { toast(`${name} isn't service-managed — update it manually (re-run the installer).`, true); return; }
    toast(`${name}: the agent did not accept the update.`, true);
  } catch (err) { toast(`${name}: ${err.message}`, true); }
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
    el('td', {}, el('div', {}, p.name), p.created_by ? el('div', { class: 'muted' }, `by ${esc(String(p.created_by))}`) : null),
    el('td', {}, testItemsSummary(p.items)),
    el('td', {}, testTargetsSummary(p.targets, agents, locations)),
    el('td', {}, testScheduleLabel(p.schedule_ms)),
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

function testScheduleLabel(ms) {
  const found = SCHEDULE_PRESETS.find(([v]) => Number(v) === Number(ms || 0));
  if (found) return found[1];
  return ms ? `Every ${Math.round(ms / 1000)}s` : 'Manual only';
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
  const scheduleSel = el('select', {}, ...SCHEDULE_PRESETS.map(([v, l]) => el('option', { value: v, ...(Number(v) === Number(data.schedule_ms || 0) ? { selected: 'selected' } : {}) }, l)));

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
    const typeSel = el('select', {}, ...[['ping', 'Ping'], ['tcp', 'TCP'], ['dns', 'DNS'], ['traceroute', 'Traceroute'], ['curl', 'cURL'], ['pageload', 'Page load'], ['transaction', 'Transaction'], ['run-test', 'Throughput'], ['speedtest', 'Speed test']].map(([v, l]) => el('option', { value: v }, l)));
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
    return { name: nameInput.value.trim(), enabled: enabledInput.checked, schedule_ms: Number(scheduleSel.value), targets, items };
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
  const title = `Speed test — ${esc(a.display_name || a.hostname)}`;
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
      kids.push(el('div', { class: 'form-actions' }, runBtn));
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
    const body = [el('h3', {}, `Traffic — ${esc(a.display_name || a.hostname)}`)];
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
    el('h3', {}, `Flows — ${esc(a.display_name || a.hostname)}`),
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
  // Event markers (drawn on top).
  if (Array.isArray(markers)) {
    const colOf = (k) => (k === 'CRIT' ? '#dc2626' : k === 'WARN' ? '#d97706' : k === 'probe' ? '#dc2626' : '#64748b');
    for (const m of markers) {
      if (!Number.isFinite(m.t) || m.t < fromMs || m.t > toMs) continue;
      const xx = xOf(m.t); const col = colOf(m.kind);
      svg.append(mk('line', { x1: xx, y1: pad.t, x2: xx, y2: H - pad.b, stroke: col, 'stroke-opacity': '0.55', 'stroke-dasharray': '3 3', 'stroke-width': 1 }));
      const tri = mk('path', { d: `M${xx - 4},${H - pad.b} L${xx + 4},${H - pad.b} L${xx},${H - pad.b - 7} Z`, fill: col });
      const title = mk('title', {}); title.textContent = m.label || ''; tri.append(title);
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
    if (info.error) col.append(el('div', { class: 'small muted' }, esc(info.error)));
    return col;
  }
  const biggest = (info.tables && info.tables[0]) || null;
  const counts = [`${info.tableCount} tables`];
  if (kind === 'tsdb' && info.hypertableCount) counts.push(`${info.hypertableCount} hypertables`);
  col.append(
    el('div', { class: 'storage-row' }, el('span', { class: 'k' }, `Database ${esc(info.name || '')}`), el('span', { class: 'v' }, fmtBytes(info.totalBytes))),
    el('div', { class: 'small muted' }, `${counts.join(' · ')}${biggest ? ` · largest: ${esc(biggest.name)} (${fmtBytes(biggest.bytes)})` : ''}`));
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
      el('div', { class: 'storage-row' }, el('span', { class: 'k' }, `Drive ${esc(d.path || '')}`), el('span', { class: 'v' }, `${fmtBytes(d.freeBytes)} free`)),
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

// ---- Analysis (findings + AI assistant) ----------------------------------
// hostId of a finding is the agent id (the analysis pipeline keys on it).
const findingsState = { hostId: '', tbody: null, agentName: null };

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

views.findings = async () => {
  const root = el('div');
  const agents = await api('/agents').catch(() => []);
  const agentName = (id) => {
    const a = agents.find((x) => String(x.id) === String(id));
    return a ? (a.display_name || a.hostname) : `host ${id}`;
  };
  findingsState.agentName = agentName;

  const hostSelect = el('select', {},
    el('option', { value: '' }, 'All hosts'),
    ...agents.map((a) => el('option',
      { value: String(a.id), ...(String(a.id) === findingsState.hostId ? { selected: 'selected' } : {}) },
      a.display_name || a.hostname)));
  hostSelect.addEventListener('change', () => { findingsState.hostId = hostSelect.value; loadList(); });

  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Analysis — errors & anomalies'),
    el('span', { class: 'muted' }, 'computed locally'),
    el('span', { class: 'spacer' }),
    exportButtons('findings', () => (findingsState.hostId ? { hostId: findingsState.hostId } : {})),
    el('label', { class: 'muted inline' }, 'Host ', hostSelect)));

  if (featureEnabled('assistant')) root.append(assistantBox(() => findingsState.hostId));

  const listHost = el('div', {});
  root.append(listHost);

  async function loadList() {
    listHost.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
    let findings;
    try {
      const qs = findingsState.hostId ? `?hostId=${encodeURIComponent(findingsState.hostId)}` : '';
      findings = await api(`/api/findings${qs}`);
    } catch (err) {
      findingsState.tbody = null;
      listHost.replaceChildren(el('div', { class: 'empty error' }, err.message));
      return;
    }
    if (!findings.length) {
      findingsState.tbody = null;
      listHost.replaceChildren(el('div', { class: 'empty' }, 'No findings yet. When an agent reports abnormal measurements they will appear here.'));
      return;
    }
    const tbody = el('tbody', {}, ...findings.map((f) => findingRow(agentName, f)));
    findingsState.tbody = tbody;
    listHost.replaceChildren(el('table', { class: 'findings' },
      el('thead', {}, el('tr', {}, ...['Time', 'Host', 'Metric', 'Severity', 'Deviation', 'Explanation', ''].map((h) => el('th', {}, h)))),
      tbody));
  }

  loadList();
  return root;
};

function findingRow(agentName, f) {
  const dev = typeof f.deviation === 'number' ? `${f.deviation.toFixed(1)}σ` : '–';
  const corr = Array.isArray(f.correlatedWith) && f.correlatedWith.length
    ? el('div', { class: 'muted' }, `correlated with ${f.correlatedWith.length} other(s)`)
    : null;
  const action = f.acked
    ? el('span', { class: 'muted' }, 'acknowledged')
    : (canWrite() ? el('button', { class: 'small ghost', onclick: (e) => ackFinding(f, e.target) }, 'Acknowledge') : null);
  const tr = el('tr', { class: f.acked ? 'acked' : '' },
    el('td', { class: 'muted' }, fmtDate(f.createdAt)),
    el('td', {}, agentName(f.hostId)),
    el('td', {}, f.metric),
    el('td', {}, el('span', { class: `badge ${esc(f.severity || 'INFO')}` }, f.severity || 'INFO'),
      f.kind === 'FLATLINE' ? el('span', { class: 'muted' }, ' flatline') : null),
    el('td', {}, dev),
    el('td', {}, el('div', {}, f.explanation || '–'), corr),
    el('td', {}, action));
  tr.dataset.findingId = f.id;
  return tr;
}

async function ackFinding(f, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(`/api/findings/${encodeURIComponent(f.id)}/ack`, { method: 'POST' });
    f.acked = true;
    toast('Acknowledged');
    const tr = btn && btn.closest('tr');
    if (tr) { tr.classList.add('acked'); btn.replaceWith(el('span', { class: 'muted' }, 'acknowledged')); }
  } catch (err) {
    if (btn) btn.disabled = false;
    toast(err.message, true);
  }
}

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
        el('div', { class: 'assistant-meta muted' }, `${esc(res.model || '')} · ${res.usedFindings ?? 0} findings in context`));
    } catch (err) {
      out.className = 'assistant-out muted';
      out.textContent = err.status === 403
        ? 'The AI assistant is disabled. An administrator can enable it under Settings → Analysis → AI assistant.'
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

// ---- Incidents (first-class incident_cases) --------------------------------
let selectedIncidentId = null;
function openIncident(id) { selectedIncidentId = id; currentView = 'incident'; render(); }

const INC_STATUS_LABEL = { open: 'Open', investigating: 'Investigating', resolved: 'Resolved', closed: 'Closed' };
const INC_TRANSITIONS = { open: ['investigating'], investigating: ['resolved'], resolved: ['closed'], closed: ['open'] };
const incStatusBadge = (s) => el('span', { class: `badge inc-status-${s}` }, INC_STATUS_LABEL[s] || s);
const incSevBadge = (s) => el('span', { class: `badge inc-sev-${s}` }, s);

PAGE_INFO.incidents = {
  hero: 'Incidents group related anomalies on the same device into one case you can track from open to closed — with a timeline, the config change that may have triggered it, similar past incidents, and an opt-in AI assistant.',
  title: 'Incidents — grouped anomalies, tracked end-to-end',
  body: () => [
    el('p', {}, 'Each incident wraps the analysis findings (anomalies) that fired close together on one device. Status moves open → investigating → resolved → closed; a closed incident can be reopened with a comment (recorded in the audit trail).'),
    el('p', {}, 'The detail page shows the incident timeline, the device-config change suspected to have triggered it, similar past incidents, and — when the EU AI assistant is enabled — a chat that answers questions using only masked, aggregated context.'),
    el('p', { class: 'muted' }, 'Status changes, config history and the AI chat are operator/admin only.'),
  ],
};

views.incidents = async () => {
  const wrap = el('div', { class: 'incidents-view' });
  const filters = { status: '', severity: '', device: '' };
  const tbody = el('tbody', {});
  const table = el('table', { class: 'data' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Severity'), el('th', {}, 'Status'), el('th', {}, 'Title'),
      el('th', {}, 'Device'), el('th', {}, 'First seen'), el('th', {}, 'Last activity'), el('th', {}, ''))),
    tbody);

  async function load() {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: '7', class: 'muted' }, 'Loading…')));
    const qs = new URLSearchParams();
    if (filters.status) qs.set('status', filters.status);
    if (filters.severity) qs.set('severity', filters.severity);
    if (filters.device) qs.set('device', filters.device);
    try {
      const { incidents } = await api(`/api/incidents${qs.toString() ? `?${qs}` : ''}`);
      if (!incidents.length) { tbody.replaceChildren(el('tr', {}, el('td', { colspan: '7', class: 'muted' }, 'No incidents match.'))); return; }
      tbody.replaceChildren(...incidents.map((i) => el('tr', {
        class: 'clickable', tabindex: '0',
        onclick: () => openIncident(i.id), onkeydown: (e) => { if (e.key === 'Enter') openIncident(i.id); },
      },
        el('td', {}, incSevBadge(i.severity)),
        el('td', {}, incStatusBadge(i.status)),
        el('td', {}, esc(i.title)),
        el('td', { class: 'muted' }, esc(i.deviceId)),
        el('td', { class: 'muted' }, fmtDate(i.firstEventAt)),
        el('td', { class: 'muted' }, fmtDate(i.lastEventAt)),
        el('td', {}, canWrite() ? el('button', { class: 'pill guide-pill small', title: 'Guided troubleshooting', onclick: (e) => { e.stopPropagation(); guideFromList(i.id); } }, '🧭 Guide') : ''))));
    } catch (err) {
      tbody.replaceChildren(el('tr', {}, el('td', { colspan: '7', class: 'error' }, err.message)));
    }
  }

  const statusSel = el('select', { onchange: (e) => { filters.status = e.target.value; load(); } },
    el('option', { value: '' }, 'All statuses'),
    ...Object.keys(INC_STATUS_LABEL).map((s) => el('option', { value: s }, INC_STATUS_LABEL[s])));
  const sevSel = el('select', { onchange: (e) => { filters.severity = e.target.value; load(); } },
    el('option', { value: '' }, 'All severities'),
    ...['INFO', 'WARN', 'CRIT'].map((s) => el('option', { value: s }, s)));
  const devInput = el('input', { type: 'text', placeholder: 'Device id', oninput: (e) => { filters.device = e.target.value.trim(); } });
  const devBtn = el('button', { class: 'small ghost', onclick: () => load() }, 'Filter');

  wrap.append(el('div', { class: 'toolbar' }, statusSel, sevSel, devInput, devBtn), table);
  await load();
  return wrap;
};

async function loadIncidentTimeline(id, card, deviceId) {
  const head = el('h3', {}, 'Timeline');
  const devNum = Number(deviceId);
  // Anomaly + config-change events link to the device page (its findings/health
  // and, for config, the Config history card). Status changes have no target.
  const canLink = Number.isInteger(devNum);
  try {
    const { events } = await api(`/api/incidents/${id}/timeline`);
    if (!events.length) { card.replaceChildren(head, el('p', { class: 'muted' }, 'No events yet.')); return; }
    card.replaceChildren(head, el('ul', { class: 'timeline' }, ...events.map((e) => {
      const linkable = canLink && (e.type === 'anomaly' || e.type === 'config_change');
      return el('li', {
        class: `tl tl-${e.type}${linkable ? ' clickable' : ''}`,
        ...(linkable ? { title: 'Open device', onclick: () => openAgent(devNum) } : {}),
      },
        el('span', { class: 'tl-time muted' }, fmtDate(e.timestamp)),
        el('span', { class: `tl-dot tl-dot-${e.type}` }),
        el('span', { class: 'tl-desc' }, esc(e.description || e.type),
          e.severity ? el('span', { class: 'muted' }, ` [${e.severity}]`) : null,
          e.status ? el('span', { class: 'muted' }, ` [${e.status}]`) : null));
    })));
  } catch (err) { card.replaceChildren(head, el('p', { class: 'error' }, err.message)); }
}

async function loadIncidentSimilar(id, card) {
  const head = el('h3', {}, 'Similar past incidents');
  try {
    const { similar } = await api(`/api/incidents/${id}/similar`);
    if (!similar.length) { card.replaceChildren(head, el('p', { class: 'muted' }, 'No similar incidents found.')); return; }
    card.replaceChildren(head, el('ul', { class: 'inc-similar' }, ...similar.map((s) => el('li', {
      class: 'clickable', onclick: () => openIncident(s.id),
    },
      el('span', { class: 'badge' }, `score ${s.score}`), ' ', esc(s.title || `#${s.id}`),
      el('span', { class: 'muted' }, ` · ${(s.matchedOn || []).join(', ')} · resolved ${fmtDate(s.resolvedAt)}${s.closedBy ? ` by ${esc(s.closedBy)}` : ''}`)))));
  } catch (err) { card.replaceChildren(head, el('p', { class: 'error' }, err.message)); }
}

async function loadIncidentConfigContext(id, card) {
  const head = el('h3', {}, 'Config context');
  try {
    const ctx = await api(`/api/incidents/${id}/config-context`);
    if (!ctx.configChangeId) { card.replaceChildren(head, el('p', { class: 'muted' }, 'No correlated config change.')); return; }
    const st = ctx.suspectedTrigger;
    const diff = ctx.diff || {};
    card.replaceChildren(head,
      st ? el('p', { class: 'callout' }, `⚠ ${esc(st.note)}`) : null,
      el('p', { class: 'muted' }, `Risk: ${diff.risk || 'n/a'}${(diff.riskReasons || []).length ? ` (${diff.riskReasons.join(', ')})` : ''} · +${(diff.stats && diff.stats.added) || 0}/-${(diff.stats && diff.stats.removed) || 0} lines · captured ${fmtDate(ctx.change && ctx.change.capturedAt)} (${esc((ctx.change && ctx.change.capturedVia) || '')})`),
      diff.changedLines && diff.changedLines.length
        ? el('pre', { class: 'config-diff' }, diff.changedLines.map((l) => `${l.op} ${l.text}`).join('\n'))
        : null);
  } catch (err) {
    card.replaceChildren(head, el('p', { class: err.status === 403 ? 'muted' : 'error' }, err.status === 403 ? 'Requires operator/admin.' : err.message));
  }
}

function incidentAssistantCard(id) {
  const out = el('div', { class: 'assistant-out muted' }, 'Ask a question about this incident.');
  const input = el('input', { type: 'text', placeholder: 'e.g. what likely triggered this?', class: 'inc-ask-input' });
  const askBtn = el('button', { class: 'small' }, 'Ask AI');
  async function ask() {
    const q = input.value.trim();
    if (!q) return;
    out.className = 'assistant-out muted';
    out.textContent = 'Thinking…';
    askBtn.disabled = true;
    try {
      const res = await api(`/api/incidents/${id}/ask`, { method: 'POST', body: { question: q } });
      out.className = 'assistant-out';
      out.replaceChildren(
        el('div', { class: 'ai-badge' }, '⚠ AI-generated'),
        el('div', {}, res.answer || '(empty response)'),
        el('div', { class: 'assistant-meta muted' }, `${esc(res.model || 'no provider call')}${res.cached ? ' · cached' : ''}${res.dataAvailable === false ? ' · insufficient context' : ''}`));
    } catch (err) {
      out.className = 'assistant-out muted';
      out.textContent = err.status === 403
        ? 'The AI assistant is disabled or not licensed. Enable it in Settings → AI assistant.'
        : (err.status === 404 ? 'Incident not found.' : err.message);
    } finally { askBtn.disabled = false; }
  }
  askBtn.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  return el('div', { class: 'card' },
    el('h3', {}, 'Ask AI about this incident'),
    el('p', { class: 'muted' }, 'Answers use only masked, aggregated context (timeline, config diff, similar incidents). No raw config or secrets are sent.'),
    el('div', { class: 'inc-ask' }, input, askBtn),
    out);
}

// The per-incident detail page (no tab — reached via openIncident).
// ---- Guided troubleshooting ("Guide me") -----------------------------------
let guideAutoOpen = false;
function guideFromList(id) { guideAutoOpen = true; openIncident(id); }

// Deep-link a guide step's suggested action into the existing tools.
function guideNavigate(action, incident) {
  if (!action) return;
  if (action.view === 'incident') { openIncident(action.targetId); return; }
  const dev = Number(action.view === 'config-context' ? (incident.deviceId ?? incident.hostId) : action.targetId);
  if (!Number.isInteger(dev)) return;
  if (action.view === 'flows') { openFlows(dev); return; }
  openAgent(dev); // agent / interfaces / config-context all live on the device page
}

async function loadGuide(incident, body) {
  try {
    const guide = await api(`/api/incidents/${incident.id}/guide`);
    if (!guide.steps || !guide.steps.length) { body.replaceChildren(el('p', { class: 'muted' }, 'No guidance available for this incident.')); return; }
    const doneKey = `blueeye.guide.${incident.id}`;
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
        const res = await api(`/api/incidents/${incident.id}/ask`, { method: 'POST', body: { question: seed } });
        aiOut.className = 'assistant-out';
        aiOut.replaceChildren(
          el('div', { class: 'ai-badge' }, '⚠ AI-generated'),
          el('div', {}, res.answer || '(empty response)'),
          el('div', { class: 'assistant-meta muted' }, `${esc(res.model || 'no provider call')}${res.dataAvailable === false ? ' · insufficient context' : ''}`));
      } catch (err) {
        aiOut.className = 'assistant-out muted';
        aiOut.textContent = err.status === 403 ? 'The AI assistant is disabled or not licensed (Settings → AI assistant).' : err.message;
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
      const actionBtn = s.action ? el('button', { class: 'small ghost', onclick: () => guideNavigate(s.action, incident) }, s.action.label) : null;
      const askBtn = el('button', { class: 'small ghost', onclick: () => askAbout(`Help me with this troubleshooting step for the incident: "${s.title}". ${s.detail}`) }, 'Ask AI');
      li.append(
        el('label', { class: 'guide-step-head' }, cb, el('span', { class: 'guide-step-title' }, esc(s.title)), el('span', { class: `badge kind-${s.kind}` }, s.kind)),
        el('p', { class: 'guide-detail' }, esc(s.detail)),
        el('p', { class: 'guide-rationale muted' }, '↳ ', esc(s.rationale)),
        el('div', { class: 'guide-actions' }, actionBtn, askBtn));
      return li;
    });

    const freeQ = el('input', { type: 'text', placeholder: 'Ask BlueEye AI about this incident…', class: 'inc-ask-input' });
    const freeBtn = el('button', { class: 'small', onclick: () => { if (freeQ.value.trim()) askAbout(freeQ.value.trim()); } }, 'Ask AI');
    freeQ.addEventListener('keydown', (e) => { if (e.key === 'Enter' && freeQ.value.trim()) askAbout(freeQ.value.trim()); });

    refresh();
    body.replaceChildren(
      progress,
      el('ol', { class: 'guide-steps' }, ...steps),
      el('div', { class: 'guide-ai' },
        el('p', { class: 'muted' }, 'BlueEye built these steps from this incident. Ask the AI to explain a step or the likely cause — it uses only masked context.'),
        el('div', { class: 'inc-ask' }, freeQ, freeBtn), aiOut));
  } catch (err) {
    body.replaceChildren(el('p', { class: err.status === 403 ? 'muted' : 'error' }, err.status === 403 ? 'Guided troubleshooting requires operator/admin.' : err.message));
  }
}

// A collapsible "Guide me" card that lazy-loads the step-by-step guide on open.
function incidentGuideCard(incident) {
  const body = el('div', { class: 'guide-body' }, el('p', { class: 'muted' }, 'Loading…'));
  let loaded = false;
  const openAndLoad = () => { if (!loaded) { loaded = true; loadGuide(incident, body); } };
  const details = el('details', { class: 'card guide-card' },
    el('summary', { class: 'guide-summary' },
      el('span', { class: 'pill guide-pill' }, '🧭 Guide me'),
      el('span', { class: 'muted' }, ' — step-by-step troubleshooting, BlueEye + AI')),
    body);
  details.addEventListener('toggle', () => { if (details.open) openAndLoad(); });
  if (guideAutoOpen) { guideAutoOpen = false; details.open = true; openAndLoad(); }
  return details;
}

views.incident = async () => {
  const id = selectedIncidentId;
  const back = el('button', { class: 'small ghost', onclick: () => { currentView = 'incidents'; render(); } }, '← Incidents');
  if (id == null) return el('div', { class: 'empty' }, back, el('p', {}, 'No incident selected.'));

  let data;
  try {
    data = await api(`/api/incidents/${id}`);
  } catch (err) {
    if (err.status === 404) return el('div', { class: 'empty' }, back, el('p', { class: 'error' }, 'Incident not found.'));
    return el('div', { class: 'empty error' }, back, ' ', err.message);
  }
  const inc = data.incident;
  const anomalies = data.anomalies || [];

  const header = el('div', { class: 'inc-header' },
    el('div', {},
      el('h2', {}, esc(inc.title)),
      el('div', { class: 'inc-meta' }, incSevBadge(inc.severity), ' ', incStatusBadge(inc.status),
        el('span', { class: 'muted' }, ` · device ${esc(inc.deviceId)} · opened ${fmtDate(inc.firstEventAt)}`))),
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
            await api(`/api/incidents/${id}`, { method: 'PATCH', body: { status: to, ...(comment ? { comment } : {}) } });
            toast(`Incident ${INC_STATUS_LABEL[to].toLowerCase()}`);
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
          incSevBadge(a.severity), ' ', el('strong', {}, esc(a.metric)), ' — ', esc(a.explanation || ''),
          el('span', { class: 'muted' }, ` (${fmtDate(a.createdAt)})`))))
      : el('p', { class: 'muted' }, 'No linked anomalies.'));

  const timelineCard = el('div', { class: 'card' }, el('h3', {}, 'Timeline'), el('div', { class: 'muted' }, 'Loading…'));
  loadIncidentTimeline(id, timelineCard, inc.deviceId);
  const similarCard = el('div', { class: 'card' }, el('h3', {}, 'Similar past incidents'), el('div', { class: 'muted' }, 'Loading…'));
  loadIncidentSimilar(id, similarCard);

  const extra = [];
  if (canWrite()) {
    const cfgCard = el('div', { class: 'card' }, el('h3', {}, 'Config context'), el('div', { class: 'muted' }, 'Loading…'));
    loadIncidentConfigContext(id, cfgCard);
    extra.push(cfgCard);
    if (featureEnabled('assistant')) extra.push(incidentAssistantCard(id));
  }

  // "Guide me" — operator/admin (the guide endpoint + its config/AI steps are).
  const guideCard = canWrite() ? incidentGuideCard(inc) : null;

  return el('div', { class: 'incident-detail' }, header, controls, guideCard, anomaliesCard, timelineCard, similarCard, ...extra);
};

views.overview = async () => {
  const root = el('div', { class: 'overview' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Traffic'),
    el('span', { class: 'muted' }, 'auto-updates every 3 sec.')));

  // NOC: alert banner (latest unacked CRIT/WARN finding) + KPI grid.
  const alertBanner = el('div', { class: 'alert-banner hidden' });
  root.append(alertBanner);

  // Compact KPI strip: one slim row instead of four tall cards.
  const kpiStat = (cls, label) => {
    const value = el('span', { class: 'v num' }, '–');
    const sub = el('span', { class: 'kpi-mini' });
    return { node: el('div', { class: `kpi ${cls}` }, el('span', { class: 'k' }, label), value, sub), value, sub };
  };
  const kRx = kpiStat('rx', '↓ RX');
  const kTx = kpiStat('tx', '↑ TX');
  const kAg = kpiStat('ag', 'Agents');
  const kLoc = kpiStat('loc', 'Locations');
  root.append(el('div', { class: 'kpis' }, kRx.node, kTx.node, kAg.node, kLoc.node));

  async function refreshAlert() {
    try {
      const fs = await api(`/api/findings?since=${new Date(Date.now() - 3600000).toISOString()}`);
      const hit = fs.find((f) => (f.severity === 'CRIT' || f.severity === 'WARN') && !f.acked);
      if (hit) {
        alertBanner.className = `alert-banner sev-${hit.severity}`;
        alertBanner.replaceChildren(
          el('span', { class: 'alert-ic' }, '⚠'),
          el('span', {}, `${hit.severity}: ${esc(hit.metric || '')} — ${esc(hit.explanation || '')}`),
          el('span', { class: 'spacer' }),
          el('span', { class: 'muted small' }, fmtDate(hit.createdAt)),
          el('button', { class: 'small ghost', onclick: () => { currentView = 'findings'; render(); } }, 'Details'));
      } else { alertBanner.className = 'alert-banner hidden'; alertBanner.replaceChildren(); }
    } catch { alertBanner.className = 'alert-banner hidden'; }
  }
  refreshAlert();
  api('/locations').then((locs) => {
    kLoc.value.textContent = String(locs.length);
    kLoc.node.title = `${locs.filter((l) => l.latitude != null).length} with coordinates`;
  }).catch(() => {});

  // Top agents by current bandwidth (updated each tick).
  const topAgents = el('div', { class: 'top-agents' });

  // Hero chart: the chart fills the card's full width. Dragging across it zooms
  // into the selected timespan (freezing the live view to that window); the
  // "Reset zoom" chip returns to the live rolling view.
  const chartHost = el('div', { class: 'overview-chart' });
  const controls = el('div', { class: 'peragent-list' });
  const chipRx = el('button', { class: 'chip rx', onclick: () => toggleSeries('total:rx') }, 'Total RX');
  const chipTx = el('button', { class: 'chip tx', onclick: () => toggleSeries('total:tx') }, 'Total TX');
  const perAgentCnt = el('span', { class: 'cnt muted' });
  const perAgent = el('details', { class: 'chip-det' },
    el('summary', { class: 'chip' }, 'Pr. agent ', perAgentCnt), controls);
  const zoomBtn = el('button', { class: 'chip size-toggle', onclick: () => resetZoom() });
  let zoom = null; // frozen snapshot of the dragged window, or null while live
  const chartCard = el('div', { class: 'chart-card' },
    el('div', { class: 'bar' }, el('h3', {}, 'Live traffic'), el('span', { class: 'spacer' }), chipRx, chipTx, perAgent, zoomBtn),
    el('div', { class: 'chart-row' }, chartHost));
  root.append(chartCard);

  // Slim storage line; the full disk/DB/forbrug breakdown folds open below it.
  const storageSummary = el('summary', { class: 'storage-line' }, el('span', { class: 'muted' }, 'Storage …'));
  const storageBody = el('div', { class: 'storage-detail-body' });
  root.append(el('details', { class: 'storage-fold' }, storageSummary, storageBody));
  function refreshStorage() {
    api('/system/storage').then((s) => {
      storageSummary.replaceChildren(...storageLineParts(s));
      storageBody.replaceChildren(storageCards(s));
    }).catch(() => {});
  }
  refreshStorage();

  root.append(el('details', { class: 'sec' }, el('summary', {}, 'Top agents ', el('span', { class: 'muted' }, '· by current bandwidth')), topAgents));

  // history[seriesId] = [{ y }]; selection is a Set of seriesId.
  const history = new Map();
  const selection = ovState.selection;
  const MAX = 60;
  let agentsMeta = [];
  let tickN = 0;

  function pushPoint(id, label, y) {
    if (!history.has(id)) history.set(id, { label, points: [] });
    const h = history.get(id);
    h.label = label;
    h.points.push({ y, t: Date.now() });
    if (h.points.length > MAX) h.points.shift();
  }

  async function tick() {
    let agents;
    try { agents = await api('/agents'); } catch (err) { chartHost.replaceChildren(el('p', { class: 'error' }, err.message)); return; }
    agentsMeta = agents;
    // Fetch each agent's latest result (rate) in parallel.
    const latest = await Promise.all(agents.map(async (a) => {
      try {
        const rows = await api(`/agents/${a.id}/results?limit=1`);
        const t = rows[0] && rows[0].payload && rows[0].payload.traffic && rows[0].payload.traffic.totals;
        return { a, rx: t ? Number(t.rxBytesPerSec) || 0 : 0, tx: t ? Number(t.txBytesPerSec) || 0 : 0 };
      } catch { return { a, rx: 0, tx: 0 }; }
    }));
    let totalRx = 0;
    let totalTx = 0;
    for (const { a, rx, tx } of latest) {
      const name = a.display_name || a.hostname;
      pushPoint(`rx:${a.id}`, `${name} RX`, rx);
      pushPoint(`tx:${a.id}`, `${name} TX`, tx);
      totalRx += rx; totalTx += tx;
    }
    pushPoint('total:rx', 'Total RX', totalRx);
    pushPoint('total:tx', 'Total TX', totalTx);

    // KPI cards.
    kRx.value.textContent = `${fmtBytes(totalRx)}/s`;
    kTx.value.textContent = `${fmtBytes(totalTx)}/s`;
    const online = agents.filter((a) => a.status === 'online').length;
    kAg.value.textContent = `${online} / ${agents.length}`;
    kAg.sub.replaceChildren(usageBar(agents.length ? Math.round((online / agents.length) * 100) : 0));

    // Top agents by current bandwidth.
    const top = latest.slice().sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx)).slice(0, 5);
    topAgents.replaceChildren(
      ...(top.length ? top.map(({ a, rx, tx }) => el('div', { class: 'ta-row' },
        el('span', { class: `badge ${a.status}` }, a.status === 'online' ? '●' : '○'),
        el('span', { class: 'ta-name' }, esc(a.display_name || a.hostname)),
        el('span', { class: 'ta-bw muted' }, `↓ ${fmtBytes(rx)}/s · ↑ ${fmtBytes(tx)}/s`))) : [el('div', { class: 'muted' }, 'No agents.')]));

    // Default selection on first load: the two totals.
    if (!selection.size) { selection.add('total:rx'); selection.add('total:tx'); }

    renderChart();
    renderControls();

    // Periodically refresh the alert banner + storage (not every 3s tick).
    tickN += 1;
    if (tickN % 10 === 0) { refreshAlert(); refreshStorage(); }
  }

  // The live series: the selected ids mapped onto their rolling history
  // buffers, coloured cyan for RX / emerald for TX and the palette otherwise.
  function liveSeries() {
    const colorFor = (id, idx) => (id.includes('rx') ? '#06b6d4' : id.includes('tx') ? '#10b981' : SERIES_COLORS[idx % SERIES_COLORS.length]);
    return [...selection].filter((id) => history.has(id)).map((id, idx) => ({
      id, label: history.get(id).label, color: colorFor(id, idx),
      points: history.get(id).points,
    }));
  }

  function renderChart() {
    // While zoomed the chart is frozen to the snapshot taken at drag time, so
    // the 3-second live tick doesn't fight the zoom; otherwise it's the rolling
    // live series.
    const seriesList = zoom ? zoom.series : liveSeries();
    const legend = legendFor(seriesList);
    // Running clock ticks (HH:MM:SS) from the actual point timestamps, so the
    // x-axis shows the (live or zoomed) timeframe rather than a static label.
    const ref = seriesList.find((s) => s.points.length >= 2);
    const TICKS = 5;
    let xLabels = ['~3 min ago', '', 'now'];
    if (ref) {
      const pts = ref.points;
      xLabels = Array.from({ length: TICKS }, (_, i) =>
        fmtClock(pts[Math.round((i / (TICKS - 1)) * (pts.length - 1))].t));
    }
    chartHost.replaceChildren(
      seriesList.length ? multiChart(seriesList, { height: 300, area: true, xLabels, onBrush: (f0, f1) => { if (f0 === null) resetZoom(); else zoomTo(f0, f1); } }) : el('div', { class: 'empty' }, 'Select series in the toolbar ↑'),
      legend);
    syncChips();
  }

  // Drag-to-zoom: freeze the chart to the dragged slice of whatever is shown
  // now (the live buffer, or an existing zoom — so a second drag zooms in
  // further). Snapshots the points so later live ticks leave the window be.
  function zoomTo(f0, f1) {
    const base = zoom ? zoom.series : liveSeries();
    if (!base.length) return;
    const lo = Math.min(f0, f1);
    const hi = Math.max(f0, f1);
    // multiChart stretches each series across the full width using its own
    // point count, so map the dragged fraction onto each series' own index
    // range. A single shared length would slice a shorter series past its end
    // (it would vanish from the zoom) or zoom it to the wrong interval.
    const series = base
      .map((s) => {
        const n = s.points.length;
        const i0 = Math.round(lo * (n - 1));
        const i1 = Math.round(hi * (n - 1));
        return { id: s.id, label: s.label, color: s.color, points: s.points.slice(i0, i1 + 1).map((p) => ({ t: p.t, y: p.y })) };
      })
      .filter((s) => s.points.length >= 2);
    if (!series.length) return;
    zoom = { series };
    updateZoomBtn();
    renderChart();
  }
  function resetZoom() {
    if (!zoom) return;
    zoom = null;
    updateZoomBtn();
    renderChart();
  }
  // The toolbar chip only does something while zoomed; greyed out otherwise.
  function updateZoomBtn() {
    zoomBtn.textContent = '↺ Reset zoom';
    zoomBtn.disabled = !zoom;
    zoomBtn.classList.toggle('on', !!zoom);
    zoomBtn.title = zoom ? 'Return to the live rolling view' : 'Drag across the chart to zoom into a timespan';
  }

  function checkbox(id, label) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = selection.has(id);
    cb.addEventListener('change', () => { if (cb.checked) selection.add(id); else selection.delete(id); if (zoom) resetZoom(); else renderChart(); });
    return el('label', { class: 'check' }, cb, label);
  }

  // Per-agent series live in the "Pr. agent" chip menu; totals are the chips.
  function renderControls() {
    const items = [];
    for (const a of agentsMeta) {
      const name = a.display_name || a.hostname;
      items.push(checkbox(`rx:${a.id}`, `${name} · RX`), checkbox(`tx:${a.id}`, `${name} · TX`));
    }
    controls.replaceChildren(...(items.length ? items : [el('div', { class: 'muted' }, 'No agents.')]));
    syncChips();
  }

  // Toolbar chips toggle the two totals and reflect the live selection.
  function toggleSeries(id) {
    if (selection.has(id)) selection.delete(id); else selection.add(id);
    if (zoom) resetZoom(); else renderChart();
  }
  function syncChips() {
    chipRx.classList.toggle('on', selection.has('total:rx'));
    chipTx.classList.toggle('on', selection.has('total:tx'));
    let n = 0;
    for (const id of selection) if (id.startsWith('rx:') || id.startsWith('tx:')) n += 1;
    perAgentCnt.textContent = n ? `(${n})` : '';
  }

  // Historical traffic explorer (date range, types, time axis, brush-to-zoom),
  // with the Traffic types aggregate card beside it (side by side; stacks on
  // narrow viewports). The card derives its figures from the history samples.
  const typesCard = trafficTypesCard();
  const histSection = trafficHistorySection({ onData: (d) => typesCard.update(d) });
  const histDetails = el('details', { class: 'sec hist-main' }, el('summary', {}, 'History — inspect time window ', el('span', { class: 'muted' }, '· select agent + period')), histSection.node);
  root.append(el('div', { class: 'hist-row' }, histDetails, typesCard.node));

  // Traffic-type breakdown (DNS, Web, Facebook, …) — opt-in, collapsed.
  const typeSection = trafficTypeSection();
  root.append(el('details', { class: 'sec' }, el('summary', {}, 'Traffic type ', el('span', { class: 'muted' }, '· per agent · DNS, Facebook, …')), typeSection.node));

  // Set the zoom-button state and render once before the first tick.
  updateZoomBtn();
  renderChart();

  // Lifecycle: poll while this view is mounted; stop when leaving.
  stopOverview();
  ovState.timer = setInterval(() => { if (!modalOpen()) tick(); }, 3000);
  tick();
  return root;
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
      el('td', {}, esc(i.iface)),
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

// `onInstall(tool, row)` is optional; when provided, a failed probe that names a
// missing installable tool gets an "Install <tool>" button.
function probeLatestTable(rows, onDetail, onInstall = null) {
  if (!rows.length) return el('div', { class: 'muted' }, 'No probe results yet — run one above.');
  return el('table', {},
    el('thead', {}, el('tr', {}, ...['Type', 'Target', 'Status', 'RTT', 'Loss', 'Jitter', 'Time', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((r) => {
      const tool = onInstall ? missingToolOf(r) : null;
      return el('tr', {},
        el('td', {}, r.type),
        el('td', {}, esc(r.target),
          // curl/http carry a verification/cert explanation; a failed probe carries
          // its reason (e.g. "traceroute not installed"). Surface it inline.
          r.detail ? el('div', { class: 'muted small' }, esc(r.detail)) : null,
          (r.type === 'curl' && r.contentType) ? el('div', { class: 'muted small' }, `${esc(r.contentType)}${r.bytes != null ? ` · ${r.bytes} B` : ''}`) : null),
        el('td', {}, el('span', { class: `badge ${r.ok ? 'online' : 'offline'}`, title: !r.ok && r.detail ? r.detail : null }, r.ok ? 'ok' : 'error')),
        el('td', { class: 'num' }, r.rttMs != null ? `${r.rttMs} ms` : '–'),
        el('td', { class: 'num' }, r.lossPct != null ? `${r.lossPct}%` : '–'),
        el('td', { class: 'num' }, r.jitterMs != null ? `${r.jitterMs} ms` : '–'),
        el('td', { class: 'muted' }, r.ts ? fmtTimeShort(new Date(r.ts).getTime()) : '–'),
        el('td', {},
          tool ? el('button', { class: 'small', title: `Install ${tool} on the agent host`, onclick: (e) => onInstall(tool, r, e.target) }, `Install ${tool}`) : null,
          el('button', { class: 'small ghost', onclick: () => onDetail(r) }, r.type === 'traceroute' ? 'Path' : 'History')));
    })));
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
function pathGraph(graph) {
  const nodes = graph.nodes || [];
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
      loc ? el('div', {}, esc(loc)) : (n.private ? el('div', { class: 'muted' }, 'Private / RFC1918 — not geolocated') : null),
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
  nodes.forEach((n, i) => {
    const x = xOf(i);
    const top3 = n.kind === 'source' ? 'AGENT' : (n.kind === 'dest' ? `DEST · #${n.hop}` : `HOP #${n.hop}`);
    const meta = n.asn != null ? `AS${n.asn}${n.country ? ' · ' + n.country : ''}` : (n.rttMs != null ? `${n.rttMs} ms` : (n.unresponsive ? 'no reply' : ''));
    const g = mk('g', { class: `pg-node ${n.severity} ${n.kind}`, tabindex: '0', role: 'button', 'aria-label': `${top3} ${n.ip || ''} ${n.explain}` },
      mk('rect', { x, y: top, width: NW, height: NH, rx: 10 }),
      mk('text', { x: x + 11, y: top + 19, class: 'pg-hop' }, top3),
      mk('text', { x: x + 11, y: top + 38, class: 'pg-ip' }, (n.ip || (n.unresponsive ? '* * *' : '—')).slice(0, 17)),
      mk('text', { x: x + 11, y: top + 56, class: 'pg-meta' }, meta));
    g.addEventListener('mouseenter', () => showNode(n));
    g.addEventListener('focus', () => showNode(n));
    svg.append(g);
  });
  showNode(nodes[nodes.length - 1]); // default to the destination

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
      n.asnName ? el('div', {}, esc(n.asnName)) : null,
      n.country ? el('div', { class: 'muted' }, esc(n.country)) : null,
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
  const hopWrap = el('div', { class: 'pg-scroll' }, svg);
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

// Detail node for one probe result: traceroute path map (fetches + aggregates the
// recent traceroutes into a hop graph) or RTT history (the per-agent time series).
async function probeDetail(r, agentId) {
  if (r.type === 'traceroute') {
    let graph = null;
    try { graph = await api(`/api/probes/path?agentId=${encodeURIComponent(agentId)}&target=${encodeURIComponent(r.target)}`); } catch { /* fall back to the table */ }
    const hops = r.hops || [];
    const hopRow = (h) => el('tr', {},
      el('td', { class: 'muted' }, `#${h.hop}`),
      el('td', { class: 'mono' }, h.ip || '* * *'),
      el('td', { class: 'num' }, h.rttMs != null ? `${h.rttMs} ms` : '–'),
      el('td', { class: 'num' }, h.lossPct != null ? `${h.lossPct}%` : '–'),
      el('td', { class: 'num' }, h.jitterMs != null ? `${h.jitterMs} ms` : '–'));
    return el('details', { class: 'sec', open: true }, el('summary', {}, `Path to ${esc(r.target)} `, el('span', { class: 'muted' }, '· loss · latency · jitter per hop')),
      (graph && (graph.nodes || []).length > 1) ? pathGraph(graph) : null,
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
  const chart = el('details', { class: 'sec', open: true }, el('summary', {}, `${histTitle} — ${r.type} → ${esc(r.target)} `, el('span', { class: 'muted' }, '· band = normal range (median±MAD)')),
    el('div', { class: 'overview-chart' }, pts.length ? historyChart([{ id: 'rtt', label: metricLabel, color: '#06b6d4', points: pts }], { fromMs, toMs, band, markers }) : el('div', { class: 'empty' }, 'No history yet — run a few measurements.')));
  if (!isPageload && !isTx) return chart;
  return el('div', {},
    el('details', { class: 'sec', open: true }, el('summary', {}, `${isTx ? 'Steps' : 'Page elements'} — ${esc(r.target)} `, el('span', { class: 'muted' }, isTx ? '· per-step status · size · time' : '· per-resource status · size · load time')), pageloadWaterfall(r)),
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

// Flow-derived dependency / topology map — who-talks-to-whom built from the
// ingested 5-tuple flows. Internal (RFC1918) hosts vs external peers (with ASN/
// country). Read-only: a summary + the heaviest dependencies and busiest hosts.
// Site filter scopes the graph to one location; window selector adjusts depth.
// Action buttons (Ping / Vis rute) let an operator run live diagnostics against
// any observed host directly from this view, using a selectable online agent.
views.topology = async () => {
  const root = el('div', { class: 'topology' });
  const headInfo = el('span', { class: 'muted' }, 'Service/host dependencies from observed flows');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Topology'), headInfo));

  const [agentList, locations] = await Promise.all([
    api('/agents').catch(() => []),
    api('/locations').catch(() => []),
  ]);
  const onlineAgents = agentList.filter((a) => a.status === 'online');

  // Site and time-window selectors — control what the graph covers.
  const locSel = el('select', { class: 'small' },
    el('option', { value: '' }, 'All sites'),
    ...locations.map((l) => el('option', { value: String(l.id) }, l.name)));
  const winSel = el('select', { class: 'small' },
    el('option', { value: '30' }, '30 min'),
    el('option', { value: '60' }, '60 min'),
    el('option', { value: '240' }, '4 hours'),
    el('option', { value: '1440' }, '24 hours'));
  winSel.value = '60';
  const refreshBtn = el('button', { class: 'small ghost' }, 'Refresh');

  // View-mode toggle: the who-talks-to-whom SVG diagram (default) or a map of the
  // public peers by country. Internal hosts are never geolocated, so the map only
  // covers the external subset — see drawTopoMap.
  let mode = 'diagram';
  const diagramBtn = el('button', { class: 'small', 'aria-pressed': 'true' }, 'Diagram');
  const mapBtn = el('button', { class: 'small ghost', 'aria-pressed': 'false' }, 'Map');
  const modeToggle = el('div', { class: 'topo-mode', role: 'group', 'aria-label': 'View mode' }, diagramBtn, mapBtn);

  root.append(el('div', { class: 'topo-action-bar' },
    el('label', { class: 'inline muted' }, 'Site ', locSel),
    el('label', { class: 'inline muted' }, ' Window ', winSel),
    refreshBtn,
    el('span', { class: 'spacer' }),
    modeToggle));

  // Agent selector — shown only when at least one agent is online so action
  // buttons have something to send probes from.
  const agentSel = el('select', { class: 'small' });
  if (onlineAgents.length) {
    onlineAgents.forEach((a) => agentSel.append(el('option', { value: String(a.id) }, a.display_name || a.hostname)));
    root.append(el('div', { class: 'topo-action-bar' },
      el('span', { class: 'muted' }, 'Run actions from agent:'), agentSel));
  }

  const summary = el('p', { class: 'muted' });
  root.append(summary);
  // The visual area holds either the diagram (graphHost) or the map (mapHost);
  // the tables below stay visible in both modes (full list). lastData is the most
  // recent /api/topology response so the toggle can redraw without refetching.
  const graphHost = el('div', {});
  const mapHost = el('div', { class: 'topo-maphost hidden' });
  root.append(el('div', {}, graphHost, mapHost));
  const tableHost = el('div', {});
  root.append(tableHost);
  let lastData = null;

  // byId index is rebuilt on each load; shared by label() and actionBtns().
  const byId = {};
  const label = (id) => {
    const n = byId[id];
    if (n && n.kind === 'external') return `${id}${n.asnName ? ` · ${n.asnName}` : ''}${n.country ? ` (${n.country})` : ''}`;
    return id;
  };
  const kindBadge = (kind) => el('span', { class: `badge ${kind === 'external' ? 'warn' : 'ok'}` }, kind || '?');

  // Send a probe and poll until a result newer than sentAt appears (or timeout).
  async function runProbeAndWait(type, host, maxAttempts, intervalMs) {
    const id = agentSel.value;
    if (!id) throw new Error('Select an agent.');
    const sentAt = Date.now();
    await api(`/agents/${id}/probe`, { method: 'POST', body: { type, host } });
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((res) => setTimeout(res, intervalMs));
      const d = await api(`/api/probes/latest?agentId=${encodeURIComponent(id)}`);
      const r = (d.results || []).find(
        (x) => x.type === type && x.target === host && new Date(x.ts).getTime() > sentAt - 500);
      if (r) return { r, agentId: id };
    }
    throw new Error('No result yet — check Probes & Tests.');
  }

  // Per-row action buttons: Ping shows a quick RTT/loss summary; Show route runs
  // traceroute and opens the full path-graph panel (same as Probes & Tests).
  function actionBtns(host) {
    const pingBtn = el('button', { class: 'small ghost', onclick: async () => {
      if (!agentSel.value) { toast('Select an agent.', true); return; }
      pingBtn.disabled = true;
      const card = $('#modal-card');
      const st = el('p', { class: 'muted' }, 'Sending ping…');
      card.replaceChildren(
        el('h3', {}, `Ping → ${esc(host)}`), st,
        el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
      $('#modal').classList.remove('hidden');
      try {
        const { r } = await runProbeAndWait('ping', host, 8, 2500);
        st.className = r.ok ? '' : 'error';
        st.textContent = r.ok
          ? `RTT: ${r.rttMs} ms · Tab: ${r.lossPct ?? 0}% · Jitter: ${r.jitterMs != null ? r.jitterMs + ' ms' : '–'}`
          : `Error: ${r.detail || 'no response'}`;
      } catch (e) {
        st.className = 'error'; st.textContent = errText(e);
      } finally { pingBtn.disabled = false; }
    }}, 'Ping');

    const routeBtn = el('button', { class: 'small ghost', onclick: async () => {
      if (!agentSel.value) { toast('Select an agent.', true); return; }
      routeBtn.disabled = true;
      const agentId = agentSel.value;
      const card = $('#modal-card');
      const st = el('p', { class: 'muted' }, 'Running traceroute (up to ~30 s)…');
      card.replaceChildren(
        el('h3', {}, `Route → ${esc(host)}`), st,
        el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
      $('#modal').classList.remove('hidden');
      $('#modal-card').classList.add('wide');
      try {
        const { r } = await runProbeAndWait('traceroute', host, 12, 3000);
        const detail = await probeDetail(r, agentId);
        st.replaceWith(detail);
      } catch (e) {
        st.className = 'error'; st.textContent = errText(e);
      } finally { routeBtn.disabled = false; }
    }}, 'Show route');

    return el('div', { class: 'row-actions' }, pingBtn, routeBtn);
  }

  // Map mode: plots the PUBLIC peers by country (circles sized by traffic) over
  // the shared EU/self-hosted tiles, your sites as anchor pins, and the observed
  // dependencies as routes. Internal (RFC1918) hosts are never geolocated, so the
  // map deliberately shows only the external subset; the diagram remains the tool
  // for the internal structure. Routes internal→external are drawn from a single
  // anchor site — the selected Site, or the only located site — because the graph
  // doesn't tie each internal IP to a site; when the fleet spans several sites we
  // show the peers without those lines and say so. External↔external edges (both
  // ends geolocated) are always drawn.
  const EXT_COLOR = '#f59e0b'; // external peer (matches the diagram's amber)
  const SITE_COLOR = '#38bdf8'; // internal site anchor

  async function drawTopoMap() {
    stopTopoMap();
    if (typeof L === 'undefined') {
      mapHost.replaceChildren(el('div', { class: 'empty' }, 'Map library (Leaflet) could not be loaded — the map is unavailable offline. Use the Diagram.'));
      return;
    }
    const nodes = (lastData && lastData.nodes) || [];
    const edges = (lastData && lastData.edges) || [];
    const byId = {}; nodes.forEach((n) => { byId[n.id] = n; });
    const located = locations.filter((l) => l.latitude != null && l.longitude != null);
    const extNodes = nodes.filter((n) => n.kind === 'external');
    const geoNodes = extNodes.filter((n) => n.lat != null && n.lng != null);

    // Aggregate the geolocated peers to their country centroid (many peer IPs
    // stack on one point otherwise): sum bytes, count peers, collect ASN names.
    const byCountry = new Map();
    for (const n of geoNodes) {
      const e = byCountry.get(n.country) || { country: n.country, lat: n.lat, lng: n.lng, bytes: 0, peers: 0, asns: new Set() };
      e.bytes += n.bytes || 0; e.peers += 1; if (n.asnName) e.asns.add(n.asnName);
      byCountry.set(n.country, e);
    }

    // Which site anchors the internal→external routes (see the note above).
    const selLoc = locSel.value ? located.find((l) => String(l.id) === locSel.value) : null;
    const anchor = selLoc || (located.length === 1 ? located[0] : null);

    if (!geoNodes.length && !located.length) {
      mapHost.replaceChildren(el('div', { class: 'empty' },
        extNodes.length
          ? 'No public peers could be placed on the map yet. Country-level placement needs the offline GeoIP/ASN database (Settings → Map).'
          : 'Nothing to map in this window — the graph is all internal hosts, which are never geolocated. Use the Diagram.'));
      return;
    }

    let cfg = {};
    try { cfg = await api('/api/map/config'); } catch { /* fall back to default tiles */ }
    // The user may have switched mode / left the view while awaiting.
    if (mode !== 'map' || !mapHost.isConnected) return;

    const canvas = el('div', { class: 'map' });
    // GeoIP-missing banner: peers exist but none could be placed by country.
    const banner = (extNodes.length && !geoNodes.length)
      ? el('div', { class: 'alert-banner sev-WARN' },
          el('span', { class: 'alert-ic' }, '⚠'),
          el('span', {}, el('strong', {}, 'GeoIP database not configured. '),
            'External peers can’t be placed by country until the offline GeoIP/ASN database is loaded. ',
            role === 'admin' ? settingsLink('map', 'Configure it in Settings → Map') : 'Ask an administrator to configure it in Settings → Map', '.'))
      : null;
    const noAnchor = geoNodes.length && !anchor;
    const legend = el('div', { class: 'legend geo-legend' },
      el('span', {}, el('span', { class: 'dot ring', style: `background:${SITE_COLOR}` }), ' site'),
      el('span', {}, el('span', { class: 'dot', style: `background:${EXT_COLOR}` }), ' external peer'),
      el('span', { class: 'muted' }, '· circle size = traffic · lines = observed routes · public peers placed at country level'));
    const note = el('p', { class: 'muted small' },
      `Internal (private) hosts are never geolocated — the map shows only the ${byCountry.size} external ${byCountry.size === 1 ? 'country' : 'countries'} (${geoNodes.length} peers). `,
      noAnchor ? 'Select a single Site above to draw its routes to those peers.' : (anchor ? `Routes are drawn from ${esc(anchor.name)}.` : ''));
    mapHost.replaceChildren(...[banner, canvas, legend, note].filter(Boolean));

    const center = anchor ? [anchor.latitude, anchor.longitude]
      : (geoNodes.length ? [geoNodes[0].lat, geoNodes[0].lng] : [located[0].latitude, located[0].longitude]);
    const map = createLeafletMap(canvas, cfg, { center, zoom: 3 });
    if (!map) return;
    topoMapState.map = map;
    const pts = [];

    // Routes: internal→external anchored to the site; external↔external between
    // the two country centroids. Aggregate by endpoints so repeated conversations
    // become one line weighted (log-scaled) by total bytes.
    const routes = new Map();
    const addRoute = (key, a, b, bytes) => {
      const r = routes.get(key) || { a, b, bytes: 0 };
      r.bytes += bytes || 0; routes.set(key, r);
    };
    for (const e of edges) {
      const a = byId[e.from]; const b = byId[e.to];
      if (!a || !b) continue;
      const aExt = a.kind === 'external' && a.lat != null;
      const bExt = b.kind === 'external' && b.lat != null;
      if (aExt && bExt) {
        if (a.country === b.country) continue; // same centroid — nothing to draw
        addRoute(`x:${[a.country, b.country].sort().join('>')}`, [a.lat, a.lng], [b.lat, b.lng], e.bytes);
      } else if (anchor && (aExt || bExt)) {
        const ext = aExt ? a : b;
        addRoute(`s:${ext.country}`, [anchor.latitude, anchor.longitude], [ext.lat, ext.lng], e.bytes);
      }
    }
    const maxRouteBytes = Math.max(1, ...[...routes.values()].map((r) => r.bytes));
    for (const r of routes.values()) {
      const w = 1 + (Math.log2(1 + r.bytes) / Math.log2(1 + maxRouteBytes)) * 4;
      L.polyline([r.a, r.b], { color: EXT_COLOR, weight: w, opacity: 0.5 }).addTo(map);
    }

    // Site anchor pins (the anchor is emphasised; others give geographic context).
    for (const l of located) {
      const isAnchor = anchor && String(l.id) === String(anchor.id);
      L.circleMarker([l.latitude, l.longitude], {
        radius: isAnchor ? 9 : 7, color: '#fff', weight: 2,
        fillColor: SITE_COLOR, fillOpacity: isAnchor ? 0.95 : 0.6,
      }).addTo(map).bindTooltip(`${esc(l.name)}${isAnchor ? ' · routes anchor' : ''}`);
      pts.push([l.latitude, l.longitude]);
    }

    // External peers by country.
    for (const c of byCountry.values()) {
      const asns = [...c.asns].slice(0, 4).join(', ');
      L.circleMarker([c.lat, c.lng], {
        radius: radiusForBytes(c.bytes), color: EXT_COLOR, fillColor: EXT_COLOR, fillOpacity: 0.5, weight: 1,
      }).addTo(map).bindTooltip(
        `${esc(c.country)} · ${c.peers} peer${c.peers === 1 ? '' : 's'} · ${fmtBytes(c.bytes)}${asns ? ` · ${esc(asns)}` : ''}`);
      pts.push([c.lat, c.lng]);
    }

    if (pts.length > 1) { try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 7 }); } catch { /* single point */ } }
    setTimeout(() => { try { map.invalidateSize(); } catch { /* ignore */ } }, 60);
  }

  // Show the active mode's host, keep the other hidden, and (re)draw the map.
  function applyMode() {
    const isMap = mode === 'map';
    graphHost.classList.toggle('hidden', isMap);
    mapHost.classList.toggle('hidden', !isMap);
    diagramBtn.classList.toggle('ghost', isMap);
    mapBtn.classList.toggle('ghost', !isMap);
    diagramBtn.setAttribute('aria-pressed', String(!isMap));
    mapBtn.setAttribute('aria-pressed', String(isMap));
    if (isMap) drawTopoMap();
    else stopTopoMap();
  }
  diagramBtn.addEventListener('click', () => { if (mode !== 'diagram') { mode = 'diagram'; applyMode(); } });
  mapBtn.addEventListener('click', () => { if (mode !== 'map') { mode = 'map'; applyMode(); } });

  async function loadTopology() {
    const qp = new URLSearchParams({ minutes: winSel.value });
    const locId = locSel.value;
    if (locId) qp.set('locationId', locId);

    const locName = locId ? (locations.find((l) => String(l.id) === locId) || {}).name : null;
    const winLabel = winSel.options[winSel.selectedIndex].text;
    headInfo.textContent = `Service/host dependencies · ${winLabel}${locName ? ` · ${locName}` : ''}`;

    let data;
    try {
      data = await api(`/api/topology?${qp}`);
    } catch (e) {
      lastData = null;
      graphHost.replaceChildren();
      tableHost.replaceChildren(el('div', { class: 'error' }, errText(e)));
      summary.textContent = '';
      applyMode();
      return;
    }
    lastData = data;

    const t = data.totals || { nodes: 0, internal: 0, external: 0, edges: 0 };
    summary.textContent = `${t.nodes} hosts (${t.internal} internal, ${t.external} external) · ${t.edges} dependencies${data.truncated ? ' · showing the heaviest' : ''}`;

    if (!data.edges || !data.edges.length) {
      graphHost.replaceChildren();
      tableHost.replaceChildren(el('div', { class: 'empty' }, 'No flow data in this window. Topology is built from agents whose traffic source is NetFlow or sFlow.'));
      applyMode();
      return;
    }

    Object.keys(byId).forEach((k) => delete byId[k]);
    (data.nodes || []).forEach((n) => { byId[n.id] = n; });

    // Diagram: capped to the busiest hosts for legibility — the tables below
    // carry the full (still-capped-by-the-API) list. Both draw from the same
    // response, so the diagram and the tables always agree.
    const GRAPH_MAX_NODES = 40;
    const graphNodes = (data.nodes || []).slice(0, GRAPH_MAX_NODES);
    const graphIds = new Set(graphNodes.map((n) => n.id));
    const graphEdges = (data.edges || []).filter((e) => graphIds.has(e.from) && graphIds.has(e.to)).slice(0, 90);
    const graphNote = graphNodes.length < (data.nodes || []).length
      ? el('p', { class: 'muted small' }, `Diagram shows the ${graphNodes.length} busiest of ${data.nodes.length} hosts — see the tables below for the full list.`)
      : null;
    graphHost.replaceChildren(
      ...[el('h3', {}, 'Diagram'),
        topoGraphSvg(graphNodes, graphEdges, { label, kindBadge, actionBtns: onlineAgents.length ? actionBtns : null }),
        graphNote].filter(Boolean));

    tableHost.replaceChildren(
      el('h3', {}, 'Top dependencies'),
      el('table', { class: 'agents-table' },
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, 'From'), el('th', { scope: 'col' }, 'To'),
          el('th', { scope: 'col' }, 'Peer'), el('th', { scope: 'col' }, 'Bytes'), el('th', { scope: 'col' }, 'Flows'),
          onlineAgents.length ? el('th', { scope: 'col' }, 'Actions') : null)),
        el('tbody', {}, ...data.edges.slice(0, 100).map((e) => el('tr', {},
          el('td', {}, label(e.from)),
          el('td', {}, label(e.to)),
          el('td', {}, kindBadge(byId[e.to] && byId[e.to].kind)),
          el('td', {}, fmtBytes(e.bytes)),
          el('td', {}, String(e.flows)),
          onlineAgents.length ? el('td', {}, actionBtns(e.to)) : null)))),
      el('h3', {}, 'Busiest hosts'),
      el('table', { class: 'agents-table' },
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, 'Host'), el('th', { scope: 'col' }, 'Kind'),
          el('th', { scope: 'col' }, 'Peers'), el('th', { scope: 'col' }, 'In'), el('th', { scope: 'col' }, 'Out'),
          onlineAgents.length ? el('th', { scope: 'col' }, 'Actions') : null)),
        el('tbody', {}, ...(data.nodes || []).slice(0, 50).map((n) => el('tr', {},
          el('td', {}, label(n.id)),
          el('td', {}, kindBadge(n.kind)),
          el('td', {}, String(n.degree)),
          el('td', {}, fmtBytes(n.bytesIn)),
          el('td', {}, fmtBytes(n.bytesOut)),
          onlineAgents.length ? el('td', {}, actionBtns(n.id)) : null)))));

    applyMode();
  }

  locSel.addEventListener('change', loadTopology);
  winSel.addEventListener('change', loadTopology);
  refreshBtn.addEventListener('click', loadTopology);
  await loadTopology();
  return root;
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
        ` Draft created (${esc(d.incidentId || '?')}) — review before submission`),
      el('div', { class: 'inv-nis2-draft-body' },
        el('p', { class: 'muted inv-nis2-notice' },
          'AI-generated draft · Requires human review · Never auto-submitted'),
        el('dl', { class: 'inv-nis2-dl' },
          el('dt', {}, 'Title'), el('dd', {}, esc(d.title || '–')),
          el('dt', {}, 'Severity'), el('dd', {},
            el('span', { class: `badge inv-badge ${sevCls}` }, d.severity || '–')),
          el('dt', {}, 'Detected'), el('dd', {}, d.detectedAt ? fmtDate(new Date(d.detectedAt).getTime()) : '–'),
          el('dt', {}, 'Affected systems'), el('dd', {}, esc(d.affectedSystems || '–')),
          el('dt', {}, 'Description'), el('dd', {}, esc(d.businessImpact || '–'))),
        el('p', { class: 'muted' },
          'Edit the draft under ',
          el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); switchView('reporting'); } },
            'Reporting → NIS2 Incidents'), '.')));
  } else if (inv.nis2DraftError) {
    nis2El = el('div', { class: 'inv-nis2-error muted' },
      `NIS2 draft could not be created: ${esc(inv.nis2DraftError)}`);
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

views.investigation = async () => {
  const root = el('div', { class: 'investigation' });

  const agents = await api('/agents').catch(() => []);
  const locations = await api('/locations').catch(() => []);

  // --- Input section ---
  const typeSelect = el('select', { id: 'inv-type' },
    el('option', { value: 'agent' }, 'Agent'),
    el('option', { value: 'interface' }, 'Interface'),
    el('option', { value: 'subnet' }, 'Subnet'),
    el('option', { value: 'site' }, 'Site/location'));

  // Dynamic value input: dropdown for agent/site, free text for subnet/interface.
  const agentOptions = [el('option', { value: '' }, '— select agent —'),
    ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname))];
  const siteOptions = [el('option', { value: '' }, '— select site —'),
    ...locations.map((l) => el('option', { value: String(l.id) }, l.name))];

  const valueSelect = el('select', { id: 'inv-value-select' }, ...agentOptions);
  const valueText = el('input', { id: 'inv-value-text', type: 'text', placeholder: 'e.g. 10.0.1.0/24 or eth0', class: 'hidden' });

  typeSelect.addEventListener('change', () => {
    const t = typeSelect.value;
    if (t === 'agent') {
      valueSelect.replaceChildren(...agentOptions.map((o) => o.cloneNode(true)));
      valueSelect.classList.remove('hidden');
      valueText.classList.add('hidden');
    } else if (t === 'site') {
      valueSelect.replaceChildren(...siteOptions.map((o) => o.cloneNode(true)));
      valueSelect.classList.remove('hidden');
      valueText.classList.add('hidden');
    } else {
      valueSelect.classList.add('hidden');
      valueText.classList.remove('hidden');
    }
  });

  const windowSelect = el('select', { id: 'inv-window' },
    el('option', { value: '15' }, '15 min'),
    el('option', { value: '30', selected: 'selected' }, '30 min'),
    el('option', { value: '60' }, '60 min'));

  const runBtn = el('button', { class: 'primary', id: 'inv-run-btn' }, 'Investigate');
  const statusEl = el('p', { class: 'muted', id: 'inv-status' }, '');

  root.append(
    el('div', { class: 'section-head' },
      el('h2', {}, 'Troubleshooting'),
      el('span', { class: 'muted' }, 'Location-driven anomaly investigation')),
    el('div', { class: 'inv-form' },
      el('div', { class: 'inv-form-row' },
        el('label', {}, 'Location type ', typeSelect),
        el('label', {}, 'Value ', valueSelect, valueText),
        el('label', {}, 'Time window ', windowSelect),
        runBtn),
      statusEl));

  const resultArea = el('div', { id: 'inv-result-area' });
  root.append(resultArea);

  const historyArea = el('div', { id: 'inv-history-area' });
  root.append(historyArea);

  // Load history of previous investigations.
  async function loadHistory() {
    let list;
    try {
      list = await api('/api/investigation');
    } catch {
      return;
    }
    if (!Array.isArray(list) || list.length === 0) {
      historyArea.replaceChildren(el('div', { class: 'empty' }, 'No previous investigations.'));
      return;
    }
    historyArea.replaceChildren(
      el('h3', {}, 'Previous investigations'),
      ...list.map(investigationCard));
  }

  loadHistory();

  runBtn.addEventListener('click', async () => {
    const t = typeSelect.value;
    const rawValue = t === 'agent' || t === 'site'
      ? valueSelect.value
      : valueText.value.trim();

    if (!rawValue) {
      statusEl.textContent = 'Select or enter a location value.';
      return;
    }

    runBtn.disabled = true;
    statusEl.textContent = 'Investigating…';
    resultArea.replaceChildren();

    try {
      const inv = await api('/api/investigation/run', {
        method: 'POST',
        body: {
          locationRef: { type: t, value: rawValue },
          windowMinutes: Number(windowSelect.value),
        },
      });
      resultArea.replaceChildren(investigationCard(inv));
      statusEl.textContent = '';
      loadHistory();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      runBtn.disabled = false;
    }
  });

  return root;
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
let probesTab = 'run'; // 'run' | 'packages'
views.probes = async () => {
  const root = el('div');
  const tab = (key, label) => el('button', { class: `small ghost${probesTab === key ? ' active' : ''}`,
    onclick: () => { if (probesTab === key) return; if (key !== 'run') stopProbes(); probesTab = key; render(); } }, label);
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Probes & Tests'),
    el('div', { class: 'subtabs' }, tab('run', 'Run a probe'), tab('packages', 'Test packages'))));
  root.append(await (probesTab === 'packages' ? testPackagesView() : probeRunnerView()));
  return root;
};

async function probeRunnerView() {
  const root = el('div', { class: 'probes' });
  root.append(el('div', { class: 'muted', style: 'margin:2px 0 10px' }, 'Run one check now from a single agent · ping · TCP · DNS · traceroute · cURL · page load · transaction'));

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'No agents yet — enrol an agent first.')); return root; }

  const agentSel = el('select', {}, ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  const typeSel = el('select', {}, ...[['ping', 'Ping (ICMP)'], ['tcp', 'TCP-connect'], ['dns', 'DNS'], ['traceroute', 'Traceroute'], ['curl', 'cURL (content check)'], ['pageload', 'Page load'], ['transaction', 'Transaction (multi-step)']].map(([v, l]) => el('option', { value: v }, l)));
  const target = el('input', { type: 'text', placeholder: 'e.g. 1.1.1.1 or example.com' });
  const targetWrap = el('label', { class: 'inline muted' }, 'Target ', target);
  const portInput = el('input', { type: 'number', min: '1', max: '65535', value: '443' });
  const portWrap = el('label', { class: 'inline muted' }, 'Port ', portInput);
  const countInput = el('input', { type: 'number', min: '1', max: '20', value: '4' });
  const countLabelText = el('span', {}, 'Count ');
  const countWrap = el('label', { class: 'inline muted' }, countLabelText, countInput);
  // cURL content-verification inputs — only shown for the curl type. They let the
  // operator assert that the received traffic is correct, not just reachable.
  const curl = curlInputs();
  const tx = transactionStepsEditor([]);
  const txWrap = el('div', { class: 'tx-wrap' }, el('div', { class: 'muted small' }, 'Steps run in order; a step can extract a value (regex) for later steps as {{name}}. Stops at the first failure.'), tx.node);
  const runBtn = el('button', { class: 'small' }, 'Run probe');
  const status = el('div', { class: 'muted' });
  // For traceroute the count is the per-hop probe count ("queries") that MTR-style
  // sampling uses to derive per-hop loss/jitter (server caps it at 10).
  const syncPort = () => {
    const tr = typeSel.value === 'traceroute';
    const isCurl = typeSel.value === 'curl';
    const isTx = typeSel.value === 'transaction';
    const isUrl = isCurl || typeSel.value === 'pageload';
    targetWrap.style.display = isTx ? 'none' : '';
    portWrap.style.display = typeSel.value === 'tcp' ? '' : 'none';
    curl.wrap.style.display = isCurl ? '' : 'none';
    txWrap.style.display = isTx ? '' : 'none';
    countWrap.style.display = (typeSel.value === 'pageload' || isTx) ? 'none' : '';
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
    runBtn, status), txWrap);

  const latestHost = el('div', { class: 'probe-latest' });
  const detailHost = el('div', {});
  root.append(el('details', { class: 'sec', open: true }, el('summary', {}, 'Latest results ', el('span', { class: 'muted' }, '· most recent per target')), latestHost));
  root.append(detailHost);

  async function run() {
    const id = agentSel.value;
    let body;
    if (typeSel.value === 'transaction') {
      const steps = tx.collect();
      if (!steps.length) { status.className = 'error'; status.textContent = 'Add at least one step with a URL.'; return; }
      body = { type: 'transaction', steps };
    } else {
      const host = target.value.trim();
      if (!host) { status.className = 'error'; status.textContent = 'Enter a target.'; return; }
      body = { type: typeSel.value, host };
      if (typeSel.value === 'tcp') body.port = Number(portInput.value);
      if (typeSel.value === 'curl') curl.apply(body);
      if (typeSel.value === 'traceroute' && countInput.value) body.queries = Number(countInput.value);
      else if ((typeSel.value === 'ping' || typeSel.value === 'tcp') && countInput.value) body.count = Number(countInput.value);
    }
    status.className = 'muted'; status.textContent = 'Sending…'; runBtn.disabled = true;
    try {
      await api(`/agents/${id}/probe`, { method: 'POST', body });
      status.textContent = 'Sent — the agent is running it now; results will arrive in a moment.';
      setTimeout(refreshLatest, 2500); setTimeout(refreshLatest, 6000);
    } catch (e) {
      status.className = 'error';
      status.textContent = e.status === 409 ? 'The agent is not connected right now.' : errText(e);
    } finally { runBtn.disabled = false; }
  }
  runBtn.addEventListener('click', run);

  async function refreshLatest() {
    const id = agentSel.value;
    let data;
    try { data = await api(`/api/probes/latest?agentId=${encodeURIComponent(id)}`); } catch { return; }
    const rows = data.results || [];
    latestHost.replaceChildren(probeLatestTable(rows, showDetail, (tool, r, btn) => requestToolInstall(agentSel.value, tool, btn)));
  }

  async function showDetail(r) {
    detailHost.replaceChildren(await probeDetail(r, agentSel.value));
  }

  refreshLatest();
  stopProbes();
  // Guard against the async TOCTOU: if a tab switch happened during the awaits
  // above, render() already cleared the timer — self-clear instead of leaking.
  probeState.timer = setInterval(() => {
    if (currentView !== 'probes') { stopProbes(); return; }
    if (!modalOpen()) refreshLatest();
  }, 5000);
  return root;
};

// ---- Fleet overview + combined agent page ---------------------------------

let selectedAgentId = null;
function openAgent(id) { selectedAgentId = id; currentView = 'agent'; render(); }

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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BlueEye investigation — ${e2(b.agent.displayName)}</title>
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
    el('h3', {}, `Export investigation — ${esc(name)}`),
    el('p', { class: 'muted' }, 'A snapshot of the last 24 hours: health, data quality, interfaces, latest probes, findings and top talkers.'),
    el('div', { class: 'form-actions' },
      el('button', { onclick: () => downloadAuthed(`/api/export/investigation?agentId=${encodeURIComponent(id)}&format=json`, `investigation-${id}.json`) }, 'JSON'),
      el('button', { class: 'ghost', onclick: () => downloadAuthed(`/api/export/investigation?agentId=${encodeURIComponent(id)}&format=csv`, `investigation-${id}.csv`) }, 'CSV'),
      el('button', { class: 'ghost', onclick: () => { closeModal(); printInvestigation(id); } }, 'Print / PDF'),
      el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
  $('#modal').classList.remove('hidden');
}

// Global search (topbar): agents/hosts/locations + which agents recently saw an
// IP/port. Results open in a modal; each is a shortcut into the agent/flow views.
async function globalSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  const card = $('#modal-card');
  card.replaceChildren(el('h3', {}, `Search: ${esc(q)}`), el('div', { class: 'muted' }, 'Searching…'));
  $('#modal').classList.remove('hidden');
  let data;
  try { data = await api(`/api/search?q=${encodeURIComponent(q)}`); }
  catch (e) { card.replaceChildren(el('h3', {}, 'Search'), el('p', { class: 'error' }, e.message), el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close'))); return; }
  const item = (label, sub, onclick) => el('button', { class: 'search-item', onclick }, el('span', {}, label), sub || null);
  const kids = [el('h3', {}, `Search: ${esc(q)}`)];
  let any = false;
  if (data.agents.length) {
    any = true;
    kids.push(el('h4', {}, 'Agents'));
    kids.push(el('div', { class: 'search-list' }, ...data.agents.map((a) => item(
      esc(a.name), el('span', { class: `badge ${a.status === 'online' ? 'online' : 'offline'}` }, a.status || '?'),
      () => { closeModal(); openAgent(a.id); }))));
  }
  if (data.flows && data.flows.ip && data.flows.ip.agents.length) {
    any = true;
    kids.push(el('h4', {}, `IP ${esc(data.flows.ip.ip)} `, el('span', { class: 'muted' }, '· set af')));
    kids.push(el('div', { class: 'search-list' }, ...data.flows.ip.agents.map((a) => item(
      esc(a.name), el('span', { class: 'muted' }, '→ flows'), () => { closeModal(); openFlows(a.id, { peer: data.flows.ip.ip }); }))));
  }
  if (data.flows && data.flows.port && data.flows.port.agents.length) {
    any = true;
    kids.push(el('h4', {}, `Port ${data.flows.port.port} `, el('span', { class: 'muted' }, '· set af')));
    kids.push(el('div', { class: 'search-list' }, ...data.flows.port.agents.map((a) => item(
      esc(a.name), el('span', { class: 'muted' }, '→ flows'), () => { closeModal(); openFlows(a.id, { port: data.flows.port.port }); }))));
  }
  if (data.locations.length) {
    any = true;
    kids.push(el('h4', {}, 'Locations'));
    kids.push(el('div', { class: 'search-list' }, ...data.locations.map((l) => item(esc(l.name), null, () => { closeModal(); currentView = 'map'; render(); }))));
  }
  if (!any) kids.push(el('div', { class: 'empty' }, 'No results.'));
  kids.push(el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Close')));
  card.replaceChildren(...kids);
}

const fleetState = { timer: null };
function stopFleet() { if (fleetState.timer) { clearInterval(fleetState.timer); fleetState.timer = null; } }
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
function kpiCard(label, value, sub, status) {
  const vCls = status === 'warn' ? ' v-warn' : status === 'bad' ? ' v-bad' : status === 'ok' ? ' v-ok' : '';
  return el('div', { class: `kpi st-${status}` },
    el('div', { class: 'kpi-k' }, label),
    el('div', { class: `kpi-v${vCls}` }, value),
    el('div', { class: 'kpi-sub muted' }, sub));
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
  const NW = 120, NH = 58, top = 28, cy = top + NH / 2;
  const X = { HQ: 20, ISP: 220, CL: 420, SA: 620 };
  const node = (x, title, sub, lvl, edge, tip) => mk('g', { class: `np-node${edge ? ' edge' : ''}${lvl && lvl !== 'ok' ? ` ${lvl}` : ''}` },
    tip ? mk('title', {}, tip) : null,
    mk('rect', { x, y: top, width: NW, height: NH, rx: 10 }),
    mk('circle', { cx: x + 16, cy: top + 18, r: 4, class: 'np-ico' }),
    mk('text', { x: x + 30, y: top + 23, class: 'np-t' }, title),
    mk('text', { x: x + 12, y: top + 42, class: 'np-s' }, sub));
  const link = (x1, y1, x2, y2, lvl, label, tip) => {
    const g = mk('g', {},
      tip ? mk('title', {}, tip) : null,
      mk('line', { x1, y1, x2, y2, class: cls('np-link', lvl), 'stroke-linecap': 'round' }),
      mk('line', { x1, y1, x2, y2, class: cls('np-flow', lvl), 'stroke-linecap': 'round' }));
    if (label) g.append(mk('text', { x: (x1 + x2) / 2, y: Math.min(y1, y2) - 7, 'text-anchor': 'middle', class: cls('np-lab', lvl) }, label));
    return g;
  };
  const Bx = 320, By = 150, BNH = 50;
  const overall = worst(originLvl, accessLvl, wanLvl, saasLvl, scoped ? 'ok' : branchLvl);
  const statusTxt = overall === 'bad' ? 'Critical segment' : overall === 'warn' ? 'Degraded segment detected' : 'All segments nominal';
  const ariaLabel = `Network path for ${scoped ? scopeName : 'the whole fleet'} — origin, ISP, cloud, SaaS — ${statusTxt.toLowerCase()}`;
  const branchTip = `Other sites — ${(s.down || 0) + (s.stale || 0)} agent(s) down or stale`;
  const svg = mk('svg', { viewBox: '0 0 820 214', role: 'img', 'aria-label': ariaLabel },
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
      mk('rect', { x: Bx, y: By, width: NW, height: BNH, rx: 10 }),
      mk('circle', { cx: Bx + 16, cy: By + 16, r: 4, class: 'np-ico' }),
      mk('text', { x: Bx + 30, y: By + 21, class: 'np-t' }, 'Branch'),
      mk('text', { x: Bx + 12, y: By + 38, class: 'np-s' }, 'Remote sites')));
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
// the active incidents and the most-recent unacknowledged analysis findings,
// side by side. Composed from data the server already holds (no new collection)
// and rendered with the compact .panel-grid / .adv-table styling. Rows that map
// to an agent drill into its combined page.
function fleetIssues(w) {
  if (!w) return el('div', {});
  const count = (n) => el('span', { class: 'muted fi-count' }, n ? ` · ${n}` : '');

  const inc = el('div', { class: 'card' }, el('h3', {}, 'Active incidents', count(w.incidents.active)));
  if (!w.incidents.recent.length) inc.append(el('p', { class: 'muted' }, 'No active incidents.'));
  else inc.append(el('table', { class: 'adv-table' }, el('tbody', {}, ...w.incidents.recent.map((i) =>
    el('tr', i.agentId ? { class: 'clickable', onclick: () => openAgent(i.agentId) } : {},
      el('td', {}, el('span', { class: `badge ${i.severity === 'critical' ? 'crit' : 'warn'}` }, i.severity)),
      el('td', {}, esc(i.agentName || `agent ${i.agentId}`), i.locationName ? el('span', { class: 'muted' }, ` · ${esc(i.locationName)}`) : null),
      el('td', {}, esc(i.metric)),
      el('td', { class: 'muted' }, fmtDate(i.startedAt)))))));

  const fnd = el('div', { class: 'card' }, el('h3', {}, 'Recent findings', count(w.findings.open)));
  if (!w.findings.recent.length) fnd.append(el('p', { class: 'muted' }, 'No open analysis findings.'));
  else fnd.append(el('table', { class: 'adv-table' }, el('tbody', {}, ...w.findings.recent.map((x) =>
    el('tr', {},
      el('td', {}, el('span', { class: `badge ${x.severity === 'CRIT' ? 'crit' : x.severity === 'WARN' ? 'warn' : 'grace'}` }, x.severity)),
      el('td', {}, esc(x.hostId), el('span', { class: 'muted' }, ` · ${esc(x.metric)}`)),
      el('td', { class: 'muted' }, esc(x.explanation || x.kind || '')))))));

  // First-class incidents (incident_cases) — open/investigating cases; click a
  // row to open its detail page. Guarded for older servers without the widget.
  const ic = w.incidentCases || { open: 0, recent: [] };
  const cases = el('div', { class: 'card' }, el('h3', {}, 'Open incidents', count(ic.open)));
  if (!ic.recent.length) cases.append(el('p', { class: 'muted' }, 'No open incidents.'));
  else cases.append(el('table', { class: 'adv-table' }, el('tbody', {}, ...ic.recent.map((c) =>
    el('tr', { class: 'clickable', onclick: () => openIncident(c.id) },
      el('td', {}, el('span', { class: `badge inc-sev-${c.severity}` }, c.severity)),
      el('td', {}, esc(c.title)),
      el('td', {}, el('span', { class: `badge inc-status-${c.status}` }, INC_STATUS_LABEL[c.status] || c.status)),
      el('td', { class: 'muted' }, fmtDate(c.lastEventAt)))))));

  return el('section', { class: 'fleet-issues' },
    el('h3', { class: 'fi-head' }, 'Open issues',
      el('span', { class: 'muted' }, ' · open incidents, probe outages & recent analysis findings')),
    el('div', { class: 'panel-grid' }, cases, inc, fnd));
}

// The landing view: all agents with a probe-derived health verdict, worst-first.
// Click a row to pivot into that agent's combined detail page. For Professional+
// licences it also surfaces an "Open issues" rollup (incidents + findings).
views.fleet = async () => {
  const root = el('div', { class: 'fleet' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Overview'),
    el('span', { class: 'muted' }, 'All agents · health from reachability · loss · latency · jitter')));
  const bannerHost = el('div', {});
  const nocHost = el('div', {});
  const summaryHost = el('div', { class: 'fleet-summary' });
  const tableHost = el('div', {});
  const issuesHost = el('div', {}); // gated (dashboard_advanced): incidents + findings
  root.append(bannerHost, nocHost, summaryHost, tableHost, issuesHost);

  // Maintenance banner (viewer-readable) — shown while a window is active now.
  api('/api/settings/maintenance').then((m) => {
    const now = Date.now();
    const active = (m.windows || []).filter((w) => Date.parse(w.from) <= now && now <= Date.parse(w.to));
    if (active.length) bannerHost.replaceChildren(el('div', { class: 'mw-banner' }, '🛠 Maintenance active: ', esc(active.map((w) => w.name).join(', ')), el('span', { class: 'muted' }, ' — alert notifications suppressed')));
    else bannerHost.replaceChildren();
  }).catch(() => {});

  // Click a summary chip ("3 Healthy", "1 Critical", …) to filter the table to
  // just those agents; click it again — or "Show all" — to clear. null = no
  // filter. Kept in the closure so it survives the 10 s poll; the latest fetch
  // is cached so a toggle re-renders instantly without refetching.
  let activeFilter = null;
  let lastData = null;
  // Independent of the chip filter above: the NOC header (KPI cards + live
  // network path) can be narrowed to a single location. null = whole fleet.
  let locationScope = null;
  // Chip ⇒ which health verdicts it covers. "Critical" folds in 'down' to match
  // its count (bad + down); the rest map one-to-one.
  const FILTER_MATCH = {
    ok: (s) => s === 'ok', warn: (s) => s === 'warn',
    bad: (s) => s === 'bad' || s === 'down',
    stale: (s) => s === 'stale', unknown: (s) => s === 'unknown',
  };
  const FILTER_LABEL = { ok: 'healthy', warn: 'warning', bad: 'critical', stale: 'stale', unknown: 'unknown' };
  function setFilter(cls) {
    activeFilter = activeFilter === cls ? null : cls;
    if (lastData) { renderSummary(lastData.summary); renderTable(lastData.agents); }
  }

  // Distinct locations present in the latest poll (only sites that actually have
  // an agent are offered as scope options), name-sorted.
  function nocLocations(agents) {
    const seen = new Map();
    for (const a of agents || []) {
      if (a.locationId != null && !seen.has(a.locationId)) seen.set(a.locationId, a.locationName || `#${a.locationId}`);
    }
    return [...seen].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name));
  }
  // Narrow the fleet rollup to one location, recomputing the status summary so
  // the KPI cards + the network path reflect just that site. null ⇒ whole fleet.
  function scopeData(data, locId) {
    if (locId == null) return data;
    const agents = (data.agents || []).filter((a) => a.locationId === locId);
    const summary = { ok: 0, warn: 0, bad: 0, down: 0, stale: 0, unknown: 0, total: agents.length };
    for (const a of agents) summary[a.health.status] = (summary[a.health.status] || 0) + 1;
    return { ...data, agents, summary };
  }
  // (Re)render the NOC header for the current scope. The <select> is rebuilt on
  // every poll with the active scope preselected, so the choice survives the
  // 10 s refresh; picking a location just re-runs this (no refetch).
  function renderNoc() {
    if (!lastData) return;
    const locs = nocLocations(lastData.agents);
    // Forget a scope whose location dropped out of the latest poll.
    if (locationScope != null && !locs.some((l) => l.id === locationScope)) locationScope = null;
    const scopeName = locationScope != null ? (locs.find((l) => l.id === locationScope) || {}).name : null;
    const controls = locs.length
      ? el('label', { class: 'inline muted' }, 'Location ',
        el('select', { onchange: (e) => { locationScope = e.target.value ? Number(e.target.value) : null; renderNoc(); } },
          el('option', { value: '' }, 'All locations'),
          ...locs.map((l) => el('option', { value: String(l.id), selected: l.id === locationScope ? '' : null }, l.name))))
      : null;
    nocHost.replaceChildren(nocDashboard(scopeData(lastData, locationScope), { controls, scopeName }));
  }

  function renderSummary(s) {
    const chip = (cls, label, n) => {
      const on = activeFilter === cls;
      return el('div', {
        class: `fs-chip ${cls}${n ? '' : ' zero'}${on ? ' active' : ''}`,
        role: 'button', tabindex: '0', 'aria-pressed': on ? 'true' : 'false',
        title: on ? 'Show all agents' : `Show only ${label.toLowerCase()} agents`,
        onclick: () => setFilter(cls),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFilter(cls); } },
      }, el('span', { class: 'fs-n' }, String(n)), el('span', { class: 'fs-l' }, label));
    };
    summaryHost.replaceChildren(
      chip('ok', 'Healthy', s.ok),
      chip('warn', 'Warnings', s.warn),
      chip('bad', 'Critical', s.bad + s.down),
      chip('stale', 'Stale', s.stale),
      chip('unknown', 'Unknown', s.unknown));
  }
  function fleetRow(a) {
    const m = a.health.metrics;
    const dq = a.quality && a.quality.status && a.quality.status !== 'ok' && a.quality.status !== 'unknown'
      ? el('span', { class: 'dq-flag', title: `Data quality: ${a.quality.reason || a.quality.status}` }, ' ⚠')
      : null;
    return el('tr', { class: 'fleet-row', tabindex: '0', onclick: () => openAgent(a.agentId), onkeydown: (e) => { if (e.key === 'Enter') openAgent(a.agentId); } },
      el('td', {}, el('div', {}, esc(a.displayName), dq), a.displayName !== a.hostname ? el('div', { class: 'muted' }, esc(a.hostname)) : null),
      el('td', {}, el('span', { class: `badge ${a.online ? 'online' : 'offline'}` }, a.online ? 'online' : 'offline')),
      el('td', {}, healthBadge(a.health)),
      el('td', { class: 'num' }, m.lossPct != null ? `${m.lossPct}%` : '–'),
      el('td', { class: 'num' }, latencyText(m)),
      el('td', { class: 'num' }, m.jitterMs != null ? `${m.jitterMs} ms` : '–'),
      el('td', { class: 'num muted' }, m.targets ? `${m.reachable}/${m.targets}` : '–'),
      el('td', { class: 'num' }, throughputText(a.throughput)),
      el('td', { class: 'muted' }, a.locationName || '–'),
      el('td', { class: 'muted' }, m.lastTs ? fmtTimeShort(new Date(m.lastTs).getTime()) : '–'));
  }
  function renderTable(agents) {
    if (!agents.length) { tableHost.replaceChildren(el('div', { class: 'empty' }, 'No agents yet — go to Agents to enrol one.')); return; }
    const shown = activeFilter ? agents.filter((a) => FILTER_MATCH[activeFilter](a.health.status)) : agents;
    const bar = activeFilter
      ? el('div', { class: 'fleet-filter' },
        el('span', { class: 'muted' }, `Showing ${shown.length} of ${agents.length} — ${FILTER_LABEL[activeFilter]}`),
        el('button', { class: 'small ghost', onclick: () => setFilter(activeFilter) }, 'Show all'))
      : null;
    const body = shown.length
      ? el('table', { class: 'fleet-table' },
        el('thead', {}, el('tr', {}, ...['Agent', 'Status', 'Health', 'Loss', 'Latency', 'Jitter', 'Targets', 'Speed', 'Location', 'Last seen'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...shown.map(fleetRow)))
      : el('div', { class: 'empty' }, `No ${FILTER_LABEL[activeFilter]} agents.`);
    tableHost.replaceChildren(...(bar ? [bar, body] : [body]));
  }
  // Open issues (incidents + findings) — a Professional+ rollup (feature
  // dashboard_advanced). Best-effort + gated: when the licence doesn't include
  // it the panels are simply omitted, so the core Overview always renders.
  async function refreshIssues() {
    if (!featureEntitled('dashboard_advanced')) { issuesHost.replaceChildren(); return; }
    try { issuesHost.replaceChildren(fleetIssues((await api('/api/dashboard/advanced')).widgets)); }
    catch { issuesHost.replaceChildren(); }
  }
  async function refresh() {
    refreshIssues(); // gated incidents/findings panels, fetched in parallel
    let data;
    try { data = await api('/api/fleet/health'); } catch (e) { tableHost.replaceChildren(el('div', { class: 'error' }, e.message)); return; }
    lastData = data;
    renderNoc();
    renderSummary(data.summary);
    renderTable(data.agents);
  }

  await refresh();
  stopFleet();
  fleetState.timer = setInterval(() => {
    if (currentView !== 'fleet') { stopFleet(); return; }
    if (!modalOpen()) refresh();
  }, 10000);
  return root;
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

views.agent = async () => {
  const id = selectedAgentId;
  const root = el('div', { class: 'agent-detail' });
  if (id == null) { root.append(el('div', { class: 'empty' }, 'Select an agent in the overview.')); return root; }
  let agent;
  try { agent = await api(`/agents/${id}`); } catch (e) { root.append(el('div', { class: 'error' }, e.message)); return root; }

  root.append(el('div', { class: 'section-head' },
    el('button', { class: 'small ghost', onclick: () => { currentView = 'fleet'; render(); } }, '← Overview'),
    el('h2', {}, esc(agent.display_name || agent.hostname)),
    el('span', { class: `badge ${agent.status}` }, agent.status),
    agent.location_name ? el('span', { class: 'muted' }, esc(agent.location_name)) : null,
    el('button', { class: 'small ghost', onclick: () => { currentView = 'flows'; render(); } }, 'Flows →'),
    el('button', { class: 'small ghost', onclick: () => exportInvestigationMenu(id, agent.display_name || agent.hostname) }, 'Export'),
    canWrite() ? el('button', { class: 'small ghost', onclick: () => runTest(agent) }, 'Run test') : null));

  // Health résumé (the headline + the metrics that drove it).
  const healthHost = el('div', { class: 'agent-health' });
  root.append(healthHost);

  // Device config history (operator/admin) — masked snapshots + risk-classified
  // diffs from GET /api/devices/:id/config-history. Lazy-loaded.
  if (canWrite()) {
    const cfgHost = el('div', { class: 'card agent-config-history' }, el('h3', {}, 'Config history'), el('div', { class: 'muted' }, 'Loading…'));
    root.append(cfgHost);
    loadDeviceConfigHistory(id, cfgHost);
  }
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
  const typeSel = el('select', {}, ...[['ping', 'Ping (ICMP)'], ['tcp', 'TCP-connect'], ['dns', 'DNS'], ['traceroute', 'Traceroute'], ['curl', 'cURL (content check)'], ['pageload', 'Page load']].map(([v, l]) => el('option', { value: v }, l)));
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
    portWrap.style.display = typeSel.value === 'tcp' ? '' : 'none';
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
  const probeDetailHost = el('div', {});

  async function runProbe() {
    const host = target.value.trim();
    if (!host) { probeStatus.className = 'error'; probeStatus.textContent = 'Enter a target.'; return; }
    const body = { type: typeSel.value, host };
    if (typeSel.value === 'tcp') body.port = Number(portInput.value);
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
    probeLatestHost.replaceChildren(probeLatestTable(data.results || [], async (r) => { probeDetailHost.replaceChildren(await probeDetail(r, id)); }, (tool, r, btn) => requestToolInstall(id, tool, btn)));
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
    el('details', { class: 'sec', open: true }, el('summary', {}, 'Probes ', el('span', { class: 'muted' }, '· ping · TCP · DNS · traceroute · cURL')), probeForm, probeLatestHost, probeDetailHost),
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
    el('td', {}, esc(n.iface || '—')),
    el('td', {}, esc(n.driver || '—')),
    el('td', { class: 'muted' }, esc(n.driverVersion || '—')),
    el('td', {}, esc(n.firmwareVersion || '—')),
    el('td', { class: 'muted' }, esc(n.busInfo || n.pciId || '—'))));
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
      esc(a.name), a.iface ? el('span', { class: 'muted' }, ` (${esc(a.iface)})`) : null)));

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
          el('div', { class: 'drift-head' }, el('strong', {}, esc(model.label)), el('span', { class: 'muted' }, ` · ${model.count} unit(s)`)));
        for (const f of model.firmwares) {
          block.append(el('div', { class: `fw-row${f.isOutlier ? ' fw-outlier' : ''}` },
            el('span', { class: `badge ${f.isOutlier ? 'warn' : 'online'}` }, f.isOutlier ? 'outlier' : 'majority'),
            el('span', { class: 'fw-ver' }, esc(f.firmwareVersion)),
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
        el('div', {}, el('strong', {}, esc(model.label)), model.hasDrift ? el('span', { class: 'badge warn', style: 'margin-left:.4rem' }, 'drift') : null),
        el('div', { class: 'muted' }, `${model.count} unit(s) · ${esc(fwSummary)}`)));
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
          el('button', { class: 'linklike', onclick: () => openAgent(a.id) }, esc(a.name)),
          a.location ? el('span', { class: 'muted' }, ` · ${esc(a.location)}`) : null,
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
views.flows = async () => {
  const root = el('div', { class: 'flows-explorer' });
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Flows'),
    el('span', { class: 'muted' }, 'Conversations · top talkers · ports · anomalies · ingress/egress')));

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'No agents yet.')); return root; }

  const agentSel = el('select', {}, ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  if (selectedAgentId != null && agents.some((a) => String(a.id) === String(selectedAgentId))) agentSel.value = String(selectedAgentId);

  // Mode toggle: Unified (explore) or Bidirectional (ingress/egress split).
  let mode = 'unified';
  const modeUnified = el('button', { class: 'small active' }, 'Unified');
  const modeBidi = el('button', { class: 'small ghost' }, 'Bidirectional');

  const peerInput = el('input', { type: 'text', placeholder: 'IP (src/dst)' });
  const portInput = el('input', { type: 'number', min: '1', max: '65535', placeholder: 'port' });
  const protoInput = el('input', { type: 'text', placeholder: 'tcp/udp' });
  const dirSel = el('select', {},
    el('option', { value: '' }, 'All directions'),
    el('option', { value: 'out' }, 'Outbound'),
    el('option', { value: 'in' }, 'Inbound'));
  const scopeSel = el('select', {},
    el('option', { value: '' }, 'Internal + external'),
    el('option', { value: 'external' }, 'External only'),
    el('option', { value: 'internal' }, 'Internal only'));

  // Time controls: preset buttons + optional custom from/to that override them.
  const presets = [['15m', '15 min'], ['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours']];
  let activePreset = '1h';
  const fromI = el('input', { type: 'datetime-local', title: 'From (overrides preset)' });
  const toI = el('input', { type: 'datetime-local', title: 'To (overrides preset)' });
  const presetBtns = presets.map(([val, label]) => {
    const b = el('button', { class: `small ghost${val === activePreset ? ' active' : ''}`, onclick: () => {
      activePreset = val;
      presetBtns.forEach((pb) => pb.classList.toggle('active', pb === b));
      fromI.value = ''; toI.value = '';
      refresh();
    } }, label);
    return b;
  });
  const runBtn = el('button', { class: 'small' }, 'Inspect');
  const status = el('span', { class: 'muted' });

  // Unified-only filters — hidden when switching to bidirectional mode.
  const unifiedControls = el('span', {},
    el('label', { class: 'inline muted' }, ' Port ', portInput),
    el('label', { class: 'inline muted' }, ' Proto ', protoInput),
    dirSel, scopeSel);

  // Prefill from a deep link (global search → "→ flows").
  if (flowsPrefill) {
    if (flowsPrefill.agentId != null && agents.some((a) => String(a.id) === String(flowsPrefill.agentId))) agentSel.value = String(flowsPrefill.agentId);
    if (flowsPrefill.peer) peerInput.value = flowsPrefill.peer;
    if (flowsPrefill.port) portInput.value = String(flowsPrefill.port);
    flowsPrefill = null;
  }

  function switchMode(m) {
    mode = m;
    modeUnified.classList.toggle('active', m === 'unified');
    modeUnified.classList.toggle('ghost', m !== 'unified');
    modeBidi.classList.toggle('active', m === 'bidi');
    modeBidi.classList.toggle('ghost', m !== 'bidi');
    unifiedControls.style.display = m === 'unified' ? '' : 'none';
    refresh();
  }
  modeUnified.addEventListener('click', () => switchMode('unified'));
  modeBidi.addEventListener('click', () => switchMode('bidi'));

  root.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Agent ', agentSel),
    el('span', { class: 'muted' }, ' Mode '), modeUnified, modeBidi,
    el('label', { class: 'inline muted' }, ' Peer ', peerInput),
    unifiedControls,
    el('span', { class: 'muted' }, ' '), ...presetBtns,
    el('label', { class: 'inline muted' }, ' From ', fromI),
    el('label', { class: 'inline muted' }, ' To ', toI),
    runBtn, status));

  const host = el('div', {});
  root.append(host);

  function windowMs() {
    if (fromI.value && toI.value) return { fromMs: new Date(fromI.value).getTime(), toMs: new Date(toI.value).getTime() };
    const now = Date.now();
    if (activePreset === '15m') return { fromMs: now - 15 * 60000, toMs: now };
    if (activePreset === '6h') return { fromMs: now - 6 * 3600000, toMs: now };
    if (activePreset === '24h') return { fromMs: now - 24 * 3600000, toMs: now };
    return { fromMs: now - 3600000, toMs: now };
  }

  function dirSection(title, color, data, fromMs, toMs, markers) {
    const kids = [];
    if (data.series && data.series.length >= 2) {
      const pts = data.series.map((s) => ({ t: new Date(s.at).getTime(), y: s.bytes }));
      kids.push(el('div', { class: 'overview-chart' },
        historyChart([{ id: 'b', label: 'Bytes', color, points: pts }],
          { fromMs: pts[0].t, toMs: pts[pts.length - 1].t, band: robustBand(pts), markers })));
    } else {
      kids.push(el('div', { class: 'empty' }, 'No flows in window.'));
    }
    kids.push(el('h4', {}, 'Top talkers'));
    if (!data.topTalkers.length) {
      kids.push(el('div', { class: 'empty' }, 'No flows recorded.'));
    } else {
      kids.push(el('table', {},
        el('thead', {}, el('tr', {}, ...['Source', 'Destination', 'Org/Country', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...data.topTalkers.slice(0, 20).map((t) => el('tr', {},
          el('td', {}, esc(t.srcIp || '–')),
          el('td', {}, esc(t.dstIp || t.extIp || '–')),
          el('td', {}, t.internal
            ? el('span', { class: 'badge grace' }, 'internal')
            : el('span', { class: 'muted' }, [t.asnName, t.country].filter(Boolean).join(' · ') || '–')),
          el('td', { class: 'num' }, fmtBytes(t.bytes)),
          el('td', { class: 'num muted' }, String(t.flowCount)))))));
    }
    if (data.byProto && data.byProto.length) {
      kids.push(el('h4', {}, 'Protocols'));
      kids.push(el('table', {},
        el('thead', {}, el('tr', {}, ...['Protocol', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...data.byProto.slice(0, 8).map((p) => el('tr', {},
          el('td', {}, p.proto || '–'),
          el('td', { class: 'num' }, fmtBytes(p.bytes)),
          el('td', { class: 'num muted' }, String(p.flowCount)))))));
    }
    return el('div', { class: 'flowbidi-panel' },
      el('h3', { class: 'flowbidi-dir' }, title, el('span', { class: 'muted' }, ` · ${fmtBytes(data.totals.bytes)}`)),
      ...kids);
  }

  const talkerPeer = (t) => (t.internal ? t.dstIp : (t.extIp || t.dstIp));

  async function refresh() {
    const { fromMs, toMs } = windowMs();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      host.replaceChildren(el('div', { class: 'error' }, 'Invalid time range — check From / To.'));
      status.textContent = ''; return;
    }
    status.textContent = 'Loading…';
    host.replaceChildren();

    const qp = new URLSearchParams({
      agentId: agentSel.value,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
    const peerVal = peerInput.value.trim();

    if (mode === 'bidi') {
      if (peerVal) qp.set('host', peerVal);
      let data;
      try {
        data = await api(`/api/flows/bidirectional?${qp}`);
      } catch (e) {
        host.replaceChildren(el('div', { class: 'error' }, errText(e)));
        status.textContent = ''; return;
      }
      status.textContent = `${fmtBytes(data.asymmetry.totalBytes)} total · ${fmtBytes(data.asymmetry.inBytes)} ↓ / ${fmtBytes(data.asymmetry.outBytes)} ↑`;

      let markers = [];
      try {
        const fs = await api(`/api/findings?hostId=${encodeURIComponent(agentSel.value)}&since=${new Date(fromMs).toISOString()}`);
        markers = findingMarkers(fs);
      } catch { /* overlay is optional */ }

      const kids = [];
      if (data.asymmetry.ratio !== null && data.asymmetry.asymmetric) {
        const inPct = Math.round(data.asymmetry.ratio * 100);
        kids.push(el('div', { class: 'flowbidi-asym warn' },
          '⚠ Asymmetric traffic: ',
          el('strong', {}, `${inPct}% ingress`), ' / ',
          el('strong', {}, `${100 - inPct}% egress`),
          el('span', { class: 'muted' }, ' — replies may arrive on a different path.')));
      } else if (data.asymmetry.ratio !== null) {
        const inPct = Math.round(data.asymmetry.ratio * 100);
        kids.push(el('div', { class: 'flowbidi-asym ok' },
          `Symmetric traffic: ${inPct}% ingress / ${100 - inPct}% egress.`));
      }
      kids.push(el('div', { class: 'flowbidi-cols' },
        dirSection('↓ Ingress', '#06b6d4', data.ingress, fromMs, toMs, markers),
        dirSection('↑ Egress', '#10b981', data.egress, fromMs, toMs, markers)));
      host.replaceChildren(...kids);
      return;
    }

    // Unified mode — /api/flows/explore.
    if (peerVal) qp.set('peer', peerVal);
    if (portInput.value.trim()) qp.set('port', portInput.value.trim());
    if (protoInput.value.trim()) qp.set('proto', protoInput.value.trim());
    if (dirSel.value) qp.set('direction', dirSel.value);
    if (scopeSel.value) qp.set('internal', scopeSel.value);

    let data;
    try { data = await api(`/api/flows/explore?${qp}`); } catch (e) { host.replaceChildren(el('div', { class: 'error' }, e.message)); status.textContent = ''; return; }
    status.textContent = `${fmtBytes(data.totals.bytes)} · ${data.totals.flowCount} flows · ${data.totals.records} records`;

    let markers = [];
    try {
      const fs = await api(`/api/findings?hostId=${encodeURIComponent(agentSel.value)}&since=${new Date(fromMs).toISOString()}`);
      markers = findingMarkers(fs);
    } catch { /* overlay is optional */ }

    const kids = [];
    if (data.scans && data.scans.length) {
      kids.push(el('details', { class: 'sec scan-sec', open: true },
        el('summary', {}, '⚠ Possible scans / fan-out ', el('span', { class: 'muted' }, '· one source against many ports/hosts')),
        el('table', {},
          el('thead', {}, el('tr', {}, ...['Source', 'Type', 'Ports', 'Hosts', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...data.scans.map((s) => el('tr', {},
            el('td', {}, esc(s.srcIp)),
            el('td', {}, el('span', { class: `badge ${s.kind === 'port-scan' ? 'offline' : 'warn'}` }, s.kind === 'port-scan' ? 'PORT-SCAN' : 'FAN-OUT')),
            el('td', { class: 'num bad-text' }, String(s.distinctPorts)),
            el('td', { class: 'num' }, String(s.distinctHosts)),
            el('td', { class: 'num' }, fmtBytes(s.bytes)),
            el('td', { class: 'num muted' }, String(s.flowCount))))))));
    }
    if (data.series && data.series.length >= 2) {
      const pts = data.series.map((s) => ({ t: new Date(s.at).getTime(), y: s.bytes }));
      kids.push(el('div', { class: 'overview-chart' },
        historyChart([{ id: 'b', label: 'Bytes', color: '#06b6d4', points: pts }],
          { fromMs: pts[0].t, toMs: pts[pts.length - 1].t, band: robustBand(pts), markers })));
    }
    kids.push(el('h4', {}, 'Top talkers'));
    if (!data.topTalkers.length) kids.push(el('div', { class: 'empty' }, 'No flows in the window — requires NetFlow/sFlow + geo-pipeline.'));
    else kids.push(el('table', {},
      el('thead', {}, el('tr', {}, ...['Source', 'Destination', 'Org/Country', 'Bytes', 'Packets', 'Flows'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...data.topTalkers.map((t) => el('tr', { class: 'fleet-row', onclick: () => { peerInput.value = talkerPeer(t) || ''; refresh(); } },
        el('td', {}, esc(t.srcIp || '–')),
        el('td', {}, esc(t.dstIp || t.extIp || '–')),
        el('td', {}, t.internal ? el('span', { class: 'badge grace' }, 'internal') : el('span', { class: 'muted' }, [t.asnName, t.country].filter(Boolean).join(' · ') || '–')),
        el('td', { class: 'num' }, fmtBytes(t.bytes)),
        el('td', { class: 'num muted' }, String(t.packets)),
        el('td', { class: 'num muted' }, String(t.flowCount)))))));

    const portTable = el('table', {},
      el('thead', {}, el('tr', {}, ...['Port', 'Proto', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...(data.byPort.length ? data.byPort.map((p) => el('tr', {},
        el('td', {}, String(p.port)), el('td', { class: 'muted' }, p.proto || '–'),
        el('td', { class: 'num' }, fmtBytes(p.bytes)), el('td', { class: 'num muted' }, String(p.flowCount))))
        : [el('tr', {}, el('td', { class: 'muted' }, '–'))])));
    const protoTable = el('table', {},
      el('thead', {}, el('tr', {}, ...['Protocol', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...(data.byProto.length ? data.byProto.map((p) => el('tr', {},
        el('td', {}, p.proto || '–'),
        el('td', { class: 'num' }, fmtBytes(p.bytes)),
        el('td', { class: 'num muted' }, String(p.flowCount))))
        : [el('tr', {}, el('td', { class: 'muted' }, '–'))])));
    kids.push(el('div', { class: 'flows-tables' },
      el('div', {}, el('h4', {}, 'Top ports'), portTable),
      el('div', {}, el('h4', {}, 'Protocols'), protoTable)));

    host.replaceChildren(...kids);
  }

  runBtn.addEventListener('click', refresh);
  agentSel.addEventListener('change', refresh);
  await refresh();
  return root;
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

// Topology map-mode Leaflet instance. The Topology tab defaults to the SVG
// diagram; when the user switches to Map mode a Leaflet map is built here and
// torn down on mode switch / view leave (it rebuilds on entry).
const topoMapState = { map: null };
function stopTopoMap() {
  if (topoMapState.map) { try { topoMapState.map.remove(); } catch { /* ignore */ } topoMapState.map = null; }
}

// Sites-map polling state (mirrors stopOverview/stopGeo). Re-drawn on a timer so
// agent health/online counts stay live; torn down when leaving the view.
const mapState = { map: null, timer: null, layer: null, fitted: false, popupOpen: false };
function stopMap() {
  if (mapState.timer) { clearInterval(mapState.timer); mapState.timer = null; }
  if (mapState.map) { try { mapState.map.remove(); } catch { /* ignore */ } }
  mapState.map = null; mapState.layer = null; mapState.fitted = false; mapState.popupOpen = false;
}

// The "Sites" map: your locations on a map, each marker coloured by the WORST
// agent health at that site (reusing the Overview verdict), clustered, live, and
// click-through to the agents there.
views.map = async () => {
  const root = el('div');
  const sub = el('span', { class: 'muted' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Sites'), sub));

  let locations; let agents; let mapCfg; let fleet;
  try {
    [locations, agents, mapCfg, fleet] = await Promise.all([
      api('/locations'), api('/agents'),
      api('/api/map/config').catch(() => ({})),
      api('/api/fleet/health').catch(() => ({ agents: [] })),
    ]);
  } catch (e) { root.append(el('div', { class: 'error' }, e.message)); return root; }

  // agentId → health verdict; refreshed on each poll.
  const healthByAgent = new Map((fleet.agents || []).map((a) => [a.agentId, a.health && a.health.status]));

  // Per-location rollup: counts + the agents (with health) + the worst status.
  function rollup() {
    const byLoc = new Map();
    for (const a of agents) {
      if (a.location_id == null) continue;
      const e = byLoc.get(a.location_id) || { total: 0, online: 0, agents: [] };
      e.total += 1;
      if (a.status === 'online') e.online += 1;
      const status = healthByAgent.get(a.id) || (a.status === 'online' ? 'unknown' : 'down');
      e.agents.push({ id: a.id, name: a.display_name || a.hostname, status });
      byLoc.set(a.location_id, e);
    }
    for (const e of byLoc.values()) e.worst = worstHealthStatus(e.agents.map((x) => x.status));
    return byLoc;
  }

  const located = locations.filter((l) => l.latitude != null && l.longitude != null);
  sub.textContent = `${located.length} of ${locations.length} locations have coordinates`;

  if (typeof L === 'undefined') {
    root.append(el('div', { class: 'empty' }, 'Map library could not be loaded (offline?). Showing list instead.'));
    root.append(locationList(locations, rollup()));
    return root;
  }
  if (!located.length) {
    root.append(el('div', { class: 'empty' }, 'No locations with coordinates yet. Add latitude/longitude in the Locations tab.'));
    return root;
  }

  const mapEl = el('div', { class: 'map' });
  root.append(mapEl);
  root.append(el('div', { class: 'legend geo-legend' },
    el('span', {}, el('span', { class: 'dot ring', style: `background:${HEALTH_COLOR.ok}` }), ' healthy'),
    el('span', {}, el('span', { class: 'dot ring', style: `background:${HEALTH_COLOR.warn}` }), ' warning'),
    el('span', {}, el('span', { class: 'dot ring', style: `background:${HEALTH_COLOR.bad}` }), ' critical'),
    el('span', {}, el('span', { class: 'dot ring', style: `background:${HEALTH_COLOR.unknown}` }), ' unknown / offline'),
    el('span', { class: 'muted' }, '· colour = worst agent health at the site')));

  function popupFor(l, c) {
    return el('div', { class: 'map-pop' },
      el('strong', {}, esc(l.name)),
      el('div', { class: 'muted' }, `${c.online}/${c.total} agents online`),
      l.address ? el('div', { class: 'muted' }, esc(l.address)) : null,
      el('div', { class: 'map-pop-agents' }, ...c.agents.slice(0, 12).map((ag) => el('button', {
        class: 'map-pop-agent', title: 'Open agent', onclick: () => openAgent(ag.id),
      }, el('span', { class: 'dot', style: `background:${healthColor(ag.status)}` }), esc(ag.name)))));
  }

  function draw(byLoc) {
    if (!mapState.layer) return;
    mapState.layer.clearLayers();
    const pts = [];
    for (const l of located) {
      const c = byLoc.get(l.id) || { total: 0, online: 0, agents: [], worst: null };
      const m = L.circleMarker([l.latitude, l.longitude], {
        radius: 9, color: '#fff', weight: 2, fillColor: c.worst ? healthColor(c.worst) : '#94a3b8', fillOpacity: 0.95,
      });
      m.bindPopup(popupFor(l, c));
      mapState.layer.addLayer(m);
      pts.push([l.latitude, l.longitude]);
    }
    if (!mapState.fitted && pts.length) {
      if (pts.length > 1) mapState.map.fitBounds(pts, { padding: [40, 40] });
      mapState.fitted = true;
    }
  }

  stopMap();
  setTimeout(() => {
    if (!mapEl.isConnected) return; // view was left before the deferred init ran
    const map = createLeafletMap(mapEl, mapCfg, { center: [located[0].latitude, located[0].longitude], zoom: 6 });
    if (!map) return;
    mapState.map = map;
    map.on('popupopen', () => { mapState.popupOpen = true; });
    map.on('popupclose', () => { mapState.popupOpen = false; });
    mapState.layer = (typeof L.markerClusterGroup === 'function') ? L.markerClusterGroup({ maxClusterRadius: 50 }) : L.layerGroup();
    mapState.layer.addTo(map);
    draw(rollup());
  }, 0);

  mapState.timer = setInterval(async () => {
    if (currentView !== 'map') { stopMap(); return; }
    if (modalOpen() || mapState.popupOpen || !mapState.map) return;
    try {
      const [a, f] = await Promise.all([api('/agents'), api('/api/fleet/health').catch(() => null)]);
      agents = a;
      if (f) { healthByAgent.clear(); for (const x of f.agents || []) healthByAgent.set(x.agentId, x.health && x.health.status); }
      draw(rollup());
    } catch { /* keep the last good render */ }
  }, 10000);

  return root;
};

// ---- Destinations map (internal sites + external destinations + selection) ----
const geoState = { map: null, ext: null, hosts: null, rect: null, dests: [], sinceIso: '', panel: null, selecting: false, rectStart: null, healthByHost: null, pathLayer: null };

function stopGeo() {
  if (geoState.map) { try { geoState.map.remove(); } catch { /* ignore */ } }
  geoState.map = null; geoState.ext = null; geoState.hosts = null; geoState.rect = null;
  geoState.dests = []; geoState.selecting = false; geoState.rectStart = null; geoState.healthByHost = null; geoState.pathLayer = null;
}

function devColor(dev) {
  const d = Number(dev) || 0;
  if (d >= 0.75) return '#ef4444';
  if (d >= 0.2) return '#f59e0b';
  return '#38bdf8';
}
function devLabel(dev) { const d = Number(dev) || 0; return `${d > 0 ? '+' : ''}${Math.round(d * 100)}%`; }
function radiusForBytes(b) { return Math.max(6, Math.min(28, 6 + Math.log10((Number(b) || 0) + 1) * 3)); }
function destTitle(d) { return `${d.country || '??'}${d.asn ? ` · AS${d.asn}` : ''}${d.asnName ? ` ${d.asnName}` : ''}`; }
function destQuery(d) {
  const qs = new URLSearchParams();
  if (d.country) qs.set('country', d.country);
  if (d.asn != null && d.asn !== '') qs.set('asn', d.asn);
  if (geoState.sinceIso) qs.set('since', geoState.sinceIso);
  return qs.toString();
}

function geoSpinner(text) { return el('div', { class: 'geo-loading' }, el('span', { class: 'spinner' }), text || 'Loading…'); }

function miniTable(title, rows) {
  if (!rows || !rows.length) return null;
  return el('div', { class: 'mini' }, el('h4', {}, title),
    el('table', {}, el('tbody', {}, ...rows.map((r) => el('tr', {}, el('td', {}, r[0]), el('td', { class: 'num' }, r[1]))))));
}
function findingMini(f) {
  return el('div', { class: 'finding-mini' },
    el('span', { class: `badge ${esc(f.severity || 'INFO')}` }, f.severity || 'INFO'),
    el('span', {}, ` ${esc(f.metric || '')} `),
    el('span', { class: 'muted' }, esc(f.explanation || '')));
}

views.geo = async () => {
  if (typeof L === 'undefined') {
    return el('div', { class: 'empty' }, 'Map library (Leaflet) could not be loaded — geo map is unavailable offline.');
  }
  const [config, overview, fleet, agents] = await Promise.all([
    api('/api/geo/config'), api('/api/geo/overview'),
    api('/api/fleet/health').catch(() => ({ agents: [] })),
    api('/agents').catch(() => []),
  ]);
  // hostId → health verdict, so internal site pins can be coloured by health.
  geoState.healthByHost = new Map((fleet.agents || []).map((a) => [a.agentId, a.health && a.health.status]));

  const root = el('div', { class: 'geo' });
  const periodSel = el('select', {},
    el('option', { value: '24h' }, 'Last 24 h'),
    el('option', { value: '7d' }, 'Last 7 days'),
    el('option', { value: '30d' }, 'Last 30 days'));
  const regionBtn = el('button', { class: 'small ghost' }, 'Select region');
  const clearBtn = el('button', { class: 'small ghost' }, 'Clear selection');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Destinations'),
    el('span', { class: 'spacer' }),
    exportButtons('geo', () => (geoState.sinceIso ? { since: geoState.sinceIso } : {})),
    el('label', { class: 'muted inline' }, 'Period ', periodSel),
    regionBtn, clearBtn));

  // Path picker: overlay an agent's traceroute path onto this map. Target options
  // are the agent's recent traceroute destinations (run them in the Probes tab).
  const pathAgentSel = el('select', { class: 'small' }, el('option', { value: '' }, 'Agent…'),
    ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  const pathTargetDl = el('datalist', { id: 'geo-path-targets' });
  const pathTargetInput = el('input', { type: 'text', class: 'small', list: 'geo-path-targets', placeholder: 'Traceroute target…' });
  const showPathBtn = el('button', { class: 'small' }, 'Show path');
  const clearPathBtn = el('button', { class: 'small ghost' }, 'Clear path');
  async function loadPathTargets() {
    pathTargetDl.replaceChildren();
    const id = pathAgentSel.value;
    pathTargetInput.value = '';
    if (!id) return;
    try {
      const data = await api(`/api/probes/latest?agentId=${encodeURIComponent(id)}`);
      const targets = [...new Set((data.results || []).filter((r) => r.type === 'traceroute').map((r) => r.target))];
      for (const t of targets) pathTargetDl.append(el('option', { value: t }));
    } catch { /* leave empty */ }
  }
  async function showPath() {
    if (!geoState.map) return;
    const id = pathAgentSel.value;
    if (!id) { toast('Pick an agent first.', true); return; }
    const target = pathTargetInput.value.trim();
    if (!target) { toast('Enter a traceroute target.', true); return; }
    showPathBtn.disabled = true;
    let polling = false;
    try {
      const qs = `agentId=${encodeURIComponent(id)}&target=${encodeURIComponent(target)}`;
      const data = await api(`/api/probes/path?${qs}`);
      if (data.nodes && data.nodes.length) {
        drawGeoPath(data);
      } else {
        // No existing data — trigger a fresh traceroute and poll for results.
        await api(`/agents/${id}/probe`, { method: 'POST', body: { type: 'traceroute', host: target } });
        polling = true;
        showPathBtn.textContent = 'Running…';
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          try {
            const d = await api(`/api/probes/path?${qs}`);
            if ((d.nodes && d.nodes.length) || attempts >= 4) {
              clearInterval(poll);
              showPathBtn.textContent = 'Show path';
              showPathBtn.disabled = false;
              if (d.nodes && d.nodes.length) { drawGeoPath(d); loadPathTargets(); }
              else toast('Traceroute sent — no path yet, try Show path again in a moment.', true);
            }
          } catch { clearInterval(poll); showPathBtn.textContent = 'Show path'; showPathBtn.disabled = false; }
        }, 4000);
      }
    } catch (e) {
      toast(e.status === 409 ? 'Agent not connected — run the traceroute from the Probes tab first.' : errText(e), true);
    } finally { if (!polling) showPathBtn.disabled = false; }
  }
  pathAgentSel.addEventListener('change', loadPathTargets);
  showPathBtn.addEventListener('click', showPath);
  clearPathBtn.addEventListener('click', () => { if (geoState.pathLayer) geoState.pathLayer.clearLayers(); showOverviewSummary(); });
  root.append(el('div', { class: 'geo-pathpick' },
    el('span', { class: 'muted' }, 'Traceroute path:'),
    pathAgentSel, pathTargetDl, pathTargetInput, showPathBtn, clearPathBtn));

  // No GeoIP database ⇒ public IPs can't be placed by country, so the map shows
  // only site pins and traceroute paths collapse to the origin. Say so up front
  // rather than letting the map look broken; point admins at where to fix it.
  geoState.geoip = config.geoip || null;
  if (config.geoip && config.geoip.configured === false) {
    root.append(el('div', { class: 'alert-banner sev-WARN' },
      el('span', { class: 'alert-ic' }, '⚠'),
      el('span', {},
        el('strong', {}, 'GeoIP database not configured. '),
        'External destinations and traceroute hops can’t be placed by country until an offline GeoIP/ASN range database is loaded. ',
        role === 'admin'
          ? settingsLink('map', 'Configure it in Settings → Map')
          : 'Ask an administrator to configure it in Settings → Map',
        '.')));
  }

  const mapEl = el('div', { class: 'map' });
  const panel = el('div', { class: 'geo-panel' });
  geoState.panel = panel;
  geoState.mapEl = mapEl;
  root.append(el('div', { class: 'geo-grid' }, mapEl, panel));
  // Two colour scales: internal SITES are ringed dots coloured by agent health;
  // external DESTINATIONS are circles coloured by traffic deviation (size = volume).
  root.append(el('div', { class: 'legend geo-legend' },
    el('span', { class: 'muted' }, 'Sites:'),
    el('span', {}, el('span', { class: 'dot ring', style: `background:${HEALTH_COLOR.ok}` }), ' healthy'),
    el('span', {}, el('span', { class: 'dot ring', style: `background:${HEALTH_COLOR.warn}` }), ' warning'),
    el('span', {}, el('span', { class: 'dot ring', style: `background:${HEALTH_COLOR.bad}` }), ' critical'),
    el('span', { class: 'muted' }, '· Destinations:'),
    el('span', {}, el('span', { class: 'dot', style: 'background:#38bdf8' }), ' normal'),
    el('span', {}, el('span', { class: 'dot', style: 'background:#f59e0b' }), ' elevated'),
    el('span', {}, el('span', { class: 'dot', style: 'background:#ef4444' }), ' strong deviation'),
    el('span', { class: 'muted' }, '· size = volume')));

  periodSel.addEventListener('change', () => {
    const v = periodSel.value;
    const ms = v === '7d' ? 7 * 864e5 : v === '30d' ? 30 * 864e5 : 864e5;
    geoState.sinceIso = new Date(Date.now() - ms).toISOString();
    reloadOverview();
  });
  regionBtn.addEventListener('click', () => beginRegionSelect(regionBtn));
  clearBtn.addEventListener('click', () => { clearRegion(); showOverviewSummary(); });

  setTimeout(() => initGeoMap(config, overview), 0);
  return root;
};

function initGeoMap(config, overview) {
  if (!geoState.mapEl || !geoState.mapEl.isConnected) return; // view was left already
  const center = pickGeoCenter(overview);
  const map = createLeafletMap(geoState.mapEl, config, { center, zoom: 3 });
  if (!map) return;
  geoState.map = map;

  geoState.ext = (typeof L.markerClusterGroup === 'function') ? L.markerClusterGroup({ maxClusterRadius: 50 }) : L.layerGroup();
  geoState.hosts = L.layerGroup();
  geoState.ext.addTo(map); geoState.hosts.addTo(map);

  // Region drawing handlers (active only while selecting).
  map.on('mousedown', (e) => { if (geoState.selecting) { geoState.rectStart = e.latlng; } });
  map.on('mousemove', (e) => {
    if (!geoState.selecting || !geoState.rectStart) return;
    const b = L.latLngBounds(geoState.rectStart, e.latlng);
    if (geoState.rect) geoState.rect.setBounds(b);
    else geoState.rect = L.rectangle(b, { color: '#38bdf8', weight: 1, fillOpacity: 0.08 }).addTo(map);
  });
  map.on('mouseup', (e) => {
    if (!geoState.selecting || !geoState.rectStart) return;
    const b = L.latLngBounds(geoState.rectStart, e.latlng);
    geoState.rectStart = null; geoState.selecting = false;
    map.dragging.enable(); map.boxZoom.enable();
    aggregateRegion(b);
  });

  drawOverview(overview);
  showOverviewSummary();
}

function pickGeoCenter(overview) {
  const h = (overview.internalHosts || []).find((x) => x.lat != null && x.lng != null);
  if (h) return [h.lat, h.lng];
  const d = (overview.externalDestinations || []).find((x) => x.lat != null && x.lng != null);
  return d ? [d.lat, d.lng] : [20, 0];
}

function drawOverview(overview) {
  geoState.dests = (overview.externalDestinations || []).filter((d) => d.lat != null && d.lng != null);
  geoState.ext.clearLayers(); geoState.hosts.clearLayers();

  for (const h of overview.internalHosts || []) {
    if (h.lat == null || h.lng == null) continue;
    const status = (geoState.healthByHost && geoState.healthByHost.get(h.hostId)) || (h.status === 'online' ? 'unknown' : 'down');
    const m = L.circleMarker([h.lat, h.lng], { radius: 8, color: '#fff', weight: 2, fillColor: healthColor(status), fillOpacity: 0.95 });
    m.bindTooltip(`${esc(h.siteName || `host ${h.hostId}`)} (${esc(h.status || '?')})`);
    m.on('click', () => selectHost(h));
    geoState.hosts.addLayer(m);
  }
  for (const d of geoState.dests) {
    const c = L.circleMarker([d.lat, d.lng], {
      radius: radiusForBytes(d.bytes), color: devColor(d.deviation),
      fillColor: devColor(d.deviation), fillOpacity: 0.5, weight: 1,
    });
    c.bindTooltip(`${esc(destTitle(d))} — ${fmtBytes(d.bytes)} (${devLabel(d.deviation)})`);
    c.on('click', () => selectDestination(d));
    geoState.ext.addLayer(c);
  }
}

async function reloadOverview() {
  if (!geoState.map) return;
  const panel = geoState.panel;
  panel.replaceChildren(geoSpinner('Updating…'));
  try {
    const qs = geoState.sinceIso ? `?since=${encodeURIComponent(geoState.sinceIso)}` : '';
    const overview = await api(`/api/geo/overview${qs}`);
    drawOverview(overview);
    showOverviewSummary();
  } catch (err) {
    panel.replaceChildren(el('div', { class: 'empty error' }, err.message));
  }
}

function showOverviewSummary() {
  const panel = geoState.panel;
  if (!panel) return;
  const dests = geoState.dests;
  const totBytes = dests.reduce((s, d) => s + (Number(d.bytes) || 0), 0);
  const top = dests.slice().sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0)).slice(0, 12);
  const topTable = top.length
    ? el('table', { class: 'geo-top' }, el('tbody', {}, ...top.map((d) => el('tr', {
      class: 'geo-top-row', tabindex: '0', title: 'Show destination details',
      onclick: () => selectDestination(d),
      onkeydown: (e) => { if (e.key === 'Enter') selectDestination(d); },
    },
    el('td', {}, el('span', { class: 'dot', style: `background:${devColor(d.deviation)}` }), ' ', esc(destTitle(d))),
    el('td', { class: 'num' }, fmtBytes(d.bytes)),
    el('td', { class: 'num muted' }, devLabel(d.deviation))))))
    : el('div', { class: 'muted' }, 'No external destinations in this period.');
  panel.replaceChildren(
    el('div', { class: 'section-head' }, el('h3', {}, 'Overview')),
    el('p', { class: 'muted' }, `${dests.length} external destinations · ${fmtBytes(totBytes)} in the period`),
    el('h4', {}, 'Top destinations'),
    topTable,
    el('p', { class: 'muted small' }, 'Click a row, a circle (destination) or a site pin for details, or select a region.'));
}

// Overlays a traceroute path graph (from /api/probes/path) onto the Destinations
// map in a dedicated layer that "Clear path" wipes — same pgColor/pathGeoStops/
// renderPathStops used by the Probes traceroute map — and summarises it in the
// side panel.
function drawGeoPath(graph) {
  if (!geoState.map) return;
  const stops = pathGeoStops(graph.nodes || []);
  if (!geoState.pathLayer) geoState.pathLayer = L.layerGroup().addTo(geoState.map);
  geoState.pathLayer.clearLayers();
  if (stops.length >= 2) {
    const latlngs = renderPathStops(geoState.pathLayer, stops);
    try { geoState.map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 7 }); } catch { /* single point */ }
  }
  geoPathSummary(graph, stops);
}

function geoPathSummary(graph, stops) {
  const panel = geoState.panel;
  if (!panel) return;
  const rank = { bad: 3, warn: 2, muted: 1, ok: 0 };
  const hops = (graph.nodes || []).filter((n) => n.kind !== 'source');
  const worst = hops.reduce((w, n) => ((rank[n.severity] || 0) > (rank[(w && w.severity)] || 0) ? n : w), null);
  const list = stops.length
    ? el('ul', { class: 'geo-path-stops' }, ...stops.map((s) => {
      const isSrc = s.nodes.some((n) => n.kind === 'source');
      const place = isSrc ? (s.nodes[0].label || 'Agent') : (s.nodes[0].country || '—');
      const hopLabel = isSrc ? 'origin'
        : s.nodes.length > 1 ? `hops ${s.nodes[0].hop}–${s.nodes[s.nodes.length - 1].hop}` : `hop ${s.nodes[0].hop}`;
      return el('li', {}, el('span', { class: 'dot', style: `background:${pgColor(s.severity)}` }), ' ',
        esc(String(place)), ' ', el('span', { class: 'muted' }, hopLabel));
    }))
    : el('div', { class: 'empty' }, 'No geolocated stops — country-level geo needs the agent site and at least one public hop.');
  // When a run exists but the map stays (almost) empty, say why instead of leaving
  // a blank panel: either no hops came back at all (the agent's traceroute/tracert
  // is missing or blocked), or hops came back but can't be placed (private hops, or
  // no GeoIP country). The full per-hop topology is always on the Probes view.
  let note = null;
  if (graph.samples > 0 && stops.length < 2) {
    if (!hops.length) {
      const why = graph.detail
        ? `The agent couldn't run traceroute: ${esc(graph.detail)}.`
        : 'The traceroute returned no hops — the agent is likely missing the traceroute/tracert command or has it blocked.';
      note = el('p', { class: 'muted small' }, `${why} Open Probes to see the raw result.`);
    } else {
      const silent = hops.every((h) => h.unresponsive);
      note = el('p', { class: 'muted small' }, `${hops.length} hop${hops.length === 1 ? '' : 's'} captured${silent ? ' (all silent — no ICMP replies)' : ''}, but none could be placed on the map (private hops or no GeoIP country). Open Probes for the per-hop topology.`);
    }
  }
  // worst-hop line and `note` can be null; `el()` skips null kids but a bare
  // `replaceChildren(…, null, …)` would stringify it to the text "null", so filter.
  const worstLine = worst && (rank[worst.severity] || 0) > 0
    ? el('p', { class: worst.severity === 'bad' ? 'bad-text' : 'warn-text' }, `Worst hop: #${worst.hop} — ${esc(worst.explain)}`)
    : null;
  panel.replaceChildren(...[
    el('div', { class: 'section-head' }, el('h3', {}, 'Traceroute path')),
    el('p', {}, esc(graph.target || '(latest)')),
    el('p', { class: 'muted' }, `${graph.samples} run${graph.samples === 1 ? '' : 's'} aggregated · ${stops.length} geolocated stop${stops.length === 1 ? '' : 's'}`),
    worstLine,
    note,
    list,
    el('p', { class: 'muted small' }, 'Open Probes to inspect the per-hop topology, or “Clear path” to return to the overview.'),
  ].filter(Boolean));
}

async function selectDestination(d) {
  const panel = geoState.panel;
  panel.replaceChildren(geoSpinner('Loading destination…'));
  const qs = destQuery(d);
  try {
    const flows = await api(`/api/geo/select/flows?${qs}`).catch((e) => { if (e.status === 404) return null; throw e; });
    if (!flows) { panel.replaceChildren(el('div', { class: 'empty' }, 'No data for this destination in the period.')); return; }
    const findings = await api(`/api/geo/select/findings?${qs}`).catch((e) => { if (e.status === 404) return { findings: [] }; throw e; });
    renderDestPanel(d, flows, findings);
  } catch (err) {
    panel.replaceChildren(el('div', { class: 'empty error' }, err.message));
  }
}

function renderDestPanel(d, flows, findingsRes) {
  const fs = (findingsRes && findingsRes.findings) || [];
  geoState.panel.replaceChildren(
    el('div', { class: 'section-head' }, el('h3', {}, destTitle(d)),
      el('span', { class: 'spacer' }), el('button', { class: 'small ghost', onclick: () => { clearRegion(); showOverviewSummary(); } }, 'Clear selection')),
    el('p', { class: 'muted' }, `${fmtBytes(flows.totals.bytes)} · ${flows.totals.flowCount} flows · deviation ${devLabel(d.deviation)}`),
    miniTable('Direction', flows.byDirection.map((x) => [x.direction === 'in' ? 'inbound' : 'outbound', fmtBytes(x.bytes)])),
    miniTable('Protocol', flows.byProto.map((x) => [esc(x.proto || '–'), fmtBytes(x.bytes)])),
    miniTable('ASN', flows.byAsn.map((x) => [esc(x.asnName || (x.asn ? `AS${x.asn}` : '–')), fmtBytes(x.bytes)])),
    el('h4', {}, `Findings (${fs.length})`),
    fs.length ? el('div', {}, ...fs.slice(0, 50).map(findingMini)) : el('div', { class: 'muted' }, 'No findings for the hosts communicating with this destination.'));
}

async function selectHost(h) {
  const panel = geoState.panel;
  panel.replaceChildren(geoSpinner('Loading host…'));
  try {
    const findings = await api(`/api/findings?hostId=${encodeURIComponent(h.hostId)}`);
    panel.replaceChildren(
      el('div', { class: 'section-head' }, el('h3', {}, esc(h.siteName || `host ${h.hostId}`)),
        el('span', { class: 'spacer' }), el('button', { class: 'small ghost', onclick: showOverviewSummary }, 'Clear selection')),
      el('p', {}, el('span', { class: `badge ${h.status === 'online' ? 'online' : 'offline'}` }, h.status || '?'), ` host ${h.hostId}`),
      el('h4', {}, `Findings (${findings.length})`),
      findings.length ? el('div', {}, ...findings.slice(0, 50).map(findingMini)) : el('div', { class: 'muted' }, 'No findings for this host.'));
  } catch (err) {
    panel.replaceChildren(el('div', { class: 'empty error' }, err.message));
  }
}

function beginRegionSelect(btn) {
  if (!geoState.map) return;
  geoState.selecting = true;
  geoState.map.dragging.disable();
  geoState.map.boxZoom.disable();
  toast('Draw a box on the map to select a region');
  if (btn) { btn.classList.add('active-btn'); setTimeout(() => btn.classList.remove('active-btn'), 1500); }
}

function clearRegion() {
  if (geoState.rect && geoState.map) { geoState.map.removeLayer(geoState.rect); }
  geoState.rect = null;
}

async function aggregateRegion(bounds) {
  const panel = geoState.panel;
  const inBox = geoState.dests.filter((d) => bounds.contains([d.lat, d.lng]));
  if (!inBox.length) { panel.replaceChildren(el('div', { class: 'empty' }, 'No destinations in the selected region.')); return; }
  const totBytes = inBox.reduce((s, d) => s + (Number(d.bytes) || 0), 0);
  const totFlows = inBox.reduce((s, d) => s + (Number(d.flowCount) || 0), 0);
  panel.replaceChildren(
    el('div', { class: 'section-head' }, el('h3', {}, 'Region'),
      el('span', { class: 'spacer' }), el('button', { class: 'small ghost', onclick: () => { clearRegion(); showOverviewSummary(); } }, 'Clear selection')),
    el('p', { class: 'muted' }, `${inBox.length} destinations · ${fmtBytes(totBytes)} · ${totFlows} flows`),
    miniTable('Destinations', inBox.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 30).map((d) => [esc(destTitle(d)), fmtBytes(d.bytes)])),
    el('div', { class: 'geo-region-findings' }, geoSpinner('Loading findings for the region…')));

  // Aggregate findings across the distinct countries in the box (bounded).
  const countries = [...new Set(inBox.map((d) => d.country).filter(Boolean))].slice(0, 8);
  const seen = new Set();
  const findings = [];
  try {
    for (const country of countries) {
      const qs = new URLSearchParams({ country });
      if (geoState.sinceIso) qs.set('since', geoState.sinceIso);
      // eslint-disable-next-line no-await-in-loop
      const res = await api(`/api/geo/select/findings?${qs}`).catch((e) => (e.status === 404 ? { findings: [] } : Promise.reject(e)));
      for (const f of res.findings || []) { if (!seen.has(f.id)) { seen.add(f.id); findings.push(f); } }
    }
  } catch { /* best-effort */ }
  const slot = panel.querySelector('.geo-region-findings');
  if (slot) {
    slot.replaceChildren(el('h4', {}, `Findings (${findings.length})`),
      findings.length ? el('div', {}, ...findings.slice(0, 50).map(findingMini)) : el('div', { class: 'muted' }, 'No findings in the region.'));
  }
}

function locationList(locations, byLoc) {
  return el('table', {},
    el('thead', {}, el('tr', {}, ...['Location', 'Address', 'Coordinates', 'Agents'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...locations.map((l) => {
      const c = byLoc.get(l.id) || { total: 0, online: 0 };
      return el('tr', {},
        el('td', {}, l.name),
        el('td', { class: 'muted' }, l.address || '–'),
        el('td', { class: 'muted' }, l.latitude != null ? `${l.latitude}, ${l.longitude}` : '–'),
        el('td', {}, `${c.online}/${c.total} online`));
    })));
}

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

views.locations = async () => {
  const locations = await api('/locations');
  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Locations'),
    canWrite() ? el('button', { class: 'small', onclick: () => editLocation() }, '+ New location') : null));
  if (!locations.length) { root.append(el('div', { class: 'empty' }, 'No locations.')); return root; }
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Name', 'Description', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...locations.map((l) => el('tr', {},
      el('td', {}, String(l.id)),
      el('td', {}, l.name),
      el('td', { class: 'muted' }, l.description || '–'),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'small ghost', onclick: () => showLocationTraffic(l) }, 'Traffic'),
        el('button', { class: 'small ghost', onclick: () => showLocationHistory(l) }, 'History'),
        featureEnabled('assistant') ? el('button', { class: 'small ghost', onclick: () => showLocationSummary(l) }, 'AI status') : null,
        canWrite() ? el('button', { class: 'small ghost', onclick: () => editLocation(l) }, 'Edit') : null,
        canDelete() ? el('button', { class: 'small danger', onclick: () => deleteLocation(l) }, 'Delete') : null)),
    )))));
  return root;
};

// AI status: a brief, plain-language "what's going on at this location?" summary
// from the opt-in assistant (per-agent health verdicts + recent findings). One
// click, no question to type. Degrades gracefully when the feature is off (403).
async function showLocationSummary(l) {
  const card = $('#modal-card');
  const out = el('div', { class: 'assistant-out muted' }, 'Thinking…');
  const close = el('button', { class: 'ghost', onclick: closeModal }, 'Close');
  card.replaceChildren(
    el('h3', {}, `AI status — ${esc(l.name)}`),
    el('p', { class: 'muted' }, 'Based on the latest probe-health verdicts and findings for this location.'),
    out,
    el('div', { class: 'form-actions' }, close));
  $('#modal').classList.remove('hidden');
  try {
    const res = await api('/api/assistant/location-summary', { method: 'POST', body: { locationId: l.id } });
    out.className = 'assistant-out';
    out.replaceChildren(
      el('div', {}, res.answer || '(empty response)'),
      el('div', { class: 'assistant-meta muted' }, `${esc(res.model || '')} · ${res.agents ?? 0} agent(s) · ${res.findings ?? 0} finding(s) in context`));
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
        el('h3', {}, `Traffic — ${esc(l.name)}`),
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
      el('h3', {}, `Traffic — ${esc(l.name)}`),
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

  card.replaceChildren(el('h3', {}, `Traffic — ${esc(l.name)}`), el('div', { class: 'empty' }, 'Loading…'));
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
    el('h3', {}, `History — ${esc(l.name)}`),
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

views.enrollment = async () => {
  const [codes, locations, cfg] = await Promise.all([
    api('/enrollment-codes'),
    api('/locations').catch(() => []),
    api('/enroll/config').catch(() => ({ serverUrl: location.origin, certFingerprint: null })),
  ]);
  locationCache = locations;
  enrollWatch = null;
  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Enrollment')));

  // Adding agents requires the agent signing key (the trust anchor for secure agent
  // management). Without it the server refuses to mint codes, so guide the user to
  // set it first instead of showing a wizard that would only error.
  if (canWrite()) {
    if (cfg.releasePublicKey) {
      root.append(enrollWizard(cfg));
    } else {
      const where = role === 'admin' ? settingsLink('agentkey', 'Settings → Agent key') : el('strong', {}, 'Settings → Agent key');
      root.append(el('div', { class: 'empty error' },
        'No agent signing key is set — you cannot add agents yet. ',
        role === 'admin' ? 'Generate it in ' : 'An administrator must generate it in ',
        where, ' first.'));
    }
  }

  root.append(el('div', { class: 'section-head' }, el('h3', {}, 'Active codes'),
    canWrite() ? el('button', { class: 'small ghost', onclick: () => createCode() }, '+ New code (advanced)') : null));
  if (!codes.length) { root.append(el('div', { class: 'empty' }, 'No codes yet — use "Add agent" above.')); return root; }
  // Codes are one-time install tickets; the agent's real credential is separate.
  root.append(el('p', { class: 'muted enroll-note' }, 'Codes are one-time install tickets. Once an agent enrols it stays connected on its own permanent token — independent of the code’s status — so a "used" or "expired" code never disconnects the agent shown beside it.'));
  // The agent(s) a code enrolled, each a clickable live online/offline badge.
  const agentsCell = (agents) => ((agents && agents.length)
    ? el('div', { class: 'code-agents' }, ...agents.map((a) => el('span', {
      class: 'code-agent', role: 'button', tabindex: '0',
      title: `${a.online ? 'Online' : 'Offline'} — open agent`,
      onclick: () => openAgent(a.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAgent(a.id); } },
    }, el('span', { class: `badge ${a.online ? 'online' : 'offline'}` }, a.online ? 'online' : 'offline'), esc(a.name))))
    : el('span', { class: 'muted' }, '–'));
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Status', 'Uses', 'Agents', 'Location', 'Expires', 'Created', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...codes.map((c) => el('tr', {},
      el('td', {}, String(c.id)),
      el('td', {}, el('span', { class: `badge ${c.status}` }, c.status)),
      el('td', {}, c.max_uses > 1 ? `${c.uses_remaining}/${c.max_uses}` : (c.uses_remaining === 0 ? 'used' : '1')),
      el('td', {}, agentsCell(c.agents)),
      el('td', {}, c.location_name || '–'),
      el('td', { class: 'muted' }, fmtDate(c.expires_at)),
      el('td', { class: 'muted' }, fmtDate(c.created_at)),
      el('td', {}, canDelete() ? el('button', { class: 'small danger', onclick: () => deleteCode(c) }, 'Delete') : null),
    )))));
  return root;
};

function enrollField(label, control) {
  return el('label', { class: 'enroll-field' }, el('span', {}, label), control);
}

function enrollWizard(cfg) {
  const card = el('div', { class: 'enroll-card' });
  const platformSel = el('select', {}, ...ENROLL_PLATFORMS.map(([v, l]) => el('option', { value: v }, l)));
  const countInp = el('input', { type: 'number', min: '1', max: '1000', value: '1', class: 'enroll-num' });
  const ttlInp = el('input', { type: 'number', min: '1', value: '60', class: 'enroll-num' });
  const locSel = el('select', {}, el('option', { value: '' }, '(no location)'),
    ...locationCache.map((l) => el('option', { value: String(l.id) }, l.name)));
  const result = el('div', { class: 'enroll-result hidden' });
  const genBtn = el('button', { onclick: () => generate() }, 'Generate code & command');

  card.append(
    el('h3', {}, 'Add agent'),
    el('p', { class: 'muted' }, 'Choose a platform, generate a code and copy the command to the agent machine. It registers itself online as soon as it runs — you never type the server address.'),
    el('div', { class: 'enroll-form' },
      enrollField('Platform', platformSel),
      enrollField('Number of machines', countInp),
      enrollField('Lifetime (min)', ttlInp),
      enrollField('Location', locSel)),
    el('div', { class: 'form-actions' }, genBtn),
    result);

  async function generate() {
    genBtn.disabled = true;
    try {
      const n = Math.max(1, Number(countInp.value) || 1);
      const ttl = Math.max(1, Number(ttlInp.value) || 60);
      const q = new URLSearchParams({ platform: platformSel.value, maxUses: String(n), ttlMinutes: String(ttl) });
      if (locSel.value) q.set('locationId', locSel.value);
      const data = await api(`/api/enroll/command?${q.toString()}`);
      renderEnrollResult(result, data, cfg, generate);
    } catch (err) { toast(errText(err), true); }
    finally { genBtn.disabled = false; }
  }
  return card;
}

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

  host.replaceChildren(
    live,
    el('div', { class: 'enroll-cmd-row' }, cmdPre, copyBtn),
    el('div', { class: 'form-actions' }, manualToggle, regenBtn),
    manual,
    meta,
    enrollAnsibleBlock(oneLiner));
}

// Copy-paste Ansible task running the same one-liner. `creates:` makes it
// idempotent (skips hosts where the agent is already installed).
function enrollAnsibleBlock(oneLiner) {
  const yaml = [
    '- hosts: all',
    '  become: true',
    '  tasks:',
    '    - name: Install BlueEye agent',
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
      el('pre', {}, esc(created.code)),
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

// ---- Settings (settings overview: users + license + config) ---------
let settingsTab = null;
// Settings are organised into labelled sections rather than one long row of tabs,
// so related controls sit together and the page stays scannable as it grows. Each
// tab is [key, label, adminOnly]; non-admins only ever see the personal section.
const SETTINGS_GROUPS = [
  ['Access & security', [['users', 'Users', true], ['auth', 'Authentication', true], ['apitokens', 'API tokens', true], ['agentkey', 'Agent key', true]]],
  ['Detection & alerts', [['analyse', 'Analysis', true], ['alerting', 'Alerting', true], ['integrations', 'Integrations', true], ['maintenance', 'Maintenance', true]]],
  ['Data', [['retention', 'Retention', true], ['types', 'Traffic types', true], ['map', 'Map', true]]],
  ['System', [['updates', 'Updates', true], ['agents', 'Agents', true], ['screening', 'Test Settings', true]]],
  ['Personal', [['appearance', 'Appearance', false], ['license', 'License', false]]],
];
// ---- Logs (admin-only operational + client-error view) ----------------------
// The in-memory server operational stream (agent connect/disconnect, WS/DB
// errors, HTTP failures) merged with client-side action failures. A live
// diagnostic aid — cleared on server restart. Distinct from Reporting → Audit
// (the durable "who did what" trail).
const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
let logsFilter = { level: '', source: '', q: '' };

function logLevelBadge(level) {
  const cls = level === 'error' ? 'danger' : (level === 'warn' ? 'warn' : (level === 'debug' ? 'neutral' : 'active'));
  return el('span', { class: `badge ${cls}` }, level);
}

function mergeLogEntries(serverEntries) {
  // Server ring already contains client errors shipped from any session (id
  // prefixed with 'c'); dedup this session's local copies against them so a
  // client error isn't shown twice.
  const shipped = new Set(serverEntries.filter((e) => e.source === 'client').map((e) => String(e.id).replace(/^c/, '')));
  const localOnly = clientLog.filter((e) => !shipped.has(e.id));
  return [...serverEntries, ...localOnly].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

views.logs = async () => {
  const root = el('div');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Logs'),
    el('span', { class: 'muted' }, 'Live server diagnostics + your dashboard errors · in-memory (cleared on restart)')));

  const levelSel = el('select', {}, ...[['', 'All levels'], ['debug', 'Debug+'], ['info', 'Info+'], ['warn', 'Warn+'], ['error', 'Errors only']]
    .map(([v, l]) => el('option', { value: v, ...(logsFilter.level === v ? { selected: 'selected' } : {}) }, l)));
  const sourceSel = el('select', {}, ...[['', 'All sources'], ['server', 'Server'], ['client', 'Dashboard']]
    .map(([v, l]) => el('option', { value: v, ...(logsFilter.source === v ? { selected: 'selected' } : {}) }, l)));
  const qInput = el('input', { type: 'search', placeholder: 'Filter text…', value: logsFilter.q });
  const refreshBtn = el('button', { class: 'small ghost' }, '⟳ Refresh');
  const status = el('span', { class: 'muted small' });

  const tbody = el('tbody');
  const table = el('table', { class: 'tests-table logs-table' },
    el('thead', {}, el('tr', {}, ...['Time', 'Level', 'Source', 'Message'].map((h) => el('th', {}, h)))),
    tbody);
  const host = el('div', { style: 'overflow-x:auto' }, table);

  async function load() {
    logsFilter = { level: levelSel.value, source: sourceSel.value, q: qInput.value.trim() };
    let serverEntries = [];
    try {
      const p = new URLSearchParams();
      if (logsFilter.level) p.set('level', logsFilter.level);
      if (logsFilter.q) p.set('q', logsFilter.q);
      p.set('limit', '500');
      const resp = await api(`/api/logs?${p.toString()}`);
      serverEntries = resp.entries || [];
    } catch (e) {
      // Non-fatal: still show the local client errors even if the server ring
      // is unreachable. (Don't toast — that would re-enter recordClientLog.)
      status.textContent = `server logs unavailable: ${errText(e)}`;
    }
    let rows = mergeLogEntries(serverEntries);
    if (logsFilter.source) rows = rows.filter((r) => r.source === logsFilter.source);
    if (logsFilter.level) { const min = LOG_LEVEL_ORDER[logsFilter.level]; rows = rows.filter((r) => (LOG_LEVEL_ORDER[r.level] ?? 1) >= min); }
    if (logsFilter.q) { const s = logsFilter.q.toLowerCase(); rows = rows.filter((r) => r.msg.toLowerCase().includes(s) || JSON.stringify(r.meta || {}).toLowerCase().includes(s)); }

    tbody.replaceChildren(...rows.map((r) => {
      const metaStr = r.meta && Object.keys(r.meta).length ? JSON.stringify(r.meta) : '';
      return el('tr', { class: r.level === 'error' ? 'log-row-error' : '' },
        el('td', { class: 'muted small nowrap' }, fmtDate(r.ts)),
        el('td', {}, logLevelBadge(r.level)),
        el('td', { class: 'muted small' }, r.source === 'client' ? 'dashboard' : 'server'),
        el('td', {}, el('div', {}, esc(r.msg)), metaStr ? el('div', { class: 'muted small' }, esc(metaStr)) : null));
    }));
    if (!status.textContent) status.textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} shown`;
    else status.textContent += ` · ${rows.length} shown (local only)`;
  }

  levelSel.addEventListener('change', () => { status.textContent = ''; load(); });
  sourceSel.addEventListener('change', () => { status.textContent = ''; load(); });
  qInput.addEventListener('input', () => { status.textContent = ''; load(); });
  refreshBtn.addEventListener('click', () => { status.textContent = ''; load(); });

  root.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Level ', levelSel),
    el('label', { class: 'inline muted' }, 'Source ', sourceSel),
    el('label', { class: 'inline muted' }, 'Search ', qInput),
    refreshBtn, el('span', { class: 'spacer' }), status));
  root.append(host);
  await load();
  return root;
};

views.settings = async () => {
  const root = el('div');
  // Drop admin-only tabs for non-admins, then drop any section left empty.
  const groups = SETTINGS_GROUPS
    .map(([label, tabs]) => [label, tabs.filter(([, , adminOnly]) => isAdmin() || !adminOnly)])
    .filter(([, tabs]) => tabs.length > 0);
  const allKeys = groups.flatMap(([, tabs]) => tabs.map(([k]) => k));
  if (!settingsTab || !allKeys.includes(settingsTab)) settingsTab = allKeys[0];

  const nav = el('div', { class: 'settings-nav' }, ...groups.map(([label, tabs]) =>
    el('div', { class: 'settings-nav-group' },
      el('span', { class: 'settings-nav-label' }, label),
      el('div', { class: 'subtabs' }, ...tabs.map(([k, lbl]) =>
        el('button', { class: `small ghost${k === settingsTab ? ' active' : ''}`, onclick: () => { settingsTab = k; render(); } }, lbl))))));
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Settings')), nav);
  // Per-section licence pill (green = included in this licence, red = not).
  // Needs the feature + plan maps; both are cached, so this is usually instant.
  await Promise.all([loadFeatures(), loadPlan()]);
  root.append(el('div', { class: 'settings-license-row' }, settingsLicensePill(settingsTab)));

  const views2 = {
    users: () => views.users(),
    license: () => views.license(),
    appearance: settingsAppearanceView,
    map: settingsMapView,
    types: settingsTypesView,
    analyse: settingsAnalyseView,
    alerting: settingsAlertingView,
    integrations: settingsIntegrationsView,
    maintenance: settingsMaintenanceView,
    updates: settingsUpdatesView,
    agentkey: settingsAgentKeyView,
    agents: settingsAgentsView,
    retention: settingsRetentionView,
    auth: settingsAuthView,
    apitokens: settingsApiTokensView,
    screening: () => views.screening(),
  };
  let content;
  try {
    content = await (views2[settingsTab] || settingsAnalyseView)();
  } catch (err) {
    content = el('div', { class: 'empty error' }, err.message);
  }
  root.append(content);
  return root;
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
  map: { feature: 'geo', label: 'Destinations / geo' },
};

// The green/red licence pill shown at the top of every Settings section.
function settingsLicensePill(tabKey) {
  const info = SETTINGS_FEATURE[tabKey];
  if (!info) {
    return el('span', { class: 'badge active', title: 'Included in every BlueEye licence — not a gateable feature.' },
      'Licence: included');
  }
  const ok = featureEntitled(info.feature);
  const title = ok ? `${info.label} is included in your licence.` : lockedHint(info.label, info.feature);
  return el('span', { class: `badge ${ok ? 'active' : 'bad'}`, title },
    `Licence: ${info.label} — ${ok ? 'included' : 'not in licence'}`);
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
    bits.push(el('li', {}, el('strong', {}, 'Can sign releases: '), status.canSign ? 'yes' : 'no (verify-only)'));
    root.append(el('ul', {}, ...bits));
    if (status.source === 'managed') {
      root.append(el('div', { class: 'form-actions' }, el('button', { class: 'danger', onclick: () => removeKey() }, 'Delete signing key')));
    } else {
      root.append(el('p', { class: 'muted' }, 'This key comes from the server environment — manage it there.'));
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
  return root;
}

// Settings -> Updates: the server's version and the agent version it serves, plus
// which enrolled agents are behind. Admins can push a one-click update to
// systemd-managed agents from here; checks themselves make no external calls.
async function settingsUpdatesView() {
  const [ver, agents] = await Promise.all([api('/system/version'), api('/agents')]);
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'Version of this server and the agent it ships, plus which enrolled agents are out of date. Checks are local — no external calls.'));

  root.append(el('div', { class: 'cards' },
    stat('Server', ver.server ? `v${ver.server}` : '–'),
    stat('Agent (served)', ver.agent ? `v${ver.agent}` : '–')));

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
            toast(r && r.version ? `Agent source reloaded — now serving v${r.version}.` : 'Agent source reloaded.');
            render();
          } catch (err) { toast(err.message, true); }
        },
      }, 'Reload agent source')));
    root.append(el('p', { class: 'muted' }, 'After pulling a new agent version on the server host, reload to publish it without restarting the server.'));
  }

  const cur = ver.agent || null;
  const withVer = agents.filter((a) => a.capabilities && a.capabilities.agentVersion);
  const behind = withVer.filter((a) => agentIsBehind(a, cur));

  root.append(el('div', { class: 'cards' },
    stat('Agents reporting', `${withVer.length} / ${agents.length}`),
    stat('Up to date', cur ? String(withVer.length - behind.length) : '–'),
    stat('Behind', cur ? String(behind.length) : '–')));

  if (behind.length) {
    root.append(el('h4', {}, 'Agents needing an update'));
    const cols = canDelete() ? ['Agent', 'Installed', 'Current', ''] : ['Agent', 'Installed', 'Current'];
    root.append(el('table', {},
      el('thead', {}, el('tr', {}, ...cols.map((h) => el('th', {}, h)))),
      el('tbody', {}, ...behind.map((a) => el('tr', {},
        el('td', {}, a.display_name || a.hostname),
        el('td', {}, el('span', { class: 'badge warn' }, `v${a.capabilities.agentVersion}`)),
        el('td', {}, el('span', { class: 'badge active' }, `v${cur}`)),
        canDelete() ? el('td', {}, el('div', { class: 'row-actions' },
          el('button', { class: 'small', onclick: () => updateAgent(a, cur) }, 'Update'))) : null,
      )))));
  } else if (cur && withVer.length) {
    root.append(el('p', { class: 'muted' }, 'All reporting agents are on the current version.'));
  }

  root.append(el('h4', {}, 'How to update'));
  root.append(el('ul', {},
    el('li', {}, el('strong', {}, 'Server: '), 'on the server host run ', el('code', {}, './scripts/deploy.sh'), ' (git pull + rebuild).'),
    el('li', {}, el('strong', {}, 'Agents (systemd): '), 'click ', el('strong', {}, 'Update'), ' above (or on the Agents tab) — the server tells the agent to rebuild from the published source and restart.'),
    el('li', {}, el('strong', {}, 'Agents (Docker): '), 're-run the install one-liner from ', el('strong', {}, 'Enrollment'), ' on that host (a container rebuilds on the host, not from here).')));
  return root;
}

async function settingsAnalyseView() {
  const data = await api('/api/settings');
  const root = el('div');
  // The assistant is configurable only when the licence includes it (the PUT is
  // refused server-side otherwise). An unknown licence (null) keeps the card, in
  // line with the "allow until we know it's off" rule used elsewhere.
  const assistantLicensed = !data.license || data.license.assistant !== false;
  root.append(el('p', { class: 'muted settings-intro' }, 'The server learns a normal baseline for each metric and raises a finding when a measurement deviates enough from it. Here you set how sensitive detection is — changes take effect immediately, without restart. The opt-in AI assistant (its on/off switch and API key) is configured here too.'));
  root.append(el('div', { class: 'settings-grid' }, analyseSettingsCard(data.analysis), throughputSettingsCard(data.throughput),
    assistantLicensed ? assistantSettingsCard(data.assistant) : assistantUnlicensedCard(data.license)));
  return root;
}

// Speed-test health thresholds: flag agents on the Overview when their latest
// download/upload falls below a floor (0 = that floor is off). Folded into the
// agent's health verdict like loss/latency. Admin, runtime-editable.
// Settings → Agents: agent-management toggles. Currently the opt-in for the
// server to auto-install a missing diagnostic tool when a probe reports it.
async function settingsAgentsView() {
  const data = await api('/api/settings');
  return el('div', { class: 'settings-grid' }, agentsSettingsCard(data.agents));
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

// ---- Settings → Integrations (ITSM/IPAM outbound connectors) --------------
// Manage outbound API integrations (ServiceNow, Nautobot, generic webhook): push
// BlueEye events (incidents/anomalies, agent enroll/delete) to external systems.
// Backend: src/routes/integrations.js (CRUD + /meta + test-fire). Credentials are
// encrypted at rest (secret box) and never returned. Admin-only.
let integrationsEditing = null; // null = list only · 'new' · <id> being edited

async function settingsIntegrationsView() {
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'Push BlueEye events to your ITSM/IPAM systems — e.g. open a ServiceNow incident when a CRIT finding fires, or sync agents into Nautobot. Credentials are encrypted at rest and never shown again; changes take effect immediately.'));

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
    const tableI = el('input', { type: 'text', value: c.table || 'incident', placeholder: 'incident' });
    rows.push(alertField('Table', tableI, 'ServiceNow table to create records in (default: incident).'));
    gather = () => ({ table: tableI.value.trim() || 'incident' });
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
  }
  return { rows, gather };
}

// Event checkboxes (which BlueEye events the integration reacts to).
function integrationEventFields(allEvents, selected) {
  const chosen = new Set(selected || []);
  const boxes = (allEvents || []).map((ev) => {
    const cb = el('input', { type: 'checkbox' }); cb.checked = chosen.has(ev);
    return { ev, cb };
  });
  const row = el('label', { class: 'set-field' },
    el('span', {}, 'Events'),
    el('div', { class: 'inline-checks' }, ...boxes.map((b) => el('label', { class: 'inline muted small' }, b.cb, el('span', {}, b.ev)))),
    el('span', { class: 'muted small' }, 'Which BlueEye events this integration reacts to.'));
  return { row, gather: () => boxes.filter((b) => b.cb.checked).map((b) => b.ev) };
}

// The create/edit form. `existing` is null for a new integration, else the safe row.
function integrationEditor(meta, existing) {
  const isEdit = !!existing;
  const types = meta.types || [];
  const typeNames = types.map((t) => t.type);
  const connectorFor = (type) => types.find((t) => t.type === type) || { authTypes: ['none'], defaultEvents: [] };

  const typeSel = el('select', {}, ...typeNames.map((t) => el('option', { value: t }, t)));
  typeSel.value = isEdit ? existing.type : (typeNames[0] || '');
  if (isEdit) typeSel.disabled = true;

  const nameI = el('input', { type: 'text', value: isEdit ? existing.name : '', placeholder: 'ServiceNow (prod)' });
  const urlI = el('input', { type: 'text', value: isEdit ? existing.base_url : '', placeholder: 'https://example.service-now.com' });
  const enabledI = el('input', { type: 'checkbox' }); enabledI.checked = isEdit ? !!existing.enabled : true;

  const authWrap = el('div', { class: 'form-grid' });
  const credWrap = el('div', { class: 'form-grid' });
  const cfgWrap = el('div', { class: 'form-grid' });
  const evWrap = el('div', { class: 'form-grid' });
  const err = el('p', { class: 'error' });

  let authSel; let credGather; let cfgGather; let evGather;

  function rebuildCreds() {
    const c = integrationCredFields(authSel.value, typeSel.value, isEdit);
    credGather = c.gather;
    credWrap.replaceChildren(...c.rows);
  }
  function rebuild() {
    const conn = connectorFor(typeSel.value);
    authSel = el('select', {}, ...conn.authTypes.map((a) => el('option', { value: a }, a)));
    authSel.value = isEdit && conn.authTypes.includes(existing.auth_type) ? existing.auth_type : conn.authTypes[0];
    authSel.addEventListener('change', rebuildCreds);
    authWrap.replaceChildren(alertField('Auth type', authSel, 'How BlueEye authenticates to the target API.'));
    rebuildCreds();
    const cfg = integrationConfigFields(typeSel.value, isEdit ? existing.config_json : null);
    cfgGather = cfg.gather;
    cfgWrap.replaceChildren(...cfg.rows);
    const ev = integrationEventFields(meta.events || [], (isEdit && existing.config_json && existing.config_json.events) || conn.defaultEvents || []);
    evGather = ev.gather;
    evWrap.replaceChildren(ev.row);
  }
  typeSel.addEventListener('change', rebuild);
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
      else { body.type = typeSel.value; await api('/api/integrations', { method: 'POST', body }); }
      toast(isEdit ? 'Integration saved' : 'Integration created');
      integrationsEditing = null; render();
    } catch (e) { err.textContent = errText(e); saveBtn.disabled = false; }
  });

  return el('div', { class: 'settings-card' },
    el('h3', {}, isEdit ? `Edit integration: ${existing.name}` : 'Add integration'),
    el('div', { class: 'form-grid' },
      isEdit ? alertField('Type', el('span', { class: 'muted' }, existing.type))
        : alertField('Type', typeSel, 'Connector type (cannot be changed after creation).'),
      alertField('Name', nameI, 'A label for this integration.'),
      alertField('Base URL', urlI, 'https URL of the target API. Private/loopback addresses are rejected.'),
      authWrap, credWrap, cfgWrap, evWrap,
      alertField('Enabled', enabledI, 'When off, events are not dispatched to this target.'),
      err,
      el('div', { class: 'form-actions' }, saveBtn, cancelBtn)));
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
// Connect BlueEye to an LDAP/AD directory so users sign in with their directory
// account and get a role from their group membership. Backend: src/routes/ldap.js
// (config CRUD + connectivity test + login audit) and src/auth/ldap.js (the bind
// + group→role resolution, run from src/routes/auth.js at login). Admin-only and
// licence-gated (sso_ldap, Enterprise) — the server returns licensed:false and
// refuses the writes when the plan doesn't include it.
async function settingsAuthView() {
  const cfgRes = await api('/api/ldap/config');
  const cfg = cfgRes.config || {};
  const licensed = cfgRes.licensed !== false; // server-computed; allow-until-known-off
  const envOn = cfgRes.authEnabledFlag === true;
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' },
    'Let users sign in with their Active Directory / LDAP account. After a successful bind, each user’s BlueEye role is taken from their directory group membership (the highest matching role wins), so access is governed centrally in the directory. Local accounts keep working as a fallback. ',
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
    el('p', { class: 'muted' }, 'Directory login is not included in your licence, so it can’t be configured here. It is part of the BlueEye Enterprise plan — contact your provider to enable it. ',
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

// Group → role mapping: each LDAP/AD group DN maps to a BlueEye role. The change
// select PUTs immediately; add/delete re-render the tab.
function ldapRoleMapCard(roleMap) {
  const card = el('div', { class: 'settings-card wide' }, el('h3', {}, 'Group → role mapping'));
  card.append(el('p', { class: 'muted small' },
    'Map a directory group (by its full DN) to a BlueEye role. A user gets the highest role across all their matched groups; a user in no mapped group is denied access — there is no default role. Roles: viewer < operator < admin.'));
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
        el('td', {}, esc(r.username || '–')),
        el('td', {}, r.ok ? el('span', { class: 'badge ok' }, 'ok') : el('span', { class: 'badge bad' }, esc(r.reason || 'failed'))),
        el('td', {}, esc(r.granted_role || '–')),
        el('td', { class: 'muted' }, String(r.groups_matched ?? 0)),
        el('td', { class: 'muted' }, esc(r.source_ip || '–'))))))));
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
        el('td', {}, esc(w.name)),
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
      body[f.key] = f.type === 'checkbox' ? inputs[f.key].checked : Number(inputs[f.key].value);
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
    if (err.status === 403) return featureUpsell('API access', 'Programmatic API tokens are part of the BlueEye Professional plan and above, so they can’t be managed here.');
    throw err;
  }

  root.append(el('p', { class: 'muted settings-intro' },
    'Issue tokens for programmatic access to the BlueEye API (CI jobs, scripts, integrations). A token authenticates with a fixed role and is sent as ',
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
      s && s.source ? el('span', { class: 'muted' }, ` · source: ${esc(s.source)}`) : null,
      s && s.error ? el('span', { class: 'warn-text' }, ` · ${esc(s.error)}`) : null);
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
  const users = await api('/users');
  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Users'),
    el('button', { class: 'small', onclick: () => editUser() }, '+ New user')));
  root.append(el('p', { class: 'muted' }, 'Roles: viewer (read), operator (create/edit), admin (all). Only admins see this tab.'));
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Email', 'Role', 'Created', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...users.map((u) => el('tr', {},
      el('td', {}, String(u.id)),
      el('td', {}, u.email),
      el('td', {}, el('span', { class: 'badge' }, u.role),
        u.protected ? el('span', { class: 'badge', title: 'Superadmin — cannot be changed/deleted, password only', style: 'margin-left:6px' }, 'superadmin') : null),
      el('td', { class: 'muted' }, fmtDate(u.created_at)),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'small ghost', onclick: () => editUser(u) }, u.protected ? 'Change password' : 'Edit'),
        u.protected ? null : el('button', { class: 'small danger', onclick: () => deleteUser(u) }, 'Delete'))),
    )))));
  return root;
};

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
      { name: 'role', label: 'Role', type: 'select', value: u.role, options: ROLE_OPTIONS },
      { name: 'password', label: 'New password (optional — leave blank to keep)', type: 'password-strength', optional: true, value: '' },
    ], async (v) => {
      const body = { email: v.email, role: v.role };
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
      { name: 'password', label: 'Password', type: 'password-strength', value: '' },
      { name: 'role', label: 'Role', type: 'select', value: 'viewer', options: ROLE_OPTIONS },
    ], async (v) => {
      if (!evaluatePassword(v.password).meetsPolicy) throw new Error('Password does not meet the requirements below');
      await api('/users', { method: 'POST', body: { email: v.email, password: v.password, role: v.role } });
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
    plan ? stat('Plan', `BlueEye ${plan.plan_name}`) : stat('Max. agents', String(s.maxAgents)),
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
      stat('Plan', `BlueEye ${plan.plan_name}${plan.is_trial ? ' (trial)' : ''}`),
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
function connectLive() {
  if (!token) return;
  if (liveWs && (liveWs.readyState === WebSocket.OPEN || liveWs.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let sock;
  try { sock = new WebSocket(`${proto}://${location.host}/ws/dashboard?token=${encodeURIComponent(token)}`); }
  catch { return; }
  liveWs = sock;
  sock.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;
    if (msg.type === 'finding') onLiveFinding(msg.payload);
    else if (msg.type === 'agent-enrolled') onAgentEvent('enrolled', msg.payload);
    else if (msg.type === 'agent-status') onAgentEvent(msg.payload && msg.payload.status, msg.payload);
  });
  sock.addEventListener('close', () => {
    liveWs = null;
    if (token && !liveReconnect) liveReconnect = setTimeout(() => { liveReconnect = null; connectLive(); }, 4000);
  });
  sock.addEventListener('error', () => { try { sock.close(); } catch { /* ignore */ } });
}
function disconnectLive() {
  if (liveReconnect) { clearTimeout(liveReconnect); liveReconnect = null; }
  if (liveWs) { try { liveWs.close(); } catch { /* ignore */ } liveWs = null; }
}
// Live agent enrollment / online-status events. Surfaces a toast, and (when the
// enrollment wizard is showing a fresh code) flips its "Waiting for agent…" panel.
function onAgentEvent(kind, payload) {
  if (kind === 'enrolled') toast(`New agent connected${payload && payload.hostname ? ': ' + payload.hostname : ''}`);
  if (currentView === 'enrollment' && typeof enrollWatch === 'function') enrollWatch(kind, payload);
}

function onLiveFinding(f) {
  if (!f) return;
  const sev = f.severity || 'INFO';
  toast(`New finding: ${f.metric} ${sev}`, sev === 'CRIT' || sev === 'WARN');
  // Live-prepend only when the findings table is actually on screen and the
  // active host filter matches; otherwise the REST list will show it next time.
  if (currentView === 'findings' && findingsState.tbody && findingsState.tbody.isConnected) {
    if (!findingsState.hostId || String(f.hostId) === String(findingsState.hostId)) {
      const name = findingsState.agentName || ((id) => `host ${id}`);
      findingsState.tbody.prepend(findingRow(name, f));
    }
  }
}

// ---- NIS2 Reporting Center ------------------------------------------------
// A self-contained compliance module: readiness dashboard, risk register,
// control evidence, security incidents, generated management reports and an
// audit trail. Talks to /api/nis2/*; PDF export opens the server's print-ready
// HTML in a new window (authed fetch → window.print), CSV downloads as a file.

const NIS2_CATEGORIES = [
  'Governance', 'Risk Management', 'Incident Response', 'Backup/Recovery', 'Access Control',
  'Supplier Management', 'Network Security', 'Logging/Monitoring', 'Vulnerability Management', 'Documentation',
];
const NIS2_RISK_STATUS = ['open', 'mitigating', 'accepted', 'closed'];
const NIS2_CONTROL_STATUS = ['OK', 'Partial', 'Missing', 'Overdue'];
const NIS2_FREQ = ['daily', 'weekly', 'monthly', 'quarterly', 'annually', 'ad-hoc'];
const NIS2_SEVERITY = ['low', 'medium', 'high', 'critical'];
const NIS2_INCIDENT_STATUS = ['open', 'investigating', 'contained', 'resolved', 'closed'];

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
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) { toast(`Export failed: ${err.message}`, true); }
}

// Authenticated print: fetch the server's print-ready HTML and open it in a new
// window for the browser's "Save as PDF". The document carries its own print CSS.
async function nis2Print(path) {
  try {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const w = window.open('', '_blank');
    if (!w) { toast('Pop-up blocked — allow pop-ups to export PDF', true); return; }
    w.document.open(); w.document.write(html); w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 400);
  } catch (err) { toast(`Export failed: ${err.message}`, true); }
}

// Top-level Reporting view: NIS2 (a stationary page with fixed parameters) and
// the Report Generator (a flexible, selector-driven custom report builder).
views.reporting = async () => {
  const root = el('div', { class: 'nis2' });
  const sections = [['nis2', 'NIS2'], ['generator', 'Report Generator']];
  // Audit is RBAC-gated: only admins may see who did what on the server.
  if (role === 'admin') sections.push(['audit', 'Audit']);
  // Guard against a stale section the current user may no longer access.
  if (!sections.some(([k]) => k === reportingState.section)) reportingState.section = 'nis2';
  const bar = el('div', { class: 'subtabs nis2-subtabs' },
    ...sections.map(([key, label]) => el('button', {
      class: `small ghost${reportingState.section === key ? ' active' : ''}`,
      onclick: () => { reportingState.section = key; render(); },
    }, label)));
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Reporting'), bar));

  const body = el('div', { class: 'nis2-body' }, el('div', { class: 'empty' }, 'Loading…'));
  root.append(body);
  try {
    body.replaceChildren(
      reportingState.section === 'generator' ? await reportGenerator()
        : reportingState.section === 'audit' ? await auditModule()
          : await nis2Module());
  } catch (err) { body.replaceChildren(el('div', { class: 'empty error' }, err.message)); }
  return root;
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
  wrap.append(el('div', { class: 'subtabs nis2-subtabs nis2-inner-tabs' },
    ...tabs.map(([key, label]) => el('button', {
      class: `small ghost${nis2State.tab === key ? ' active' : ''}`,
      onclick: () => { nis2State.tab = key; render(); },
    }, label))));

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
  if (!d.totals.risks && !d.totals.controls && !d.totals.incidents) {
    wrap.append(nis2GetStarted());
  }

  // Readiness hero + KPI cards.
  const readinessClass = d.readinessScore >= 80 ? 'ok' : d.readinessScore >= 50 ? 'warn' : 'crit';
  wrap.append(el('div', { class: 'nis2-readiness' },
    el('div', { class: 'nis2-gauge' },
      el('div', { class: `nis2-gauge-v ${readinessClass}` }, `${d.readinessScore}%`),
      el('div', { class: 'nis2-gauge-bar' }, el('span', { class: readinessClass, style: `width:${d.readinessScore}%` }))),
    el('div', { class: 'nis2-gauge-label' }, el('strong', {}, 'NIS2 readiness'),
      el('div', { class: 'muted' }, `${d.totals.controls} controls · ${d.totals.risks} risks · ${d.totals.incidents} incidents`))));

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
    kpi('Incidents (30 days)', d.incidentsLast30Days, '',
      'Security incidents detected in the last 30 days. Any flagged “notification required” carry a reporting duty to the authority within the NIS2 (Art. 23) deadlines.'),
    kpi('Controls without evidence', d.controlsWithoutEvidence, d.controlsWithoutEvidence ? 'warn-text' : '',
      'Controls with no evidence reference on file (or marked Missing/Overdue). Evidence is what an auditor asks for — these are what pull the readiness score down.')));

  // Category status grid.
  wrap.append(el('h3', { class: 'nis2-h3' }, 'Status by category'));
  wrap.append(el('div', { class: 'nis2-cats' }, ...d.categories.map((c) => el('div', { class: 'nis2-cat' },
    el('div', { class: 'nis2-cat-top' }, el('span', {}, c.category), nbadge(c.status, NIS2_CATSTATUS_CLASS[c.status])),
    el('div', { class: 'nis2-gauge-bar sm' }, el('span', { class: NIS2_CATSTATUS_CLASS[c.status], style: `width:${c.score}%` })),
    el('div', { class: 'muted nis2-cat-sub' }, `${c.controlCount} control(s) · ${c.score}%`)))));

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

// ---- NIS2: Incidents -------------------------------------------------------
function nis2IncidentFields(i) {
  i = i || {};
  const dt = (v) => (v ? new Date(v).toISOString().slice(0, 16) : '');
  return [
    { name: 'title', label: 'Title', value: i.title, hint: 'Short description of the incident.' },
    selField('severity', 'Severity', NIS2_SEVERITY, i.severity || 'medium', 'Your impact assessment, low → critical. High/critical incidents surface in the Executive report.'),
    selField('status', 'Status', NIS2_INCIDENT_STATUS, i.status || 'open', 'Where the incident is in its lifecycle: open → investigating → contained → resolved → closed.'),
    { name: 'detectedAt', label: 'Detected at', type: 'datetime-local', value: dt(i.detectedAt), hint: 'When you became aware of it — the moment the NIS2 (Art. 23) reporting deadlines start counting from.' },
    { name: 'startedAt', label: 'Started at', type: 'datetime-local', value: dt(i.startedAt), hint: 'When the incident actually began, if known (may precede detection).' },
    { name: 'resolvedAt', label: 'Resolved at', type: 'datetime-local', value: dt(i.resolvedAt), hint: 'When normal service was restored.' },
    selField('nis2Relevant', 'NIS2 relevant', yesNo(), String(!!i.nis2Relevant), 'Yes if the incident falls within the scope of the NIS2 directive for your organisation.'),
    selField('notificationRequired', 'Notification required', yesNo(), String(!!i.notificationRequired), 'Yes if the incident is “significant” and must be reported to the authority/CSIRT. This is the duty that starts the 24-hour early warning / 72-hour notification / one-month final-report clock under NIS2 (Art. 23).'),
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
    'Your log of significant security incidents — what happened, when it was detected, the systems and business affected, the root cause and the actions taken. These are incidents you record by hand, distinct from the network incidents derived automatically from probes.',
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
  ['risk', 'Risk Register Report'], ['control', 'Control Evidence Report'], ['incident', 'Incident Report'],
];
async function nis2Reports() {
  const reports = await api('/api/nis2/reports');
  const wrap = el('div');
  wrap.append(el('div', { class: 'section-head' },
    el('h3', { class: 'nis2-h3' }, 'Management reports'),
    el('span', { style: 'flex:1' }),
    canWrite() ? el('button', { class: 'small', onclick: () => nis2GenerateReport() }, '+ Generate report') : null));

  wrap.append(nis2Explain(
    'Point-in-time management reports — Executive, Readiness, Risk, Control or Incident — built from the current data and viewable as a print-ready PDF for the board or the authority.',
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
  const map = { executive: 'executive', readiness: 'readiness', risk: 'risk', control: 'control', incident: 'incident' };
  nis2Print(`/api/nis2/export/${map[type] || 'executive'}.html`);
}
function nis2GenerateReport() {
  nis2Modal('Generate report', [
    selField('reportType', 'Report type', NIS2_REPORT_TYPES.map((t) => ({ value: t[0], label: t[1] })), 'executive',
      'Executive = board summary + trend · Readiness = the scorecard · Risk / Control / Incident = the full register for that area.'),
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
  wrap.append(el('div', { class: 'subtabs', style: 'gap:8px;align-items:center' },
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
      if (err.status === 403) { body.replaceChildren(featureUpsell('Audit trail', 'The audit trail is part of the BlueEye Professional plan and above, so it isn\'t available here.')); return; }
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
      step(3, 'Log security incidents', 'Record incidents and flag the ones that may carry a NIS2 notification obligation.',
        canWrite() ? el('button', { class: 'small', onclick: goto('incidents') }, 'Go to Incidents') : null),
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
  const { sources } = await api('/api/nis2/custom-reports/sources');
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
      const report = await api('/api/nis2/custom-reports/preview', { method: 'POST', body: spec });
      preview.replaceChildren(renderRgPreview(report));
    } catch (err) { preview.replaceChildren(el('div', { class: 'empty error' }, errText(err))); }
  }

  async function doExport() {
    const spec = buildSpec();
    if (!spec.sections.length) { toast('Select at least one section', true); return; }
    try {
      const res = await fetch('/api/nis2/custom-reports/export', {
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
    el('p', {}, 'A stationary module with fixed parameters: a readiness dashboard, risk register, control evidence, security incidents, generated management/executive reports and an audit trail.'),
    el('h4', {}, 'Report Generator'),
    el('p', {}, 'Build your own report from selectable sections (readiness summary, category status, risks, controls, incidents, and — for admins — the audit trail). Set per-section filters and choose the columns, then preview on screen or export as PDF, CSV or JSON.'),
    el('h4', {}, 'Inside NIS2 — Dashboard'),
    el('p', {}, 'A single readiness percentage (the mean of the ten category scores, each derived from its controls’ evidence health), plus headline counts and the top recommended actions.'),
    el('h4', {}, 'Risk register'),
    el('p', {}, 'Your inventory of cyber risks to the systems in scope, each scored likelihood × impact (1–25) and banded Low/Medium/High/Critical, with an owner and treatment status. NIS2 (Article 21) requires risk-based security measures — this register is the evidence that risks are identified, assessed and being treated. Export to CSV or PDF.'),
    el('h4', {}, 'Controls'),
    el('p', {}, 'The recurring technical and organisational security measures you operate (backups, patching, access reviews, logging…), each tied to a NIS2 area with an owner, a cadence and an evidence reference. NIS2 (Article 21) requires these measures to be kept effective; the evidence is what an auditor asks for, so controls lacking it — or marked Missing/Overdue — are flagged.'),
    el('h4', {}, 'Incidents'),
    el('p', {}, 'Security incidents you record by hand (distinct from the network incidents derived automatically from probes), with timeline, impact and root cause. Flag “notification required” for a significant incident — NIS2 (Article 23) then obliges you to alert the national CSIRT/authority within 24 hours, file a full notification within 72 hours and a final report within one month.'),
    el('h4', {}, 'Reports & audit'),
    el('p', {}, 'Generate snapshot reports (the frozen metrics let the next report show the trend). Reports are approved by an admin/compliance role. Every change to a risk, control or incident is written to the audit trail.'),
    el('p', { class: 'muted' }, 'PDF export opens a clean, print-ready document — use your browser’s “Save as PDF”.'),
    el('h4', {}, 'Audit (admin only)'),
    el('p', {}, 'A server-wide audit trail: which user did what (login, and every create/update/delete) and what each agent performed (traffic measurements, probes) — each with when, who and what. Repeated activity such as continuous reporting or scheduled probes is recorded once and annotated “Repeats every …” rather than spamming the log. Visible only to administrators; exportable to CSV.'),
  ],
};

PAGE_INFO.logs = {
  hero: 'Logs — the live server diagnostic stream (agent connects, WebSocket/DB errors, HTTP failures) merged with the dashboard errors you were shown. In-memory: cleared when the server restarts.',
  title: 'Logs — operational diagnostics',
  body: () => [
    el('p', {}, 'This is the operational/diagnostic stream — the same lines the server writes to its console (', el('code', {}, 'docker compose logs'), ') — kept in an in-memory ring buffer (the most recent ~1000 records) so you can read them here without shell access. It is merged with client-side failures: any error a dashboard action showed you (e.g. “Agent not connected”) is captured here too, so a toast that flashed past can still be found.'),
    el('p', {}, el('strong', {}, 'This is not the audit trail. '), 'For the durable “who did what” security record (logins, create/update/delete), see ', viewLink('reporting', 'Reporting → Audit'), '. Logs here are ephemeral and reset on restart.'),
    el('h4', {}, 'Filters'),
    el('ul', {},
      el('li', {}, el('strong', {}, 'Level '), '— show a minimum severity (Errors only, Warn+, …).'),
      el('li', {}, el('strong', {}, 'Source '), '— Server (the diagnostic stream) or Dashboard (browser-side action failures).'),
      el('li', {}, el('strong', {}, 'Search '), '— free-text match over the message and its structured detail.')),
    el('p', { class: 'muted' }, 'Admin-only: operational logs can contain internal detail (hostnames, error messages, request ids).'),
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
views.transactions = async () => {
  const root = el('div', { class: 'transactions' });
  const body = el('div', {});
  const tabs = el('div', { class: 'subtabs' }, ...[['list', 'List'], ['matrix', 'Matrix']].map(([k, label]) =>
    el('button', { class: `subtab${txTab === k ? ' active' : ''}`, onclick: () => { txTab = k; draw(); } }, label)));
  const head = el('div', { class: 'section-head' }, el('h2', {}, 'Transaction tests'),
    isAdmin() ? el('button', { class: 'primary', onclick: () => txMount(body, () => txForm(null, body)) }, '+ New test') : null);
  function draw() {
    tabs.querySelectorAll('.subtab').forEach((b, i) => b.classList.toggle('active', ['list', 'matrix'][i] === txTab));
    if (txTab === 'matrix') txMount(body, () => txMatrixView(body));
    else txMount(body, () => txListView(body));
  }
  root.append(head, tabs, body);
  draw();
  return root;
};

async function txListView(host) {
  const tests = await api('/api/transactions');
  if (!tests.length) return el('div', { class: 'empty' }, 'No transaction tests yet. A transaction test runs http/tcp/dns/icmp from assigned agents on an interval.');
  const rows = tests.map((t) => el('tr', { class: 'clickable', onclick: () => txMount(host, () => txDetailView(t.id, host)) },
    el('td', {}, t.name),
    el('td', {}, el('span', { class: 'chip' }, t.type)),
    el('td', {}, t.target || '—'),
    el('td', {}, String((t.agent_ids || []).length)),
    el('td', {}, `${t.interval_sec}s`),
    el('td', {}, t.enabled ? 'Active' : 'Disabled'),
    el('td', {}, isAdmin() ? el('span', {},
      el('button', { class: 'ghost small', onclick: (e) => { e.stopPropagation(); txMount(host, () => txForm(t, host)); } }, 'Edit'),
      el('button', { class: 'ghost small danger', onclick: (e) => { e.stopPropagation(); txDelete(t, host); } }, 'Delete')) : null)));
  return el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, ...['Name', 'Type', 'Target', 'Agents', 'Interval', 'Status', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows));
}

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
      el('div', { class: 'tx-step-line' }, methodSel, nameI, urlI, el('button', { type: 'button', class: 'ghost small danger', onclick: () => { row.remove(); } }, '×')),
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
    const r = el('div', { class: 'tx-secret-row' }, nI, vI, el('button', { type: 'button', class: 'ghost small danger', onclick: () => r.remove() }, '×'));
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

let currentView = 'fleet';
const modalOpen = () => !$('#modal').classList.contains('hidden');

// One-time per session: stamp the sidebar foot with this server's build —
// "BlueEye server · v<version> · <release date>" — from /system/version.
let footStamped = false;
async function stampFooter() {
  if (footStamped) return;
  footStamped = true;
  const foot = $('#sidebar-foot');
  if (!foot) return;
  try {
    const ver = await api('/system/version');
    const parts = ['BlueEye server'];
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
    $('#app').classList.add('hidden');
    focusLoginField();
    return;
  }
  $('#login').classList.add('hidden');
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
  stampFooter(); // sidebar foot: BlueEye server · version · release date
  // Admin-only, once per session: nudge to set the agent signing key if it's missing.
  maybePromptSigningKey();

  // Stop the overview poller when leaving that view (it restarts itself when shown).
  if (currentView !== 'overview') stopOverview();
  if (currentView !== 'probes') stopProbes();
  if (currentView !== 'interfaces') stopIfaces();
  if (currentView !== 'fleet') stopFleet();
  if (currentView !== 'agent') stopAgent();
  // Tear down the Leaflet maps when leaving their views (they rebuild on entry).
  if (currentView !== 'geo') stopGeo();
  if (currentView !== 'map') stopMap();
  if (currentView !== 'topology') stopTopoMap();

  // Admin-only tabs (e.g. Users); send non-admins back to agents if needed.
  for (const b of document.querySelectorAll('.tabs button[data-admin]')) {
    b.classList.toggle('hidden', role !== 'admin');
  }
  if (currentView === 'users' && role !== 'admin') currentView = 'overview';
  for (const b of document.querySelectorAll('.tabs button[data-view]')) b.classList.toggle('active', b.dataset.view === currentView);

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

// Federated sign-in buttons on the login screen. Asks the server which SSO
// methods are live (GET /auth/sso) and shows a button per method; each is just a
// link to the provider-initiated flow. Local login always stays as the fallback.
async function renderSsoOptions() {
  const host = $('#sso-options');
  if (!host) return;
  if (ssoLoginError) $('#login-error').textContent = `Single sign-on failed: ${ssoLoginError}`;
  let sso = null;
  try { sso = await (await fetch('/auth/sso')).json(); } catch { sso = null; }
  const methods = [];
  if (sso && sso.oidc && sso.oidc.enabled) methods.push({ label: 'Sign in with SSO (OIDC)', url: sso.oidc.loginUrl });
  if (sso && sso.saml && sso.saml.enabled) methods.push({ label: 'Sign in with SSO (SAML)', url: sso.saml.loginUrl });
  if (!methods.length) { host.classList.add('hidden'); return; }
  host.replaceChildren(
    el('div', { class: 'sso-divider' }, el('span', {}, 'or')),
    ...methods.map((m) => el('a', { class: 'sso-button', href: m.url }, m.label)));
  host.classList.remove('hidden');
}
renderSsoOptions();
$('#logout').addEventListener('click', () => { setAutoRefresh(false); stopOverview(); stopFleet(); stopAgent(); stopProbes(); stopIfaces(); stopMap(); stopGeo(); stopTopoMap(); $('#autorefresh').checked = false; logout(); });
$('#refresh').addEventListener('click', () => render());
$('#autorefresh').addEventListener('change', (e) => setAutoRefresh(e.target.checked));
function closeNav() { $('#app').classList.remove('nav-open'); }
for (const b of document.querySelectorAll('.tabs button[data-view]')) {
  b.addEventListener('click', () => {
    closeDrawer(); closeNav();
    // Locked (licence-excluded) items don't open — they nudge to the licence page.
    if (b.classList.contains('locked')) {
      toast(`${lockedHint((b.textContent || 'This module').trim(), b.dataset.feature)} — see License.`);
      settingsTab = 'license'; currentView = 'settings'; render();
      return;
    }
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
{
  const sq = $('#search-q');
  if (sq) sq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); globalSearch(sq.value); sq.blur(); } });
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
installModalA11y(); // focus management + trap + Escape for every modal flow

render();
