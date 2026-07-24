# Per-flow-pair volume baselines

Extends per-metric anomaly detection to **per-(src_host, dst_host, dst_port)**:
baseline each flow pair's hourly traffic volume and flag deviations. Deviation
only — no threat classification, no "malicious" labelling, no new alerting
channel (the correlator handles findings like any other).

## How it works

1. **Hourly rollup** (`flow_pair_hourly`, append-only): a leader-only hourly job
   rolls up the previous complete hour's TCP volume per tuple, from the same
   `flowsRepository.tcpServiceFlows` + host-resolution path the service-dependency
   job uses. Retained ≥ the baseline window (`FLOW_BASELINE_RETENTION_DAYS`,
   default 21). Because raw `flow_records` is only kept ~7 days, this history
   **builds forward** from deploy — it cannot be backfilled.
2. **Baselines** (`flow_pair_baselines`): robust median + MAD, **day-of-week +
   hour-of-day aware** — Tuesday 14:00 is compared against prior Tuesdays 14:00,
   not a flat mean. Recomputed each run over `FLOW_BASELINE_WINDOW_DAYS` (default
   14), reusing `src/analysis/baselines.js` (`median`/`mad`/`MAD_TO_SIGMA`) — **no
   new statistical code**.
3. **Eligibility gate**: a pair needs at least `FLOW_BASELINE_MIN_OBSERVATIONS`
   (default 100) total hourly buckets before any of its slots are scored. Below
   that, no score.
4. **Scoring + emit**: the current hour's volume is scored against its
   `(dow, hour)` baseline with the same robust z-score the live detector uses
   (`z = (value − median) / (mad · MAD_TO_SIGMA)`). A breach of the analysis
   sigma thresholds (`ANALYSIS_WARN_SIGMA` 3 / `ANALYSIS_CRIT_SIGMA` 4) becomes an
   ordinary finding (`kind: ANOMALY`, `metric: 'flow.volume'`, `hostId` = the
   **source** host; `dst`/`port` carried in the metric label + evidence). The
   finding is saved via `findingStore.save`, so the per-target and cross-agent
   correlators pick it up automatically — nothing calls a correlator directly.

The current observation is **excluded from its own baseline** (baseline is built
from prior history, then the current bucket is appended), so an outlier can't mask
itself.

## API

- `GET /api/topology/flow-baselines?host=<agentId>` (operator+) — the host's
  per-flow-pair baselines. 400 invalid/missing host, 404 unknown host, 500 on DB
  failure.
- `POST /api/topology/flow-baselines/recompute` (operator+) — run the job now.

## Config

| Env var                                | Default | Meaning                              |
| -------------------------------------- | ------- | ------------------------------------ |
| `FLOW_BASELINE_WINDOW_DAYS`            | 14      | baseline window                      |
| `FLOW_BASELINE_MIN_OBSERVATIONS`       | 100     | buckets a pair needs before scoring  |
| `FLOW_BASELINE_RETENTION_DAYS`         | 21      | hourly-rollup retention              |
| `FLOW_BASELINE_JOB_INTERVAL_MINUTES`   | 60      | recompute cadence                    |

Sigma thresholds are shared with the analysis module (`ANALYSIS_WARN_SIGMA`,
`ANALYSIS_CRIT_SIGMA`). Migration 068. See also `docs/service-dependencies.md`.
