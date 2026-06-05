'use strict';

// Per-user UI preferences are stored as a small JSON blob. Today the only
// preference is the dashboard colour theme; whitelist new keys here.
//
// THEMES must stay in sync with the [data-theme="…"] blocks in
// public/styles.css and the THEMES catalogue in public/app.js.
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

  if (Object.keys(errors).length > 0) return { errors };
  if (Object.keys(value).length === 0) {
    return { errors: { preferences: 'no recognised preference keys to update' } };
  }
  return { value };
}

module.exports = { validatePreferences, THEMES };
