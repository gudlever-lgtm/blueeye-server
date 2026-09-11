'use strict';

// Small shared helpers for the Service Tests repositories. Kept deliberately
// tiny: repositories take the pool in and hand plain objects out, and nothing
// here knows about HTTP, Express or Playwright.

// mysql2 hands JSON columns back either parsed or as a string depending on the
// driver/column, so every read normalises. A malformed value degrades to the
// fallback rather than throwing on a list read.
function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

const bool = (v) => !!v;

// A finite number, or null — `null`, `undefined` and `''` are ABSENCE, and a
// genuine 0 is a genuine 0.
//
// Written out here rather than required from src/lib/num.js because nothing
// under src/serviceTests/ may reach into its host (ports.js). Same rule, same
// reason: `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious
// guard turns a missing measurement into a real-looking zero — and zero is never
// neutral. It is "instant", "no latency", "free": always the good end of the
// scale, so missing data reads as good news.
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  // `Number([])` is 0 and `Number(true)` is 1 — neither is a measurement.
  if (typeof v === 'boolean' || typeof v === 'object') return null;
  // `Number('')` and `Number('   ')` are both 0; a padded CHAR column is absence.
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Null unless the value is a usable integer — keeps `''`, undefined and NaN out
// of the parameter list, where MySQL would coerce them to 0.
function intOrNull(v) {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

module.exports = { parseJson, bool, intOrNull, numOrNull };
