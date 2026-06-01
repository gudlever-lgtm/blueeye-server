# Retention + rollup

Phase 10. Keeps the on-prem database healthy: raw, full-resolution data is
down-sampled into compact rollups after a window, expired data is purged, and
queries read seamlessly across raw + rollup so long time-ranges still work.

ON by default (`RETENTION_ENABLED`) — DB hygiene is a safe default.

## What it does

- **rollupFlows** — raw `flow_records` older than `rawRetentionDays` are
  aggregated into `flow_rollup` time buckets (`rollupIntervalMinutes`) per
  `(agent, direction, peer country, peer ASN)`: summed bytes/packets/flowCount
  plus min/max/median volume. The raw rows it covered are then deleted.
- **rollupMetrics** — metric samples extracted from result payloads are
  aggregated into `metric_rollup` per `(agent, metric)` bucket (min/max/median +
  sample count); the raw `results` are then deleted.
- **purgeExpired** — deletes `flow_rollup`/`metric_rollup` older than
  `rollupRetentionDays`, and findings older than `findingRetentionDays`. Finding
  purge is conservative: **only acknowledged findings are deleted** —
  unacknowledged findings (including CRIT) are kept regardless of age.

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

`createRetentionScheduler` runs rollup + purge on an interval
(`RETENTION_JOB_INTERVAL_HOURS`, default daily), started in `server.js` and
stopped on shutdown. It mirrors the existing periodic-job pattern (e.g. the
license manager).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `RETENTION_ENABLED` | `true` | Run rollup + purge. |
| `RETENTION_RAW_DAYS` | `7` | How long raw data is kept. |
| `RETENTION_ROLLUP_DAYS` | `90` | How long rollups are kept. |
| `RETENTION_FINDING_DAYS` | `365` | How long (acked) findings are kept. |
| `RETENTION_ROLLUP_INTERVAL_MINUTES` | `60` | Rollup bucket granularity. |
| `RETENTION_JOB_INTERVAL_HOURS` | `24` | How often the job runs. |

## Tests

`src/analysis/retention/__tests__/` (rollup correctness + idempotency, purge
rules incl. "unacked CRIT never deleted", scheduler ordering + re-entrancy) and
`test/flowsCrossRead.test.js` (coherent raw+rollup series).
