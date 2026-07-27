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
| Cross-agent correlation (the rollup) | `incident_clusters` (mig 057/058/060/064) | `GET /api/incident-clusters` |

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

---

## Design decisions

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
| Tests | `test/troubleshooting{RootCauses,TopologyState,Anomalies,OverviewService,OverviewApi,ViewModel}.test.js` |
