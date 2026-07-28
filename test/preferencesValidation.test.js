'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validatePreferences, THEMES, LOCALES } = require('../src/validation/preferencesValidation');
const I18n = require('../public/i18n');

test('accepts every theme in the catalogue', () => {
  for (const theme of THEMES) {
    const { value, errors } = validatePreferences({ theme });
    assert.equal(errors, undefined, `theme ${theme} should be valid`);
    assert.deepEqual(value, { theme });
  }
});

test('rejects an unknown theme', () => {
  const { value, errors } = validatePreferences({ theme: 'rainbow' });
  assert.equal(value, undefined);
  assert.ok(errors.theme);
});

test('rejects a non-string theme', () => {
  assert.ok(validatePreferences({ theme: 123 }).errors.theme);
  assert.ok(validatePreferences({ theme: null }).errors.theme);
});

test('ignores unknown keys but still validates known ones', () => {
  const { value, errors } = validatePreferences({ theme: 'dark', density: 'cozy' });
  assert.equal(errors, undefined);
  assert.deepEqual(value, { theme: 'dark' }); // unknown key dropped
});

test('rejects an empty patch (nothing recognised to update)', () => {
  assert.ok(validatePreferences({}).errors.preferences);
});

test('rejects a non-object body', () => {
  assert.ok(validatePreferences(null).errors.preferences);
  assert.ok(validatePreferences([]).errors.preferences);
  assert.ok(validatePreferences('dark').errors.preferences);
  assert.ok(validatePreferences(7).errors.preferences);
});

test('accepts every locale in the catalogue', () => {
  for (const locale of LOCALES) {
    const { value, errors } = validatePreferences({ locale });
    assert.equal(errors, undefined, `locale ${locale} should be valid`);
    assert.deepEqual(value, { locale });
  }
});

test('rejects an unknown or non-string locale', () => {
  assert.ok(validatePreferences({ locale: 'klingon' }).errors.locale);
  assert.ok(validatePreferences({ locale: 'da-DK' }).errors.locale); // full tags are not codes
  assert.ok(validatePreferences({ locale: 42 }).errors.locale);
  assert.ok(validatePreferences({ locale: null }).errors.locale);
});

test('theme and locale can be patched together', () => {
  const { value, errors } = validatePreferences({ theme: 'nord', locale: 'da' });
  assert.equal(errors, undefined);
  assert.deepEqual(value, { theme: 'nord', locale: 'da' });
});

test('server LOCALES matches the dashboard catalogue in public/i18n.js', () => {
  // The whitelist and the string catalogue must not drift: a locale the server
  // accepts but the dashboard cannot render would leave the UI in English with
  // no way back through the picker.
  assert.deepEqual([...LOCALES].sort(), [...I18n.LOCALES].sort());
});

test('every colour palette has both a light and a dark variant', () => {
  for (const k of [
    'light', 'dark',
    'midnight', 'midnight-light',
    'nord', 'nord-light',
    'forest', 'forest-light',
    'sunset', 'sunset-light',
    'solarized-light', 'solarized-dark',
    'contrast', 'contrast-light',
  ]) {
    assert.ok(THEMES.includes(k), `expected theme ${k}`);
  }
});
