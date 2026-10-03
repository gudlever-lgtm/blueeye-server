'use strict';

// Settings → Data → Map → "Hop locations you have corrected", booted in jsdom
// against a fake fetch.
//
// WHY IT LIVES THERE. A correction answers the same question the GeoIP card
// above it answers — where does the map get a position from — so it sits beside
// it rather than behind a nav entry of its own. What must survive: the list is
// read in lookup order (longest prefix first, as the server sends it), a viewer
// sees it but is offered no way to change it, an operator can add, edit and
// remove, and a licence that excludes geo says so instead of showing an empty
// table.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const CORRECTIONS = [
  {
    ip: '193.162.153.9', prefixLen: 32, lat: 56.1629, lng: 10.2039, city: 'Aarhus', country: 'DK',
    source: 'manual', note: 'measured from the Aarhus agent', createdBy: 1, createdByName: 'Lars',
    createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z',
  },
  {
    ip: '193.162.153.0', prefixLen: 24, lat: 55.6761, lng: 12.5683, city: 'Copenhagen', country: 'DK',
    source: 'manual', note: null, createdBy: 1, createdByName: 'Lars',
    createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z',
  },
  {
    ip: '80.0.0.0', prefixLen: 8, lat: 52.3676, lng: 4.9041, city: null, country: 'NL',
    source: 'ripe', note: 'RIPE geoloc', createdBy: null, createdByName: null,
    createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-01T09:00:00Z',
  },
];

function boot({ t, routes = {}, role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, {
    url: 'http://server.test/settings/map', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const [p, qs] = String(u).split('?');
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push(qs ? `${key}?${qs}` : key);
    if (opts.body) log.push(`BODY ${opts.body}`);
    let hit = routes[key];
    if (typeof hit === 'function') hit = hit(new URLSearchParams(qs || ''));
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found' } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  if (t) t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src')).filter((x) => x.startsWith('/') && !x.startsWith('/vendor/'))) {
    window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  return { window, doc: window.document, errors, log };
}

const settle = () => new Promise((r) => setTimeout(r, 250));

const SESSION = (role, over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'lars@example.dk', role, preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/settings': {
    map: { tileUrl: 'https://{s}.tile.example.eu/{z}/{x}/{y}.png', tileAttribution: 'x', tileMaxZoom: 19, geocoderUrl: 'https://geo.example.eu' },
    geoip: { configured: true, ranges: 10, dbPath: '/data/geoip.csv', city: {} },
  },
  'GET /api/geo/hops': { corrections: CORRECTIONS, active: { size: 3, loadedAt: '2026-10-01T09:00:00Z' } },
}, over);

const card = (doc) => [...doc.querySelectorAll('#view .settings-card')]
  .find((c) => /Hop locations you have corrected/.test((c.querySelector('h3') || {}).textContent || ''));
const button = (root, re) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));

test('the corrections sit on Settings → Map, in lookup order, with source and note', async (t) => {
  const { doc, errors } = boot({ t, routes: SESSION('admin') });
  await settle();
  assert.deepEqual(errors, []);
  const c = card(doc);
  assert.ok(c, 'the card is on the Map settings screen');
  const rows = [...c.querySelectorAll('.hopfix-row')].filter((r) => !r.classList.contains('hopfix-head'));
  assert.equal(rows.length, 3);
  // Longest prefix first — the order the lookup itself reads them in.
  assert.deepEqual(rows.map((r) => r.firstChild.textContent), ['193.162.153.9/32', '193.162.153.0/24', '80.0.0.0/8']);
  assert.match(rows[0].textContent, /Aarhus, DK/);
  assert.match(rows[0].textContent, /56\.1629, 10\.2039/);
  assert.match(rows[0].textContent, /measured from the Aarhus agent/);
  assert.match(rows[0].textContent, /Corrected/);
  // An imported row says where it came from, and has no author.
  assert.match(rows[2].textContent, /RIPE/);
  assert.match(c.textContent, /3 correction\(s\) stored · 3 in use right now/);
});

test('Settings → Map is admin-only, so the corrections are too', async (t) => {
  const { doc } = boot({ t, routes: SESSION('viewer'), role: 'viewer' });
  await settle();
  // A non-admin is never offered the tab the card lives on — the card's own
  // operator check behind it is the second lock, not the first.
  assert.equal(card(doc), undefined);
  assert.equal([...doc.querySelectorAll('#view button')].some((b) => /^Map$/.test(b.textContent.trim())), false);
});

test('an empty table explains where corrections come from', async (t) => {
  const { doc } = boot({ t, routes: SESSION('admin', { 'GET /api/geo/hops': { corrections: [], active: { size: 0 } } }) });
  await settle();
  assert.match(card(doc).textContent, /No corrections yet/);
});

test('a licence without geo says so instead of showing an empty table', async (t) => {
  const { doc } = boot({ t, routes: SESSION('admin', { 'GET /api/geo/hops': { status: 403, body: { error: 'Feature not included' } } }) });
  await settle();
  assert.match(card(doc).textContent, /not part of this licence/);
});

test('Edit opens the stored row with its own prefix, locked, and can remove it', async (t) => {
  const { doc, log } = boot({ t, routes: SESSION('admin', { 'GET /api/map/config': { tileUrl: '', attribution: '', maxZoom: 19 }, 'DELETE /api/geo/hops': { removed: 1 } }) });
  await settle();
  const rows = [...card(doc).querySelectorAll('.hopfix-row')].filter((r) => !r.classList.contains('hopfix-head'));
  button(rows[2], /^Edit$/).click(); // the /8 — a prefix the two presets do not offer
  await settle();
  const modal = doc.querySelector('#modal-card');
  assert.match(modal.textContent, /Correction for 80\.0\.0\.0\/8/);
  const scope = modal.querySelector('select');
  assert.equal(scope.value, '8', 'the row keeps the prefix it was written with');
  assert.equal(scope.disabled, true, 'the key of an existing row is not re-scoped by editing it');
  // Removing it deletes exactly that row.
  button(modal, /Remove correction/).click();
  await settle();
  assert.ok(log.some((l) => l === 'DELETE /api/geo/hops?ip=80.0.0.0&prefixLen=8'), log.filter((l) => l.includes('hops')).join('\n'));
});

test('Add correction asks for the address, and a CIDR carries its own prefix', async (t) => {
  const { doc, log } = boot({
    t,
    routes: SESSION('admin', {
      'GET /api/map/config': { tileUrl: '', attribution: '', maxZoom: 19 },
      'PUT /api/geo/hops': { correction: { ip: '5.5.5.0', prefixLen: 24 } },
    }),
  });
  await settle();
  button(card(doc), /Add correction/).click();
  await settle();
  const modal = doc.querySelector('#modal-card');
  const addr = modal.querySelector('input[type="text"]');
  assert.equal(addr.disabled, false, 'a new correction needs an address typed');
  addr.value = '5.5.5.0/24';
  // The coordinate field of the point picker is the second text input.
  const coords = [...modal.querySelectorAll('input[type="text"]')][1];
  coords.value = '55.6761, 12.5683';
  button(modal, /Save location/).click();
  await settle();
  const sent = log.find((l) => l.startsWith('BODY ') && l.includes('5.5.5.0'));
  assert.ok(sent, log.join('\n'));
  const body = JSON.parse(sent.slice(5));
  assert.equal(body.ip, '5.5.5.0/24');
  assert.equal(body.prefixLen, undefined, 'a CIDR carries its own prefix; the select does not override it');
  assert.equal(body.lat, 55.6761);
});
