'use strict';

// Tab strips — what a tab IS, as opposed to a button that happens to switch a view.
//
// The dashboard drew both the same way until tabStrip() existed: a row of quiet
// buttons, the selected one with a slightly different background, sitting next
// to a form whose Save/Cancel looked identical. These pin the three things that
// make a tab a tab — it looks like one, it is one stop in the keyboard's tab
// order, and it says so to a screen reader — plus the distinction the codebase
// now draws between a tab strip and a rail of destinations.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { JSDOM, VirtualConsole } = require('jsdom');

const { makeApp, tokenFor, makeAgentsRepo } = require('../test-support/fakes');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const AGENTS = [{ id: 1, hostname: 'probe-01', display_name: 'probe-01', status: 'online', capabilities: {}, meta: {}, monitor_config: {} }];

async function boot(t, { role = 'admin' } = {}) {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS, findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null }),
    agentCommander: { sendCommand: () => 1 },
    probeResultsRepo: { latestByAgent: async () => [], findByAgent: async () => [] },
  });
  const token = tokenFor(role, { id: 1, email: 'op@blueeye.local' });
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url: 'http://server.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    let req = request(app)[method.toLowerCase()](String(url)).set('Authorization', `Bearer ${token}`);
    if (opts.body) req = req.set('Content-Type', 'application/json').send(JSON.parse(opts.body));
    const res = await req;
    return {
      ok: res.status < 300, status: res.status,
      headers: { get: (h) => res.headers[String(h).toLowerCase()] },
      json: async () => res.body, text: async () => res.text,
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.scrollTo = () => {};
  window.WebSocket = class { constructor() { this.readyState = 3; } close() {} send() {} addEventListener() {} removeEventListener() {} };
  window.EventSource = window.WebSocket;
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  t.after(() => window.close());
  window.localStorage.setItem('blueeye.server.token', token);
  window.localStorage.setItem('blueeye.server.role', role);
  for (const s of [...window.document.querySelectorAll('script[src]')].map((x) => x.getAttribute('src'))) {
    if (s.startsWith('/')) window.eval(fs.readFileSync(path.join(PUBLIC, s.split('?')[0]), 'utf8'));
  }
  await tick(250);
  return { window, doc: window.document, errors };
}

async function openProbes(doc) {
  doc.querySelector('.tabs button[data-view="probes"]').click();
  await tick(300);
  const strip = doc.querySelector('#view .subtabs');
  assert.ok(strip, 'no tab strip on Probes & Tests');
  return strip;
}

const tabsOf = (strip) => [...strip.querySelectorAll('[role="tab"]')];

test('a tab strip announces itself as one: tablist, tabs, exactly one selected', async (t) => {
  const { doc, errors } = await boot(t);
  const strip = await openProbes(doc);
  assert.equal(strip.getAttribute('role'), 'tablist');
  assert.ok(strip.getAttribute('aria-label'), 'the strip does not say what it switches');
  const tabs = tabsOf(strip);
  assert.equal(tabs.length, 3, `expected three tabs, got ${tabs.length}`);
  const selected = tabs.filter((b) => b.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1, 'a tab strip must have exactly one selected tab');
  assert.ok(selected[0].classList.contains('active'), 'the selected tab is not the active one');
  assert.deepEqual(errors, []);
});

test('a tab does not wear the form buttons\' clothes', async (t) => {
  const { doc } = await boot(t);
  const strip = await openProbes(doc);
  for (const b of tabsOf(strip)) {
    // `ghost` is the quiet FORM button — the very class that made a tab strip
    // indistinguishable from a row of actions.
    assert.ok(!b.classList.contains('ghost'), `${b.textContent}: still styled as a form button`);
    assert.ok(b.classList.contains('subtab'), `${b.textContent}: not carrying the tab class`);
    assert.equal(b.getAttribute('type'), 'button', 'a tab inside a form would submit it');
  }
});

test('the strip is ONE stop in the tab order, and the arrows move inside it', async (t) => {
  const { doc, window } = await boot(t);
  const strip = await openProbes(doc);
  const tabs = tabsOf(strip);
  // Roving tabindex: Tab enters at the selected tab and leaves the strip.
  assert.equal(tabs.filter((b) => b.tabIndex === 0).length, 1, 'more than one tab is in the tab order');
  assert.equal(tabs.find((b) => b.getAttribute('aria-selected') === 'true').tabIndex, 0);

  const key = (node, k) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  tabs[0].focus();
  key(tabs[0], 'ArrowRight');
  assert.equal(doc.activeElement, tabs[1], 'ArrowRight did not move to the next tab');
  key(tabs[1], 'ArrowLeft');
  assert.equal(doc.activeElement, tabs[0], 'ArrowLeft did not move back');
  key(tabs[0], 'ArrowLeft');
  assert.equal(doc.activeElement, tabs[tabs.length - 1], 'the strip does not wrap around');
  key(tabs[tabs.length - 1], 'Home');
  assert.equal(doc.activeElement, tabs[0], 'Home did not jump to the first tab');
  key(tabs[0], 'End');
  assert.equal(doc.activeElement, tabs[tabs.length - 1], 'End did not jump to the last tab');

  // Moving focus does NOT switch the view: each of these tabs renders a screen
  // and calls the API, so arrowing past one must not load it.
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'focus alone switched the tab');
});

test('activating a tab switches the view and moves the selection', async (t) => {
  const { doc } = await boot(t);
  let strip = await openProbes(doc);
  const before = tabsOf(strip).map((b) => b.textContent);
  tabsOf(strip)[1].click();
  await tick(350);
  // The screen re-renders, so the strip is a new node — find it again.
  strip = doc.querySelector('#view .subtabs');
  const tabs = tabsOf(strip);
  assert.deepEqual(tabs.map((b) => b.textContent), before, 'the strip lost its tabs on a switch');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(tabs.filter((b) => b.getAttribute('aria-selected') === 'true').length, 1);
  assert.ok(doc.querySelector('.connection-test'), 'the second tab did not open its screen');
});

test('a rail of destinations is not a tab strip, and says so', async (t) => {
  const { doc } = await boot(t);
  doc.querySelector('.tabs button[data-view="settings"]').click();
  await tick(400);
  const rail = doc.querySelector('.settings-nav .navlist');
  assert.ok(rail, 'the settings rail is missing');
  assert.equal(rail.getAttribute('role'), null, 'a rail of separate screens must not claim to be a tablist');
  assert.equal(doc.querySelector('.settings-nav .subtabs'), null, 'the settings rail is still using the tab class');
  // It keeps the quiet-chip look on purpose — these are destinations, not tabs.
  assert.ok([...rail.querySelectorAll('button')].every((b) => b.classList.contains('ghost')));
});
