# Per-target incident timeline

A unified, **read-only** view that merges the timestamped events already recorded
for one agent/target into a single chronological list — the backend for the
"incident timeline" feature. Phase 1 is the endpoint only; the dashboard view is
a later phase.

## Endpoint

```
GET /api/targets/:id/timeline?from=&to=&limit=
```

- **Auth:** `viewer+` (same read convention as `/api/incidents/:id/timeline`).
- **`:id`** is the numeric `agents.id`. Unknown id → **404** (not an empty list).
- **`from` / `to`** ISO-8601. Omit either → default window **last 24h**. Invalid
  date → **400**; `from` after `to` → **400**.
- **`limit`** positive integer, capped at **500** (default 500). Invalid → **400**.

### Response

```json
{
  "events": [
    { "timestamp": "2026-06-01T09:00:00Z", "source": "agent",
      "type": "agent.offline", "severity": "WARN",
      "summary": "Agent disconnected", "ref_id": 11 }
  ],
  "partial": false,
  "failedSources": [],
  "window": { "from": "…", "to": "…" }
}
```

Events are sorted **descending** by `timestamp`. Each item is normalised to
`{ timestamp, source, type, severity, summary, ref_id }`; `ref_id` (+ `source`)
lets the frontend deep-link to the original record.

## Sources merged

| `source` | table | `ref_id` | notes |
|---|---|---|---|
| `finding` | `findings` | finding uuid | anomaly detections; `type` = the finding metric |
| `incident` | `incidents` | incident id | probe outages; emits an open event and (if resolved in-window) a `…​.resolved` event |
| `agent` | `audit_events` | audit-event id | lifecycle only: `agent.online` / `agent.offline` / `agent.enrolled` (recurring activity is skipped) |
| `playbook` | `incident_playbook_runs` | run id | remediation runs, resolved via the host's `incident_cases` |

**Severity is normalised to `INFO`/`WARN`/`CRIT` across all sources** so the
frontend colours the whole timeline from the findings palette (probe-outage
`warning`/`critical` → `WARN`/`CRIT`).

## Design notes

- **Reusable merge.** The pure merge/normalise lives in
  `src/timeline/targetTimeline.js` (`buildTargetTimeline`) — a standalone
  function, not embedded in the route — so later phases (e.g. "what changed
  before this finding") can reuse it by filtering its output.
- **Partial failure, not 500.** `src/timeline/targetTimelineService.js` fans out
  the four sources with `Promise.allSettled`; a failing source is reported in
  `failedSources` with `partial: true` while the rest still render. The sources
  are independent and three are slated to move to a separate database
  (TimescaleDB) per `docs/storage-split-audit.md`, so one being unavailable must
  not blank the timeline. A real **500** only happens before fan-out (e.g.
  resolving the target).
- **Target identity.** Every source keys off the agent's numeric id, but stored
  inconsistently — `String(id)` for findings/incident_cases `host_id`, numeric
  for incidents `agent_id` and audit_events `actor_id`. The service centralises
  that mapping. See `REFACTOR-AUDIT-timeline.md` for the full identity analysis.

## "What changed before this" (Phase 3)

```
GET /api/findings/:id/context?window=<minutes>
```

Returns the **change-type** timeline events on the finding's device in the
window immediately before the anomaly (default **30** min, capped 24h). The
look-back is anchored on the anomaly **onset** (`findings.window_from`) when
present — the change that caused an anomaly precedes its onset, which can be
well before detection — falling back to detection time (`findings.created_at`);
`window.anchoredOn` reports which was used, and `trigger.at` always reports the
detection time. Reuses the Phase 1 merge (`getTimeline` over the same sources),
then filters with `classifyEvent` — not a separate query path. Chronological,
**closest-to-trigger first**.

- `viewer+`. **404** unknown finding; **400** invalid `window`; **200 with `[]`**
  (not 404) when no changes; partial-failure handling identical to the timeline.
- Response: `{ changes, partial, failedSources, trigger: { findingId, at }, window }`.

### change vs symptom (`classifyEvent`)

A **change** acted on/altered the target; a **symptom** is the problem
manifesting. Proposed split (one line each to adjust in `targetTimeline.js`):

| event | class |
|---|---|
| playbook run (`playbook.*`) | change |
| agent reconnect (`agent.online`) | change |
| agent enrolment (`agent.enrolled`) | change |
| anomaly finding (`finding.*`) | symptom |
| probe-outage incident (`incident.*`) | symptom |
| agent offline (`agent.offline`) | symptom |

The frontend surfaces this as an inline **"What changed?"** expander per row on
the Findings table (`toggleFindingContext`/`loadFindingContext` in `app.js`),
reusing the Phase 2 `timelineRowEl` row.

## Where things live

- Route: `src/routes/targets.js` (mounted `/api/targets` in `routes/index.js`).
- Merge (pure): `src/timeline/targetTimeline.js`.
- Fan-out/partial: `src/timeline/targetTimelineService.js`.
- Read-only repo additions (no schema changes): `incidentsRepository.listForAgent`,
  `auditEventsRepository.findByActor` (accepts an `actions` whitelist so only
  lifecycle rows are fetched), `remediationPlaybooksRepository.listRunsForHost`
  (single JOIN through `incident_cases` — no N+1), and a `to`/`until` upper bound
  on `findingStore.list` (prevents historical-window truncation).
- Tests: `test/targetTimeline.test.js`.
