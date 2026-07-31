# Outages & NIS2 reporting

> This is the **probe-outage** table (`probe_outages`, migration 025 — renamed
> from `incidents` in migration 077). For the separate **first-class event
> entity** that groups analysis findings (`event_cases`, `/api/events`), see
> **[event-cases.md](event-cases.md)**.

Derives **outages** from active-probe results (`probe_results`) and exposes
availability / outage / NIS2-draft reports. Single-tenant, on-prem, local +
explainable — every decision is a plain comparison against an auditable
threshold, no statistics or hidden state.

## Data model

- **`probe_thresholds`** (migration 023) — per-metric cut-offs.
  `location_id = NULL` is the **global default**; a concrete `location_id` is a
  **per-location override**. Unique on `(location_id, metric)`. Lookup: the
  location-specific row wins, else fall back to the global.
  - `metric` ∈ `reachability | latency | packet_loss`
  - `warning_value` / `critical_value` — interpreted per metric:
    - **reachability** — a failed probe (`ok = 0`) is always *critical*; the
      value columns are unused (NULL).
    - **latency** — `rtt_ms >= warning_value` ⇒ warning, `>= critical_value` ⇒
      critical (ms).
    - **packet_loss** — `loss_pct >= warning_value` ⇒ warning, `>= critical_value`
      ⇒ critical (%).
  - `debounce_count` — consecutive failing results required before an outage
    opens (default **3**), to ride out blips.
  - Seeded global defaults: reachability critical on failure; latency
    warn 150 ms / crit 300 ms; packet_loss warn 2% / crit 5%; debounce 3.

- **`probe_outages`** (migration 025) — one row per `(agent, metric, target)` outage.
  - `started_at` = timestamp of the **first** failing result in the breaching
    sequence (not the one that crossed the debounce count).
  - `resolved_at` = NULL while active; set when a result returns under threshold.
  - `duration_seconds` = NULL until resolved (computed in SQL from `started_at`).
  - At most **one active** outage per `(agent, metric, affected_target)`.

The metrics map directly onto `probe_results`: `ok` → reachability,
`rtt_ms` → latency, `loss_pct` → packet_loss, `target` → `affected_target`. A
probe row's location is its agent's `location_id`.

## Derivation

`src/probeOutages/detection.js` is pure and unit-tested directly:

- `evaluateRow(row, metric, threshold)` → `fail` (with severity) / `pass` /
  `skip`. A missing reading (e.g. no `rtt_ms` because the probe timed out) is
  **skip** — neutral, so a down host never spuriously resolves a latency/loss
  outage.
- `deriveSequenceState(rows, metric, threshold)` replays a chronological
  `(metric, target)` sequence and returns the desired end state: open (with
  `startedAt` = first failure of the current run + max severity seen) or not
  (with `lastRecoveryAt`).

`src/probeOutages/probeOutageService.js` runs **on probe-results ingest**
(`POST /agents/probe-results`, alongside the probe-findings pipeline,
best-effort — it never breaks ingestion). For each `(metric, target)` group of
the agent's recent rows it loads the effective threshold, derives the desired
state, and reconciles against stored outages:

- **open** a new outage when the run breaches debounce and none is active;
- **escalate** an active outage's severity when the run crosses into a higher
  tier (e.g. warning → critical) — never a duplicate, never a downgrade;
- **resolve** an active outage on recovery. The recovery timestamp is the
  fail→recover transition the window saw, or — when the failing run has scrolled
  out of the lookback and only healthy rows remain — the first healthy sample, so
  an outage never lingers active after the outage ages out of the window.

## Endpoints

All under the existing user-JWT auth.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/api/reports/availability?from=&to=&location_id=` | viewer+ | uptime % per location/agent from probe reachability |
| GET | `/api/reports/probe-outages?from=&to=&severity=&location_id=` | viewer+ | probe outages overlapping the period (timestamps + duration) |
| GET | `/api/reports/nis2-draft/:probe_outage_id` | operator+ | one probe outage as an English CFCS notification draft (the draft text says "incident" — the directive's word) |
| GET | `/api/thresholds` | viewer+ | global defaults |
| PUT | `/api/thresholds` | admin | upsert a global default (one metric) |
| GET | `/api/thresholds/:location_id` | viewer+ | effective per-metric thresholds for a location |
| PUT | `/api/thresholds/:location_id` | admin | upsert a location override (one metric) |

`from`/`to` are required, must be parseable, and `from < to` (else 400). Unknown
`location_id` / `incident_id` → 404. The NIS2 draft is an **English-only,
hardcoded** template (`src/probeOutages/nis2.js`): detection time (UTC ISO-8601),
duration, affected location/target, severity, and current status.
