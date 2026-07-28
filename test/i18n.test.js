'use strict';

// Unit tests for the dashboard translation layer (public/i18n.js): lookup +
// locale fallback, {name} interpolation, locale resolution, and the relative-time
// helper. No DOM — the module is required directly, so `root` is null and the
// <html lang>/localStorage side effects are no-ops.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const I18n = require('../public/i18n');

test('t() returns the string for the active locale', () => {
  I18n.setLocale('en');
  assert.equal(I18n.t('notes.title'), 'Work log');
  I18n.setLocale('da');
  assert.equal(I18n.t('notes.title'), 'Arbejdslog');
  I18n.setLocale('en');
});

test('t() takes an explicit locale override without changing the active one', () => {
  I18n.setLocale('en');
  assert.equal(I18n.t('notes.title', null, 'da'), 'Arbejdslog');
  assert.equal(I18n.getLocale(), 'en');
});

test('t() falls back to en for a key missing from the active locale', () => {
  // Inject a key that only exists in en, then read it through da.
  I18n.STRINGS.en['test.onlyEnglish'] = 'English only';
  try {
    I18n.setLocale('da');
    assert.equal(I18n.t('test.onlyEnglish'), 'English only');
  } finally {
    delete I18n.STRINGS.en['test.onlyEnglish'];
    I18n.setLocale('en');
  }
});

test('t() returns the key itself when it exists in no locale', () => {
  // A visible key in the UI beats a silent empty string.
  assert.equal(I18n.t('nope.not.a.real.key'), 'nope.not.a.real.key');
  assert.equal(I18n.t(''), '');
  assert.equal(I18n.t(null), '');
});

test('t() interpolates {name} placeholders', () => {
  I18n.setLocale('en');
  assert.equal(I18n.t('search.empty', { q: '10.0.0.1' }), 'Nothing matched “10.0.0.1”.');
  assert.equal(I18n.t('changes.truncated', { shown: 50, total: 231 }),
    'Showing the first 50 of 231 changes.');
});

test('t() leaves an unmatched placeholder verbatim rather than blanking it', () => {
  assert.equal(I18n.t('search.empty', {}), 'Nothing matched “{q}”.');
  assert.equal(I18n.t('search.empty'), 'Nothing matched “{q}”.');
  assert.equal(I18n.t('search.empty', { q: null }), 'Nothing matched “{q}”.');
});

test('interpolation handles a zero / false param (not treated as missing)', () => {
  assert.equal(I18n.t('common.minutesAgo', { n: 0 }), '0 min ago');
});

test('resolveLocale: preference wins, then browser tag, then default', () => {
  assert.equal(I18n.resolveLocale('da', 'en-GB'), 'da');
  assert.equal(I18n.resolveLocale(null, 'da-DK'), 'da');
  assert.equal(I18n.resolveLocale(undefined, 'DA'), 'da');
  assert.equal(I18n.resolveLocale(null, 'fr-FR'), 'en');
  assert.equal(I18n.resolveLocale('klingon', 'fr'), 'en');
  assert.equal(I18n.resolveLocale(null, null), 'en');
});

test('setLocale ignores an unsupported code and keeps the current one', () => {
  I18n.setLocale('da');
  assert.equal(I18n.setLocale('xx'), 'da');
  assert.equal(I18n.getLocale(), 'da');
  I18n.setLocale('en');
});

test('has() reports per-locale key presence', () => {
  assert.equal(I18n.has('notes.title', 'en'), true);
  assert.equal(I18n.has('notes.title', 'da'), true);
  assert.equal(I18n.has('nope.missing', 'en'), false);
});

test('da catalogue has no untranslated keys (parity with en)', () => {
  // Not a hard requirement at runtime — missing keys fall back to English — but
  // the shipped catalogue should be complete, so a gap fails here first.
  assert.deepEqual(I18n.missingKeys('da'), []);
});

test('every catalogue placeholder is present in both locales', () => {
  // A da string that drops a {placeholder} the en string has would silently lose
  // information; catch that here rather than in the UI.
  const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
  for (const key of Object.keys(I18n.STRINGS.en)) {
    if (!I18n.has(key, 'da')) continue;
    assert.deepEqual(
      placeholders(I18n.STRINGS.da[key]),
      placeholders(I18n.STRINGS.en[key]),
      `placeholder mismatch for "${key}"`
    );
  }
});

test('relativeTime buckets into just now / minutes / hours / days', () => {
  I18n.setLocale('en');
  const now = Date.parse('2026-07-28T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(I18n.relativeTime(ago(10 * 1000), now), 'just now');
  assert.equal(I18n.relativeTime(ago(5 * 60 * 1000), now), '5 min ago');
  assert.equal(I18n.relativeTime(ago(3 * 3600 * 1000), now), '3 h ago');
  assert.equal(I18n.relativeTime(ago(50 * 3600 * 1000), now), '2 d ago');
});

test('relativeTime handles null / unparseable input without throwing', () => {
  I18n.setLocale('en');
  assert.equal(I18n.relativeTime(null), 'never');
  assert.equal(I18n.relativeTime(''), 'never');
  assert.equal(I18n.relativeTime(undefined), 'never');
  assert.equal(I18n.relativeTime('not a date'), 'unknown');
});

test('relativeTime accepts a Date instance', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  assert.equal(I18n.relativeTime(new Date(now - 7 * 60 * 1000), now), '7 min ago');
});

test('storedLocale returns null when there is no localStorage (node)', () => {
  assert.equal(I18n.storedLocale(), null);
});
