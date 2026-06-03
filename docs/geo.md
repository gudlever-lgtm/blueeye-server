# Geo layer (flow records + GeoIP/ASN enrichment)

Phase 7 of BlueEye. The server enriches the flows agents report with **country**
and **ASN** for the external (public) peer, and stores them so the map layer
(Phase 8) can aggregate traffic by destination. Everything is local and
on-prem: no third-party geo SDK and no network call at runtime — enrichment
reads an **offline** range database.

> Privacy by design: **RFC1918 / private addresses are never geolocated.** Only
> the public endpoint of a flow is looked up; purely-internal flows (both ends
> private) are flagged `internal` and stored without any country/ASN. Internal
> traffic is topology, not geography.

## Data model

`flow_records` (migration `010`): one row per reported flow.

| Column | Meaning |
| --- | --- |
| `agent_id`, `ts` | which agent reported it, and when |
| `src_ip`, `dst_ip` | the two endpoints |
| `ext_ip`, `direction` | the public peer and `in`/`out` relative to the site |
| `proto`, `src_port`, `dst_port` | transport details |
| `bytes`, `packets`, `flows` | volume |
| `internal` | `1` when both ends are private (never geolocated) |
| `country`, `asn`, `asn_name` | GeoIP/ASN of the public peer (NULL when internal/unknown) |

## Pipeline

```
POST /agents/results → resultsRepo.createMany (stored)
                         └─ flowPipeline.processResults (best-effort)
                              ├─ extractFlows()   payload.traffic.flows → raw records
                              ├─ enricher.enrichMany()
                              │     ├─ externalEndpoint()  pick public peer (skip internal)
                              │     ├─ provider.lookup()   IP → { country, asn, asnName }
                              │     └─ centroids.get()     country → { lat, lng }
                              └─ flowsRepo.insertMany()
```

Like the analysis pipeline, this runs **after** results are persisted and is
fully best-effort — a geo failure can never break ingestion.

## Accepted flow shape

The agent should include flow records in its result payload:

```json
{
  "traffic": {
    "flows": [
      { "srcIp": "10.0.0.5", "dstIp": "8.8.8.8", "proto": "tcp",
        "srcPort": 50000, "dstPort": 443, "bytes": 1200, "packets": 8, "flows": 2 }
    ]
  }
}
```

If `traffic.flows` is absent, the extractor falls back to parsing
`traffic.topTalkers[].pair` strings for IP pairs (best-effort).

## GeoIP database (offline, EU-sourced)

`GEOIP_DB_PATH` points at a CSV range file, one range per line:

```
start_ip,end_ip,country[,asn[,asn_name]]
8.8.8.0,8.8.8.255,US,15169,GOOGLE
80.0.0.0,80.255.255.255,DE,3320,DTAG
```

Lines that don't begin with an IP/integer are treated as comments/headers. The
provider sorts the ranges and binary-searches them — IPv4 today (IPv6 ranges are
ignored by the default reader).

**Recommended dataset:** [DB-IP Lite](https://db-ip.com/db/lite.php) — published
by DB-IP (Belgium, EU) under CC-BY-4.0, downloadable monthly as CSV. Combine its
IP-to-Country and IP-to-ASN lite files into the format above. RIPE NCC
(Amsterdam) delegated-stats are an alternative for ASN/country. **Do not** use a
US-hosted geo SDK or tile/API service — the constraint is EU/self-hosted data.

When `GEOIP_DB_PATH` is unset or the file is unreadable, flows are still stored
but with `country`/`asn` NULL (no geolocation); a warning is logged at startup.

## Map API (Phase 8)

All endpoints are viewer+ behind the user JWT. Aggregation is server-side — raw
flow records never leave the server.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/geo/config` | Map tile source `{ tileUrl, attribution, maxZoom }` (so the frontend never hardcodes it). |
| `GET` | `/api/geo/overview?since=&hostId=` | `internalHosts` (site metadata) + `externalDestinations` (country/ASN aggregates with a deviation vs. the previous window). |
| `GET` | `/api/geo/select/findings?country=&asn=&since=` | Findings for the hosts that talked to the selected destination. `404` if unknown. |
| `GET` | `/api/geo/select/flows?country=&asn=&since=` | Aggregated flow detail (peers by ASN, by direction, by protocol, byte time-series). `404` if unknown. |

`externalDestinations` are **aggregates only** — they carry `country`, `asn`,
`asnName`, `bytes`, `flowCount`, `deviation` and a country-centroid `lat`/`lng`;
never a raw or private IP. `internalHosts` come from site metadata, never GeoIP.

### Dashboard

The **Geo** tab renders a Leaflet map (tiles from `/api/geo/config`): internal
sites as pins, external destinations as circles sized by traffic and coloured by
deviation (neutral → yellow → red), with clustering when the plugin is present.
Clicking a destination calls both `select/*` endpoints and shows findings + flow
detail in a side panel; clicking a site shows its status + findings; "Select
area" drags a box to aggregate every destination inside it. Loading and error
states are shown rather than a blank screen.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `GEO_ENABLED` | `true` | Enrich + store flow records. |
| `GEOIP_DB_PATH` | – | Path to the offline GeoIP/ASN range CSV. |
| `MAP_TILE_URL` | OpenStreetMap (EU) | Tile URL served to the frontend. Point at self-hosted/EU tiles in production. |
| `MAP_TILE_ATTRIBUTION` | `© OpenStreetMap contributors` | Tile attribution. |
| `MAP_TILE_MAX_ZOOM` | `19` | Max zoom. |

## Country centroids

`src/geo/countryCentroids.json` maps ISO-3166 alpha-2 → approximate `[lat, lng]`.
**Country level only — deliberately not city precision.** City-level GeoIP is too
imprecise to build selection or alerts on; centroids give stable marker
positions without pretending to a precision the data doesn't have. Extend the
table as needed.

## Tests

`node --test` — see `src/geo/__tests__/` (private-IP detection, provider lookup,
enricher incl. the privacy guarantee that internal flows never reach the
provider, flow extraction, pipeline) and `test/flowsRepository.test.js` +
`test/flowIngest.test.js`.
