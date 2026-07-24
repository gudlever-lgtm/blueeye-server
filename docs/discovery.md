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
(`DISCOVERY_PORTS`, default `22,80,161,443,3389`), reverse DNS for the hostname.
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
| `DISCOVERY_PORTS`            | 22,80,161,443,3389   | TCP connect port list            |
| `DISCOVERY_RATE_LIMIT`       | 50                   | probes/second                    |
| `DISCOVERY_ADDRESS_CAP`      | 65536                | max addresses a scope may cover  |
| `DISCOVERY_INTERVAL_MINUTES` | 360                  | sweep cadence                    |

Migration 069 (`discovered_devices`).
