'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');

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
