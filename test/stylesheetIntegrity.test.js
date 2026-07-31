'use strict';

// The dashboard has no build step and no CSS linter, so a malformed stylesheet
// fails SILENTLY: the browser drops the offending rule (and often the one after
// it) and the page simply renders slightly wrong. That is exactly what happened
// while fixing the changes feed — a comment left unclosed by one line swallowed
// the `.chg-indicates` rule, and the only symptom was an un-indented sentence.
//
// These are structural checks, not a parser: cheap, and they catch the class of
// mistake that hand-edited CSS actually suffers from.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_DIR = path.join(__dirname, '..', 'public');
const sheets = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));

// Strip comments and quoted strings so the brace scan sees only real syntax.
function stripNoise(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

test('every stylesheet has balanced comment delimiters', () => {
  assert.ok(sheets.length > 0, 'expected at least one stylesheet');
  for (const f of sheets) {
    const css = fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
    const opens = (css.match(/\/\*/g) || []).length;
    const closes = (css.match(/\*\//g) || []).length;
    assert.equal(opens, closes, `${f}: ${opens} "/*" vs ${closes} "*/" — an unclosed comment eats the rules after it`);

    // A `*/` with no `/*` before it means prose is sitting in rule position:
    // the stray-text case, which drops the very next declaration block.
    let depth = 0;
    for (const m of css.matchAll(/\/\*|\*\//g)) {
      depth += m[0] === '/*' ? 1 : -1;
      assert.ok(depth >= 0, `${f}: stray "*/" at offset ${m.index} — comment text has leaked into rule position`);
      assert.ok(depth <= 1, `${f}: nested "/*" at offset ${m.index} — CSS comments do not nest`);
    }
  }
});

test('every stylesheet has balanced braces', () => {
  for (const f of sheets) {
    const css = stripNoise(fs.readFileSync(path.join(CSS_DIR, f), 'utf8'));
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        assert.ok(depth >= 0, `${f}: a "}" closes a block that was never opened`);
      }
    }
    assert.equal(depth, 0, `${f}: ${depth} unclosed block(s)`);
  }
});

// `flex-basis: 100%` plus a left margin is 100% + the margin: the item is wider
// than its container and pushes a horizontal scrollbar onto the whole page. It
// is a real bug the changes feed shipped with; padding (under the global
// `box-sizing: border-box`) is the fix, so keep the pattern out.
// Resolves the LEFT margin of a declaration block, honouring the shorthand:
// 1 value → all sides; 2 or 3 → left is the 2nd (the horizontal one); 4 → the
// 4th. Getting this wrong flags `margin: 1px 0 6px`, whose left margin is 0.
function hasLeftMargin(body) {
  const isZero = (v) => v === '0' || /^0[a-z%]*$/i.test(v);
  const explicit = /(?:^|;)\s*margin-left\s*:\s*([^;]+)/i.exec(body);
  if (explicit) return !isZero(explicit[1].trim());
  const short = /(?:^|;)\s*margin\s*:\s*([^;]+)/i.exec(body);
  if (!short) return false;
  const parts = short[1].trim().split(/\s+/);
  const left = parts.length >= 4 ? parts[3] : (parts.length >= 2 ? parts[1] : parts[0]);
  return !isZero(left);
}

test('no full-basis flex item is indented with a margin instead of padding', () => {
  for (const f of sheets) {
    const css = fs.readFileSync(path.join(CSS_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/\{([^{}]*)\}/g)) {
      const body = m[1];
      if (!/flex\s*:\s*[\d.]+\s+[\d.]+\s+100%/.test(body) && !/flex-basis\s*:\s*100%/.test(body)) continue;
      assert.ok(
        !hasLeftMargin(body),
        `${f}: a flex-basis:100% item carries a left margin, so it overflows its container — use padding-left instead:\n{${body.trim()}}`
      );
    }
  }
});
