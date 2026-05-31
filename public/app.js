'use strict';

// BlueEye server dashboard — dependency-free vanilla JS over the JSON API.
const TOKEN_KEY = 'blueeye.server.token';
const ROLE_KEY = 'blueeye.server.role';

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

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const fmtDate = (s) => (s ? new Date(s).toLocaleString('da-DK') : '–');

// ---- Auth -----------------------------------------------------------------
async function login(email, password) {
  const data = await api('/auth/login', { method: 'POST', body: { email, password } });
  token = data.token;
  role = data.user.role;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
}
function logout() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
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
    try { await onSubmit(values); closeModal(); }
    catch (err) { errP.textContent = err.message; }
  });
  card.replaceChildren(el('h3', {}, title), form);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

// ---- Views ----------------------------------------------------------------
const views = {};
let locationCache = [];

views.agents = async () => {
  const [agents, locations] = await Promise.all([api('/agents'), api('/locations')]);
  locationCache = locations;
  const root = el('div');
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Agenter'), el('span', { class: 'muted' }, `${agents.length} stk.`)));
  if (!agents.length) { root.append(el('div', { class: 'empty' }, 'Ingen agenter endnu. Opret en enrollment-kode under fanen Enrollment.')); return root; }

  const rows = agents.map((a) => el('tr', {},
    el('td', {}, String(a.id)),
    el('td', {}, el('div', {}, a.display_name || a.hostname), a.display_name ? el('div', { class: 'muted' }, a.hostname) : null),
    el('td', {}, `${a.platform} / ${a.arch}`),
    el('td', {}, el('span', { class: `badge ${a.status}` }, a.status)),
    el('td', {}, a.location_name || '–'),
    el('td', {}, agentSourceCell(a)),
    el('td', { class: 'muted' }, fmtDate(a.last_seen)),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'small ghost', onclick: () => showResults(a) }, 'Trafik'),
      canWrite() ? el('button', { class: 'small', onclick: () => runTest(a) }, 'Kør test') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => editAgent(a) }, 'Rediger') : null,
      canDelete() ? el('button', { class: 'small danger', onclick: () => deleteAgent(a) }, 'Slet') : null,
    )),
  ));
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Navn / hostname', 'Platform', 'Status', 'Lokation', 'Kilde', 'Sidst set', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows)));
  return root;
};

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
    toast('Agent opdateret'); render();
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
      data.agents.length
        ? el('table', {},
            el('thead', {}, el('tr', {}, ...['Agent', 'Status', 'RX/s', 'TX/s', 'Sidst'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows))
        : el('div', { class: 'empty' }, 'Ingen agenter i denne lokation.'),
      el('p', { class: 'muted' }, `Opdateret ${fmtDate(data.at)} · auto hvert 3. sek.`),
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

function editLocation(l) {
  openModal(l ? `Rediger lokation ${l.id}` : 'Ny lokation', [
    { name: 'name', label: 'Navn', value: l ? l.name : '' },
    { name: 'description', label: 'Beskrivelse', type: 'textarea', value: l ? l.description || '' : '' },
  ], async (v) => {
    const body = { name: v.name, description: v.description || null };
    if (l) await api(`/locations/${l.id}`, { method: 'PUT', body });
    else await api('/locations', { method: 'POST', body });
    toast('Gemt'); render();
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
      el('td', {}, el('span', { class: 'badge' }, u.role)),
      el('td', { class: 'muted' }, fmtDate(u.created_at)),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'small ghost', onclick: () => editUser(u) }, 'Rediger'),
        el('button', { class: 'small danger', onclick: () => deleteUser(u) }, 'Slet'))),
    )))));
  return root;
};

const ROLE_OPTIONS = ['viewer', 'operator', 'admin'].map((r) => ({ value: r, label: r }));

function editUser(u) {
  if (u) {
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
  root.append(el('div', { class: 'section-head' }, el('h2', {}, 'Licensstatus')));
  root.append(el('div', { class: 'cards' },
    stat('Status', el('span', { class: `badge ${s.status}` }, s.status)),
    stat('Licenseret', s.licensed ? 'Ja' : 'Nej'),
    stat('Maks. agenter', String(s.maxAgents)),
    stat('Server-ID', s.serverId || '–'),
    stat('Sidst valideret', fmtDate(s.verifiedAt)),
    stat('Grace udløber', fmtDate(s.graceUntil)),
  ));
  if (s.reason) root.append(el('p', { class: 'muted' }, `Note: ${s.reason}`));
  return root;
};
function stat(k, v) {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}

// ---- Render ---------------------------------------------------------------
let currentView = 'agents';
const modalOpen = () => !$('#modal').classList.contains('hidden');

async function render({ silent = false } = {}) {
  if (!token) { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); return; }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoami').textContent = role;

  // Admin-only tabs (e.g. Brugere); send non-admins back to agents if needed.
  for (const b of document.querySelectorAll('.tabs button[data-admin]')) {
    b.classList.toggle('hidden', role !== 'admin');
  }
  if (currentView === 'users' && role !== 'admin') currentView = 'agents';
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === currentView);

  const view = $('#view');
  if (!silent) view.replaceChildren(el('div', { class: 'empty' }, 'Indlæser…'));
  try {
    const node = await views[currentView]();
    view.replaceChildren(node);
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
$('#logout').addEventListener('click', () => { setAutoRefresh(false); $('#autorefresh').checked = false; logout(); });
$('#refresh').addEventListener('click', () => render());
$('#autorefresh').addEventListener('change', (e) => setAutoRefresh(e.target.checked));
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { currentView = b.dataset.view; render(); });
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

render();
