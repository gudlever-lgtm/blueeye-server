# Changelog

## 0.115.2 — The Windows install command no longer looks like a PowerShell stager

A customer's IPS fired on their own BlueEyes server:

```
IPS Alert 2: Potentially Bad Traffic. Signature ET ATTACK_RESPONSE PowerShell
NoProfile Command Received In Powershell Stagers.
From: <server>:3000, to: <operator PC>, protocol: TCP
```

Nothing was compromised. The Windows install command we handed out was
`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm <url>/install.ps1 |
iex"` — a download cradle, which is the shape every PowerShell stager has. The
Emerging Threats rule matches that flag combination inside an HTTP response body,
so it went off on the **dashboard response** that showed an operator the command,
over cleartext `http://…:3000`. On the host the same pattern is what endpoint AV
blocks, which is the other half of why the agent was hard to get installed.

The command now downloads the script and runs the file:

```
<TLS/pin prelude> Invoke-WebRequest -UseBasicParsing -Uri '<url>/install.ps1' -OutFile "$env:TEMP\blueeye-install.ps1"; Set-ExecutionPolicy Bypass -Scope Process -Force; & "$env:TEMP\blueeye-install.ps1"
```

- **The script lands on disk before it runs**, so AMSI and antivirus can scan it,
  an operator can read it first, and it can be allowlisted by path.
- **`Set-ExecutionPolicy Bypass -Scope Process`** replaces the
  `-ExecutionPolicy Bypass` flag: this process only, no admin rights needed, the
  machine's policy untouched.
- **`-NoProfile` is gone.** It bought nothing in an elevated admin shell, and it
  is the literal token the rule matches on.
- The same applies to the **update** and **uninstall** commands, and to the
  generated scripts themselves — their own comments and hints used to spell the
  cradle out, so downloading `install.ps1` tripped the rule a second time.

Nothing is encoded or hidden, and integrity is unchanged: the download is still
pinned to the server's certificate fingerprint when one is configured, and the
agent bundle is still verified against the SHA-256 embedded in the script.

Around it:

- `GET /api/enroll/command` and `/api/enroll/update-command` return `steps`
  (`download` / `run` / `scriptUrl` / `scriptFile`) beside `oneLiner`, and the
  dashboard offers **"Run it in two steps"** so an operator can read the script
  in between.
- `install.ps1`, `update.ps1` and `uninstall.ps1` accept **`?download=1`** and come
  back as a named attachment — for a host that cannot fetch the script itself and
  needs it carried over.
- The command is now meant for an **elevated PowerShell** specifically; it is no
  longer wrapped in `powershell -Command "…"`, so `cmd.exe` is not a host for it.

If the IPS alert is what you are chasing: also put the dashboard behind TLS. The
command was only readable on the wire because it crossed the network in cleartext
on port 3000. `docs/enrollment.md` has the full reasoning under
**Why not `irm … | iex`**.

## 0.114.1 — Troubleshooting stops loading 28 000 alarms to draw four numbers

The Troubleshooting tab took the better part of a minute to paint on a busy
fleet. The cause was one line: for every live root cause it re-read each member
finding with `findingStore.get(id)`, one query per member. A hundred clusters
holding 28 574 alarms meant 28 574 round trips queued behind a ten-connection
pool — to compute four key figures and a severity badge.

Two changes, and the screen is back to one read:

- **The rollup hydrates in bulk, through a narrow projection.**
  `FindingStore.listByIds(ids, { light: true })` reads members in 1000-id
  `IN (...)` batches and selects only `id/host_id/metric/severity/kind/acked/
  created_at` — no `evidence` or `correlated_with` JSON. That is exactly what the
  severity, affected-device and classification rollups consume, and it is the
  difference between a few hundred KB and tens of MB on the wire. A store without
  `listByIds` still works; the per-id path is now the compatibility fallback, not
  the normal one.

- **The raw alarms are opt-in.** `GET /api/troubleshooting/faults?limit=&offset=
  &clusterId=` returns the full findings behind the live root causes, paged
  (1..500 per page, default 100), in the same order the root-cause panel renders.
  `/overview` never carries them.

On the dashboard, the **Active faults** card now says how many there are and
offers a link to list them. The figure itself was always free — it is the sum of
each cluster's stored member ids — so the card costs nothing; the rows behind it
are fetched only when asked, a page at a time, under a counter that reads
"Showing 200 of 28 574" while it works. Everything else on the screen is there
before you ask, as before.

A member whose finding retention has already purged still gets a row, flagged
`missing`, rather than being dropped: silently short pages would leave that
counter permanently unable to reach its total.

New strings are in both the en and da catalogues.

## 0.113.0 — Trace the path the traffic actually takes

Traceroute sends ICMP or UDP. Plenty of firewalls and transit providers drop or
rate-limit exactly those while passing the TCP session an application uses, so
the path map goes dark at hop 4 while the service it is tracing works fine. The
operator is left with a blank map and no way to tell "the path is broken" from
"the path won't answer *this* probe".

A second trace type answers that: **TCP traceroute** walks the same path with
TCP SYNs to a port, so it follows the route the real traffic takes.

`tcptraceroute` had been on the agent's installable-tool allowlist since the
install-tool feature shipped, and nothing used it. It does now
(`blueeye-agent/src/probes/tcptraceroute.js`), with a fallback: where the binary
is absent the probe traces with `traceroute -T -p <port>` instead, which the
traceroute package already provides for the ICMP probe — so on most hosts this
works with nothing installed. When BOTH are missing the reported reason names
`tcptraceroute`, because that is what auto-install can actually offer; naming
the fallback would promise a fix the allowlist cannot apply. Both binaries need
raw sockets, so a permission failure gets its own reason rather than an empty
path.

Server side, the two traces are deliberately **kept apart**:

- `GET /api/probes/path` takes `probeType` (`traceroute` default, or
  `tcptraceroute`) and echoes it back. An unrecognised value falls back to the
  default rather than 400 — the view still renders.
- A TCP trace stores its target as `host:port`, so the same host traced two ways
  stays two series.
- The hop table names which probe drew the path.

Averaging them would have been the easy default and the wrong one: an ICMP path
that dies at hop 4 beside a TCP path that completes IS the finding, and merging
the two erases it.

The hop record is identical either way, so `buildPathGraph`, the geo path
overlay, the metric timeline and the scheduled test packages all took the new
type without change.

## 0.112.1 — The events list says what its columns do not

The Events table repeated itself three times over. The server stores a
self-contained title — `${SEV} ${metric} on ${device (site)}` — which is right
where it stands alone (the detail-page heading, an ITSM ticket subject, an alert
body), but in the list severity, device and location are each already a column:

    CRIT | Open | CRIT probe.latency on Localhost agent test (gnf-server-agent)
         | Localhost agent test #1 | gnf-server-agent | 31/07/2026, 13:17:30

Three of five columns saying the same thing, with the one piece of information
unique to the title — `probe.latency` — buried in the middle of it.

The column is now **Condition**, rendering `EventTitle.conditionOf()`
(`public/eventTitle.js`): the title with a leading severity and a trailing
` on <device label>` removed. The full stored title is the cell's tooltip, and
nothing rewrites the stored value.

The trim is deliberately conservative, because a wrong strip silently changes
what an operator reads:

- the severity comes off only when it matches the row's own badge — a title
  describing a *different* severity is left alone;
- the device tail only on an EXACT match against the label that row is
  displaying, so an agent renamed since the title was stored keeps its full
  title rather than silently hiding the discrepancy;
- a metric that legitimately contains " on " is not mistaken for a device tail;
- a title that would trim away to nothing, or to a bare `on <device>` fragment,
  is shown as stored;
- a hand-written title is returned untouched.

### A guard for the wiring

`public/app.js` reaches its helpers through globals they register on `window`;
there is no build step and no module loader. A helper that is not script-tagged
in `index.html` is simply `undefined`, and the first row that touches it throws —
a blank table, no build error, nothing in the tests. A new test asserts every
`window.*` helper app.js uses is loaded, and that index.html loads no script that
does not exist. Mutation-checked by removing the tag.

### Not changed

The **location** column showing an agent-like name (`gnf-server-agent`) is not a
join bug — `list()` reads `locations.name` for the agent's `location_id`. That
site record is genuinely named that; rename it under Sites.

## 0.111.1 — One event per condition, and a changes feed you can scan

Two reports, and they turned out to have separate causes.

### The Events tab was one event per breach, not one per condition

`eventCaseService` grouped a new anomaly into an open event only if it arrived
within **60 s** of that event's last activity, while `autoResolveJob` waited
**15 min** of quiet before calling the condition finished. The gap between those
two numbers was a bug: for fourteen minutes an event was still **open**, but a
new anomaly refused to join it and opened a *second* open event on the same
device. Probes report on a cadence of minutes, so in practice every recurring
breach spawned its own event — one device with a flapping probe filled the tab
with near-identical rows.

Both now read one constant, `EVENT_ACTIVITY_WINDOW_MS`
(`src/eventCases/activityWindow.js`). Grouping and finishing are the same
judgement — "is this condition still going?" — so they cannot drift apart again;
a test asserts they agree. The 60 s came from the correlator, which answers a
different question: it groups findings that fired *simultaneously* into one root
cause, not a condition tracked over its lifetime.

Recurrence keeps an event alive — each anomaly that groups in advances
`last_event_at` — so a condition that keeps firing stays **one** event for as
long as it lasts. A quiet gap longer than the window still starts a new event,
which is the honest boundary: it means the condition cleared and came back.

**No migration.** This changes only how *new* events are grouped; existing rows
are untouched.

### The changes feed was hard to read

- **A horizontal scrollbar on the whole page.** `.chg-indicates` combined
  `flex-basis: 100%` with a left margin, so the line was 100% + 10.5rem wide and
  overflowed its container. It is padding now (inside the basis, under the global
  `box-sizing: border-box`).
- **Raw ISO timestamps** — `2026-07-31T11:05:05.000Z` filled the time column,
  because three feeds called `TimelineView.renderRow` without `formatTime` while
  every other timeline passed `fmtDate`. All three pass it now.
- **Chips marooned at the right edge.** The summary was `flex: 1 1 auto`, so it
  ate the free width and flung the row's own metadata — recurrence, folded count,
  device — hard against the right edge with a chasm between a sentence and the
  chips describing it. The summary now takes only the width it needs; only the
  device control stays right-aligned, and the list has a max measure so that rail
  never strands itself on a wide screen.
- **The severity was printed twice** — a `CRIT` badge next to a summary opening
  "CRIT probe.latency on…". The leading token is dropped when it matches the
  badge, and only then.
- **The same sentence on every row.** "What this indicates" is per *condition
  family*, so eight latency events repeated it verbatim eight times, doubling the
  height of the feed to say one thing. It prints once per run of a family now; a
  row with no family (a situation, an agent transition) does not break the run.
- Recurrence and folded-count chips read as one family instead of three
  different fills, and the current-state badge is short with the full sentence on
  hover.

### Guards for the silent-failure classes these came from

The dashboard has no build step, no CSS linter and no DOM test, so all three of
these failed quietly. New tests read the source: every `renderRow`/`renderInto`
caller passing an inline opts object must set `formatTime`; stylesheets must have
balanced comments and braces (an unclosed comment silently eats the next rule —
it happened while writing this); and no `flex-basis: 100%` item may carry a left
margin.

## 0.110.1 — The incident vocabulary leaves the code and the database

0.109.0 renamed what a customer *sees* — the tab, the API paths, the response
keys — and deliberately stopped at the storage layer. This finishes the job:
the tables, columns, module directories and audit categories now say what they
mean, and "incident" is reserved for the two places it is genuinely the right
word.

**Breaking.** Read the migration note below before upgrading.

### Two things were both called "incident", and they split

Migration **077** renames them, preserving every row:

| Before | After | What it is |
| --- | --- | --- |
| `incident_cases` | `event_cases` | Grouped anomalies — the Events tab |
| `incident_notes` | `event_notes` | The work log |
| `incident_clusters` | `event_clusters` | Situations (cross-agent) |
| `incident_playbook_runs` | `event_playbook_runs` | Remediation runs |
| `findings.incident_case_id` | `findings.event_case_id` | The link from 048 |
| `incidents` | `probe_outages` | Probe threshold breaches (025) — never an event |
| `incident_thresholds` | `probe_thresholds` | Their thresholds (024) |

The code follows: `src/incidentCases/` → `src/eventCases/`, `src/incidents/` →
`src/probeOutages/`, and the matching repositories, validators, routers and
tests. Every index and foreign key is renamed explicitly — MySQL carries the
OLD constraint names through a table rename, so otherwise the schema would
still be full of `fk_incident_*` pointing at `event_*` tables. Indexes InnoDB
auto-created to back a foreign key are renamed conditionally via
`information_schema`, because whether they exist depends on the server version
and a hard `RENAME INDEX` would abort the migration on a database that lacks
one.

### What deliberately keeps the word

- **NIS2** — `blueeye_nis2_incidents`, `src/nis2/`, the NIS2 tab and the CFCS
  report text. "Incident" is the word the directive uses, and a regulator reads
  the generated report against that wording.
- **ITSM** — ServiceNow's `incident` table, and the stored integration
  subscription names (`incident`, `anomaly`). Those live in customer configs;
  renaming them would silently unsubscribe live integrations.

### Breaking changes

- **`/api/incidents/*` is gone.** `/api/events/*` has been the canonical path
  since 0.109.0; the deprecated alias and the duplicated `incident`/`incidents`/
  `incidentId` response keys are removed. A test asserts the old paths now 404
  rather than quietly answering.
- **Probe-outage reports moved** off the event vocabulary they never belonged
  to: `/api/reports/incidents[.csv|.html]` → `/api/reports/probe-outages[…]`,
  the JSON key `incidents` → `probeOutages`, the CSV filename
  `blueeye-incidents.csv` → `blueeye-probe-outages.csv`, and
  `/api/reports/nis2-draft/:incident_id` → `/nis2-draft/:probe_outage_id`
  returning `probeOutageId`/`probeOutage`.
- **`/api/incident-clusters` → `/api/event-clusters`.**
- **`GET /api/dashboard/advanced`**: the widget `widgets.incidents` (probe
  outages) is now `widgets.probeOutages`, distinct from `widgets.eventCases`.
- **Target timeline**: the `incident` source is now `probe`, and its event types
  `incident.*` are now `probe.*`.
- **No compatibility views.** Anything still querying the old table names fails
  loudly on upgrade instead of silently reading a stale shim.

### The audit trail is read, not rewritten

Audit entries move from category `incident` to `event`. Existing rows are **not**
migrated: `audit_log` is hash-chained, so rewriting them would break the chain
and every later verification. The readers match both categories instead, so an
event opened before the upgrade keeps its full status history. `listByTarget`
now accepts an array of categories for exactly this.

### Upgrading

Run `npm run migrate`. The migration is data-preserving but **not reversible**,
and MySQL commits DDL implicitly — a failure part-way leaves a partially
renamed schema, so take a backup first. Update any external caller of the
removed paths before upgrading.

## 0.109.0 — Events, not incidents; and a feed that correlates instead of counting

Two complaints, one root cause. The changes feed listed an **anomaly** row *and* an
**event** row for the same detection, then repeated that pair every time the
condition came back — "Critical (52)" for a handful of actual problems. And the
row that did the double-counting was labelled `incident_case`, a table name, next
to a run-together `finding.probe.latencyprobe.latency`.

### Fewer rows, and what they indicate

Two reductions now run in `src/changes/changeFeed.js` **before** ordering and the
cap, so the cap's budget goes to distinct conditions instead of repeats of one —
a single flapping link can no longer push everything else off the page.

- **Roll-up.** An anomaly whose event is also on the feed is folded *into* that
  event, which carries `findingCount`. The event exists precisely to represent
  those anomalies; listing both double-counted one detection. Matched on
  `findings.incident_case_id`, with `primary_finding_id` as a second signal so the
  very first anomaly of a case (whose FK may not be written yet) folds too.
- **Collapse.** Repeats of one condition on one device become **one** row carrying
  `count`, `firstAt` and every `refIds`. A condition that reopened seven times in
  four hours is one chronic problem, and `7× since 07:15` says so where seven rows
  only implied it. Key: `kind|source|type|agentId|metric|severity` — a fold never
  crosses a device, a condition, a severity (an escalation stays its own row) or a
  transition direction, so "went offline" is never folded into "came back online".
  One-off artifacts (config captures, topology changes, playbook runs) and
  `currentState` rows are never folded: three config pushes are three pushes.
- **It says what it folded.** `rawTotal` and `correlated` join `total`, and the
  page prints them — a feed that quietly compressed 120 occurrences into 14 rows
  would otherwise read as a suspiciously quiet shift.
- **"What this indicates."** Each row carries a condition `family` from the new
  `src/changes/indications.js` (latency, interface, saturation, loss, certificate,
  routing, resources, …), rendered as one sentence under the row. Local,
  deterministic, regex-on-family — an unrecognised metric yields `null` and no
  sentence, because no interpretation beats a confident wrong one. Wording lives in
  `public/i18n.js` (`changes.indicates.*`, en + da), not in the server.
- `incidentCasesRepository.list()` now joins the primary anomaly's metric
  (`primaryMetric`), because correlating on the row id instead of the condition
  makes two unrelated events on one device look like one recurring problem.

### The rendering bugs behind the screenshot

- The feed renders its rows into `ul.timeline-list`, which never picked up the
  flex/gap rules `ul.timeline` has — so every chip abutted the next. Both parents
  are styled now.
- The type chip drops its source prefix and hides entirely when the summary
  already spells it out: `finding.probe.latency` beside "probe.latency on core-sw"
  was duplication twice over. Matched on **word boundaries**, so a site named
  Copenhagen cannot suppress an `open` status chip by containing the letters.
- `SOURCE_LABELS` had no entry for `incident_case`, which is why a table name
  reached the page. Every source a mapper emits now has a label, and a test
  asserts it.

### Events, not incidents

BlueEyes produces **events**; an **incident** is what a connected ITSM opens from
one, and it lives there with its own number, SLA and owner. Calling our own row an
incident made the two indistinguishable and implied BlueEyes does incident
management, which it deliberately does not. New doc: **`docs/events.md`**.

- The dashboard tab is **Events**; `views.events` / `views.event`, `PAGE_INFO.events`,
  and the page help now states the boundary outright.
- **`/api/events/*` is canonical.** `/api/incidents/*` stays mounted as a
  deprecated alias — the *same router instance*, so the two cannot drift — and
  every response carries `event`/`events`/`eventId` alongside the old
  `incident`/`incidents`/`incidentId` keys. Existing integrations keep working.
- The changes feed's two records that used to share the kind `incident` are now
  distinct: `event` (`incident_cases`) and `probe` (the probe-outage `incidents`,
  migration 025), whose transitions read `degraded`/`recovered`.
- **Unchanged on purpose:** the `incident_cases` / `incidents` / `incident_notes`
  tables (renaming buys nothing a customer sees and costs a migration on live data
  with five FKs); the integrations' stored subscription names (`incident`,
  `anomaly`) — renaming them would silently unsubscribe live integrations, and
  `incident` there now literally means "the subscription that opens an ITSM
  incident"; ServiceNow's `incident` table; and **NIS2 incidents**, where
  "incident" is the word the legislation uses.

## 0.108.0 — CMDB asset picker: search by asset ID, name or location

Linking an agent to its CMDB asset was a free-text box that searched asset
**names** only, and it was shown even when no CMDB was connected.

- **One term, three fields.** ServiceNow ORs `name` / `sys_id` / `asset_tag` /
  `location.name` in a single encoded query (the term is stripped of `^` and `,`
  so it cannot open a condition of its own); Nautobot merges its `q=` read with a
  `location=` read, deduplicated by id and best-effort — a rejected location
  filter leaves the `q` results intact. The custom connector stays config-driven.
- **A real dropdown.** The agent page's CMDB card is now a combobox: options are
  fetched per keystroke (debounced, min 2 chars — a CMDB holds more assets than a
  `<select>` can), each row shows name, id, type and location ("No location in
  CMDB" when it has none), and ↓/↑/Enter/Esc work.
- **New `GET /api/cmdb/assets/status`** (operator+, safe config only) — the card
  asks first, so with no CMDB connected it says so and points an admin at
  Settings → CMDB instead of offering a search that can only 404.

## 0.107.0 — Incidents say where they are (agent + location)

An incident read "WARN probe.latency on 1" and its Device column was empty, so
placing a case meant looking the agent id up somewhere else. Every surface that
names an incident now names the **agent** and the **location** it stands at.

- **The auto-generated title** resolves the agent: "WARN probe.latency on
  **core-sw (Copenhagen HQ)**". Best-effort — an unknown/deleted agent or a
  failed lookup falls back to "device 1" and never blocks the incident.
- **The read API** joins `agents` + `locations` onto `GET /api/incidents`,
  `GET /api/incidents/:id` and the similarity pool: `agentName`,
  `agentHostname`, `locationId`, `locationName`. Since it is a join on read, a
  renamed or relocated agent immediately reads correctly on **old** incidents
  too — the frozen title is not the only answer.
- **`explanation.where`** gains `locationId`/`locationName` and a ready-made
  `summary` ("core-sw (Copenhagen HQ)").
- **Dashboard**: the Incidents list gains **Device** and **Location** columns
  (location narrows client-side — incidents are keyed by device, not by site),
  the detail header names the agent (linked to its page) and its site, and the
  Overview "open incidents" rollup shows the same agent · site pair the
  probe-outage rollup already did.

Fixed along the way: the incident device was read as `deviceId` in the dashboard
and in the Overview rollup, but the repository has always returned `hostId` — so
the Device column, the detail header and the rollup rendered blank. The
"Affected path" card and the guide's config-context action were reading the same
missing field.

## 0.99.0 — Consolidated Troubleshooting Dashboard

One screen for an outage: **what is failing, what it affects, and when it
started** — without switching views.

New read endpoint `GET /api/troubleshooting/overview` (operator+) returns the
whole screen in one request: key figures, the L2/L3 topology with per-node
state, the correlated root causes with their blast radius, flow-pair baseline
deviations and a change timeline. New tab **Troubleshooting**.

**It owns no data.** No tables, no migrations — it is a read/aggregation layer
over five capabilities that already existed (topology rediscovery, service
dependency mapping, blast radius, flow-pair baselining, active discovery) plus
the cross-agent correlator, each of which keeps its own page and API.

Decisions worth knowing:

- **The rollup is preserved, not re-derived.** One cluster = one root cause,
  never one per affected device. The key figures make the collapse legible —
  "47 alarms → 3 causes" — instead of leaving the operator to divide.
- **Blast radius counts impact *beyond* the devices a cause already names**, so
  a root cause cannot inflate itself; L2-isolated hosts are not double-counted
  as service dependents.
- **Node state is derived and conservative.** `unreachable_downstream` exists
  nowhere in the schema; it means "we cannot hear it", which is not a claim that
  the host is broken — and an unknown agent status maps to `ok`, because we do
  not invent faults we have no evidence for.
- **One graph read.** `blastRadiusService.compute()` rebuilds the whole topology
  graph per call, so the service takes the graph once and runs the pure
  `computeBlastRadius` per node. A test asserts it.
- **Aggregating never widens access.** The endpoint adopts operator+, the
  strictest non-admin level of its sources; admin-only discovery candidates are
  included for admins only — as an empty list, not a 403 for everyone else.
- **Fail-closed per panel.** A dead domain lands in `failedSources`, sets
  `partial: true` and costs that one panel; it never blanks the screen.

Read-only — no agent command is pushed, so no signed command and no audit write.

The older location-driven anomaly view is unchanged and is now labelled
**Investigate**, which is what it does.

See `docs/troubleshooting-dashboard.md`.

## 0.98.2 — Rename: BlueEyes Network Resilience System

The product is now the **BlueEyes Network Resilience System**. Every
user-facing surface was updated — dashboard chrome and login, the built-in
documentation, plan labels ("BlueEyes Professional"), the one-time-password
email, ITSM/CMDB/webhook help text, installer and uninstaller output, and the
READMEs across server, agent and licens. Inline prose uses the short form
**BlueEyes**; the full name anchors the page titles, login screens, README
leads and the "What BlueEyes does" article.

Deliberately **not** renamed, because deployed installs and integrations key
off them: the `X-BlueEye-Signature` and `X-BlueEye-Protocol` HTTP headers, the
`BlueEyeAgent` Windows service, the `u_source = BlueEye` ServiceNow filter
tag, `BLUEEYE_*` environment variables, `blueeye_*` database objects, and the
`blueeye-server` / `blueeye-agent` / `blueeye-licens` package and repository
names. Renaming any of those would break agents in the field, saved ServiceNow
views and existing deployment config, so they stay on the old spelling until
there is a migration path.

## 0.96.3 — Fix: traffic map stuck on "Loading…"

The traffic map never rendered — the Overview (and the location page) sat on
**"Loading…"** indefinitely. A view's DOM is built *before* `render()` mounts
it, so the card's `/api/flows/map` fetch routinely resolved while its own
container was still detached; the `if (!root.isConnected) return` guard —
meant to abandon work after the user navigates away — fired on that race and
abandoned the *initial* render instead. Whoever won the race decided whether
the map appeared, so a fast API reliably lost.

Replaced with a `whenConnected(node)` helper that waits for the mount (with a
15 s cap, so navigating away still abandons cleanly) and polls via
`setTimeout` rather than `requestAnimationFrame`, which is paused in a hidden
tab. `drawTrafficMap` now also re-runs `invalidateSize()` + `fitBounds()` once
its container is actually laid out — Leaflet otherwise sizes to 0×0 and puts
the arcs off-screen. The Overview's map is a little shorter now so it doesn't
dominate the page.

## 0.96.0 — Traffic map (colored flow arrows), location drill-down page

**Traffic map.** Flows get a geographic view: colored arrows between your sites
and destination countries, where **color = traffic type** (the existing
admin-editable categories — DNS, Web, VPN, Facebook, …), **moving dashes =
direction** (drawn toward the receiving end; solid = both ways) and **width =
volume**. Backed by a new `GET /api/flows/map` (viewer+) endpoint —
`flowsRepository.mapFlows` groups public `flow_records` by (agent, country,
ASN, direction, service port), the route classifies each group into a category
(ASN match wins over port match) and aggregates to one arc per
(site, country, category) with an in/out byte split. Destinations are placed at
country centroids only; internal RFC1918 traffic is never geolocated. Surfaced
in three places:

- **Flows → Map mode** (third mode next to Unified/Bidirectional): scope to the
  selected agent, one site or the whole fleet; legend chips toggle categories;
  a top-flows side panel pans the map.
- **Overview**: a fleet-wide traffic map below the network path. Clicking an
  arc (a dataflow) opens Flows → Map scoped to that site; clicking a site pin
  opens the location page. The **network path shrank to a compact strip**
  (~25 % less height, capped width) to make room.
- **Location page**: the site's own scoped map + dataflow list.

**Location drill-down page.** Clicking a location anywhere (the agent page's
site name, the Locations list, a site pin on a traffic map) opens a full-width
per-site page: the Overview KPI cards scoped to the site, every agent there
(connection, health verdict, loss/latency/jitter, throughput, version,
last-seen — click through to the agent page), and the site's data flows.

**Layout.** The agent page's Config history / CMDB asset / Dependencies cards
now sit in a responsive grid using the full page width (the global login-card
`width: 320px` had left them stranded in a narrow column).

## 0.94.1 — Analysis overview + filterable/sortable tables

Adds an **Overview** panel to the Analysis (findings) page and makes both the
Analysis and Incidents tables filter/sort from their headers — no new tables,
no new collection.

**Overview panel.** The Analysis page now opens with an aggregate summary over
the current filter: total + unacknowledged counts, a severity breakdown, and
per-metric / per-host tables with count, average σ and peak σ. Backed by a new
`GET /api/findings/summary` (viewer+) endpoint and `FindingStore.summary()`,
which computes the aggregates in SQL (`GROUP BY severity|metric|host_id`) over
the same filter set as the list — one scan per grouping, never pulls raw rows to
total them. Severity chips and metric rows in the panel are clickable and drive
the same filters as the header controls.

**Filterable / sortable headers.** Both the Analysis and Incidents tables now
carry their filter controls **in the table header** — a filter row under the
sortable column labels — so each header both sorts (click the label, click again
to flip) and filters (the control beneath it). Analysis filters by Host /
Severity / Metric (metric options populated from the overview); Incidents by
Severity / Status / Device. `GET /api/findings` accepts `severity` and `metric`
query params (400 on an unknown severity). Both reuse a shared `sortableTable`
helper (client-side sort, numeric-aware, nulls last; optional per-column filter
row), styled like the existing Agents table.

## 0.90.0 — Per-flow-pair volume baselines + scheduled active discovery

Two features (migrations 068 + 069).

**Per-flow-pair volume baselines.** Extends per-metric anomaly detection to
per-`(src_host, dst_host, dst_port)`: baseline each pair's hourly traffic volume
and flag deviations. Reuses the existing median/MAD z-score (`src/analysis/
baselines.js`) — **no new statistical code**. Day-of-week + hour-of-day aware
(Tuesday 14:00 vs prior Tuesdays 14:00). A new append-only `flow_pair_hourly`
rollup (fed by the service-dep `tcpServiceFlows`+resolver path; history builds
forward, ~7-day raw flows can't backfill) feeds `flow_pair_baselines`; a
leader-only hourly job (`src/analysis/flowPairBaselineJob.js`) recomputes over a
14-day window (min 100 observations before scoring) and emits deviations to the
correlator as ordinary findings (`kind ANOMALY`, `metric flow.volume`) via
`findingStore.save`. Deviation only — **no** threat classification, **no** new
alerting channel. API `GET /api/topology/flow-baselines` (operator+, 400/404/500)
+ `POST …/recompute`. Config `FLOW_BASELINE_*`. See `docs/flow-pair-baselines.md`.

**Scheduled active discovery.** Finds devices passive collection misses by probing
an admin-configured CIDR scope. **Native Node only** (TCP connect via `net`,
reverse DNS via `dns.promises`; ICMP is an injectable probe, unsupported by
default since raw sockets need CAP_NET_RAW — no `nmap`/`ping`, ever). Scope is
explicit — never scans outside the configured CIDRs, refuses to start when scope
is unset/invalid or exceeds the address cap (default 65536, checked before any
probe), rate-limited (default 50/s). Results are `discovered_devices` candidates —
**never auto-enrolled**; an admin promotes one to a monitored SNMP device
(`agents` row). Every sweep is written to the hash-chained audit log with scope,
start, end and result count. **Admin-only** router (`/api/discovery/*`; viewer +
operator get 403 on every path). Engine `src/discovery/` (`cidr`, `rateLimiter`,
`probes`, `scanner`, `discoverySweepJob`); config `DISCOVERY_*` (`src/config.js`).
See `docs/discovery.md`. Documentation-center how-tos added for both features.

## 0.89.0 — Topology change detection (LLDP neighbour changes + audit evidence)

Detects and records LLDP/CDP topology changes between poll cycles. Each agent
capabilities report is diffed against the agent's previous neighbour snapshot;
differences become change records — `neighbour_added`, `neighbour_removed`,
`link_state_changed`, `port_moved` — with flap suppression (a revert within
`TOPOLOGY_FLAP_WINDOW_SECONDS`, default 300, collapses to one `flapping` record).

- **Reuses the delta/changes shape** — change records surface as the existing
  target-timeline event `{ timestamp, source:'topology', type, severity, summary,
  ref_id }` (new `topology` source in `src/timeline/targetTimeline.js`, rendered
  "Topology change"). No second changes format.
- **Hash-chained audit evidence** — each change is written to `audit_log` (mig
  033/041) via the fail-safe compliance logger (category `topology`, action
  `topology_<type>`, `actorRole:'system'`, no actor user).
- **Migration 067** — `topology_changes` table + nullable `lldp_neighbors.link_state`
  (so a previous snapshot can carry state to diff). Diff seam at
  `POST /agents/me/capabilities`: detect before upsert, reconcile removed/moved
  edges so they don't re-emit.
- **API** — `GET /api/topology/changes` (operator+, `?host=`): 400/404/500; changes
  also merge into `GET /api/targets/:id/timeline` (viewer+).
- Pure diff `src/topology/topologyDiff.js`; service `topologyChangeService.js`;
  repo `topologyChangesRepository.js`; `lldpNeighborsRepository` gains
  `listByAgent`/`deleteEdge` + `link_state`.
- Tests: each change type on synthetic snapshots, flap window boundaries
  (299/300/301s), no-change on identical, API 400/401/403/404/500, end-to-end
  ingest + timeline. Documentation-center how-to + `docs/topology-changes.md`.
- **Known gap:** the shipping agent doesn't collect LLDP yet, so this is dormant
  in production until an agent reports `capabilities.lldp` (and per-neighbour
  link state for `link_state_changed`). Server, storage and tests are ready.

## 0.88.0 — Blast radius (impact analysis from a failing node)

Given a **failing node** (agent id), computes which downstream hosts/services are
affected, from the unified topology graph. Two tiers, each with a justifying path:
`directly_isolated` (walk `l2_link` out from the node → hosts that lose L2
connectivity) and `dependency_affected` (walk `service_dep` in reverse from the
failing + isolated set → dependents, transitively). Depth-capped
(`BLAST_RADIUS_MAX_DEPTH`, default 4), cycle-safe, `O(V + E)` (a 5,000-node perf
test asserts <2s).

- Pure engine `src/topology/blastRadius.js` + `blastRadiusService.js` (builds the
  graph from the two bounded `listAll`s).
- **Incident enrichment** — `GET /api/incidents/:id` (viewer+) gains **one** added
  field, `blastRadius`, computed on read from the incident's `host_id`. Best-effort
  (topology failure → `blastRadius: null`, incident still served). **No schema
  change** — nothing persisted.
- **Ad-hoc endpoint** — `GET /api/topology/blast-radius/:node` (operator+),
  `?depth=N`; 404 unknown node, 400 invalid, 500 on topology-store failure.
- Tests: linear/star/cyclic topologies, depth cap, empty downstream, dependency
  chains, 5k-node perf; API 400/401/403/404/500 + incident-enrichment best-effort.
- **Documentation center** (Diagnostics how-tos) gains worked-example articles for
  the service dependency graph **and** blast radius. Docs `docs/blast-radius.md`.

## 0.87.0 — Service dependency graph (edge type `service_dep`)

Adds a **service dependency graph**: directed edges between monitored hosts derived
from observed **TCP** flows, aggregated over a rolling 24h window by
`(src_host_id, dst_host_id, dst_port)` with byte/packet/connection counts +
first/last-seen. This is the second edge type of the **unified topology graph** —
`l2_link` (LLDP, migration 063) and now `service_dep` (migration 066) — merged by one
host-keyed model in `src/topology/graph.js` (`buildTopologyGraph`), **not** a parallel
structure.

- **Storage:** new MySQL table `service_dependencies` (migration 066), modeled on
  `lldp_neighbors` — a keyed, upsert + age-out current-state edge table (not
  append-only telemetry). Repo `src/repositories/serviceDependenciesRepository.js`.
- **Aggregation:** a leader-only scheduled job (`src/topology/serviceDependencyJob.js`,
  in `server.js` `backgroundJobs`, default every 10 min) recomputes the rolling window
  **off the ingest hot path**. Pure aggregation + Top-N-per-source-host truncation in
  `src/topology/serviceDependencyAggregator.js` (default N=50, `SERVICE_DEP_TOP_N`).
  IP→host resolution (`src/topology/hostResolver.js`) maps an IP to a monitored host
  via the agent's own reported IPs (`capabilities.ips`) or an SNMP-monitored device's
  `monitor_config.snmp.host`; **edges with either endpoint unresolved are dropped**.
- **API (`/api/topology`, viewer+):** `GET /dependencies` (Top-N edges, `?host=` for one
  host — 404 unknown), `GET /graph` (unified typed graph), `POST /dependencies/recompute`
  (operator+ — the write path).
- **v1 scope:** TCP only; both endpoints must be monitored hosts; no process attribution;
  no service naming/classification.
- **Agent lockstep (blueeye-agent 0.18.0):** the sFlow/NetFlow collector now emits a
  capped per-5-tuple `traffic.flows` list (proto + dst_port, already decoded) and reports
  the host's own IPs via `capabilities.ips` — both additive and backward-compatible
  (older servers keep using `topTalkers`). Config: `SERVICE_DEP_WINDOW_HOURS` (24),
  `SERVICE_DEP_TOP_N` (50), `SERVICE_DEP_JOB_INTERVAL_MINUTES` (10). See
  `docs/service-dependencies.md`.

## 0.84.2 — Fix: `trigger` reserved word broke migration 065 (deploy hotfix)

`cluster_evidence_snapshots.trigger` (Fase 6) is a **MySQL reserved word** and was
used unquoted in the `CREATE TABLE` (migration 065) and in the repository's
`INSERT`/`SELECT` column lists — so `node src/migrate.js` failed with a syntax error
on a fresh deploy, aborting the container's `migrate && seed && server` startup chain
(`blueeye-server` exited 1). Backticked `` `trigger` `` everywhere it names the column.
Added a repository regression test asserting the emitted SQL backticks the column
(the fake pool doesn't parse SQL, so the original bug passed CI). No schema/behaviour
change — re-running the migration now applies cleanly (065 had rolled back, so nothing
was recorded).

## 0.84.0 — Automated read-only evidence snapshot on cluster open

When a cross-agent cluster opens, BlueEyes captures a **READ-ONLY** diagnostic
snapshot from each affected target over the **existing** authenticated, audited
agent-command path — then references one compressed blob per (cluster, target)
from the incident timeline. The capture is bounded and best-effort: it never
blocks clustering, alerting or the incident page.

**Audit note (premise partly off, as in F3–F5):** agent commands were **not
Ed25519-signed** before this (only release manifests were), there was **no
playbook/command executor for read-only diagnostics**, and nothing captured
point-in-time evidence for a cluster. This phase reuses the existing release
signing key + the `sendCommandAndWait` command path rather than inventing new
transport.

### Read-only by contract (defense in depth)
- Server allowlist `src/evidence/commandAllowlist.js` (`evidence-v1`) is the single
  source of truth for WHAT may be collected — `iface.counters`, `arp.table`,
  `snmp.reads`, `agent.state`, every entry `readOnly: true`. A would-be write item
  simply is not on the list.
- The **agent enforces its own copy** of the allowlist (`blueeye-agent`
  `src/evidenceCollector.js`) and hard-refuses any non-allowlisted item **without
  invoking a collector** — so a compromised/buggy server still cannot make an agent
  act.
- The evidence command is **Ed25519-signed** with the existing release key when one
  is configured; the agent verifies it and refuses a bad signature.

### Bounded + best-effort capture
- `src/evidence/snapshotService.js` — per-target hard timeout (default 30s),
  concurrency cap (default 4), an offline agent retried **once** after 60s then
  recorded `agent-offline`. Partial results are valid: each item's outcome
  (`ok`/`timeout`/`refused`/`agent-offline`) is stored. Every path swallows its own
  errors — the trigger is fire-and-forget from the clustering sweep.

### Evidence, not time series
- Migration `065_create_cluster_evidence_snapshots.sql` — one row per (cluster,
  target) with a **gzip blob** (`payload_gzip`), not metric rows; nothing lands in
  TimescaleDB. `src/repositories/evidenceSnapshotsRepository.js` gzips on write /
  gunzips on read so callers deal in plain text.
- Timeline gains an **`evidence`** source (`src/timeline/incidentTimeline.js`):
  "evidence snapshot captured" per target (INFO when complete, WARN for
  partial/offline/failed), linking to the raw-text viewer.

### Retention (existing never-delete rule)
- `src/evidence/evidenceRetention.js` — a 6h background job ages out snapshots older
  than `RETENTION_EVIDENCE_DAYS` (default 90) **except** those on a cluster that
  still has an **unacknowledged CRIT** finding.

### API + RBAC
- `GET /api/incident-clusters/:id/evidence` (viewer+) lists snapshots;
  `GET …/evidence/:sid` (viewer+) returns the decompressed raw text (`text/plain`);
  `POST …/evidence` (operator+) triggers a **manual re-snapshot**, rate-limited
  (once/min, `429` + `Retry-After`) and evidence-class **audit-logged**.

Agent bumped to **0.17.0** in lockstep (`evidence` command recognizer + collector).

## 0.83.0 — Cluster-level alerting, ITSM bridge & NIS2 draft

Rolls a clustered incident's notifications up to the CLUSTER: one alert lifecycle,
one ITSM ticket, one NIS2 draft — instead of N per member finding. Backward
compatible: un-clustered findings and low-confidence clusters keep per-finding
alerting unchanged.

**Audit note (premise partly off, as in F3/F4):** ITSM connectors had **no
worknote/comment method** and **no state-map**; nothing stored an external ticket
id per cluster; the cluster path never called the integrations dispatcher; and the
NIS2 persisted-draft path had **no template fallback** when Mistral is off.

### Alert rollup
- Pure engine `src/analysis/clusterRollup.js` — decides **opened / update /
  escalation / resolved / none** from the cluster's stored alert state. Digest
  window (default 10 min) + **CRIT escalation bypass**. Dispatcher gains
  `dispatchClusterEvent` with **per-channel digest** (`digestMode: 'silent'` skips
  mid-incident updates, still gets opened/escalation/resolved).
- Orchestrator `clusterNotifier.js` wired into the cluster sweep + the resolve API:
  cluster-opened alert, digested updates, immediate escalation, one resolution
  alert (duration + note).
- **Suppression**: a dispatch-time gate (`clusterAlertGate.js`) suppresses a
  finding's individual alert + ITSM emit once its host is in an open medium/high
  cluster; the sweep records every suppression (audit + cluster timeline —
  "rolled into cluster #X"), honouring the **race case** (already-alerted members
  are noted, never recalled). Migration **064** adds the rollup state + refs.

### ITSM bridge
- ServiceNow/custom connectors gain **worknote append** (`work_notes`, journal-only)
  + return the ticket ref; integrations dispatcher gains `emitCluster` /
  `emitClusterNote`. **One ticket per cluster** (idempotent `be-cluster-<id>`),
  worknotes on update/escalation/resolve, ref stored on the cluster. Reuses the
  existing retry/backoff; a connector failure never blocks alerting or the sweep.

### NIS2 cluster draft
- `clusterNis2.js` — **one** cluster-level draft via the existing pipeline,
  **fully functional without Mistral** (template fallback), AI-masked + clearly
  marked when enabled. Invariants preserved (`notification_required=false`, never
  auto-submitted, `[AI draft]`/`[Cluster draft]` title). Per-finding drafts
  suppressed with an audit link; `nis2_draft_id` stored on the cluster.

### API
- `GET /api/incident-clusters/:id/notifications` — the ONE ticket ref, the ONE
  NIS2 draft id, and the cluster-level alert history (viewer+, 400/401/404/500).

### Tests
Rollup (opened/digest/silent/escalation/resolved), notifier (opened + one ticket +
NIS2 + suppression; escalation worknote; digest hold; resolution; ITSM-failure
isolation; race case), NIS2 (invariants, works without Mistral, AI-marked,
idempotent), gate + pipeline suppression (individual alert + ITSM emit skipped),
ServiceNow worknote append, and the notifications API.

## 0.82.0 — LLDP neighbor graph for incident clustering

Adds a minimal, queryable L2 topology so cross-agent clustering can group findings
by neighbor adjacency when no shared-site (manual) topology applies.

**Audit note:** the brief assumed BlueEyes already collects LLDP as part of "L2 loop
detection" — it does **not** (no L2 loop detection, no SNMP/BRIDGE-MIB/LLDP
collection exists; `locator.js`'s "neighbor" means neighbor *agents*). And Fase 1's
topology signal is **shared-site** (`location_id`), not a manual dependency graph.
So this phase persists LLDP data arriving on the **existing agent report path**
(no new SNMP polling) and wires it in as a topology fallback.

### Persistence
- Migration **063** `lldp_neighbors` (`local_agent_id`, `local_chassis_id`,
  `local_port`, `remote_chassis_id`, `remote_port`, `last_seen`) + repository:
  upsert (bumps `last_seen`), batch upsert, age-out (default 24h, configurable),
  list/count. Ingested from a `capabilities.lldp` list in the agent's existing
  `POST /agents/me/capabilities` report — no new polling.

### Graph service
- Pure agent-projected graph (`src/topology/lldpGraph.js`): `adjacent` / `within-N
  hops` / `unknown`, via direct links (remote chassis = another agent's chassis)
  and shared segments (two agents on one switch). Partial coverage → partial graph;
  a pair with no path is **unknown, never "unrelated"**.
- TTL-cached service (`lldpGraphService.js`): rebuilds ≤ once/min (ageing out stale
  rows first), exposes a **sync** `relation()` for the clustering hot path.

### Fase 1 integration
- The correlator gains an LLDP topology pass **between** the site pass and the
  type pass, so **manual/site ALWAYS wins** (it consumes its findings first),
  LLDP fills the remainder, and anything else stays unknown. A cluster now records
  `topologySource` (`site`/`lldp`) and the evidence/`suspected_common_cause` names
  it ("LLDP: sw-03 adjacent to sw-04"). Wired via a background refresh/age-out job.

### API
- `GET /api/topology/neighbors` — viewer+, filter by `target` (both directions),
  pagination; 400/401/404/clean-500.

### Tests
- Graph queries (adjacent / 2-hop / unknown / partial coverage); upsert + age-out +
  TTL refresh; resolution order (site wins over LLDP); clustering integration
  (two LLDP-adjacent agents at different sites with different finding-types →
  clustered via LLDP, evidence names the source); ingest via the capabilities path;
  API 400/401/404/500.

## 0.81.0 — Recommended actions + post-remediation verification loop

Completes "not who's to blame, but what to do": a static finding-type → runbook
bridge on the incident (Situation) page, explicit operator-run playbooks, and a
verification cycle that re-checks whether the symptoms actually cleared. Queries +
UI; no new AI/ML (the Mistral advisory stays opt-in garnish).

**Audit note:** the phase brief assumed an existing playbook execution path with
retry/backoff, a `remediating` state, and playbook-success logging — none of which
existed (migration 055 explicitly deferred execution; `recordRun` was never
called; the state machine excludes playbook transitions). This phase builds the
minimal execution + verification path faithful to that schema's intent.

### Runbooks (static mapping first)
- Migration **061** `runbooks` (finding_type → title + markdown body + optional
  `linked_playbook_id`). Admin CRUD API `/api/runbooks` (+ `/playbooks` for the
  link editor); reads viewer+, writes admin. UI: **Settings → Runbooks**.

### Recommended actions on the incident page
- `GET /api/incident-clusters/:id/recommended-actions` — runbooks matching the
  cluster's dominant finding-types (rendered markdown), plus the cluster AI
  advisory **only when the assistant is enabled** (clearly AI-labelled).
- `POST /api/incident-clusters/:id/run-playbook` — operator+, confirm dialog,
  hash-chained audit, uses the run-recording execution model and **schedules a
  verification**. No auto-execution from clustering; existing auto-trigger rules
  untouched. 409 on a resolved cluster.
- Frontend: a "Recommended actions" panel (with a safe, dependency-free markdown
  renderer) + AI advisory directly below, on the Situation page.

### Verification loop
- Migration **062** `verification_runs`. After a playbook runs, a leader-only
  sweep (`verificationJob`) waits the configurable settle time (**Settings →
  Analysis → verify settle**, default 5 min) then re-checks the affected targets
  for fresh, unacknowledged findings of the relevant types:
  cleared → **passed** (suggest resolution, never auto-resolve); persists →
  **failed** with the current readings (cluster stays open). Every outcome is
  hash-chained-audited and surfaced on the cluster timeline as a new
  **`verification`** source.

### Tests
- Runbook CRUD (happy/400/401/403/404/clean-500); recommended-actions (match /
  no-match / advisory gated by Mistral) + run-playbook (202/400/403/404/409);
  verification (cleared, persisting-with-readings, settle-time respected,
  acked-ignored, error, no-reprocess, timeline emission, never auto-resolves);
  frontend jsdom (panel render, viewer vs operator, empty state, fetch-failure
  isolation, advisory placement, markdown-injection safety).

## 0.80.0 — Incident Situation View (timeline + what-changed + evidence)

One page per cross-agent situation (cluster) that answers, under pressure, what is
happening, where, since when, what changed right before, and what the evidence
says — "ét fælles billede". Queries + UI only; no new AI/ML. Builds on the Fase-1
cluster API and reuses the existing timeline, badge and advisory patterns.

### Backend
- **`GET /api/incident-clusters/:id/timeline`** — one chronologically merged event
  stream for the cluster's affected agents, from `first_seen − lookback` (default
  30 min, `?lookback=<minutes>`) to now, merging: member findings, cluster
  lifecycle transitions, playbook runs, agent connect/disconnect/enrol, and
  config-change captures. Each event carries `{ timestamp, source, target,
  severity, summary, ref_id }`. A separate **`whatChanged`** slice flags the
  sources-c–e events in the pre-incident window. viewer+; 400 on bad lookback,
  404 unknown cluster, clean 500; partial-failure tolerant (`partial` +
  `failedSources`, never a blank timeline).
- Pure merge `src/timeline/incidentTimeline.js` (reuses the per-target mappers,
  adds `target` + config/state-change sources) + fan-out
  `src/timeline/incidentTimelineService.js`. New windowed
  `configSnapshotsRepository.listForDeviceBetween`.

### Frontend
- **Situations** list (`views.clusters`) + per-situation page (`views.cluster`),
  cloning the incident list/detail patterns. Panels: header
  (status/confidence/root-cause/agents + RBAC-aware ack/resolve), a prominent
  **"What changed"** panel (explicit "no recorded changes" when empty — absence is
  diagnostic), an **Evidence** panel (Fase-1 confidence breakdown in plain
  language), the **merged timeline** (filterable by source, severity-coloured,
  rows deep-link to the affected device), and an optional AI advisory block
  (rendered read-only from the cluster; an independent failure domain — never
  breaks the page). Reuses `TimelineView`; page assembly + panels live in the pure,
  jsdom-tested `public/clusterView.js` (`window.ClusterView`). New nav entry +
  `PAGE_INFO.clusters` + a `type:'incident_cluster'` branch on the dashboard WS.

### Tests
- Backend: timeline merge ordering, lookback boundary, what-changed separation,
  400/401/404/partial/clean-500.
- Frontend (jsdom): full-data render, empty timeline, advisory disabled, advisory
  failing (page still renders), timeline failing, RBAC actions, source filter.
- Installed the declared `jsdom` devDependency so the DOM render tests (and the
  pre-existing `timelineView` suite) run.

## 0.79.1 — Cross-agent incident clusters: operator API + lifecycle

Builds the operator-facing surface on top of the existing cross-agent clustering
engine (detector + dedup/auto-resolve + AI advisory + alerting already shipped in
0.7x). No parallel correlation system — this reuses the engine as-is.

### Added
- **REST API** `/api/incident-clusters` (`src/routes/incidentClusters.js`):
  - `GET /` — list with `status` + `from`/`to` filters and `limit`/`offset`
    pagination (viewer+).
  - `GET /:id` — full cluster: hydrated member findings + evidence, affected
    agents/targets, a weighted **confidence breakdown** (signals + score vs the
    single-signal baseline), a suspected **root-cause layer**
    (network-/application-layer/undetermined, reusing the L2
    `isAppMetric`/`isNetMetric` classifiers) and a plain-language evidence
    summary (viewer+).
  - `POST /:id/ack` — acknowledge (operator+, hash-chained audit).
  - `POST /:id/resolve` — resolve with a **required free-text note** (operator+,
    audited).
- Pure read-model assembly `src/analysis/clusterView.js` and a
  `confidenceBreakdown` helper on `crossAgentCorrelator`.
- Migration **060** — `incident_clusters` gains the `acknowledged` status plus
  `acknowledged_at`/`acknowledged_by`, `resolved_by`, `resolution_note`.

### Changed
- Auto-resolve now **never closes a cluster that still holds an unacknowledged
  CRIT member finding** (existing retention rule), and the default quiet period is
  **30 min** (was 15). `open` and `acknowledged` both count as live for
  dedup/auto-resolve.
- `incidentClustersRepository` gains `acknowledge`/`resolve`/`count` and
  time-range + pagination on `list`.

### Tests
- API tests (happy path, 400/401/403/404/409, clean 500), pure unit tests for the
  confidence breakdown + root-cause classification + detail assembly, and a
  simulation test (10 agents, one shared finding-type within 3 min → exactly one
  cluster with all 10 members, confidence above the single-signal baseline).
