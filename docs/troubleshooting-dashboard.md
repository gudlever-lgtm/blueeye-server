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

**No new tables, no new migrations.** Everything is computed on read.

---

## The API

### `GET /api/troubleshooting/overview` — operator+

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
    "devicesUnreachable": 2
  },
  "topology": {
    "nodes": [{ "id": 1, "label": "sw-core-1", "state": "down", "locationId": 1, "status": "offline", "lastSeen": "…" }],
    "links": [{ "layer": "l2", "type": "l2_link", "directed": false, "source": 1, "target": 2, "dstPort": null, "state": "down" }],
    "counts": { "ok": 1, "down": 1, "unreachable_downstream": 2 },
    "layers": { "l2": 2, "l3": 1 },
    "discovered": []          // active-discovery candidates — ADMIN only, else []
  },
  "rootCauses": [{
    "id": 1, "severity": "CRIT", "cause": "Uplink sw-core-1 unreachable",
    "affectedDeviceIds": [2, 3, 4], "blastRadiusCount": 1,
    "status": "open", "confidence": "high", "classification": "network-layer",
    "memberCount": 5, "firstSeen": "…", "lastSeen": "…", "primaryDeviceId": 2,
    "blastRadius": { "directlyIsolated": [1], "dependencyAffected": [] }
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

### `GET /api/troubleshooting/faults` — operator+

The rows behind `summary.activeFaults`: the member findings of every live root
cause, with the evidence the rollup drops (explanation, observed/baseline,
deviation). Paged, and fetched **only when the operator asks to list them**.

| Query | Default | Notes |
| --- | --- | --- |
| `limit` | `100` | 1..500. Outside that range → `400`. |
| `offset` | `0` | `>= 0`. Rows already held, so paging never re-reads or skips. |
| `clusterId` | — | Positive integer; narrows the list to one root cause. |

```jsonc
{
  "total": 28574,          // distinct member ids across the live clusters
  "offset": 0,
  "limit": 100,
  "returned": 100,
  "hasMore": true,
  "faults": [{
    "findingId": "…", "clusterId": 12, "cause": "Uplink sw-core-1 unreachable",
    "missing": false,      // true when retention purged the finding (see below)
    "hostId": "2", "metric": "link.errors", "severity": "CRIT", "kind": "anomaly",
    "observed": 9, "baseline": 1, "deviation": 8, "acked": false,
    "explanation": "…", "createdAt": "…"
  }]
}
```

Same RBAC and the same source as the overview, so this widens nothing: it is the
detail of a number the overview already shows.

**Order** is the root-cause order the screen already renders (clusters by newest
activity, members in the order the correlator grouped them), which is what makes
`offset` stable across pages. **`total`** counts *distinct* member ids: clusters do
not share findings in practice, so it matches `summary.activeFaults`; if one ever
did, the list shows the alarm once rather than twice.

A member whose finding retention has already purged comes back as a row with
`missing: true` and nothing invented. Dropping it would leave every page short and
the dashboard's "x of y" counter permanently short of its total.

Status codes: `200` · `400` invalid query · `401` unauthenticated · `403` viewer ·
`500` unexpected fault · `503` service not wired.

---

## Design decisions

### The fault list is opt-in

`activeFaults` is free: it is the sum of each live cluster's `member_finding_ids`
length, read straight off the cluster rows. The **rows** behind it are not — a busy
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

### The rollup is not re-derived

**One cluster = one root cause, never one per affected device.** The cross-agent
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
| L2-isolated behind a `down` node, not itself down | `unreachable_downstream` |
| unknown status / no agent row | `ok` |

Two choices worth stating plainly:

- **Unknown status maps to `ok`.** We will not invent a fault we have no evidence
  for. A missing agent row means the graph carries an edge to a host we no longer
  monitor, not that the host failed.
- **Only tier 1 greys a node.** A service dependent is *degraded*, not *unreachable*.
  `unreachable_downstream` means "we cannot hear it", which is not the same claim as
  "it is broken" — the label says so, and the colour never travels without it.

Link state is the worse of its two endpoints. No new vocabulary.

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
`dependencies` at viewer+, `changes`/`blast-radius`/`flow-baselines` at operator+,
and discovery at admin. The endpoint therefore adopts **operator+**, the strictest
non-admin level its data requires, and includes the admin-only discovery candidates
**only for admins** — as an empty list, not a `403` that would deny the whole screen.

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
3. **Root causes** — severity-coloured list. **Show path** fetches
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
| Bulk member read | `FindingStore.listByIds()` in `src/analysis/findings.js` |
| Tests | `test/troubleshooting{RootCauses,TopologyState,Anomalies,OverviewService,OverviewApi,ViewModel,Faults}.test.js` |
