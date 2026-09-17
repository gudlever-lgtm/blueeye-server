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

### The layer scale

Anything that paints over the page takes its `z-index` from one ordered scale in
[`public/css/tokens.css`](../public/css/tokens.css). A hand-picked number is a
finding (`ui:check`, rule `z-index`), and `test/layerScale.test.js` pins the
order.

| Token | Layer |
| --- | --- |
| `--z-sticky` | sticky table head, inside its panel |
| `--z-inline` | inline suggestion list, anchored to its input |
| `--z-topbar` | sticky page topbar |
| `--z-sidebar` | nav rail (its mobile scrim one below) |
| `--z-popover` | help popover, dropdown menu |
| `--z-rowmenu` | row action menu |
| `--z-scrim` | modal / drawer backdrop |
| `--z-modal` | modal card, drawer panel |
| `--z-toast` | toast — always on top, so one raised from a modal is readable |

Hand-picked numbers produced three separate bugs: the sidebar (60) painted over
the slide-in drawer (51); the legacy `.modal` had **no** `z-index` at all and
went under the sticky page chrome; and Leaflet numbers its own panes from 400 up,
which without a stacking context of their own landed in the ROOT one and covered
the drawer, the modal and the toast — "the map covers the Destination details".
`.leaflet-container { isolation: isolate }` clamps the map's panes to the map.

### Toasts

Top right, stacked, capped at four. A confirmation clears after 5 s; an **error
after 15 s**, not never — a stack of undismissed errors ends up covering the page
it is complaining about. The countdown pauses while the pointer is over the stack
or focus is inside it, so an error being read is not pulled away mid-sentence,
and ✕ closes one on demand. The same title+detail twice is one toast with its
timer restarted, so clicking a button that fails validation five times does not
build a five-high stack of the same line.

`opts.focus` takes the form field the message is about: the field is scrolled to,
focused and ringed (`.is-asked`, cleared on the first input/change/blur). "Pick
an agent first" should put the cursor in the agent picker, not leave the operator
guessing which of six controls it means.

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

**The colour rule sweeps every stylesheet**, contract or not. It did not always:
while the unmigrated chrome carried 461 literals, they were counted as a
shrinking debt rather than failed on, because a lint that cannot pass is a lint
nobody runs. Phase 4 emptied them, so the rule is now what keeps them empty.
The **size** rule is still contract-only — the old sheets are full of hand-set
px that migrate with their screens.

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
| Transaction tests | `/transaction-tests/:tab` | A · ListPage (shell) | [`public/views/transactions.js`](../public/views/transactions.js) |
| Service Assurance | `/service-assurance/:tab` | A · ListPage (shell) | [`public/views/serviceAssurance.js`](../public/views/serviceAssurance.js) |
| Events | `/events` | A · ListPage | [`public/views/events.js`](../public/views/events.js) |

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


**Transaction tests** is the second shell migration, and follows the Probes
pattern exactly. The heading with a loose "+ New test" beside it is a PageHeader
with one primary action and the (?) popover; the tab strip was already
`tabStrip()`, so it only needed its labels through the catalogue; the list is a
sortable DataTable.

Edit and Delete were two buttons in every row's last cell. Edit is the row's one
action and Delete is behind the ⋯ menu, marked destructive — a delete does not
belong one mis-click away from an edit.

A first click on a numeric column sorts high-first and on a text column
A-first, which is what the reader is asking for when they click that particular
column.

**Not migrated, passed in whole:** the create/edit form (a multi-step http
editor with secrets and agent assignment), the matrix, and the per-test detail
with its heatmap and trend — about 350 lines between them. They navigate back to
"the list", which is the view's now, so the view hands its list builder to
app.js and `txListView()` forwards to it.


## Phase 4, in progress: the colour debt

`serviceAssurance.css` carried **283 colour literals**; it now carries none.
They came off in two passes.

**The dead fallbacks (142).** Most were `var(--muted, #6b7280)` — a token plus a
literal that could only ever be reached if the token were missing, which it
never is. They are dropped. Three of them were the exception that made the pass
worth doing: `--danger`, `--crit` and `--code-bg` are **not defined anywhere**,
so for those the fallback WAS the colour and it never followed a theme. They now
read `--sev-crit` and `--surface-alt`.

**The real colours (141).** Almost all were a status badge's light pair
(`background: #fee2e2; color: #991b1b`) with a
`[data-theme="dark"], [data-theme="midnight"]` block restating it for a dark
ground. Each pair became `var(--crit-weak)` / `var(--sev-crit)` and the override
blocks went. That fixed a real defect: the overrides named **two** palettes, and
this app ships **seven dark ones** — on nord, forest, sunset, solarized-dark and
contrast those badges were rendering the light values on a dark ground.

Service Assurance's own eight-hue categorical ramp moved to `tokens.css` as
`--sa-hue-1..8`, with its dark re-stepping applied to every dark palette rather
than to two of them. Eight rather than the chart contract's six because a
journey chart genuinely has eight lines, and dropping two would drop two
applications.

`styles.css` followed, and the same two passes emptied it: 31 dead fallbacks
(five of them for tokens defined nowhere — `--code-bg`, `--danger`, `--fg`,
`--surface-1`, `--surface-2`), and ~120 real colours. One of those five was
worse than a dead fallback: `.tl-src` read `color: var(--fg)` with **no**
fallback at all, so the declaration was invalid and the colour simply inherited.

The incident, confidence, risk, root-cause and guide badges were a flat-UI
palette — `#c0392b`, `#e67e22`, `#2980b9`, `#8e44ad`, `#27ae60`, `#95a5a6` —
painted flat with white text, and none of it moved with the palette. They are
severity pairs now. Two meanings shared one purple: "investigating" and
"acknowledged". Both read as warn, which says more than the purple did —
somebody has it, and it is not fixed.

**`npm run ui:check -- --all` is clean.** There is no colour literal anywhere in
`public/` outside `css/tokens.css`.


**Service Assurance** is the third shell migration, and the largest: eight
screens in a 5,100-line module that also ships standalone.

The module carried **its own copy of the tab strip** — correct keyboard and
ARIA, written out a second time. The contract forbids a page-local copy of a
component, so the module grew an `embedded` mode: with it the host draws the
chrome and the module draws only the body; without it the module still owns its
own shell, which is how it ships standalone. That seam already existed for
`mode: 'settings'`, which mounts only the settings panel inside another screen.

The screen also gained a **PageHeader and the (?) popover**, which it never had:
the tab strip was the first thing on the page, so the section's name appeared
only in the nav and the breadcrumb.

Migrating the strip surfaced a gap. **History** is one of the eight screens the
strip offers, but it was in neither the module's accepted-tab list nor the
route's — so it could be clicked to and never linked to, and a
`/service-assurance/history` deep link silently opened Applications. It is in
both now.

**Not migrated:** the eight tab bodies. Each is hundreds of lines with its own
forms, detail screens and polling, and each migrates in its own commit. Its
**stylesheet** is done — see phase 4 above.


**Events** was the only table in the app whose filters lived **inside the table
header** — one control per column, under the sortable label. Clever, and unique,
which is what made it a problem: it is the contract's Toolbar now, the same move
Analysis made when it migrated.

A StatStrip counts the events by status and filters on a click. "How many are
still open" was a question this page could not answer without reading the rows.

The "🧭 Guide" button sat in every row as a `pill` — a chip carrying an action,
which is neither a state nor metadata. It is the row's action, on hover, like
Acknowledge on Analysis.

Eight columns will not fit fixed widths at 1280, and the flexible one — the
condition, which is the point of the row — is what gets squeezed to nothing. Only
severity, status and the action column are pinned; the browser lays the rest out,
and the two timestamps read as "5 d ago" with the exact stamp as the tooltip.

**Clear filters is always present and disabled when there is nothing to clear.**
Showing it conditionally would mean rebuilding the toolbar on every keystroke in
the location field — and losing the focus with it.


**Situations** is the clustering view: findings the analyser grouped into one
story. It had a heading, a row of filter buttons where the pressed one was a
`.active` class, and a table whose every non-row state was a single
`<td colspan="6">` with a sentence in it.

Three states now say three different things: nothing clustered yet (the
analyser has not grouped anything — not an error), a filter that matches
nothing (with the filter to clear), and a failed load (with the request and a
Retry). One grey sentence in a table cell could not tell those apart, so it
never did.

The status filter is a StatStrip — open / acknowledged / resolved with their
counts — and the confidence filter is a Toolbar select. Confidence sorts by
rank (high / medium / low), not alphabetically, which is what "sort by
confidence" is asking for.


**Reporting** is the fourth shell migration. The page name and its navigation
were one line of markup — a `<h2>Reporting</h2>` with the section strip wedged
in beside it inside `.section-head`. The name is a PageHeader with the (?)
popover, and the strip is under it, where every other tabbed screen puts it.

The section is in the URL now (`/reporting/schedules`), so the audit trail can
be linked to. Picking a section used to go through `render()` and rebuild the
whole view; only the body is rebuilt.

"Loading…" and the failure were both a `.empty` div — the same grey box for
"wait" and for "it broke". They are a skeleton and an ErrorState with a Retry.
The page is returned before the section resolves, so the header, the strip and
the skeleton are on screen while the body loads; awaiting the body first left
the reader on the previous screen and the skeleton was never seen at all.

Audit is admin-only. A reader who deep-links to `/reporting/audit` without the
role lands on the first section **and the address follows**, so a reload does
not try it again.

**Not migrated, passed in whole:** the four bodies — the NIS2 module (with its
own second-level tab strip), the report generator, the schedules panel and the
audit trail. The nested strip is the one place in the app with two levels of
tabs; it stays until the NIS2 module migrates, which is its own commit.


**Guides** is the fifth shell migration, and the one where the contract's
deletion of info banners does the most work. The screen opened with a hero
banner explaining what a guide is, above a heading whose own lead line said the
same thing, above a third line counting the steps — three paragraphs before the
first step. It is a PageHeader with one lead and the (?) popover; the footer
already reads "Step 3 of 7", so the count needed no line of its own.

"The live state could not be read" was a callout sitting in the document flow
between the heading and the steps. It is an advisory about the data, so it is
an inline note. The guidance never depended on that state — a 404 or a 500 on
one endpoint costs its own status line and nothing else — and the page proves
it: the seven steps are all still there.

Back and Next were `.ghost` and `.primary`, the legacy button classes. They are
contract buttons in a form-actions row, and Back is a secondary the reader can
see rather than a borderless one that disappears when disabled.

**Not migrated, passed in whole:** the stepper and the step bodies. They are
the document, and they are `public/guides.js`, which ships standalone — so
`mode: 'embedded'` is opt-in there, the same arrangement Service Assurance
uses. Without it the module still draws its own heading, banner and footer.


**Locations** had **six** buttons in every row's last cell — Open, Traffic,
History, AI status, Edit, Delete — with Delete sitting one mis-click from Edit.
The row opens the location, because that is what a row does; Edit is the row's
action on hover; Traffic, History and AI status are in the ⋯ menu, and Delete
is last, behind a separator, marked destructive.

AI status is offered only when the licence includes the assistant. It used to
be, too — the difference is that a menu is where an entry can quietly not be
there, while a sixth button leaving a row changes its shape.

"No locations." was a grey sentence in a table. An empty estate is the first
thing a new install sees, so it says what a location is for and offers the
button that creates one. A failed load took the page down with it; it is an
ErrorState naming `GET /locations`, with a Retry.

**Not migrated, passed in whole:** the three panels the menu opens — live
traffic (a 3 s poll with a rolling chart), the history range picker, and the AI
summary. They are modals with their own machinery.


**Enrollment** is the second FormPage in Administration. The wizard was four
loose `<label>`s in a flex row of its own markup (`.enroll-form`,
`.enroll-field`, `.enroll-num` — a page-local copy of what FormSection does);
it is a FormSection with one primary now, and those three classes are gone with
their CSS.

"No agent signing key is set" was a red box in the document flow. It said what
was wrong, and — for an admin — linked to Settings. It is a state with the
button, and for a reader who cannot fix it themselves it names who can rather
than offering a screen their role does not open.

The status column was `.badge <status>`, styled by whatever word the server
sent. It is a contract Badge on a tone (active → ok, expired → warn, revoked →
crit), so a status the palette never heard of is neutral rather than unstyled.

Delete was a red button in every row. The row has no primary action — a code is
not a page — so the ⋯ menu carries the one destructive entry and nothing else.
"Delete all expired" stays a panel action, offered only when there is something
to clear.

The panel head carried the title, a three-line explanation and two buttons on
one line. The explanation is an inline note above the table, which is what an
advisory about the data is for; the head keeps the count.

**Not migrated, passed in whole:** `renderEnrollResult` — the generated command,
the live "waiting for agent" socket state, the Windows two-step variant and the
manual download + checksum block.


**Discovery** is a DashboardPage of four panels: the scan scope, a manual
sweep, the candidates, and the sweep log.

The scope form was `.discovery-form` + `.discovery-form-row` + a local
`field()` — a page-local copy of FormSection, three classes deep, with its own
grid. It is a FormSection; the whole `.discovery-*` block is gone from
`styles.css`.

A failed save used to write into a `<span class="error">` beside the button.
That part was right, and it stayed: the server validates per field and returns
`details` keyed by field, so the message belongs next to the button that
failed, not in a toast that is gone before the reader looks back at the form.

**The counts were the filter all along.** "discovered 4 · promoted 1 · ignored
9" was a grey sentence, next to a `<select>` that did the filtering. They are a
StatStrip now — the same move Events and Situations made — and clicking the
pressed one clears it.

Promote and Dismiss were two buttons in every candidate row. Promote is the
row's action on hover; Dismiss is the ⋯ menu, because dismissing something you
have not looked at should take one more beat than promoting it.

Every status was `.badge <word>` — `online` for a promoted candidate, `muted`
for an ignored one, styled by the server's vocabulary rather than by what the
word means. They are Badges on tones.

**Each panel fails on its own.** There were three separate greys for "Loading…"
and three for the error. A 500 on the candidates now leaves the scope form and
the sweep log standing, and names `GET /api/discovery/candidates` with a Retry.
A 403 on the config is the exception: the nav hides this screen, so a reader who
gets there typed the address — that is a locked EmptyState, not a server
failure, and nothing else is drawn under it.

Only **connected** agents are offered as a sweep vantage. An offline one was
offered before and answered 409.


**System Logs** had a `.history-controls` row: three loose labels, a Refresh
and a status span, all in one flex line. It is a Toolbar, with Refresh as a
toolbar action where every other screen puts it, and a Clear that is present
and disabled rather than appearing and disappearing under the cursor.

The level badge was `.badge danger|warn|neutral|active` — a fourth vocabulary
for severity, in an app that already had one. It is a Badge on the same
crit/warn/info/neutral tones the rest of the app reads.

**"server logs unavailable: …" used to be appended to the row count**, in the
same grey span, so the sentence read "42 entries shown · server logs
unavailable: HTTP 500". A ring that cannot be read is not a footnote to a
count: it is an inline note above the table, and it says what the rows below it
then are — this browser's own log, and nothing else. It is still never a toast,
because a toast here re-enters `recordClientLog`.

An empty table said nothing at all; it now says whether the ring is quiet or
the filter matches nothing, and only the second offers a Clear.

**Kept exactly as it was:** the faceted counts. Each dropdown counts over the
set the OTHER filter narrowed, so a selected level still shows how many entries
each source holds — which is what makes the selection reversible without
guessing. The level filter is a floor ("Warn+"), not an exact match.


**User Logs** is the audit log, and the screen where the DataTable's one rule —
**a row is one line** — did the most work. Every row had three stacked lines in
three of its six cells: the action label over the raw key over `POST
/auth/login · HTTP 401 · 10.0.0.44`, the name over the e-mail, a flag's reasons
under its badge. Six columns of that overflowed the panel at 1280 and pushed
the flag text off the right edge.

The row is five one-line columns now, and everything under them opens in a
**Drawer**: why it was flagged, the account behind it, what was done, and the
request that did it. That is where the contract puts detail, and it is the only
place with room for a whole request line.

"flagged: 3" was a warn badge inside a grey summary line. A count that is the
reason to open the page is a stat: the StatStrip carries actions / people /
flagged, and clicking flagged filters — the same move Events, Situations and
Discovery made. The "Flagged only" checkbox went with it.

**Kept deliberately:** an unflagged row carries no badge at all. A green "OK" on
every line is noise, and a flag only means something if it is rare enough to
notice. The flag rules and their wording stay server-side in
`src/audit/userActivity.js`, so this screen and the CSV export can never
disagree about why something was flagged — and the export still asks with the
filters the reader set.

A failed load used to put a red box **above an empty table**, so the screen said
"it broke" and "nothing happened here" at the same time, with the summary still
showing counts the load never returned. It is one ErrorState naming
`GET /api/audit/users`, with a Retry, and nothing else.

With both log screens migrated, the `.logs-table` / `.log-row-error` block is
gone from `styles.css`.


**Settings** is the sixth shell migration, and the one that reverses an earlier
decision on purpose.

The section picker was `.settings-nav`: five wrapped clusters of `.small ghost`
buttons with an `.active` class — **twenty-two buttons pretending to be tabs**,
which the "Forbidden after migration" list names outright. An earlier test
defended them, on the reasoning that they were "destinations, not tabs". The
addresses say otherwise: they are `/settings/<section>`, one screen with
sections, and selecting one swaps the panel below it without leaving the page.
That is a tablist.

They are **two levels of SubTabs**: the five groups, then the sections of the
group you are in. Five fits a strip and so does eight; twenty-two never did,
which is why they wrapped. The group is derived from the section, so no route
changed — `/settings/retention` still opens Retention, with **Data** selected
above it. Picking a group opens that group's first section, because a group
with nothing selected under it is a strip with no page behind it.

**Deviation, recorded:** the contract asks for one SubTabs row per screen.
Settings has two, for the same reason Reporting does — the second level belongs
to whatever the first level selected.

**The shell draws no panel around the section.** Every section body already
builds its own `.settings-card`, so a contract panel around it was a box inside
a box with the section's name written on both. The panel is kept for the two
states a section cannot draw itself: the skeleton while it loads, and the
ErrorState when it throws. The licence answer, which needed a home once the
panel head was gone, is a Badge in a Toolbar row that moves with the section —
it used to be `.badge active|bad` on a bare `div` above the strips, describing
whichever section happened to be open.

A section that threw used to replace the entire page body with a red box, so a
failing section looked like a broken Settings. It is an ErrorState in the
section's slot, with the section still selected, so Retry has something to
retry.

**Not migrated, passed in whole:** all twenty-two section bodies.


**Login and the forced password change** are the last two screens of phase 3,
and the only two that are static markup in `index.html` rather than a view
module. `render()` never touches them, so — like the sidebar — they carry
`data-i18n` attributes that `applyStaticTranslations()` walks.

They were `.login` + `.card`: a 340px box with `<label>Email <input></label>`
inside it, one unstyled `<button>`, and `<p class="error">`. They are on the
contract's tokens and controls now, under a `.ui.ui-auth` scope with an
`.auth-card` — the two labelled fields are `.f`, the submit is one
`.btn-primary`, and the error is the same `.field-error` a form field uses,
with `role="alert"` and `:empty { display: none }` so it holds no line until
something goes wrong.

**The forced-change screen read both languages at once.** Every line of it was
hardcoded `Ny adgangskode / New password` — Danish, a slash, English — because
it predates the translation layer and nobody wanted to pick. It goes through
`t()` now, and a test walks both screens asserting that no visible string is
hardcoded and that neither carries ` / `.

The SSO sign-in options were `.sso-button`, a hand-rolled link that looked
almost like a button. They are `a.btn.btn-secondary`, and `.ui a.btn` drops the
underline the global anchor rule would otherwise put back.

**Not a page template.** These two are on the contract's components but on no
page template: there is no shell around them, and a sidebar the reader cannot
use would be a lie.


**Agents** carried **nine** buttons in every row's last cell — Traffic, Flows,
Ping, Diagnose, Speed, Run test, Edit, Update, Delete — with Delete at the end
of the run. The row opens the agent, "Run test" is the row's action, and the
rest are in the ⋯ menu, grouped: the six checks that only look, then the two
that change something, then Delete alone behind a separator.

The table sorted itself by rewriting `th.textContent` with a ▲ or ▼ glued to the
label and setting `aria-sort` by hand. That is the DataTable's job.

**Two columns went, and the table stopped overflowing.** Nine fixed widths came
to 1196px; at 1280 "Last reported" and the whole action column were past the
right edge.

- **Status** was redundant *by construction*: Health is derived from it —
  `status !== 'online'` **is** `down` — so the two columns said the same thing,
  one of them less precisely. Health keeps the distinction Status could not
  make: an agent that is connected and has gone quiet.
- **ID** went with it. The row opens the agent, and the id is in that address.
- **Platform** went too. It changes once in an agent's life, and the one
  decision it drove — whether an update is one click or an installer job — is on
  the version badge. The filter still matches it, so "windows" still finds the
  Windows agents.
- The **version** got a column of its own instead of a second line under the
  platform. It is what "Update outdated (3)" in the header is about, and sorting
  by it puts the stragglers first rather than sorting version strings
  alphabetically.

What is left is six columns, only three of them pinned — the badge, the
timestamp and the actions. Pinning all of them squeezed the agent's own name,
the point of the row, down to a hundred pixels and truncated it.

The status chip was `.badge <status> clickable` — a chip you could click, which
is a button wearing a badge. The connection diagnosis is a menu entry now, with
the other checks. The source cell's capability list and hsflowd state moved to
the agent page, where the detail lives.

`agentHealthCell` and `agentHealthRank` are gone from `app.js`: two copies of
the same rule, one for the cell and one for the sort, on a screen that no longer
draws either.


**Interfaces** is a ListPage, and its table is **exported as well as drawn**:
the agent detail page renders the same interfaces, and two copies of one table
would drift. `app.js`'s `interfaceTable()` reads it off the view module now,
and `IFACE_RANK`, `ifaceStatusBadge` and `ifaceLinkText` are gone with the copy
they served.

`.history-controls` is a Toolbar. `source: proc · measured 14:02` was a grey
span at the end of that control row; it is the panel's note, beside the table it
describes.

The status chip was `.badge online|warn|error|down|grace` reading OK / WARN /
ERR / DOWN / IDLE — a fifth vocabulary for severity. It is a Badge on the app's
tones. Errors and discards carry a tone on the **number**, not a badge: a count
is not a state, so `.num-crit` / `.num-warn` say a port is dropping frames
without pretending the figure is a status.

**An idle virtual port used to sort to the very top.** `docker0` and a handful
of veths are `status: down`, which ranked them first — above the port that was
actually erroring. They read IDLE, which is not a fault, so they rank below OK
as well.

**The flow-source empty state keeps every word.** An agent on sflow or netflow
reports sampled conversations, not per-interface counters, so this table is
*always* empty for it however healthy Diagnose looks. Telling that reader "no
data yet" sends them to update an agent that is working. It says what its source
does, which two sources would fill this table, and which screens do use what
this agent reports — and it now offers the button that changes the setting.
