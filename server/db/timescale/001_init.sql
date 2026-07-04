-- =====================================================================
-- BlueEye telemetry — TimescaleDB schema (migration 001)
--
-- Target:   PostgreSQL 16 + TimescaleDB (on-prem, EU-sovereign).
-- Scope:    the TELEMETRY tables from docs/storage-split-audit.md that move
--           out of MySQL. STATIC tables (inventory, auth, config, compliance,
--           the hash-chained `audit_log`) stay in MySQL and are NOT created
--           here.
--
-- Idempotent: safe to run again. Every statement uses IF NOT EXISTS /
--   if_not_exists => TRUE / CREATE OR REPLACE, so a re-run is a no-op.
--
-- HOW TO RUN (important): run per-statement, NOT in a single transaction.
--   Continuous-aggregate creation (CREATE MATERIALIZED VIEW ... WITH
--   (timescaledb.continuous)) cannot run inside a transaction block, so do
--   NOT pass psql -1 / --single-transaction. Use ON_ERROR_STOP instead:
--
--     psql -v ON_ERROR_STOP=1 -d blueeye_telemetry -f 001_init.sql
--
-- Time column: every hypertable uses `ts TIMESTAMPTZ NOT NULL` as its
--   first-class time dimension. This matches the merged Punkt 3 decision in
--   docs/storage-split-audit.md (`last(payload, ts)`). The MySQL source
--   column mapping is noted per table (e.g. results.created_at -> ts).
--
-- Explicit tuning: chunk_time_interval and every retention window are
--   explicit integers/intervals below — no reliance on TimescaleDB defaults,
--   per the storage-split rules.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- =====================================================================
-- 1. RAW TELEMETRY HYPERTABLES
-- =====================================================================

-- ---------------------------------------------------------------------
-- results  (MySQL `results`; created_at -> ts)
--   HIGH volume, ~1 row/min/agent. High-cardinality on agent_id ->
--   space-partitioned. payload kept as JSONB (was MySQL JSON).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS results (
  agent_id INTEGER      NOT NULL,
  ts       TIMESTAMPTZ  NOT NULL,
  payload  JSONB        NOT NULL
);

-- Space-partition on agent_id (high cardinality): 4 hash partitions.
-- chunk_time_interval = 1 hour (explicit) — matches the Punkt 3 chunk-
-- exclusion window (WHERE ts >= now() - INTERVAL '5 minutes' hits 1 chunk).
SELECT create_hypertable(
  'results', 'ts',
  partitioning_column => 'agent_id',
  number_partitions   => 4,
  chunk_time_interval => INTERVAL '1 hour',
  if_not_exists       => TRUE
);

-- latestPerAgent index (Punkt 3): supports last(payload, ts) per agent_id
-- with time-bounded chunk exclusion. See EXPLAIN block at the end of file.
CREATE INDEX IF NOT EXISTS idx_results_agent_ts ON results (agent_id, ts DESC);

-- ---------------------------------------------------------------------
-- flow_records  (MySQL `flow_records`; ts already present)
--   HIGH volume, many rows/min/agent. Space-partitioned on agent_id.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flow_records (
  agent_id  INTEGER     NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  src_ip    TEXT,
  dst_ip    TEXT,
  ext_ip    TEXT,
  direction TEXT,                    -- 'in' | 'out'
  proto     TEXT,
  src_port  INTEGER,
  dst_port  INTEGER,
  bytes     BIGINT      NOT NULL DEFAULT 0,
  packets   BIGINT      NOT NULL DEFAULT 0,
  flows     INTEGER     NOT NULL DEFAULT 0,
  internal  BOOLEAN     NOT NULL DEFAULT FALSE,
  country   CHAR(2),
  asn       BIGINT,
  asn_name  TEXT
);

SELECT create_hypertable(
  'flow_records', 'ts',
  partitioning_column => 'agent_id',
  number_partitions   => 4,
  chunk_time_interval => INTERVAL '1 hour',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_flows_agent_ts   ON flow_records (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_flows_country_ts ON flow_records (country, ts DESC);
CREATE INDEX IF NOT EXISTS idx_flows_asn_ts     ON flow_records (asn, ts DESC);

-- ---------------------------------------------------------------------
-- probe_results  (MySQL `probe_results`; ts already present)
--   HIGH volume but not extreme; MEDIUM cardinality -> no space partition.
--   90-day retention -> 1-day chunks (~90 chunks steady-state).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS probe_results (
  agent_id         INTEGER     NOT NULL,
  ts               TIMESTAMPTZ NOT NULL,
  type             TEXT        NOT NULL,   -- ping | tcp | dns | traceroute | http
  target           TEXT        NOT NULL,
  ok               BOOLEAN     NOT NULL DEFAULT FALSE,
  rtt_ms           DOUBLE PRECISION,
  min_ms           DOUBLE PRECISION,
  max_ms           DOUBLE PRECISION,
  jitter_ms        DOUBLE PRECISION,
  loss_pct         DOUBLE PRECISION,
  status           SMALLINT,
  cert_expiry_days INTEGER,
  hops             JSONB,
  detail           TEXT
);

SELECT create_hypertable(
  'probe_results', 'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_probe_agent_ts        ON probe_results (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_probe_agent_type_tgt  ON probe_results (agent_id, type, target, ts DESC);

-- ---------------------------------------------------------------------
-- findings  (MySQL `findings`; created_at -> ts)
--   MEDIUM volume, governance-relevant -> NO auto-drop. Identity here is
--   host_id (string), not agent_id — indexed accordingly.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
  id              UUID        NOT NULL,
  host_id         TEXT        NOT NULL,
  metric          TEXT        NOT NULL,
  severity        TEXT        NOT NULL,   -- INFO | WARN | CRIT
  kind            TEXT        NOT NULL,   -- ANOMALY | THRESHOLD | FLATLINE | CORRELATED
  observed        DOUBLE PRECISION,
  baseline        DOUBLE PRECISION,
  deviation       DOUBLE PRECISION,
  window_from     TIMESTAMPTZ,
  window_to       TIMESTAMPTZ,
  explanation     TEXT        NOT NULL,
  evidence        JSONB       NOT NULL,
  correlated_with JSONB,
  acked           BOOLEAN     NOT NULL DEFAULT FALSE,
  ts              TIMESTAMPTZ NOT NULL
);

SELECT create_hypertable(
  'findings', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_findings_host_ts ON findings (host_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_findings_id      ON findings (id);

-- ---------------------------------------------------------------------
-- incidents  (MySQL `incidents`; started_at -> ts)
--   MEDIUM volume, governance-relevant -> NO auto-drop. resolved_at is
--   UPDATEd later; it is a non-partition column so the UPDATE is fine.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
  id               BIGINT      NOT NULL,
  location_id      INTEGER,
  agent_id         INTEGER     NOT NULL,
  metric           TEXT        NOT NULL,   -- reachability | latency | packet_loss
  severity         TEXT        NOT NULL,   -- warning | critical
  ts               TIMESTAMPTZ NOT NULL,   -- started_at
  resolved_at      TIMESTAMPTZ,
  duration_seconds INTEGER,
  affected_target  TEXT        NOT NULL
);

SELECT create_hypertable(
  'incidents', 'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_incidents_agent_ts    ON incidents (agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_location_ts ON incidents (location_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_open        ON incidents (agent_id, metric, affected_target)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------
-- speedtest_results  (MySQL `speedtest_results`; ts already present)
--   LOW volume (on-demand). 90-day retention.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS speedtest_results (
  agent_id   INTEGER     NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  ok         BOOLEAN     NOT NULL DEFAULT FALSE,
  down_mbps  DOUBLE PRECISION,
  up_mbps    DOUBLE PRECISION,
  down_bytes BIGINT,
  up_bytes   BIGINT,
  down_ms    DOUBLE PRECISION,
  up_ms      DOUBLE PRECISION,
  target     TEXT,
  detail     TEXT
);

SELECT create_hypertable(
  'speedtest_results', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_speedtest_agent_ts ON speedtest_results (agent_id, ts DESC);

-- ---------------------------------------------------------------------
-- audit_events  (MySQL `audit_events`; ts already present)
--   Governance-relevant -> NO auto-drop (Punkt 2: no hash chain, safe to
--   move; the hash-chained `audit_log` stays in MySQL).
--
--   APPEND-ONLY here (implementation refinement of Punkt 2): the MySQL table
--   dedups recurring activity onto one row via UNIQUE(dedup_key) + ON
--   DUPLICATE KEY UPDATE occurrences. A TimescaleDB hypertable CANNOT carry a
--   global UNIQUE(dedup_key): unique indexes on a hypertable must include the
--   partition key (ts), so a dedup key cannot be enforced across chunks. The
--   TSDB-native answer is append-only: store each occurrence as its own row
--   and derive occurrences / first_seen / last_seen at query time
--   (GROUP BY dedup_key, min(ts), max(ts), count(*)). This is also strictly
--   MORE faithful to an audit trail (never mutate a past row). See the Punkt 2
--   implementation note in docs/storage-split-audit.md.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  ts                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type         TEXT        NOT NULL,   -- user | agent | system
  actor_id           INTEGER,
  actor_label        TEXT,
  actor_role         TEXT,
  action             TEXT        NOT NULL,   -- dotted key, e.g. 'user.update'
  target_type        TEXT,
  target_id          TEXT,
  target_label       TEXT,
  method             TEXT,
  path               TEXT,
  status             INTEGER,
  ip                 TEXT,
  detail             JSONB,
  repeat_interval_ms BIGINT,
  dedup_key          TEXT                    -- NOT unique here; used for query-time grouping
);

SELECT create_hypertable(
  'audit_events', 'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS idx_audit_ts        ON audit_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_events (actor_type, actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_events (action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_dedup_key ON audit_events (dedup_key, ts DESC);

-- =====================================================================
-- 2. RETENTION POLICIES  (explicit windows; no defaults)
--
--   Raw flow_records, results ......... 30 days
--   probe_results, speedtest_results .. 90 days
--   findings, incidents, audit_events . NO auto-drop (governance)
--
--   Ordering is safe: the continuous-aggregate policies below run hourly and
--   materialize the rollups long before the 30-day raw retention drops the
--   source chunks, so no aggregated history is lost.
-- =====================================================================

SELECT add_retention_policy('results',           INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('flow_records',       INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('probe_results',      INTERVAL '90 days', if_not_exists => TRUE);
SELECT add_retention_policy('speedtest_results',  INTERVAL '90 days', if_not_exists => TRUE);
-- findings / incidents / audit_events: intentionally NO add_retention_policy.

-- =====================================================================
-- 3. CONTINUOUS AGGREGATES  (replace the application-level rollup job)
--
--   flow_rollup  and  metric_rollup  are NO LONGER base tables — they are
--   TimescaleDB continuous aggregates that maintain themselves. The old
--   MySQL rollup tables and the nightly retention/rollup job are retired for
--   the TSDB path.
--
--   MEDIAN caveat: the retired MySQL rollups stored *_median. Exact median is
--   not computable in a plain continuous aggregate (no ordered-set aggregate
--   is allowed). These aggregates keep exact sum/min/max/avg/count instead.
--   If an approximate median is required, install timescaledb_toolkit and add
--   a percentile_agg(...) column (example in README). We deliberately do NOT
--   depend on the toolkit here to keep the migration dependency-light.
--
--   WITH NO DATA: created empty; the policy backfills. Avoids a long blocking
--   materialization at migration time.
-- =====================================================================

-- ---------------------------------------------------------------------
-- flow_rollup  <- flow_records, 1-hour buckets.
--   Mirrors the old rollup grain: (agent_id, direction, country, asn).
--   Only external (geolocated) flows are rolled up (internal = FALSE),
--   matching the old getRawExternalFlowsBatch scope.
-- ---------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS flow_rollup
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', ts) AS bucket,
  agent_id,
  direction,
  country,
  asn,
  max(asn_name)  AS asn_name,
  sum(bytes)     AS bytes,
  sum(packets)   AS packets,
  sum(flows)     AS flow_count,
  min(bytes)     AS bytes_min,
  max(bytes)     AS bytes_max,
  count(*)       AS records
FROM flow_records
WHERE internal = FALSE
GROUP BY bucket, agent_id, direction, country, asn
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'flow_rollup',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE
);

-- ---------------------------------------------------------------------
-- metric_rollup  <- results, 1-hour buckets.
--   The MySQL rollup pivots each result payload into many (metric, value)
--   samples via extractSamples() and stores one row per (agent, metric,
--   bucket). A continuous aggregate is a single GROUP BY and cannot pivot one
--   row into many. The metric set is small and FIXED, so we materialize a
--   WIDE row per (agent, bucket) with one avg/min/max column-group per metric,
--   extracted from the JSONB payload on the SAME paths extractSamples uses:
--     cpu    <- system.cpuPercent
--     mem    <- system.memUsedPercent
--     load1  <- system.loadavg[0]
--     rx_bps <- traffic.totals.rxBytesPerSec
--     tx_bps <- traffic.totals.txBytesPerSec
--   (uptime is a monotonic counter — not aggregated.)
--   Adding a new metric = adding a column-group here (explicit, reviewed).
--   Shape change (long -> wide) is documented in README + the audit doc; the
--   read path (metricRollupRepository) adapts in the repository-split phase.
-- ---------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS metric_rollup
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', ts) AS bucket,
  agent_id,
  count(*) AS samples,
  avg((payload #>> '{system,cpuPercent}')::double precision)            AS cpu_avg,
  min((payload #>> '{system,cpuPercent}')::double precision)            AS cpu_min,
  max((payload #>> '{system,cpuPercent}')::double precision)            AS cpu_max,
  avg((payload #>> '{system,memUsedPercent}')::double precision)        AS mem_avg,
  min((payload #>> '{system,memUsedPercent}')::double precision)        AS mem_min,
  max((payload #>> '{system,memUsedPercent}')::double precision)        AS mem_max,
  avg((payload #>> '{system,loadavg,0}')::double precision)             AS load1_avg,
  min((payload #>> '{system,loadavg,0}')::double precision)             AS load1_min,
  max((payload #>> '{system,loadavg,0}')::double precision)             AS load1_max,
  avg((payload #>> '{traffic,totals,rxBytesPerSec}')::double precision) AS rx_bps_avg,
  max((payload #>> '{traffic,totals,rxBytesPerSec}')::double precision) AS rx_bps_max,
  avg((payload #>> '{traffic,totals,txBytesPerSec}')::double precision) AS tx_bps_avg,
  max((payload #>> '{traffic,totals,txBytesPerSec}')::double precision) AS tx_bps_max
FROM results
GROUP BY bucket, agent_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'metric_rollup',
  start_offset      => INTERVAL '3 hours',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE
);

-- =====================================================================
-- 4. latestPerAgent — chunk-exclusion verification (Punkt 3)
--
-- Replacement for resultsRepository.latestPerAgent (was GROUP BY MAX(id),
-- full-table scan in MySQL). In TimescaleDB, a MANDATORY time bound on ts
-- gives constraint exclusion down to a single chunk:
--
--   SELECT agent_id,
--          last(payload, ts) AS payload,
--          last(ts, ts)      AS last_ts
--   FROM results
--   WHERE ts >= now() - INTERVAL '5 minutes'
--   GROUP BY agent_id;
--
-- Verify on a live instance (cannot be run at migration time):
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT agent_id, last(payload, ts) AS payload, last(ts, ts) AS last_ts
--   FROM results
--   WHERE ts >= now() - INTERVAL '5 minutes'
--   GROUP BY agent_id;
--
--   EXPECT: a Custom Scan (ChunkAppend) whose Append list contains ONE chunk
--           (the current 1-hour chunk). idx_results_agent_ts serves the
--           per-agent last().
--   REJECT: a Seq Scan / Append across ALL chunks — that means the ts filter
--           was dropped. The WHERE on ts is invariant: never run an unbounded
--           GROUP BY on a hypertable.
-- =====================================================================

-- End of migration 001.
