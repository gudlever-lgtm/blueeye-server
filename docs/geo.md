# Geo layer (flow records + GeoIP/ASN enrichment)

Phase 7 of BlueEyes. The server enriches the flows agents report with **country**
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
but with `country`/`asn` NULL (no geolocation); a warning is logged at startup,
and the Destinations map shows a **"GeoIP database not configured"** banner (so an
empty map reads as "not set up" rather than "broken"). Traceroute path overlays
likewise collapse to the agent origin until a database is loaded.

### Building the CSV

`scripts/build-geoip.js` turns the DB-IP Lite files into the format above (IPv4,
Node stdlib only — no dependency):

```
node scripts/build-geoip.js --country dbip-country-lite.csv.gz \
     --asn dbip-asn-lite.csv.gz --out /data/geoip.csv
# or stream them straight from a URL:
node scripts/build-geoip.js --country-url <URL> --asn-url <URL> --out /data/geoip.csv
```

It range-joins the optional ASN file onto the country ranges, so each output row
carries `country` and (where known) `asn,asn_name`.

### Configuring at runtime (admin)

Besides `GEOIP_DB_PATH`, an **admin** can set the server-side CSV path under
**Settings → Map → GeoIP database**. It persists in `app_settings` (overriding the
env path) and reloads the provider **live** — the response reports how many ranges
loaded, so a wrong path shows as `0` rather than a silent no-op. An empty path
clears the override (falls back to env / disabled). Only a *path* is stored, never
the file's contents.

### One-click / scheduled update (admin)

The same card has **"Update now"**: the server downloads the latest DB-IP Lite
release, builds the CSV with `geoipBuild.js` (shared with the CLI script) into
`GEOIP_BUILD_PATH` (default `/data/geoip.csv` — the persistent volume, so it works
in Docker with **no host mount**), then reloads the provider. It runs in the
background; the UI polls the job (`POST`/`GET /api/settings/geoip/update`) and shows
month + range count when done.

An **Auto-update monthly** toggle (opt-in) lets the server refresh itself when a new
month is published. This is the only part of geo that makes an **outbound** call, it's
admin-initiated/opt-in, and the source base URL is configurable (`GEOIP_SOURCE_URL`,
default db-ip.com). **Air-gapped installs** simply never enable it and keep using a
file built by `scripts/build-geoip.js` (which also has a `--latest` mode).

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
| `GEOIP_CITY_DB_PATH` | – | Path to the city table (traceroute hop placement only). |
| `GEOIP_CITY_BUILD_PATH` | `/data/geoip-city.csv` | Where "Update now" writes the city table. |
| `MAP_TILE_URL` | OpenStreetMap (EU) | Tile URL served to the frontend. Point at self-hosted/EU tiles in production. |
| `MAP_TILE_ATTRIBUTION` | `© OpenStreetMap contributors` | Tile attribution. |
| `MAP_TILE_MAX_ZOOM` | `19` | Max zoom. |

## Country centroids

`src/geo/countryCentroids.json` maps ISO-3166 alpha-2 → approximate `[lat, lng]`.
**Flows and destinations stay at country level.** City-level GeoIP is too
imprecise to build selection or alerts on; centroids give stable marker
positions without pretending to a precision the data doesn't have. Extend the
table as needed.

## Traceroute hops (city level where it can be shown)

A traceroute hop is a router, and a router's name usually says where it stands:
`ae3.cph-bb1.telia.net`, `be2376.ccr41.fra03.atlas.cogentco.com`,
`ae-5.r20.frnkge08.de.bb.gin.ntt.net`. So the traceroute maps place hops more
precisely than flows. `src/geo/hopLocation.js` (`locateHop`) tries three
sources, best first:

| Source | `place.source` | Precision | Where it comes from |
| --- | --- | --- | --- |
| Router name | `rdns` | city | The hop's PTR name (agent 0.40+ looks it up after the trace, public hops only), read against the curated code table in `src/geo/networkPlaces.js` by `hostnameHints.js` |
| City GeoIP | `geoip-city` | city | DB-IP City Lite (`cityProvider.js`). Often the operator's head office rather than the router, which is why it comes second |
| Country | `geoip-country` | country | The country centroid, as before |

**Reading a name.** The registered domain (`telia.net`, `example.co.uk`) is
dropped, the rest is split at dots, dashes and digits (`fra03` → `fra`), and
each word is looked up as an IATA/carrier/CLLI code or city name, or as a
UN/LOCODE (`dkcph`). A name that yields two different cities (`ams-fra-link`,
the two ends of a link) gives no place. The table is curated on purpose: most
of the ~9000 IATA codes collide with words routers use for other things (`tor`,
`man`, `bdr`, `per`), and a wrong code draws the hop in the wrong city. Add a
code to `networkPlaces.js` only when it cannot mean anything else;
`test/hopPlacement.test.js` checks the table.

**The speed-of-light check.** Light in fibre covers about 200 km per ms, so a
reply that took R ms round trip came from at most R × 100 km (+150 km slack)
from the agent. Each candidate is checked against the hop's **fastest** reply
across the aggregated runs; one that is too far is skipped for the next source.
A slow reply never pulls a hop anywhere — routers answer ICMP from their slow
path, so a long RTT says nothing about distance. The check needs the agent's
site coordinates; without them nothing is rejected.

When every candidate is ruled out — typically an anycast address such as a
public DNS resolver, registered in the US and answering from 3 ms away — the hop
gets no coordinates and `geoRejected` lists what was ruled out and why. The map
leaves it off and says so under the map.

Each node carries `hostname`, `place` (`{ city, country, precision, source,
code? }`) and `geoRejected`; `country`/`asn` keep their meaning (the GeoIP
registration). Live hops (`trace-hop`) go through the same function, with the
agent's site looked up once a minute per agent. The agent looks names up after
the trace finishes, so a live hop has no name yet and is placed by GeoIP; the
finished run replaces it with the name-based placement.

### City table

`GEOIP_CITY_DB_PATH` (or **Settings → Map → City-level data**) points at a CSV:

```
start_ip,end_ip,country,lat,lng,city
2.16.0.0,2.16.0.255,DK,55.6761,12.5683,Copenhagen
```

"Update now" builds it from DB-IP City Lite (same month, same source as the
country table) into `GEOIP_CITY_BUILD_PATH` (default `/data/geoip-city.csv`)
unless **Include city-level data when updating** is unticked. It is the largest
download (about 120 MB) and a failure there is reported but does not fail the
update. By hand:

```
node scripts/build-geoip.js --city dbip-city-lite.csv.gz --city-out /data/geoip-city.csv
node scripts/build-geoip.js --latest --with-city
```

Adjacent ranges on the same point are merged. The provider holds the table in
typed arrays (about 20 bytes a range, roughly 60 MB for the IPv4 lite file) and
streams it in the background: lookups answer null until it is loaded, and the
settings card says "loading". Only the traceroute maps read it.

## Tests

`node --test` — see `src/geo/__tests__/` (private-IP detection, provider lookup,
enricher incl. the privacy guarantee that internal flows never reach the
provider, flow extraction, pipeline) and `test/flowsRepository.test.js` +
`test/flowIngest.test.js`.
