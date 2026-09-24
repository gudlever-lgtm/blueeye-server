# Retention + rollup

Phase 10. Keeps the on-prem database healthy: raw, full-resolution data is
down-sampled into compact rollups after a window, expired data is purged, and
queries read seamlessly across raw + rollup so long time-ranges still work.

ON by default (`RETENTION_ENABLED`) — DB hygiene is a safe default.

> **Runtime-editable:** an admin can change `enabled` and the retention windows
> (`rawRetentionDays`, `rollupRetentionDays`, `findingRetentionDays`) under
> **Settings → Retention** (`PUT /api/settings/retention`). Overrides are
> stored in `app_settings`, applied to the live config, and re-applied at boot;
> the scheduler/purge read them on each run, so changes take effect on the next
> cleanup without a restart. The rollup **cadence** (`rollupIntervalMinutes`,
> scheduler interval) stays env-only.

## What it does

- **rollupFlows** — raw `flow_records` older than `rawRetentionDays` are
  aggregated into `flow_rollup` time buckets (`rollupIntervalMinutes`) per
  `(agent, direction, peer country, peer ASN)`: summed bytes/packets/flowCount
  plus min/max/median volume. **Internal** (RFC1918↔RFC1918, LAN/OT) flows —
  which have no country/ASN and so never reached `flow_rollup` — are aggregated
  into `flow_internal_rollup` (migration 119) per `(agent, src_ip, dst_ip,
  proto, service_port)`, the service port being the server end of the
  conversation (a named well-known port on either side, else the lower port),
  so a PLC's reply lands on the same `502` row as the SCADA poll. Bounded: per
  agent per bucket only the top `RETENTION_INTERNAL_ROLLUP_TOP_N` (500) keys by
  bytes are kept; the rest fold into one overflow row (`src_ip = dst_ip = '*'`,
  `service_port = 0`), so totals still add up and a port scan cannot grow the
  table. The raw rows before the cutoff are then deleted — always, even when
  nothing was geolocated (it used to skip the delete then, so a LAN-only site
  never purged `flow_records`).
- **rollupMetrics** — metric samples extracted from result payloads are
  aggregated into `metric_rollup` per `(agent, metric)` bucket (min/max/median +
  sample count); the raw `results` are then deleted.
- **purgeExpired** — deletes `flow_rollup`/`metric_rollup`/`flow_internal_rollup`
  older than `rollupRetentionDays`, and findings older than
  `findingRetentionDays`. Finding purge is conservative: **only acknowledged
  findings are deleted** — unacknowledged findings (including CRIT) are kept
  regardless of age. It also ages out each table below on its own window
  (0 = keep forever):

  | Table | Column | Default | Why that long |
  | --- | --- | --- | --- |
  | `probe_results` | `ts` | 400 d | the availability/outage reports accept ranges up to 366 days and compute uptime from these rows |
  | `probe_outages` (**closed only**) | `resolved_at` | 400 d | same reports; an open outage is a current condition and is never purged |
  | `speedtest_results` | `ts` | 365 d | "is the line slower than last year" |
  | `transaction_results` | `time` | 90 d | the trend endpoint serves up to 90 days |
  | `topology_changes` | `detected_at` | 180 d | quoted in investigations, like config snapshots |
  | `discovered_devices` (`discovered`/`ignored` only) | `last_seen` | 90 d | a **promoted** candidate is never purged |
  | `host_connections` | `last_seen` | 30 d | only an agent that stopped reporting leaves rows (a live one replaces its own) |
  | `audit_events` | `last_seen_at` | 365 d | the User Logs record; a recurring row still being bumped is kept |

  **`audit_log` is never purged.** It is the hash-chained, tamper-evident
  compliance trail (`verifyChain()`, see `docs/audit-vs-logging.md`); deleting
  its oldest rows would break the chain. `audit_events` is a separate,
  un-chained table, which is why it can age out.

> **Why the Analysis page does not slow down as findings pile up.** It reads
> `?open=1` by default — only what nobody has accepted — through
> `idx_findings_open` (migration 114). Accepted findings stay in the table for
> the retention window above and still appear under "Open + accepted", but they
> are no longer scanned on every load. Before that, four `GROUP BY` passes read
> every row on every visit, so a long-running server got slower and accepting
> findings could not help.


## Idempotency

Rollup deletes the raw rows it aggregates, so a repeated run finds nothing to
aggregate and double-counts nothing. The rollup tables also carry a unique key
per bucket and use `ON DUPLICATE KEY UPDATE` (summing) as a belt-and-braces
merge. The scheduler additionally guards against overlapping runs.

## Cross-reading raw + rollup

`flowsRepository` reads **both** tables for the geo overview and selection
queries (`aggregateExternalDestinations`, `destinationExists`,
`agentIdsForDestination`, `selectFlows`). So a 30-day view returns a coherent
series even though raw data only goes back `rawRetentionDays` — recent buckets
come from `flow_records`, older ones from `flow_rollup`. (Protocol breakdown is
raw-only, since rollups don't retain per-protocol detail.)

## Scheduler

`createRetentionScheduler` runs rollup + purge once shortly after boot
(`RETENTION_STARTUP_DELAY_SECONDS`, default 120) and then on an interval
(`RETENTION_JOB_INTERVAL_HOURS`, default daily); started in `server.js` and
stopped on shutdown. The boot run matters: with only the interval, a server
restarted more often than daily (a deploy a day) never ran retention at all.
Both timers are unref'd, a failed run is logged and never escapes the timer,
and the re-entrancy guard still skips a run while one is in progress.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `RETENTION_ENABLED` | `true` | Run rollup + purge. |
| `RETENTION_RAW_DAYS` | `7` | How long raw data is kept. |
| `RETENTION_ROLLUP_DAYS` | `90` | How long rollups are kept. |
| `RETENTION_FINDING_DAYS` | `365` | How long (acked) findings are kept. |
| `RETENTION_ROLLUP_INTERVAL_MINUTES` | `60` | Rollup bucket granularity. |
| `RETENTION_JOB_INTERVAL_HOURS` | `24` | How often the job runs. |
| `RETENTION_STARTUP_DELAY_SECONDS` | `120` | First run after boot. |
| `RETENTION_INTERNAL_ROLLUP_TOP_N` | `500` | Internal-flow rollup rows per agent per bucket before the overflow row. |
| `RETENTION_PROBE_RESULT_DAYS` | `400` | `probe_results`. |
| `RETENTION_PROBE_OUTAGE_DAYS` | `400` | Closed `probe_outages`. |
| `RETENTION_SPEEDTEST_DAYS` | `365` | `speedtest_results`. |
| `RETENTION_TRANSACTION_RESULT_DAYS` | `90` | `transaction_results`. |
| `RETENTION_TRANSACTION_CAPTURE_DAYS` | `7` | `transaction_captures` — **the shortest window here, deliberately.** A capture is the most detailed thing the product stores (packet headers of one test run), and it stops being evidence long before it stops being detailed. A week covers the fault somebody is still investigating; after that the result row keeps the verdict, which is what gets quoted anyway. See [transaction-capture.md](transaction-capture.md). |
| `RETENTION_TOPOLOGY_CHANGE_DAYS` | `180` | `topology_changes`. |
| `RETENTION_DISCOVERED_DEVICE_DAYS` | `90` | Unpromoted `discovered_devices`. |
| `RETENTION_HOST_CONNECTION_DAYS` | `30` | `host_connections`. |
| `RETENTION_AUDIT_EVENT_DAYS` | `365` | `audit_events` (0 = forever). Never `audit_log`. |

The other windows (config snapshots, ARP, FDB, device events, interface
counters/inventory/transitions, burst runs) are documented beside their
features and in `src/analysis/retention/config.js`. Migration 120 adds the
timestamp indexes `speedtest_results` and `transaction_results` lacked; the
other purged columns were already indexed.

## Tests

`src/analysis/retention/__tests__/` (rollup correctness + idempotency incl. the
bounded internal rollup, purge rules incl. "unacked CRIT never deleted" and the
per-table windows, scheduler ordering + re-entrancy + the boot run, config
defaults pinned to the report range), `test/retentionRepo.test.js` (which rows
each purge may touch: never a promoted candidate, an open outage or
`audit_log`) and `test/flowsCrossRead.test.js` (coherent raw+rollup series).
