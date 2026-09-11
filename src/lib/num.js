'use strict';

// Number coercion that does not invent measurements.
//
// THE TRAP THIS EXISTS TO CLOSE:
//
//     Number(null)            === 0
//     Number(undefined)       === NaN      (this one is safe)
//     Number('')              === 0
//     Number([])              === 0
//     Number.isFinite(0)      === true
//
// So the natural-looking guard
//
//     Number.isFinite(Number(row.duration_ms)) ? Number(row.duration_ms) : null
//
// turns a MISSING value into a real-looking zero. And zero is never neutral in
// this codebase: it is "instant", "0 Mbps", "no latency", "free" — always the
// good end of whatever scale it lands on. Missing data then reads as good news,
// which is the one direction monitoring must never err in.
//
// It has bitten three times now: a journey whose duration was the sum of its
// steps came out FASTER when a step was unmeasured; the same journey's duration
// verdict reported "0 ms, comfortably inside expectation" when nothing had been
// measured at all; and an agent with no speed-test reading was flagged BAD for
// "Download 0 Mbps".
//
// Use `numOrNull` wherever a value may be absent and zero would be a lie.

// A finite number, or null. `null`, `undefined` and `''` are ABSENCE and come
// back as null; a genuine 0 comes back as 0.
function numOrNull(value) {
  if (value === null || value === undefined) return null;
  // `Number([])` is 0 and `Number(true)` is 1. Neither is a measurement, and an
  // empty array in particular is the same kind of absence as null.
  if (typeof value === 'boolean' || typeof value === 'object') return null;
  // `Number('')` is 0 and so is `Number('   ')` — an empty column and a padded
  // one are both absence, and CHAR columns pad.
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// An integer, or null. Same absence rules.
function intOrNull(value) {
  const n = numOrNull(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

// Sums values that may be absent, and says so rather than guessing.
//
//   { total, measured, of }   total is null unless EVERY value was present.
//
// A partial sum compared against a whole expectation reads as a speed-up when it
// is really a missing measurement — so the caller is handed the counts and has
// to decide, instead of being handed a number that looks complete.
function sumOrNull(values) {
  const list = Array.isArray(values) ? values : [];
  let total = 0;
  let measured = 0;
  for (const v of list) {
    const n = numOrNull(v);
    if (n === null) continue;
    total += n;
    measured += 1;
  }
  return { total: measured === list.length && list.length > 0 ? total : null, measured, of: list.length };
}

module.exports = { numOrNull, intOrNull, sumOrNull };
