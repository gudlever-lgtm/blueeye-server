# L2 path and device location

Two questions a technician asks most, answered from what the switches already
report:

- **"Where is device X plugged in?"** — site, switch, port, VLAN, first/last
  seen, who reported it, and what it is (hostname, vendor from the MAC).
- **"Which switches and ports does traffic from A to B cross?"** — hop by hop,
  each port with its state, speed, VLANs, error/discard rates and load.

Plus one list that answers **"which devices do I have, and where are they?"** —
agents, polled switches, discovery candidates and hosts only an ARP table has
seen, each with its best-known location.

Dashboard: **Diagnostics → Path & location** (`/path-location`,
`public/views/pathLocation.js`). Universal search offers a jump to it for any
IP or MAC hit.

## API

| Route | Role | Answer |
| --- | --- | --- |
| `GET /api/topology/l2-path?from=&to=[&gateway=]` | viewer+ | `{ from, to, gateway, vlans:{from,to,shared}, routed, complete, segments:[{from,to,complete,physicalOnly?,hops}], uncertainties, graph:{switches,links}, sources, generatedAt }` |
| `GET /api/devices/locate?q=` | viewer+ | `{ query, label, hostname, agentId, deviceId, ips, macs:[{mac,vendor,locallyAdministered,sources,lastSeen}], site, location, port, vlanName, firstSeen, lastSeen, reportedBy, alternatives, uncertainties, sources }` |
| `GET /api/devices/inventory?limit=&offset=&kind=&q=` | **operator+** | `{ total, limit, offset, items, counts, capped, partial, sources }` |

An endpoint (`from`, `to`, `gateway`, `q`) is an **IPv4/IPv6 address**, a
**MAC** in any common spelling, a **hostname** (exact, or the short name of an
FQDN — never a substring), or **`agent:<id>`**. It is classified once, in
`src/validation/l2PathValidation.js`.

- **400** a missing or malformed endpoint / inventory parameter (the field is
  named in `details`). The inventory rejects out-of-range values rather than
  clamping them (`limit` 1..200, `offset` 0..100000, `kind` ∈ agent / switch /
  discovered / host, `q` ≤ 64 chars).
- **404** an endpoint nothing on this server has ever seen — no agent, switch,
  ARP, forwarding-table or discovery record. `details` names which one.
- **503** (path only) this install has no switch inventory or forwarding table
  at all. That is not the same thing as "not found".
- **500** the switch list or the forwarding table could not be read. The
  decorations (counters, VLAN names, discovery, LLDP) are best-effort and a
  failure is named in `sources` instead.

**Why the inventory is operator+.** Path and locate answer a question about one
or two endpoints the reader already knows, from the same tables universal
search (viewer+) already reads. The inventory is the same facts for *every*
host at once — a full list of what is plugged in where — which a read-only
account does not need to do its job. The page tells a viewer so rather than
showing an empty table.

## How an endpoint is placed

Code: `src/topology/deviceLocator.js` (I/O) and `src/topology/l2Path.js` (pure).

1. **Identity.** An agent's own report (`capabilities.ips`) and a polled
   switch's address say *who* an IP is. A discovery candidate gives a hostname.
2. **IP → MAC.** The agents' ARP tables (`arp_entries`; an agent's own table
   never holds its own address, so its rows are ignored for itself) and — when
   collected — a **router's ARP table** (`deviceArpRepo`, optional; see below).
   An agent nobody's ARP table knows falls back to its LLDP chassis id, which is
   usually one of its NIC MACs. At most four candidate MACs per endpoint.
3. **MAC → port.** `fdb_entries`. A MAC is learned on its own access port *and*
   on every uplink between it and each reporting switch. The access port is the
   port that **does not face another managed switch** (an LLDP/CDP adjacency
   resolved to a polled switch) with the **fewest MACs** behind it, freshest
   breaking the tie — the rule the coverage report and the agent-offline
   verdict already use. A row with status `self`/`mgmt` is the switch's own
   MAC: the endpoint *is* that switch.

## How the path is walked

The switch graph is the one the topology map draws (`src/topology/graph.js`):
enabled `snmp_devices` as nodes, `snmp_neighbors` rows as edges, the far end
resolved **by MAC** against the switches' own port MACs, then by an **exact,
unambiguous name**, never by anything looser. A **CDP** row is one more
neighbour row: `snmp_neighbors.protocol` (migration 124) rides along on each hop
as `linkProtocols` (a row without it counts as LLDP).
The port on the far side is that switch's own report of the link when it has
one, the neighbour's claim (`remote_port_id`, or the description when the id is
a MAC or a bare number) otherwise.

BFS finds the shortest path between the two access switches (capped at 32
hops). Each hop carries its ingress and egress port — `access`, `uplink`,
`self` or `gap` — with oper/admin status, speed and alias from
`device_interfaces`, the newest `device_counter_samples` row (errors, discards,
utilisation; `null`, never zero, when there is no sample in the last hour), and
the VLANs the endpoints' MACs were learned in on that switch.

## Every uncertainty is said

`uncertainties[]` — each `{ code, severity: info|warn, message, evidence,
endpoint? }`. The message is plain English for API consumers; the dashboard
translates by `code` (`l2p.unc.*`).

| Code | When |
| --- | --- |
| `missingLink` | No managed path joins the two access switches, **and** a switch on each side has the other side's endpoint on a port leading out of the managed graph: *"an unmanaged switch or missing LLDP between X (port P) and Y (port Q)"*. An unmanaged LLDP neighbour reported on either port is named. The hop list carries a `gap` step between the two known halves. |
| `noAdjacency` | No managed path and no such border evidence — the path runs through equipment the server does not poll. Still drawn as a `gap`. |
| `fdbDisagrees` | A switch on the path has an endpoint's MAC on a third port, not the one the neighbour links point to — a stale entry, a loop, or a link LLDP/CDP does not report. |
| `differentVlans` | The endpoints' access VLANs differ: *"traffic is routed; the L2 path ends at the gateway"*. |
| `gatewayUnknown` | Routed, and no gateway could be placed. The one segment returned is marked `physicalOnly` — the switch path between the two access switches, which traffic may leave at the gateway. |
| `gatewayNotFound` | The `gateway=` the caller named is not known. |
| `vlanUnknown` | A switch did not report the VLAN (BRIDGE-MIB only), so whether the two share one is unknown. |
| `noMac` | No ARP table maps the endpoint's address to a MAC. |
| `notInFdb` | The MAC is in no polled switch's forwarding table (not polled, or aged out). |
| `uplinkOnly` | The MAC is only learned on uplinks between managed switches — its own access switch is not polled. |
| `sharedPort` | The access port has ≥ 4 MACs behind it (the coverage report's threshold): an unmanaged switch, AP or hypervisor sits in between. |
| `neighbourOnPort` | The access port reports an LLDP/CDP neighbour the server does not poll. |
| `ambiguousEndpoint` / `ambiguousName` / `ipMultipleMacs` | More than one candidate; the freshest / first is used and the rest are in `alternatives`. |
| `deviceDisabled` | The endpoint is a switch that is disabled in the inventory, so its links are not in the graph. |

## Routed paths and the gateway

When the VLANs differ, the path is split at the gateway when one can be placed:

1. `gateway=<ip|mac|hostname|agent:id>` from the caller, or
2. a **router whose ARP table holds both endpoints' addresses** (`deviceArpRepo`).
   If that router is a polled switch in the graph it is its own location;
   otherwise it is placed by its own port MACs through the forwarding tables.

The answer then has two segments, `from → gateway` and `gateway → to`. A gateway
named by the caller also splits a path whose VLANs are unknown (never one whose
VLANs are known to be shared).

**`deviceArpRepo` is optional and duck-typed.** It is another feature's table
(`device_arp_entries`, router ARP via IP-MIB, migration 125); the path depends
on it only through
`findByIp({ ip, limit })` and `findByMac({ mac, limit })`, each returning
`[{ deviceId, ip, mac, lastSeen }]`, and each may be missing. Without it the
agents' ARP tables are the only IP → MAC source and a routed path's gateway can
only be named by the caller. It is passed as `deviceArpRepo` to `createApp` /
`createApiRouter`.

## Inventory

`buildInventory()` (pure, in `deviceLocator.js`) merges, one row per thing:
agents own their reported IPs; a switch owns its management address; a
discovery candidate or ARP binding that shares an address with either is folded
into it (`sources` lists every source); ARP-only hosts are grouped by MAC;
`ignored` discovery candidates stay out. The best-known location comes from the
up-port MAC table (`fdb_entries.listUpPortMacs`, last 24 h) with the same
access-port rule; a located host takes its switch's site, otherwise the site of
the agent that reported it.

Bounds: ARP bindings from the last 7 days, newest 5000
(`arpEntriesRepository.listRecent`); 20 000 up-port MACs; 2000 discovery
candidates. A read that came back at its cap is flagged in `capped`, and a
source that failed in `sources` with `partial: true`.

## What it does not do

- It does not trace a **routed** path hop by hop (that is traceroute's job —
  Probes → path visualization).
- It does not guess an adjacency LLDP/CDP did not report. A missing link is
  drawn as a gap with its evidence, never bridged.
- It does not invent a room or rack: `sysLocation` (migration 126) is shown
  on each hop and location exactly as the switch reports it, and is `null`
  where the switch says nothing (or an older agent has not sent it yet).
