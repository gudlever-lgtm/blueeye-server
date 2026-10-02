'use strict';

// A CARD HAS TO LOOK LIKE A CARD — measured, not eyeballed.
//
// The elevation scale gave every surface a shadow, and the page still read as
// flat. The reason was not the shadow: on the default light palette the page
// (#f7f7f6) and a card (#ffffff) were 1.07:1 apart, which the eye reads as
// "the same colour", and the card's edge was 1.24:1. A resting shadow is
// deliberately soft, so with both other signals that weak there was nothing
// left to carry the boundary. Buttons had it twice over — a secondary button
// is panel-coloured ON a panel, so its ONLY signal is that same edge.
//
// Two floors, checked for every palette, because "it looks fine in the one I
// use" is how thirteen of the others drifted:
//
//   SURFACE  page → panel ≥ 1.18   a card separates from the page by its FILL,
//                                  not only by its shadow
//   CONTROL  panel → border ≥ 1.45 a button or field on that card has an edge
//                                  you can find
//
// The numbers are ratios from WCAG's relative luminance. They are far below
// the 3:1 and 4.5:1 thresholds that apply to TEXT, and deliberately so: this
// is about seeing where a surface ends, not about reading it. What matters is
// that they are above the floor where a step stops being a step.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TOKENS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'tokens.css'), 'utf8');

const SURFACE_FLOOR = 1.18;
const CONTROL_FLOOR = 1.45;

const channels = (h) => { const x = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
const linear = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (h) => { const [r, g, b] = channels(h); return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b); };
const contrast = (a, b) => {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
};

// Every palette block that declares the three colours this is about. The
// grouped elevation blocks declare none of them, so they fall out on their own.
function palettes() {
  const found = [];
  const seen = new Set();
  for (const m of TOKENS.matchAll(/(:root|\[data-theme="([a-z-]+)"\])\s*\{([^}]*)\}/g)) {
    const name = m[2] || 'light (:root)';
    const body = m[3];
    const read = (key) => {
      const hit = new RegExp(`--${key}:\\s*(#[0-9a-f]{6})`, 'i').exec(body);
      return hit && hit[1];
    };
    const bg = read('bg');
    const panel = read('panel');
    const border = read('border');
    if (!bg || !panel || !border || seen.has(name)) continue;
    seen.add(name);
    found.push({ name, bg, panel, border });
  }
  return found;
}

test('every palette declares the three colours this is measured on', () => {
  const found = palettes();
  // Sixteen in the file; the count is here so a palette that silently loses
  // its --bg or --border drops out of the sweep instead of passing it.
  assert.ok(found.length >= 14, `only ${found.length} palettes carry bg/panel/border`);
  for (const p of found) assert.match(p.panel, /^#[0-9a-f]{6}$/i, p.name);
});

test('a card separates from the page by its fill, in every palette', () => {
  const thin = palettes()
    .map((p) => ({ ...p, ratio: contrast(p.bg, p.panel) }))
    .filter((p) => p.ratio < SURFACE_FLOOR)
    .map((p) => `${p.name}: page ${p.bg} vs panel ${p.panel} = ${p.ratio.toFixed(3)}`);
  assert.deepEqual(thin, [],
    `below ${SURFACE_FLOOR}:1 the page and the card read as one colour, and the shadow is left carrying the boundary alone`);
});

test('a control on that card has an edge you can find, in every palette', () => {
  const thin = palettes()
    .map((p) => ({ ...p, ratio: contrast(p.panel, p.border) }))
    .filter((p) => p.ratio < CONTROL_FLOOR)
    .map((p) => `${p.name}: panel ${p.panel} vs border ${p.border} = ${p.ratio.toFixed(3)}`);
  assert.deepEqual(thin, [],
    `below ${CONTROL_FLOOR}:1 a secondary button on a card is an edgeless rectangle — its fill is the card's own colour`);
});

test('the surface line stays lighter than the control line', () => {
  // --hairline rides on --border, so strengthening the border strengthens it
  // too. The ordering is the point: a surface edge must be quieter than a
  // control edge, or the page goes back to reading as a grid of boxes.
  const hairline = /--hairline:\s*color-mix\(in srgb, var\(--border\) (\d+)%/.exec(TOKENS);
  assert.ok(hairline, '--hairline is no longer derived from --border');
  const pct = Number(hairline[1]);
  assert.ok(pct > 0 && pct < 100, `--hairline at ${pct}% is not a mix`);
  for (const p of palettes()) {
    const mixed = channels(p.border).map((v, i) => Math.round(v * (pct / 100) + channels(p.panel)[i] * (1 - pct / 100)));
    const hair = `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    assert.ok(contrast(p.panel, hair) < contrast(p.panel, p.border),
      `${p.name}: the hairline must be quieter than the border it is derived from`);
    assert.ok(contrast(p.panel, hair) >= 1.2,
      `${p.name}: hairline ${contrast(p.panel, hair).toFixed(3)} — a surface edge nobody can see is not an edge`);
  }
});
