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

Audit is rich but currently spread across several stores
(`auditEvents`, `auditLog`, plus domain trails: agent actions, integrations,
LDAP/SSO logins, NIS2). The canonical shape is
`{ category, action, outcome, actor{type,id,label,role}, target{type,id,label},
ip, detail(redacted), ts }`. Secrets are redacted before persistence
(`audit/actions.js redactBody`); audit writes are best-effort and never block the
action they describe — their *failures* are logged (see the rule above).

> Consolidating the overlapping general audit stores behind one taxonomy/facade
> is tracked separately; this document defines the boundary they must respect.
