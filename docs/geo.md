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
A destination is drawn here **unless** the city test below passes: centroids
give a stable marker position without pretending to a precision the data
doesn't have. Extend the table as needed.

## Destinations: city where it can be said honestly (migration 145)

A destination used to be drawn on the country centroid, full stop. For Canada
that is a point in Nunavut, while a traceroute stop in the same country is
drawn on its city — two layers of one map disagreeing by a thousand kilometres.

`src/geo/destinationPlace.js` decides per flow, at enrichment time, and writes
`city` / `city_lat` / `city_lng` onto `flow_records` only when **all** of this
holds:

| Test | Why |
| --- | --- |
| The ASN is not a cloud/hosting network (`hostingNetworks.js`) and not an anycast CDN (`ANYCAST` in `destinationPlace.js`) | One address answers from whichever of dozens of sites is nearest. "The city" does not exist |
| The city database and the country database name the **same** country | Two sources agreeing is the only corroboration available — a flow carries no round-trip time, so unlike a hop there is nothing to measure the claim against |
| There is a city name and a usable point | A city without coordinates is a label, not a position |

Anything else keeps `city` NULL and is drawn on the centroid. The destination
carries `precision: 'city' | 'country'`, and the map draws a country-level
circle with a dashed ring — the same language the path map uses for a stop it
only knows the country of.

**The rollup has no city.** `flow_rollup` aggregates per (agent, direction,
country, ASN) and keeps no `ext_ip` to recover one from, so a period reaching
past raw retention contributes one country-level row per (country, ASN)
alongside the city rows. Totals stay right; the older half of the window is
simply less precise. For the same reason `?city=` on the selection endpoints is
a raw-only read: filtering the rollup by a column it does not have would
quietly fold the whole country back in.

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

**Every hop that can be placed is drawn.** The reply time does not decide
whether a hop appears — it decides how the marker is labelled
(`place.certainty`):

| `certainty` | Means | On the map |
| --- | --- | --- |
| `exact` | The position fits what the reply time allows, or there is no agent position / no RTT to check against | Drawn plainly |
| `approximate` | A country centroid the reply rules out as a point, while the country itself is reachable (its centroid less `COUNTRY_REACH_KM`) | Drawn, marked "approximate" — the marker stands for the country |
| `registration` | The reply came back far too fast for anywhere in that country: anycast, or a block registered a continent from the rack | Drawn where it is registered, marked, with `withinKm` for what IS known |

Hiding a hop taught an operator less than drawing what the address says and
being honest about it: a path with holes in it reads as a broken trace.
`place.offByKm` is how far past the budget the pin sits, and `withinKm` is the
radius the reply time proves on its own. `alternatives` lists the sources that
did not win, so the drawer can show the rDNS city behind a GeoIP country.

**Filling the gaps from the path** (`settlePath`). A hop GeoIP can place
NOWHERE — no router name, no city, no country — is drawn with the last placed
hop when its fastest reply is at most **2 ms** behind it, or at the agent when
it answered within **5 ms**; its `place` then reads
`{ source: 'latency', nearHop, deltaMs }`. It never moves a hop that has a
position of its own: overriding the address's own answer collapsed whole paths
onto the agent and hid what the data said. A filled-in hop never becomes an
anchor, so a chain of small steps cannot creep a pin across a continent.

**Does the path agree with itself?** (`src/geo/hopConsistency.js`). Everything
above answers each hop ALONE, from what somebody published about its address
block — and a block is registered where the operator's head office is, not where
the rack is. The path knows better: three hops a millisecond apart are in one
building, whatever their blocks say. So after the hops are placed and settled,
each one is compared with the hop before and the hop after it. The bound is the
same physics used against the agent, applied between hops: an RTT difference of
*d* ms allows at most *d* × 100 km between them (+250 km slack, because both
ends are now estimates).

A hop is marked `place.suspect` when it disagrees with **both** neighbours while
they agree with **each other** — one-sided disagreement is left alone, because
at the end of a path "this hop is placed wrong" and "the path really does end in
another country" look identical. The mark carries the evidence (`prev`/`next`
with `distanceKm` and `allowedKm`) and a `suggestion`: where the nearer
neighbour sits. A hop placed from a correction, from RIPE, or by `settlePath`
is never second-guessed.

**Nothing is moved on that evidence.** Moving a hop because its neighbours
disagree is the mistake `settlePath` was written to avoid, and it hides the
thing worth seeing — that the GeoIP data for this address is wrong. The map
lists the suspect hops under the path (`pathSuspectNote` in `public/app.js`) and
offers the one thing that does move a hop: writing down where it stands.

## Correcting a hop (the server's own location table)

`hop_locations` (migration 144) is what somebody KNOWS, as opposed to what a
range file infers. It is the first candidate `locateHop` tries, ahead of the
router name, city GeoIP and the country centroid, and the reply-time check never
downgrades it: the person who runs the network outranks a published range.

| Column | Meaning |
| --- | --- |
| `ip` + `prefix_len` | one address (`/32`) or a whole block (`/24`, down to `/8`). Longest prefix wins, the way routing works, so a `/32` exception inside a corrected `/24` behaves as expected |
| `latitude`, `longitude` | where the router actually stands |
| `city`, `country` | what to call it on the map (both optional) |
| `source` | `manual` (somebody corrected it) or `ripe` (imported, below) |
| `note` | why they know — shown next to the hop, so the next person does not re-litigate it |

**In the UI, two places.** Under a path map, each suspect hop has **Correct
location** (operator+): a point picker that opens on what the neighbouring hops
suggest, a choice between this address and the whole `/24`, and the
city/country/note. **Settings → Data → Map** then lists every correction the
server holds — address, place, coordinates, source, note and who last changed it
— in lookup order (longest prefix first), with **Edit**, **Remove correction**
and **Add correction** for an address somebody already knows the answer for.

It sits on the Map screen rather than behind a nav entry of its own because it
answers the same question the GeoIP card above it answers: where the map gets a
position from. A screen in the sidebar for a table that is empty on every fresh
install would be read once and never again. Editing an existing row keeps its
prefix locked — `(ip, prefix_len)` is the row's key, so re-scoping in place would
write a second row and leave the first one on the map; a different scope is a
remove and an add. Typing an address instead (Add correction) takes a CIDR, and
the suffix is the scope.
`PUT /api/geo/hops` writes it, `DELETE /api/geo/hops?ip=&prefixLen=` goes back to
what GeoIP says, `GET /api/geo/hops` lists them (viewer+). Every write reloads
the in-memory index (`src/geo/hopCorrections.js`), so the next path drawn is
already corrected — a correction that only took effect after a restart reads as
"it did not work".

**RIPE NCC `geoloc:`.** The RIPE database carries an optional attribute holding
the coordinates the HOLDER of a block published for it — the operator saying
where their own equipment is, in a European registry, in a file that can be read
offline. `scripts/import-ripe-geoloc.js` streams a split file
(`ftp.ripe.net/ripe/dbase/split/ripe.db.inetnum.gz`), takes the records that have
one, converts each `inetnum` range to the prefixes that exactly cover it (never
wider — that would move addresses the holder never claimed) and inserts them as
`source = 'ripe'`:

```
node scripts/import-ripe-geoloc.js --dry-run ripe.db.inetnum.gz   # count first
node scripts/import-ripe-geoloc.js ripe.db.inetnum.gz
```

`INSERT IGNORE`, so an import never overwrites a manual correction. Most holders
leave the attribute out, so this seeds the table rather than replacing GeoIP.
Private space in the registry is skipped, like everywhere else here.

**Not IPinfo.** The obvious alternative is a commercial GeoIP aggregator API,
and the ones usually reached for (IPinfo among them) are US companies — ruled
out by the no-US-vendor rule this product is built on, and by the fact that a
runtime API call would send every router address a customer traces to a third
party. RIPE's published data is the European, offline answer to the same
question.

**Is the agent where its site says?** (`src/geo/hostingNetworks.js`). Every
distance is measured from the agent's site. When the first public hop belongs
to a cloud or hosting provider (DigitalOcean, AWS, Google Cloud, Azure,
Hetzner, OVH, …) and answers within 5 ms, the agent most likely runs in that
provider's data centre, or sends its traffic out through one. The graph then
carries `originHint: { hop, ip, asn, provider, rttMs }` and the map says so,
with a button to set the agent's position.

**An agent's own position** (migration 136). An agent borrows its site's
coordinates unless it has its own: **Agents → ⋯ → Position on map** (or the
button in the note above) opens a map where the position can be clicked,
dragged, found by address, or pasted as `latitude, longitude` the way a map
application copies it. **Edit agent** has the same position as a
text field (`latitude, longitude`; empty = the site's); a mistyped value is
refused before anything in the form is saved. `PUT /agents/:id/position` takes `{ latitude,
longitude }` or `{ coordinates: "55.6761, 12.5683" }`; both null goes back to
the site's position, and an empty body is refused rather than read as "clear".
The path map (`src/geo/agentPosition.js`) and the Destinations map
(`findForGeo`) use the agent's own position when it is set, and the cloud note
is not shown for an agent that has one — it is the answer to that note.

Each node carries `hostname`, `place` (`{ city, country, precision, source,
code?, nearHop?, deltaMs? }`), `geoRejected` and `withinKm`; `country`/`asn`
keep their meaning (the GeoIP registration). Live hops (`trace-hop`) go through
the same functions: the server keeps each running trace's hops for five minutes
(`createLiveTraces`), so a live hop is settled with the hops before it exactly
as the finished path will be, and the agent's site is looked up once a minute
per agent. The agent looks names up after the trace finishes, so a live hop has
no name yet and is placed by GeoIP and latency; the finished run replaces it
with the name-based placement.

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
