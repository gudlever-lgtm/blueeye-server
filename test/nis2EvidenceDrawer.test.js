'use strict';

// NIS2 evidence references (public/nis2Evidence.js), opened from a row in the
// NIS2 Controls register inside the real dashboard.
//
// The behaviour that must survive: the drawer lists what is attached to THAT
// record (entityType + entityId go to the server), an operator can attach a
// reference (POST carries the record it belongs to) and remove one (DELETE by
// id), the server's validation message lands under the field it is about, and
// a viewer can read the list but gets no form.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

function boot({ t, routes = {}, url = 'http://server.test/reporting/nis2', role = 'admin' } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  const log = [];
  window.fetch = async (u, opts = {}) => {
    const p = String(u).split('?')[0];
    const key = `${(opts.method || 'GET').toUpperCase()} ${p}`;
    log.push({ key, url: String(u), body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes[key];
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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

const CONTROL = { id: 5, controlName: 'Quarterly restore test', nis2Area: 'Business continuity', owner: 'ops', frequency: 'quarterly', status: 'OK', hasEvidence: true };
const EVIDENCE = [{ id: 31, title: 'Q3 restore report', fileUrl: 'https://wiki.x.dk/restore-q3', description: null, entityType: 'control', entityId: 5, uploadedByEmail: 'x@y.dk', createdAt: '2026-09-20T10:00:00.000Z' }];
const SESSION = (over = {}) => Object.assign({
  'GET /me': { id: 1, email: 'x@y.dk', role: 'admin', preferences: {} },
  'GET /auth/sso': { methods: [] },
  'GET /license': { plan: 'professional', features: {} },
  'GET /api/nis2/dashboard': { readinessScore: 0, categories: [], topActions: [] },
  'GET /api/nis2/controls': [CONTROL],
  'GET /api/nis2/evidence': EVIDENCE,
  'POST /api/nis2/evidence': { status: 201, body: { id: 32 } },
  'DELETE /api/nis2/evidence/31': { status: 204, body: null },
}, over);

async function openControls(doc, window) {
  const tab = [...doc.querySelectorAll('#view [role="tab"]')].find((b) => b.textContent === 'Controls');
  tab.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle();
  const row = [...doc.querySelectorAll('#view tr')].find((r) => /Quarterly restore test/.test(r.textContent));
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Evidence').click();
  await settle();
  return doc.querySelector('.ui-drawer');
}

test('the drawer lists the evidence attached to that control', async (t) => {
  const { doc, window, errors, log } = boot({ t, routes: SESSION() });
  await settle();
  const drawer = await openControls(doc, window);
  assert.deepEqual(errors, []);
  assert.ok(drawer);
  const get = log.find((l) => l.key === 'GET /api/nis2/evidence');
  assert.match(get.url, /entityType=control&entityId=5/);
  assert.match(drawer.textContent, /Evidence · Quarterly restore test/);
  const a = drawer.querySelector('a[href="https://wiki.x.dk/restore-q3"]');
  assert.ok(a, 'a web link is clickable');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.match(drawer.textContent, /never the file itself/);
});

test('an operator attaches a reference to THIS record, and removes one by id', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION() });
  await settle();
  const drawer = await openControls(doc, window);
  drawer.querySelector('#nis2ev-title').value = 'Review minutes';
  drawer.querySelector('#nis2ev-url').value = '/share/nis2/minutes.pdf';
  [...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Attach').click();
  await settle();
  const post = log.find((l) => l.key === 'POST /api/nis2/evidence');
  assert.deepEqual(post.body, { title: 'Review minutes', fileUrl: '/share/nis2/minutes.pdf', description: null, entityType: 'control', entityId: 5 });

  [...doc.querySelector('.ui-drawer').querySelectorAll('button')].find((b) => b.textContent === 'Remove').click();
  await settle();
  assert.ok(log.some((l) => l.key === 'DELETE /api/nis2/evidence/31'));
});

test('a missing title is caught before sending; the server\'s message lands under its field', async (t) => {
  const { doc, window, log } = boot({ t, routes: SESSION({
    'POST /api/nis2/evidence': { status: 400, body: { error: 'Validation failed', details: { fileUrl: 'fileUrl must be an http(s) URL or an absolute path' } } },
  }) });
  await settle();
  const drawer = await openControls(doc, window);
  const attach = [...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Attach');
  attach.click();
  await settle();
  assert.equal(log.filter((l) => l.key === 'POST /api/nis2/evidence').length, 0, 'an empty title was sent');
  assert.match(drawer.querySelector('#nis2ev-title').parentNode.textContent, /A title is required/);

  drawer.querySelector('#nis2ev-title').value = 'x';
  drawer.querySelector('#nis2ev-url').value = 'javascript:alert(1)';
  attach.click();
  await settle();
  const url = drawer.querySelector('#nis2ev-url');
  assert.equal(url.getAttribute('aria-invalid'), 'true');
  assert.match(url.parentNode.querySelector('.field-error').textContent, /http\(s\) URL or an absolute path/);
});

test('a viewer reads the list and gets no form', async (t) => {
  const { doc, window } = boot({ t, role: 'viewer', routes: SESSION({ 'GET /me': { id: 2, email: 'v@y.dk', role: 'viewer', preferences: {} } }) });
  await settle();
  const drawer = await openControls(doc, window);
  assert.match(drawer.textContent, /Q3 restore report/);
  assert.equal(drawer.querySelector('#nis2ev-title'), null);
  assert.equal([...drawer.querySelectorAll('button')].filter((b) => b.textContent === 'Remove').length, 0);
});
