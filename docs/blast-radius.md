# Blast radius

Given a **failing node** (a monitored device/host, identified by its agent id),
blast radius computes which downstream hosts and services are affected, from the
unified topology graph (`l2_link` + `service_dep` edges — see
[service-dependencies.md](service-dependencies.md)).

## Two tiers

| Tier                  | How it's found                                                                 |
| --------------------- | ------------------------------------------------------------------------------ |
| `directly_isolated`   | Walk `l2_link` edges out from the failing node → hosts that lose L2 connectivity. |
| `dependency_affected` | From the failing + isolated set, walk `service_dep` edges **in reverse** (a `service_dep` edge is `source → target` = "source depends on target") → hosts that depend on any of them, transitively. |

Each entry carries the **path** that justifies it: an L2 node path for
`directly_isolated`, and a dependency chain (with the `dstPort` used at each hop)
for `dependency_affected`.

Because `l2_link` (LLDP/CDP) adjacency is **undirected/symmetric**, "downstream"
means the failing node's L2-reachable neighbourhood within the depth cap — the
hosts cut off with or behind it.

## Bounds & safety

- **Depth cap** — configurable via `BLAST_RADIUS_MAX_DEPTH` (default 4). Applied
  to each tier's traversal.
- **Cycle-safe** — shared `seen` sets; the walk always terminates.
- **Complexity** — building the two adjacency indices is `O(E)`; each BFS visits
  every node/edge at most once ⇒ **`O(V + E)`** total, `O(V + E)` memory. A
  5,000-node graph computes in well under the 2s budget (a perf test asserts it).

## Where it surfaces

- **Incident enrichment** (`GET /api/incidents/:id`, viewer+): the incident
  object carries one added field, `blastRadius`, computed on read for the
  incident's `host_id` (when it is an agent id). **Best-effort** — a topology/DB
  hiccup yields `blastRadius: null`, never a failed incident view. No schema
  change (nothing is persisted; it is derived from the graph on read).
- **Ad-hoc endpoint** (`GET /api/topology/blast-radius/:node`, **operator+**):
  compute for any node. `?depth=N` overrides the cap. `404` unknown node, `400`
  invalid node/depth, `500` when the topology store is unavailable.

## Worked example

Core switch **agent 1** fails; it is L2-adjacent to **2** and **3**; app server
**4** depends on **3** on port 5432:

```
GET /api/topology/blast-radius/1

{
  "failingNode": 1,
  "depthCap": 4,
  "directly_isolated": [
    { "hostId": 2, "path": [1, 2] },
    { "hostId": 3, "path": [1, 2, 3] }
  ],
  "dependency_affected": [
    { "hostId": 4, "path": [ { "hostId": 3, "viaPort": null }, { "hostId": 4, "viaPort": 5432 } ] }
  ],
  "totals": { "directly_isolated": 2, "dependency_affected": 1 }
}
```

## Code

- Pure engine: `src/topology/blastRadius.js` (`computeBlastRadius`).
- Graph build + service: `src/topology/blastRadiusService.js` (reads the two
  bounded `listAll`s, builds `buildTopologyGraph`, runs the traversal).
- Surfaces: `src/routes/topology.js` (`/blast-radius/:node`) and
  `src/routes/incidents.js` (`GET /:id` enrichment).
