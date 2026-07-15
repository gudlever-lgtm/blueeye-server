# REFACTOR-AUDIT — Incident Timeline (Phase 1)

> **Filename note:** the brief asked for `REFACTOR-AUDIT.md`, but that file
> already exists on `main` and holds an **unrelated, committed** security/RBAC
> audit (dated 2026-06-20). I did **not** overwrite it. This timeline audit is
> written here instead — see the "Filename collision" decision at the bottom.

Scope: a future **read-only** endpoint `GET /api/targets/:id/timeline` that
merges already-recorded, timestamped events per agent/target into one
chronological view. **No production code written** — this is the "stop and
report" deliverable.

**Headline risk (as you predicted):** there is **no single, typed key** for "the
same target" across the source tables. Everything *semantically* keys off the
agent's numeric `agents.id`, but it's stored three different ways (`INT` PK,
`VARCHAR(255)` `host_id` holding the stringified id, and `actor_id` in the audit
trail). And one of the four sources the brief names — **L2 loop events** —
**does not exist** in this codebase.

---

## 1. Every timestamped, target-scoped event source

**Storage today** = where rows actually live right now. **Storage per #127** =
the classification in `docs/storage-split-audit.md` (PR #127, **merged
2026-07-04**). ⚠️ **#127 is a docs + tests PR only — no table has been
physically moved.** All sources below are still read from the **MySQL pool**
today (`db.pool`); only raw `results` has a TSDB dual-write repo
(`resultsTsdbRepository.js`).

| # | Table (migration) | Timestamp column(s) | Target identity | Storage today | Per #127 | Brief's source |
|---|---|---|---|---|---|---|
| 1 | `findings` (009) | `created_at` (+ `window_from`/`window_to`) | `host_id VARCHAR(255)` = **stringified `agents.id`** | MySQL | TELEMETRY → TSDB | **anomaly findings** ✓ |
| 2 | `incident_playbook_runs` (055) | `ran_at` | `incident_case_id` → `incident_cases.host_id` (**indirect**) | MySQL | MySQL | **playbook remediation attempts** ✓ |
| 3 | `audit_events` (035) | `ts` / `last_seen_at` | `actor_type='agent'` + `actor_id INT` (= `agents.id`) | MySQL | TELEMETRY → TSDB | **agent connect/disconnect** ✓ (`agent.online`/`agent.offline`) |
| 4 | `incidents` (025) | `started_at`, `resolved_at` | `agent_id INT` FK → `agents.id` | MySQL | TELEMETRY → TSDB | probe-outage incidents (not named; a real per-target event source) |
| — | **L2 loop events** | — | — | **DOES NOT EXIST** | — | **L2 loop events** ✗ — see §1a |

### 1a. L2 loop events — the named source does not exist ⚠️

No L2-loop table, finding-metric, probe type, or event stream exists. The only
trace is a comment in `src/incidentCases/explanation.js`:

> "…No anomaly-type ships a confidence model in this codebase yet (only an
> **L2-loop model was ever specced, and it is not here**)…"

`CONFIDENCE_MODELS` is `Object.freeze({})`. If L2-loop detection ever ships, it
will almost certainly arrive as **rows in `findings`** (a new `metric`/`kind`) —
the whole analysis stack funnels through `findings` — so the timeline would pick
it up for free via source #1. **Recommendation:** treat L2-loop as "covered when
it exists (as a finding)"; do **not** stub an empty source that always returns
nothing.

### 1b. Other per-target event sources found (candidates — your call)

Not named in the brief, but timestamped and target-scoped:

| Table (migration) | Timestamp | Identity | Note |
|---|---|---|---|
| `config_snapshots` (049) | `captured_at` | `device_id INT` → agents.id | Device-config changes; already incident-correlated. Strong candidate. |
| `agent_action_audit` (022) | request/complete | `agent_id INT` | Server→agent actions (upgrade/delete/install-tool). |
| `incident_cases` (047) | `first_event_at`/`last_event_at`/`resolved_at` | `host_id VARCHAR(255)` (= agent id) | A *wrapper* over findings — including it double-counts. Prefer exclude. |
| `audit_log` (033) | `created_at` | not agent-keyed (incident-keyed) | Hash-chained; incident status changes. |
| `probe_results` (014) | `ts` | `agent_id INT` | Raw per-probe rows — too granular; already summarised into `incidents`. Exclude. |
| `transaction_results` (046) | `time` | via join table, no FK | TSDB-bound, agent-keyed only through a join. Exclude v1. |

**Prior art to reuse:** `GET /api/incidents/:id/timeline`
(`src/incidentCases/timeline.js` + `routes/incidents.js`) already merges
**findings + audit_events + audit_log** for *one incident* into a flat, sorted
list with `{ ref: { kind, id } }` deep-links — almost exactly the brief's shape
(`ref_id`). The new endpoint is the **per-target generalisation** of it; reuse
the pure `buildTimeline` merge/sort helper and its `ref` convention.

---

## 2. Is "the same target" identified consistently? **No — representationally.** ⚠️

**Semantically:** every source keys off the agent's numeric `agents.id`.
Confirmed end-to-end: `routes/agentReports.js:185` calls
`analysisPipeline.processResults(req.agent.agentId, …)`, and `analysis/ingest.js`
stamps `hostId: String(hostId)` onto every finding ⇒ `findings.host_id ===
String(agents.id)`.

**Representationally:** stored three incompatible ways —

| Source | Column | Type | Value |
|---|---|---|---|
| `agents` | `id` | `INT UNSIGNED` (PK) | canonical |
| `findings` | `host_id` | `VARCHAR(255)` | `"9"` (stringified) |
| `incident_cases` | `host_id` | `VARCHAR(255)` | `"9"` (stringified) |
| `incidents` | `agent_id` | `INT UNSIGNED` (FK) | `9` |
| `audit_events` | `actor_id` | `INT UNSIGNED` | `9` (+ `actor_type='agent'`) |
| `config_snapshots` | `device_id` | `INT` | `9` |
| `incident_playbook_runs` | `incident_case_id` | `BIGINT` | **indirect** (via `incident_cases.host_id`) |

### Risks

1. **String `host_id` vs int `agent_id`, no FK.** `findings`/`incident_cases`
   `host_id` are free-text `VARCHAR` with **no foreign key** to `agents`.
   Existing code already leans on MySQL implicit coercion —
   `incidentCasesRepository.listResolvedClosed` joins
   `LEFT JOIN agents a ON a.id = ic.host_id`. It works, but can't use an int
   index cleanly, and any non-integer `host_id` silently never matches.
2. **Playbook runs aren't agent-keyed.** "Playbook attempts for target X"
   requires `agents.id → incident_cases.host_id (string) →
   incident_playbook_runs.incident_case_id` — two hops, one via the fragile
   string join.
3. **No existing read path fetches `audit_events` by `actor_id` + window.**
   `auditEventsRepository.findAll` filters `actorType`/`action`/time but **not**
   `actorId`; `findByTarget` filters `target_id`, which is **NULL** for
   `agent.online`/`agent.offline`. Step 1 will need a **new read-only** method
   (e.g. `findByActor({ actorType:'agent', actorId, from, to })`) — pure
   addition, no schema change.
4. **Forward-compat with the storage split.** Three of the four real sources
   (`findings`, `incidents`, `audit_events`) are classified TELEMETRY → bound for
   a *separate* database later. The merge layer should treat each source as an
   independent, possibly-failing backend (see §5).

### Recommended `:id` resolution
Resolve `:id` **once** via `agentsRepo.findById(id)` (`null` ⇒ **404**), then fan
out with the id in each source's required shape: `String(id)` for `host_id`,
numeric `id` for `agent_id`/`actor_id`, and the `incident_case → host_id` hop for
playbook runs. Centralises the messy mapping and yields a clean 404.

---

## 3. Existing pagination / time-range convention (reuse — don't invent)

Consistent, **offset-free, `from`/`to` + capped-`limit`**. No cursors anywhere.

- Route layer parses dates with a local `parseDate(v)` → `Date | null` (invalid
  ⇒ `null`), e.g. `routes/incidents.js:26`; repos take `{ from, to, limit }`.
- **`limit` clamped in the repo**, never trusted raw: `audit_events`
  `clampLimit(v, 100, 500)`; `FindingStore.list` `Math.min(limit, 5000)`;
  `incident_cases.list` cap 5000; `listRunsForIncident` default 50 / cap 500.
- Ordering `ORDER BY <ts> DESC, id DESC` for list reads.
- The brief's "default last 24h, cap `limit` at 500" maps directly: reuse
  `parseDate` in the route + a `clampLimit(…, 500)`-style cap.
- Per-source time column differs: `findings.created_at`, `incidents.started_at`
  (+ open where `resolved_at IS NULL`), `audit_events.ts`,
  `incident_playbook_runs.ran_at`.

---

## 4. RBAC for read endpoints — **viewer+ confirmed sufficient**

Convention (`src/auth/middleware.js`, `viewer < operator < admin`):

```js
const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => { … }));
```

Confirmed on the closest analogue: `GET /api/incidents/:id` **and**
`GET /api/incidents/:id/timeline` are both `requireAuth + reader` (viewer+). So
**viewer is enough** — matches the brief. No license gate is applied to the
incident timeline; recommend the new endpoint stay ungated too (flag if you'd
prefer a plan feature).

**Routing:** there is **no `/api/targets` router today** (`routes/index.js` is
clean). Step 1 adds `src/routes/targets.js` mounted at `/api/targets` in
`routes/index.js`, plus a fake in `test-support/fakes.js`.

---

## 5. 500 vs partial-failure — recommendation for sign-off

**Recommend: partial success with a `partial: true` flag**, not all-or-nothing
500. Rationale, grounded in this codebase's ethos:

- Sources are **independent**, and three are slated to move to a **separate
  database** (TSDB). A findings-store outage shouldn't blank the agent's
  connect/disconnect history, or vice-versa.
- The ingest/analysis stack is deliberately **best-effort/resilient**
  (`analysisPipeline`/`flowPipeline` swallow per-item failures; audit writes are
  "non-fatal"). A read timeline should mirror that.
- Concretely: fan out per-source reads with `Promise.allSettled`, merge the
  fulfilled ones, and on any rejection return `200` with
  `{ events: [...], partial: true, failedSources: ['findings', …] }`. A true
  **500** is reserved for a failure *before* fan-out (e.g. the `:id`→agent
  resolution throwing); an unknown agent stays a clean **404**.

---

## Proposed normalized event shape (Step 1 preview — not built)

Per the brief: `{ timestamp, source, type, severity, summary, ref_id }`, sorted
**descending** by timestamp.

| source | type | severity | summary | ref_id |
|---|---|---|---|---|
| `findings` | `finding.<metric>` / `kind` | `INFO`/`WARN`/`CRIT` | `explanation` | finding `id` (uuid) |
| `incidents` | `incident.<metric>` (+ `.resolved`) | `warning`/`critical` | target + duration | incident `id` |
| `audit_events` | `agent.online` / `agent.offline` | `INFO` | source IP / reason | audit_event `id` |
| `incident_playbook_runs` | `playbook.<status>` | derived | playbook name + outcome | run `id` |

`ref_id` (+ implicit `source`) deep-links back to the original record — the same
idea as `{ ref: { kind, id } }` in the existing incident timeline.

---

## STOP — awaiting go-ahead

Decisions needed before Step 1:

1. **Filename collision** — `REFACTOR-AUDIT.md` already exists on `main` (an
   unrelated, committed security audit). Options: (a) keep this audit as
   `REFACTOR-AUDIT-timeline.md` (done — nothing destroyed), (b) let me move it
   into `docs/` (e.g. `docs/incident-timeline-audit.md`), or (c) overwrite the
   existing `REFACTOR-AUDIT.md` (destroys the prior security audit — not
   recommended).
2. **L2 loop** — confirm we treat it as "arrives as a finding when it exists"
   and ship against the three real sources + probe-outage incidents (my rec),
   not a stub source.
3. **Source set** — include probe-outage `incidents` (#4)? (I'd include it.)
   Also fold in `config_snapshots` config-changes / `agent_action_audit`? (Hold
   unless you want a fuller view.)
4. **Partial vs 500** — confirm the `partial: true` approach in §5.
5. **License gate** — leave viewer+ ungated like the incident timeline (my rec),
   or gate behind a plan feature?

*AUDIT-ONLY — no production code changed, no migrations run, nothing committed.*
