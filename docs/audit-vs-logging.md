# Audit vs. logging

BlueEyes keeps two deliberately separate streams. Conflating them is a bug: an
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

## The Logs menu, split in two (dashboard)

The two streams above used to arrive in the dashboard as one nav entry called
**Logs**, which showed only the operational stream — the durable trail lived in
Reporting → Audit, where nobody looked for it. The menu now says what the split
already was:

| Nav | View | Reads | Answers |
| --- | --- | --- | --- |
| **System Logs** | `views.logs` | `GET /api/logs` — the in-memory ring buffer, merged with dashboard errors | *Is the server healthy?* Cleared on restart. |
| **User Logs** | `views.userLogs` | `GET /api/audit/users` | *What did people do here?* Durable. **This is the audit log.** |

Both are admin-only (`data-min-role="admin"`).

### User Logs (`src/audit/userActivity.js`)

`GET /api/audit/users` merges the same two stores as `/api/audit/all`, keeps only
`actor.type === 'user'`, resolves each actor against the live users table, and
annotates every row. The module is **pure** — canonical entries in, rows out — so
the view and the CSV export can never disagree about why something is flagged.

**It is deliberately NOT licence-gated**, unlike `/api/audit/all` and
`/api/audit-log`. User Logs *is* the audit record of who did what, and a security
record that is incomplete by plan is one nobody can trust: an admin asking "what
did people do here" must not be handed a list with the failed sign-ins and licence
actions silently removed. What the `audit_log` feature sells is the tamper-evident
compliance API over the same rows — `verifyChain()`, the category/actor query
surface — not an administrator's ability to see their own users' activity. Writes
were never gated either (`services/complianceLogger.js` records unconditionally),
so the rows are present on every install; only those two reads check the plan.

A row carries `{ ts, userId, name, email, role, action, actionLabel, outcome,
target, status, ip, flagLevel, flags[] }`. `name` comes from `users.name`
(migration 093) as it is **now**, while `email` is the address recorded **at the
time**: a renamed user reads correctly, a deleted one still shows the address that
acted and is marked `deletedUser`.

**The flag rules.** Each returns a `{ code, level, message }` or nothing, and the
row takes the highest level that fired while keeping every reason. There is no
score and no tunable threshold — a flag means "worth a look", not "someone did
wrong", and it always says why:

| Code | Level | Fires when |
| --- | --- | --- |
| `denied` | critical | outcome `denied`, or HTTP 403 — the role did not allow it |
| `failed-login-burst` | critical | 3 failed sign-ins for one account within 15 minutes |
| `server-error` | warn | HTTP 5xx — the action may be half-applied |
| `rejected` | warn | HTTP 4xx, or outcome `failure` |
| `destructive` | notice | a successful delete/remove/purge/revoke/reset/wipe |
| `privileged` | notice | a successful action touching accounts, roles, tokens, licence, SSO/LDAP or secrets |
| `new-address` | notice | a sign-in from an IP the account has not used elsewhere in the same view — never the first row for that account |

Filters (`?user=`, `?flagged=1`, `?q=`, `?from=`/`?to=`, `?limit=`) apply to the
assembled rows; `GET /api/audit/users/export.csv` takes the same query and adds
`flagLevel` + `flagReasons` columns. The response's `sources` says which stores
the list was drawn from (`{events, log}`) — a statement of fact about this
install, not a licence signal.

**Names.** `users.name` is display-only: never an identifier, never unique, never
used to look a user up. Admins set it in Settings → Users (or when inviting).
Federated (LDAP/OIDC/SAML) users have no name until an admin sets one — the
directory's own display name is not imported, so those rows fall back to the
email.
