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

Two files, one implementation each:

- [`public/ui.js`](../public/ui.js) — the builders. `createUi(deps)` returns
  every component a screen composes itself from. A screen imports nothing else;
  anything it needs that `ui.js` has not got is a gap in the contract rather
  than something to hand-roll on the page.
- [`public/css/components.css`](../public/css/components.css) — the look.

Everything is scoped under `ui`, which is a **marker class, not a layout**: it
carries no styles of its own. The page root is `ui ui-page`; every body-level
overlay (Drawer, popover, row menu, toast host) is `ui ui-<thing>`, because they
are appended to `<body>` outside the page root — without the marker, a button in
the Drawer falls back to the legacy `button` rule and renders as a filled accent
button.

The scope is deliberate and temporary: it lets a contract component share a name
with a legacy rule in `styles.css` (`.badge`, `.panel`, `.toolbar` all exist
there) while pages migrate one at a time. When the last page is migrated the
marker moves to the shell and the legacy rules go.

```js
const view = ui.page(
  ui.pageHeader({ title, lead, help, actions: [secondary, primary] }),
  ui.statStrip(cards),
  ui.toolbar({ filters: [ui.filter(label, ui.select({…}))], actions: [export] }),
  ui.panel({ title, note, children: [ui.dataTable({ columns, rows, sort, onSort, onOpen })] }),
);
```

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

`ui.chart({ title, series, labels, form, height })`. Hand-written SVG — the repo
takes no chart library.

Three rules live in the component rather than on each screen:

- the **legend sits under the plot and is always drawn** (a series you cannot
  name is a line you cannot read);
- the **y-axis is whole numbers when the data is whole**, stepping by 1 while the
  maximum is 10 or less, and by a round number above that — never two ticks with
  the same label;
- **few data points render as bars** (8 or fewer per series), because four dots
  joined by a line invent a trend the data does not have. `form: 'line'` or
  `form: 'bars'` overrides it.

Series colours are `--series-0…5` in `tokens.css`, derived from the palette's own
semantic colours so every theme gets a set that holds together. Six, because a
legend longer than that is a table nobody reads.

### States

`EmptyState`, `LoadingState` (skeleton), `ErrorState`. The same on every screen.
An ErrorState always says what failed (`GET /api/changes?window=7d`) and always
offers a retry. A failed panel never takes the page with it: the shell, the
PageHeader and the sidebar stay.

### Toast

Top right, stacked, auto-close after 5s. **Errors stay** until dismissed.

### Time

`ui.fmt` — one source, four shapes:

| | For | Example |
|---|---|---|
| `abs(v)` | Drawers, detail panels — anywhere the reader is reading | `12/09/2026, 14:02:33` |
| `short(v)` | A table column | `12/09, 14:02` |
| `clock(v)` | A series of readings inside one day | `14:02:33` |
| `rel(v)` | "how old is this" | `4 min ago` |
| `duration(ms)` | A span | `740 ms`, `1.4 s`, `2 min` |

Every shape renders `—` for a missing or unparseable value; none of them can
produce `Invalid Date`. The locale follows the user's, so the same timestamp
reads as a Dane expects it to without a second formatter.

---

## Forbidden after migration

- inline `style=""`
- colour, px spacing or font size outside `tokens.css`
- buttons used as tabs
- chips for metadata or host names
- more than one primary button per PageHeader
- page-local copies of a component

### Enforced: `npm run ui:check`

[`scripts/ui-check.js`](../scripts/ui-check.js). Reports `file:line:rule` and
exits 1 on any finding. It runs in the pre-build gate and inside `npm test`
(`test/uiCheck.test.js`), so a violation fails the build rather than waiting for
somebody to notice.

| Rule | Fires on |
|---|---|
| `inline-style` | `style:` / `style="` in a view |
| `colour` | a hex or `rgb()` literal outside `css/tokens.css` |
| `px-size` | a raw px spacing or font size in a contract stylesheet |
| `legacy-class` | a class the contract replaced, still in use — the message names the replacement |
| `tab-pattern` | a hand-rolled tab strip |
| `chip-metadata` | a chip, whatever it carries |
| `primary-count` | more than one primary in a PageHeader's actions |
| `template` | a migrated view that uses none of the four templates |

**The `MIGRATED` list only grows.** Phase 3 adds a screen to it in the same
commit that migrates the screen, so the sweep tightens one screen at a time
rather than being switched off while the work is in flight. A finding is either
fixed or the file is not migrated yet — the rules are never loosened to make one
go away.

`npm run ui:check -- --all` sweeps the unmigrated chrome too. That is the phase 4
target; the default run prints what is still owed as a single shrinking number.

**One exemption**, and it is an element rather than a file: a `<col>` width is
table geometry the caller supplies per table, and expressing it in CSS would mean
one class per pixel value. Every other inline style is caught, everywhere.

---

## Phases

| Phase | What | Status |
|---|---|---|
| 0 | Audit | done |
| 1 | `tokens.css`, the components the examples need, two example screens on `/ui-preview/*`, routing | **done — awaiting approval** |
| 2 | Finish `tokens.css` + `base.css`, remaining components, `/ui-kitchen-sink`, `scripts/ui-check.js` | **done** |
| 3 | Migration, one screen per commit | not started |
| 4 | Verification: `ui:check` clean, before/after grep report | not started |

### Component reference

**`/ui-kitchen-sink`** (admin only) renders every component in every state it
has, built from `ui.js` like any migrated screen. Two jobs: a visual reference,
so "what does an ErrorState look like" is a link rather than a hunt; and a test
surface, so a regression in a component shows up on a page that is checked
rather than only on whichever screen happens to use it.

Unlike the previews it stays after the migration.

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

---

## Phase 3: migration

One screen per commit, in this order:

App shell → **Changes** → Analysis → Fleet → Monitoring → Diagnostics (Probes &
Tests, Transaction tests, Flows, Topology, Topology delta, Diagnose,
Troubleshooting, Investigate) → Service Assurance → Insights → Guides →
Administration → login and error screens.

### How a screen is migrated

1. The view moves to **`public/views/<screen>.js`**, a `createX(deps)` module
   that builds itself from `ui.js`. This is what makes `ui:check`'s per-file
   `MIGRATED` list work at all: `app.js` is one 18,000-line file, so a rule that
   can only say "this file is clean" can say nothing about a half-migrated one.
2. `app.js` keeps the state the screen must not own — anything that outlives the
   view — and passes it in. It builds the module **lazily**, on first use: `ui`
   is declared far down the file, so wiring it at load time throws during boot.
3. The screen is added to `MIGRATED` in `scripts/ui-check.js` and to
   `CONTRACT_VIEWS` in `app.js`, in the same commit. `CONTRACT_VIEWS` is what
   stops the legacy `hero()` banner drawing a second copy of help the (?) popover
   now carries — and the UI gate reads it, so a screen in that set must actually
   have the popover.
4. Its dead CSS comes out of `styles.css`.
5. A test file per screen, checking the **behaviour that must survive** rather
   than the markup that changed.

### Migrated

| Screen | Route | Template | Module |
|---|---|---|---|
| Changes | `/changes` | A · ListPage | [`public/views/changes.js`](../public/views/changes.js) |
| Probes & Tests | `/probes/:tab` | C · FormPage (shell) | [`public/views/probes.js`](../public/views/probes.js) |
| Analysis | `/analysis` | A · ListPage | [`public/views/analysis.js`](../public/views/analysis.js) |
| Fleet | `/fleet` | A · ListPage | [`public/views/fleet.js`](../public/views/fleet.js) |
| Sites | `/sites` | A · ListPage | [`public/views/sites.js`](../public/views/sites.js) |
| Traffic | `/traffic` | B · DashboardPage | [`public/views/traffic.js`](../public/views/traffic.js) |
| Destinations | `/destinations` | A · ListPage | [`public/views/destinations.js`](../public/views/destinations.js) |
| Topology delta | `/topology-delta` | A · ListPage | [`public/views/topologyDelta.js`](../public/views/topologyDelta.js) |
| Investigate | `/investigate` | C · FormPage | [`public/views/investigate.js`](../public/views/investigate.js) |
| Diagnose | `/diagnose` | C · FormPage | [`public/views/diagnose.js`](../public/views/diagnose.js) |
| Troubleshooting | `/troubleshooting` | B · DashboardPage | [`public/views/troubleshooting.js`](../public/views/troubleshooting.js) |
| Topology | `/topology` | B · DashboardPage | [`public/views/topology.js`](../public/views/topology.js) |
| Flows | `/flows` | B · DashboardPage | [`public/views/flows.js`](../public/views/flows.js) |

**What Changes kept:** the window vocabulary the server accepts (`30m`, `6h`,
`24h`, `7d` — not the preview's three), the marker rule (it moves only on an
explicit "Mark as seen", never on a load), the CSV export, and every deep link
into the record a row is about.

**What changed:** severity grouping became a StatStrip filter plus a column; each
row's explanation moved into the Drawer; the info banner became the (?) popover;
the partial-result warning stayed on screen as an inline note.


**Probes & Tests is a shell migration.** The PageHeader, the (?) popover and the
SubTabs are on the contract; the three tab bodies — Run a probe, Connection test,
Test packages — are ~1,700 lines between them and each carries live machinery
(dispatch, polling, a schedule dialog) that a shell migration has no business
touching. They are passed in and migrate in their own commits.

That split is the point of the per-file module: `ui:check` holds
`views/probes.js` to the contract while the bodies it renders are still on the
old chrome. A screen does not have to be migrated all at once — it has to be
migrated honestly, with the part that is done actually done.

Three PAGE_INFO entries (`probes`, `connectionTest`, `tests`) used to feed three
different hero banners. They now feed one (?) popover, which shows the **active
tab's** help — the page title alone cannot say whether you are about to run one
check or forty.


**Analysis is the three-stacked-buttons fix.** A finding used to carry three
buttons in its last cell — Acknowledge, "What changed?", and for an admin a
severity rule — which stacked into a three-line column on any screen narrower
than a desk. Acknowledge is now the one action on the row, shown on hover; the
other two moved into the ⋯ menu, and the explanation they led to moved into the
Drawer, where there is room to read it.

The severity chips became a StatStrip; the "By metric" and "By host" breakdowns
became two panels in a panel grid, with their rows still pivoting the filter.
The severity column is wide enough for the badge **and** the note saying what
was originally detected — a downgraded critical truncated to "wa…" tells nobody
anything, and that note is the whole reason it is on the row rather than only in
the Drawer.

`CONTRACT_VIEWS` is a Map rather than a Set because the view key and the module
name differ here: the key is `findings` (the records it lists), the product calls
the screen Analysis. The UI gate reads the pairs, checks the module exists, that
it builds a PageHeader with help — and that `ui-check` is actually watching it.


**Fleet** kept the four metric cards as the StatStrip they always were, and lost
the removable filter-chip row: a StatStrip card already shows its own state, so
the chips repeated it. What the chips said that a card could not — a site, a
health threshold — reads as one line above the table.

The grid became a DataTable with sorting in the header. Three panels on the page
are **not** the contract's and are passed in whole: the NOC header (KPI cards and
the live network path), the fleet-wide traffic map (Leaflet, rendered once per
view entry so the 10 s poll does not rebuild it under the reader), and the
licence-gated issues rollup. They migrate in their own commits.

Six hardcoded Danish strings on an English screen — "Kritiske", "Advarsler",
"Ryd alle", "agenter", "Ingen agenter matcher filteret", "sortér grid efter
score" — now go through the catalogue in both languages.

**Known redundancy, not yet resolved:** the NOC header and the StatStrip say
some of the same things (Active agents "5 of 6" against Offline "1"). Both are
kept for now because the NOC header is its own unmigrated component; when it
migrates, one of the two loses those figures.


**Sites** had a heading, a map, and — only when the map could not be drawn — a
table nobody had looked at since it was written. It is a ListPage now, and the
table is always there: the rollup is the same data whether or not Leaflet
loaded, so it is the page's content rather than its fallback.

The marker colours were a hardcoded ramp (`#22c55e`, `#f59e0b`, `#ef4444`,
`#94a3b8`) that stayed the same in all 16 themes. `ui.token()` and
`ui.healthColor()` read the semantic tokens off the document at runtime, so a
marker now follows the palette; the legend under the map takes its colour from a
class (`.ui-legend-dot.health-ok|warn|bad|unknown`) instead of an inline style.
The `--popup-*` tokens are the exception that proves the rule: Leaflet paints
its popup on its own white card in every theme, so the text inside it is fixed
on purpose, in `tokens.css`, where a fixed colour can at least be found.

"The map library did not load" and "no site has coordinates yet" used to be the
same grey sentence. One is a thing to know and one is a thing to fix, so they
are two states with two different ways out.

The Leaflet instance stays in `app.js`: it is a live object carrying the
reader's pan and zoom, and the 10 s poll has to move its markers rather than
rebuild it. The view asks for a canvas and `app.js` mounts the map into it —
which is the shape every remaining map screen will use.


**Traffic** is the first DashboardPage (template B). The four KPI tiles were a
StatStrip written by hand, so they are one now; the alert bar became an inline
note above the data it is about.

Three controls used to ask one question — which series to plot: a "Total RX"
chip, a "Total TX" chip, and a "Pr. agent" fold holding one checkbox per agent
per direction. They are one picker, and the legend under the chart is where a
series comes off again. The series take their colour from `--series-0..5`
instead of two hardcoded hues plus a fixed ramp, which is also what let the
legend dot become a class rather than an inline style.

Drag-to-zoom survives unchanged, including the part that matters: the zoom is a
frozen snapshot, so the 3-second poll cannot move the window out from under
whoever is reading it.

**Not migrated, passed in whole:** the chart plotter (`multiChart`, which owns
the brush), the storage fold, the history explorer with its traffic-types card,
and the traffic-type breakdown. Traffic is the only screen that mounts them, so
they stay in `app.js` until they migrate on their own. The one accommodation is
a single rule in `styles.css` — `.ui .overview-chart` drops its own card
background — so the unmigrated plotter does not draw a second panel inside the
contract's.


**Destinations** kept a 340px panel beside the map at all times. A destination
circle, a site pin and a dragged region all wrote into it, with nothing to say
which of the three you were reading and no way to put it away. That panel is the
**Drawer**: one place for detail whatever was clicked, with a title, Escape, a
close and a focus return — and the map gets the full width back when it is shut.

"Top destinations" became a DataTable, sortable by volume, flows or deviation,
with the deviation as a badge. A destination the GeoIP database cannot place now
appears in that table: it is still traffic leaving the network, and the old page
dropped it entirely because the map could not draw it.

Both colour scales — health for sites, deviation for destinations — come from
the palette through `ui.token()`. The legend names both, because two scales on
one map that nobody explains is two scales nobody reads.

The map is mounted **once**. A period change refetches, redraws the markers and
retitles the panel; rebuilding the map would throw away the reader's pan and
zoom, which is the one thing a map is for. `teardownGeoMap()` exists for exactly
that reason: a remount has to drop the Leaflet objects without dropping the
overview it is about to draw.

**Not migrated, passed in whole:** the Leaflet instance, the two marker layers,
the region rectangle and the traceroute path layer, plus `pathGeoStops` /
`renderPathStops`, which the Probes traceroute map shares.


**Topology delta** carried three rows of controls: change-type chips, a
site/severity bar, and a third row of removable chips repeating what the second
one already said. The types are a StatStrip now — counting is what they were
doing anyway — and the rest is one Toolbar. The feed is a sortable DataTable.

The change-type filter is still in the URL, so a filtered feed is still one
link, and the site and severity still come from the shared `fleetFilter` rather
than a second copy of it: setting a severity goes through
`FleetFilter.toggleSeverity` rather than writing the array in, which is what
keeps its normalisation.

Two Danish strings on an English screen — "Kritiske" and "Advarsler" — now come
from the catalogue in both languages.

The page is called **Topology delta** here, in the nav and in the breadcrumb.
Two screens were both called "Changes", which is one too many.


**Investigate** is the second FormPage. The three loose labels are a
FormSection, and "Investigate" is the page's one primary action.

The grey sentence under the form was doing two jobs — "Select or enter a
location value" and "Error: …" — and did neither well. A validation problem now
belongs to the field it is about and clears the moment the field is filled; a
failed run is an ErrorState that names the call and leaves the form usable.

The history stacked full result cards, each as long as the run you had just
made, so the third one was below the fold and the tenth was unreachable. It is a
DataTable — when, target, verdict, confidence, why — and a row opens that run in
the Drawer. An agent id and a site id resolve to the names they stand for.

The page is called **Investigate**. Its title said "Troubleshooting", which is a
different screen in the same section.

**Not migrated, passed in whole:** `investigationCard()`, which carries the NIS2
draft block and the AI-narrative fold. Each of those migrates on its own terms;
the card is drawn inside a contract Panel and inside the Drawer, so it lost the
card background it used to paint for itself.


**Diagnose** is the third FormPage, and the densest screen migrated so far. The
question, the scope and the examples were a hand-built card; they are two
FormSections with one primary action. The verdict and the direction were
`pill`s — a chip carrying a state, which is what a Badge is for — and are badges
now. The run controls were seven elements in a row with a bare `<span>` doing
double duty as progress and failure; they are a form-actions row with an inline
note, so a failure reads as a failure.

"Which matcher produced this" moved from a coloured strip above the causes into
the Panel head, where the reader is already looking for what a result is worth.

What it keeps, deliberately: the per-test selection carrying the **stored row
ids** (the server can verify an id; it cannot verify "the third one"), the
rounds loop with Stop, the one-package-per-agent repeat — a plan can span two
agents, and one package would run each reverse test from the wrong end — and the
evidence list: every rule, whether it fired, and the sentence behind it, which
is what makes a verdict arguable rather than asserted.

This migration also fixed a defect in `el()` itself: `class: cond ? 'x' : null`
set the element's class to the literal string `"null"`. Every caller in the
codebase that uses that shape was affected; the DataTable's own cells were.


**Troubleshooting** is a DashboardPage with four zones. The four KPI cards
become a StatStrip, and "Active faults" becomes the doorway to the raw list
rather than carrying a link inside a card — the figure is free (it comes off the
cluster rows), the rows behind it are not, so opening them is a decision.

A root cause carried three buttons — Show path, What changed?, Open situation —
which stacked into a three-line block on any screen narrower than a desk. Show
path is the row's one action and the other two are behind the ⋯ menu: the same
fix Analysis got, for the same shape. A cause with no anchor to walk the
topology from simply does not offer the path.

"Partial data — unavailable: …" was grey text in a control bar, next to the
Refresh button and nowhere near the panels it was about. It is an inline note
in warn, above the data.

The fault list stays **opt-in and paged**, which is the one thing about this
screen that must not regress: a fleet can carry tens of thousands of raw alarms
behind its root causes, and fetching them to paint the page is what made this
tab slow. Changing the window drops the held pages — they belong to the rollup
that was just replaced — and refetches page 1 of the new set rather than showing
the old one under a new heading.

**Not migrated, passed in whole:** the topology SVG (`tshootTopologySvg`), the
timeline rows (`TimelineView.renderRow`) and the brush geometry, which moved to
`tshootBrushSvg` in app.js as an object the view paints into. Two of the three
are shared with other screens.


**Topology** had three buttons pretending to be tabs — Diagram, Layers, Map —
with a `.topo-mode` rule that rounded the first and last to fake a segmented
control. They are a SubTabs strip now, with the mode in the URL, which is the
contract's one tab pattern and carries the keyboard and the ARIA the buttons
never had.

Every table row carried three probe buttons — Ping, Show route, Path — stacking
into a three-line column on a narrow screen. Ping is the row's one action and
the other two are behind the ⋯ menu. All three need an agent to run from, so
when no agent is online the column is not there at all.

The two tables became sortable DataTables, so "the busiest host" is a click.
The scope line — "Service/host dependencies · 60 min · Oslo" — moved from a grey
span beside the heading into the Panel that shows the data, where it belongs.

A `?layer` or `?focus` deep link still opens on Layers. That test reads the
**raw query**, because `TopologyGraph.parseParams` defaults `layer` to `both`
and would claim every URL was a layer link.

**Not migrated, passed in whole:** `topoGraphSvg`, `topoLayersSvg`, the Leaflet
map (now `drawTopoMapInto`), the blast-radius panel and the probe modals (now
`topoProbeModal`) — the path visualisation among them is shared with Probes &
Tests.


**Flows** carried two segmented controls — Unified / Bidirectional / Map, and
four time presets — plus a hand-built grid of labelled fields (`.flows-field`)
with its own input styling. The modes are a SubTabs strip with the mode in the
URL; the presets are a select, because a range is a value and not a place; the
fields are one Toolbar, and a control a mode does not use is simply not built
for it.

The status line — bytes, flows, records — was a grey span in the control bar,
as far from the numbers it described as the layout allowed. It is the Panel
note, beside the data it counts. "Invalid time range — check From / To" was an
error where the data goes; it is a field error on the input that is wrong.

Every table became a DataTable, sortable, with the ports and the protocols side
by side in a panel grid. Clicking a talker still pivots the peer filter onto it
— it is a HostLink now rather than a whole clickable row, so the rest of the row
can be selected and read.

**Not migrated, passed in whole:** the traffic map, its legend chips and the
traffic-type colour ramp. The ramp is a per-category palette (17 named
categories plus a hash fallback) that cannot become a class per colour, so the
one dot that needs it is built in app.js and handed over as a node.
