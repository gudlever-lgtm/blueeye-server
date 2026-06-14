# Audit vs. logging

BlueEye keeps two deliberately separate streams. Conflating them is a bug: an
audit record must never depend on the log, and the log must never be the system
of record for compliance.

| | **Audit event** | **Log line** |
| --- | --- | --- |
| Answers | *Who did what, to what, with what outcome?* | *What did the software do / go wrong?* |
| Audience | Security / compliance / NIS2 | Operators / developers |
| Store | Durable DB (queryable, retained, redacted) | Ephemeral stream → stdout/file/syslog, rotated |
| Triggers | user/admin/agent **actions** + security outcomes (login ok/fail, authz denied, config/license/role change, agent lifecycle) | request served, exceptions, retries/backoff, degraded dependency, **a failed audit write** |
| Code | `src/middleware/auditLogger.js`, `src/services/auditLogger.js`, `src/audit/actions.js`, the `*AuditRepository` / `auditEvents` / `auditLog` repos | `src/logger.js` (`createLogger`), `src/middleware/requestLogger.js` |

## The rule of thumb

A single event may legitimately produce **both** (a failed login is an audit
event *and* a `warn` log), but neither replaces the other.

The clearest case is a **failed audit write** (e.g. `routes/agents.js`
`recordRequested`/`markFailed`): you cannot audit the failure of the audit
system, so it goes to the operational **log** at `warn`. That is exactly why the
two streams exist and stay independent.

## Logging (`src/logger.js`)

`createLogger({ level, format })` — dependency-free, leveled
(`debug<info<warn<error`), ISO-timestamped, optional JSON (`LOG_FORMAT=json`),
with `child(bindings)` for per-request correlation. `src/server.js` injects it
into every module in place of bare `console`. `requestLogger` mints a
per-request id (`req.id`, echoed as `X-Request-Id`) and binds it onto `req.log`,
so the request line and any error logged for that request share one id.

Configuration: `LOG_LEVEL` (default `info`), `LOG_FORMAT` (`text` | `json`).

## Audit (the durable trail)

Audit is rich but spread across several stores (`audit_events`, `audit_log`, plus
domain trails: agent actions, integrations, LDAP/SSO logins, NIS2). The canonical
shape is `{ source, id, ts, category, action, outcome, actor{type,id,label,role},
target{type,id,label}, ip, detail, method, path, status, occurrences }`. Secrets
are redacted before persistence (`audit/actions.js redactBody`); audit writes are
best-effort and never block the action they describe — their *failures* are logged
(see the rule above).

The two general stores differ by design:
- **`audit_events`** (`auditEventsRepository`) — auto-captured user actions + agent
  activity; carries HTTP method/path/status and dedup `occurrences`.
- **`audit_log`** (`auditLogRepository`) — the compliance trail, **hash-chained**
  for tamper-evidence (`entry_hash = sha256(prev_hash ‖ canonical(fields))`,
  `verifyChain()`), licence-gated (`audit_log`).

### Unified read (`src/audit/categories.js`)

Rather than a risky physical table merge, `fromAuditEvent` / `fromAuditLog`
normalize both stores onto the canonical shape and `mergeTrail` merges them into a
single newest-first timeline. **`GET /api/audit/all`** (admin) serves it —
filterable by `category`/`actorType`, paged — so operators get ONE "who did what"
view. The per-store endpoints (`GET /api/audit`, `GET /api/audit-log`) and every
writer are unchanged (backward-compatible). `audit_log` rows are included only when
its feature is licensed.

> Next step (not yet done): route every writer through a single write facade and
> physically reconcile the two tables behind a migration. The taxonomy + unified
> read above are the foundation; the hash-chain on `audit_log` must be preserved
> by any such merge.
