# Attack indication

Four detectors that answer a question the rest of the analysis module cannot:
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
| `net.beacon` | this host called the same external address every N seconds for H hours | regularity over `flow_records` timings |
| `peer.new_asn` · `peer.new_country` | this site has never reached that network before | first sighting against `known_peers` |

All three raise ORDINARY findings through the shared sink
(`src/devices/findingSink.js`): stored, pushed to the dashboards, grouped into
an event case, alerted through whatever channels are configured, handed to the
outbound integrations. There is no separate security pipeline, no second alert
path and no new UI surface — a finding is a finding.

They are gated like every other finding producer: the analysis feature flag
(`ANALYSIS_ENABLED`) **and** the `analysis` licence feature, plus a per-detector
switch of their own.

**Everything here is tunable from the dashboard** — Settings → Attack
indication — and applies without a restart. The environment variables named
throughout are the FLOOR: they are what the process loads at boot, and what a
deployment that never opens that screen keeps. See
[Settings → Attack indication](#settings--attack-indication).

**An open finding shows as a red line** across the top of every screen. See
[The red line](#the-red-line).

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

## 3. Beaconing

**`src/analysis/beaconDetector.js`** · finding `net.beacon`

Everything else in the analysis module measures HOW MUCH: bytes against a
baseline, a count against a threshold, a counter against its own history. A
beacon is not loud. It is a few hundred bytes on a schedule, far below any
volume baseline, to an address that may be perfectly ordinary. What gives it
away is not the size but the **rhythm**, and nothing here was looking at rhythm.

### What the signal actually is

An agent sends a flow snapshot on its own cadence (`BLUEEYE_REPORT_INTERVAL_MS`,
60 s by default), so `flow_records` holds one row per 5-tuple per interval that
tuple was active in. Line up the distinct timestamps of one
(internal host → external peer : port) conversation and look at the gaps:

```
a person browsing     37s    4s  900s   12s   61s  2100s   — ragged
a session left open   60s   60s   60s   60s   60s    60s   — every interval
a beacon             600s  600s  601s  600s  599s   600s   — every tenth
```

**The middle one is the trap**, and it is why this cannot use a fixed number. A
conversation that never stops appears in every interval, perfectly regularly,
and looks exactly like a beacon. The only thing that separates them is the
agent's own reporting cadence — a beacon SKIPS intervals, a stream does not — so
the cadence is **derived per agent** from the same table
(`flowsRepository.reportCadence`) and a candidate must beat it by
`minCadenceMultiple` before its regularity counts for anything. A hard-coded
60 s would call every long-lived session on a five-minute agent a beacon.

### The measure

Median gap and a robust sigma over the gaps — median + MAD, the same statistics
as every other detector here, no second definition of "typical". **Jitter** is
`sigma / median`: a dimensionless number that is small when the gaps are all
alike whatever their length. 0.15 by default, so a ten-minute beacon may wander
about ninety seconds and still count.

One inversion worth knowing: `robustSigma` answers `null` when every sample is
identical. For a baseline that means "no scale exists"; here it means the
opposite — gaps that never vary at all are the strongest beacon there is — so
null is read as **zero jitter**, not as a missing measurement.

A candidate is rejected, and the reason is counted in the job's log line, when
it has too few calls, too short a span, no derivable cadence, a gap under the
cadence multiple (`continuous`), or jitter over the limit (`irregular`).

### Plenty of honest software beacons

NTP, update checkers, monitoring agents, licence heartbeats, telemetry. The
finding states the period, the jitter, how long it has been going on and how few
bytes each call carried, and then stops. **Port 123 (NTP) is excluded by
default** — its entire job is to call out on a fixed schedule, it is on every
host, and leaving it in would mean every deployment's first finding is its own
time service. **DNS is deliberately NOT excluded**: a resolver being called
regularly is ordinary, but DNS is also the most-used covert channel there is,
and excluding it by default would blind the detector to the case it is most
needed for.

The ignore lists are how an operator writes down what they already know, once,
instead of acknowledging the same finding every day. `ignoreAsns` is usually the
better answer than `ignoreDestinations`: a CDN-hosted update service is a moving
set of addresses and one stable AS number.

### Cost

The candidate list is one grouped read; the timings are **one read per
candidate**, which is the job's real cost. `maxCandidates` (100) bounds it, and
an ignored destination is dropped *before* its timings are fetched.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BEACON_ALERTS_ENABLED` | `true` | `false` turns the detector off |
| `BEACON_WINDOW_HOURS` | `24` | how far back each run looks (stay inside `RETENTION_RAW_DAYS`) |
| `BEACON_JOB_INTERVAL_MINUTES` | `60` | |
| `BEACON_MIN_OBSERVATIONS` | `12` | calls before regularity means anything |
| `BEACON_MIN_SPAN_MINUTES` | `120` | how long the pattern must have been running |
| `BEACON_MIN_CADENCE_MULTIPLE` | `2` | the anti-stream rule, in multiples of the agent's reporting cadence |
| `BEACON_MAX_JITTER` | `0.15` | sigma / median over the gaps |
| `BEACON_CRIT_JITTER` | `0.05` | never above the WARN line |
| `BEACON_MAX_CANDIDATES` | `100` | candidates pulled per run |
| `BEACON_MAX_PER_RUN` | `20` | above it, one log line instead of a flood |
| `BEACON_COOLDOWN_MINUTES` | `1440` | one finding per conversation per day |
| `BEACON_IGNORE_PORTS` | `123` | **empty means ignore nothing**, unset means the default |
| `BEACON_IGNORE_DESTINATIONS` | — | addresses and IPv4 CIDRs allowed to beacon |
| `BEACON_IGNORE_ASNS` | — | AS numbers allowed to beacon |

---

## 4. Networks this site has never reached

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

## Settings → Attack indication

Everything above is tunable from the dashboard, by an admin, without a restart.
`PUT /api/settings/attack-indication`, stored under the `attackIndication`
settings key, validated by `src/services/attackIndicationSettings.js`.

### Why the screen exists

Two of these knobs are ones a deployment cannot avoid touching, and both were
"edit `.env` and restart the server" — which on a customer's on-prem box means
a change window for a threshold:

| Field | Why it cannot stay in `.env` |
| --- | --- |
| `newPeer.baselineHours` | How long a site stays silent while its memory of "networks we have reached" fills up. Too short on a fresh install and the first day is a siren. |
| `scan.ignoreSources` | The addresses allowed to sweep the network. This server's own sweep is excluded automatically; a CUSTOMER's vulnerability scanner is not, and until it is listed it produces a CRIT on every run. |

The rest are here because once the screen exists, leaving half the knobs in
`.env` is the confusing answer.

### How it applies without a restart

`src/server.js` builds **one live object**, `attackConfig`, with a section per
detector, from the environment. Each detector holds a *reference* to its section
and re-reads it on every run (`config` may be a getter or a plain object). The
settings service mutates those sections in place — on save, and again at boot
through `applyStoredOverrides` — so a change lands on the next cycle. The same
`attackConfig.scan` object is what the flow explorer's on-screen scan list
reads, so tuning the threshold moves the finding and the list together.

### The rules the validator enforces

- **A patch carries only what it names.** Saving the scan card never restates
  the beacon values, and the rule table merges **per rule** — tuning the failed
  login counts does not drop the ACL rule somebody set last month.
- **What is stored is the admin's own decisions**, not the effective config, so
  a default that moves in a later release still moves for a deployment that
  never set it. `source` in the response says which fields were taken over.
- **A CRIT line below its WARN line is refused and named**, not silently
  clamped the way the env loader does. Checked against the MERGED result, so
  raising WARN in one save and CRIT in the next is not refused for a state that
  only ever existed between two requests.
- **Lists take a string or an array** — the UI sends a comma-separated line,
  the API accepts either, and what is stored is always an array. Bad entries are
  named, not counted.
- **An unknown event type is accepted** in the rule table, because the agent's
  classifier ships ahead of the server's catalogue.

### Where the numbers live

| Card | Section | Fields |
| --- | --- | --- |
| Port scans and fan-out | `scan` | enabled, port/host thresholds + their CRIT lines, window, cooldown, `ignoreSources` |
| Networks never reached before | `newPeer` | enabled, `baselineHours`, ASN/country on-off + severities, `maxPerScope` |
| Beaconing | `beacon` | enabled, window, min observations/span, jitter limits, cooldown, three ignore lists |
| Security events from the equipment | `securityEvents` | enabled, cooldown |
| Security event thresholds | `securityEvents.rules` | per event type: warn, crit, window |

---

## The red line

A **3 px red line** across the top of the content column whenever an open,
unacknowledged attack-indication finding of **WARN or worse** exists in the last
24 hours **and either is CRIT or has been corroborated** (below). Hidden, and
taking no space, when there is none — which is almost always.

- **Why a line and not a banner.** It has to be visible from across a room on a
  wall-mounted dashboard and cost nothing on every other day. A banner pushes
  the page down, gets dismissed, and is then never seen again; three pixels at
  the top edge are either there or not.
- **The whole strip is a button.** Hovering or focusing it drops a panel with
  the sentence the detector wrote; clicking opens the event case the finding was
  grouped into, or — when it has none yet — the Analysis screen filtered to that
  metric. It is a `<button>`, not a decorated `<div>`, so it is reachable by
  keyboard and announced as a control.
- **The strip never changes size.** The panel is absolutely positioned: outside
  the button's box for layout, inside it for hit-testing, so the pointer can
  walk down into the text without losing `:hover`, and nothing on the page moves
  when a mouse crosses the top edge. Growing the button itself is a hover loop —
  the pointer below the 3px line is inside the grown box and outside the
  collapsed one, so leaving it starts a shrink, the shrinking box passes back
  under the pointer, `:hover` applies again, about thirty times a second.
- **It carries its own `min-height: 0`.** Every `<button>` in the app has
  `min-height: var(--control-h)` so a control is tappable. Without a floor of
  its own, the strip rendered 40px tall — a slab, not a line.
- **CRIT breathes, WARN does not.** Same colour, a slow pulse for the critical
  one, behind `prefers-reduced-motion`.
- **Acknowledging is how it clears.** There is no private dismiss: accepting the
  finding is the existing act of saying "seen", and it leaves a record that
  somebody did.
- **INFO never raises it.** That is why `peer.new_asn` is INFO by default — and
  why raising it, in Settings or with a severity rule, is also how you make the
  line react to it.

### Red means "we are reasonably sure": corroboration

A single WARN is not sure. `net.scan` says one source touched a lot of ports,
and the detector's own sentence then admits that a vulnerability scanner, an
asset inventory or a backup agent walking the LAN looks exactly the same. A red
line over a sentence that says "this is probably your backup agent" teaches an
operator to stop reading the line.

So a **WARN reaches the bar only when a second detector agrees**: another open
attack-indication finding, with a **different metric**, in the **same event
case**, inside the same 24-hour window. A scan beside a first-ever ASN from the
same host is a story; a scan on its own is a candidate.

- **A different metric**, because two `net.scan` findings in one case is one
  detector saying the same thing twice — repetition, not corroboration.
- **The corroborator may be INFO.** `peer.new_asn` is INFO by default and still
  corroborates, without reaching the bar on its own.
- **It must still be open.** Acknowledging the corroborating half takes the
  other one off the bar: the agreement is what made it red.
- **A finding with no event case waits.** The correlator (`src/eventCases/`) is
  what places findings in a case; until it has, nothing has agreed with it. The
  Changes feed and Analysis carry it in the meantime — it is not lost, it is
  just not red.
- **CRIT is exempt.** The critical thresholds exist precisely to name the cases
  nobody needs a second opinion on, and waiting there would hold the bar back on
  the one night it matters. The exemption is a parameter
  (`corroborationExempt`), not a hard-coded severity.

### What the strip says, and what the page says

The strip shows a **summary**: whole sentences from the detector's explanation,
cut to 240 characters on a sentence boundary — never mid-word. The old hard
slice put "…add it to" on screen with the rest nowhere, and the half that was
being cut is the half that says what would make the finding harmless.

The **full** text lives on the event the bar opens, in its own
**Attack indication** panel above everything else on that page, with the finding
the bar actually opened marked "opened from the red line". The case's title is
usually about something else — the correlator names the case after its primary
fault — so without that panel the reader landed on a page about jitter and had
to hunt a scan out of nine one-line anomalies.

| Piece | Where |
| --- | --- |
| Which metrics count | `src/analysis/attackIndication.js` — the ONE list, also read by the changes feed and the event guide |
| The query | `FindingStore.attackIndication()`, on `idx_findings_open` — the corroboration test is an `EXISTS` back onto `findings` over `event_case_id` |
| The summary | `summarize()` in `src/analysis/attackIndication.js` (`BAR_SUMMARY_MAX`) |
| The `attack` flag on an event's anomalies | `GET /api/events/:id`, from the same membership list |
| The panel on the event page | `public/views/event.js`, `.attack-finding` in `public/css/components.css` |
| The endpoint | `GET /api/findings/attack-indication` (viewer+), mounted before `/:id` |
| The markup | `#attack-bar` in `public/index.html` |
| The behaviour | `refreshAttackBar()` in `public/app.js` — every render, every live finding over the dashboard socket, and a 60 s poll |
| The styling | `.attack-bar` in `public/css/components.css` |

The poller is session-scoped, not view-scoped: it is released by `logout()`
alongside the live socket, which is why it is not in `VIEW_RESOURCES` and not
named `stopX()`.

---

## What this is not

Worth saying plainly, because "attack detection" invites the assumption:

- **No DPI, no payload.** Metadata only — ports, addresses, ASN, timings,
  5-tuple — the same rule the whole product follows. `net.scan` says what was
  touched, not what was sent or whether anything answered.
- **No threat classification.** Nothing here labels traffic malicious, scores
  a threat, or maps to a technique taxonomy. `docs/flow-pair-baselines.md` made
  that a design choice and it still is.
- **No C2 attribution.** `net.beacon` says the traffic keeps time. It cannot
  say what the traffic is, because nothing here reads payload — an update
  checker and a command channel are the same shape from the outside.
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
- **The in-app guide** — Guides → Attack indication (`public/guides.js`,
  `securitySteps()`): seven steps covering what each detector measures, the two
  settings to touch on the first day of an install, and the red line. See
  `docs/guides.md`.


## Concluding an event puts the bar out

The bar counts findings with `acked = 0`. Acknowledging is how it clears — and
resolving or closing the **event case** the bar points at now accepts the
findings behind it, on every path that concludes a case (`PATCH
/api/events/:id`, `POST /api/events/bulk-status` by ids, and the filter-scoped
bulk form). Before this an operator could resolve the very event the bar was
about and be left with the bar still lit and no control on that screen that
could touch it.

Re-opening a case does **not** un-accept: those rows were seen, and un-seeing
them is not something an operator can do. The transition's response carries
`ackedFindings` so the screen can say what else it did, and the audit row
records the count alongside the status change.

Migration 143 does the same thing once for the backlog — the cases that were
concluded before this existed.
