# Colour themes

The dashboard ships a small catalogue of colour themes (beyond the original
light/dark pair). The choice is **per user** — saved to the signed-in account so
it follows the user to any browser — and cached in `localStorage` so it applies
instantly on load with no flash.

## How it fits together

- **Palettes** live in `public/styles.css` as `[data-theme="…"]` blocks that
  override the `:root` CSS variables (`--bg`, `--panel`, `--accent`, …). Light is
  the default (`:root`); every other theme is one opt-in block.
- **The catalogue** `THEMES` in `public/app.js` lists each theme's `key`, `label`,
  `family` (light|dark, drives the topbar quick-toggle icon) and a `swatch`
  preview. `applyTheme()` sets `<html data-theme>`; `setTheme()` applies + caches
  + persists.
- **The picker** is **Settings → Appearance** (`settingsAppearanceView`),
  available to every role — it's a personal preference, not admin config. The
  topbar 🌙/☀️ button stays a quick light/dark toggle.
- **Persistence** is `GET /me` + `PUT /me/preferences` (`src/routes/me.js`, any
  authenticated role). Preferences are a JSON blob on `users.preferences`
  (migration `020`), read/merge-written by `usersRepository.getPreferences` /
  `updatePreferences`. `loadProfile()` fetches the saved theme once per session
  and applies it (server wins over the local cache).
- **Validation** whitelists the allowed theme keys in
  `src/validation/preferencesValidation.js` (`THEMES`). Unknown keys in a patch
  are ignored; an unknown/!string theme is a 400.

## Adding a theme

Add the key in three places (kept deliberately in sync):

1. a `[data-theme="<key>"]` block in `public/styles.css` (all the `--*` vars),
2. an entry in `THEMES` in `public/app.js` (`key`, `label`, `family`, `swatch`),
3. the key in `THEMES` in `src/validation/preferencesValidation.js`.

`test/preferencesValidation.test.js` and `test/dashboard.test.js` guard the
wiring; `test/me.test.js` covers the read/save endpoints.
