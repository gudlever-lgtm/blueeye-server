'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const fs = require('fs');
const path = require('path');

const { makeApp } = require('../test-support/fakes');

const PUBLIC = path.join(__dirname, '..', 'public');

// The dashboard's look is carried by one token scale in public/styles.css
// (radii, elevation, hairlines, easing) that every palette re-themes for free.
// These tests guard the scale itself: a surface that hard-codes a radius or an
// rgba tint drops out of the palette system silently, which is exactly the
// class of change nobody notices until a customer switches theme.

test('GET /styles.css serves the stylesheet (no 404/500 for the dashboard chrome)', async () => {
  const res = await request(makeApp()).get('/styles.css');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/css/);
});

test('a stylesheet that does not exist is a 404, not a 500', async () => {
  const res = await request(makeApp()).get('/does-not-exist.css');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not Found');
});

test('the soft-surface token scale is defined on :root', async () => {
  const css = (await request(makeApp()).get('/styles.css')).text;
  for (const token of [
    '--radius-xs:', '--radius-sm:', '--radius:', '--radius-lg:', '--radius-pill:',
    '--shadow:', '--shadow-md:', '--shadow-lg:',
    '--hairline:', '--hover:', '--ring:', '--ease:',
  ]) {
    assert.ok(css.includes(token), `${token} is part of the token scale`);
  }
  // Dark palettes restate the elevation tokens (a light shadow disappears on a
  // dark panel), so the dark override block must stay in place.
  assert.match(css, /\[data-theme="midnight"\][\s\S]{0,200}--shadow:/);
});

test('panel radii come from the token scale, not from literal pixels', async () => {
  const css = (await request(makeApp()).get('/styles.css')).text;
  // Panel-scale radii (6–12px) are tokens. Small decorative radii (dots, 2–5px
  // bars) are still literal — they are shapes, not surfaces.
  const literals = css.match(/border-radius: (?:6|7|8|9|10|11|12)px/g) || [];
  assert.deepEqual(literals, [], `these should use var(--radius*): ${literals.join(', ')}`);
});

test('status tints are derived from the palette, not hard-coded rgba', async () => {
  const css = (await request(makeApp()).get('/styles.css')).text;
  const at = css.indexOf('\n.badge {'); // the base rule, not `.storage-store .badge {`
  const badgeBlock = css.slice(at, at + 1200);
  assert.match(badgeBlock, /\.badge\.online[^\n]*var\(--ok-weak\)/);
  assert.match(badgeBlock, /\.badge\.offline[^\n]*var\(--warn-weak\)/);
  assert.match(badgeBlock, /\.badge\.revoked[^\n]*var\(--bad-weak\)/);
  // The green/amber/red literals the badges used to carry are gone everywhere,
  // so a custom palette re-tints every status surface with it.
  for (const literal of ['rgba(34,197,94,.15)', 'rgba(245,158,11,.15)', 'rgba(239,68,68,.15)']) {
    assert.ok(!css.includes(literal), `${literal} should be a *-weak token`);
  }
});

test('.fs-chip is scoped to its two owners (fleet summary vs analysis severity)', async () => {
  const css = (await request(makeApp()).get('/styles.css')).text;
  // Two unrelated components share the class name; unscoped, the second block
  // silently restyled the first.
  assert.match(css, /\.fleet-summary \.fs-chip \{/);
  assert.match(css, /\.fs-chips \.fs-chip \{/);
  assert.ok(!/\n\.fs-chip \{/.test(css), 'no unscoped .fs-chip rule remains');
});

// A button that repaints its background and forgets its text colour inherits
// `color: var(--btn-fg)` from the base `button` rule — white, for the accent
// surface. On a panel-coloured button that is white on white: the control is
// there, reads as empty, and looks like a rendering bug rather than a styling
// one. It happened to the phase legend, where six named steps came out as six
// bare dots.
//
// The classes are read out of the SOURCE rather than guessed from the
// stylesheet: `.sa-chip` is a span and `.sa-segmented` is a div, and a sweep
// that cannot tell those from a button is a sweep somebody switches off.
function buttonClasses() {
  const found = new Set();
  for (const file of ['app.js', 'serviceAssurance.js', 'guides.js']) {
    const source = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    // el('button', { ... class: 'a b' ... }) — the literal classes only; a
    // computed one is not something this sweep can follow, and pretending
    // otherwise would make it lie in the reassuring direction.
    const calls = source.match(/el\(\s*'button'\s*,\s*\{[^}]*\}/g) || [];
    for (const call of calls) {
      const m = call.match(/class\s*:\s*'([^']+)'/);
      if (!m) continue;
      for (const name of m[1].split(/\s+/).filter(Boolean)) {
        // A bare state word (`active`, `rx`, `ok`) is on half the page and
        // cannot identify a rule; the repo's real component classes are
        // hyphenated (`sa-phase-key`, `fs-chip`). Plain `button` rules are
        // matched by the element selector instead, so nothing is lost.
        if (name.includes('-')) found.add(name);
      }
    }
  }
  return found;
}

// Rules are read in cascade, so `.fs-chip.active { background: … }` is fine when
// `.fs-chip { color: … }` sits above it. This collects the classes that some
// rule DOES give a colour to — excluding the base `button` rule, which is the
// one handing out the white in the first place.
function colouredClasses(css, blocks) {
  const out = new Set();
  for (const { selector, body } of blocks) {
    if (selector === 'button') continue;
    if (!/(^|[;\s])color\s*:/.test(body)) continue;
    for (const m of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

function rulesOf(css) {
  return (css.match(/[^{}]+\{[^{}]*\}/g) || []).map((block) => {
    const at = block.indexOf('{');
    return {
      selector: block.slice(0, at).replace(/\/\*[\s\S]*?\*\//g, '').trim(),
      body: block.slice(at + 1, -1),
    };
  });
}

test('a button that repaints its background states its text colour too', async () => {
  const app = makeApp();
  const classes = buttonClasses();
  assert.ok(classes.size >= 5, `the sweep found only ${classes.size} button classes — it has stopped reading the source`);

  const offenders = [];
  for (const sheet of ['/styles.css', '/serviceAssurance.css']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).get(sheet);
    assert.equal(res.status, 200, `${sheet} is not served`);
    const blocks = rulesOf(res.text);
    const coloured = colouredClasses(res.text, blocks);

    for (const { selector, body } of blocks) {
      if (selector.startsWith('@') || selector.startsWith(':root')) continue;
      // A state rule inherits the base rule's colour on purpose.
      if (/:(hover|focus|active|disabled|focus-visible)/.test(selector)) continue;
      if (!/(^|[;\s])background(-color)?\s*:/.test(body)) continue;
      if (/background(-color)?\s*:\s*(none|transparent|inherit|unset)/.test(body)) continue;
      if (/(^|[;\s])color\s*:/.test(body)) continue;

      const hit = [...classes].filter((name) => new RegExp(`\\.${name}(?![\\w-])`).test(selector));
      const isButtonElement = /(^|[\s,>+~])button\b/.test(selector);
      if (!hit.length && !isButtonElement) continue;
      // Some other rule already gives this component a colour.
      if (hit.some((name) => coloured.has(name))) continue;
      offenders.push(`${sheet}: ${selector}`);
    }
  }

  assert.deepEqual(offenders, [],
    'these rules repaint a button surface without setting a text colour, so the '
    + `label inherits var(--btn-fg) and disappears:\n  ${offenders.join('\n  ')}`);
});
