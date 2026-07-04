# BlueEye telemetry — TimescaleDB schema

This directory holds the schema for the **telemetry layer** that moves out of
MySQL per [`docs/storage-split-audit.md`](../../../docs/storage-split-audit.md).
Only the tables classified **TELEMETRY** in that audit live here; everything
classified **STATIC** (inventory, auth, config, compliance, the hash-chained
`audit_log`) stays in MySQL and is not touched by these migrations.

- **Target:** PostgreSQL 16 + TimescaleDB, on-prem, EU-sovereign. No US cloud.
- **Deploy:** the node is provisioned by [`deploy/install-timescale.sh`](../../../deploy/install-timescale.sh);
  see [`deploy/README-timescale.md`](../../../deploy/README-timescale.md).

## What's in `001_init.sql`

| Object | Kind | Time col | Chunk | Retention |
|---|---|---|---|---|
| `results` | hypertable (space-part. agent_id×4) | `ts` | 1 hour | 30 days |
| `flow_records` | hypertable (space-part. agent_id×4) | `ts` | 1 hour | 30 days |
| `probe_results` | hypertable | `ts` | 1 day | 90 days |
| `speedtest_results` | hypertable | `ts` | 7 days | 90 days |
| `findings` | hypertable | `ts` | 7 days | none (governance) |
| `incidents` | hypertable | `ts` | 30 days | none (governance) |
| `audit_events` | hypertable (append-only) | `ts` | 7 days | none (governance) |
| `flow_rollup` | continuous aggregate ← `flow_records` | `bucket` | 1 h buckets | — |
| `metric_rollup` | continuous aggregate ← `results` | `bucket` | 1 h buckets | — |

The old MySQL `flow_rollup` / `metric_rollup` base tables and the nightly
rollup job are **retired** on the TSDB path — continuous aggregates maintain
themselves via `add_continuous_aggregate_policy` (hourly).

## Running the migration

Run it **per-statement, not in a single transaction** — a continuous
aggregate cannot be created inside a transaction block, so do **not** use
`psql -1` / `--single-transaction`:

```bash
psql -v ON_ERROR_STOP=1 \
     -h 192.168.1.140 -U blueeye_tsdb -d blueeye_telemetry \
     -f server/db/timescale/001_init.sql
```

The file is **idempotent** (`IF NOT EXISTS` / `if_not_exists => TRUE` /
`CREATE OR REPLACE`). Re-running it is a no-op — use it as the forward
migration on schema changes too.

### Verify after running

```sql
-- extension active
SELECT extname, extversion FROM pg_extension WHERE extname = 'timescaledb';

-- hypertables exist (expect 7)
SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1;

-- retention policies registered (expect 4: results, flow_records,
-- probe_results, speedtest_results)
SELECT hypertable_name, config
FROM   timescaledb_information.jobs
WHERE  proc_name = 'policy_retention';

-- continuous aggregates (expect flow_rollup, metric_rollup)
SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1;
```

### Verify `latestPerAgent` chunk-exclusion (Punkt 3)

Against a live instance with data:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT agent_id, last(payload, ts) AS payload, last(ts, ts) AS last_ts
FROM results
WHERE ts >= now() - INTERVAL '5 minutes'
GROUP BY agent_id;
```

Expect a `Custom Scan (ChunkAppend)` with **one** chunk in the Append list.
A `Seq Scan` across all chunks means the mandatory `ts` filter was dropped.

## Rollback

There is no data-preserving down-migration — the migration only **adds**
objects and never mutates MySQL. To fully undo on the telemetry node:

```sql
-- continuous aggregates first (they depend on the base hypertables)
DROP MATERIALIZED VIEW IF EXISTS metric_rollup;
DROP MATERIALIZED VIEW IF EXISTS flow_rollup;

DROP TABLE IF EXISTS results, flow_records, probe_results, speedtest_results,
                     findings, incidents, audit_events CASCADE;
```

Retention and continuous-aggregate **policies** are dropped automatically with
their hypertable / view. Because BlueEye keeps writing telemetry to MySQL until
the repository-split phase lands, dropping these objects loses only data that
was mirrored into the TSDB — MySQL remains the source of truth during rollout.

## Notes / deliberate deviations from the audit

- **`ts` (not `time`) time column.** The merged Punkt 3 query is
  `last(payload, ts)`; the schema keeps `ts` so that query works verbatim.
  MySQL source columns map as: `results.created_at → ts`,
  `findings.created_at → ts`, `incidents.started_at → ts`; the rest already
  use `ts`.
- **`audit_events` is append-only.** A hypertable can't enforce a global
  `UNIQUE(dedup_key)` (unique indexes must include the partition key `ts`), so
  the MySQL dedup-onto-one-row semantics are replaced by append-only storage +
  query-time aggregation (`GROUP BY dedup_key, min(ts), max(ts), count(*)`).
  This refines — does not reverse — the Punkt 2 placement decision. Details in
  the audit doc's Punkt 2 implementation note.
- **No exact median in the rollups.** Continuous aggregates can't compute an
  exact median, so `flow_rollup` / `metric_rollup` keep sum/min/max/avg/count.
  For an approximate median, install `timescaledb_toolkit` and add e.g.
  `percentile_agg(bytes) AS bytes_pct` to `flow_rollup`, then read it with
  `approx_percentile(0.5, bytes_pct)`. We keep the toolkit **out** of the base
  migration to stay dependency-light.
- **`metric_rollup` is wide, not long.** See the header comment in
  `001_init.sql`; adding a metric means adding a column-group (a reviewed
  schema change), which is the safe trade for a self-maintaining aggregate.
