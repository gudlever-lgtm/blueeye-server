# Incidents (`incident_cases`) — grouped anomalies, tracked end-to-end

> **Not to be confused with `docs/incidents.md`.** That describes the older
> *probe-outage* `incidents` table (migration 025) surfaced via `/api/reports`.
> This document is the **first-class incident entity** (`incident_cases`,
> migration 047) that wraps analysis **findings** (the system's "anomalies"). The
> two are independent; the probe-outage table is untouched.

## What it is

An `incident_case` groups the analysis findings that fire close together on the
same **device** into one case you can track from `open` to `closed`, with a
timeline, the device-config change suspected to have triggered it, similar past
incidents, and an opt-in AI assistant. A "device" is an agent — findings key on
`host_id`, which the ingest path sets to the agent id, so `incident_cases.host_id`
== the agent id throughout.

There is **no `anomalies` table** (anomalies live in `findings`) and **no playbook
subsystem** in this codebase; playbook-related fields are surfaced as `null`.

## Data model

| Migration | Object | Notes |
| --- | --- | --- |
| 047 | `incident_cases` | `status` (open/investigating/resolved/closed), `severity` (INFO/WARN/CRIT, inherited from the worst linked finding), auto-generated `title`, `primary_finding_id`→`findings`, `config_change_id`→`config_snapshots`, `first/last_event_at`, `resolved_at`, `created_by` (system/manual), `closed_by`→`users` |
| 048 | `findings.incident_case_id` | nullable FK, `ON DELETE SET NULL` — the grouping link |
| 049 | `config_snapshots` | raw device config: `device_id`→`agents`, `config_text`, `captured_at`, `captured_via` (manual/agent_poll/change_detected) |
| 050 | `incident_cases.config_change_id` | nullable FK→`config_snapshots` — the suspected trigger |

## Auto-creation & grouping

`src/incidentCases/incidentCaseService.js` runs after a finding is produced (wired
into both analysis pipelines in `src/server.js`). A new finding on the same device
within the correlator window (60s) of an open incident's last activity is grouped
into it (severity escalated, `last_event_at` advanced); otherwise a new incident is
opened (`status=open`, `created_by=system`). Best-effort — never blocks ingestion.

## State machine

`src/incidentCases/stateMachine.js` (pure): `open → investigating → resolved →
closed`, plus `closed → open` (reopen, **requires a comment**, stored in the audit
trail). Any other transition is rejected with 409. `autoResolveJob.js` is a
leader-only job that resolves incidents stuck in `investigating` once no new anomaly
has linked within the inactivity window (audited, actor `system`).

## Device config: snapshots, diff, risk, correlation

- **Snapshots** (`config_snapshots`) are raw captures. There is a **manual producer**
  today — `POST /api/devices/:id/config-snapshots` (operator/admin); `agent_poll` /
  `change_detected` are reserved for later agent-side work. Identical re-posts are
  de-duplicated.
- **Diff** — `src/config/diff.js` (built on the `diff` library).
- **Risk** — `src/config/risk.js`, rule-based (not ML): ACL / routing / interface /
  VLAN / NAT / crypto / AAA = **high**; comments / descriptions / banners = **low**;
  else **medium**.
- **Correlation** — when a new anomaly arrives, the most recent config change on the
  device within a configurable window before it (default **30 min**) is linked as
  `config_change_id` (first correlated change wins).
- **Masking** — `src/config/mask.js`. The store keeps **raw** config; everything is
  **masked on read** (IP literals → `[host]`, secret-bearing lines redacted). Raw
  `config_text` is never returned by the API and never sent to the AI provider.

## Similarity search

`src/incidentCases/similarity.js` (pure, weighted, not ML): scores past
resolved/closed incidents by **device** (3) / **device-type** (1, agent `platform`
as the only proxy — there is no role/type field) / **anomaly-type** (2, primary
finding metric) / **config-change-type** (1, same risk class). Top 5, ties broken by
most-recently-resolved. Weights live in `DEFAULT_WEIGHTS`.

## AI assistant

`POST /api/incidents/:id/ask` (operator/admin, opt-in + `assistant` licence). Builds
the **masked, aggregated** context (`askContext.js`: timeline + config diffs +
similar) and asks the EU provider via `src/analysis/assistant.js` (`askIncident`).
The system prompt forbids inventing and pins the exact fallback *"Der findes ikke
tilstrækkelige data til at konkludere."*; with no context at all the route returns
that fallback **without** a provider call. Answers are cached per incident+question
(`askCache.js`) and every ask is recorded in the hash-chained `audit_log`.

## HTTP API

| Method + path | Role | Purpose |
| --- | --- | --- |
| `GET /api/incidents` | viewer+ | list (filter `status`/`severity`/`device`/`from`/`to`) |
| `GET /api/incidents/:id` | viewer+ | one incident + its linked anomalies |
| `GET /api/incidents/:id/timeline` | viewer+ | chronological events (anomalies + config-changes + status changes) |
| `GET /api/incidents/:id/config-context` | operator+ | the correlated config change + masked/classified diff + "suspected trigger N min before" |
| `GET /api/incidents/:id/similar` | viewer+ | top-5 similar past incidents |
| `PATCH /api/incidents/:id` | operator+ | status transition (state-machine-validated, audited) |
| `POST /api/incidents/:id/ask` | operator+ | AI question over masked context |
| `GET /api/devices/:id/config-history` | operator+ | masked snapshots + risk-classified diffs |
| `POST /api/devices/:id/config-snapshots` | operator+ | ingest a raw config capture |

## Retention

Raw config snapshots are purged by the existing retention job
(`src/analysis/retention/`) after `RETENTION_CONFIG_SNAPSHOT_DAYS` (default 180).
Purging a snapshot only clears any stale `config_change_id` link (FK is
`ON DELETE SET NULL`) — it never deletes an incident.

## Dashboard

- **Incidents** tab (`views.incidents`) + per-incident detail page (`views.incident`)
  in `public/app.js`: status controls, anomalies, colour-coded timeline (anomaly /
  config-change events link to the device), config-context, similar incidents, and the
  opt-in AI chat.
- **Agent page** gains a "Config history" card (masked diffs + paste-to-ingest form).
- **Overview** "open issues" rollup includes open `incident_cases`
  (`src/dashboard/advancedDashboard.js`).

## Notable design decisions (defaults, tunable)

- **Config secret-masking = mask-on-read** (raw stored, redacted on output).
- **Similarity weights** and the `platform`-as-device-type proxy are in
  `similarity.js` for tuning on real data.
