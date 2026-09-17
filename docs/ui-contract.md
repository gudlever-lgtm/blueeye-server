# UI contract

Every screen in blueeye-server is built from the same components and follows one
of four page templates, so a reader knows where the title, the actions, the
filters, the tabs, the data and the detail are before they have read a word.

This document is the reference. It is normative: `npm run ui:check` (phase 2)
enforces the parts a script can enforce, and the parts it cannot are settled
here rather than per page.

Status: **phase 1** — the contract is written, the tokens and the components the
two example screens need are built, and the examples live on their own routes.
Nothing else is migrated yet. See [Phases](#phases).

---

## Tokens

One file: [`public/css/tokens.css`](../public/css/tokens.css). It is loaded
before `styles.css`, so every rule in the codebase reads the same values.

**No colour outside this file.** The palette and all sixteen `[data-theme]`
blocks live there; a rule anywhere else takes a token or it is wrong.

### Colour

The palette kept its historical names (`--bad`, `--warn`, `--ok`, `--muted`,
`--panel`, `--accent`) because sixteen themes and ~700 selectors already read
them. The contract adds semantic aliases for what those colours *mean*, and both
spellings resolve to the same value in every theme:

| Semantic | Alias of | Use for |
|---|---|---|
| `--sev-crit` | `--bad` | critical severity, destructive actions, field errors |
| `--sev-warn` | `--warn` | warning severity |
| `--sev-info` | `--accent` | informational severity |
| `--sev-ok` | `--ok` | healthy / passed |
| `--text` | — | body text |
| `--text-muted` | `--muted` | metadata, hints, secondary labels |
| `--border` | — | hairlines and control edges |
| `--surface` | `--panel` | panel and card background |
| `--surface-alt` | `--panel-2` | table headers, hover fills, inset blocks |
| `--accent` | — | the one accent: primary buttons, links, active state |

Washes (`--crit-weak`, `--warn-weak`, `--ok-weak`, `--accent-weak`,
`--info-weak`) and `--scrim` are derived with `color-mix`, so they re-theme with
every palette instead of pinning a hex per theme.

New code uses the semantic name. The alias is what lets the two coexist while
pages migrate one at a time.

### Scale

```
spacing   --s-1 4px   --s-2 8px   --s-3 12px  --s-4 16px  --s-5 24px  --s-6 32px
type      --fs-xs 12  --fs-sm 13  --fs-md 14  --fs-lg 16  --fs-xl 20
control   --control-h 32px
radius    --r-btn 10px   --r-badge 6px   --r-panel 12px
layout    --sidebar-w 240px   --content-max 1440px
rows      --row-h 44px   --row-h-compact 36px
```

**Radius is a decision, not the original proposal.** The contract first proposed
6/4/8px; the call was to keep the softer scale the product already shipped, so
`--r-btn` is `--radius-sm`, `--r-panel` is `--radius`, and `--r-badge` sits
between `--radius-xs` and `--r-btn` because a 20px-tall badge at 8px reads as a
pill rather than a badge.

`--control-h` is new and is enforced: before this there were four different
control heights (27, 32, 35, 37px) depending on which class a button happened to
carry.

---

## Routing

Every screen has an address. [`public/routes.js`](../public/routes.js) is the one
place that knows view ↔ path, and both sides read it: the dashboard parses the
location on boot and pushes state on navigation, the server decides whether an
HTML request is a real app path.

- `/` and `/index.html` open Changes.
- Sub-tabs are **path segments**, not query parameters: `/probes/connection`,
  `/settings/retention`, `/service-assurance/health`, `/guides/fleet`. Several
  views already own the query string for their own filters (`/fleet?severity=`,
  `/topology?layer=`, `/topology-delta?changeTypes=`) and rewrite it wholesale;
  keeping tabs out of the query means those writers stay exactly as they are.
- A record has its id in the path: `/agents/12`, `/events/5`, `/situations/8`.
- Filters stay in the query, so a tab and a filter both survive a reload.

### How the server answers

| Request | Answer |
|---|---|
| Navigation to a real address (`/fleet`, `/probes/connection`) | 200 + the shell |
| Navigation to an address inside the namespace that resolves to nothing (`/agents/abc`, `/nope`) | **404 + the same shell**; the client renders the not-found view |
| `fetch('/agents')` from `api()` | the agents API, unchanged |
| Navigation to `/api/nis2/…` (the API's own HTML documents) | the API, unchanged |

A browser navigation is told apart from an XHR by `Sec-Fetch-Dest: document` or
an `Accept` header containing `text/html`. `api()` sends neither, which is what
keeps a fetch for `/agents` from being answered with the dashboard.

### Role

`MIN_ROLE` in `routes.js` gates screens by address as well as by nav rail: a
typed URL does not pass the rail, so a viewer asking for `/discovery` gets a
**403 screen**, not the page and not a 404. Saying "no such page" about a page
that does exist is the kind of half-truth that generates support tickets.

**Known deviation:** the contract asked for HTTP 403 on `/ui-preview/*` for
non-admins. The server cannot do that — the session is a JWT in `localStorage`,
not a cookie, so an HTML request carries no identity, and adding one would be an
auth change the brief rules out. The gate is enforced in the client, and the APIs
behind every gated screen still refuse the same reader with a real 403.

---

## App shell

Identical on every screen.

**Sidebar** — sections, collapsible, collapsed state remembered per browser. The
active item is marked with an accent background **and** an accent left edge; the
wash alone reads as a hover state on the darker themes. **The section containing
the active item is always unfolded on load**, so a deep link never marks an item
inside a folded group.

**Topbar** — breadcrumb left (`Section / Page / sub-page`), global search and the
account menu right. The breadcrumb is rebuilt from the route on every render and
takes its labels from the sidebar the route points at, so the crumb and the rail
can never disagree and a language switch relabels both.

**Content** — padding `--s-6`, `max-width: --content-max`.

---

## Page templates

Every screen uses exactly one.

| | Template | Structure |
|---|---|---|
| **A** | ListPage | PageHeader → [SubTabs] → [StatStrip] → Toolbar → DataTable → Drawer |
| **B** | DashboardPage | PageHeader → [SubTabs] → StatStrip → Panel grid (charts/cards) |
| **C** | FormPage | PageHeader → [SubTabs] → Panel(s) of FormSection → FormActions bottom right |
| **D** | DetailPage | PageHeader with status badge and actions → SubTabs → Panels |

---

## Components

One implementation each, in
[`public/css/components.css`](../public/css/components.css). Everything is scoped
under `.ui`, which a migrated view puts on its root — deliberately and
temporarily, so a contract component can share a name with a legacy rule in
`styles.css` (`.badge`, `.panel`, `.toolbar` all exist there) while pages migrate
one at a time. When the last page is migrated the scope moves to the shell and
the legacy rules go.

### PageHeader

Title at `--fs-xl`, one line of description in `--text-muted`, a `(?)` that opens
a help popover, actions right. **At most one primary button.** Info banners are
gone — the `hero()` banner's text moved into the popover.

```js
pageHeader({
  title: t('changes.title'),
  lead: t('changes.subtitle'),
  help: { title: …, body: () => [ el('p', {}, …) ] },
  actions: [secondaryButton, primaryButton],   // primary last, at most one
})
```

An advisory that belongs to the **data** rather than to the page — a partial
result, the reference time, "3 sources did not answer" — is an `.inline-note`
above the table. Not a banner, not hidden behind the `(?)`. A safety note that
changes what a reader may assume (Discovery's "read-only by design") stays on
screen for the same reason.

### SubTabs

Underline tabs. **The only tab pattern.** `.seg`, `sa-segmented` and the settings
side-nav all collapse into this one. The active tab is in the URL.

The markup comes from `tabStrip()` in `app.js` — the one place allowed to build a
strip, because it carries the roving tabindex, the arrow keys and the
`role="tablist"` a hand-rolled row of buttons silently drops (a gate rule
enforces it). `components.css` supplies only the look: inside `.ui` the strip is
an underline row rather than the legacy row of filled buttons.

### StatStrip

Clickable cards (number + label) that set a filter in the Toolbar/DataTable.
Clicking an active card clears it. This is also where the fleet filter chips
(`.fs-chip`) go — they were always a strip of counts.

### Toolbar

Filters left with inline labels, all `--control-h`. Secondary actions (Export,
view switch) right. Filters are reflected in the URL query.

### DataTable

A real `<table>`: fixed columns, sticky header, sorting in the header, column
filters only in the Toolbar. Row height `--row-h` (44px), `--row-h-compact`
(36px) under `.ui.dense`. Clicking a row opens the Drawer. Row actions live in a
`⋯` menu with **one** primary action visible on hover — this is what replaces
Analysis's three stacked buttons. Paging sits in the `.panel-foot`, the same
everywhere.

### Drawer

Right side, 480px, header with title + status badge + close. Content in
sections. Explanations, "what changed", the severity rule and the history live
here — that is what takes them off the row.

### Panel

Heading, optional actions right, padding `--s-4`/`--s-5`, optional `.panel-foot`.

### Button

`btn-primary` (filled accent), `btn-secondary` (outline), `btn-ghost` (text
only), `btn-danger`. Radius `--r-btn`, height `--control-h`; `btn-icon` is the
same height, `btn-xs` is the in-row size.

### Badge

**Status, severity and state only.** `crit` / `warn` / `info` / `ok` /
`neutral`, radius `--r-badge`, colour from the semantic tokens.

Metadata is muted text: `recurring 135×` is `135×` in `--text-muted`, not a chip.
`12 anomalies`, `Event`, `open` — all text.

### HostLink

A host or agent name is a text link in its own column. Never a chip, never
appended to a title.

### FormSection

Label above the field, hint below, error below that in `--sev-crit`. Fields in a
grid, **max two columns**, one column below 900px. `FormActions` sits at the
bottom right, separated by a hairline.

### Chart wrapper

Title in the Panel, legend under the chart and always visible. Integer y-axis
when the data is integers (`stepSize` 1 when max ≤ 10). Few data points → bars by
default. *(Phase 2 — not built yet.)*

### States

`EmptyState`, `LoadingState` (skeleton), `ErrorState`. The same on every screen.
An ErrorState always says what failed (`GET /api/changes?window=7d`) and always
offers a retry. A failed panel never takes the page with it: the shell, the
PageHeader and the sidebar stay.

### Toast

Top right, stacked, auto-close after 5s. **Errors stay** until dismissed.

### Time

One formatter, the same everywhere. *(Phase 2 — six formatters exist today.)*

---

## Forbidden after migration

- inline `style=""`
- colour, px spacing or font size outside `tokens.css`
- buttons used as tabs
- chips for metadata or host names
- more than one primary button per PageHeader
- page-local copies of a component

---

## Phases

| Phase | What | Status |
|---|---|---|
| 0 | Audit | done |
| 1 | `tokens.css`, the components the examples need, two example screens on `/ui-preview/*`, routing | **done — awaiting approval** |
| 2 | Finish `tokens.css` + `base.css`, remaining components, `/ui-kitchen-sink`, `scripts/ui-check.js` | not started |
| 3 | Migration, one screen per commit | not started |
| 4 | Verification: `ui:check` clean, before/after grep report | not started |

### Phase 1 examples

Admin only. Deleted once Changes and Probes & Tests move onto their real routes.

- **`/ui-preview/changes`** — Changes as a ListPage (template A). Also
  `?state=empty` and `?state=error`, because a live server rarely produces either
  on demand.
- **`/ui-preview/probes`** — Probes & Tests as a FormPage (template C).

Both read the real APIs (`/api/changes`, `/agents`,
`/api/connection-test/checks`), so what is on screen is this server's own data.
The Run button on the preview dispatches nothing.

### Contract points adjusted during phase 1

| Point | Adjusted to | Why |
|---|---|---|
| `--r-btn 6px`, `--r-panel 8px` | 10px / 12px | Keep the shape the product already shipped; the brief preserved the palette, and the radii read as part of it. |
| Semantic token names replace the old ones | Semantic names are **aliases** | 16 themes and ~700 selectors read the old names. A rename is a 2000-line diff with no user-visible gain; an alias lets both spellings resolve to one value. |
| `?tab=` for sub-tabs | Path segments | Five views already own the query for their filters and rewrite it wholesale. |
| "Mark as seen" / "Fleet grid" in the Toolbar | **PageHeader** | A PageHeader with no actions reads as unfinished, and both are page-level actions rather than filters. "Mark as seen" is the one primary; "Fleet grid" is a way out of the page, so it is secondary. |
| HTTP 403 on `/ui-preview/*` | Client-side 403 screen | The session is a JWT in `localStorage`; an HTML request carries no identity. See [Routing → Role](#role). |
| Info banners removed entirely | Intro text → `(?)` popover; data advisories → `.inline-note` | Some banners carry state a reader must not miss (partial results, read-only-by-design). Hiding those behind a `(?)` removes information rather than clutter. |
| Changes as a flat DataTable | Severity grouping → StatStrip filter + a Severity column | The grouped timeline cannot be a table. The `family` sentence-dedup (identical explanations suppressed on consecutive rows of the same family) does not survive; the explanation moved into the Drawer, where it is shown once per row on demand. |
