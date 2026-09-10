'use strict';

// A scripted stand-in for the Playwright driver.
//
// Because execute.js talks to an interface rather than to Playwright, the entire
// meaning of a test — step order, credential resolution, conditional blocks,
// stop-at-first-failure, assertion outcomes — is exercised here with no browser
// and no network. That is the payoff of the driver seam, and this file is what
// collects it.
//
//   const driver = makeFakeDriver({
//     page: { url: 'https://app.test/login', text: { 'Dashboard': 'Dashboard' } },
//     present: ['Username', 'Password', 'Login'],
//     failOn: { click: new Error('Timeout 30000ms exceeded') },
//   });
function makeFakeDriver(opts = {}) {
  const calls = [];
  const present = new Set(opts.present || []);
  const visible = new Set(opts.visible || opts.present || []);
  const texts = opts.texts || {};
  const failOn = opts.failOn || {};
  let url = opts.url || 'https://app.test/';
  let status = opts.status ?? 200;

  // A target's identity for the fake: the first hint it carries. Enough to say
  // "is this element present" without reimplementing a locator engine.
  const key = (target) => {
    if (!target) return '';
    return target.name || target.label || target.text || target.placeholder || target.id || target.role || target.css || '';
  };

  const record = (method, ...args) => {
    calls.push({ method, args });
    const failure = failOn[method];
    if (failure) {
      if (typeof failure === 'function') failure(...args);
      else throw failure;
    }
  };

  return {
    calls,
    methodsCalled: () => calls.map((c) => c.method),
    async open(u) { record('open', u); url = u.startsWith('http') ? u : `https://app.test${u}`; return { status, url }; },
    async back() { record('back'); return { status, url }; },
    async refresh() { record('refresh'); return { status, url }; },
    async click(t) { record('click', key(t)); },
    async fill(t, v) { record('fill', key(t), v); },
    async clear(t) { record('clear', key(t)); },
    async select(t, v) { record('select', key(t), v); },
    async setChecked(t, c) { record('setChecked', key(t), c); },
    async upload(t, f) { record('upload', key(t), f); },
    async exists(t) { record('exists', key(t)); return present.has(key(t)); },
    async visible(t) { record('visible', key(t)); return visible.has(key(t)); },
    async textOf(t) { record('textOf', key(t)); return texts[key(t)] ?? ''; },
    async currentUrl() { return url; },
    async waitFor(t) { record('waitFor', key(t)); },
    async sleep(ms) { record('sleep', ms); },
    async login(cred) { record('login', cred && cred.username, cred && cred.secret); },
    async logout() { record('logout'); },
    async apiRequest(req) { record('apiRequest', req.method, req.url); status = opts.apiStatus ?? 200; return { status }; },
    async consoleErrors() { return opts.consoleErrors || []; },
    async networkErrors() { return opts.networkErrors || []; },
    async screenshot() { return opts.screenshot ?? null; },
  };
}

module.exports = { makeFakeDriver };
