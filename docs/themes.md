# Colour themes

The dashboard ships a catalogue of colour **palettes**, each in a light and a
dark variant. The choice is **per user** — saved to the signed-in account so it
follows the user to any browser — and cached in `localStorage` so it applies
instantly on load with no flash.

## How it fits together

- **Palette variants** live in `public/styles.css` as `[data-theme="…"]` blocks
  that override the `:root` CSS variables (`--bg`, `--panel`, `--accent`, …).
  Light is the default (`:root`); every other variant is one opt-in block. Each
  palette has a light and a dark block (e.g. `nord` / `nord-light`).
- **The catalogue** `PALETTES` in `public/app.js` lists each palette's `key`,
  `label` and its `light`/`dark` variants (each `{ key, swatch }`). It's flattened
  into `THEMES` (one entry per variant) carrying `family` (light|dark), `palette`,
  and `dual` — the opposite-brightness variant of the same palette. `applyTheme()`
  sets `<html data-theme>`; `setTheme()` applies + caches + persists.
- **The picker** is **Settings → Appearance** (`settingsAppearanceView`),
  available to every role — it's a personal preference, not admin config. It
  shows one card per palette (light + dark swatches) and selecting one keeps the
  current brightness.
- **The toggle** — the topbar 🌙/☀️ button — flips to the current palette's
  opposite-brightness variant (`themeMeta(current).dual`). So brightness changes
  while the chosen palette is preserved (e.g. Forest dark ⟷ Forest light); it
  never falls back to the basic light/dark pair.
- **Persistence** is `GET /me` + `PUT /me/preferences` (`src/routes/me.js`, any
  authenticated role). Preferences are a JSON blob on `users.preferences`
  (migration `020`), read/merge-written by `usersRepository.getPreferences` /
  `updatePreferences`. `loadProfile()` fetches the saved theme once per session
  and applies it (server wins over the local cache).
- **Validation** whitelists the allowed variant keys in
  `src/validation/preferencesValidation.js` (`THEMES`). Unknown keys in a patch
  are ignored; an unknown/!string theme is a 400.

## Adding a palette

Add a light **and** a dark variant, keeping these in sync:

1. two `[data-theme="<key>"]` blocks in `public/styles.css` (all the `--*` vars),
2. an entry in `PALETTES` in `public/app.js` (`key`, `label`, `light`, `dark`,
   each with its variant `key` + `swatch`),
3. both variant keys in `THEMES` in `src/validation/preferencesValidation.js`.

`test/preferencesValidation.test.js` and `test/dashboard.test.js` guard the
wiring; `test/me.test.js` covers the read/save endpoints.
