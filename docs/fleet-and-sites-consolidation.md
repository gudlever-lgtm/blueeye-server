# Fleet and Sites consolidation

Two places in the nav named the same thing twice, and four screens described one
object between them. This document is the design and the record of what changed.

The estate is two objects: an **agent** and a **site**. Before this change each
was split across two or more screens, and the split was not by object but by
who was asking:

| Object | "How is it?" | "What is it / manage it" |
|---|---|---|
| agent | Monitoring → **Fleet** | Fleet → **Agents**, **Interfaces**, **NICs** |
| site  | Monitoring → **Sites** | Administration → **Locations** |

Nothing about the object changes when the question does. So the split put the
same row on two screens, and the reader had to know which of the two to open
before they knew what they were looking for.

---

## 1. What was wrong, concretely

### Fleet vs Agents — the same table with two definitions of health

Both list every agent. Both show name, health, site and a last-seen timestamp.
The difference is what else they carry: Fleet adds the measurements (loss,
latency, jitter, targets, throughput), Agents adds the administration (version,
source, and the nine row actions).

Health, though, was computed in two places:

* **Fleet** — `health.status` from the server (`src/health/probeHealth.js`),
  folding active probes, the interface signal, throughput and connection state
  into one verdict with a reason and evidence behind it.
* **Agents** — computed in the browser: `status !== 'online'` ⇒ `down`, else the
  age of `last_report_at` (≤ 5 min ⇒ `healthy`, older ⇒ `delayed`).

Same word, two answers, and the weaker one was on the screen an operator opens
to act. The same went for "last seen": Fleet showed the last *probe* timestamp
(`metrics.lastTs`), Agents the last *report* (`last_report_at`).

Fleet also carried a STATUS column beside HEALTH, which repeated it: an offline
agent read `OFFLINE` and `STALE` side by side, because `mergeConnection()` has
already folded connection state into the verdict.

### Interfaces — a fleet screen that could only show one agent

The Interfaces page was per-agent behind a dropdown: you chose the agent you
already had in mind. It could not answer "which ports in the estate are
dropping frames", which is the question a fleet-wide screen exists for. Its
per-agent table was already duplicated as a fold on the agent page.

### NICs — an inventory report in a monitoring menu

Driver and firmware strings change when someone updates a machine. The screen
answers "which firmware is deployed where", which is asset work, not monitoring.
Its per-agent tab duplicated the NIC fold on the agent page.

### Sites vs Locations — the same list, twice

`Monitoring → Sites` is a map of sites coloured by worst agent health, with a
rollup table. `Administration → Locations` is a table of the same records with
the create/edit/delete actions. Each carried a button pointing at the other
("Manage sites" / the map), which is the tell: two halves of one screen that
knew it.

In Danish the nav made it plainest — `Lokationer` and `Lokationsregister`, two
menu entries for one register.

---

## 2. The shape it takes now

```
MONITORING            FLEET                 ADMINISTRATION
  Changes               Fleet                 …
  Fleet   ← removed     …                     NIC inventory  ← moved here
  Traffic                                     Locations      ← removed
  Sites
  Destinations
```

Two consolidated screens:

* **Fleet** — one table of agents, three column sets, a drawer per row.
* **Sites** — one screen, two tabs: the map and the register.

### Why column sets rather than sub-tabs

Sub-tabs were the obvious move, and they are the wrong one here. Tabs change the
rows: Fleet lists agents, Interfaces lists ports, NICs lists models. The reader
loses their place, their filter and their sort at every switch, and has to
re-establish which population they are looking at.

A column set keeps the rows identical and changes only what is said about them.
The filter, the sort and the scroll position survive the switch, and the
sentence is simple: *these are the agents — choose what you want to know about
them.*

---

## 3. Fleet: the column sets

### Fixed columns (present in all three sets)

| Column | Width | Source | Note |
|---|---|---|---|
| AGENT | flex | `displayName` + `hostname` beneath | ⚠ marks poor data quality (`quality.status`), title carries the reason |
| HEALTH | 120px | `health.status` | one verdict, offline included as a tone |
| SITE | 140px | `locationName` | |
| LAST SEEN | 128px | `lastReportAt` | the agent's last report, not the last probe |
| ⋯ | 116px | — | operator/admin only; primary action is Run test |

The STATUS column is gone: `mergeConnection()` already turns an offline agent
into `down`, so the two columns said one thing twice. The probe timestamp moved
into the drawer, beside the measurements it belongs to.

### Set 1 — Health (default)

`LOSS · LATENCY · JITTER · TARGETS · SPEED`, from `health.metrics` and
`throughput`. Unchanged from the old Fleet grid. Answers "is the estate well
right now".

### Set 2 — Drift

`VERSION · SOURCE · DATA QUALITY`, from `GET /agents`.

* VERSION carries the update badge; sorting puts agents that are behind first,
  which is the only reason to sort on a version.
* SOURCE is `monitor_config.source` (+ SNMP host).
* DATA QUALITY promotes `quality.reason` from a ⚠ with a tooltip to a column.

Platform and architecture are deliberately not columns — they change once in a
machine's life, and the one decision they drove (one-click update or installer)
is already on the version badge. They are in the drawer.

The bulk action "Update outdated (n)" belongs to this set and appears only here.

### Set 3 — Hardware

`PORTS · PORT FAULTS · LINK · NIC · FIRMWARE`.

The interface figures need **no new endpoint**: `mergeHealth()` already writes
`ifaceStatus`, `ifaceCount`, `ifaceIssues` and `worstIface` into
`health.metrics` (`src/health/probeHealth.js`), so `/api/fleet/health` has
carried them all along. NIC count and the firmware-outlier flag come from
`GET /api/fleet/nics`, whose payload already includes a `byAgent` breakdown.

The set is a summary, not a port list — the ports themselves are in the drawer,
where an agent has been chosen. It hides itself entirely when no agent in the
estate reports either interface counters or NIC data, the same way
`data-feature` hides geo and analysis: an estate on netflow should not be
offered a set that can only explain why it is empty.

### Loading

| Set | Call | Frequency |
|---|---|---|
| all (fixed columns + StatStrip) | `GET /api/fleet/health` | poll, 10 s |
| Drift | `GET /agents` | once, cached per view entry |
| Hardware | `GET /api/fleet/nics` | once, cached per view entry |

Version, source and firmware move in days. They have no business in a
ten-second poll, so they are fetched on first use of their set and kept.

---

## 4. Fleet: the drawer

A row click opens a drawer instead of navigating. `ui.dataTable` already
supports it and `ui.openDrawer` already handles the scrim, Escape, focus return
and the row's `aria-selected`.

```
┌─ ts-pi5 ──────────────────────── HEALTHY · ONLINE ─ [×] ─┐
│ raspberrypi · Thomas test site · last seen 15:35          │
├───────────────────────────────────────────────────────────┤
│ VERDICT       health.reason + health.evidence             │
│ MEASUREMENTS  loss / rtt / jitter / targets / speedtest    │
│ PORTS (7)     the shared interface table  [ Refresh ]      │
│ NIC (2)       the shared NIC table                         │
│ IDENTITY      platform · version · source · site · report  │
│ Investigate:  [Probe] [Diagnose] [Investigate] [Log]       │
├───────────────────────────────────────────────────────────┤
│ [ Open agent page → ]                      [ Run test ] ⋯ │
└───────────────────────────────────────────────────────────┘
```

Almost all of it is reuse: `interfaces.table()` and `nics.nicTable()` are
already exported for the agent page, `contextActions()` already builds the
hand-off row, and the ⋯ menu is the agent row menu. The only call the drawer
makes on its own is the port list.

**Rules**

* **Deep link** — the open agent is written to the address (`?agent=<id>`), so a
  reload or a pasted link opens the same agent on the same column set.
* **Polling** — the drawer starts no poller. The ten-second fleet poll keeps the
  verdict and the measurements live; the port list has an explicit Refresh,
  because a five-second poll under a table someone is reading is hostile.
* **Failures are per section** — a 404 on `/api/interfaces` (the agent was
  deleted while the drawer was open) or a 500 renders an ErrorState *in the
  ports section*, naming the call, with a Retry. The rest of the drawer is
  still correct and still useful, so it stays.
* **Flow sources** — an agent on netflow/sflow keeps the explicit empty state
  that says this table can never fill and what to change. That is a different
  message from "no data yet", and the difference is the whole point of it.

What is **not** in the drawer: config history, the CMDB asset, dependencies, the
activity timeline and the four live folds. That is the agent page, and one
button at the bottom goes there. A drawer that takes a minute to read is a worse
copy of the page.

### The capacity forecast

The 14-day interface capacity forecast moved to the agent page's Interfaces
fold. It reads two weeks of history per agent; running it for the estate, or
inside a drawer that opens on a click, is an expensive answer to a question
whose answer moves in days.

---

## 5. Sites: map and register

One screen, two tabs, `/sites` and `/sites/list`:

* **Map** — the existing site map, the health StatStrip and the rollup table.
* **Register** — the existing locations table with its row actions (edit,
  traffic, history, AI summary, delete), role-gated exactly as before.

The two cross-links ("Manage sites" on one, the map on the other) are gone:
they were navigation between two halves of one screen. `/locations` redirects to
`/sites/list`; `/locations/:id` is untouched — a site's own page is a real
destination and keeps its address.

---

## 6. Addresses

New:

| Path | Screen |
|---|---|
| `/fleet` | Fleet, Health set |
| `/fleet/drift` | Fleet, Drift set |
| `/fleet/hardware` | Fleet, Hardware set |
| `/fleet?agent=12` | Fleet with agent 12's drawer open |
| `/sites` | Sites, map |
| `/sites/list` | Sites, register |
| `/nic-inventory` | NIC inventory (Administration) |

Redirected, so existing links and bookmarks keep working
(`ALIASES` in `public/routes.js`):

| Old | New |
|---|---|
| `/agents` | `/fleet/drift` |
| `/interfaces` | `/fleet/hardware` |
| `/nics`, `/nics/models`, `/nics/agents` | `/nic-inventory` |
| `/locations` | `/sites/list` |

`/agents/:id` (the agent page) and `/locations/:id` (the site page) are
unchanged.

---

## 7. What this touches

* `public/routes.js` — the tab sets, the removed view keys, `ALIASES`.
* `public/views/fleet.js` — column sets, the drawer, the merged data.
* `public/views/sites.js` — the tab shell; `public/views/locations.js` exposes
  its table as a body the shell can host.
* `public/views/interfaces.js` — keeps the shared table and the forecast table,
  loses its own page.
* `public/views/nics.js` — the models inventory only; its per-agent tab is the
  drawer now.
* `public/index.html` — the nav rail.
* `public/app.js` — the view wiring, `PAGE_INFO`, `VIEW_LABELS`, the teardown
  table, the cross-links in the help drawers.
* `public/i18n.js` — new keys in **both** catalogues.
* `test/gate/*` and `scripts/ui-check.js` — the sweeps follow the new surface.

The gate is what keeps this honest: it sweeps every `data-view`, every `t()`
key in both locales, every `PAGE_INFO` entry and every registered route, so a
half-finished move fails the build rather than shipping a menu entry that opens
nothing.
