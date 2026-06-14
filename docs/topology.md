# Flow-derived topology / dependency map

A who-talks-to-whom service/host dependency graph, built from the 5-tuple flows
agents already report (NetFlow/sFlow). It complements the per-target traceroute
**path graph** (`src/analysis/pathGraph.js`) and the **AS-path** view: those are
about the path to one destination, this is the network-wide dependency map.

Privacy by design: internal (RFC1918/non-routable) endpoints stay topology and
are **never geolocated**; external peers carry their ASN/country. Metadata only —
addresses, ports, ASNs, byte/flow counts, never payload.

## Pipeline

- **Edges (`src/repositories/flowsRepository.js` `topologyEdges`)** — aggregates
  raw `flow_records` by the `(src_ip, dst_ip)` conversation over a window (whole
  fleet, or one agent), summing bytes/packets/flows and carrying the external
  endpoint's ASN/country. Includes internal↔internal conversations (the LAN).
- **Graph (`src/analysis/topology.js` `buildTopology`)** — pure builder: classifies
  each endpoint internal/external (`geo/privateIp.js isPrivate`), accumulates node
  in/out bytes + peer degree, and de-dupes directed edges. Caps to the heaviest
  nodes/edges for the UI (`truncated` flags when more exist); `totals` reflect the
  full graph.

## API

`GET /api/topology?minutes=<n>&agentId=<id>` (viewer+):

```jsonc
{
  "from": "...", "to": "...", "agentId": null,
  "nodes": [{ "id": "8.8.8.8", "kind": "external", "asn": 15169, "asnName": "GOOGLE",
              "country": "US", "bytesIn": 0, "bytesOut": 9000, "bytes": 9000, "degree": 1 }],
  "edges": [{ "from": "10.0.0.5", "to": "8.8.8.8", "bytes": 9000, "packets": 90, "flows": 9 }],
  "truncated": false,
  "totals": { "nodes": 3, "edges": 2, "internal": 2, "external": 1 }
}
```

`minutes` defaults to 60 (max 7 days). `agentId` scopes to one agent (400 invalid /
404 unknown). Surfaced in the dashboard **Topology** view (Diagnostics group): a
summary + the top dependencies and busiest hosts. A node/edge force-graph
rendering is a natural UI follow-up on top of this payload.
