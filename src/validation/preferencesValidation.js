'use strict';

// Per-user UI preferences are stored as a small JSON blob. Whitelist new keys
// here — anything not listed is ignored (forward-compatible).
//
// THEMES must stay in sync with the [data-theme="…"] blocks in
// public/styles.css and the THEMES catalogue in public/app.js.
// LOCALES must stay in sync with the LOCALES list in public/i18n.js.
const THEMES = [
  'light',
  'dark',
  'midnight',
  'midnight-light',
  'nord',
  'nord-light',
  'forest',
  'forest-light',
  'sunset',
  'sunset-light',
  'solarized-light',
  'solarized-dark',
  'contrast',
  'contrast-light',
];

// Dashboard language. `en` is the reference locale; a string absent from a
// locale's catalogue falls back to English rather than rendering empty, so
// adding a locale here is safe even before its catalogue is complete.
const LOCALES = ['en', 'da'];

// Information density. `standard` leads with clarity; `compact` fits more rows
// and more technical detail on a screen for somebody who reads this product all
// day. Both show exactly the SAME things — it is row height and padding, never
// a feature that is present in one and absent in the other, because a mode that
// hides capability is a mode nobody can be told to switch on.
const DENSITIES = ['standard', 'compact'];

// Validates a preferences patch. Unknown keys are ignored (forward-compatible),
// but at least one recognised, valid key must be present. Returns
// { value } on success or { errors } on failure (mirrors the other validators).
function validatePreferences(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!input) {
    return { errors: { preferences: 'preferences must be an object' } };
  }

  const errors = {};
  const value = {};

  if (input.theme !== undefined) {
    if (typeof input.theme !== 'string' || !THEMES.includes(input.theme)) {
      errors.theme = `theme must be one of: ${THEMES.join(', ')}`;
    } else {
      value.theme = input.theme;
    }
  }

  if (input.locale !== undefined) {
    if (typeof input.locale !== 'string' || !LOCALES.includes(input.locale)) {
      errors.locale = `locale must be one of: ${LOCALES.join(', ')}`;
    } else {
      value.locale = input.locale;
    }
  }

  if (input.density !== undefined) {
    if (typeof input.density !== 'string' || !DENSITIES.includes(input.density)) {
      errors.density = `density must be one of: ${DENSITIES.join(', ')}`;
    } else {
      value.density = input.density;
    }
  }

  if (Object.keys(errors).length > 0) return { errors };
  if (Object.keys(value).length === 0) {
    return { errors: { preferences: 'no recognised preference keys to update' } };
  }
  return { value };
}

module.exports = { validatePreferences, THEMES, LOCALES, DENSITIES };
