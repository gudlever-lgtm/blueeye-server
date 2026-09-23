# Interface counters — what a switch port has been doing

> Everything before this answered **where** something is. This answers what a
> port has been **doing**, and it is the first per-port time series in the
> product.

**Nav:** SNMP device → port table · **API:** `/api/snmp-devices/:id/counters`
**Agent:** `blueeye-agent/src/snmp/counters.js` · **Tables:** `device_counter_samples` (migration 109), `device_interfaces` (108)

---

## The shape of it

```
   the switch                 the agent                      the server
   ──────────                 ─────────                      ──────────
   IF-MIB ifXTable   ──▶  snmp/counters.js
   IF-MIB ifTable         one READ per cycle, raw values
   EtherLike-MIB          + sysUpTime in the same session
   sysUpTime                     │
                                 │ 4 devices at a time, own interval
                                 ▼
                    POST /agents/me/snmp-counters
                                 │
                    snmpCounterIngest.js
                      · resolve port by NAME (not ifIndex)
                      · read the PREVIOUS sample per port
                      · counterDelta.js: rate, or a reason there is none
                                 ▼
                    device_counter_samples   (TSDB, or MySQL)
```

---

## Both the raw counter and the rate

Nothing else in this product stores a raw counter. `snmpMonitor.js` — the 1:1
traffic source — reads twice, subtracts, and sends rates; the counters never
leave the agent. That is right when an agent measures **itself** at a cadence it
owns, and wrong here:

- **A rate can never be recomputed.** Change what "utilisation" means and every
  historical number is stuck with the old definition.
- **A counter reset cannot be recognised after the fact.** With only rates, a
  reboot is a single enormous spike, indistinguishable from a real one.
- **A missing cycle cannot be told from a cycle that measured zero.** A raw
  counter that did not move says *no traffic*; a row that is not there says *we
  did not look*.

So the raw value is the evidence, the rate is the derivation, and both are kept.

---

## When the arithmetic must NOT run

This is the part worth reviewing. In each of these cases subtraction produces a
number, and the number is a lie — which is worse than a gap, because it is
indistinguishable from a measurement.

| `discontinuity` | What happened | What is stored |
| --- | --- | --- |
| `first` | No previous sample for this port | Raw counters, no rates |
| `reboot` | The device restarted between polls | Raw counters, no rates |
| `renumber` | The port's ifIndex moved between polls | Raw counters, no rates |
| `gap` | The interval was over 10 minutes, under 5 seconds, or nonsensical | Raw counters, no rates |
| `wrap` | A 32-bit counter went backwards | Raw counters, no rates |
| `NULL` | The delta is real | Everything |

### The reboot case everybody forgets

A switch that reboots at 03:00:10 and is back up at 03:00:40 has a **rising**
`sysUpTime` at the 03:01 poll — it just rose by twenty seconds instead of sixty.
Comparing against zero misses it entirely; the check is against the **elapsed
real time**, with 30 seconds of slack for drift and slow polls.

```js
uptimeGrewSec + UPTIME_SLACK_SEC < elapsedSec   // → rebooted
```

`sysUpTime` is read in the same GET as the rest of the device scalars on every
poll, and the last value is kept on `snmp_devices` rather than recomputed from
the samples — the check has to run *before* the new rows are written.

### Why a wrap is not corrected for

A 32-bit octet counter wraps in about **34 seconds** on a saturated gigabit
port, which is faster than any polling interval worth having. At 60 seconds the
counter may have wrapped once, twice or five times, and nothing in the data says
which. Adding 2^32 would be a guess with a decimal point on it, so the rate is
null and the row says `wrap`.

On a 64-bit counter a decrease is never a wrap — an octet counter would have to
run for months at 100 Gbit/s to reach 2^64 — so a decrease there means the
device is wrong, and the honest answer is the same: null.

A wrap on **either** direction voids the whole row. Both directions are read
from the same device at the same moment, and half a trustworthy row invites
somebody to read the other half as if it were fine.

### Absent is not zero

Every counter the device did not answer for is `NULL`, never `0`. **Zero FCS
errors is what rules out a bad cable**, and a device that cannot count them has
ruled out nothing. The same rule runs from the agent's walk (a column missing
from the result object) through the validator (a negative or unparseable value)
to the stored row.

Utilisation follows it too: `NULL` when the device reported no speed, because a
percentage of an unknown is not a number and `0` would read as an idle port.

### Duplex and late collisions (migration 116)

`duplex` is what EtherLike-MIB `dot3StatsDuplexStatus` said (`half` | `full` |
`unknown`, `NULL` when the device did not answer). It is a **state**, not a
counter, so it survives every discontinuity. `late_coll_pps` is the
late-collision rate for the interval, computed and voided exactly like
`fcs_pps`, and analysed by the detector as `if.<id>.duplex.collPps` (not a name
containing "late": the changes feed and the event guide would read it as
latency).

A port reporting **half** duplex while late collisions or FCS errors are rising
is raised as a duplex-mismatch finding (`if.<id>.duplex.mismatch`, WARN, once
per port per hour, `src/devices/duplexMismatch.js`) whose explanation names the
port and says what to change. The switch page shows FCS, late collisions and
duplex beside errors and discards.

---

## The identity is the port, not the index

`device_counter_samples.interface_id` points at a `device_interfaces` row, whose
key is `(device_id, if_name)`. **ifIndex never appears in the time series.**

The MIB only guarantees ifIndex stable between re-initialisations of the network
management system. A reboot may renumber; inserting a module into a chassis
almost always renumbers everything after it. Keyed on ifIndex, the 18th's
numbers for `Gi1/0/12` would sit beside the 19th's for a `Gi1/0/12` that is now
a different physical port.

Resolution order on ingest: **name, then index**. A sample whose port is in
neither is dropped and counted (`unresolved`) rather than guessed at — it would
have nothing to be a measurement of, and the next topology poll creates the row.

---

## The cadence, and why it is its own setting

A forwarding table is a snapshot of where things are; every five minutes is
generous. **A counter series' interval IS its resolution** — a five-minute
sample cannot show a two-minute error burst at all.

So `snmp_devices.counter_interval_sec` is separate from `interval_sec`, floored
at 30 seconds, defaulting to 60. A device is polled for counters only when its
`collect` list contains `ifcounters`, so the volume is opt-in per device.

It is also **capped at 600 seconds**, which is `MAX_DELTA_SEC` — the same
number the `gap` rule above uses. A device set to report counters every twenty
minutes would store readings for ever and never produce one rate, because every
delta would be wider than the gap ceiling. The validator refuses the setting
rather than letting the screen fill with raw octets and empty rate columns, and
it imports the number from `src/devices/counterDelta.js` so the two cannot
drift. The topology interval keeps its own much wider ceiling (a day) — nothing
about it is a rate.

### Four at a time

The topology cycle is deliberately **sequential** — ten simultaneous
bridge-table walks out of one host looks like a scan. At a 30-second per-device
timeout that is ten minutes for twenty devices, against a wanted interval of
sixty seconds. **One minute of polling for twenty switches cannot be done one at
a time.**

So the counter cycle runs a bounded number at once (`COUNTER_CONCURRENCY = 4`).
Not `Promise.all` over everything, which is the burst the sequential rule was
protecting against; four is enough to fit twenty devices into a minute with a
30-second worst case, and small enough that the traffic still looks like
monitoring.

---

## Volume and storage

20 switches × 48 ports at 60 s:

| | |
| --- | --- |
| Rows per cycle | 960 |
| Rows per day | ~1.38 million |
| Uncompressed | ~250 MB/day, ~90 GB/year |
| TimescaleDB, compressed | ~12–25 MB/day, ~4.5–9 GB/year |

One **wide** row per port per poll, not one per metric — the narrow shape is ten
times the rows. The cost is that a new metric is an `ALTER` rather than a new
id, and with IF-MIB that is acceptable: the column set is defined by an RFC from
2000 and does not move.

This is the first table in the schema with a **compression policy**
(`compress_segmentby = interface_id`, after 7 days). Counter columns are
monotonically rising `BIGINT`s, which delta-encode well, and the error columns
are zero most of the time on a healthy network, which run-length-encodes well.

**Retention**: 90 days in TimescaleDB; **14 days** in the MySQL fallback
(`RETENTION_DEVICE_COUNTER_DAYS`), because 180 bytes × 1.4 million a day is
~10 GB a month in InnoDB with no compression to lean on. The port inventory is
purged on a **longer** window (180 days) so a sample never outlives the row that
gives it meaning.

---

## Routes

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `POST` | `/agents/me/snmp-counters` | agent token | One cycle. **202** with counts and a breakdown of the discontinuities. Ownership checked in the ingest: an agent may only write the devices assigned to it |
| `GET` | `/api/snmp-devices/:id/counters` | viewer+ | The newest sample per port, with the port's name, alias, speed and status |
| `GET` | `/api/snmp-devices/:id/interfaces/:interfaceId/series` | viewer+ | One port's series over a window (`minutes`, default 240, downsampled to 500 points). **404** when the port belongs to another device |

`503` rather than an empty list when counters are not configured: *not
collecting* and *collecting, nothing seen* send a technician to different
places.

---

## Where things are

| | |
| --- | --- |
| The arithmetic (pure) | `src/devices/counterDelta.js` |
| Ingest | `src/devices/snmpCounterIngest.js` |
| Storage | `deviceCounterSamplesRepository.js` + `…TsdbRepository.js`, migration 109 |
| Validation | `src/validation/snmpDeviceValidation.js` (`validateSnmpCounterBatch`) |
| Agent read | `blueeye-agent/src/snmp/counters.js` |
| Agent schedule | `blueeye-agent/src/snmpPoller.js` (`runCounterCycle`) |
