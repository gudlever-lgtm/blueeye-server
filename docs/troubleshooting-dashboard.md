# Troubleshooting Dashboard

One screen for an outage: **what is failing, what it affects, and when it started** —
without switching views.

The dashboard owns **no data and no analysis of its own**. It is a read/aggregation
layer over five capabilities that already existed, each of which keeps its own page,
its own API and its own tests:

| Domain | Source of truth | Existing API |
| --- | --- | --- |
| Topology rediscovery (LLDP) | `lldp_neighbors` (mig 063), `topology_changes` (mig 067) | `GET /api/topology/{neighbors,changes,graph}` |
| Service dependency mapping | `service_dependencies` (mig 066), `host_connections` (mig 070) | `GET /api/topology/dependencies` |
| Blast radius | derived — no table | `GET /api/topology/blast-radius/:node` |
| Flow-pair baselining | `flow_pair_hourly` · `flow_pair_baselines` (mig 068) | `GET /api/topology/flow-baselines` |
| Active discovery | `discovered_devices` (mig 069) | `GET /api/discovery/candidates` |
| Cross-agent correlation (the rollup) | `event_clusters` (mig 057/058/060/064) | `GET /api/event-clusters` |
| Open event cases (single-host faults) | `event_cases` (mig 047/129) + `findings.event_case_id` (mig 048) | `GET /api/events` |

**No new tables, no new migrations.** Everything is computed on read.

**Faults are not only cross-agent situations.** The correlator forms a cluster
only from findings on ≥2 agents, so a site with ONE agent — a small water
utility with two switches behind it — never has one. Its uplink can be down on
both switches, with probe outages and a failed transaction on top, and the
cluster path alone says "0 active faults, every node ok" (found by a real
end-to-end run). The screen therefore also rolls up every **open event case**
(`open`/`investigating`) that is not part of a live situation: one case = one
root cause, the case's findings = its alarms. See *Two sources of faults* below.

---

## The API

### `GET /api/troubleshooting/overview` — viewer+ (filtered by role)

One request returns every block the view needs.

| Query | Default | Notes |
| --- | --- | --- |
| `minutes` | `1440` (24h) | 1..10080 (7 days). Outside that range → `400`. |
| `limit` | domain defaults | 1..1000; caps clusters, anomalies and timeline events. |

```jsonc
{
  "window":  { "from": "…", "to": "…", "minutes": 1440 },
  "summary": {
    "activeFaults": 5,        // raw member findings behind the live root causes
    "affectedDevices": 4,     // full impact footprint, each device counted once
    "rootCauses": 1,          // what those alarms collapse to
    "anomalies": 1,           // flow-pair baseline deviations
    "devicesDown": 1,         // additive breakdown of affectedDevices
    "devicesUnreachable": 2,
    "devicesDegraded": 0      // reachable, with an open fault on them
  },
  "topology": {
    "nodes": [{ "id": 1, "label": "sw-core-1", "state": "down", "locationId": 1, "status": "offline", "lastSeen": "…" }],
    "links": [{ "layer": "l2", "type": "l2_link", "directed": false, "source": 1, "target": 2, "dstPort": null, "state": "down" }],
    "counts": { "ok": 1, "down": 1, "unreachable_downstream": 2 },   // + "degraded"/"unknown" when non-zero
    "layers": { "l2": 2, "l3": 1 },
    "discovered": []          // active-discovery candidates — ADMIN only, else []
  },
  "rootCauses": [{
    "id": 1, "source": "cluster", "clusterId": 1, "caseId": null,
    "severity": "CRIT", "cause": "Uplink sw-core-1 unreachable",
    "affectedDeviceIds": [2, 3, 4], "blastRadiusCount": 1,
    "status": "open", "confidence": "high", "classification": "network-layer",
    "memberCount": 5, "firstSeen": "…", "lastSeen": "…", "primaryDeviceId": 2,
    "blastRadius": { "directlyIsolated": [1], "dependencyAffected": [] }
  }, {
    // one host's open event case (no cross-agent situation)
    "id": "case:5", "source": "case", "clusterId": null, "caseId": 5,
    "severity": "CRIT", "cause": "Port Gi0/1 on sw-core went down (SNMP poll).",
    "title": "CRIT if.11.link.down on vv-agent (Vandværket)",
    "affectedDeviceIds": [7, "d:1", "d:2"], "memberCount": 22, "status": "open",
    "confidence": null, "classification": null, "primaryDeviceId": "d:1",
    "primaryFindingId": "…", "primaryMetric": "if.11.link.down", "…": "…"
  }],
  "anomalies": [{
    "linkId": "2->4:5432", "currentVsBaselinePct": 320, "since": "…",
    "findingId": "…", "srcHostId": 2, "dstHostId": 4, "dstPort": 5432,
    "observed": 4200, "baseline": 1000, "deviation": 8.4, "severity": "WARN", "explanation": "…"
  }],
  "timeline": [{ "timestamp": "…", "source": "topology", "type": "topology.link_state_changed",
                 "severity": "WARN", "summary": "Gi0/1 went down", "ref_id": 21, "agentId": 2 }],
  "partial": false,
  "failedSources": []
}
```

Status codes: `200` · `400` invalid query · `401` unauthenticated · `403` viewer ·
`404` unknown path · `500` unexpected fault · `503` service not wired.

`/overview` deliberately does **not** carry the raw alarm rows — only the
`activeFaults` figure. See *The fault list is opt-in* below.

### `GET /api/troubleshooting/faults` — viewer+

The rows behind `summary.activeFaults`: the member findings of every live root
cause, with the evidence the rollup drops (explanation, observed/baseline,
deviation). Paged, and fetched **only when the operator asks to list them**.

| Query | Default | Notes |
| --- | --- | --- |
| `limit` | `100` | 1..500. Outside that range → `400`. |
| `offset` | `0` | `>= 0`. Rows already held, so paging never re-reads or skips. |
| `clusterId` | — | Positive integer; narrows the list to one situation (no case rows). |
| `caseId` | — | Positive integer; narrows the list to one open event case (no cluster rows). With `clusterId` → `400`. |
| `source` | — | `cluster` or `case`: one half of the list. Contradicting `clusterId`/`caseId` → `400`. |

```jsonc
{
  "total": 28574,          // distinct member ids across the live clusters
  "offset": 0,
  "limit": 100,
  "returned": 100,
  "hasMore": true,
  "faults": [{
    "findingId": "…", "source": "cluster", "clusterId": 12, "caseId": null,
    "cause": "Uplink sw-core-1 unreachable",
    "missing": false,      // true when retention purged the finding (see below)
    "hostId": "2", "deviceId": null, "interfaceId": null,
    "metric": "link.errors", "severity": "CRIT", "kind": "anomaly",
    "observed": 9, "baseline": 1, "deviation": 8, "acked": false,
    "explanation": "…", "createdAt": "…"
  }]
}
```

Same RBAC and the same source as the overview, so this widens nothing: it is the
detail of a number the overview already shows.

**Order** is stable, which is what makes `offset` stable across pages: the live
clusters by newest activity with members in the order the correlator grouped
them, then the open cases by newest activity with their findings oldest first
(the order the event page shows them). **`total`** counts *distinct* finding
ids across both: clusters do not share findings in practice, and a finding a
live cluster lists is never repeated under its case, so it matches
`summary.activeFaults`.

A case row's `cause` is the case's own, named exactly as the overview names it
(see below). A `caseId` of a case that is part of a live situation returns no
rows: its situation counts them.

A member whose finding retention has already purged comes back as a row with
`missing: true` and nothing invented. Dropping it would leave every page short and
the dashboard's "x of y" counter permanently short of its total.

Status codes: `200` · `400` invalid query · `401` unauthenticated · `403` viewer ·
`500` unexpected fault · `503` service not wired.

---

## Design decisions

### The fault list is opt-in

`activeFaults` is cheap: for the clusters it is the sum of each live cluster's
`member_finding_ids` length, read straight off the cluster rows; for the open
cases it is the rows of the one narrow `listByEventCases` read. The **rows** behind it are not — a busy
fleet carries tens of thousands of raw alarms — so painting the screen must never
pay for them.

Two things follow, and both are load-bearing:

1. **The overview hydrates members through ONE bulk read, in the narrow
   projection.** It used to call `findingStore.get(id)` once per member: 100 live
   clusters holding 28 000 members meant 28 000 round trips queued behind a
   ~10-connection pool, which is what made this tab take half a minute to paint.
   `FindingStore.listByIds(ids, { light: true })` reads them in 1000-id `IN (...)`
   batches and selects `id/host_id/metric/severity/kind/acked/created_at` — no
   `evidence` or `correlated_with` JSON. That is exactly what the severity, affected
   device and classification rollups need, and it is the difference between a few
   hundred KB and tens of MB on the wire.
2. **The rows move to their own endpoint.** `GET /api/troubleshooting/faults` returns
   the full findings, one page at a time. The dashboard calls it only when the
   operator clicks the link on the Active faults card, and shows a counter
   ("Showing 200 of 28 574") as pages arrive, so a long read reads as progress rather
   than a spinner.

A hydration ceiling (`MAX_HYDRATED_MEMBERS`, 20 000) guards the rollup against a
runaway cluster. It is well above any realistic fleet, and `activeFaults` stays exact
either way — the figure comes from the cluster row, not from the hydrated members.

### Two sources of faults

| Source | What one root cause is | Its alarms (`memberCount`) | Opens |
| --- | --- | --- | --- |
| `cluster` | one live cross-agent situation (`event_clusters`, open/acknowledged) | the cluster's `member_finding_ids` | the Situation page |
| `case` | one open event case (`event_cases`, open/investigating) **not** part of a live situation | the case's findings (`findings.event_case_id`), minus any a live cluster lists | the Event page |

**Nothing counts twice.** `eventCasesRepo.listOpenOutsideSituations()` leaves
out a case whose `cluster_id` points at a live situation (it is back in once
that situation is resolved, or deleted). And because the cluster sweep stamps
`cluster_id` a minute after the fact, every finding id a live cluster lists is
also stripped from the cases before they are counted — a case left with no
finding adds no cause at all.

**The case's root finding** is its own `primary_finding_id` (the finding that
opened it) while that is still among the members counted here, else its
earliest remaining finding. The `cause` text is that finding's first sentence
("Port Gi0/1 on sw-core went down (SNMP poll).") — the detector's own words —
falling back to the case title. A case is one host's findings grouped by time,
not a correlation judgement, so `confidence` and `classification` are `null`
rather than invented. `affectedDeviceIds` is the case's host agent plus every
switch its findings name (`d:<id>`; a port finding carries the polling agent in
`host_id` and the switch in `device_id`, migration 110), and `primaryDeviceId`
("Show path") is the switch the root finding names, else the host.

**Bounded like the cluster path.** At most `limit` cases (default 100, newest
activity first); their findings in ONE `findingStore.listByEventCases(ids,
{ light: true })` read (`event_case_id IN (...)`, the narrow projection), capped
at `MAX_HYDRATED_MEMBERS`; plus one `listByIds` of at most one root finding per
case for the cause text. Unlike a cluster, a case stores no member list, so its
`memberCount` IS the rows read: a set of open cases holding more than 20 000
findings (a runaway, not a site) counts the first 20 000 and logs it. A failed
case read costs the case causes (`failedSources: ['cases']`), not the screen.

**What is deliberately NOT a fault here: unacknowledged findings outside any
open case.** Every finding path (`pipeline`, `probePipeline`, the finding sink
for switch/transaction/probe-outage findings, the offline monitor, new-device
detection) assigns an event case, so an open finding normally has an open case.
Two gaps remain and are left to the **Analysis** page (open findings), on
purpose:

- *Case assignment is best-effort.* A failed assignment leaves the finding with
  no case. It is logged by the caller; it is not a second source here, because
  a per-finding fallback would re-open the fleet-wide finding scan this screen
  was made fast by removing.
- *A resolved or closed case.* Its findings may still be unacknowledged (an
  operator resolved the event without acking them, or `autoResolveJob` resolved
  an `investigating` case after 15 quiet minutes while a single link-down
  finding stayed unacked). Resolving the event is the statement that the work
  is done; the screen follows it rather than second-guessing it.

### The rollup is not re-derived

**One cluster (or one open case) = one root cause, never one per affected device.** The cross-agent
correlator (`src/analysis/crossAgentCorrelator.js`) already groups findings from ≥2
agents into a cluster, and `clusterView.buildClusterDetail()` already renders that
group. The dashboard *preserves* that collapse; it does not re-implement it.

The key figures make the collapse legible on purpose: `activeFaults` is the raw
member-finding count and `rootCauses` is what they collapse to, so the cards read
"47 alarms → 3 causes" rather than leaving the operator to divide two numbers.

### Blast radius counts impact *beyond* the named devices

Re-counting the devices a cause already names would inflate every root cause. The
count is the union of every affected device's blast radius **minus** the affected
set. A host that is L2-isolated is not counted a second time as a service dependent.

Tier 1 (`directly_isolated`) and tier 2 (`dependency_affected`) are reported
separately so the panel can say "→ 2 devices unreachable · 1 dependent service
affected" instead of one undifferentiated number.

### Node state is derived, and deliberately conservative

Nothing in the schema records `unreachable_downstream`. It is computed:

| Input | State |
| --- | --- |
| `agents.status = 'online'` | `ok` |
| `agents.status = 'offline'` | `down` |
| switch that has never answered a poll | `unknown` |
| L2-isolated behind a `down` node, and neither `ok` nor `down` itself | `unreachable_downstream` |
| `ok` (or `unknown`) with an **open fault** on it | `degraded` |
| unknown status / no agent row | `ok` |

**Open fault** means an unacknowledged CRIT or WARN finding among the members
the two rollups already hold — a live cluster's members or an open case's
findings — never a separate read of the findings table. A finding that names a
switch (`device_id`: a port down, flapping, a duplex mismatch, an L2 loop)
marks the **switch**, not the agent that polled it; one about the agent itself
(a probe outage, a failed transaction, a TLS finding) marks the agent. A switch
whose uplink is down answers its poll perfectly well, so without this it was
drawn green. `degraded` is applied after the downstream pass and only moves
`ok`/`unknown`: it never changes who is reachable (a degraded node is one we
can hear), and it never overrules `down` or `unreachable_downstream`, which
already say more. Acknowledging the finding, or resolving its case, turns the
node back to `ok`.

Two choices worth stating plainly:

- **Unknown status maps to `ok`.** We will not invent a fault we have no evidence
  for. A missing agent row means the graph carries an edge to a host we no longer
  monitor, not that the host failed.
- **A node we can hear is never greyed.** An agent that is online and reporting
  (or a switch that answered its poll) is reachable by definition, whatever the
  graph walk says. The L2 graph is undirected, so from an offline leaf agent the
  walk reaches its access switch and every host behind it; that used to grey out
  healthy neighbours and blame them for one host's outage (fault-scenario audit,
  scenario 12). The blast radius the overview computes is given `isAlive`, so it
  stops at live nodes (`known_reachable`), and the view never overrules an `ok`.
- **Only tier 1 greys a node.** A service dependent is *degraded*, not *unreachable*.
  `unreachable_downstream` means "we cannot hear it", which is not the same claim as
  "it is broken" — the label says so, and the colour never travels without it.

Link state is the worse of its two endpoints (`ok` < `degraded` <
`unreachable_downstream` < `down`).

### One graph read, not one per device

`blastRadiusService.compute(node)` rebuilds the whole topology graph on every call,
so computing a radius per affected device would mean N full graph loads. The service
takes the graph **once** via `blastRadiusService.graph()` and runs the pure
`computeBlastRadius` against it per node — same engine, same result, one read.
`test/troubleshootingOverviewService.test.js` asserts the graph is read exactly once.

### Anomalies come from findings, not from the baseline API

`GET /api/topology/flow-baselines` requires a `host`, so a fleet-wide view would need
one request per agent. Instead the dashboard reads the findings
`flowPairBaselineJob` already writes (`metric = 'flow.volume'`, with the pair in
`evidence[0].labels`). Cheaper, consistent — and an anomaly acknowledged on the
Analysis page disappears here too.

`currentVsBaselinePct` is `((observed - baseline) / baseline) * 100`: `+320` means
4.2× the usual volume, `-80` means the pair went nearly silent. It is `null` when the
baseline is zero or absent, because no meaningful ratio exists.

### RBAC: aggregating must never widen access

The underlying domains sit at three different levels — `neighbors`/`graph`/
`dependencies`, the situations and their findings at viewer+, `changes`/
`blast-radius`/`flow-baselines` at operator+, and discovery at admin. The screen is
the first place a viewer (first line, the person on the phone) should look when
something is down, so the endpoint is **viewer+** and each domain is included only
for the roles that may read it on its own:

| Role | Root causes · topology · agent events | Baseline deviations · topology changes · blast radius | Discovery |
| --- | --- | --- | --- |
| viewer | yes (incl. open event cases — `/api/events` is viewer+) | **empty**, listed in `restricted` | empty |
| operator | yes | yes | empty |
| admin | yes | yes | yes |

Left-out domains are empty lists, never a `403` that would deny the whole screen,
and `restricted: ['anomalies', 'topologyChanges', 'blastRadius']` tells the client
why they are empty; the page says so above the panels and does not offer *Show
path* (it walks the blast radius). Without blast radius a viewer's topology marks
nodes `down`, never `unreachable_downstream`. `GET /faults` is viewer+ for the same
reason: its rows are findings, which `/api/findings` serves to viewers too.

### Read-only

Nothing on this screen pushes an agent command, so there is no signed command and no
audit write. Adding an action later means an Ed25519-signed command over
`agentCommander` plus a hash-chained `audit_log` entry, exactly as the evidence
snapshot path does.

### Fail-closed, panel by panel

Sources are fanned out with `Promise.allSettled` (the same policy as
`targetTimelineService.js`). A domain that is down costs the operator **that panel**,
lands in `failedSources`, and sets `partial: true` — it never blanks the screen. The
UI surfaces this as "Partial data — unavailable: …" rather than silently showing
zeros.

---

## The view

`views.troubleshooting` in `public/app.js`, four zones, all fed by the single read:

1. **Key figures** — four cards; the hints spell out the rollup.
2. **Topology** — state-coloured SVG; toggle L2 / L3 / both; click a node for
   detail and a deep-link to its agent page.
3. **Root causes** — severity-coloured list, situations and open event cases
   together. A cause from an event case says so ("Event #5 · one host", a link
   to the event) and its ⋯ menu offers **Open event** instead of *Open
   situation*; a fault row from a case links to its event too. **Show path** fetches
   `GET /api/topology/blast-radius/:node` and highlights that path on the graph
   (rather than inflating the overview payload with every justifying path).
   **What changed?** lists change events in the 30 minutes before the fault started.
   Baseline deviations sit below.
4. **Timeline** — event markers with drag-to-brush; the brush narrows the event list.

Pure logic lives in `public/troubleshootingView.js` (`window.TroubleshootingView`),
dual-exported so it is unit-tested under `node --test` — the dashboard has no build
step and no browser test harness, so anything testable is kept out of the DOM layer.

**Naming:** this screen takes the **Troubleshooting** tab. The older location-driven
anomaly view (`views.investigation`) is unchanged and is now labelled **Investigate**,
which is what it does.

---

## Files

| Concern | File |
| --- | --- |
| Pure read-model (rollup, node state, anomalies, summary) | `src/troubleshooting/overview.js` |
| Fan-out + partial-failure policy | `src/troubleshooting/overviewService.js` |
| HTTP | `src/routes/troubleshooting.js` (mounted in `routes/index.js`) |
| Pure view-model | `public/troubleshootingView.js` |
| View | `views.troubleshooting` + `tshootTopologySvg` in `public/app.js`; `.ts-*` in `public/styles.css` |
| Bulk member read | `FindingStore.listByIds()` / `listByEventCases()` in `src/analysis/findings.js` |
| Open cases outside a live situation | `eventCasesRepo.listOpenOutsideSituations()` in `src/repositories/eventCasesRepository.js` |
| Tests | `test/troubleshooting{RootCauses,TopologyState,Anomalies,OverviewService,OverviewApi,ViewModel,Faults,CaseFaults,Page}.test.js` |

---

## Hand-offs between the fault screens

A fault is chased across several screens — Troubleshooting, an event or a
situation, Probes, Diagnose, Investigate, Device log. They share one **fault
context**: an agent, a target and a time window. `openInContext(view, ctx)` in
`public/app.js` opens a screen with it already chosen, and writes it to the
address, so the link opens on the same thing for a colleague:

    /diagnose?agent=12&target=10.0.0.1
    /investigate?agent=12&window=240
    /device-log?agent=12&window=120

| From | Hand-off row offers |
| --- | --- |
| Event page | Probe (agent + the anomaly's target), Diagnose, Investigate, Device log — window from before the first anomaly |
| Situation page | the same, from the first affected agent and the situation's first-seen time |
| Troubleshooting root cause | the same, from the cause's anchor or first affected agent |
| Changes drawer | the same, from the row's agent and time |
| Agent page | the same, for that agent |
| Investigate result | Probe, Diagnose, Device log |
| Search for an IP or host name | Probe this address, Diagnose |

The window a screen gets is the smallest it offers that still covers the fault,
with a quarter added in front so the minutes before it are in view. A screen
opened on its own reads the same parameters (`applyContextFromUrl`), and a
choice made on it is mirrored back into the address. Parameters that belong to
one record's chart (`from`, `to`, `metric`, `overlay`) are dropped on a path
change, so they cannot override the next screen's window.
