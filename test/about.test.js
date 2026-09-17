'use strict';

// The About page — the account menu's "About", and the dated feature history
// behind it (public/about.js).
//
// Three claims are being checked, and they are different:
//
//   1. The history is well-formed — every entry carries a version, a real date,
//      a known area and BOTH languages, and the list runs newest first. A
//      history that is out of order is a history nobody trusts.
//   2. It does not claim a build that does not exist. Nothing in the list may
//      be newer than the version in package.json: the page is read next to the
//      build stamp in the sidebar foot, and the two must agree.
//   3. It survives the version lookup failing. GET /system/version is the
//      garnish (viewer+, and it can 403/404/500); the history is the page. A
//      failure there costs the build line, never the list.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const About = require('../public/about.js');
const I18n = require('../public/i18n');
const pkg = require('../package.json');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

const SEMVER = /^\d+\.\d+\.\d+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// ---------------------------------------------------------------- the data
test('every history entry carries a version, a date, a known area and both languages', () => {
  assert.ok(About.RELEASES.length >= 40, `only ${About.RELEASES.length} entries`);
  for (const e of About.RELEASES) {
    const where = `${e.v} (${e.d})`;
    assert.match(e.v, SEMVER, `${where}: version`);
    assert.match(e.d, ISO_DAY, `${where}: date`);
    assert.ok(!Number.isNaN(Date.parse(`${e.d}T00:00:00Z`)), `${where}: unparseable date`);
    assert.ok(About.AREAS.includes(e.area), `${where}: unknown area ${e.area}`);
    for (const locale of I18n.LOCALES) {
      assert.ok(e[locale], `${where}: no ${locale} text`);
      assert.ok(e[locale].t && e[locale].t.trim(), `${where}: empty ${locale} title`);
      assert.ok(e[locale].s && e[locale].s.trim(), `${where}: empty ${locale} summary`);
    }
    // A Danish entry that is a verbatim copy of the English one is an entry
    // somebody forgot to translate, not a translation.
    assert.notEqual(e.da.s, e.en.s, `${where}: the Danish summary is the English one`);
  }
});

test('the history runs newest first, by date and then by version', () => {
  for (let i = 1; i < About.RELEASES.length; i += 1) {
    const prev = About.RELEASES[i - 1];
    const cur = About.RELEASES[i];
    assert.ok(prev.d >= cur.d, `${prev.v} (${prev.d}) is listed above ${cur.v} (${cur.d})`);
    if (prev.d === cur.d) assert.ok(cmp(prev.v, cur.v) >= 0, `${prev.v} is listed above ${cur.v} on ${cur.d}`);
  }
});

test('no entry claims a version newer than this build', () => {
  for (const e of About.RELEASES) {
    assert.ok(cmp(e.v, pkg.version) <= 0, `${e.v} is newer than package.json (${pkg.version})`);
  }
});

test('every area label the page can print exists in BOTH locales', () => {
  const keys = ['about.filter.all'].concat(About.AREAS.map((a) => About.AREA_KEYS[a]));
  for (const key of keys) {
    assert.ok(key, 'an area has no catalogue key');
    for (const locale of I18n.LOCALES) assert.ok(I18n.has(key, locale), `${key} missing in ${locale}`);
  }
  // Every area is actually used; an empty filter chip is a dead control.
  for (const area of About.AREAS) {
    assert.ok(About.RELEASES.some((e) => e.area === area), `no entry in area ${area}`);
  }
});

test('grouping buckets by month, newest month first, and labels it in the active language', () => {
  const groups = About.byMonth(About.RELEASES);
  const buckets = groups.map((g) => g.bucket);
  assert.deepEqual(buckets, [...buckets].sort().reverse(), 'months are out of order');
  assert.equal(new Set(buckets).size, buckets.length, 'the same month appears twice');
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), About.RELEASES.length);
  assert.match(About.monthLabel('2026-09', 'en'), /September 2026/);
  assert.match(About.monthLabel('2026-09', 'da'), /2026/);
  assert.equal(About.monthLabel('2026-09', 'da').toLowerCase().includes('september'), true);
});

// ---------------------------------------------------------------- in a real DOM
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const p = String(url).split('?')[0];
    const hit = routes[`${(opts.method || 'GET').toUpperCase()} ${p}`];
    const status = hit === undefined ? 404 : (hit.status || 200);
    const body = hit === undefined ? { error: 'Not Found', path: p } : (hit.body !== undefined ? hit.body : hit);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

async function boot(t, routes = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.fetch = fakeFetch({
    'GET /me': { id: 1, email: 'op@blueeye.local', role: 'viewer', preferences: {} },
    'GET /auth/sso': { methods: [] },
    'GET /license': { plan: 'professional', features: {} },
    ...routes,
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', 'T');
  window.localStorage.setItem('blueeye.server.role', 'viewer');
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick();
  return { window, doc: window.document, errors };
}

async function openAbout(doc) {
  const trigger = doc.querySelector('#user-menu-trigger');
  trigger.click();
  await tick(20);
  const item = doc.querySelector('#user-menu-panel button[data-view="about"]');
  assert.ok(item, 'no About entry in the account menu');
  item.click();
  await tick(120);
  return item;
}

test('the account menu opens About, and the menu closes behind it', async (t) => {
  const { doc, errors } = await boot(t, { 'GET /system/version': { server: pkg.version, releaseDate: pkg.releaseDate } });
  await openAbout(doc);
  assert.deepEqual(errors, []);
  const page = doc.querySelector('#view .about');
  assert.ok(page, 'the About page did not render');
  assert.ok(doc.querySelector('#user-menu-panel').classList.contains('hidden'), 'the account menu stayed open over the page it opened');
  assert.equal(doc.querySelector('#user-menu-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(doc.querySelectorAll('#view .about-item').length, About.RELEASES.length);
  assert.equal(doc.querySelectorAll('#view .about-month').length, About.byMonth(About.RELEASES).length);
  assert.match(doc.querySelector('#view .about-build-ver').textContent, new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));
  assert.ok(doc.querySelector('#view .about-build').textContent.includes(pkg.releaseDate), 'the release date is not shown');
  // The page carries its own help hero, like every other view.
  const hero = doc.querySelector('#view .hero');
  assert.ok(hero, 'no help hero for the About page');
  assert.equal(hero.querySelector('.hero-text').textContent, I18n.STRINGS.en['about.info.hero']);
});

test('a filter chip narrows the list to one area and the count follows', async (t) => {
  const { doc } = await boot(t, { 'GET /system/version': { server: pkg.version, releaseDate: pkg.releaseDate } });
  await openAbout(doc);
  const chips = [...doc.querySelectorAll('#view .about-filters .chip')];
  assert.equal(chips.length, About.AREAS.length + 1, 'one chip per area, plus "everything"');
  const idx = About.AREAS.indexOf('assurance') + 1;
  chips[idx].click();
  await tick(30);
  const expected = About.RELEASES.filter((e) => e.area === 'assurance').length;
  assert.equal(doc.querySelectorAll('#view .about-item').length, expected);
  assert.equal(doc.querySelector('#view .about-filters .chip.active').getAttribute('aria-pressed'), 'true');
  assert.match(doc.querySelector('#view .about-count').textContent, new RegExp(String(expected)));
});

// The version lookup is the garnish. 403 (no role), 404 (an endpoint that
// moved) and 500 (a broken server) each cost the build line — never the page.
for (const status of [403, 404, 500]) {
  test(`the history still renders when GET /system/version answers ${status}`, async (t) => {
    const { doc, errors } = await boot(t, { 'GET /system/version': { status, body: { error: 'nope' } } });
    await openAbout(doc);
    assert.deepEqual(errors, []);
    assert.equal(doc.querySelectorAll('#view .about-item').length, About.RELEASES.length, `${status} took the history down`);
    assert.equal(doc.querySelector('#view .about-build-ver').textContent, '—', `${status}: a version was invented`);
  });
}

test('the page follows the language switch', async (t) => {
  const { doc, window } = await boot(t, { 'GET /system/version': { server: pkg.version, releaseDate: pkg.releaseDate }, 'PUT /me/preferences': { ok: true } });
  await openAbout(doc);
  const firstEn = doc.querySelector('#view .about-item-title').textContent;
  assert.equal(firstEn, About.RELEASES[0].en.t);
  doc.querySelector('#user-menu-trigger').click();
  await tick(20);
  const da = [...doc.querySelectorAll('#lang-switch button')].find((b) => b.textContent === 'DA');
  da.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(120);
  assert.equal(window.I18n.getLocale(), 'da');
  assert.equal(doc.querySelector('#view .about-item-title').textContent, About.RELEASES[0].da.t);
  assert.equal(doc.querySelector('#user-menu-panel button[data-view="about"] [data-i18n]').textContent, I18n.STRINGS.da['nav.about']);
  // The page chrome follows too — the history is data, the frame around it is
  // the catalogue, and half a translated page is the bug worth catching.
  assert.equal(doc.querySelector('#view .about-filters .chip').textContent.replace(/\d+$/, '').trim(), I18n.STRINGS.da['about.filter.all']);
  assert.equal(doc.querySelector('#view .section-head h2').textContent, I18n.STRINGS.da['about.title']);
  assert.match(doc.querySelector('#view .about-month').textContent.toLowerCase(), /september 2026/);
});
