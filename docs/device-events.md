# Device events — what the network equipment itself says

> Until this, BlueEyes could tell you that something broke. The switch had been
> saying **why** the whole time, and nothing was listening.

**Nav:** Diagnostics → Device log · **API:** `/api/device-events`
**Agent:** `blueeye-agent/src/syslog/` · **Table:** `device_events` (migration 103)

---

## The shape of it

```
switch / firewall / AP          the agent                      the server
──────────────────────          ─────────                      ──────────
  syslog → udp/tcp 1514  ──▶  receiver.js   bind + rate-limit
                              parse.js      RFC 3164 / 5424 / Cisco
                              classify.js   → event_type + ifname
                              mask.js       credentials redacted HERE
                                  │
                                  │ batched every 30 s, over the REST
                                  │ channel the agent already holds
                                  ▼
                       POST /agents/me/device-events
                                  │
                       deviceEventIngest.js   who sent it · how it folds
                                  ▼
                            device_events
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
      Device log           target timeline         changes feed
   (its own screen)     (next to the findings)   (warning and above)
```

Nothing new leaves the customer's site. The devices point their logging at an
agent **on their own network**, which is why no listener is needed anywhere near
the edge and why this works in an air-gapped install.

---

## Port 1514, not 514

Binding below 1024 needs root or `CAP_NET_BIND_SERVICE`. Running a monitoring
agent as root so it can receive **unauthenticated UDP from every switch on the
network** is the wrong trade, and it is not one we make quietly on somebody's
behalf during an upgrade.

So: default `1514`, and syslog is **off unless switched on** —
`BLUEEYE_SYSLOG_ENABLED=1` (or `syslogEnabled: true` in the agent config file).
A listening port is opt-in.

A host that wants the well-known port grants the capability to the service
rather than to the whole process:

```ini
# /etc/systemd/system/blueeye-agent.service.d/syslog.conf
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Environment=BLUEEYE_SYSLOG_PORT=514
```

Or leave the agent on 1514 and redirect:

```
iptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-port 1514
```

### Agent settings

| Env | Config key | Default | |
|---|---|---|---|
| `BLUEEYE_SYSLOG_ENABLED` | `syslogEnabled` | `false` | the receiver binds nothing unless this is on |
| `BLUEEYE_SYSLOG_PORT` | `syslogPort` | `1514` | |
| `BLUEEYE_SYSLOG_BIND` | `syslogBindAddress` | `0.0.0.0` | |
| `BLUEEYE_SYSLOG_UDP` / `_TCP` | `syslogUdp` / `syslogTcp` | both on | one failing to bind never takes the other down |
| `BLUEEYE_SYSLOG_FLUSH_MS` | `syslogFlushIntervalMs` | `30000` | independent of the traffic report: a link-down should not wait on a traffic sample |
| `BLUEEYE_SYSLOG_MAX_EVENTS` | `syslogMaxEvents` | `5000` | buffered rows before new ones are dropped |
| `BLUEEYE_SYSLOG_RATE` | `syslogRatePerSec` | `200` | per sender |

---

## Four dialects, detected per line

One device emits more than one format — a switch logs RFC 3164 while its
management daemon logs RFC 5424 — and a UDP datagram from one host says nothing
about the next. So `parse.js` detects the dialect **per line**, the same rule
`src/identity/arpTable.js` follows: an unparseable line must never discard the
rest of the batch.

| | Example |
|---|---|
| RFC 5424 | `<34>1 2026-09-20T09:41:09Z sw-core-1 sshd 1234 ID47 [sd] msg` |
| RFC 3164 | `<186>Sep 20 09:41:09 sw-core-1 %LINK-3-UPDOWN: Interface Gi0/1, changed state to down` |
| Cisco | `<189>4521: sw-acc-2: Sep 20 09:41:09.123 CEST: %SPANTREE-5-TOPOTRAP: …` |
| PRI only | `<14>anything at all` |

A line with **no PRI at all is not syslog** and is counted, not stored.
Accepting it would mean inventing a facility and a severity, and a severity
nobody measured is worse than a line nobody stored.

RFC 3164 carries no year. It is resolved against the moment the agent received
the line, with one rollback rule: a stamp more than a day in the future belongs
to the previous year (a December log read on 1 January). This is the one place
guessing beats not guessing — the alternative is no device time at all, which
loses the clock-skew check the whole screen is built around.

---

## Classification, and what is deliberately not classified

`classify.js` maps a line onto an `event_type`. It is a table of patterns — no
MIB files, no vendor SDK, no model.

**A line the table does not recognise is `syslog.raw`, kept verbatim, and never
coerced to its nearest neighbour.** A wrong `event_type` is worse than none: the
correlator and the timeline trust the type, and a technician reading
`ospf.adjacency_lost` on a line that said something else has been actively
misled. Same rule the diagnose module applies to LLM output.

An **interface name is extracted from every line**, classified or not: a line
nobody recognises still belongs on that interface's timeline.

The vocabulary lives in `src/devices/deviceEventCatalog.js` and is served to the
dashboard by `GET /api/device-events/catalog`, so the filter list and the stored
data have exactly one definition.

### The server's table may be behind the agent's

The agent ships the classifier, and a newer agent will send types this server
has not heard of. That is **not** an error: `describeEventType()` returns null,
the row stores and displays its raw type, and filtering still works because it
filters by string. Refusing an unknown type would mean an agent upgrade silently
dropping the events it just got better at recognising.

---

## Masking happens on the agent

`mask.js` redacts credentials **before the line leaves the host**, so the
unmasked text exists only inside one function's stack frame. Same keyword list
as `src/config/mask.js` uses for device configuration.

What is **not** shared is that module's `maskIps()`. In a device config an IP
literal is incidental; in a syslog line it is the message. Masking it would
leave a line that says a neighbour went down and refuses to say which one.

Privacy is unaffected either way: these are the equipment's own operational
messages — metadata about the network, never user payload. No DPI comes in
through this path, and nothing here is geolocated.

---

## Who sent it

The agent knows only a source IP. `deviceEventIngest.js` resolves it:

1. **The agent inventory** — reported IPs and SNMP monitor targets, through the
   same `buildHostResolver` the topology graph uses. One resolver, one answer;
   two would eventually disagree. Cached for 60 s.
2. **`arp_entries`** — the IP↔MAC table an agent reports from its own neighbour
   cache. One lookup per *distinct* unresolved address in the batch, not per
   row: a switch mid-outage sends the same address hundreds of times.
3. **Neither** → stored with `device_id NULL` and the source IP intact.

Step 3 is the one worth protecting. Discarding an unresolved sender would throw
away the one message that explains an outage because the inventory was
incomplete — and an outage is exactly when inventories are incomplete. The
device log shows such a row as `(unknown sender)` rather than hiding it.

---

## How it folds

A device logging the same line every second must become one row per window, not
three hundred. Two mechanisms, at different scales:

* **In the agent**, within one drain window: the receiver keys its buffer on
  `(sourceIp, eventType, ifname, summary)` and accumulates `occurrences`.
* **In the server**, `dedup_key` is nullable + UNIQUE — the mechanism
  `audit_events` (035) already uses. The key is

  ```
  d<deviceId>|<transport>|<eventType>|<sha256(type+iface+summary)[0:24]>|<5-min bucket>
  ```

**The bucket is in the key**, which is what keeps folding bounded: a link flap
this morning never merges into one from last week, and a rate that changes over
time stays readable as a sequence of rows. The summary is *hashed* rather than
included — it is 512 characters against a 160-character column, and hashing also
keeps message text out of an index.

A NULL `dedup_key` opts a row out of folding entirely.

---

## Storage

`device_events` is **TELEMETRY** by the classification in
[storage-split-audit.md](storage-split-audit.md): HIGH write volume, and bursty
in a way nothing else is — one switch in an STP loop out-writes the whole
fleet's traffic sampling for as long as the loop lasts.

So it follows the same dual-store rule as `results` and `probe_results`:

| | |
|---|---|
| `deviceEventsRepository.js` | MySQL, when TSDB is not configured |
| `deviceEventsTsdbRepository.js` | the TimescaleDB hypertable, when it is |

`src/server.js` picks one; the router, the timeline and the changes feed never
learn which answered. Deciding this at migration time rather than later is
deliberate: adding the split afterwards means migrating a table that by then
holds millions of rows.

The one real difference is in the writes. MySQL folds with
`ON DUPLICATE KEY UPDATE` against a UNIQUE `dedup_key`; a hypertable cannot
carry a UNIQUE index that excludes its partitioning column, so the TSDB
repository does an explicit UPDATE-then-INSERT within the window the bucketed
key already bounds. Callers see the same `{ inserted, folded }` either way.

**Retention: 30 days** (`RETENTION_DEVICE_EVENT_DAYS`). Long enough to explain
an outage somebody is still writing the report for; short enough that a chatty
fleet does not turn the device log into the largest thing on the disk. The
TimescaleDB policy in `server/db/timescale/001_init.sql` uses the same window, so
the two stores expire together.

---

## The API

### `GET /api/device-events` — viewer+

Viewer, deliberately. This is the same data class as the Flows explorer and the
probe results a viewer already reads, with credentials already masked. A
technician who can see that a link went down should not need operator rights to
read the line where the switch says so.

| Query | Default | |
|---|---|---|
| `minutes` | `120` | 1..10080; outside that is **400**, not a silent clamp |
| `limit` / `offset` | `100` / `0` | limit 1..500 |
| `maxSeverity` | — | 0..7. **LOWER IS WORSE** in syslog, which is why the parameter is named `maxSeverity`: `4` means warning and above |
| `deviceId` / `agentId` | — | an id nobody has is **404** — "no events" and "no such device" are different answers |
| `transport` | — | `syslog` \| `trap` |
| `eventType` | — | a dotted identifier |
| `q` | — | free text over message, device name and interface |

Returns `{ window, filter, counts, events[], hasMore }`. The severity `counts`
are computed over the same window **without** the severity filter — a chip is
only useful while it counts the rows it is hiding.

A failing count costs the chips, never the log.

### `GET /api/device-events/catalog` — viewer+

The severity names and event-type groups the filters offer.

### `POST /agents/me/device-events` — agent token

Answers **202** with `{ inserted, folded, skipped, resolved, unresolved }`.

Counts rather than a bare acknowledgement, because an operator staring at
"202 accepted" with nothing new on screen needs to tell a repeat batch from a
broken pipeline, and an unresolved sender from a dropped one.

The agent is authenticated; **its input is not trusted.** Every field originated
on equipment anyone on the customer's LAN can send UDP to, so
`src/validation/deviceEventValidation.js` is a real boundary: bounds on every
string, a fixed vocabulary for the enums, a cap of 1000 rows per batch, and a
bounded `clock_skew_ms` so a device claiming 1970 cannot overflow the column.

**A malformed row is skipped, not fatal to the batch.** One bad line out of 500
must not cost the other 499 — the same rule the agent's per-line parser follows.

With no ingest wired the route answers **503**, not 202: answering "accepted" to
a write that went nowhere is the one failure mode nobody can diagnose from the
outside.

---

## Why the clock skew is a column

Switches keep bad time. A device whose clock is three seconds behind silently
ruins every correlation built on its timestamps, and an operator reading the log
has no way to tell.

`clock_skew_ms` stores the measured difference between the device's own stamp
and the moment the agent received the line, and the device log puts it **on the
row**. `NULL` means the line carried no device time at all, which is not the
same as zero skew.

---

## Where the events show up

| | |
|---|---|
| **Device log** | its own screen, the full stream |
| **Target timeline** | `source: 'device'` next to the findings for that agent — the switch's own account of what happened, beside the server's inference about it. Keyed on the RESOLVED `device_id`, so an unresolved sender correctly appears on nobody's timeline |
| **Changes feed** | **warning and above only.** The landing page answers "what changed since I last looked", and a fleet's notice-level chatter is not that. Folds as `device_event`, for the same reason `interface_state` does: a port that flaps forty times is one thing to look at |

The eight syslog levels narrow to the three the rest of the server speaks
(CRIT/WARN/INFO) through `severityBand()` in `deviceEventCatalog.js` — one
definition, used by both consumers. `err(3)` and worse is CRIT, `warning(4)` is
WARN, the rest is INFO.

`classifyEvent()` in `targetTimeline.js` treats four device events as a
**change** rather than a symptom: `config.changed`, `device.rebooted`,
`port.err_disabled`, `stp.root_changed`. Somebody or something altered the
device; a link going down is the fault showing itself. That split is what makes
"what changed before this finding" answerable from the device's own log.

---

## Operating it

The `diagnose` command's reply now carries a `syslog` block — port, what
actually bound, buffered rows, received, **dropped** (refused by the rate limit),
**unparsed**, **overflowed**, distinct senders, and when the last batch was
submitted. So "why am I not seeing logs from this switch?" is answerable from the
dashboard without shell access to the host.

Two things the agent deliberately does **not** do:

* **It does not re-queue a drained batch when the server is unreachable.**
  Holding it would accumulate an outage's worth of log lines in memory on a host
  we do not own. The receiver's bounded buffer exists so this process never
  becomes the outage; the counters record the gap so it is visible rather than
  silent.
* **It does not fail to start when it cannot bind.** A host where something else
  already holds the port still reports traffic and runs probes.

---

## Next

Stage 03 adds **SNMP traps** on the same rails: `transport: 'trap'`, the same
table, the same route, the same screen with a source filter. That is why
`transport` is an ENUM with both values from migration 103 rather than a column
added later — a trap and a syslog line are the same thing arriving over a
different socket.
