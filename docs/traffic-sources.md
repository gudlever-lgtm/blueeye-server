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
- Destinations aggregation: `src/repositories/flowsRepository.js`
  (`aggregateExternalDestinations`).
