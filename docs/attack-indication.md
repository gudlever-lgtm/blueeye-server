# Attack indication

Three detectors that answer a question the rest of the analysis module cannot:
**is something on this network behaving like an attack?**

They are deliberately modest. BlueEyes is a fault and availability analyser —
local, explainable, robust statistics, no ML, no cloud, metadata only — and
nothing here changes that. None of these detectors classifies traffic as
malicious, scores a threat or names a technique. Each one states a fact with
its numbers, and the reader draws the conclusion:

| Metric | Says | Kind |
| --- | --- | --- |
| `security.auth_failure` · `security.acl_denied` · `security.port_violation` · `security.vpn_failure` | this device reported N of these in M minutes | rate over `device_events` |
| `net.scan` | this source address reached N distinct ports across M distinct hosts | threshold over `flow_records` |
| `peer.new_asn` · `peer.new_country` | this site has never reached that network before | first sighting against `known_peers` |

All three raise ORDINARY findings through the shared sink
(`src/devices/findingSink.js`): stored, pushed to the dashboards, grouped into
an event case, alerted through whatever channels are configured, handed to the
outbound integrations. There is no separate security pipeline, no second alert
path and no new UI surface — a finding is a finding.

They are gated like every other finding producer: the analysis feature flag
(`ANALYSIS_ENABLED`) **and** the `analysis` licence feature, plus a per-detector
switch of their own.

---

## 1. Security events from the equipment's own log

**`src/devices/securityEventDetector.js`** · findings `security.*`

The agents have always received, parsed and classified what the network
equipment says: `auth.failure`, `acl.denied`, `port.security_violation`,
`vpn.negotiation_failed` (agent `src/syslog/classify.js` and
`src/traps/translate.js`; the vocabulary is `src/devices/deviceEventCatalog.js`,
group `security`). The rows land in `device_events` with a syslog severity and
an occurrence count — and until now that was the end of it. Two hundred failed
logins against the core switch looked exactly like two hundred rows, and an
operator found out by scrolling.

This counts them. One rule per event type, a sliding window in memory, a
finding when the count crosses the threshold:

| Event type | Metric | Window | WARN | CRIT |
| --- | --- | --- | --- | --- |
| `auth.failure` | `security.auth_failure` | 10 min | 10 | 50 |
| `acl.denied` | `security.acl_denied` | 10 min | 50 | 250 |
| `port.security_violation` | `security.port_violation` | 15 min | 3 | 10 |
| `vpn.negotiation_failed` | `security.vpn_failure` | 15 min | 5 | 20 |

**Why a rate and not a baseline.** The median/MAD machinery needs a warm-up
against a value that moves. Failed logins are zero almost all the time, so the
baseline is a constant and the detector's "step off a constant" rule would fire
a WARN on the *first* login failure. A fixed rate with a window is the honest
shape for a counter that is normally idle, and it works on day one rather than
after a fortnight of learning.

**Where it runs.** Called by the device-event ingest
(`src/devices/deviceEventIngest.js`) *after* the rows are stored, exactly like
the switch-port history. The events are already safe; nothing here can fail or
slow the write it watches, and a detector that throws is logged and ignored.

**Counting.** Per sender, per event type. The sender is the polled switch when
the ingest resolved one, else the agent host, else the bare source address —
the same identity ladder the dedup key uses, so a sender is one sender in both.
Occurrences are summed, not rows: the ingest folds repeats into one row with an
`occurrences` count, and a folded row standing for sixty sightings counts sixty.

**Cooldown.** 30 minutes per (sender, rule). Without it a burst that keeps going
raises on every batch, and the event case that groups them is no substitute for
not making them.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECURITY_EVENT_ALERTS_ENABLED` | `true` | `false` turns the whole rule off |
| `SECURITY_EVENT_COOLDOWN_MINUTES` | `30` | quiet time per (sender, rule) after raising |
| `SECURITY_EVENT_MAX_TRACKED` | `5000` | ceiling on tracked (sender, rule) windows |
| `SECURITY_EVENT_RULES` | — | per-rule overrides, `type:warn/crit/windowMinutes`, comma-separated |

```
SECURITY_EVENT_RULES="auth.failure:5/30/60,acl.denied:200/1000/10"
```

An entry naming an event type this server's catalogue does not know is kept on
purpose: the agent's classifier ships ahead of the server's table, and refusing
a type the server has not heard of would mean an agent upgrade could not be
acted on. An entry that does not parse is dropped and logged rather than taking
the whole table down with it.

---

## 2. Port scans and fan-out

**`src/analysis/scanDetector.js`** · finding `net.scan`

The SQL has existed for a long time. The flow explorer's `scans` array
(`flowsRepository.exploreFlows`) counts distinct destination ports and hosts per
source and labels anything over fifty a port-scan or a fan-out. It is a good
signal and it was completely passive: a technician who already suspected
something, already had the right agent open and already picked the right time
window got told. Nobody else ever did.

This runs the same count on a schedule (leader-only), across the whole fleet,
and raises a finding for anything over the threshold.

- **port-scan** — the source reached `SCAN_PORT_THRESHOLD` distinct destination
  ports. A source over *both* lines is labelled a port-scan, the more specific
  of the two; the explanation names both counts either way.
- **fan-out** — the source reached `SCAN_HOST_THRESHOLD` distinct destination
  hosts.
- **CRIT** at ten times either line by default.

The finding's window is the burst (`MIN(ts)`/`MAX(ts)` of the matching flows),
not the whole search window, so a three-second sweep is not reported as a
fifteen-minute one.

### The product's own scanner is the first false positive

BlueEyes ships an active-discovery sweep (`src/discovery/scanner.js`) that
probes every address in an admin-configured scope on a schedule. It is, by
construction, the loudest port-scan on the network, and a detector that paged
on it would be uninstalled the same week.

So: **while discovery is enabled**, this server's own host addresses — read
from the interface list at run time, so an address nobody wrote down is still
covered — are ignored. With the sweep switched off they are not: this server
scanning the network is then worth hearing about.

`SCAN_IGNORE_SOURCES` is for every other scanner an operator knowingly runs —
a vulnerability scanner, an asset-inventory tool, a monitoring system that
port-knocks. It takes addresses and IPv4 CIDRs; an entry that does not parse is
logged rather than silently matching nothing.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCAN_ALERTS_ENABLED` | `true` | `false` turns the detector off (the explorer list stays) |
| `SCAN_PORT_THRESHOLD` | `50` | distinct destination ports that make it a port-scan |
| `SCAN_HOST_THRESHOLD` | `50` | distinct destination hosts that make it a fan-out |
| `SCAN_CRIT_PORT_THRESHOLD` | `10 ×` the port threshold | never below the WARN line |
| `SCAN_CRIT_HOST_THRESHOLD` | `10 ×` the host threshold | never below the WARN line |
| `SCAN_WINDOW_MINUTES` | `15` | how far back each run looks |
| `SCAN_JOB_INTERVAL_MINUTES` | `15` | how often it runs |
| `SCAN_COOLDOWN_MINUTES` | `60` | quiet time per (agent, source) after raising |
| `SCAN_MAX_PER_RUN` | `20` | above it, one log line instead of a flood |
| `SCAN_IGNORE_SOURCES` | — | comma-separated IPv4 addresses and CIDRs that may sweep |

The thresholds are read **once** by `src/server.js` and shared by the detector
and the flow explorer's on-screen list, so tuning one moves both. An operator
who raised the threshold because a load balancer trips it must not still see it
listed as a scan on the screen the finding links to. `GET /api/flows/explore`
answers with the thresholds it applied (`scanThresholds`).

---

## 3. Networks this site has never reached

**`src/analysis/newPeerDetector.js`** · `known_peers` (migration 142) ·
findings `peer.new_asn`, `peer.new_country`

Every other detector in this product compares a number against a number: a
z-score against a median, a rate against a threshold, a counter against its own
history. None of them can express the question an investigation actually opens
with — *has this ever happened before?* — because nothing was keeping the
answer. `flow_records` carries the ASN and the country of every external
endpoint and is purged after about a week, so "this server has never had
outbound traffic to a network in that country" was not a question the server
could answer, let alone raise.

`known_peers` is that memory. It is the `known_devices` pattern one layer out:
same scope string (`site:<id>` when the agent has a site, else `agent:<id>`),
same 400-day horizon, same flood guard. A MAC nobody at this site has seen
becomes `device.new`; a network nobody at this site has reached becomes
`peer.new_asn` / `peer.new_country`.

Each hour (leader-only) the previous complete hour's external conversations are
reduced to the set of (ASN, country) each scope reached. Anything the memory has
never held is new.

### Why the scope is a site and not a host

`(host → ASN)` would be the sharper signal, and it is also hosts × networks rows
and a finding every time a workstation opens a new CDN. The scope is the unit an
operator actually reasons about — "nothing at this site has ever talked to that
network" — and `last_src_ip` keeps the address that triggered it, which is what
an investigation needs in the first minute. If per-host memory is ever wanted,
it is a third `peer_kind`, not a second table.

### New is not bad

A new ASN is usually a CDN moving a customer, a supplier changing hosting, or
software that phones a different update server. That is why `peer.new_asn` is
**INFO** by default — a fact for the record and for correlation, not a page. A
new **country** is the rarer and sharper one (a site's traffic footprint is
stable at country level for months), so `peer.new_country` defaults to **WARN**.

Neither says "exfiltration". Both say what changed, when, and which internal
address did it.

### The flood guard

The first run against an empty memory would call every network on the internet
new at once. Two things stop that:

1. **Migration 142 seeds the table** from the flow records that still exist, so
   the memory starts with roughly the last week rather than empty.
2. **A scope stays silent until its memory is at least `NEW_PEER_BASELINE_HOURS`
   old.** It is still written during that time — it simply raises nothing. The
   same rule the new-device detector applies to an agent's first ARP report.

Above `NEW_PEER_MAX_PER_SCOPE` new peers in one hour for one scope, the rest
become one summary finding. A site that changes upstream provider meets fifty
new ASNs in one hour and that is one event. Countries are raised before ASNs, so
the sharper signal survives the cap.

The memory is written **before** the findings are raised: a crash between the two
costs one finding, where the other order costs the same finding every hour
forever. A memory that cannot be read means nothing is called new — never that
everything is.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEW_PEER_ALERTS_ENABLED` | `true` | `false` turns the detector off (the memory stops being written too) |
| `NEW_PEER_BASELINE_HOURS` | `24` | how old a scope's memory must be before it may call anything new |
| `NEW_PEER_ASN_ENABLED` / `NEW_PEER_COUNTRY_ENABLED` | `true` | turn either kind off; the memory keeps being written |
| `NEW_PEER_ASN_SEVERITY` | `INFO` | |
| `NEW_PEER_COUNTRY_SEVERITY` | `WARN` | |
| `NEW_PEER_MAX_PER_SCOPE` | `10` | above it, one summary finding per scope per run |
| `NEW_PEER_MIN_BYTES` | `1` | a first sighting under this many bytes is not a relationship |
| `NEW_PEER_JOB_INTERVAL_MINUTES` | `60` | |
| `RETENTION_KNOWN_PEER_DAYS` | `400` | the memory's horizon, aged on `last_seen` |

---

## What this is not

Worth saying plainly, because "attack detection" invites the assumption:

- **No DPI, no payload.** Metadata only — ports, addresses, ASN, timings,
  5-tuple — the same rule the whole product follows. `net.scan` says what was
  touched, not what was sent or whether anything answered.
- **No threat classification.** Nothing here labels traffic malicious, scores
  a threat, or maps to a technique taxonomy. `docs/flow-pair-baselines.md` made
  that a design choice and it still is.
- **No beaconing / C2 detection.** That needs inter-arrival-interval statistics
  over a (src, dst, port) series; the hourly rollups destroy the signal by
  design.
- **No ARP-integrity model.** `arp_entries` is upserted per (agent, IP); an IP
  changing MAC is not an event yet.
- **No allow/deny list for destinations.** Everything except
  `SCAN_IGNORE_SOURCES` is statistical or first-sighting. There is nowhere to
  express "traffic to this country is never OK here".

These are the honest remaining gaps, listed so the next person does not have to
rediscover them.

## NIS2

The NIS2 incident register (`docs/nis2.md`) carries a hand-entered
`suspectedMalicious` flag (Art. 23(4)(a)). These are the first detectors that
could reasonably set it — an event case built from `security.*`, `net.scan` or
`peer.new_country` findings is exactly the input that flag was meant for. The
wiring does not exist yet: `POST /api/nis2/incidents/from-event-case/:caseId`
still leaves the flag to a human.

## Where it appears

- **Findings** — the ordinary list and the per-agent view.
- **Changes feed** — the metrics map to the `security` condition family
  (`src/changes/indications.js`), whose sentence is
  `changes.indicates.security` in both catalogues.
- **Event guide** — `src/eventCases/guide.js` leads with *identify the source
  before treating this as an incident*, because these findings are counts and
  first sightings, not verdicts.
- **Alerting / ITSM** — through the normal dispatcher and integrations, with
  severity rules (`docs/severity-rules.md`) applied at store time as usual.
