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
