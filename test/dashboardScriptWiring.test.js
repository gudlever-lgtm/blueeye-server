'use strict';

// public/app.js reaches its helper modules through globals they register on
// `window` (there is no build step and no module loader). If a module is not
// script-tagged in index.html, the global is undefined and the FIRST row that
// touches it throws — a blank table, no build error, nothing in the tests.
//
// That is how the events table would have broken when eventTitle.js was added.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

// `root.Foo = ` in a public/*.js is that file registering the global `Foo`.
function registeredGlobals() {
  const out = new Map();
  for (const f of fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of src.matchAll(/\broot\.([A-Z][A-Za-z0-9]*)\s*=/g)) out.set(m[1], f);
  }
  return out;
}

test('every window.* helper app.js uses is script-tagged in index.html', () => {
  const registry = registeredGlobals();
  assert.ok(registry.size > 3, `expected several public/ modules, found ${registry.size}`);

  const used = new Set([...app.matchAll(/\bwindow\.([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]));
  const missing = [];
  for (const name of used) {
    const file = registry.get(name);
    if (!file) continue; // not one of ours (a browser built-in, or set by app.js itself)
    if (!new RegExp(`<script[^>]+src=["']/?${file.replace('.', '\\.')}["']`).test(html)) {
      missing.push(`window.${name} comes from public/${file}, which index.html never loads`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('every script index.html loads from public/ actually exists', () => {
  const missing = [];
  for (const m of html.matchAll(/<script[^>]+src=["']\/([A-Za-z0-9_.-]+\.js)["']/g)) {
    if (!fs.existsSync(path.join(PUBLIC, m[1]))) missing.push(m[1]);
  }
  assert.deepEqual(missing, [], `index.html loads scripts that do not exist: ${missing.join(', ')}`);
});
