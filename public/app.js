'use strict';

// BlueEye server dashboard — dependency-free vanilla JS over the JSON API.
const TOKEN_KEY = 'blueeye.server.token';
const ROLE_KEY = 'blueeye.server.role';
const EMAIL_KEY = 'blueeye.server.email';
const THEME_KEY = 'blueeye.server.theme';

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
  const t = THEME_KEYS.includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = t;
  const btn = document.querySelector('#theme');
  if (btn) {
    const isDark = themeMeta(t).family === 'dark';
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  }
}
function cachedTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; }
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
  const t = THEME_KEYS.includes(theme) ? theme : 'light';
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

let token = localStorage.getItem(TOKEN_KEY);
let role = localStorage.getItem(ROLE_KEY) || 'viewer';
let email = localStorage.getItem(EMAIL_KEY) || '';
const canWrite = () => role === 'operator' || role === 'admin';
const canDelete = () => role === 'admin';

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
function invalidateFeatures() { licenseFeatures = null; featuresLoadedAt = 0; }
async function loadFeatures() {
  if (licenseFeatures && Date.now() - featuresLoadedAt < FEATURES_TTL_MS) return licenseFeatures;
  try { licenseFeatures = await api('/license/features'); featuresLoadedAt = Date.now(); }
  catch { if (!licenseFeatures) licenseFeatures = {}; }
  return licenseFeatures;
}
function applyFeatureVisibility() {
  const feats = licenseFeatures || {};
  for (const b of document.querySelectorAll('.tabs button[data-feature]')) {
    const allowed = feats[b.dataset.feature] !== false; // show until we know it's off
    b.classList.toggle('hidden', !allowed);
    if (!allowed && currentView === b.dataset.view) currentView = 'overview';
  }
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
    // Skip if the user already chose a theme this session (e.g. toggled while
    // this request was in flight) — their deliberate choice must win.
    if (!themeUserChoice && theme && THEME_KEYS.includes(theme)) {
      applyTheme(theme);
      try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage off */ }
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
  render();
}

// ---- Modal ----------------------------------------------------------------
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
    } else {
      input = el('input', { type: f.type || 'text', value: f.value ?? '' });
    }
    inputs[f.name] = input;
    form.append(el('label', {}, f.label, input));
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
    catch (err) { errP.textContent = err.message; }
  });
  card.replaceChildren(el('h3', {}, title), form);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').classList.remove('wide'); }

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
  findings: 'Analysis', locations: 'Locations', enrollment: 'Enrollment', settings: 'Settings',
};
function gotoView(viewKey) { closeDrawer(); currentView = viewKey; render(); }
function viewLink(viewKey, label) {
  const text = label || VIEW_LABELS[viewKey] || viewKey;
  const tab = document.querySelector(`.tabs button[data-view="${viewKey}"]`);
  if (tab && tab.classList.contains('hidden')) return document.createTextNode(text);
  return el('a', { href: '#', class: 'drawer-link', onclick: (e) => { e.preventDefault(); gotoView(viewKey); } }, text);
}
// Deep-link into a specific Settings sub-tab (Analysis, Retention, Traffic types…).
function settingsLink(tab, label) {
  return el('a', { href: '#', class: 'drawer-link',
    onclick: (e) => { e.preventDefault(); closeDrawer(); settingsTab = tab; currentView = 'settings'; render(); } }, label);
}

const PAGE_INFO = {
  tests: {
    hero: 'Reusable test packages — sets of probe/traffic tests the server pushes to chosen agents to run, on a schedule or on demand.',
    title: 'Tests — packages pushed to agents',
    body: () => [
      el('p', {}, 'A test package is a named set of tests (ping / TCP / DNS / traceroute / throughput) with a target selector and an optional schedule. The server pushes the tests to the selected, connected agents; each agent runs them and reports back — results appear on the ', viewLink('probes'), ' and ', viewLink('overview', 'Traffic'), ' pages as usual.'),
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
        el('li', {}, el('strong', {}, 'STALE: '), 'no fresh measurements (> 15 min).'),
        el('li', {}, el('strong', {}, 'UNKNOWN: '), 'agent has not run any probe yet.')),
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
        el('li', {}, el('strong', {}, 'Health stamp '), '(HEALTHY / WARNING / CRITICAL / DOWN / STALE) — the worst of reachability, loss, latency, jitter and interface/link state. The line beside it is the single reason that drove it (e.g. “Link down (eth0)”).'),
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
        el('li', {}, '”↔ Expand” stretches the chart to full width and height; click again for normal size.')),
      el('h4', {}, 'Inspect a time window'),
      el('p', {}, 'Drag across the chart to mark a window — the panel on the right shows average/min/max for the marked series. “Show stored data →” fetches the actual stored measurements for the window (in History). Right-click clears the selection.'),
      el('h4', {}, 'Rest of the page'),
      el('ul', {},
        el('li', {}, 'KPI strip at the top: current RX/TX, online agents and number of locations.'),
        el('li', {}, 'The storage line shows disk usage + estimated consumption per day (“Details” expands the DB/disk breakdown).'),
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
        el('li', {}, 'Status: online/offline based on the WebSocket connection.'),
        el('li', {}, 'Health: “healthy” = online and reported within 5 min., “delayed” = online but stale report, “down” = offline.'),
        el('li', {}, 'Last reported: the time of the agent\'s most recent traffic measurement.')),
      el('h4', {}, 'Actions'),
      el('ul', {},
        el('li', {}, '”+ New agent” issues a one-time code for installation (operator+) — or use ', viewLink('enrollment'), ' for a ready-to-run one-liner.'),
        el('li', {}, '”Run test” asks the agent to measure immediately; “Traffic” shows the measurements.'),
        el('li', {}, '”Edit” sets name, location, notes and traffic source (proc, SNMP, NetFlow or sFlow).')),
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
  probes: {
    hero: 'Active reachability from an agent: ping, TCP-connect, DNS and traceroute — with RTT, loss and path.',
    title: 'Probes',
    body: () => [
      el('p', {}, 'While the other pages measure traffic passively, probes run an active test from a selected agent against a target, so you can answer “can site A reach host B — and how quickly?”.'),
      el('h4', {}, 'Types'),
      el('ul', {},
        el('li', {}, 'Ping (ICMP): RTT min/avg/max + packet loss + jitter.'),
        el('li', {}, 'TCP-connect: opens host:port and measures connection time (no payload sent).'),
        el('li', {}, 'DNS: time to resolve a name (and which address was returned).'),
        el('li', {}, 'Traceroute: the path (hops) to the target with RTT per hop.')),
      el('p', {}, 'Select agent + type + target and click “Run probe”. The agent must be connected; the result comes back a moment later and is added to the history so you can see RTT/loss over time.'),
      el('p', { class: 'muted' }, 'To run the same probes on a schedule across many agents, use ', viewLink('tests'), '; probe results also drive the health verdict on ', viewLink('fleet', 'Overview'), '. Metadata only: targets and timings — never packet contents.'),
    ],
  },
  flows: {
    hero: 'Inspect specific conversations (flows): who talks to whom, on which ports — and who is scanning.',
    title: 'Flows — conversations',
    body: () => [
      el('p', {}, 'While ', viewLink('overview', 'Traffic'), ' shows volumes and the ', viewLink('geo', 'Destinations'), ' map shows where it goes, Flows lets you drill into individual conversations (5-tuple metadata from NetFlow/sFlow) for one agent.'),
      el('h4', {}, 'Filters'),
      el('ul', {},
        el('li', {}, 'Peer: show only conversations where a specific IP is source or destination (click a talker to set it).'),
        el('li', {}, 'Port / Proto: narrow down to e.g. 443 or tcp/udp.'),
        el('li', {}, 'Direction + scope: in/out, and internal (LAN↔LAN) vs. external.')),
      el('h4', {}, 'What you see'),
      el('ul', {},
        el('li', {}, 'Top talkers: the largest conversations (source→destination) by bytes.'),
        el('li', {}, 'Top ports / protocols + a bytes-over-time chart for the window.'),
        el('li', {}, 'Scans / fan-out: sources hitting many different ports (port scan) or many hosts (fan-out) — a quick indicator of scanning or a runaway client.')),
      el('p', { class: 'muted' }, 'Metadata only (5-tuple + bytes/flows), never packet contents. Internal RFC1918 addresses are shown (they are never geolocated). Requires a NetFlow/sFlow source + the geo pipeline being active.'),
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
      el('p', {}, 'If enabled (opt-in) you can ask in natural language — the assistant replies based on the latest findings, not raw data. Turn it on and pick the model under ', settingsLink('analyse', 'Settings → Analysis'), '.'),
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
      el('p', { class: 'muted' }, 'The agent is built + run on the target (Docker or Node) — no pre-built binaries. Also works on air-gapped networks: the source is served from the BlueEye server itself.'),
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
        el('li', {}, settingsLink('retention', 'Retention'), ': how long raw/aggregated data and findings are kept before being cleaned up.'),
        el('li', {}, settingsLink('types', 'Traffic types'), ': define the categories (DNS, Facebook …) from service ports and destination ASN. Shown on ', viewLink('overview', 'Traffic'), ' → Traffic type.'),
        el('li', {}, settingsLink('map', 'Map'), ': tile and geocoder source for the maps (use an EU/self-hosted source in production).')),
      el('h4', {}, 'Read-only (set in .env / requires restart)'),
      el('ul', {},
        el('li', {}, settingsLink('alerting', 'Alerting'), ': channels (e-mail/webhook/syslog) — carries secrets (SMTP password, webhook HMAC), so they are kept in .env.'),
        el('li', {}, settingsLink('users', 'Users'), ': create/edit staff and roles (admin only).'),
        el('li', {}, settingsLink('license', 'License'), ': status + “Revalidate now”.')),
      el('p', { class: 'muted' }, 'Editable changes are stored in app_settings and are reloaded on startup, so they survive a restart.'),
    ],
  },
};

function hero(viewKey) {
  const info = PAGE_INFO[viewKey];
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
    ? el('th', { class: 'sortable', onclick: () => sortBy(c.key) })
    : el('th', {}, c.label)));
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
    });
    countLabel.textContent = filter ? `${list.length} of ${agents.length}` : `${agents.length} total`;
  }

  update();
  return root;
};

// One agent table row (extracted so the agents view can re-render on filter/sort).
function agentRow(a, currentAgentVersion) {
  return el('tr', {},
    el('td', {}, String(a.id)),
    el('td', {}, el('div', {}, a.display_name || a.hostname), a.display_name ? el('div', { class: 'muted' }, a.hostname) : null),
    el('td', {}, `${a.platform} / ${a.arch}`, agentVersionLine(a, currentAgentVersion)),
    el('td', {}, el('span', { class: `badge ${a.status}` }, a.status)),
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
      el('button', { class: 'small ghost', onclick: () => showSpeedtest(a), title: 'Active download/upload speed test to the server' }, 'Speed'),
      canWrite() ? el('button', { class: 'small', onclick: () => runTest(a) }, 'Run test') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => editAgent(a) }, 'Edit') : null,
      (canDelete() && agentIsBehind(a, currentAgentVersion))
        ? el('button', { class: 'small', onclick: () => updateAgent(a, currentAgentVersion), title: 'Rebuild this agent from the server source and restart it' }, 'Update')
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

// Asks a systemd-managed agent to rebuild from the server's source and restart.
// Docker/unmanaged agents decline (their host rebuilds them) — surface why.
async function updateAgent(a, target) {
  const name = a.display_name || a.hostname;
  if (!confirm(`Update ${name} to v${target || '?'}?\n\nThe agent will rebuild from the server's source bundle and restart, briefly interrupting monitoring on that host.`)) return;
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

views.tests = async () => {
  const [packages, agents, locations] = await Promise.all([
    api('/api/test-packages'),
    api('/agents').catch(() => []),
    api('/locations').catch(() => []),
  ]);
  const root = el('div');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Tests'),
    el('span', { class: 'muted' }, `${packages.length} package${packages.length === 1 ? '' : 's'}`),
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
    setTimeout(() => { if (currentView === 'tests') render(); }, 1500);
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
    const typeSel = el('select', {}, ...[['ping', 'Ping'], ['tcp', 'TCP'], ['dns', 'DNS'], ['traceroute', 'Traceroute'], ['run-test', 'Throughput'], ['speedtest', 'Speed test']].map(([v, l]) => el('option', { value: v }, l)));
    const host = el('input', { type: 'text', placeholder: 'host / target' });
    const port = el('input', { type: 'number', min: '1', max: '65535', placeholder: 'port' });
    const count = el('input', { type: 'number', min: '1', max: '20', placeholder: 'count' });
    if (item) {
      if (item.type === 'run-test' || item.type === 'speedtest') { typeSel.value = item.type; }
      else { typeSel.value = item.probe.type; host.value = item.probe.host || ''; if (item.probe.port) port.value = item.probe.port; if (item.probe.count) count.value = item.probe.count; }
    }
    const ctrl = { typeSel, host, port, count };
    const del = el('button', { type: 'button', class: 'small ghost danger', title: 'Remove', onclick: () => { const i = itemRows.indexOf(ctrl); if (i >= 0) itemRows.splice(i, 1); node.remove(); } }, '×');
    const node = el('div', { class: 'test-item-row' }, typeSel, host, port, count, del);
    const sync = () => {
      const t = typeSel.value;
      const noTarget = t === 'run-test' || t === 'speedtest';
      host.style.visibility = noTarget ? 'hidden' : 'visible';
      port.style.visibility = t === 'tcp' ? 'visible' : 'hidden';
      count.style.visibility = (t === 'ping' || t === 'tcp') ? 'visible' : 'hidden';
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

      // Traffic over time: oldest -> newest, rate per measurement.
      const series = results
        .slice()
        .reverse()
        .map((r) => ({
          at: r.created_at,
          rx: r.payload && r.payload.traffic && r.payload.traffic.totals ? r.payload.traffic.totals.rxBytesPerSec : 0,
          tx: r.payload && r.payload.traffic && r.payload.traffic.totals ? r.payload.traffic.totals.txBytesPerSec : 0,
        }));
      if (series.length >= 2) body.push(trafficChart(series));

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
      } else {
        body.push(el('pre', {}, esc(JSON.stringify(latest.payload, null, 2))));
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
    cb.addEventListener('change', () => { if (cb.checked) histState.metrics.add(key); else histState.metrics.delete(key); });
    return el('label', { class: 'check' }, cb, label);
  });

  const chartHost = el('div', { class: 'overview-chart' });
  const status = el('div', { class: 'muted' });
  let baseFrom = null;
  let baseTo = null;

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
    const chosen = METRIC_DEFS.filter(([k]) => histState.metrics.has(k));
    if (!chosen.length) { chartHost.replaceChildren(el('div', { class: 'empty' }, 'Select at least one type.')); return; }
    const seriesList = chosen.map(([k, label], idx) => ({ id: k, label, color: SERIES_COLORS[idx % SERIES_COLORS.length], points: points.map((p) => ({ t: p.t, y: p[k] })) }));
    const legend = legendFor(seriesList);
    // #7 event timeline: findings for this agent in the window as markers. Band
    // (#6) only when a single metric is shown (otherwise scales clash).
    let markers = [];
    try { const fs = await api(`/api/findings?hostId=${encodeURIComponent(agentId)}&since=${new Date(fromMs).toISOString()}`); markers = findingMarkers(fs); } catch { markers = []; }
    const band = seriesList.length === 1 ? robustBand(seriesList[0].points) : null;
    chartHost.replaceChildren(historyChart(seriesList, { fromMs, toMs, band, markers, onBrush: (f, t) => { fromI.value = toLocalInput(new Date(f)); toI.value = toLocalInput(new Date(t)); load({ fromMs: f, toMs: t }); } }), legend);
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
// a terse "· DB … · ~…/dag · disk fuld …". The full breakdown folds open below.
function storageLineParts(s) {
  const d = s.disk || {};
  const db = s.database || {};
  const ing = s.ingest || null;
  const parts = [el('span', { class: 'muted' }, 'Storage')];
  if (d.available) {
    parts.push(usageBar(d.usedPercent));
    parts.push(el('span', { class: 'num' }, `${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)} (${d.usedPercent}%)`));
  } else {
    parts.push(el('span', { class: 'muted' }, 'drive unavailable'));
  }
  const extra = [];
  if (!db.error && db.totalBytes != null) extra.push(`DB ${fmtBytes(db.totalBytes)}`);
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

// One combined storage card: disk + database + a consumption estimate derived
// from how much was actually stored in the last few minutes.
function storageCards(s) {
  const wrap = el('div', { class: 'storage' });
  wrap.append(el('h3', { class: 'storage-h' }, 'Server storage'));
  const card = el('div', { class: 'stat storage-card' });
  const d = s.disk || {};
  const db = s.database || {};
  const ing = s.ingest || null;

  // Disk
  if (d.available) {
    card.append(
      el('div', { class: 'storage-row' }, el('span', { class: 'k' }, `Drive ${esc(d.path || '')}`), el('span', { class: 'v' }, `${fmtBytes(d.freeBytes)} free`)),
      usageBar(d.usedPercent),
      el('div', { class: 'small muted' }, `${fmtBytes(d.usedBytes)} used of ${fmtBytes(d.totalBytes)} (${d.usedPercent}%)`));
  } else {
    card.append(el('div', { class: 'storage-row' }, el('span', { class: 'k' }, 'Drive'), el('span', { class: 'v muted' }, 'unavailable')));
  }

  card.append(el('hr', { class: 'storage-sep' }));

  // Database
  if (db.error) {
    card.append(el('div', { class: 'storage-row' }, el('span', { class: 'k' }, 'Database'), el('span', { class: 'v muted' }, 'unavailable')));
  } else {
    const biggest = (db.tables && db.tables[0]) || null;
    card.append(
      el('div', { class: 'storage-row' }, el('span', { class: 'k' }, `Database ${esc(db.name || '')}`), el('span', { class: 'v' }, fmtBytes(db.totalBytes))),
      el('div', { class: 'small muted' }, `${db.tableCount} tables${biggest ? ` · largest: ${esc(biggest.name)} (${fmtBytes(biggest.bytes)})` : ''}`));
  }

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

  root.append(assistantBox(() => findingsState.hostId));

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

  // Hero chart: the chart fills the card's full width; a "marked" side panel
  // claims the right edge only while a window is selected. A size toggle widens
  // the whole card to (almost) the viewport and makes the chart taller.
  const chartHost = el('div', { class: 'overview-chart' });
  const controls = el('div', { class: 'peragent-list' });
  const markedStrip = el('div', { class: 'marked-side hidden' });
  const chipRx = el('button', { class: 'chip rx', onclick: () => toggleSeries('total:rx') }, 'Total RX');
  const chipTx = el('button', { class: 'chip tx', onclick: () => toggleSeries('total:tx') }, 'Total TX');
  const perAgentCnt = el('span', { class: 'cnt muted' });
  const perAgent = el('details', { class: 'chip-det' },
    el('summary', { class: 'chip' }, 'Pr. agent ', perAgentCnt), controls);
  const sizeBtn = el('button', { class: 'chip size-toggle', onclick: () => toggleSize() });
  let bigView = false;
  try { bigView = localStorage.getItem('blueeye.server.trafikBig') === '1'; } catch { /* storage off */ }
  const chartCard = el('div', { class: 'chart-card' },
    el('div', { class: 'bar' }, el('h3', {}, 'Live traffic'), el('span', { class: 'spacer' }), chipRx, chipTx, perAgent, sizeBtn),
    el('div', { class: 'chart-row' }, chartHost, markedStrip));
  root.append(chartCard);
  clearMarked(); // side panel stays hidden until a brush selection

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

  function renderChart() {
    // Cyan for RX, emerald for TX (NOC palette); palette colours for the rest.
    const colorFor = (id, idx) => (id.includes('rx') ? '#06b6d4' : id.includes('tx') ? '#10b981' : SERIES_COLORS[idx % SERIES_COLORS.length]);
    const chosen = [...selection].filter((id) => history.has(id));
    const seriesList = chosen.map((id, idx) => ({
      id, label: history.get(id).label, color: colorFor(id, idx),
      points: history.get(id).points,
    }));
    const legend = legendFor(seriesList);
    // Running clock ticks (HH:MM:SS) from the actual point timestamps, so the
    // x-axis shows the live timeframe rather than a static "~3 min siden / nu".
    const ref = seriesList.find((s) => s.points.length >= 2);
    const TICKS = 5;
    let xLabels = ['~3 min ago', '', 'now'];
    if (ref) {
      const pts = ref.points;
      xLabels = Array.from({ length: TICKS }, (_, i) =>
        fmtClock(pts[Math.round((i / (TICKS - 1)) * (pts.length - 1))].t));
    }
    chartHost.replaceChildren(
      seriesList.length ? multiChart(seriesList, { height: bigView ? 560 : 300, area: true, xLabels, onBrush: (f0, f1) => { if (f0 === null) clearMarked(); else renderMarked(f0, f1); } }) : el('div', { class: 'empty' }, 'Select series in the toolbar ↑'),
      legend);
    syncChips();
  }

  function clearMarked() {
    markedStrip.className = 'marked-side hidden';
    markedStrip.replaceChildren();
  }
  function renderMarked(f0, f1) {
    const chosen = [...selection].filter((id) => history.has(id));
    if (!chosen.length) { clearMarked(); return; }
    const maxLen = Math.max(1, ...chosen.map((id) => history.get(id).points.length));
    let i0 = Math.round(f0 * (maxLen - 1));
    let i1 = Math.round(f1 * (maxLen - 1));
    if (i1 < i0) { const tmp = i0; i0 = i1; i1 = tmp; }
    const rows = [];
    for (const id of chosen) {
      const slice = history.get(id).points.slice(i0, i1 + 1);
      if (!slice.length) continue;
      const ys = slice.map((p) => p.y);
      rows.push({ label: history.get(id).label, avg: ys.reduce((s, v) => s + v, 0) / ys.length, min: Math.min(...ys), max: Math.max(...ys) });
    }
    const ref = history.get(chosen[0]).points;
    const tFrom = ref[i0] && ref[i0].t;
    const lastIdx = Math.min(i1, ref.length - 1);
    const tTo = ref[lastIdx] && ref[lastIdx].t;
    const children = [
      el('div', { class: 'ms-head' }, el('strong', {}, 'Marked'), el('span', { class: 'spacer' }), el('button', { class: 'small ghost', onclick: clearMarked }, 'Clear')),
      el('div', { class: 'muted ms-range' }, (tFrom && tTo) ? `${fmtTimeShort(tFrom)} – ${fmtTimeShort(tTo)} · ${i1 - i0 + 1} pkt.` : `${i1 - i0 + 1} pkt.`),
    ];
    for (const r of rows) {
      children.push(el('div', { class: 'ms-stat' },
        el('span', { class: 'ms-name' }, r.label),
        el('span', { class: 'num' }, `avg ${fmtBytes(r.avg)}/s`),
        el('span', { class: 'num muted' }, `${fmtBytes(r.min)}–${fmtBytes(r.max)}`)));
    }
    // Drill into the ACTUAL stored data for the marked window (per agent).
    if (tFrom && tTo) {
      children.push(el('button', { class: 'small drill', onclick: () => { histDetails.open = true; histSection.focus(tFrom, tTo); } }, 'View stored data →'));
    }
    markedStrip.className = 'marked-side';
    markedStrip.replaceChildren(...children);
  }

  function checkbox(id, label) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = selection.has(id);
    cb.addEventListener('change', () => { if (cb.checked) selection.add(id); else selection.delete(id); renderChart(); });
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
    renderChart();
  }
  function syncChips() {
    chipRx.classList.toggle('on', selection.has('total:rx'));
    chipTx.classList.toggle('on', selection.has('total:tx'));
    let n = 0;
    for (const id of selection) if (id.startsWith('rx:') || id.startsWith('tx:')) n += 1;
    perAgentCnt.textContent = n ? `(${n})` : '';
  }

  // Widen the live-traffic card to (almost) the full viewport + taller chart,
  // and back. Persisted so it survives reloads and tab switches.
  function applySize() {
    chartCard.classList.toggle('big', bigView);
    sizeBtn.textContent = bigView ? '↔ Shrink' : '↔ Expand';
    sizeBtn.title = bigView ? 'Shrink the chart to normal width' : 'Expand the chart to full width';
    renderChart();
  }
  function toggleSize() {
    bigView = !bigView;
    try { localStorage.setItem('blueeye.server.trafikBig', bigView ? '1' : '0'); } catch { /* storage off */ }
    applySize();
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

  // Reflect the persisted size + set the toggle label (renders the chart once).
  applySize();

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
// Interface health table (worst first). Empty-state when there is no data.
function interfaceTable(interfaces) {
  const ifs = (interfaces || []).slice().sort((a, b) => (IFACE_RANK[a.status] - IFACE_RANK[b.status]) || ((b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec)));
  if (!ifs.length) return el('div', { class: 'empty' }, 'No interface data yet — requires an agent measurement (update the agent for errors/discards/link).');
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
function probeLatestTable(rows, onDetail) {
  if (!rows.length) return el('div', { class: 'muted' }, 'No probe results yet — run one above.');
  return el('table', {},
    el('thead', {}, el('tr', {}, ...['Type', 'Target', 'Status', 'RTT', 'Loss', 'Jitter', 'Time', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      el('td', {}, r.type),
      el('td', {}, esc(r.target)),
      el('td', {}, el('span', { class: `badge ${r.ok ? 'online' : 'offline'}` }, r.ok ? 'ok' : 'error')),
      el('td', { class: 'num' }, r.rttMs != null ? `${r.rttMs} ms` : '–'),
      el('td', { class: 'num' }, r.lossPct != null ? `${r.lossPct}%` : '–'),
      el('td', { class: 'num' }, r.jitterMs != null ? `${r.jitterMs} ms` : '–'),
      el('td', { class: 'muted' }, r.ts ? fmtTimeShort(new Date(r.ts).getTime()) : '–'),
      el('td', {}, el('button', { class: 'small ghost', onclick: () => onDetail(r) }, r.type === 'traceroute' ? 'Path' : 'History'))))));
}

// Detail node for one probe result: traceroute path (sync) or RTT history
// (fetches the per-agent time series).
async function probeDetail(r, agentId) {
  if (r.type === 'traceroute') {
    const hops = r.hops || [];
    return el('details', { class: 'sec', open: true }, el('summary', {}, `Path to ${esc(r.target)}`),
      el('table', { class: 'probe-hops' }, el('tbody', {}, ...(hops.length ? hops.map((h) => el('tr', {},
        el('td', { class: 'muted' }, `#${h.hop}`),
        el('td', {}, h.ip || '* * *'),
        el('td', { class: 'num' }, h.rttMs != null ? `${h.rttMs} ms` : '–'))) : [el('tr', {}, el('td', { class: 'muted' }, 'No hops.'))]))));
  }
  let data;
  try { data = await api(`/api/probes?agentId=${encodeURIComponent(agentId)}&type=${r.type}`); } catch (e) { return el('div', { class: 'error' }, e.message); }
  const pts = (data.results || []).filter((x) => x.target === r.target && x.rttMs != null).map((x) => ({ t: new Date(x.ts).getTime(), y: x.rttMs }));
  const fromMs = pts.length ? pts[0].t : Date.now() - 3600000;
  const toMs = pts.length ? pts[pts.length - 1].t : Date.now();
  // #6 normal-range band (RTT vs. its own median±MAD) + #7 markers: probe
  // failures (ok→fail flips) and recent findings for this agent.
  const band = robustBand(pts);
  const markers = [];
  for (const x of (data.results || []).filter((x) => x.target === r.target)) {
    if (x.ok === false && x.ts) markers.push({ t: new Date(x.ts).getTime(), kind: 'probe', label: `Probe error${x.detail ? ': ' + x.detail : ''}` });
  }
  try { const fs = await api(`/api/findings?hostId=${encodeURIComponent(agentId)}&since=${new Date(fromMs).toISOString()}`); markers.push(...findingMarkers(fs)); } catch { /* findings optional */ }
  return el('details', { class: 'sec', open: true }, el('summary', {}, `RTT history — ${r.type} → ${esc(r.target)} `, el('span', { class: 'muted' }, '· band = normal range (median±MAD)')),
    el('div', { class: 'overview-chart' }, pts.length ? historyChart([{ id: 'rtt', label: 'RTT (ms)', color: '#06b6d4', points: pts }], { fromMs, toMs, band, markers }) : el('div', { class: 'empty' }, 'No history yet — run a few measurements.')));
}

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
    host.replaceChildren(interfaceTable(data.interfaces));
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
views.probes = async () => {
  const root = el('div', { class: 'probes' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Probes'),
    el('span', { class: 'muted' }, 'Active reachability · ping · TCP · DNS · traceroute')));

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'No agents yet — enrol an agent first.')); return root; }

  const agentSel = el('select', {}, ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  const typeSel = el('select', {}, ...[['ping', 'Ping (ICMP)'], ['tcp', 'TCP-connect'], ['dns', 'DNS'], ['traceroute', 'Traceroute']].map(([v, l]) => el('option', { value: v }, l)));
  const target = el('input', { type: 'text', placeholder: 'e.g. 1.1.1.1 or example.com' });
  const portInput = el('input', { type: 'number', min: '1', max: '65535', value: '443' });
  const portWrap = el('label', { class: 'inline muted' }, 'Port ', portInput);
  const countInput = el('input', { type: 'number', min: '1', max: '20', value: '4' });
  const runBtn = el('button', { class: 'small' }, 'Run probe');
  const status = el('div', { class: 'muted' });
  const syncPort = () => { portWrap.style.display = typeSel.value === 'tcp' ? '' : 'none'; };
  typeSel.addEventListener('change', syncPort); syncPort();

  root.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Agent ', agentSel),
    el('label', { class: 'inline muted' }, 'Type ', typeSel),
    el('label', { class: 'inline muted' }, 'Target ', target),
    portWrap,
    el('label', { class: 'inline muted' }, 'Count ', countInput),
    runBtn, status));

  const latestHost = el('div', { class: 'probe-latest' });
  const detailHost = el('div', {});
  root.append(el('details', { class: 'sec', open: true }, el('summary', {}, 'Latest results ', el('span', { class: 'muted' }, '· most recent per target')), latestHost));
  root.append(detailHost);

  async function run() {
    const id = agentSel.value;
    const host = target.value.trim();
    if (!host) { status.className = 'error'; status.textContent = 'Enter a target.'; return; }
    const body = { type: typeSel.value, host };
    if (typeSel.value === 'tcp') body.port = Number(portInput.value);
    if (countInput.value) body.count = Number(countInput.value);
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
    latestHost.replaceChildren(probeLatestTable(rows, showDetail));
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

// The landing view: all agents with a probe-derived health verdict, worst-first.
// Click a row to pivot into that agent's combined detail page.
views.fleet = async () => {
  const root = el('div', { class: 'fleet' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Overview'),
    el('span', { class: 'muted' }, 'All agents · health from reachability · loss · latency · jitter')));
  const bannerHost = el('div', {});
  const summaryHost = el('div', { class: 'fleet-summary' });
  const tableHost = el('div', {});
  root.append(bannerHost, summaryHost, tableHost);

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
  async function refresh() {
    let data;
    try { data = await api('/api/fleet/health'); } catch (e) { tableHost.replaceChildren(el('div', { class: 'error' }, e.message)); return; }
    lastData = data;
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
  const typeSel = el('select', {}, ...[['ping', 'Ping (ICMP)'], ['tcp', 'TCP-connect'], ['dns', 'DNS'], ['traceroute', 'Traceroute']].map(([v, l]) => el('option', { value: v }, l)));
  const target = el('input', { type: 'text', placeholder: 'e.g. 1.1.1.1 or example.com' });
  const portInput = el('input', { type: 'number', min: '1', max: '65535', value: '443' });
  const portWrap = el('label', { class: 'inline muted' }, 'Port ', portInput);
  const countInput = el('input', { type: 'number', min: '1', max: '20', value: '4' });
  const runBtn = el('button', { class: 'small' }, 'Run probe');
  const probeStatus = el('span', { class: 'muted' });
  const syncPort = () => { portWrap.style.display = typeSel.value === 'tcp' ? '' : 'none'; };
  typeSel.addEventListener('change', syncPort); syncPort();
  const probeForm = el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Type ', typeSel),
    el('label', { class: 'inline muted' }, 'Target ', target),
    portWrap,
    el('label', { class: 'inline muted' }, 'Count ', countInput),
    runBtn, probeStatus);
  const probeLatestHost = el('div', { class: 'probe-latest' });
  const probeDetailHost = el('div', {});

  async function runProbe() {
    const host = target.value.trim();
    if (!host) { probeStatus.className = 'error'; probeStatus.textContent = 'Enter a target.'; return; }
    const body = { type: typeSel.value, host };
    if (typeSel.value === 'tcp') body.port = Number(portInput.value);
    if (countInput.value) body.count = Number(countInput.value);
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
    probeLatestHost.replaceChildren(probeLatestTable(data.results || [], async (r) => { probeDetailHost.replaceChildren(await probeDetail(r, id)); }));
  }

  // ---- Interfaces ----
  const ifaceStatus = el('span', { class: 'muted' });
  const ifaceHost = el('div', {});
  async function refreshIfaces() {
    let data;
    try { data = await api(`/api/interfaces?agentId=${encodeURIComponent(id)}`); } catch (e) { ifaceHost.replaceChildren(el('div', { class: 'error' }, e.message)); return; }
    ifaceStatus.textContent = data.ts ? `source: ${data.source} · measured ${fmtTimeShort(new Date(data.ts).getTime())}` : 'no measurements yet';
    ifaceHost.replaceChildren(interfaceTable(data.interfaces));
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

  root.append(
    el('details', { class: 'sec', open: true }, el('summary', {}, 'Probes ', el('span', { class: 'muted' }, '· ping · TCP · DNS · traceroute')), probeForm, probeLatestHost, probeDetailHost),
    el('details', { class: 'sec', open: true }, el('summary', {}, 'Interfaces ', ifaceStatus), ifaceHost),
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

// Flow / conversation explorer: query NetFlow/sFlow conversations for an agent
// with filters, see top talkers + ports/protocols + a byte series, and surface
// port-scan / fan-out sources. Metadata only; internal (LAN) conversations are
// shown — they are simply never geolocated.
views.flows = async () => {
  const root = el('div', { class: 'flows-explorer' });
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Flows'),
    el('span', { class: 'muted' }, 'Conversations · top talkers · ports · scan / fan-out')));

  const agents = await api('/agents').catch(() => []);
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'No agents yet.')); return root; }

  const agentSel = el('select', {}, ...agents.map((a) => el('option', { value: String(a.id) }, a.display_name || a.hostname)));
  if (selectedAgentId != null && agents.some((a) => String(a.id) === String(selectedAgentId))) agentSel.value = String(selectedAgentId);
  const peerInput = el('input', { type: 'text', placeholder: 'IP (src/dst)' });
  const portInput = el('input', { type: 'number', min: '1', max: '65535', placeholder: 'port' });
  const protoInput = el('input', { type: 'text', placeholder: 'tcp/udp' });
  const dirSel = el('select', {}, el('option', { value: '' }, 'All directions'), el('option', { value: 'out' }, 'Outbound'), el('option', { value: 'in' }, 'Inbound'));
  const scopeSel = el('select', {}, el('option', { value: '' }, 'Internal + external'), el('option', { value: 'external' }, 'External only'), el('option', { value: 'internal' }, 'Internal only'));
  const winSel = el('select', {}, el('option', { value: '1' }, 'Last 1 h'), el('option', { value: '6' }, 'Last 6 h'), el('option', { value: '24' }, 'Last 24 h'));
  winSel.value = '6';
  const runBtn = el('button', { class: 'small' }, 'Show');
  const status = el('span', { class: 'muted' });

  // Prefill from a deep link (global search → "→ flows").
  if (flowsPrefill) {
    if (flowsPrefill.agentId != null && agents.some((a) => String(a.id) === String(flowsPrefill.agentId))) agentSel.value = String(flowsPrefill.agentId);
    if (flowsPrefill.peer) peerInput.value = flowsPrefill.peer;
    if (flowsPrefill.port) portInput.value = String(flowsPrefill.port);
    flowsPrefill = null;
  }

  root.append(el('div', { class: 'history-controls' },
    el('label', { class: 'inline muted' }, 'Agent ', agentSel),
    el('label', { class: 'inline muted' }, 'Peer ', peerInput),
    el('label', { class: 'inline muted' }, 'Port ', portInput),
    el('label', { class: 'inline muted' }, 'Proto ', protoInput),
    dirSel, scopeSel, winSel, runBtn, status));

  const host = el('div', {});
  root.append(host);

  function qs() {
    const p = new URLSearchParams();
    p.set('agentId', agentSel.value);
    const hours = Number(winSel.value) || 6;
    p.set('from', new Date(Date.now() - hours * 3600000).toISOString());
    if (peerInput.value.trim()) p.set('peer', peerInput.value.trim());
    if (portInput.value.trim()) p.set('port', portInput.value.trim());
    if (protoInput.value.trim()) p.set('proto', protoInput.value.trim());
    if (dirSel.value) p.set('direction', dirSel.value);
    if (scopeSel.value) p.set('internal', scopeSel.value);
    return p.toString();
  }
  const talkerPeer = (t) => (t.internal ? t.dstIp : (t.extIp || t.dstIp));

  async function refresh() {
    status.textContent = 'Loading…';
    let data;
    try { data = await api(`/api/flows/explore?${qs()}`); } catch (e) { host.replaceChildren(el('div', { class: 'error' }, e.message)); status.textContent = ''; return; }
    status.textContent = `${fmtBytes(data.totals.bytes)} · ${data.totals.flowCount} flows · ${data.totals.records} records`;
    const kids = [];

    // Scans/fan-out first — it's the security-relevant signal.
    if (data.scans && data.scans.length) {
      kids.push(el('details', { class: 'sec scan-sec', open: true }, el('summary', {}, '⚠ Mulige scans / fan-out ', el('span', { class: 'muted' }, '· én kilde mod mange porte/hosts')),
        el('table', {}, el('thead', {}, el('tr', {}, ...['Source', 'Type', 'Ports', 'Hosts', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
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
      kids.push(el('div', { class: 'overview-chart' }, historyChart([{ id: 'b', label: 'Bytes', color: '#06b6d4', points: pts }], { fromMs: pts[0].t, toMs: pts[pts.length - 1].t, band: robustBand(pts) })));
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

    const portTable = el('table', {}, el('thead', {}, el('tr', {}, ...['Port', 'Proto', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...(data.byPort.length ? data.byPort.map((p) => el('tr', {}, el('td', {}, String(p.port)), el('td', { class: 'muted' }, p.proto || '–'), el('td', { class: 'num' }, fmtBytes(p.bytes)), el('td', { class: 'num muted' }, String(p.flowCount)))) : [el('tr', {}, el('td', { class: 'muted' }, '–'))])));
    const protoTable = el('table', {}, el('thead', {}, el('tr', {}, ...['Protocol', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...(data.byProto.length ? data.byProto.map((p) => el('tr', {}, el('td', {}, p.proto || '–'), el('td', { class: 'num' }, fmtBytes(p.bytes)), el('td', { class: 'num muted' }, String(p.flowCount)))) : [el('tr', {}, el('td', { class: 'muted' }, '–'))])));
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
const geoState = { map: null, ext: null, hosts: null, rect: null, dests: [], sinceIso: '', panel: null, selecting: false, rectStart: null, healthByHost: null };

function stopGeo() {
  if (geoState.map) { try { geoState.map.remove(); } catch { /* ignore */ } }
  geoState.map = null; geoState.ext = null; geoState.hosts = null; geoState.rect = null;
  geoState.dests = []; geoState.selecting = false; geoState.rectStart = null; geoState.healthByHost = null;
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
  const [config, overview, fleet] = await Promise.all([
    api('/api/geo/config'), api('/api/geo/overview'),
    api('/api/fleet/health').catch(() => ({ agents: [] })),
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

// Cell showing the selected traffic source + what the agent reports it can do.
function agentSourceCell(a) {
  const mc = a.monitor_config || {};
  const source = mc.source || 'proc';
  const caps = a.capabilities && Array.isArray(a.capabilities.sources) ? a.capabilities.sources : null;
  const detail = source === 'snmp' && mc.snmp ? ` (${mc.snmp.host})` : '';
  return el('div', {},
    el('span', { class: 'badge' }, source + detail),
    caps ? el('div', { class: 'muted', title: 'Agent capabilities' }, `can: ${caps.join(', ')}`) : null);
}

function editAgent(a) {
  const mc = a.monitor_config || {};
  const snmp = mc.snmp || {};
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
      monitor_config = { source: 'netflow', netflow: { port: Number(v.netflow_port) || 2055 } };
    } else if (v.source === 'sflow') {
      monitor_config = { source: 'sflow', sflow: { port: Number(v.sflow_port) || 6343 } };
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
        el('button', { class: 'small ghost', onclick: () => showLocationSummary(l) }, 'AI status'),
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
    if (!mapCfg.geocodeUrl) return;
    try {
      const res = await fetch(`${mapCfg.geocodeUrl}/reverse?format=jsonv2&lat=${la}&lon=${lo}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.display_name) address.value = data.display_name;
    } catch { /* geocoder optional */ }
  }
  async function doSearch() {
    const q = search.value.trim();
    results.replaceChildren();
    if (!q) return;
    if (!mapCfg.geocodeUrl) { results.append(el('p', { class: 'muted' }, 'No geocoder configured (Settings → Map).')); return; }
    results.append(el('p', { class: 'muted' }, 'Searching…'));
    try {
      const res = await fetch(`${mapCfg.geocodeUrl}/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const list = res.ok ? await res.json() : [];
      results.replaceChildren(...(list.length ? list.map((r) => el('button', {
        type: 'button', class: 'geocode-hit', onclick: () => {
          setPoint(Number(r.lat), Number(r.lon), true);
          if (r.display_name) { address.value = r.display_name; search.value = r.display_name; }
          results.replaceChildren();
        },
      }, r.display_name)) : [el('p', { class: 'muted' }, 'No results.')]));
    } catch { results.replaceChildren(el('p', { class: 'error' }, 'Geocoder error.')); }
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

  if (canWrite()) root.append(enrollWizard(cfg));

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
views.settings = async () => {
  const root = el('div');
  const isAdmin = role === 'admin';
  const subtabs = [];
  if (isAdmin) subtabs.push(['analyse', 'Analysis'], ['alerting', 'Alerting'], ['maintenance', 'Maintenance'], ['updates', 'Updates'], ['retention', 'Retention'], ['types', 'Traffic types'], ['map', 'Map'], ['users', 'Users']);
  // Appearance + License are personal/read-only — available to every role.
  subtabs.push(['appearance', 'Appearance'], ['license', 'License']);
  if (!settingsTab || !subtabs.some(([k]) => k === settingsTab)) settingsTab = subtabs[0][0];

  const nav = el('div', { class: 'subtabs' }, ...subtabs.map(([k, label]) =>
    el('button', { class: `small ghost${k === settingsTab ? ' active' : ''}`, onclick: () => { settingsTab = k; render(); } }, label)));
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Settings'), el('span', { class: 'spacer' }), nav));

  const views2 = {
    users: () => views.users(),
    license: () => views.license(),
    appearance: settingsAppearanceView,
    map: settingsMapView,
    types: settingsTypesView,
    analyse: settingsAnalyseView,
    alerting: settingsAlertingView,
    maintenance: settingsMaintenanceView,
    updates: settingsUpdatesView,
    retention: settingsRetentionView,
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
// licence covers it.
function licenseBadge(license, feature) {
  const ok = license && license[feature] === true;
  return el('span', { class: `badge ${ok ? 'active' : 'offline'}` }, `Licence: ${feature} ${ok ? 'yes' : 'no'}`);
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
  root.append(el('p', { class: 'muted settings-intro' }, 'The server learns a normal baseline for each metric and raises a finding when a measurement deviates enough from it. Here you set how sensitive detection is — changes take effect immediately, without restart. The opt-in AI assistant (its on/off switch and API key) is configured here too. ', licenseBadge(data.license, 'analysis')));
  root.append(el('div', { class: 'settings-grid' }, analyseSettingsCard(data.analysis), throughputSettingsCard(data.throughput), assistantSettingsCard(data.assistant)));
  return root;
}

// Speed-test health thresholds: flag agents on the Overview when their latest
// download/upload falls below a floor (0 = that floor is off). Folded into the
// agent's health verdict like loss/latency. Admin, runtime-editable.
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

async function settingsAlertingView() {
  const data = await api('/api/settings');
  const root = el('div');
  root.append(el('p', { class: 'muted settings-intro' }, 'When a finding is raised it can be dispatched via e-mail, webhook, or syslog. The overview below shows which channels are enabled and their minimum severity. ', licenseBadge(data.license, 'alerting')));
  const card = settingsCard('Alerting', alertingSummary(data.alerting));
  card.append(el('p', { class: 'muted small' }, 'Channels are configured via the server .env because they contain secrets (SMTP password, webhook HMAC). Changes require a restart. Env: ALERTING_*, SMTP_*, WEBHOOK_*.'));
  root.append(el('div', { class: 'settings-grid' }, card));
  return root;
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

// AI assistant (opt-in): admin-editable enable flag, API key and model — instead
// of env-only. The key is write-only: the API only reports whether one is set
// (apiKeySet + a masked hint), so the field stays blank and a typed value
// replaces the stored key. The assistant calls Mistral (EU).
function assistantSettingsCard(a) {
  const v = a || { enabled: false, model: '', apiKeySet: false, apiKeyHint: '' };
  const enabledI = el('input', { type: 'checkbox' });
  const modelI = el('input', { type: 'text', placeholder: 'mistral-small-latest' });
  const keyI = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const clearI = el('input', { type: 'checkbox' });
  const clearRow = el('label', { class: 'inline muted small' }, clearI, el('span', {}, 'Remove the stored key'));
  const note = el('p', { class: 'muted small' });
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'small' }, 'Save');

  function applyState(s) {
    enabledI.checked = !!s.enabled;
    modelI.value = s.model || '';
    keyI.value = '';
    keyI.placeholder = s.apiKeySet ? `Key set (${s.apiKeyHint}) — type to replace` : 'Paste an API key to enable';
    clearRow.classList.toggle('hidden', !s.apiKeySet);
    clearI.checked = false;
    note.textContent = (s.enabled && !s.apiKeySet)
      ? '⚠ Enabled but no API key set — add one above, or the assistant returns an error.'
      : 'Calls Mistral (EU). The key is stored in the server database and is never shown again.';
  }
  applyState(v);

  async function save() {
    err.textContent = ''; btn.disabled = true;
    const body = { enabled: enabledI.checked, model: modelI.value.trim() || 'mistral-small-latest' };
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
      el('label', { class: 'set-field' }, el('span', {}, 'API key'), keyI,
        el('span', { class: 'muted small' }, 'Mistral API key. Write-only — stored on the server, never displayed again.')),
      clearRow,
      el('label', { class: 'set-field' }, el('span', {}, 'Model'), modelI,
        el('span', { class: 'muted small' }, 'Provider model id. Default mistral-small-latest.')),
      note, err, el('div', { class: 'form-actions' }, btn)));
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
  root.append(el('div', { class: 'settings-grid' }, mapSettingsCard(data.map)));
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
function alertingSummary(a) {
  if (!a) return el('p', { class: 'muted' }, '–');
  const rows = [el('tr', {}, el('td', { class: 'muted' }, 'Enabled'), el('td', {}, boolText(a.enabled)))];
  for (const [name, c] of Object.entries(a.channels || {})) {
    rows.push(el('tr', {}, el('td', { class: 'muted' }, name), el('td', {}, `${boolText(c.enabled)} · min ${c.minSeverity || '–'}`)));
  }
  return el('table', { class: 'kv' }, el('tbody', {}, ...rows));
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
      { name: 'password', label: 'New password (min. 8 characters)', type: 'password', value: '' },
    ], async (v) => {
      if (!v.password) throw new Error('Enter a new password');
      await api(`/users/${u.id}`, { method: 'PUT', body: { role: 'admin', password: v.password } });
      closeModal(); toast('Password changed'); render();
    });
  } else if (u) {
    // Update: role + optional password reset (email is immutable here).
    openModal(`Edit ${u.email}`, [
      { name: 'role', label: 'Role', type: 'select', value: u.role, options: ROLE_OPTIONS },
      { name: 'password', label: 'New password (optional)', type: 'password', value: '' },
    ], async (v) => {
      const body = { role: v.role };
      if (v.password) body.password = v.password;
      await api(`/users/${u.id}`, { method: 'PUT', body });
      closeModal(); toast('User updated'); render();
    });
  } else {
    openModal('New user', [
      { name: 'email', label: 'Email', type: 'email', value: '' },
      { name: 'password', label: 'Password (min. 8 characters)', type: 'password', value: '' },
      { name: 'role', label: 'Role', type: 'select', value: 'viewer', options: ROLE_OPTIONS },
    ], async (v) => {
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

views.license = async () => {
  const s = await api('/license/status');
  const root = el('div');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'License status'),
    canWrite() ? el('button', { class: 'small', onclick: refreshLicense }, 'Re-validate now') : null));
  root.append(el('div', { class: 'cards' },
    stat('Status', el('span', { class: `badge ${s.status}` }, s.status)),
    stat('Licensed', s.licensed ? 'Yes' : 'No'),
    stat('Max. agents', String(s.maxAgents)),
    stat('Server ID', s.serverId || '–'),
    stat('Last validated', fmtDate(s.verifiedAt)),
    stat('Grace expires', fmtDate(s.graceUntil)),
  ));
  if (s.reason) root.append(el('p', { class: 'muted' }, `Note: ${s.reason}`));
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

let currentView = 'fleet';
const modalOpen = () => !$('#modal').classList.contains('hidden');

async function render({ silent = false } = {}) {
  if (!token) { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); return; }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  connectLive(); // live findings channel (idempotent)
  await loadProfile(); // apply the user's saved colour theme (once per session)
  await loadFeatures();
  applyFeatureVisibility(); // hide modules not included in the licence
  // Show who is logged in: email + role.
  $('#whoami').replaceChildren(
    el('span', { class: 'who-email' }, email || '—'),
    el('span', { class: `badge role-${role}` }, role));

  // Stop the overview poller when leaving that view (it restarts itself when shown).
  if (currentView !== 'overview') stopOverview();
  if (currentView !== 'probes') stopProbes();
  if (currentView !== 'interfaces') stopIfaces();
  if (currentView !== 'fleet') stopFleet();
  if (currentView !== 'agent') stopAgent();
  // Tear down the Leaflet maps when leaving their views (they rebuild on entry).
  if (currentView !== 'geo') stopGeo();
  if (currentView !== 'map') stopMap();

  // Admin-only tabs (e.g. Users); send non-admins back to agents if needed.
  for (const b of document.querySelectorAll('.tabs button[data-admin]')) {
    b.classList.toggle('hidden', role !== 'admin');
  }
  if (currentView === 'users' && role !== 'admin') currentView = 'overview';
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === currentView);

  const view = $('#view');
  if (!silent) view.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
  try {
    const node = await views[currentView]();
    const h = hero(currentView);
    view.replaceChildren(...(h ? [h, node] : [node]));
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
$('#logout').addEventListener('click', () => { setAutoRefresh(false); stopOverview(); stopFleet(); stopAgent(); stopProbes(); stopIfaces(); stopMap(); stopGeo(); $('#autorefresh').checked = false; logout(); });
$('#refresh').addEventListener('click', () => render());
$('#autorefresh').addEventListener('change', (e) => setAutoRefresh(e.target.checked));
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { closeDrawer(); currentView = b.dataset.view; render(); });
}
{
  const sq = $('#search-q');
  if (sq) sq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); globalSearch(sq.value); sq.blur(); } });
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

render();
