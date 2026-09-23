# Layer-2 loop detection

> A forwarding loop makes broadcast traffic circulate forever, multiplying at
> every switch. The symptom is the whole site degrading at once, in waves — and
> the fault is one cable, somewhere.

**Detector:** `src/analysis/l2Loop.js` (pure) · **Service:** `src/analysis/l2LoopService.js`
**Tables:** `fdb_entries` + `fdb_mac_moves` (migrations 111, 117), `device_counter_samples` (109), `device_events` (103)

---

## What was here before

Nothing. `src/diagnose/playbooks/l2_loop.json` is a **symptom playbook** — it
describes the fault in two languages and lists tests a technician can run by
hand. There was no detector, and the server contained no SNMP OIDs at all.

---

## Why a loop needs its own detector

A loop is not an outlier in one metric. It is a **pattern across three
independent facts**, each unremarkable on its own:

| Fact | Where it comes from | Why it happens |
| --- | --- | --- |
| A MAC address keeps moving between two ports | `fdb_mac_moves`, counted inside the window | Frames from one host arrive by two paths, so the switch relearns the address on whichever port delivered last |
| Broadcast arrival rate up sharply on **many** ports at once | `device_counter_samples.in_bcast_pps` | A broadcast in a loop circulates forever and multiplies at every switch |
| Spanning tree reconverging repeatedly | `device_events` `stp.topology_change` | Either the cause (it has not converged) or the symptom (it keeps trying) |

A MAC moves when somebody unplugs a laptop. Broadcast rises when a backup
starts. STP changes when a port comes up. **Each of these alone is ordinary**,
and a detector that fires on any one of them is a detector somebody switches
off within a week.

So the first fact carries the case and the other two corroborate:

```
flapping MACs >= 3            +2      ← required; nothing fires without it
flapping MACs >= 9            +1
one port PAIR holds most      +1      ← names the two cables
broadcast surging on >= 3     +2
STP reconverged >= 2 times    +1

score >= 5 → CRIT      >= 3 → WARN      else INFO
```

---

## The evidence had to be created

`fdb_entries.upsertMany` rewrote `bridge_port` in place. A MAC that moved left
no trace of where it had been, so **two consecutive sweeps of a switch in a loop
looked exactly like two sweeps of a quiet switch**. The information was arriving
and being overwritten.

Migration 111 adds three columns — `prev_bridge_port`, `move_count`,
`last_move_at` — recorded **in the upsert itself**:

```sql
ON DUPLICATE KEY UPDATE
  prev_bridge_port = IF(bridge_port <> VALUES(bridge_port), bridge_port, prev_bridge_port),
  move_count       = move_count + IF(bridge_port <> VALUES(bridge_port), 1, 0),
  last_move_at     = IF(bridge_port <> VALUES(bridge_port), VALUES(last_move_at), last_move_at),
  ...
```

In SQL rather than read-compare-write, because a big chassis is five thousand
rows and a round trip per MAC would make a sweep ten thousand of them.

**Not a history table.** What a detector needs is *how often is this MAC
changing port, and between which two* — a count and the previous port, not a row
per observation. A history table for a forwarding database would be the largest
table in the schema within a week, to answer a question nobody asks: where a MAC
was three weeks ago is something the **switch** forgets in minutes.

---

## The output names two cables

This is what turns a detection into a work instruction.

> **6 MAC addresses moved between ports 54 times on sw-core-1 in the last few
> minutes. 6 of them are bouncing between Gi1/0/12 and Gi1/0/24 on VLAN 20. One
> of those two links is almost certainly carrying the loop. Broadcast traffic is
> up sharply on 7 ports at once, which is what a broadcast circulating in a loop
> looks like from the inside. Spanning tree has reconverged 4 times in the same
> window — either it has not settled, or it keeps trying to break the loop and
> failing. A switch relearns a MAC on whichever port delivered the frame last,
> so an address on two ports at once means frames from one host are arriving by
> two paths.**

"Six MACs are flapping" tells somebody to go looking. **"Between Gi1/0/12 and
Gi1/0/24" tells them which two cables to pull**, and one of the two is the loop.

Port pairs are order-independent (12→24 and 24→12 are one pair) and ranked by
how many MACs each holds.

---

## Two details worth knowing

**The broadcast surge is measured against the port's own baseline**, not an
absolute. An access port doing 5 broadcasts a second is odd; an uplink doing 5
is idle, and one threshold gets one of those wrong every time. The baseline is
the **median** of the port's recent history — a mean would be dragged up by the
surge it is supposed to measure against. A port with fewer than three samples
gets `null`, not `0`: an absent baseline must never become the strongest
possible evidence of a surge.

**The baseline read is capped at 64 ports per device.** Every port's baseline
is its own query, and a 48-port switch asking 48 times is nothing — a chassis
with 500 ports asking 500 times, on every topology cycle it has moving MACs,
is. The ports are taken in order of their current broadcast rate, so the ones
a surge could possibly be on are the ones looked at, and 64 sits far above the
three surging ports the rule needs.

**One finding per device per 30 minutes.** A loop that lasts an hour is one
fault, not sixty. Without the refractory period the detector raises on every
topology cycle for as long as it takes somebody to find the cable.

---

## When it runs

From the **topology ingest**, immediately after a forwarding table has been
re-read — which is the moment the move counters have moved. On a timer it would
either check a table nothing had touched, or miss the window where a loop is
visible at all.

It is best-effort and last in the ingest: a detector that throws must never cost
the sweep that was going to feed it.

---

## The finding

`metric: 'l2.loop'`, `kind: 'THRESHOLD'` — there is no baseline to deviate from;
the rule is *this many MACs flapping this fast IS a loop*, stated in code.

It carries `device_id` and **`interface_id: null`** (migration 110): a loop is a
property of the **switch**, not of one port, even though the verdict names two.
`host_id` is the polling agent, so every per-agent read finds it, and it is
grouped into an event case like any other finding — a loop belongs in the same
event as the link flaps and timeouts it is causing.

It goes through the same sink every rule-based switch finding uses
(`src/devices/findingSink.js`): stored, published, grouped into an event case,
**alerted** (behind the alerting flag, suppressed when an open cluster already
covers the host) and handed to the outbound integrations. Before, the service
stored, published and grouped — and nothing handed it a dispatcher, so a loop
on the core switch opened an event case and paged nobody.

---

## Counting moves inside the window (migration 117)

`move_count` is all-time and reset by nothing, and the detector used to read it
as the number of moves **in its window**. A laptop re-docked forty times over a
month looked exactly like a MAC flapping forty times in ten minutes.

Each observed move is now kept in `fdb_mac_moves` — written by the sweep that
records it (one `INSERT … SELECT` of the rows whose `last_move_at` is this
sweep), aged out after `RETENTION_FDB_MOVE_DAYS` (default 2) — and
`movingMacs()` counts them inside the window. `move_count` stays the all-time
figure it always was.

Counting correctly exposed a second fault the all-time count had been hiding:
**a sweep sees at most one move per MAC**, so a ten-minute window over a
switch polled every five minutes holds two sweeps and a MAC could never reach
the four moves the rule needs. The window is therefore the configured floor
(10 minutes) or `MIN_SWEEPS_PER_WINDOW` (eight) sweeps of the device's own
topology interval, whichever is longer — 40 minutes at the 300-second default.
A switch where loops matter should be polled every 60 seconds.

## A storm with no MAC flapping

A loop entirely **behind one port** — an unmanaged desk switch with two of its
ports patched together — never makes a MAC flap on the managed switch: every
circulating frame arrives on the same port. What the managed switch sees is a
broadcast storm pouring in on that port and not stopping.

So a port whose broadcast rate is at least `BROADCAST_SURGE_RATIO` times its
own median (over the last hour), at least 200 frames/s, for the last two
counter samples in a row, is raised as a **suspected** loop behind that port —
`basis: 'broadcast'` in the evidence, **WARN at most**, and an explanation that
says it is a suspicion (a faulty NIC or a flooding host looks the same). A
single burst, or a chatty port under the floor, is nothing. Without moving
MACs only ports above the floor are looked at, so on a quiet network the check
costs one read.

## Spanning-tree events are matched by the switch's address

`device_events.device_id` is **not** an `snmp_devices` id: the device-event
ingest resolves a sender through the agents' own addresses, so that column
holds an agent id. The STP corroboration used to query it with the switch's
`snmp_devices.id`, which matched some unrelated agent's events or none — in
production the corroboration was always zero. It now matches events by
`source_ip` against the switch's polled `host` (what the agent's trap receiver
and syslog listener record). A switch configured by DNS name has no address to
match and contributes nothing, which only ever adds nothing to the score.
