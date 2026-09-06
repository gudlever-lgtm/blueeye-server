# Design system — the soft surface

The dashboard is hand-written CSS with no build step, so the only thing keeping
2000 lines of `public/styles.css` looking like one product is the **token scale**
at the top of the file. Everything else — every card, table, chip, drawer —
composes from it.

The look is deliberately soft: wide radii, hairline dividers, and shadows you
feel rather than see. A surface should read as paper laid on the page, not as a
box drawn on it.

## The tokens

`:root` holds two layers. The **palette** (`--bg`, `--panel`, `--panel-2`,
`--text`, `--muted`, `--accent`, `--ok`, `--warn`, `--bad`, `--border`,
`--btn-fg`) is what every `[data-theme=…]` block overrides — see
[themes.md](themes.md). The **derived and layout tokens** below it are computed
from the palette with `color-mix()`, so they re-theme for free and no theme
block has to restate them.

| Token | What it's for |
| --- | --- |
| `--accent-weak`, `--ok-weak`, `--warn-weak`, `--bad-weak`, `--muted-weak` | status tints: badge fills, alert banners, the active nav pill |
| `--hairline` | dividers *inside* a surface (table rows, list items, section rules) |
| `--border` | the edge *of* a surface |
| `--border-strong` | a hovered edge |
| `--hover` | neutral hover wash for rows, menu items and quiet buttons |
| `--radius-xs` … `--radius-pill` | 8 / 10 / 12 / 16 / 999 px — see below |
| `--shadow`, `--shadow-md`, `--shadow-lg` | resting / lifted / overlay elevation |
| `--ring` | the focus halo (`box-shadow`, never a hard `outline`) |
| `--ease` | the shared easing curve for every transition |

### Radii

One step per surface size, so a chip inside a card inside a modal nests
correctly:

- `--radius-xs` (8px) — inline bits: code, swatches, small tints
- `--radius-sm` (10px) — controls: buttons, inputs, segmented toggles
- `--radius` (12px) — panels, cards, tables
- `--radius-lg` (16px) — big containers: graphs, maps, modals, the login card
- `--radius-pill` (999px) — badges, chips, progress tracks

Literal pixel radii are reserved for **shapes** — dots, 3px bars, sparkline
caps. `test/dashboardDesignTokens.test.js` fails if a panel-scale radius
(6–12px) is hard-coded again.

### Elevation

`--shadow` is the resting state of any content surface. `--shadow-md` is the
hover/lift state. `--shadow-lg` is for things that float above the page:
modals, drawers, the account menu, toasts.

The light default's shadows are near-invisible on a dark panel, so the dark
palettes (`dark`, `midnight`, `nord`, `forest`, `sunset`, `solarized-dark`,
`contrast`) restate the three elevation tokens — and only those — in one shared
block under `:root`.

## Rules of thumb when you add a surface

- panel background + `1px solid var(--border)` + `box-shadow: var(--shadow)`.
  Don't reach for a heavier border to separate something; that's what the
  shadow and the gutter are for.
- radius from the scale, never a literal px.
- dividers between rows *inside* the surface use `var(--hairline)`.
- hover **lifts** (`--shadow-md`); it doesn't thicken the border.
- focus is `box-shadow: var(--ring)` with `outline: none`, so the halo follows
  the element's radius.
- anything that only shows a level or a state — progress bars, meters, chips,
  badges — is fully round (`--radius-pill`).
- status colour comes from a `*-weak` token, never a literal `rgba()`. A
  hard-coded tint doesn't follow the user's palette, and there are 13 of them.

The finishing rules live in the **"Soft surface pass"** section at the very
bottom of `styles.css`. It's last on purpose: elevation, scrollbars, overlay
shadows and the reduced-motion guard should win ties against the component
rules above them. When a surface is drawn transparently *inside* another one
(a chart inside a `.chart-card`, a `table.kv` inside a settings card) it opts
out of the shadow there — a shadow on a transparent box draws a rectangle
around nothing.

## Chrome

- **Sidebar** — panel-coloured, hairline right edge. Category labels are 10px
  uppercase and fold their group. The active item is a soft accent-tinted pill;
  there is no marker bar.
- **Topbar** — translucent (`color-mix` with the panel) plus a backdrop blur, so
  content softens as it scrolls under instead of hard-clipping. An
  `@supports not` block falls back to the solid panel colour.
- **Content** — `main#view` carries the page gutter (24/28px, tightening to
  14px under 720px). Pages don't add their own outer padding.
- **One page width** — `main#view` is `width: 100%` capped at `--page-max`
  (1440px) and centred, so every view lines up: Overview, Enrollment, Settings
  and the rest are the same width on the same screen. `main#view` is a flex item
  in the `.shell` column, so `margin: 0 auto` *without* `width: 100%` would make
  each page shrink to its own content — that is what used to give every page a
  different width. Don't set a page-specific width.
- **Data sits in a frame** — a table, a list or an empty state on a page is a
  surface: panel background, `1px solid var(--border)`, `--shadow`. Nothing
  reads as data floating on the page background. `table`, `.tablewrap` and
  standalone `.empty` get this for free; a section with its own heading, actions
  and note uses `dataCard()` (`.data-card`), where the card carries the frame
  and the table runs flush to its edges. A surface drawn *inside* another one
  opts out, as above.
