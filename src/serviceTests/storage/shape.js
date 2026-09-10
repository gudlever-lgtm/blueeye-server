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

// Null unless the value is a usable integer — keeps `''`, undefined and NaN out
// of the parameter list, where MySQL would coerce them to 0.
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

module.exports = { parseJson, bool, intOrNull };
