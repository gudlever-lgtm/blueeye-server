# Traffic sources (where flow data comes from)

Each agent measures traffic with **one** source, chosen per agent in the
dashboard (**Agents → Edit → Traffic source**) and pushed to the agent as its
`monitor_config`. The source decides what kind of data the agent can report —
and, crucially, whether the **Destinations** map and **Flows** view can show
anything at all.

| Source | What it reports | Powers Destinations/Flows? |
|--------|-----------------|----------------------------|
| `proc` (default) | per-interface **byte-rates** from `/proc/net/dev` | **No** — no src/dst addresses |
| `snmp` | per-interface byte-rates polled over SNMP | **No** — no src/dst addresses |
| `netflow` | NetFlow v5/v9/IPFIX **flow records** (5-tuple) | **Yes** |
| `sflow` | sFlow v5 **sampled flow records** (5-tuple) | **Yes** |

> The default `proc` source has **no src/dst**, so a brand-new agent shows an
> empty Destinations map. That is expected, not a bug — switch the agent to a
> flow source (`netflow`/`sflow`) to get per-flow data.

## The Destinations map needs the whole chain

A circle on the Destinations map requires **every** link below; any one missing
leaves it empty:

1. The agent's source is `netflow` or `sflow` (not `proc`/`snmp`).
2. Something actually **exports flows** to the agent's collector
   (NetFlow → UDP 2055, sFlow → UDP 6343).
3. Server flow ingest is enabled (`config.geo.enabled`).
4. An EU **GeoIP** database is present — external IPs need a *country*, since the
   map aggregates by country/ASN (`flowsRepository.sumByDest` filters
   `country IS NOT NULL`).
5. The **`geo`** license feature is enabled (the `/api/geo` endpoints are gated).

The **Flows** tab is the better "is data arriving?" test: it shows raw
conversations and needs only links 1–3 (no GeoIP, no `geo` feature).

## VLAN and switch ports on a flow

A flow record from a current agent also says **which VLAN** it was on and **which
ports of the exporting switch** it entered and left by — `flow_records.vlan`,
`in_if`, `out_if` (migration 127):

| Exporter | VLAN | in / out port |
|---|---|---|
| sFlow v5 | the 802.1Q tag in the sampled frame (the outer tag of a QinQ pair); when the port stripped it, the switch's *extended switch* record (1001) | the flow sample header's input/output ifIndex (format 0 only — a discard reason or a "several ports" count is not a port) |
| NetFlow v9 / IPFIX | IE 243 `dot1qVlanId`, else IE 58 `vlanId` | IE 10 / IE 14 (`ingressInterface` / `egressInterface`) |
| NetFlow v5 | — | — |

The agent aggregates per (src, dst, dst port, protocol, **VLAN**): the same
pair on two VLANs is two conversations. The ports are not part of the key (a
conversation can enter by two LAG members); the first one seen is kept. All
three are NULL when the exporter did not say — never "VLAN 1" or "port 0".
The sampled frame's MAC addresses are decoded on the agent too (metadata, like
the 5-tuple) but not stored.

## sFlow interface counters (errors and duplex without SNMP)

An sFlow switch also pushes **counter samples** — its own generic interface
counters and Ethernet error counters — every polling interval, unasked. The
agent decodes them (generic format 1, Ethernet format 2) and sends the latest
reading per (exporter, ifIndex) as `traffic.sflowCounters` (see the agent's
`PROTOCOL.md` for the wire format). The server
(`src/devices/sflowCounterIngest.js`) turns them into **the same
`device_counter_samples` rows an SNMP counter poll writes**, through the same
`counterDelta` arithmetic, the same analysis pipeline and the same
duplex-mismatch finding (sFlow `ifDirection` 1/2 → full/half duplex; FCS,
alignment, late-collision and carrier-sense counters from the Ethernet record).

- **Only for registered devices.** The exporter's source address must be an
  SNMP device's `host` (an IP literal; IPv6 is compared in its compressed
  form). A device registered by **hostname** does not match. An exporter that
  matches nothing is recorded in `sflow_exporters` (migration 128) and shown in
  **Coverage gaps** as *sFlow exporter not registered as a device*. A newer
  agent also sends `traffic.sflowExporters` — every exporter address heard
  that interval, from flow OR counter samples, at most 256 — so a switch that
  sends only flow samples is recorded too (with no port count; a flow-only
  sighting never overwrites the count its counter samples recorded). Entries
  that are not IP literals are dropped, never a reason to refuse the report.
- **SNMP wins.** A device that is polled for SNMP counters (an assigned agent,
  `ifcounters` in collect, a counter interval) is left to the poll — two
  sources interleaving one series would compute every rate across two clocks.
- **Ports the inventory lacks** get a minimal `device_interfaces` row named
  `ifIndex N` (`name_source = 'ifIndex'`): an sFlow-only switch has no topology
  poll to create them. Once SNMP inventories the port under its real name, the
  real row wins the ifIndex lookup, and the topology upsert **retires** the
  placeholder: its `if_index` is cleared (and `if_index_changed_at` stamped)
  but the row is kept, because `device_counter_samples` has no foreign key and
  deleting it would leave its samples attributable to nothing. Retention
  removes it once it has not been seen for the window. At most 1 024 active
  placeholders per device.
- **Reboots** are detected from the exporter's uptime in the datagram header.
  It is a 32-bit millisecond counter, so it wraps every 49.7 days, which reads
  as one reboot (one row of null rates).
- **The same reading twice** (an exporter sending to two agents, a resubmitted
  report) is dropped, not stored as a second sample.
- **Bounded.** A result is capped at 64 KB, so the agent sends at most 1 024
  interfaces and ~24 KB of counters per report, less when the flow summary is
  large; the rest are sent on the following reports, longest-unsent first.
  `sflowCounters` and `sflowExporters` are **not** kept in the stored
  `results` row (nor its TSDB mirror): they already live in
  `device_counter_samples` and `sflow_exporters`, and every pipeline reads them
  from the report as it arrives.

## sFlow on a host with no switch: hsflowd

A plain Linux host emits no sFlow about its own traffic — the agent's collector
listens on 6343 but nothing sends to it. **hsflowd** (the Host sFlow daemon)
fills that gap: it samples the host and exports sFlow to `127.0.0.1:6343`,
straight into the agent's collector.

- **Native (systemd/unmanaged) agents** self-provision hsflowd when their sflow
  `monitor_config` includes an `hsflowd` block — set it via the agent edit modal
  (the "Local hsflowd exporter" option). Shape:

  ```json
  { "source": "sflow",
    "sflow": { "port": 6343, "hsflowd": { "samplingRate": 256, "device": "eth0" } } }
  ```

  hsflowd isn't in the Debian/Ubuntu archives, so the agent **builds it from
  source** (build deps `git build-essential clang libpcap-dev` → clone
  `sflow/host-sflow` → `make FEATURES="PCAP"` → `… install` → `… schedule`),
  writes `/etc/hsflowd.conf`, starts the service, and reports the actual state
  (`active` / `install_failed` / `permission_denied` / …). `PCAP` is the
  packet-sampling module — the only one needed; `HOST` would pull in
  KVM/OVS/libvirt.

  When hsflowd is the only exporter, also set the collector **bind address** to
  `127.0.0.1` ("Collector bind address" in the edit modal, or
  `"sflow": { "bindAddress": "127.0.0.1" }`) so the agent's UDP collector is
  not reachable from the LAN. `bindAddress` (an IP literal) is accepted for
  both `netflow` and `sflow`; blank means all interfaces (`0.0.0.0`). Requires
  agent ≥ 0.9.x (older agents ignore it).

- **Docker agents** can't install hsflowd onto the host, so they run the
  **hsflowd sidecar** instead (see the agent repo:
  `docker-compose.hsflowd.yml` / `ENABLE_HSFLOWD=1 ./install.sh`).

Confirm sFlow is actually arriving on the host:

```bash
sudo tcpdump -ni any udp port 6343   # packets = inbound sFlow; silence = nothing exporting
```

## Where to change things

- Source selection + validation: `src/validation/agentValidation.js`
  (`validateMonitorConfig`), edit modal in `public/app.js` (`editAgent`).
- The config the agent fetches: `GET /agents/me/config` (`src/routes/agentReports.js`).
- Flow ingest/enrichment/storage: `src/geo/flowPipeline.js`, `src/geo/enricher.js`.
- sFlow counter samples → device counter series: `src/devices/sflowCounterIngest.js`
  (exporters heard: `src/repositories/sflowExportersRepository.js`).
- Destinations aggregation: `src/repositories/flowsRepository.js`
  (`aggregateExternalDestinations`).
