# Path visualization

Turns traceroute probe data into a directed, weighted graph of every hop between
an agent and a destination, with loss / latency / jitter overlaid on the nodes
and links — an interactive topology map that shows *where* a problem sits on the
path, not just that the endpoint is slow. (ThousandEyes-style, but local,
offline and EU-sourced — see the geo notes below.)

## Data flow

```
agent traceroute (MTR-style)  →  POST /agents/probe-results  →  probe_results.hops (JSON)
                                                                      │
dashboard Probes tab  ←  GET /api/probes/path  ←  buildPathGraph()  ←─┘
```

1. **Agent** (`blueeye-agent/src/probes/traceroute.js`) runs the system
   `traceroute`/`tracert` with several probes per hop (`-q queries`, default 3;
   Windows `tracert` always sends 3). Each hop is aggregated into
   `{ hop, ip, sent, recv, lossPct, rttMs, minMs, maxMs, jitterMs }` — so every
   hop carries loss and jitter, not just one RTT. Backward-compatible: `rttMs` is
   still the per-hop average, so older servers keep working.

2. **Ingest** (`src/validation/probeValidation.js`, `probeResultsRepository.js`)
   stores the hop array in the existing `probe_results.hops` JSON column — **no
   migration needed**. Legacy single-sample hops (`{ hop, ip, rttMs }`) are still
   accepted; the extra fields normalise to `null`.

3. **Aggregation** (`src/analysis/pathGraph.js`, `buildPathGraph`): groups the
   recent traceroutes to one target by TTL position and reduces each hop with the
   **median** (robust — one odd run can't move it). It enriches public hop IPs
   with GeoIP/ASN (`src/geo/`), and classifies every hop against fixed,
   explainable thresholds (loss / jitter / latency), attaching a plain-language
   `explain`. The result is `{ nodes, links }`:
   - `nodes` — `source` (the agent) → `hop`… → `dest`, each with
     `rttMs/lossPct/jitterMs/worstLossPct`, `responded`/`runs`, `severity`, geo.
   - `links` — one per consecutive pair, weighted with the downstream loss and
     the incremental latency (`rttMs` delta, clamped at 0).

4. **API**: `GET /api/probes/path?agentId=&target=&samples=&from=&to=`
   (viewer+). `target` defaults to the most recent traceroute target; `samples`
   (default 10, max 50) caps how many recent runs are aggregated.

5. **Dashboard** (`public/app.js`, `pathGraph()`): renders an interactive SVG —
   nodes coloured by severity, links labelled with loss/latency. Hover or focus a
   hop to fill the detail panel (full metrics + ASN/country). A hop table sits
   below. Reached from **Probes → run a traceroute → "Path"**.

### Geographic map

The same path can be plotted on the **Destinations** map (Leaflet, EU/self-hosted
tiles via `GET /api/map/config`). Each node's `lat/lng` comes from its country
centroid; the **source** node is anchored at the agent's site
(`locations.latitude/longitude`, surfaced on `agentsRepo.findById` as
`location_lat/location_lng` and passed to `buildPathGraph` as `origin`).

`pathGraph()` adds a lazily-built "Geographic map" panel (`drawPathMap()`):
`pathGeoStops()` collapses consecutive hops sharing a centroid into one stop, then
it draws a polyline (each segment coloured by the downstream stop's severity)
through circle markers, with a per-stop popup (hops · ASN · latency · loss). Since
geo precision is country-level by design, same-country hops stack on one stop — the
per-hop precision stays in the topology graph; the map answers "which countries did
the traffic cross, and where did it degrade?". When there aren't at least two
geolocated stops (no GeoIP DB, or all-private hops) the panel explains why.

The same overlay is also reachable **from the Destinations tab** via a path picker
(pick agent + traceroute target → "Show path"): `drawGeoPath()` draws the path into
a dedicated Leaflet layer on the existing map (shared `renderPathStops()`), with a
side-panel summary listing the geolocated stops and the worst hop; "Clear path"
removes the layer and restores the destinations overview. Target options come from
the agent's recent traceroutes (`/api/probes/latest`).

## Shared Path Visualization component (path graph + metric timeline)

The path graph is also packaged as a **single reusable component**
(`pathVisualization(opts)` in `public/app.js`) mounted across four views, so the
same path graph + a brushable metric timeline appear everywhere without four
copies:

- **Probes** — full width under the probe detail header (`probeDetail`, the
  canonical home).
- **Topology** — a drawer over the diagram: select a peer → **Path** action
  (`actionBtns` in `views.topology`), sourced from the chosen agent.
- **Tests** — a *Network path* section per transaction test (`txDetailView`),
  sourced from the test's first assigned agent to its target.
- **Troubleshooting** — an *Affected path* card in `views.incident`,
  pre-filtered to the incident window with the problem hop pre-highlighted.

Props: `{ sourceId, targetId, probeId?, testId?, incidentId?, timeRange, metric,
overlay, onSelectionChange }`.

### Metric timeline

Below the graph sits a two-pane timeline (`pathVizTimeline`):

- **Overview strip** (~60 px, low opacity) over the full window with a
  drag-to-select **brush** (reusing the shared `attachBrush`). The brushed window
  is the **single source of truth** — it drives the detail chart *and* re-fetches
  the path graph so its per-hop stats recompute for the same window.
- **Detail chart** renders only the brushed window: **loss as bars**,
  **latency/jitter as lines**, **throughput as an area** (`pvChart`, `render`
  chosen per metric).
- **Metric selector** (Loss / Latency / Jitter / Throughput — an extensible list
  from `GET /api/probes/path/metrics`) + a per-agent **overlay** toggle
  (one colour-coded series per probing agent, with a legend).
- **Explain selection** — opt-in: sends the brushed window's aggregates to the
  EU-sovereign advisory endpoint (`POST /api/assistant/explain`); the button is
  hidden unless the `assistant` feature is entitled and answers 403 while the
  admin has it disabled (the standard graceful-degrade).
- The brush window + metric + overlay round-trip through the URL query string
  (`?from&to&metric&overlay`) so a view is shareable.

Bucketing is **DST-safe**: buckets align on the absolute UTC epoch
(`src/analysis/pathTimeseries.js`), so a bucket is always the same real duration
across a spring-forward / fall-back; the tenant timezone only affects tick
labels. Telemetry is read from MySQL `probe_results` (TimescaleDB is optional and
not required) via `probeResultsRepository.metricRows`.

### ECMP / multipath

When a hop load-balances across several next-hops, the linear median graph would
hide it (it collapses to the mode IP). `buildPathGraph` therefore also emits an
additive **`branches`** structure (`{ multipath, hops[], edges[] }`) inferred from
the **multiple stored runs** — no agent change: each TTL keeps *every* distinct
responding IP as its own branch node, and the observed hop→hop transitions become
the branch edges. When `branches.multipath` is set, the hop pane draws the
branches as parallel bezier curves that fan out and rejoin, and the head shows an
**ECMP** badge. (True single-run multipath — Paris-traceroute — would need an
agent release and is out of scope here.)

### API

- `GET /api/probes/path/metrics` — the metric catalogue for the selector.
- `GET /api/probes/path/timeseries?agentId=&target=&metric=&overlay=&bucket=&from=&to=`
  — bucketed series (one per agent when `overlay=agents`); empty window ⇒ empty
  `series` array. viewer+.

## AS-path view & change detection

Because every public hop is already enriched with its ASN, each traceroute carries
the **observed AS-path** — the ordered list of autonomous systems the packets
crossed (e.g. `AS3320 → AS1299 → AS15169`). Two things are built on top of it, with
**no new agent capability and no new data collection** — it is pure server-side
derivation over the hops already stored:

1. **AS view** (`src/analysis/asPath.js`, `asGraphFromNodes`). `GET /api/probes/path`
   returns an `asGraph` alongside the hop graph: the same path collapsed to AS hops
   (consecutive hops in one AS merge; private/un-mapped hops drop out). The Probes
   traceroute detail gets a **Hop view / AS view** toggle (`pathGraph()` in
   `public/app.js`) — same colours/severity, an AS-level altitude.

2. **AS-path change findings** (`extractAsPath` + `diffAsPath`, wired into
   `src/analysis/probeFindings.js` → `probePipeline.js`). On probe-results ingest the
   observed AS-path of the two most recent runs to a target is compared; a changed
   ordered sequence raises a finding through the **same store + alerting + ITSM**
   pipeline as the loss/latency findings:
   - a different **destination/origin AS** → `WARN` ("Path to X now exits via AS999
     (was AS200)");
   - any other reroute (a new transit AS, a dropped AS, a length change) → `INFO`.

   The per-(metric, target) cooldown means a path that changed and stays changed is
   reported once, not on every probe. Needs the GeoIP/ASN DB to resolve hop ASNs;
   without it the check is simply skipped (everything else is unaffected). Schedule a
   recurring `traceroute` (a **test package**, `docs/tests.md`) to monitor a path
   continuously.

> **Honesty — forwarding vs. control plane.** This is the **data-plane** AS-path
> *observed* via traceroute + GeoIP/ASN, **not** the BGP control-plane `AS_PATH`
> attribute. They usually agree but can diverge (MPLS tunnels hide hops, IXP hops,
> asymmetric return paths, anycast). True BGP/BMP monitoring — live route
> announcements, RPKI validity, hijack detection — needs a control-plane feed and is
> out of scope here (it would fight the offline/on-prem posture); the closest
> in-architecture extension would be importing an offline RPKI/IRR snapshot the way
> `src/geo/geoipUpdater.js` imports the GeoIP DB.

## Caveats (by design)

- **Silent routers.** Many routers don't emit ICMP "TTL exceeded", so an
  intermediate hop can show 0/N replies. That's normal, not a fault — such hops
  are rendered **muted** ("silent router"), and only the destination's loss is
  treated as real end-to-end loss.
- **Privacy.** RFC1918 / private hop IPs are never geolocated. Metadata only —
  IPs, ASN, timings; never payload.
- **Geo is offline + EU.** Enrichment uses the local GeoIP/ASN provider
  (`src/geo/provider.js`, DB-IP Lite) and country centroids — no US SDK, no
  network call, country precision only (see [geo.md](geo.md)).
