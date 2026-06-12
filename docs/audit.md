# Audit trail (Reporting → Audit)

A unified, server-wide audit trail surfaced under **Reporting → Audit**. It
answers *when, who and what* for two kinds of activity:

- **User actions on the server** — every successful login plus every successful
  state-changing request (POST/PUT/PATCH/DELETE).
- **Agent activity** — what each agent actually reported it performed (traffic
  measurements, active probes) plus non-fatal operational errors it hit.

**RBAC:** the Audit view and the `/api/audit` endpoints are **admin only** —
the `admin` role is the permission required to access the audit. Non-admins get
`403`; the dashboard hides the sub-tab entirely.

> This is distinct from the older, narrower trails that still exist:
> `agent_action_audit` (server→agent upgrade/delete, `/audit`), the NIS2 change
> log (`blueeye_audit_log`, `/api/nis2/audit`), `integration_audit` and
> `ldap_login_audit`. The unified trail below is the broad, server-wide one.

## Data model

**`audit_events`** (migration 035) — one table, two write modes:

| Column | Meaning |
| --- | --- |
| `actor_type` | `user` \| `agent` \| `system` |
| `actor_id` / `actor_label` / `actor_role` | who acted (user id+email+role, or agent id) |
| `action` | dotted key, e.g. `user.update`, `agent.run-test`, `settings.update`, `agent.traffic-report` |
| `target_type` / `target_id` / `target_label` | what was affected |
| `method` / `path` / `status` / `ip` | HTTP context (user actions) |
| `detail` | redacted request body (JSON) — **never** holds secrets |
| `repeat_interval_ms` / `occurrences` / `first_seen_at` / `last_seen_at` | recurrence |
| `dedup_key` | `NULL` for discrete rows; set + **UNIQUE** for repeat-suppressed rows |

The nullable **UNIQUE** `dedup_key` is the trick: MySQL allows many `NULL`s in a
unique index, so discrete rows (every distinct user action) never collide, while
recurring activity shares one key and is folded via `INSERT … ON DUPLICATE KEY
UPDATE`.

## How activity is captured

### User actions — `src/middleware/auditLogger.js`

Mounted **before** the API router in `src/app.js`, but it records inside
`res.on('finish')` — by then the route's `requireAuth` has populated `req.user`,
so we know who acted. It records when:

- the method is mutating **and** the response is `2xx`, and
- there is a `req.user` (authenticated user) **or** it's a successful login
  (`/auth`, where the actor comes from the posted email).

It skips the audit reader itself (`/api/audit`) and the agent self-report
endpoints (those are audited on ingest, not as HTTP). Bodies are passed through
`redactBody` (see `src/audit/actions.js`) so `password`/`token`/`secret`/`key`/…
fields become `[redacted]`. The request is mapped to a readable
`action`/`target` by `describeRequest`. A user-triggered **repeating** test/probe
(`intervalMs` in the body) is annotated with that interval.

Everything is best-effort: an audit failure never affects the response.

### Agent activity — `src/routes/agentReports.js`

On ingest the agent's own activity is recorded:

- `POST /agents/results` with `name: 'auto-report'` (continuous reporting) →
  `recordRecurring('agent.traffic-report')`, deduped per agent.
- `POST /agents/results` from a **commanded** run-test → discrete
  `record('agent.run-test')`.
- `POST /agents/probe-results` → `recordRecurring('agent.probe')`, deduped per
  `(agent, type → target)`. A probe the agent could **not execute at all** (a
  missing binary like `traceroute not installed`, a tool that timed out
  launching, or an unknown probe type — the agent reports it with an explicit
  `error`, preserved by validation as `execError`) is instead recorded as
  `recordRecurring('agent.probe-failed')` with the reason in `detail.reason`, so
  the trail shows the failure (and why) rather than a normal probe. This is
  distinct from ordinary reachability loss (`ok:false` with metrics, no error),
  which stays a plain `agent.probe`.
- **install-tool** — installing a missing diagnostic tool on an agent host leaves
  a trail at both ends: the request (operator `POST /agents/:id/install-tool`, or
  the auto-trigger when `Settings → Agents → auto-install` is on) and the
  `agent.install-tool` OUTCOME row recorded from the agent's WebSocket
  `action-result` (in `src/ws/agentSocket.js`), carrying `detail.ok` + the
  reason. The request→complete lifecycle is also tracked in `agent_action_audit`
  (migration 036) like upgrade/delete.
- **`agent.error`** — a non-fatal operational error the agent hit and could not
  otherwise surface (failed to submit a measurement, fetch its config, resolve or
  submit a scheduled probe, report capabilities, run a speed test). The agent
  ships it over the live WebSocket as an `agent.error` frame; `src/ws/agentSocket.js`
  records `recordRecurring('agent.error')`, deduped per `(agent, category[, code])`
  with the message in `detail.reason`. Metadata only — the `message` is the agent's
  `Error` text, never measured payload. This is what gives operators server-side
  visibility into agent-side failures that otherwise live only in the host's local
  log (journald / `docker logs`). A 401 stays out of this trail — it's fatal on the
  agent and already visible as the agent going offline.

No per-report agent lookup is added to the hot path: agent rows store only
`actor_id`, and the read query `LEFT JOIN`s `agents` for the hostname.

## Repeated activity — "Repeats every …"

> Repeated tests etc. are **not** audited per occurrence — only the first run is
> a row; every repeat folds onto it.

`recordRecurring()` upserts on `dedup_key`. The first call inserts an audited
row; each subsequent call bumps `occurrences` and `last_seen_at`. The repeat
interval is **self-measured**: on the first repeat it is set from the observed
gap (`TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) * 1000`) and then kept, so no
caller needs to know the agent's configured cadence. The dashboard renders this
as `Repeats every <interval> · ×<occurrences> · last <when>`.

## API (`/api/audit`, admin only)

| Route | Purpose |
| --- | --- |
| `GET /api/audit?actorType=&action=&from=&to=&limit=&offset=` | filtered trail, newest first |
| `GET /api/audit/actions` | distinct action keys (filter dropdown) |
| `GET /api/audit/export.csv` | CSV export of the (filtered) trail |

## Where things live

- Migration: `migrations/035_create_audit_events.sql`
- Repository: `src/repositories/auditEventsRepository.js` (`record`,
  `recordRecurring`, `findAll`, `distinctActions`)
- Middleware: `src/middleware/auditLogger.js`; pure helpers `src/audit/actions.js`
- Read router: `src/routes/auditEvents.js` (mounted `/api/audit`)
- Dashboard: `auditModule()` + `auditState` in `public/app.js` (Reporting → Audit)
- Tests: `test/auditActions.test.js`, `test/auditEventsRepository.test.js`,
  `test/auditEvents.test.js`, `test/auditAgentActivity.test.js`
