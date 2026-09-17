'use strict';

// The layer scale (public/css/tokens.css --z-*).
//
// Three bugs came out of hand-picked z-indexes: the sidebar painted over the
// slide-in drawer, the modal had no z-index at all and went UNDER the sticky
// page chrome, and Leaflet's own panes (400+) leaked into the root stacking
// context and covered the Destination details drawer. The numbers are now one
// ordered scale, and this pins the order — a new overlay picks a token, and a
// token that moves has to move past this test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

function scale() {
  const src = read('css/tokens.css');
  const out = {};
  for (const m of src.matchAll(/--(z-[a-z]+):\s*(\d+)\s*;/g)) out[m[1]] = Number(m[2]);
  return out;
}

test('the layer scale is ordered: page chrome under overlays, toast on top', () => {
  const z = scale();
  const order = ['z-sticky', 'z-inline', 'z-topbar', 'z-sidebar', 'z-popover',
    'z-rowmenu', 'z-scrim', 'z-modal', 'z-toast'];
  for (const name of order) assert.ok(typeof z[name] === 'number', `--${name} is missing from tokens.css`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(z[order[i]] > z[order[i - 1]],
      `--${order[i]} (${z[order[i]]}) must sit above --${order[i - 1]} (${z[order[i - 1]]})`);
  }
  // The three orderings the bugs were about, stated outright.
  assert.ok(z['z-modal'] > z['z-sidebar'], 'the sidebar painted over the drawer');
  assert.ok(z['z-scrim'] > z['z-topbar'], 'the sticky topbar painted over the modal backdrop');
  assert.ok(z['z-toast'] > z['z-modal'], 'a toast raised from a modal must still be readable');
});

test('every stylesheet takes its layer from the scale', () => {
  const sheets = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css'))
    .concat(fs.readdirSync(path.join(PUBLIC, 'css')).filter((f) => f.endsWith('.css')).map((f) => `css/${f}`));
  const offenders = [];
  for (const rel of sheets) {
    if (rel === 'css/tokens.css') continue;
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/z-index:\s*([^;{}]+)/g)) {
      const v = m[1].trim();
      if (/var\(--z-/.test(v) || v === 'auto' || v === '0') continue;
      offenders.push(`${rel}: z-index: ${v}`);
    }
  }
  assert.deepEqual(offenders, [], 'a hand-picked z-index is outside the scale');
});

test("Leaflet's panes are clamped to the map instead of the page", () => {
  // Leaflet numbers .leaflet-pane from 400 up. Without a stacking context of
  // its own the map draws those into the ROOT context, where 400 beats the
  // drawer, the modal and the toast — the "map covers the details panel" bug.
  const src = read('styles.css');
  assert.match(src, /\.leaflet-container\s*\{[^}]*isolation:\s*isolate/,
    'the map must own a stacking context, or its tiles cover every overlay');
});
