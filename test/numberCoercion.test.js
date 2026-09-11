'use strict';

// The `Number(null) === 0` trap, and a sweep that stops it coming back.
//
// It has bitten three times in this codebase, each time the same way: a value
// that was ABSENT became a real-looking zero, and zero is never neutral here. It
// is "instant", "0 Mbps", "no latency" — always the good end of whatever scale
// it lands on, so missing data read as GOOD NEWS.
//
//   * a journey's duration was the sum of its steps', and came out FASTER when
//     a step had no measurement;
//   * the same journey's duration verdict reported "0 ms, comfortably inside
//     expectation" when nothing had been measured at all;
//   * an agent whose speed test carried no figure was flagged BAD for
//     "Download 0 Mbps" — an outage invented out of absence.
//
// The fix is `numOrNull` (src/lib/num.js, mirrored in
// src/serviceTests/storage/shape.js for the module's extraction boundary). The
// sweep below is what keeps the fix from rotting.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { numOrNull, intOrNull, sumOrNull } = require('../src/lib/num');
const shape = require('../src/serviceTests/storage/shape');

const ROOT = path.join(__dirname, '..');

test('absence stays absent, and a genuine zero stays zero', () => {
  // The whole point: these all coerce to a number with Number(), and none of
  // them is a measurement.
  for (const absent of [null, undefined, '', '   ', [], [5], {}, true, false, new Date(0), NaN, Infinity, -Infinity, 'abc']) {
    assert.equal(numOrNull(absent), null, `${JSON.stringify(absent)} must not become a number`);
  }
  // A real zero is real. Refusing it would be the opposite mistake.
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull(-5.5), -5.5);
  assert.equal(numOrNull('5.5'), 5.5);
});

test('both copies of the helper agree, because they must', () => {
  // src/serviceTests/ may not require from its host (ports.js), so the helper
  // exists twice. Two copies that disagree is how the password-field rule
  // drifted, and this is the guard that stops the same thing happening here.
  for (const v of [null, undefined, '', 0, '0', 5, '5.5', -1, [], {}, true, NaN, Infinity, 'abc']) {
    assert.equal(shape.numOrNull(v), numOrNull(v), `disagreement on ${JSON.stringify(v)}`);
  }
});

test('intOrNull keeps the same absence rules', () => {
  assert.equal(intOrNull(null), null);
  assert.equal(intOrNull(''), null);
  assert.equal(intOrNull(5.5), null, 'a non-integer is not an integer');
  assert.equal(intOrNull(0), 0);
  assert.equal(intOrNull('7'), 7);
  for (const v of [null, undefined, '', 0, 7, 5.5, [], {}, 'abc']) {
    assert.equal(shape.intOrNull(v), intOrNull(v), `disagreement on ${JSON.stringify(v)}`);
  }
});

test('a partial sum reports as unknown, never as a smaller total', () => {
  assert.deepEqual(sumOrNull([800, 400]), { total: 1200, measured: 2, of: 2 });
  // The journey bug, in miniature: 800 would say "faster than expected".
  assert.deepEqual(sumOrNull([800, null]), { total: null, measured: 1, of: 2 });
  assert.deepEqual(sumOrNull([800, '']), { total: null, measured: 1, of: 2 });
  assert.deepEqual(sumOrNull([]), { total: null, measured: 0, of: 0 });
  assert.deepEqual(sumOrNull([0, 0]), { total: 0, measured: 2, of: 2 }, 'genuine zeroes still sum');
});

// ---------------------------------------------------------------- the sweep
//
// `Number.isFinite(Number(x))` is the shape the trap always took: it LOOKS like
// a careful guard and silently accepts null, '' and []. New occurrences are
// refused here rather than found in production.
//
// Not a ban: there are places where 0 genuinely is the right answer for a
// missing value. Those are listed, with the reason, so adding one is a decision
// somebody made on purpose.
const ALLOWED = new Map([
  ['src/lib/num.js', 'the documentation of the trap itself'],
  ['src/routes/forecast.js', 'guarded by `> 0` on the next clause, so null (-> 0) is rejected anyway'],
]);

test('no new Number.isFinite(Number(...)) guards appear outside the allowlist', () => {
  // git grep, so generated files, node_modules and anything untracked stay out.
  let output = '';
  try {
    output = execSync(
      'git grep -n --fixed-strings "Number.isFinite(Number(" -- "src/*.js" "src/**/*.js" "public/*.js" "scripts/*.js"',
      { cwd: ROOT, encoding: 'utf8' }
    );
  } catch (err) {
    // git grep exits 1 when nothing matches, which is a pass.
    if (err.status !== 1) throw err;
    output = '';
  }

  const offenders = output.split('\n').filter(Boolean)
    .map((line) => line.split(':')[0])
    .filter((file) => !file.includes('__tests__') && !ALLOWED.has(file));

  assert.deepEqual([...new Set(offenders)], [],
    'use numOrNull() from src/lib/num.js (or storage/shape.js inside serviceTests) — '
    + 'Number(null) is 0, and a missing measurement must never read as zero. '
    + 'If zero really is right here, add the file to ALLOWED with the reason.');
});

test('the allowlist does not outlive the lines it excuses', () => {
  // An allowlist entry for a file that no longer has the pattern is a licence
  // nobody is using — and the next person to edit that file inherits it silently.
  for (const [file, reason] of ALLOWED) {
    const full = path.join(ROOT, file);
    assert.ok(fs.existsSync(full), `${file} is allowlisted but does not exist`);
    assert.ok(fs.readFileSync(full, 'utf8').includes('Number.isFinite(Number('),
      `${file} no longer has the pattern — drop it from ALLOWED (${reason})`);
  }
});
