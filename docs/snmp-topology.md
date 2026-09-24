# SNMP topology — which port is this MAC on?

> "The printer on the second floor is offline" ends, eventually, at a physical
> port on a physical switch. BlueEyes could get as far as IP ↔ MAC and stop.

**Nav:** Settings → SNMP devices · **API:** `/api/snmp-devices`
**Agent:** `blueeye-agent/src/snmpTopology.js` + `snmpPoller.js`
**Tables:** `snmp_devices` (104) · `fdb_entries` (105) · `snmp_neighbors` (106)

---

## What changed, and what it broke

SNMP already existed here, **bound 1:1**:

* `agents.monitor_config.source = 'snmp'` makes the *whole* agent poll one
  remote device **instead of** its own `/proc`. A site with twelve switches
  needed twelve agents.
* `agentsRepository.insertSnmpDevice()` creates an `agents` row with the
  sentinel platform `'snmp'` when an admin promotes a discovered candidate —
  a row **nothing ever polls**.

`snmp_devices` breaks that binding. One agent polls **many** devices,
**alongside** its own traffic sampling.

`monitor_config` is untouched. An agent already deployed with `source: 'snmp'`
keeps doing exactly what it did, and an agent too old to understand
`snmpTargets` ignores the unknown config key — the backward-compatibility
contract this repo already relies on.

### Why a polled switch is not an `agents` row

It has no token, no WebSocket, no version, no heartbeat and no self-update.
Modelling it as an agent means every fleet-health rollup, every "agents behind"
badge and every licence seat count has to learn to exclude it — and each of
those is a place to get it wrong later. `snmp_devices.agent_id` says **who polls
it**, which is a different fact.

---

## Bridge port is not ifIndex

This is the detail the whole feature rests on, and the one most likely to be got
wrong quietly.

`dot1qTpFdbPort` and `dot1dTpFdbPort` return a **bridge port number** — an index
into `dot1dBasePortTable`, **not** the ifIndex that names an interface. On plenty
of real hardware the two coincide for the first handful of ports and then
diverge, which is *worse* than never matching: it produces an answer that is
right in the lab and wrong in the building.

So the agent walks `dot1dBasePortIfIndex` and resolves the mapping **before**
reporting. Both numbers travel and both are stored:

| | |
|---|---|
| `bridge_port` | what the device said |
| `if_index` / `if_name` | what it resolved to, or **NULL** |

When the resolution fails, the resolved fields are null, the row still records
where it came from, `fdb` is **not** claimed as supported, and the UI says *"the
switch did not name this port"* rather than printing a port number that means
something else.

### The other three things the tables get wrong if nobody looks

**Q-BRIDGE and BRIDGE list the same MAC.** A device implementing both reports
the same address with the same bridge port in each. Reading both doubles every
entry, so the per-VLAN table wins outright when it answers.

**An LLDP id's length cannot tell a MAC from a name.** `"Gi0/24"` is exactly six
bytes — the same as a MAC address. `lldpRemChassisIdSubtype` and
`lldpRemPortIdSubtype` are walked and they decide; the six-byte heuristic is
only the fallback for a device that reports no subtype, and it reads
all-printable bytes as text.

**`self` and port 0 are not devices on ports.** A `self` entry is the switch's
own address; a port-0 entry means "known but not located". Reporting either
sends somebody to a patch panel that does not exist. The agent drops them, and
the server's validator drops them again without taking the agent on trust.

---

## `port_mac_count` is the field that makes a hit an answer

One MAC on a port means an **end device** and a patch panel to walk to.
Forty means an **uplink** and one more hop to go.

It is counted over everything the sweep saw **before** the cap, so a truncated
report still says honestly that a port is crowded. The cap then keeps the
*least* crowded ports, so a core switch's 20 000-entry uplink cannot push out
the access ports a technician is actually looking for.

---

## The credential

An SNMPv2c community is a password in clear text on the wire. That is the
protocol's fault and we cannot fix it. What we refuse to do is keep it readable
in the database or hand it back on a GET:

* AES-256-GCM at rest via `secretBox`, the same treatment `cmdb_config` and
  `integrations` get;
* `SAFE_COLUMNS` in `snmpDevicesRepository` **omits the column entirely**, so an
  API read cannot return it even by accident;
* `listForAgentWithSecret()` is the single exception, named so nobody reaches
  for it absent-mindedly, and it serves exactly one caller: the agent config
  read, for the agent that does the polling;
* a PATCH that **omits** `community` leaves the stored one alone. Otherwise
  every rename would silently break polling.

**SNMPv3 is deliberately not offered.** It needs an auth/priv credential pair
and a key-management story; half-supporting it would be worse than saying so.

### SSRF

`host` is checked against `hostPolicy.denyReason()` **twice** — once on write,
once again before a device is handed to an agent — the same two-check rule the
Service Assurance allowlist follows, because a row written before the deny-list
changed must not keep reaching a target the policy now refuses.

What is refused is deliberately narrow: loopback, link-local (including
`169.254.169.254` cloud metadata), `0.0.0.0/8` and broadcast. **RFC1918 is not
refused** — a switch at `10.14.0.11` is the entire point.

---

## Ownership is the security property

An agent submits results **by device id**. It may only write the devices the
server assigned to **it**.

Without that check, any agent token could rewrite the forwarding table of any
switch in the fleet — which is not merely a data-integrity problem, it is a way
to make a technician walk to the wrong building.

`snmpTopologyIngest` checks every submitted `deviceId` against
`snmp_devices.agent_id` before a single row is written. A mismatch is **counted
and dropped**, not a failed batch: an agent whose assignment changed mid-cycle
is a normal race, not an attack, and the devices it *does* own still store.

---

## The poller

| | |
|---|---|
| Schedule | per device, `interval_sec` (default 300), floored at **60 s** |
| Order | **sequential** — ten simultaneous bridge-table walks out of one host looks like a scan |
| Timeout | 30 s per device |
| Isolation | one switch failing costs that device's turn and nothing else |

The batch carries a **per-device error**, so the dashboard shows
*"sw-lager-1: timeout, last answered 41 minutes ago"* rather than a blank where
four switches used to be. Keeping the **last good time** alongside the error is
the difference between a switch that blipped and one that is gone.

Two deliberate non-behaviours:

* **The 30 s timeout is not `unref`'d**, unlike the long-running timers
  elsewhere in the agent. It exists to *abandon* a hung poll, so it has to keep
  the event loop alive until it fires; an unref'd one lets the loop drain while
  a device that never answers holds the cycle open forever.
* **A failed submit does not hold the results for a retry.** A forwarding table
  is a snapshot of a moment; re-sending a stale one later would claim a device
  is somewhere it has since left.

`POST /api/snmp-devices/:id/poll` (operator+) asks an agent to run a cycle now.
The command goes out correlated (`sendCommandAndWait`, as ping/diagnose do) and
the server waits up to **20 s** for the agent's `command-result`: **200** with
`result: { devices, polled, failed, configRefreshed, deviceAssigned, detail,
error }` when it answers — the dashboard says "Polled 2 devices: 2 answered, 0
did not", or that this device is not assigned to the agent — and **202**
`{ pending: true }` when it has not answered yet (a slow cycle, or an agent
older than the reply): the poll still runs and the table refreshes on the
ingest path. Sent without an id, as it was, the reply was dropped by the socket.

---

## What is stored, and what is not

### `device_interfaces` — the ports, and why the NAME is the identity

Migration 108. One row per port per device, keyed `UNIQUE (device_id, if_name)`.

The agent had been sending this list on every poll since the feature shipped,
and the validator had been accepting it — nothing stored it, so the
ifIndex→ifName table crossed the wire and was thrown away every cycle. It is the
join every per-port measurement needs.

**ifIndex is not the identity, and that is the whole design.** The MIB only
guarantees ifIndex is stable *between re-initialisations of the network
management system*. A reboot may renumber; inserting a module into a chassis
almost always renumbers everything after it. Key a time series on ifIndex and
the 18th's numbers for `Gi1/0/12` sit beside the 19th's for a `Gi1/0/12` that is
now a different physical port — and nothing in the data says so.

So `if_index` is a mutable **attribute** of the row, `if_index_changed_at`
records when it last moved, and `upsertMany()` **reports** the move:

```js
const { upserted, renumbered } = await deviceInterfacesRepo.upsertMany(deviceId, interfaces);
// renumbered: [{ ifName: 'GigabitEthernet1/0/12', from: 10012, to: 10060 }]
```

The poll that notices the move is the poll whose counter delta spans two
different ports, so the caller marks that cycle discontinuous rather than
storing a fabricated number.

**`name_source` says which OID the name came from** — `ifName`, `ifDescr` or
`ifIndex`. Not every switch implements ifName; some only have ifDescr, which is
less stable, and a few name a port with neither. A row built from the weaker one
says so rather than leaving it to be assumed.

The `ifIndex.<n>` fallback is an identity for a row in **this device's own port
list**. It is deliberately kept out of the forwarding table: `fdb.ifName` stays
`null` when the switch did not name the port, because that answer sends somebody
walking to a patch panel, and `ifIndex.7` is not a place.

Retention is **180 days** (`RETENTION_DEVICE_INTERFACE_DAYS`) — the longest of
the SNMP dimensions, because a counter sample points at one of these rows and
purging the row early would strand the measurements that reference it.

### `fdb_entries` — ageing, not history

Rows are upserted on `last_seen` and aged out by retention (**30 days**,
`RETENTION_FDB_DAYS`). There is no history table, because *"where was this MAC
three weeks ago"* is a question a forwarding database cannot honestly answer —
the entry ages out of the **switch** in minutes. What matters for search is
`first_seen`/`last_seen`, so a stale answer is visibly stale rather than
confidently wrong. Same rule `arp_entries` follows.

**VLAN is in the primary key.** Q-BRIDGE learns per VLAN, and the same MAC can
legitimately appear in two (a router sub-interface, a phone on a voice and a
data VLAN). Folding those would silently discard a real observation. Devices
implementing only BRIDGE-MIB report no VLAN; those rows use `vlan 0`, which is
not a real VLAN id and is therefore unambiguous as *"the device did not say"*.

The only history kept is of **moves** (`fdb_mac_moves`, migration 117): one
row per observed move, for the loop detector's window, aged out after two days
(`RETENTION_FDB_MOVE_DAYS`) — see `docs/l2-loop.md`.

### `device_vlans` and `sysDescr` (migrations 116–117)

The VLAN names the agent reads (Q-BRIDGE `dot1qVlanStaticName`) are upserted per
`(device, vlan)` and age out with the forwarding table; a sweep without names
never erases them. The device detail route (`GET /api/snmp-devices/:id`) returns
them as `vlans`. `sysDescr` — what the switch says it is — is optional in the
batch (an older agent does not send it) and stored on `snmp_devices.sys_descr`
with `COALESCE`, so an older agent never erases what a newer one read.

### `snmp_neighbors` — and why it is not `lldp_neighbors`

`lldp_neighbors` (063) keys on `local_agent_id`, which is an **`agents`** id.
These rows belong to an **`snmp_devices`** id. Writing one into the other would
collide with agent ids and attribute a switch's neighbours to whichever agent
shared the number — which does not throw, it just **draws the wrong network**.

So they get their own table, and the merge into the topology graph is left as
its own decision. That decision is genuinely architectural: a switch sees far
more neighbours than an agent host does — every access point and phone — and
folding the two sources together changes what the graph *means*. It deserves its
own change with its own reasoning, not a column reused because it was nearby.

The data is collected and stored now so nothing is lost while that waits, and
`GET /api/snmp-devices/:id` serves it per device.

### CDP, the router ARP table, the hardware and the system group (migrations 124–126)

Three more collect kinds, read by agents from 0.40 on. **New devices get all
three by default**
(`DEFAULT_COLLECT` = `if, fdb, lldp, vlan, cdp, arp, entity`); a device created before keeps its stored list — a row whose `collect`
is `NULL` still means the legacy `if, fdb, lldp, vlan`, so an upgrade never
silently starts walking a router's ARP table. An admin opts an existing device
in with `PATCH /api/snmp-devices/:id { collect: [...] }`. A device that does not
implement one of these MIBs answers with an empty walk, which is "not
supported" in `supported`, never an error. An older agent ignores a kind it does
not know.

* **`cdp`** — CISCO-CDP-MIB `cdpCacheTable`. Stored in `snmp_neighbors` beside
  LLDP with `protocol = 'cdp'`, plus `remote_address` (cdpCacheAddress, decoded
  from its BYTES by cdpCacheAddressType — four bytes of IPv4, sixteen of IPv6)
  and `remote_platform`. `protocol` is part of the unique key, so a Cisco
  neighbour speaking both protocols is two rows that never overwrite each other.
  The consumers treat CDP like LLDP: the topology graph also resolves a
  neighbour by its CDP management address against a polled device's `host`;
  coverage counts an LLDP+CDP pair on one port once and does not flag "no LLDP"
  on a device that answers CDP; the neighbour diff compares **per protocol** —
  a poll whose CDP walk failed while LLDP answered does not announce the CDP
  neighbours as removed (nor as re-added when CDP answers again).
* **`arp`** — IP-MIB `ipNetToPhysicalTable` (IPv4 and IPv6), falling back to
  `ipNetToMediaTable`; invalid/incomplete entries, link-local IPv6 and
  multicast/broadcast addresses dropped. At most **8192 rows per device** (the
  agent bounds the walk too). Stored in `device_arp_entries` — one row per
  `(device, ip)`, a MAC change stamped in `mac_changed_at`, aged out on the
  **same 30-day window as `arp_entries`** (`RETENTION_ARP_DAYS`). It is an
  **identity source**: universal search answers IP↔MAC from it, and the
  new-device detector watches it — "never seen" is scoped to the **device's
  site** (`snmp_devices.location_id`), agents' and routers' tables at the same
  site vouch for each other, and the same baseline guard applies (the router's
  own oldest row must be `NEW_DEVICE_BASELINE_HOURS` old). In a flat OT network
  the router's table is the one that sees every PLC.
* **`entity`** — ENTITY-MIB `entPhysicalTable`: every chassis (≤ 16 — a stack of
  eight is eight serials) and up to 32 modules that name a model or a serial.
  Stored in `device_inventory`, **replaced per poll** (an empty report replaces
  nothing), searchable by serial; the FIRST chassis's model, serial, vendor and
  revisions are also kept on `snmp_devices.hw_*` for lists.

**sysLocation, sysContact, sysObjectID** are read on every poll (a second GET,
so an SNMPv1 device that lacks one never costs the uptime) and kept on
`snmp_devices` with `COALESCE`, like `sys_descr`. **sysLocation is the sub-site
location** — the room or rack the admin typed into the device — and it is shown
beside the site wherever devices are listed: the switch list, every search hit
that names a device (`Plant A · Hal 2, rack A3`), and the coverage report's
device gaps (`subject.where`). The site says which building; sysLocation says
where in it.

A cycle bigger than the server's 1 MiB body limit (a full ARP table beside a
full forwarding table can be) is sent by the agent as several POSTs, split by
device.

---

## The payoff: searching a MAC

Universal search gains one hit type, **`port`** — the only hit that gives a
*physical* address. Everything else on that screen tells a technician **what**
the device is; this tells them **where to walk**.

```json
{
  "type": "port",
  "display_name": "Core switch GigabitEthernet0/2",
  "target": "snmp-device:1",
  "confidence": "exact",
  "source": "fdb_entries (snmp)",
  "last_seen": "2026-09-20T09:41:12.000Z",
  "detail": "VLAN 20 · one MAC on this port — an end device"
}
```

The MAC is normalised through the **same** function the ARP ingest uses
(`identity/arpTable.normalizeMac`), which is what makes five spellings of one
address resolve identically across both identity sources.

Ranking needs no change: hits sort by confidence then freshness, so an exact,
recently-seen port hit lands at the top on its own.

---

## The API

| | |
|---|---|
| `GET /api/snmp-devices` | viewer+ — the inventory, with the polling agent's name |
| `GET /api/snmp-devices/:id` | viewer+ — the device (with `sysLocation`, `sysContact`, `sysObjectId`, `hardware`), `siteName`, its port table, its LLDP/CDP neighbours, its ARP table (`arp`, newest 500, `arpTotal`) and its `inventory`. Every part is best-effort: a failing port table still lets the page open, because the poll state and the error are worth seeing |
| `GET /api/snmp-devices/:id/interfaces` | viewer+ — the PORTS on the device (migration 108), without the forwarding table beside them. 404 for an unknown device rather than an empty list: "this switch has no ports" and "there is no such switch" are different answers |
| `POST /api/snmp-devices` | **admin** — 201, or **409** for a duplicate address+port, or **400** for an address the server must never poll |
| `PATCH /api/snmp-devices/:id` | **admin** |
| `DELETE /api/snmp-devices/:id` | **admin** — 204; the port table and neighbours cascade |
| `POST /api/snmp-devices/:id/poll` | **operator+** — 200 with the agent's result, 202 when it has not answered within 20 s; **409** when the device has no agent or the agent is not connected; 503 without an agent channel |
| `POST /agents/me/snmp-topology` | agent token — 202 with `{ stored, fdbRows, neighbourRows, arpRows, inventoryRows, refused, failuresRecorded, skipped }` |

Reading is viewer+ because a device list is inventory, the same class as the
agent list. **Writing is admin**: adding a device points the server's polling at
an address and stores a credential. "Poll now" is operator+ because it changes
no configuration — it only brings forward work the agent would do anyway.

`POST /agents/me/snmp-topology` requires the `devices` key: the agent's poller
only submits when it has something to say, so it always sends it. Defaulting it
would make a truncated POST look like a successful empty cycle, which is the one
outcome nobody can tell from the outside.

---

## What the UI says that a list of hosts would not

Settings → SNMP devices shows, per device:

* **what it actually answered** — a switch that cannot serve the forwarding
  table shows `fdb ✕`, not an empty column. The same rule
  `connectionTest/checks.js` follows with `available: false`, and the same one
  `snmpMonitor` follows by reporting an absent counter as `null` rather than 0.
  **A device that cannot answer must never look like one that answered "none".**
  `supported` is `NULL` until the device has answered once, and the UI says
  *"not polled yet"* — which is a third state, distinct from both.
* **when it last answered**, not just that it is failing.
