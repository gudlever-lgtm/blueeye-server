# Scheduled active discovery

Finds devices that passive collection (LLDP, sFlow, agents) misses, by actively
probing an **admin-configured CIDR scope**. Results are **candidates** — never
auto-enrolled; an admin must explicitly promote one to a monitored device.

## Guarantees

- **Scope is explicit.** Only addresses inside the configured CIDRs are ever
  probed — no auto-expansion, no scanning outside scope, ever. The scanner
  enforces an in-scope guard on every probe.
- **Refuses to start** when scope is unconfigured/invalid or exceeds the
  address-count cap (`DISCOVERY_ADDRESS_CAP`, default 65536) — checked *before*
  any address is enumerated or probed. The refusal is itself audited.
- **Native Node only** — no `nmap`, no `ping`, no external binary. TCP connect
  (`net.createConnection`) and reverse DNS (`dns.promises`) are the portable
  methods. **ICMP echo** needs a raw socket (CAP_NET_RAW) Node core doesn't
  expose; it's an injectable probe that is **unsupported by default** (liveness
  falls back to TCP connect). A privileged deployment can inject a raw-socket
  implementation without changing the engine.
- **Rate limited** (`DISCOVERY_RATE_LIMIT`, default 50 probes/second).
- **Admin only.** Every endpoint is `requireRole(ADMIN)` — viewer and operator
  get 403.
- **Audited.** Every sweep writes to the hash-chained audit log (category
  `discovery`) with scope, start, end and result count; promotions/ignores are
  audited with the acting admin.

## Methods

ICMP echo (injectable, unsupported by default), TCP connect on a small port list
(`DISCOVERY_PORTS`, default `22,80,102,161,443,502,2404,3389,4840,20000,44818` — the IT basics plus the common OT/ICS ports: S7 102, Modbus 502, IEC-104 2404, OPC UA 4840, DNP3 20000, EtherNet/IP 44818), reverse DNS for the hostname.
A host is a candidate if it answers ICMP or has any open TCP port.

## Promotion

Promoting a candidate (admin) creates a **monitored SNMP device** — a plain
`agents` row with `monitor_config = { source:'snmp', snmp:{ host:<ip> } }` — and
records `promoted_agent_id` + `status='promoted'` on the candidate. Re-observing a
promoted/ignored candidate on a later sweep never resurrects it. This is the ONLY
path from candidate to monitored device; discovery never writes to `agents`.

## API (all admin-only)

- `GET /api/discovery/config` — effective scope/ports/limits (no secrets).
- `GET /api/discovery/candidates?status=` — list candidates + status counts.
- `GET /api/discovery/candidates/:id` — one candidate (404 unknown).
- `POST /api/discovery/scan` — run a sweep now.
- `POST /api/discovery/candidates/:id/promote` — create the SNMP device.
- `POST /api/discovery/candidates/:id/ignore` — hide from future sweeps.

## Config

| Env var                      | Default              | Meaning                          |
| ---------------------------- | -------------------- | -------------------------------- |
| `DISCOVERY_ENABLED`          | false                | enable the scheduled sweep       |
| `DISCOVERY_CIDRS`            | (none)               | comma-separated IPv4 CIDR scope  |
| `DISCOVERY_PORTS`            | 22,80,102,161,443,502,2404,3389,4840,20000,44818 | TCP connect port list            |
| `DISCOVERY_RATE_LIMIT`       | 50                   | probes/second                    |
| `DISCOVERY_ADDRESS_CAP`      | 65536                | max addresses a scope may cover  |
| `DISCOVERY_INTERVAL_MINUTES` | 360                  | sweep cadence                    |

Migration 069 (`discovered_devices`).

Stale candidates (status `discovered` or `ignored`, not seen by any sweep for
`RETENTION_DISCOVERED_DEVICE_DAYS`, default 90) are purged by the retention job.
A **promoted** candidate is never purged. See `docs/retention.md`.

## New-device alarm

A device the network has never shown before raises a finding — the question an
OT operator asks first ("is that laptop / PLC supposed to be there?"). Code:
`src/discovery/newDeviceDetector.js`.

**What counts as new.** Two sources, both watched by wrapping the repository in
`src/server.js` (checked *before* the upsert that would make the device known,
raised *after* it), so every writer is covered:

| Source | Identity | New when |
| --- | --- | --- |
| ARP (`capabilities.arp` report, evidence snapshots → `arp_entries`) | MAC | no agent **at the same site** has ever had this MAC in its ARP table (no site: this agent). A known MAC on a new IP (DHCP) is not new. |
| Discovery (server sweep, or an agent's `run-discovery` → `discovered_devices`) | IP (a sweep sees no MAC) | no candidate row for the IP **and** no agent's ARP table has the IP. |

**No first-snapshot flood.** An agent's first neighbour table is entirely
"never seen before", so nothing is flagged until the agent has a baseline: its
oldest ARP row must be at least `NEW_DEVICE_BASELINE_HOURS` old (default 24).
Discovery follows the same rule on the oldest candidate — the first sweep of a
scope is a baseline. A second guard caps findings at `NEW_DEVICE_MAX_PER_HOUR`
per agent (or per discovery); anything over the cap becomes **one** summary
finding listing the first addresses, never silence and never a flood.

**The finding.** Metric `device.new`, kind `THRESHOLD`, severity
`NEW_DEVICE_SEVERITY` (default `WARN`; severity rules still apply). The
explanation names the IP, MAC, a vendor hint from the MAC prefix
(`src/identity/oui.js`, a curated OUI subset — "unknown" when not listed, and a
locally administered/randomised MAC is called that), the agent, the site and
how old the baseline is. It goes through the same path as every other finding:
stored, published to the dashboard, grouped into an event, dispatched to the
alert channels (when alerting is on) and emitted to ITSM integrations. It is
gated like the other finding producers (analysis enabled + licensed). On
**Changes** it appears as its own row kind, **New device** (`new_device`), not
folded into whatever event the agent has open.

| Env var | Default | Meaning |
| --- | --- | --- |
| `NEW_DEVICE_ALERTS_ENABLED` | true | `false` switches detection off |
| `NEW_DEVICE_BASELINE_HOURS` | 24 | an agent's ARP history (or discovery's) must be this old before anything is flagged |
| `NEW_DEVICE_MAX_PER_HOUR` | 20 | findings per agent (or per discovery) per hour before the summary |
| `NEW_DEVICE_SEVERITY` | WARN | INFO / WARN / CRIT |

Limits worth knowing: an ARP entry ages out after `RETENTION_ARP_DAYS` (30), so
a device away for longer than that is "new" again when it returns; a device
first found by a sweep and later seen in ARP is reported twice (once by IP,
once with its MAC and vendor). Tests: `test/newDeviceDetector.test.js`.
