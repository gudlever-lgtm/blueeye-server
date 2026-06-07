'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validatePreferences, THEMES } = require('../src/validation/preferencesValidation');

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
