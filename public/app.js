'use strict';

// BlueEye server dashboard — dependency-free vanilla JS over the JSON API.
const TOKEN_KEY = 'blueeye.server.token';
const ROLE_KEY = 'blueeye.server.role';
const EMAIL_KEY = 'blueeye.server.email';

const $ = (sel) => document.querySelector(sel);
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
    throw new Error('Session udløbet — log ind igen.');
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

function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast${bad ? ' bad' : ''}`;
  setTimeout(() => t.classList.add('hidden'), 3200);
}

function copyText(text) {
  const done = () => toast('Kopieret');
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
  try { document.execCommand('copy'); done(); } catch { toast('Kunne ikke kopiere', true); }
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
const fmtDate = (s) => (s ? new Date(s).toLocaleString('da-DK') : '–');
function fmtDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}t`;
  if (h > 0) return `${h}t ${m}m`;
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
// (e.g. right after "Genvalidér nu").
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

function logout() {
  disconnectLive();
  invalidateFeatures();
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
    el('button', { type: 'button', class: 'ghost', onclick: closeModal }, 'Annullér'),
    el('button', { type: 'submit' }, 'Gem')));
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
function closeModal() { $('#modal').classList.add('hidden'); }

// ---- Views ----------------------------------------------------------------
// ---- Per-page explanation (hero + slide-in info drawer) -------------------
// Each view starts with a short hero line and a "Mere info" button that slides
// in a panel from the right with a fuller explanation.
const PAGE_INFO = {
  overview: {
    hero: 'Samlet trafik-billede. Vælg de serier du vil se via checkboksene.',
    title: 'Trafik — overblik',
    body: () => [
      el('p', {}, 'Et bredt, levende grafbillede af trafikken. Til/fravælg serier i panelet til højre — totaler og pr. agent (RX/TX) — så du selv sammensætter visningen.'),
      el('p', { class: 'muted' }, 'Grafen opdateres hvert 3. sekund og viser de seneste ~3 minutter.'),
    ],
  },
  map: {
    hero: 'Geografisk overblik over lokationer og deres agenter.',
    title: 'Kort',
    body: () => [
      el('p', {}, 'Lokationer med koordinater (latitude/longitude) vises som markører. Klik en markør for at se antal agenter og hvor mange der er online.'),
      el('p', { class: 'muted' }, 'Tilføj koordinater pr. lokation under fanen Lokationer (Rediger). Mangler kortet, kan biblioteket ikke nås — så vises en liste i stedet.'),
    ],
  },
  agents: {
    hero: 'Overvåg de agenter, der rapporterer trafik ind til denne server.',
    title: 'Agenter',
    body: () => [
      el('p', {}, 'Agenter installeres på kundens maskiner og rapporterer netværkstrafik ind til serveren.'),
      el('h4', {}, 'Status & health'),
      el('ul', {},
        el('li', {}, 'Status: online/offline ud fra WebSocket-forbindelsen.'),
        el('li', {}, 'Health: "sund" = online og har rapporteret inden for 5 min., "forsinket" = online men gammel rapport, "nede" = offline.'),
        el('li', {}, 'Senest rapporteret: tidspunktet for agentens seneste trafik-måling.')),
      el('h4', {}, 'Handlinger'),
      el('ul', {},
        el('li', {}, '"+ Ny agent" giver en engangskode til installation (operator+).'),
        el('li', {}, '"Kør test" beder agenten måle med det samme; "Trafik" viser målingerne.'),
        el('li', {}, '"Rediger" sætter navn, lokation, noter og trafik-kilde (proc/SNMP).')),
    ],
  },
  geo: {
    hero: 'Geografisk overblik: interne sites og eksterne trafik-destinationer (land/ASN).',
    title: 'Geo-kort',
    body: () => [
      el('p', {}, 'Interne hosts vises ud fra deres site-koordinater (sat pr. lokation) — aldrig via GeoIP. Eksterne destinationer er aggregeret pr. land/ASN fra GeoIP-berigede flows; private/RFC1918-adresser vises aldrig som geo-punkt.'),
      el('h4', {}, 'Markører'),
      el('ul', {},
        el('li', {}, 'Pins = interne sites (klik for status + findings).'),
        el('li', {}, 'Cirkler = eksterne destinationer; størrelse efter trafik, farve efter afvigelse (neutral → gul → rød).')),
      el('h4', {}, 'Valg'),
      el('ul', {},
        el('li', {}, 'Klik en destination: se findings + flow-detaljer (peers, retning, protokol, tidsserie).'),
        el('li', {}, '"Vælg område" og træk en kasse for at aggregere alle destinationer i området.'),
        el('li', {}, '"Ryd valg" vender tilbage til overblikket.')),
      el('p', { class: 'muted' }, 'Kort-tiles hentes fra serverens config (EU/selv-hostet), ikke en hardkodet US-kilde.'),
    ],
  },
  findings: {
    hero: 'Lokalt beregnede fejl & anomalier — med forklaring, dokumentation og root-cause-hint.',
    title: 'Analyse — fejl & anomalier',
    body: () => [
      el('p', {}, 'Serveren analyserer agenternes målinger lokalt (ingen cloud, intet ML-bibliotek) og rejser en "finding", når en metrik afviger markant fra sin egen baseline, fladliner (sensor/agent-stop) eller hænger sammen med andre fejl.'),
      el('h4', {}, 'Severity'),
      el('ul', {},
        el('li', {}, 'CRIT: stor afvigelse (≥ 4σ fra baseline).'),
        el('li', {}, 'WARN: mærkbar afvigelse (≥ 3σ) eller flatline.'),
        el('li', {}, 'INFO: lavere alvorlighed.')),
      el('h4', {}, 'Kvittering'),
      el('p', {}, 'Operatører og administratorer kan kvittere for en finding, når den er set/håndteret.'),
      el('h4', {}, 'AI-assistent'),
      el('p', {}, 'Hvis aktiveret (opt-in) kan du spørge i naturligt sprog — assistenten svarer ud fra de seneste findings, ikke rå data.'),
      el('p', { class: 'muted' }, 'Nye findings vises live via WebSocket og kan også hentes via REST.'),
    ],
  },
  locations: {
    hero: 'Grupper agenter i lokationer og se korreleret live-trafik pr. lokation.',
    title: 'Lokationer',
    body: () => [
      el('p', {}, 'En lokation samler flere agenter (fx et kontor eller en lokation).'),
      el('h4', {}, 'Live-trafik'),
      el('p', {}, '"Trafik" åbner et live-panel der summerer alle agenters trafik i lokationen og opdaterer hvert 3. sekund — godt til at se samlet belastning og finde fejl.'),
    ],
  },
  enrollment: {
    hero: 'Opret engangskoder, som nye agenter bruger til at melde sig ind første gang.',
    title: 'Enrollment',
    body: () => [
      el('p', {}, 'En enrollment-kode er engangsbrug. Agenten bruger den ved første opstart til at få et fast token.'),
      el('ul', {},
        el('li', {}, 'Sæt koden som BLUEEYE_ENROLLMENT_CODE på agent-maskinen.'),
        el('li', {}, 'Koden vises kun én gang ved oprettelse.'),
        el('li', {}, 'Status: active (kan bruges), used (brugt), expired (udløbet).')),
    ],
  },
  users: {
    hero: 'Administrér personale-brugere og deres roller (kun admin).',
    title: 'Brugere',
    body: () => [
      el('h4', {}, 'Roller'),
      el('ul', {},
        el('li', {}, 'admin: alt, inkl. brugeradministration.'),
        el('li', {}, 'operator: opret/redigér agenter, lokationer og enrollment-koder.'),
        el('li', {}, 'viewer: kun læseadgang.')),
      el('p', {}, 'Den sidste admin kan ikke slettes eller degraderes.'),
    ],
  },
  license: {
    hero: 'Se denne servers licensstatus, valideret mod den centrale licensserver.',
    title: 'Licens',
    body: () => [
      el('p', {}, 'Serveren henter et signeret bevis fra licensserveren og verificerer det offline med en indlejret nøgle.'),
      el('ul', {},
        el('li', {}, 'valid: frisk og gyldig.'),
        el('li', {}, 'grace: kan ikke nå licensserveren, men cachet bevis < 14 dage.'),
        el('li', {}, 'unlicensed: ingen gyldig licens — nye agent-forbindelser afvises.')),
    ],
  },
};

function hero(viewKey) {
  const info = PAGE_INFO[viewKey];
  if (!info) return null;
  return el('div', { class: 'hero' },
    el('div', { class: 'hero-text' }, info.hero),
    el('button', { class: 'ghost small', onclick: () => openDrawer(info.title, info.body) }, 'Mere info'));
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
  const [agents, locations] = await Promise.all([api('/agents'), api('/locations')]);
  locationCache = locations;
  const root = el('div');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Agenter'),
    el('span', { class: 'muted' }, `${agents.length} stk.`),
    canWrite() ? el('button', { class: 'small', onclick: () => newAgent() }, '+ Ny agent') : null));
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'Ingen agenter endnu. Tryk "+ Ny agent" for at få en enrollment-kode til installation.')); return root; }

  const rows = agents.map((a) => el('tr', {},
    el('td', {}, String(a.id)),
    el('td', {}, el('div', {}, a.display_name || a.hostname), a.display_name ? el('div', { class: 'muted' }, a.hostname) : null),
    el('td', {}, `${a.platform} / ${a.arch}`),
    el('td', {}, el('span', { class: `badge ${a.status}` }, a.status)),
    el('td', {}, agentHealthCell(a)),
    el('td', {}, a.location_name || '–'),
    el('td', {}, agentSourceCell(a)),
    el('td', { class: 'muted' }, fmtDate(a.last_report_at)),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'small ghost', onclick: () => showResults(a) }, 'Trafik'),
      (a.monitor_config && (a.monitor_config.source === 'netflow' || a.monitor_config.source === 'sflow'))
        ? el('button', { class: 'small ghost', onclick: () => showAgentFlows(a) }, 'Flows')
        : null,
      canWrite() ? el('button', { class: 'small', onclick: () => runTest(a) }, 'Kør test') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => editAgent(a) }, 'Rediger') : null,
      canDelete() ? el('button', { class: 'small danger', onclick: () => deleteAgent(a) }, 'Slet') : null,
    )),
  ));
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Navn / hostname', 'Platform', 'Status', 'Health', 'Lokation', 'Kilde', 'Senest rapporteret', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows)));
  return root;
};

// Health derived from how recently the agent last reported in. online + a fresh
// report = healthy; online but stale (or never reported) = degraded; offline = down.
function agentHealthCell(a) {
  const last = a.last_report_at ? new Date(a.last_report_at).getTime() : 0;
  const ageMs = last ? Date.now() - last : Infinity;
  const FRESH = 5 * 60 * 1000; // 5 min
  let cls;
  let label;
  if (a.status !== 'online') { cls = 'offline'; label = 'nede'; }
  else if (ageMs <= FRESH) { cls = 'online'; label = 'sund'; }
  else { cls = 'grace'; label = last ? 'forsinket' : 'ingen data'; }
  const title = last ? `Senest rapporteret ${fmtDate(a.last_report_at)}` : 'Har ikke rapporteret endnu';
  return el('span', { class: `badge ${cls}`, title }, label);
}

// Operator "create agent" = mint an enrollment code + show install instructions.
// Agents are created when they enroll themselves (they report hostname/etc.).
async function newAgent() {
  try {
    const created = await api('/enrollment-codes', { method: 'POST', body: {} });
    const card = $('#modal-card');
    const base = location.origin;
    card.replaceChildren(
      el('h3', {}, 'Ny agent — enrollment-kode'),
      el('p', { class: 'muted' }, 'Installér agenten på maskinen og giv den denne engangskode. Den dukker op i listen, når den enroller. Koden vises kun nu:'),
      el('pre', {}, esc(created.code)),
      el('p', { class: 'muted' }, 'Eksempel (env på agent-maskinen):'),
      el('pre', {}, `BLUEEYE_SERVER_URL=${esc(base)}\nBLUEEYE_ENROLLMENT_CODE=${esc(created.code)}`),
      el('div', { class: 'form-actions' },
        el('button', { class: 'ghost', onclick: () => copyText(created.code) }, 'Kopiér kode'),
        el('button', { onclick: () => { closeModal(); render(); } }, 'Luk')));
    $('#modal').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}

async function runTest(a) {
  try {
    const res = await api(`/agents/${a.id}/run-test`, { method: 'POST', body: { intervalMs: 1000 } });
    toast(`Test sendt til ${a.hostname} (leveret: ${res.delivered}). Henter resultat…`);
    setTimeout(() => showResults(a), 2000);
  } catch (err) { toast(err.message, true); }
}

async function showResults(a) {
  try {
    const results = await api(`/agents/${a.id}/results`);
    const card = $('#modal-card');
    const body = [el('h3', {}, `Trafik — ${esc(a.display_name || a.hostname)}`)];
    if (!results.length) {
      body.push(el('p', { class: 'muted' }, 'Ingen resultater endnu. Tryk "Kør test".'));
    } else {
      const latest = results[0];
      const t = latest.payload && latest.payload.traffic;
      body.push(el('p', { class: 'muted' }, `Seneste: ${fmtDate(latest.created_at)} · ${results.length} målinger`));

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
          body.push(el('p', { class: 'muted' }, 'CPU % (blå) og memory % (grøn) over tid:'));
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
    body.push(el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: closeModal }, 'Luk')));
    card.replaceChildren(...body);
    $('#modal').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
}

// NetFlow search for an agent: filter by port and/or protocol over a time range,
// see top ports/protocols and (when filtered) a bytes-over-time series.
function showAgentFlows(a) {
  const card = $('#modal-card');
  const portInput = el('input', { type: 'number', placeholder: 'fx 443', min: '1', max: '65535' });
  const protoInput = el('input', { type: 'text', placeholder: 'fx tcp / udp' });
  const result = el('div', {});

  async function search() {
    result.replaceChildren(el('div', { class: 'empty' }, 'Søger…'));
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
    const kids = [el('p', { class: 'muted' }, `${data.measurements} målinger`)];
    if (data.series && data.series.length >= 2) {
      kids.push(trafficChart(data.series.map((s) => ({ rx: s.bytes, tx: 0 }))));
    }
    kids.push(
      el('h4', {}, 'Top porte'),
      data.byPort.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ...['Port', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))), el('tbody', {}, ...portRows))
        : el('div', { class: 'empty' }, 'Ingen flow-data. Er NetFlow-eksport slået til på enheden mod denne agent?'),
      el('h4', {}, 'Top protokoller'),
      data.byProtocol.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ...['Protokol', 'Bytes', 'Flows'].map((h) => el('th', {}, h)))), el('tbody', {}, ...protoRows))
        : el('div', { class: 'empty' }, '–'));
    result.replaceChildren(...kids);
  }

  card.replaceChildren(
    el('h3', {}, `Flows — ${esc(a.display_name || a.hostname)}`),
    el('div', { class: 'form-grid' },
      el('label', {}, 'Port (valgfri)', portInput),
      el('label', {}, 'Protokol (valgfri)', protoInput),
      el('div', { class: 'form-actions' },
        el('button', { onclick: search }, 'Søg'),
        el('button', { class: 'ghost', onclick: closeModal }, 'Luk'))),
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
      el('span', {}, el('span', { class: 'dot rx' }), `RX (maks ${fmtBytes(max)}/s)`),
      el('span', {}, el('span', { class: 'dot tx' }), `TX (maks ${fmtBytes(max)}/s)`)));
}

// Distinct colours for many simultaneous series.
const SERIES_COLORS = ['#38bdf8', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899',
  '#14b8a6', '#eab308', '#fb923c', '#60a5fa', '#34d399', '#f472b6'];

// A large, full-width multi-series line chart. `series` is an array of
// { id, label, color, points:[{x,y}] }. Time (x) is shared; y auto-scales.
function multiChart(seriesList, { height = 320 } = {}) {
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
  for (const s of seriesList) {
    if (!s.points.length) continue;
    const n = s.points.length;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i, n).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    svg.append(mk('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2 }));
  }
  return el('div', { class: 'big-chart' }, svg);
}

// Full-width traffic overview: pick which series to show via checkboxes and
// watch them live. Polls every 3s while open.
// Server storage cards: disk usage (where Docker/DB lives) + database size.
function storageCards(s) {
  const wrap = el('div', { class: 'storage' });
  wrap.append(el('h3', { class: 'storage-h' }, 'Lagerplads (server)'));
  const cards = el('div', { class: 'cards' });

  const d = s.disk || {};
  if (d.available) {
    cards.append(el('div', { class: 'stat' },
      el('div', { class: 'k' }, `Drev ${esc(d.path || '')}`),
      el('div', { class: 'v' }, `${fmtBytes(d.freeBytes)} fri`),
      usageBar(d.usedPercent),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' },
        `${fmtBytes(d.usedBytes)} brugt af ${fmtBytes(d.totalBytes)} (${d.usedPercent}%)`)));
  } else {
    cards.append(el('div', { class: 'stat' }, el('div', { class: 'k' }, 'Drev'),
      el('div', { class: 'v muted' }, 'utilgængelig')));
  }

  const db = s.database || {};
  if (db.error) {
    cards.append(el('div', { class: 'stat' }, el('div', { class: 'k' }, 'Database'),
      el('div', { class: 'v muted' }, 'utilgængelig')));
  } else {
    const biggest = (db.tables && db.tables[0]) || null;
    cards.append(el('div', { class: 'stat' },
      el('div', { class: 'k' }, `Database ${esc(db.name || '')}`),
      el('div', { class: 'v' }, fmtBytes(db.totalBytes)),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' },
        `${db.tableCount} tabeller${biggest ? ` · størst: ${esc(biggest.name)} (${fmtBytes(biggest.bytes)})` : ''}`)));
  }
  wrap.append(cards);
  return wrap;
}

function usageBar(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const cls = p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok';
  return el('div', { class: 'usagebar' }, el('div', { class: `fill ${cls}`, style: `width:${p}%` }));
}

// ---- Analyse (findings + AI assistant) ------------------------------------
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
    el('span', { class: 'muted' }, 'Eksport:'),
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
    el('option', { value: '' }, 'Alle hosts'),
    ...agents.map((a) => el('option',
      { value: String(a.id), ...(String(a.id) === findingsState.hostId ? { selected: 'selected' } : {}) },
      a.display_name || a.hostname)));
  hostSelect.addEventListener('change', () => { findingsState.hostId = hostSelect.value; loadList(); });

  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Analyse — fejl & anomalier'),
    el('span', { class: 'muted' }, 'lokalt beregnet'),
    el('span', { class: 'spacer' }),
    exportButtons('findings', () => (findingsState.hostId ? { hostId: findingsState.hostId } : {})),
    el('label', { class: 'muted inline' }, 'Host ', hostSelect)));

  root.append(assistantBox(() => findingsState.hostId));

  const listHost = el('div', {});
  root.append(listHost);

  async function loadList() {
    listHost.replaceChildren(el('div', { class: 'empty' }, 'Indlæser…'));
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
      listHost.replaceChildren(el('div', { class: 'empty' }, 'Ingen findings endnu. Når en agent rapporterer unormale målinger, dukker de op her.'));
      return;
    }
    const tbody = el('tbody', {}, ...findings.map((f) => findingRow(agentName, f)));
    findingsState.tbody = tbody;
    listHost.replaceChildren(el('table', { class: 'findings' },
      el('thead', {}, el('tr', {}, ...['Tid', 'Host', 'Metric', 'Severity', 'Afvigelse', 'Forklaring', ''].map((h) => el('th', {}, h)))),
      tbody));
  }

  loadList();
  return root;
};

function findingRow(agentName, f) {
  const dev = typeof f.deviation === 'number' ? `${f.deviation.toFixed(1)}σ` : '–';
  const corr = Array.isArray(f.correlatedWith) && f.correlatedWith.length
    ? el('div', { class: 'muted' }, `korreleret med ${f.correlatedWith.length} anden(e)`)
    : null;
  const action = f.acked
    ? el('span', { class: 'muted' }, 'kvitteret')
    : (canWrite() ? el('button', { class: 'small ghost', onclick: (e) => ackFinding(f, e.target) }, 'Kvittér') : null);
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
    toast('Kvitteret');
    const tr = btn && btn.closest('tr');
    if (tr) { tr.classList.add('acked'); btn.replaceWith(el('span', { class: 'muted' }, 'kvitteret')); }
  } catch (err) {
    if (btn) btn.disabled = false;
    toast(err.message, true);
  }
}

// AI-assistant box. Posts to /api/assistant/explain; degrades gracefully when
// the feature is disabled (403) so it never looks broken.
function assistantBox(getHostId) {
  const input = el('input', { type: 'text', placeholder: 'Spørg fx: hvorfor er CPU høj på denne host?' });
  const btn = el('button', { class: 'small' }, 'Spørg assistenten');
  const out = el('div', { class: 'assistant-out muted' }, 'Stil et spørgsmål om en host ud fra de seneste findings.');
  async function ask() {
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    btn.disabled = true;
    out.className = 'assistant-out muted';
    out.textContent = 'Tænker…';
    try {
      const res = await api('/api/assistant/explain', { method: 'POST', body: { question, hostId: getHostId() || undefined } });
      out.className = 'assistant-out';
      out.replaceChildren(
        el('div', {}, res.answer || '(tomt svar)'),
        el('div', { class: 'assistant-meta muted' }, `${esc(res.model || '')} · ${res.usedFindings ?? 0} findings i kontekst`));
    } catch (err) {
      out.className = 'assistant-out muted';
      out.textContent = err.status === 403
        ? 'AI-assistenten er slået fra. Sæt ANALYSIS_ASSISTANT_ENABLED=true (og en API-nøgle) i serverens .env for at bruge den.'
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
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Trafik — overblik'),
    el('span', { class: 'muted' }, 'Vælg serier i panelet · auto hvert 3. sek.')));

  // Server storage: disk free/used + database size.
  const storageHost = el('div', {});
  root.append(storageHost);
  api('/system/storage').then((s) => storageHost.replaceChildren(storageCards(s))).catch(() => {});

  const chartHost = el('div', { class: 'overview-chart' });
  const controls = el('div', { class: 'overview-controls' });
  root.append(el('div', { class: 'overview-grid' }, chartHost, controls));

  // history[seriesId] = [{ y }]; selection is a Set of seriesId.
  const history = new Map();
  const selection = ovState.selection;
  const MAX = 60;
  let agentsMeta = [];

  function pushPoint(id, label, y) {
    if (!history.has(id)) history.set(id, { label, points: [] });
    const h = history.get(id);
    h.label = label;
    h.points.push({ y });
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

    // Default selection on first load: the two totals.
    if (!selection.size) { selection.add('total:rx'); selection.add('total:tx'); }

    renderChart();
    renderControls();
  }

  function renderChart() {
    const chosen = [...selection].filter((id) => history.has(id));
    const seriesList = chosen.map((id, idx) => ({
      id, label: history.get(id).label, color: SERIES_COLORS[idx % SERIES_COLORS.length],
      points: history.get(id).points,
    }));
    const legend = el('div', { class: 'legend' }, ...seriesList.map((s) =>
      el('span', {}, el('span', { class: 'dot', style: `background:${s.color}` }), s.label)));
    chartHost.replaceChildren(
      seriesList.length ? multiChart(seriesList) : el('div', { class: 'empty' }, 'Vælg en eller flere serier →'),
      legend);
  }

  function checkbox(id, label) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = selection.has(id);
    cb.addEventListener('change', () => { if (cb.checked) selection.add(id); else selection.delete(id); renderChart(); });
    return el('label', { class: 'check' }, cb, label);
  }

  function renderControls() {
    const groups = [
      el('div', { class: 'ctrl-group' }, el('h4', {}, 'Total'),
        checkbox('total:rx', 'Total RX'), checkbox('total:tx', 'Total TX')),
    ];
    const perAgent = el('div', { class: 'ctrl-group' }, el('h4', {}, 'Pr. agent'));
    for (const a of agentsMeta) {
      const name = a.display_name || a.hostname;
      perAgent.append(checkbox(`rx:${a.id}`, `${name} · RX`), checkbox(`tx:${a.id}`, `${name} · TX`));
    }
    groups.push(perAgent);
    controls.replaceChildren(...groups);
  }

  // Lifecycle: poll while this view is mounted; stop when leaving.
  stopOverview();
  ovState.timer = setInterval(() => { if (!modalOpen()) tick(); }, 3000);
  tick();
  return root;
};

// Overview polling state, so switching tabs stops it.
const ovState = { timer: null, selection: new Set() };
function stopOverview() { if (ovState.timer) { clearInterval(ovState.timer); ovState.timer = null; } }

// Map of locations with their agents. Uses Leaflet if available; otherwise falls
// back to a list. Each located location gets a marker with agent count/status.
views.map = async () => {
  const [locations, agents] = await Promise.all([api('/locations'), api('/agents')]);
  // Count agents (and how many online) per location.
  const byLoc = new Map();
  for (const a of agents) {
    if (a.location_id == null) continue;
    const e = byLoc.get(a.location_id) || { total: 0, online: 0 };
    e.total += 1;
    if (a.status === 'online') e.online += 1;
    byLoc.set(a.location_id, e);
  }
  const located = locations.filter((l) => l.latitude != null && l.longitude != null);

  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Kort'),
    el('span', { class: 'muted' }, `${located.length} af ${locations.length} lokationer har koordinater`)));

  if (typeof L === 'undefined') {
    root.append(el('div', { class: 'empty' }, 'Kortbiblioteket kunne ikke indlæses (offline?). Viser liste i stedet.'));
    root.append(locationList(locations, byLoc));
    return root;
  }
  if (!located.length) {
    root.append(el('div', { class: 'empty' }, 'Ingen lokationer med koordinater endnu. Tilføj latitude/longitude under fanen Lokationer.'));
    return root;
  }

  const mapEl = el('div', { class: 'map' });
  root.append(mapEl);
  // Leaflet needs the element in the DOM with a size before init — defer a tick.
  setTimeout(() => {
    const map = L.map(mapEl).setView([located[0].latitude, located[0].longitude], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
    const group = [];
    for (const l of located) {
      const c = byLoc.get(l.id) || { total: 0, online: 0 };
      const m = L.marker([l.latitude, l.longitude]).addTo(map);
      m.bindPopup(`<b>${esc(l.name)}</b><br>${c.online}/${c.total} agenter online${l.address ? `<br>${esc(l.address)}` : ''}`);
      group.push([l.latitude, l.longitude]);
    }
    if (group.length > 1) map.fitBounds(group, { padding: [40, 40] });
  }, 0);
  return root;
};

// ---- Geo map (internal sites + external destinations + selection) ---------
const geoState = { map: null, ext: null, hosts: null, rect: null, dests: [], sinceIso: '', panel: null, selecting: false, rectStart: null };

function stopGeo() {
  if (geoState.map) { try { geoState.map.remove(); } catch { /* ignore */ } }
  geoState.map = null; geoState.ext = null; geoState.hosts = null; geoState.rect = null;
  geoState.dests = []; geoState.selecting = false; geoState.rectStart = null;
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

function geoSpinner(text) { return el('div', { class: 'geo-loading' }, el('span', { class: 'spinner' }), text || 'Indlæser…'); }

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
    return el('div', { class: 'empty' }, 'Kortbiblioteket (Leaflet) kunne ikke indlæses — geo-kortet er ikke tilgængeligt offline.');
  }
  const [config, overview] = await Promise.all([api('/api/geo/config'), api('/api/geo/overview')]);

  const root = el('div', { class: 'geo' });
  const periodSel = el('select', {},
    el('option', { value: '24h' }, 'Seneste 24t'),
    el('option', { value: '7d' }, 'Seneste 7 dage'),
    el('option', { value: '30d' }, 'Seneste 30 dage'));
  const regionBtn = el('button', { class: 'small ghost' }, 'Vælg område');
  const clearBtn = el('button', { class: 'small ghost' }, 'Ryd valg');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Geo-kort'),
    el('span', { class: 'spacer' }),
    exportButtons('geo', () => (geoState.sinceIso ? { since: geoState.sinceIso } : {})),
    el('label', { class: 'muted inline' }, 'Periode ', periodSel),
    regionBtn, clearBtn));

  const mapEl = el('div', { class: 'map' });
  const panel = el('div', { class: 'geo-panel' });
  geoState.panel = panel;
  geoState.mapEl = mapEl;
  root.append(el('div', { class: 'geo-grid' }, mapEl, panel));
  root.append(el('div', { class: 'legend geo-legend' },
    el('span', {}, el('span', { class: 'pin-dot' }), ' intern site'),
    el('span', {}, el('span', { class: 'dot', style: 'background:#38bdf8' }), ' normal'),
    el('span', {}, el('span', { class: 'dot', style: 'background:#f59e0b' }), ' forhøjet'),
    el('span', {}, el('span', { class: 'dot', style: 'background:#ef4444' }), ' kraftig afvigelse'),
    el('span', { class: 'muted' }, '· cirkelstørrelse = trafikmængde')));

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
  const map = L.map(geoState.mapEl).setView(center, 3);
  geoState.map = map;
  L.tileLayer(config.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: config.maxZoom || 19,
    attribution: config.attribution || '© OpenStreetMap',
  }).addTo(map);

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
    const m = L.marker([h.lat, h.lng]);
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
  panel.replaceChildren(geoSpinner('Opdaterer…'));
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
  panel.replaceChildren(
    el('div', { class: 'section-head' }, el('h3', {}, 'Overblik')),
    el('p', { class: 'muted' }, `${dests.length} eksterne destinationer · ${fmtBytes(totBytes)} i perioden`),
    el('p', { class: 'muted' }, 'Klik en cirkel (destination) eller en pin (intern site) for detaljer, eller vælg et område.'));
}

async function selectDestination(d) {
  const panel = geoState.panel;
  panel.replaceChildren(geoSpinner('Henter destination…'));
  const qs = destQuery(d);
  try {
    const flows = await api(`/api/geo/select/flows?${qs}`).catch((e) => { if (e.status === 404) return null; throw e; });
    if (!flows) { panel.replaceChildren(el('div', { class: 'empty' }, 'Ingen data for destinationen i perioden.')); return; }
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
      el('span', { class: 'spacer' }), el('button', { class: 'small ghost', onclick: () => { clearRegion(); showOverviewSummary(); } }, 'Ryd valg')),
    el('p', { class: 'muted' }, `${fmtBytes(flows.totals.bytes)} · ${flows.totals.flowCount} flows · afvigelse ${devLabel(d.deviation)}`),
    miniTable('Retning', flows.byDirection.map((x) => [x.direction === 'in' ? 'indgående' : 'udgående', fmtBytes(x.bytes)])),
    miniTable('Protokol', flows.byProto.map((x) => [esc(x.proto || '–'), fmtBytes(x.bytes)])),
    miniTable('ASN', flows.byAsn.map((x) => [esc(x.asnName || (x.asn ? `AS${x.asn}` : '–')), fmtBytes(x.bytes)])),
    el('h4', {}, `Findings (${fs.length})`),
    fs.length ? el('div', {}, ...fs.slice(0, 50).map(findingMini)) : el('div', { class: 'muted' }, 'Ingen findings for de hosts der taler med destinationen.'));
}

async function selectHost(h) {
  const panel = geoState.panel;
  panel.replaceChildren(geoSpinner('Henter host…'));
  try {
    const findings = await api(`/api/findings?hostId=${encodeURIComponent(h.hostId)}`);
    panel.replaceChildren(
      el('div', { class: 'section-head' }, el('h3', {}, esc(h.siteName || `host ${h.hostId}`)),
        el('span', { class: 'spacer' }), el('button', { class: 'small ghost', onclick: showOverviewSummary }, 'Ryd valg')),
      el('p', {}, el('span', { class: `badge ${h.status === 'online' ? 'online' : 'offline'}` }, h.status || '?'), ` host ${h.hostId}`),
      el('h4', {}, `Findings (${findings.length})`),
      findings.length ? el('div', {}, ...findings.slice(0, 50).map(findingMini)) : el('div', { class: 'muted' }, 'Ingen findings for denne host.'));
  } catch (err) {
    panel.replaceChildren(el('div', { class: 'empty error' }, err.message));
  }
}

function beginRegionSelect(btn) {
  if (!geoState.map) return;
  geoState.selecting = true;
  geoState.map.dragging.disable();
  geoState.map.boxZoom.disable();
  toast('Træk en kasse på kortet for at vælge et område');
  if (btn) { btn.classList.add('active-btn'); setTimeout(() => btn.classList.remove('active-btn'), 1500); }
}

function clearRegion() {
  if (geoState.rect && geoState.map) { geoState.map.removeLayer(geoState.rect); }
  geoState.rect = null;
}

async function aggregateRegion(bounds) {
  const panel = geoState.panel;
  const inBox = geoState.dests.filter((d) => bounds.contains([d.lat, d.lng]));
  if (!inBox.length) { panel.replaceChildren(el('div', { class: 'empty' }, 'Ingen destinationer i det valgte område.')); return; }
  const totBytes = inBox.reduce((s, d) => s + (Number(d.bytes) || 0), 0);
  const totFlows = inBox.reduce((s, d) => s + (Number(d.flowCount) || 0), 0);
  panel.replaceChildren(
    el('div', { class: 'section-head' }, el('h3', {}, 'Område'),
      el('span', { class: 'spacer' }), el('button', { class: 'small ghost', onclick: () => { clearRegion(); showOverviewSummary(); } }, 'Ryd valg')),
    el('p', { class: 'muted' }, `${inBox.length} destinationer · ${fmtBytes(totBytes)} · ${totFlows} flows`),
    miniTable('Destinationer', inBox.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 30).map((d) => [esc(destTitle(d)), fmtBytes(d.bytes)])),
    el('div', { class: 'geo-region-findings' }, geoSpinner('Henter findings for området…')));

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
      findings.length ? el('div', {}, ...findings.slice(0, 50).map(findingMini)) : el('div', { class: 'muted' }, 'Ingen findings i området.'));
  }
}

function locationList(locations, byLoc) {
  return el('table', {},
    el('thead', {}, el('tr', {}, ...['Lokation', 'Adresse', 'Koordinater', 'Agenter'].map((h) => el('th', {}, h)))),
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
    caps ? el('div', { class: 'muted', title: 'Agentens muligheder' }, `kan: ${caps.join(', ')}`) : null);
}

function editAgent(a) {
  const mc = a.monitor_config || {};
  const snmp = mc.snmp || {};
  const caps = a.capabilities && Array.isArray(a.capabilities.sources) ? a.capabilities.sources : [];
  // Only offer sources the agent says it supports (fall back to both if unknown).
  const sourceOptions = (caps.length ? caps : ['proc', 'snmp']).map((s) => ({ value: s, label: s }));
  openModal(`Rediger agent ${a.id}`, [
    { name: 'display_name', label: 'Visningsnavn', value: a.display_name || '' },
    { name: 'location_id', label: 'Lokation', type: 'select', value: a.location_id ? String(a.location_id) : '',
      options: [{ value: '', label: '(ingen)' }, ...locationCache.map((l) => ({ value: String(l.id), label: l.name }))] },
    { name: 'notes', label: 'Noter', type: 'textarea', value: a.notes || '' },
    { name: 'source', label: 'Trafik-kilde', type: 'select', value: mc.source || 'proc', options: sourceOptions },
    { name: 'snmp_host', label: 'SNMP host (kun ved snmp)', value: snmp.host || '' },
    { name: 'snmp_community', label: 'SNMP community', value: snmp.community || 'public' },
    { name: 'snmp_version', label: 'SNMP version', type: 'select', value: snmp.version || '2c',
      options: ['1', '2c'].map((s) => ({ value: s, label: s })) },
    { name: 'snmp_port', label: 'SNMP port', type: 'number', value: String(snmp.port || 161) },
    { name: 'netflow_port', label: 'NetFlow UDP-port (kun ved netflow)', type: 'number',
      value: String((mc.netflow && mc.netflow.port) || 2055) },
    { name: 'sflow_port', label: 'sFlow UDP-port (kun ved sflow)', type: 'number',
      value: String((mc.sflow && mc.sflow.port) || 6343) },
  ], async (v) => {
    let monitor_config = null;
    if (v.source === 'snmp') {
      if (!v.snmp_host.trim()) throw new Error('SNMP host er påkrævet ved kilde "snmp"');
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
    closeModal(); toast('Agent opdateret'); render();
  });
}

async function deleteAgent(a) {
  if (!confirm(`Slet agent ${a.hostname}?`)) return;
  try { await api(`/agents/${a.id}`, { method: 'DELETE' }); toast('Agent slettet'); render(); }
  catch (err) { toast(err.message, true); }
}

views.locations = async () => {
  const locations = await api('/locations');
  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Lokationer'),
    canWrite() ? el('button', { class: 'small', onclick: () => editLocation() }, '+ Ny lokation') : null));
  if (!locations.length) { root.append(el('div', { class: 'empty' }, 'Ingen lokationer.')); return root; }
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Navn', 'Beskrivelse', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...locations.map((l) => el('tr', {},
      el('td', {}, String(l.id)),
      el('td', {}, l.name),
      el('td', { class: 'muted' }, l.description || '–'),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'small ghost', onclick: () => showLocationTraffic(l) }, 'Trafik'),
        el('button', { class: 'small ghost', onclick: () => showLocationHistory(l) }, 'Historik'),
        canWrite() ? el('button', { class: 'small ghost', onclick: () => editLocation(l) }, 'Rediger') : null,
        canDelete() ? el('button', { class: 'small danger', onclick: () => deleteLocation(l) }, 'Slet') : null)),
    )))));
  return root;
};

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
        el('h3', {}, `Trafik — ${esc(l.name)}`),
        el('p', { class: 'error' }, err.message),
        el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: close }, 'Luk')));
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
      el('h3', {}, `Trafik — ${esc(l.name)}`),
      el('div', { class: 'cards' },
        stat('Agenter', String(data.agentCount)),
        stat('Rapporterer', String(data.reportingCount)),
        stat('RX i alt', `${fmtBytes(data.totals.rxBytesPerSec)}/s`),
        stat('TX i alt', `${fmtBytes(data.totals.txBytesPerSec)}/s`)),
      history.length >= 2
        ? trafficChart(history)
        : el('p', { class: 'muted' }, 'Samler datapunkter til grafen…'),
      data.agents.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['Agent', 'Status', 'RX/s', 'TX/s', 'Sidst'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows))
        : el('div', { class: 'empty' }, 'Ingen agenter i denne lokation.'),
      el('p', { class: 'muted' }, `Opdateret ${fmtDate(data.at)} · auto hvert 3. sek. · graf: seneste ${history.length} målinger`),
      el('div', { class: 'form-actions' }, el('button', { class: 'ghost', onclick: close }, 'Luk')));
  }

  card.replaceChildren(el('h3', {}, `Trafik — ${esc(l.name)}`), el('div', { class: 'empty' }, 'Indlæser…'));
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
    result.replaceChildren(el('div', { class: 'empty' }, 'Henter…'));
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
      el('p', { class: 'muted' }, `${data.count} målinger · ${data.series.length} tidspunkter`),
      series.length >= 2 ? trafficChart(series) : el('p', { class: 'muted' }, 'For få datapunkter til en graf i dette interval.'),
      data.points.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['Tidspunkt', 'Agent', 'RX/s', 'TX/s'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows))
        : el('div', { class: 'empty' }, 'Ingen data i intervallet.'));
  }

  card.replaceChildren(
    el('h3', {}, `Historik — ${esc(l.name)}`),
    el('div', { class: 'form-grid' },
      el('label', {}, 'Fra', fromInput),
      el('label', {}, 'Til', toInput),
      el('div', { class: 'form-actions' },
        el('button', { onclick: load }, 'Søg'),
        el('button', { class: 'ghost', onclick: closeModal }, 'Luk'))),
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

function editLocation(l) {
  openModal(l ? `Rediger lokation ${l.id}` : 'Ny lokation', [
    { name: 'name', label: 'Navn', value: l ? l.name : '' },
    { name: 'description', label: 'Beskrivelse', type: 'textarea', value: l ? l.description || '' : '' },
    { name: 'address', label: 'Adresse (valgfri)', value: l ? l.address || '' : '' },
    { name: 'latitude', label: 'Breddegrad / latitude (valgfri, -90..90)', value: l && l.latitude != null ? String(l.latitude) : '' },
    { name: 'longitude', label: 'Længdegrad / longitude (valgfri, -180..180)', value: l && l.longitude != null ? String(l.longitude) : '' },
  ], async (v) => {
    const body = {
      name: v.name,
      description: v.description || null,
      address: v.address || null,
      latitude: v.latitude.trim() === '' ? null : Number(v.latitude),
      longitude: v.longitude.trim() === '' ? null : Number(v.longitude),
    };
    if (l) await api(`/locations/${l.id}`, { method: 'PUT', body });
    else await api('/locations', { method: 'POST', body });
    closeModal(); toast('Gemt'); render();
  });
}
async function deleteLocation(l) {
  if (!confirm(`Slet lokation "${l.name}"?`)) return;
  try { await api(`/locations/${l.id}`, { method: 'DELETE' }); toast('Slettet'); render(); }
  catch (err) { toast(err.message, true); }
}

views.enrollment = async () => {
  const [codes, locations] = await Promise.all([api('/enrollment-codes'), api('/locations')]);
  locationCache = locations;
  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Enrollment-koder'),
    canWrite() ? el('button', { class: 'small', onclick: () => createCode() }, '+ Ny kode') : null));
  root.append(el('p', { class: 'muted' }, 'En kode er engangsbrug. Giv koden til agenten ved første opstart (BLUEEYE_ENROLLMENT_CODE).'));
  if (!codes.length) { root.append(el('div', { class: 'empty' }, 'Ingen koder.')); return root; }
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Status', 'Lokation', 'Udløber', 'Oprettet', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...codes.map((c) => el('tr', {},
      el('td', {}, String(c.id)),
      el('td', {}, el('span', { class: `badge ${c.status}` }, c.status)),
      el('td', {}, c.location_name || '–'),
      el('td', { class: 'muted' }, fmtDate(c.expires_at)),
      el('td', { class: 'muted' }, fmtDate(c.created_at)),
      el('td', {}, canDelete() ? el('button', { class: 'small danger', onclick: () => deleteCode(c) }, 'Slet') : null),
    )))));
  return root;
};

function createCode() {
  openModal('Ny enrollment-kode', [
    { name: 'location_id', label: 'Lokation (valgfri)', type: 'select', value: '',
      options: [{ value: '', label: '(ingen)' }, ...locationCache.map((l) => ({ value: String(l.id), label: l.name }))] },
    { name: 'expiresInMinutes', label: 'Levetid (minutter)', type: 'number', value: '60' },
  ], async (v) => {
    const body = {};
    if (v.location_id) body.location_id = Number(v.location_id);
    if (v.expiresInMinutes) body.expiresInMinutes = Number(v.expiresInMinutes);
    const created = await api('/enrollment-codes', { method: 'POST', body });
    closeModal();
    const card = $('#modal-card');
    card.replaceChildren(
      el('h3', {}, 'Kode oprettet'),
      el('p', { class: 'muted' }, 'Kopiér koden nu — den vises kun denne ene gang:'),
      el('pre', {}, esc(created.code)),
      el('div', { class: 'form-actions' }, el('button', {}, 'Luk')));
    card.querySelector('button').addEventListener('click', () => { closeModal(); render(); });
    $('#modal').classList.remove('hidden');
  });
}
async function deleteCode(c) {
  if (!confirm('Slet kode?')) return;
  try { await api(`/enrollment-codes/${c.id}`, { method: 'DELETE' }); toast('Slettet'); render(); }
  catch (err) { toast(err.message, true); }
}

views.users = async () => {
  const users = await api('/users');
  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Brugere'),
    el('button', { class: 'small', onclick: () => editUser() }, '+ Ny bruger')));
  root.append(el('p', { class: 'muted' }, 'Roller: viewer (læs), operator (opret/redigér), admin (alt). Kun admins ser denne fane.'));
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Email', 'Rolle', 'Oprettet', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...users.map((u) => el('tr', {},
      el('td', {}, String(u.id)),
      el('td', {}, u.email),
      el('td', {}, el('span', { class: 'badge' }, u.role),
        u.protected ? el('span', { class: 'badge', title: 'Superadmin — kan ikke ændres/slettes, kun password', style: 'margin-left:6px' }, 'superadmin') : null),
      el('td', { class: 'muted' }, fmtDate(u.created_at)),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'small ghost', onclick: () => editUser(u) }, u.protected ? 'Skift password' : 'Rediger'),
        u.protected ? null : el('button', { class: 'small danger', onclick: () => deleteUser(u) }, 'Slet'))),
    )))));
  return root;
};

const ROLE_OPTIONS = ['viewer', 'operator', 'admin'].map((r) => ({ value: r, label: r }));

function editUser(u) {
  if (u && u.protected) {
    // Super-admin: only a password reset is allowed.
    openModal(`Skift password — ${u.email}`, [
      { name: 'password', label: 'Ny adgangskode (min. 8 tegn)', type: 'password', value: '' },
    ], async (v) => {
      if (!v.password) throw new Error('Indtast en ny adgangskode');
      await api(`/users/${u.id}`, { method: 'PUT', body: { role: 'admin', password: v.password } });
      closeModal(); toast('Adgangskode skiftet'); render();
    });
  } else if (u) {
    // Update: role + optional password reset (email is immutable here).
    openModal(`Rediger ${u.email}`, [
      { name: 'role', label: 'Rolle', type: 'select', value: u.role, options: ROLE_OPTIONS },
      { name: 'password', label: 'Ny adgangskode (valgfri)', type: 'password', value: '' },
    ], async (v) => {
      const body = { role: v.role };
      if (v.password) body.password = v.password;
      await api(`/users/${u.id}`, { method: 'PUT', body });
      closeModal(); toast('Bruger opdateret'); render();
    });
  } else {
    openModal('Ny bruger', [
      { name: 'email', label: 'Email', type: 'email', value: '' },
      { name: 'password', label: 'Adgangskode (min. 8 tegn)', type: 'password', value: '' },
      { name: 'role', label: 'Rolle', type: 'select', value: 'viewer', options: ROLE_OPTIONS },
    ], async (v) => {
      await api('/users', { method: 'POST', body: { email: v.email, password: v.password, role: v.role } });
      closeModal(); toast('Bruger oprettet'); render();
    });
  }
}
async function deleteUser(u) {
  if (!confirm(`Slet bruger ${u.email}?`)) return;
  try { await api(`/users/${u.id}`, { method: 'DELETE' }); toast('Slettet'); render(); }
  catch (err) { toast(err.message, true); }
}

views.license = async () => {
  const s = await api('/license/status');
  const root = el('div');
  root.append(el('div', { class: 'section-head' },
    el('h2', {}, 'Licensstatus'),
    canWrite() ? el('button', { class: 'small', onclick: refreshLicense }, 'Genvalidér nu') : null));
  root.append(el('div', { class: 'cards' },
    stat('Status', el('span', { class: `badge ${s.status}` }, s.status)),
    stat('Licenseret', s.licensed ? 'Ja' : 'Nej'),
    stat('Maks. agenter', String(s.maxAgents)),
    stat('Server-ID', s.serverId || '–'),
    stat('Sidst valideret', fmtDate(s.verifiedAt)),
    stat('Grace udløber', fmtDate(s.graceUntil)),
  ));
  if (s.reason) root.append(el('p', { class: 'muted' }, `Note: ${s.reason}`));
  root.append(el('p', { class: 'muted' }, 'Fornyelse af licensen sker hos udbyderen. Når den er forlænget, tryk "Genvalidér nu" for at hente den opdaterede status med det samme (ellers tjekkes der automatisk hver 6. time).'));
  return root;
};

async function refreshLicense() {
  try {
    const s = await api('/license/refresh', { method: 'POST' });
    invalidateFeatures(); // entitlements may have changed — refresh module visibility now
    toast(`Genvalideret: ${s.status}`);
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
    if (msg && msg.type === 'finding') onLiveFinding(msg.payload);
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
function onLiveFinding(f) {
  if (!f) return;
  const sev = f.severity || 'INFO';
  toast(`Ny finding: ${f.metric} ${sev}`, sev === 'CRIT' || sev === 'WARN');
  // Live-prepend only when the findings table is actually on screen and the
  // active host filter matches; otherwise the REST list will show it next time.
  if (currentView === 'findings' && findingsState.tbody && findingsState.tbody.isConnected) {
    if (!findingsState.hostId || String(f.hostId) === String(findingsState.hostId)) {
      const name = findingsState.agentName || ((id) => `host ${id}`);
      findingsState.tbody.prepend(findingRow(name, f));
    }
  }
}

let currentView = 'overview';
const modalOpen = () => !$('#modal').classList.contains('hidden');

async function render({ silent = false } = {}) {
  if (!token) { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); return; }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  connectLive(); // live findings channel (idempotent)
  await loadFeatures();
  applyFeatureVisibility(); // hide modules not included in the licence
  // Show who is logged in: email + role.
  $('#whoami').replaceChildren(
    el('span', { class: 'who-email' }, email || '—'),
    el('span', { class: `badge role-${role}` }, role));

  // Stop the overview poller when leaving that view (it restarts itself when shown).
  if (currentView !== 'overview') stopOverview();
  // Tear down the Leaflet map when leaving the geo view (it rebuilds on entry).
  if (currentView !== 'geo') stopGeo();

  // Admin-only tabs (e.g. Brugere); send non-admins back to agents if needed.
  for (const b of document.querySelectorAll('.tabs button[data-admin]')) {
    b.classList.toggle('hidden', role !== 'admin');
  }
  if (currentView === 'users' && role !== 'admin') currentView = 'overview';
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === currentView);

  const view = $('#view');
  if (!silent) view.replaceChildren(el('div', { class: 'empty' }, 'Indlæser…'));
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
$('#logout').addEventListener('click', () => { setAutoRefresh(false); stopOverview(); $('#autorefresh').checked = false; logout(); });
$('#refresh').addEventListener('click', () => render());
$('#autorefresh').addEventListener('change', (e) => setAutoRefresh(e.target.checked));
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { closeDrawer(); currentView = b.dataset.view; render(); });
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

render();
