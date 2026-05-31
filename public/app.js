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
  if (res.status === 401) {
    logout();
    throw new Error('Session udløbet — log ind igen.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* no body (e.g. 204) */ }
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
    el('td', { class: 'muted' }, fmtDate(a.last_seen)),
    el('td', {}, el('div', { class: 'row-actions' },
      el('button', { class: 'small ghost', onclick: () => showResults(a) }, 'Trafik'),
      canWrite() ? el('button', { class: 'small', onclick: () => runTest(a) }, 'Kør test') : null,
      canWrite() ? el('button', { class: 'small ghost', onclick: () => editAgent(a) }, 'Rediger') : null,
      canDelete() ? el('button', { class: 'small danger', onclick: () => deleteAgent(a) }, 'Slet') : null,
    )),
  ));
  root.append(el('table', {},
    el('thead', {}, el('tr', {}, ...['ID', 'Navn / hostname', 'Platform', 'Status', 'Lokation', 'Sidst set', ''].map((h) => el('th', {}, h)))),
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
      body.push(el('p', { class: 'muted' }, `Seneste: ${fmtDate(latest.created_at)}`));
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

function editAgent(a) {
  openModal(`Rediger agent ${a.id}`, [
    { name: 'display_name', label: 'Visningsnavn', value: a.display_name || '' },
    { name: 'location_id', label: 'Lokation', type: 'select', value: a.location_id ? String(a.location_id) : '',
      options: [{ value: '', label: '(ingen)' }, ...locationCache.map((l) => ({ value: String(l.id), label: l.name }))] },
    { name: 'notes', label: 'Noter', type: 'textarea', value: a.notes || '' },
  ], async (v) => {
    await api(`/agents/${a.id}`, { method: 'PUT', body: {
      display_name: v.display_name || null,
      location_id: v.location_id ? Number(v.location_id) : null,
      notes: v.notes || null,
      meta: a.meta || null,
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
        canWrite() ? el('button', { class: 'small ghost', onclick: () => editLocation(l) }, 'Rediger') : null,
        canDelete() ? el('button', { class: 'small danger', onclick: () => deleteLocation(l) }, 'Slet') : null)),
    )))));
  return root;
};

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
async function render() {
  if (!token) { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); return; }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoami').textContent = role;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === currentView);
  const view = $('#view');
  view.replaceChildren(el('div', { class: 'empty' }, 'Indlæser…'));
  try {
    const node = await views[currentView]();
    view.replaceChildren(node);
  } catch (err) {
    view.replaceChildren(el('div', { class: 'empty error' }, err.message));
  }
}

// ---- Wire up --------------------------------------------------------------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try { await login($('#email').value, $('#password').value); render(); }
  catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', logout);
$('#refresh').addEventListener('click', render);
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => { currentView = b.dataset.view; render(); });
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

render();
