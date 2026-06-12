# REFACTOR-AUDIT.md — blueeye-server

Pre-refactor structural audit. **Read-only — no code was changed in this session.**
Scope: `blueeye-server` (the Express + MySQL server). The sister repos
`blueeye-agent` and `blueeye-licens` host no Express routes, MySQL pool, auth
middleware, or alerting outputs, so they are out of scope for every question below.

Method: static reading of `src/app.js`, `src/routes/*`, `src/auth/*`,
`src/middleware/*`, `src/config.js`, `src/db.js`, `src/analysis/alerting/*`,
`src/integrations/*`, and supporting services. Line references are
`file:line` against the tree as read.

---

## 0. Executive summary

| # | Topic | Headline finding |
| --- | --- | --- |
| 1 | Routes | ~140 routes across 40 router files (38 mounted in `routes/index.js`). Full table below. |
| 2 | Auth bypass | **No global `requireAuth`** — every router self-applies `requireAuth`/`requireRole`. Bypasses are all *intentional* (public + agent-token), but the pattern is fragile: a new router that forgets `requireAuth` is silently public. One global pre-auth path (API-token middleware) can populate `req.user`. |
| 3 | DB connections | **No server-runtime code bypasses the shared pool.** Only 3 standalone CLIs (`migrate.js`, `scripts/seed-*.js`) call `mysql.createConnection` directly — by necessity (they run outside the server process). |
| 4 | Config reads | **Config is NOT centralized in `config.js`.** There are **4 separate env-driven loaders** (`config.js` + `analysis/config.js` + `analysis/alerting/config.js` + `analysis/retention/config.js`) plus **3 stray `process.env` reads** outside any loader. |
| 5 | Mutating + audit | Most user mutations are auto-captured by the global `audit_events` middleware. **Two-state pattern** (request→complete) is used only for agent `update`/`delete`/`install-tool` (`agent_action_audit`). **3 agent-token mutations write no audit at all.** Audit is fragmented across **6 stores**. |
| 6 | Alerting + ITSM | **Two parallel dispatch engines** (`analysis/alerting/dispatcher.js` and `integrations/dispatcher.js`) each re-implement throttle/fan-out/test/error-isolation. **`webhook` + HMAC signing is implemented twice.** No dedicated "ISE" output exists — Cisco ISE is only a downstream consumer of the **syslog** channel. |

---

## 1. Express routes grouped by file (method + path)

Auth legend: **public** = no auth; **agent** = agent opaque-token (`agentAuth`);
**viewer+/operator+/admin** = `requireAuth` + `requireRole(...)`; **authed** =
`requireAuth` only (any role); **+feat(x)** = `requirePlanFeature`/`requireFeature` licence gate.
Mount prefixes come from `src/routes/index.js`.

### Infra / auth (public)
| File | Method | Path | Auth |
| --- | --- | --- | --- |
| `health.js` | GET | `/health` | public (db ping) |
| `auth.js` | GET | `/auth/sso` | public |
| `auth.js` | POST | `/auth/login` | public |
| `oidc.js` (auth) | GET | `/auth/oidc/login` | public |
| `oidc.js` (auth) | GET | `/auth/oidc/callback` | public (mints JWT) |
| `saml.js` (auth) | GET | `/auth/saml/login` | public |
| `saml.js` (auth) | POST | `/auth/saml/callback` | public (ACS, mints JWT) |
| `saml.js` (auth) | GET | `/auth/saml/metadata` | public |
| `enroll.js` | GET | `/enroll/config` | public |
| `enroll.js` | GET | `/enroll/agent-release-key` | public |
| `enroll.js` | GET | `/enroll/agent-source.tgz` | public |
| `enroll.js` | GET | `/enroll/agent-release` | public |
| `enroll.js` | GET | `/enroll/agent-release.tgz` | public |
| `enroll.js` | GET | `/enroll/uninstall.sh` | public |
| `enroll.js` | GET | `/enroll/agent/:platform` | public |
| `enroll.js` | GET | `/enroll/:code/install.sh` | public |

### User-facing (JWT/RBAC)
| File | Method | Path | Auth |
| --- | --- | --- | --- |
| `users.js` | GET | `/users` | admin (router-wide) |
| `users.js` | POST | `/users` | admin |
| `users.js` | PUT | `/users/:id` | admin |
| `users.js` | DELETE | `/users/:id` | admin |
| `me.js` | GET | `/me` | authed (router-wide `requireAuth`) |
| `me.js` | PUT | `/me/preferences` | authed |
| `locations.js` | GET | `/locations` | viewer+ |
| `locations.js` | GET | `/locations/:id/traffic` | viewer+ |
| `locations.js` | GET | `/locations/:id/traffic/history` | viewer+ |
| `locations.js` | POST | `/locations` | operator+ |
| `locations.js` | PUT | `/locations/:id` | operator+ |
| `locations.js` | DELETE | `/locations/:id` | admin |
| `license.js` | GET | `/license/status` · `/features` · `/plan` · `/usage` · `/matrix` | viewer+ |
| `license.js` | POST | `/license/refresh` | operator+ |
| `system.js` | GET | `/system/version` | viewer+ |
| `system.js` | POST | `/system/agent-source/reload` | admin |
| `system.js` | GET | `/system/storage` | viewer+ |
| `findings.js` | GET | `/api/findings` | viewer+ |
| `findings.js` | POST | `/api/findings/:id/ack` | operator+ |
| `assistant.js` | POST | `/api/assistant/explain` · `/diagnose-explain` · `/location-summary` | viewer+ +feat(assistant) |
| `geo.js` | GET | `/api/geo/config` · `/overview` · `/select/findings` · `/select/flows` | viewer+ +feat(geo) (router-wide) |
| `alerting.js` | GET | `/api/alerting/config` | viewer+ |
| `alerting.js` | POST | `/api/alerting/test` | operator+ |
| `map.js` | GET | `/api/map/config` | viewer+ |
| `flows.js` | GET | `/api/flows/categories/defs` · `/categories` · `/explore` | viewer+ |
| `probes.js` | GET | `/api/probes/` · `/latest` · `/path` | viewer+ |
| `fleet.js` | GET | `/api/fleet/health` · `/nics` · `/agent/:id` | viewer+ |
| `dashboard.js` | GET | `/api/dashboard/advanced` | viewer+ +feat(dashboard_advanced) |
| `reports.js` | GET | `/api/reports/availability` · `/incidents` | viewer+ |
| `reports.js` | GET | `/api/reports/availability.csv` · `/incidents.csv` | viewer+ +feat(reports_csv) |
| `reports.js` | GET | `/api/reports/availability.html` · `/incidents.html` | viewer+ +feat(reports_pdf) |
| `reports.js` | GET | `/api/reports/nis2-draft/:incident_id` | operator+ |
| `thresholds.js` | GET | `/api/thresholds/` · `/:location_id` | viewer+ |
| `thresholds.js` | PUT | `/api/thresholds/` · `/:location_id` | admin |
| `interfaces.js` | GET | `/api/interfaces/` | viewer+ |
| `search.js` | GET | `/api/search/` | viewer+ |
| `export.js` | GET | `/api/export/investigation` | viewer+ |
| `export.js` | GET | `/api/export/:resource` | viewer+ (+feat per resource) |
| `enrollmentCodes.js` | POST | `/enrollment-codes` | operator+ |
| `enrollmentCodes.js` | GET | `/enrollment-codes` | operator+ |
| `enrollmentCodes.js` | DELETE | `/enrollment-codes/:id` | admin |
| `enrollCommand.js` | GET | `/api/enroll/command` | operator+ |
| `testPackages.js` | GET | `/api/test-packages/` · `/:id` | viewer+ |
| `testPackages.js` | POST | `/api/test-packages/` · `/:id/run` | operator+ |
| `testPackages.js` | PUT | `/api/test-packages/:id` | operator+ |
| `testPackages.js` | DELETE | `/api/test-packages/:id` | operator+ |
| `speedtest.js` (read) | GET | `/api/speedtest/` | viewer+ |

### Settings / integrations / external auth (admin)
| File | Method | Path | Auth |
| --- | --- | --- | --- |
| `settings.js` | GET | `/api/settings/` · `/agent-release-key` | admin |
| `settings.js` | GET | `/api/settings/maintenance` · `/geoip/update` | viewer+ (reader) |
| `settings.js` | POST | `/api/settings/agent-release-key` · `/geoip/update` | admin |
| `settings.js` | DELETE | `/api/settings/agent-release-key` | admin |
| `settings.js` | PUT | `/api/settings/{maintenance,analysis,assistant,alerting,retention,throughput,agents,flow-categories,map,geoip}` | admin (assistant/alerting also +feat) |
| `integrations.js` | GET | `/api/integrations/{meta,/,:id,:id/audit}` | admin (router-wide) |
| `integrations.js` | POST | `/api/integrations/` · `/:id/test` | admin |
| `integrations.js` | PUT | `/api/integrations/:id` | admin |
| `integrations.js` | DELETE | `/api/integrations/:id` | admin |
| `ldap.js` | GET | `/api/ldap/config` · `/role-map` · `/login-audit` | admin (router-wide) |
| `ldap.js` | PUT | `/api/ldap/config` · `/role-map/:id` | admin +feat(sso_ldap) |
| `ldap.js` | POST | `/api/ldap/role-map` · `/test` | admin +feat(sso_ldap) |
| `ldap.js` | DELETE | `/api/ldap/role-map/:id` | admin +feat(sso_ldap) |
| `oidc.js` (admin) | GET | `/api/oidc/config` · `/role-map` · `/login-audit` | admin (router-wide) |
| `oidc.js` (admin) | POST | `/api/oidc/role-map` · `/test` | admin +feat(sso_oidc) |
| `oidc.js` (admin) | PUT | `/api/oidc/role-map/:id` | admin +feat(sso_oidc) |
| `oidc.js` (admin) | DELETE | `/api/oidc/role-map/:id` | admin +feat(sso_oidc) |
| `saml.js` (admin) | GET | `/api/saml/config` · `/role-map` · `/login-audit` | admin (router-wide) |
| `saml.js` (admin) | POST | `/api/saml/role-map` | admin +feat(sso_saml) |
| `saml.js` (admin) | PUT | `/api/saml/role-map/:id` | admin +feat(sso_saml) |
| `saml.js` (admin) | DELETE | `/api/saml/role-map/:id` | admin +feat(sso_saml) |
| `ha.js` | GET | `/api/ha/status` · `/nodes` | authed +feat(ha_deployment) (router-wide) |
| `ha.js` | POST | `/api/ha/step-down` | admin +feat(ha_deployment) |

### NIS2 reporting (`nis2.js`, `/api/nis2`)
Reader = viewer+, writer = operator+, approver = admin (all `requireAuth` per-route).
- GET (reader): `/meta` `/dashboard` `/risks` `/risks/:id` `/controls` `/controls/:id` `/incidents` `/incidents/:id` `/evidence` `/reports` `/reports/:id` `/custom-reports/sources`
- POST (reader): `/custom-reports/preview` · `/custom-reports/export` (+feat reports_compliance)
- POST/PUT/DELETE (writer): `/risks` `/risks/:id`, `/controls` `/controls/:id`, `/incidents` `/incidents/:id`, `/evidence` `/evidence/:id`, `/reports` (+feat) `/reports/:id`, `/seed`
- POST (approver): `/reports/:id/approve` (+feat reports_compliance)
- GET (admin): `/audit`
- GET (reader +feat): `/export/{risks,controls,incidents}.csv`, `/export/{executive,readiness,risk,control,incident}.html`

### Agent-facing & audit readers
| File | Method | Path | Auth |
| --- | --- | --- | --- |
| `agents.js` | POST | `/agents/releases` | admin |
| `agents.js` | POST | `/agents/:id/ping` · `/diagnose` | viewer+ |
| `agents.js` | POST | `/agents/:id/update` · `/delete` | admin |
| `agents.js` | POST | `/agents/:id/install-tool` · `/run-test` · `/probe` · `/run-speedtest` | operator+ |
| `agents.js` | GET | `/agents/` · `/:id` · `/:id/results` · `/:id/flows` | viewer+ |
| `agents.js` | GET | `/agents/:id/audit` | admin |
| `agents.js` | PUT | `/agents/:id` | operator+ |
| `agents.js` | DELETE | `/agents/:id` | admin |
| `agentReports.js` | POST | `/agents/results` · `/agents/probe-results` | **agent** |
| `agentReports.js` | GET | `/agents/me/config` | **agent** |
| `agentReports.js` | POST | `/agents/me/capabilities` | **agent** |
| `agentEnroll.js` | POST | `/agents/enroll` | **public** (enrollment code + rate limit) |
| `speedtest.js` (write) | GET | `/speedtest/download` | **agent** |
| `speedtest.js` (write) | POST | `/speedtest/upload` · `/speedtest/results` | **agent** |
| `audit.js` | GET | `/audit` | admin (reads `agent_action_audit`) |
| `auditEvents.js` | GET | `/api/audit/` · `/actions` · `/export.csv` | admin |
| `auditLog.js` | GET | `/api/audit-log/` · `/categories` · `/verify` | admin +feat(audit_log) |
| `apiTokens.js` | GET | `/api/api-tokens/` | admin +feat(api_access) (router-wide) |
| `apiTokens.js` | POST | `/api/api-tokens/` | admin +feat(api_access) |
| `apiTokens.js` | DELETE | `/api/api-tokens/:id` | admin +feat(api_access) |

> Note: many route strings are declared without a leading slash (e.g.
> `router.put(':id')`, `router.post(':id/run')` in `agents.js`, `locations.js`,
> `testPackages.js`, `findings.js`, `export.js`). They resolve correctly under the
> mount prefix and are tested, but it is an inconsistent convention worth
> normalizing during refactor.

---

## 2. Routes that bypass the shared auth middleware

**Architecture:** the shared auth middleware is `requireAuth` / `requireRole`
(`src/auth/middleware.js`). It is **NOT** applied globally — `src/app.js` mounts the
API router with no `app.use(requireAuth)`; each router applies auth itself (some
router-wide via `router.use(requireAuth, …)`, most per-route). The app.js comment
makes this explicit: *"User-JWT RBAC and agent-token auth are enforced inside the
individual routers."*

This means "bypassing the shared auth middleware" is a per-router property. The
following routes do **not** pass through `requireAuth`:

### 2a. Intentionally public (by design)
- `health.js` — liveness/db ping.
- `auth.js` — `POST /auth/login`, `GET /auth/sso`.
- `oidc.js`/`saml.js` **auth** routers — `/auth/oidc/{login,callback}`,
  `/auth/saml/{login,callback,metadata}`. These mint JWTs; the SSO assertion *is*
  the credential.
- `enroll.js` — all of `/enroll/*` (source bundle, signed release, install/uninstall
  scripts, legacy binaries). Air-gap-friendly, unauthenticated downloads.
- `agentEnroll.js` — `POST /agents/enroll`. Unauthenticated by design (the agent has
  no token yet; the one-time **enrollment code is the credential**). Throttled by an
  injected `rateLimit` — **but the default is `noopRateLimiter`** (`agentEnroll.js:22`),
  so throttling only exists if `enrollRateLimiter` is wired in `server.js`.

### 2b. Agent-token auth — a *separate* scheme, not the shared middleware
These use `agentAuth` (`createAgentTokenMiddleware`, `routes/index.js:136-141`)
instead of `requireAuth`. Not a bypass, but a parallel authenticator the shared
middleware never sees:
- `agentReports.js` — `POST /agents/results`, `POST /agents/probe-results`,
  `GET /agents/me/config`, `POST /agents/me/capabilities`.
- `speedtest.js` (write router) — `GET /speedtest/download`, `POST /speedtest/upload`,
  `POST /speedtest/results`.

### 2c. Structural risks to flag for the refactor
1. **Default-allow topology.** Because auth is opt-in per router, a newly added
   router that omits `requireAuth` is silently world-readable/writable. There is no
   backstop (no default-deny, no test that asserts every mounted router carries auth).
   Recommend a single choke-point or a registration helper that *requires* an auth
   declaration.
2. **A second, global pre-auth path exists.** `routes/index.js:146` mounts
   `createApiTokenMiddleware` with `router.use(...)` **ahead of every router**. On an
   `X-API-Key`/`Bearer` it sets `req.user` + `req.authVerified`, which `requireAuth`
   then accepts as-is (`auth/middleware.js:21-23`). So every `requireAuth` route is
   reachable by an API token (role-scoped), not only by a login JWT. Intended, but it
   means "the shared auth middleware" actually has two entry paths (JWT verify + API
   token) that must be reasoned about together.
3. **Mixed application styles.** Some routers gate router-wide
   (`users`, `me`, `geo`, `integrations`, `ldap`, `oidc`-admin, `saml`-admin,
   `apiTokens`, `ha`), others repeat `requireAuth, requireRole(...)` on every route
   (`agents`, `locations`, `nis2`, `settings`, `reports`, …). The per-route style is
   deliberate (so unknown sub-paths fall through to 404) but is copy-pasted dozens of
   times and is the most likely place for an omission to hide.

No route was found that *should* be authenticated but is accidentally public.

---

## 3. Code that opens its own DB connection (instead of the shared handle)

The shared handle is the `mysql2` pool created once in `src/db.js` (`createDb`,
injected everywhere via DI). Findings:

| Site | Call | Verdict |
| --- | --- | --- |
| `src/db.js:8` | `mysql.createPool(...)` | The shared pool itself (the canonical handle). |
| `src/db.js:22` | `pool.getConnection()` (in `ping()`) | Uses the shared pool. ✅ |
| `src/services/enrollmentStore.js:36` | `pool.getConnection()` | Uses the **injected shared pool**; checks out a dedicated connection for a `FOR UPDATE` transaction (`claimAndEnroll`). Correct/required. ✅ |
| `src/ha/leaderLock.js:52` | `pool.getConnection()` | Uses the **injected shared pool**; holds one connection for the session-scoped MySQL advisory lock (`GET_LOCK` must stay on a single session). Correct/required. ✅ |
| `src/migrate.js:41` | `mysql.createConnection(...)` | **Own connection.** Standalone CLI (`npm run migrate`), runs as its own process — no server pool exists. Needs `multipleStatements:true` (which the pool deliberately omits). Expected. |
| `scripts/seed-demo.js:21` | `mysql.createConnection(...)` | **Own connection.** Standalone seeding CLI. Expected. |
| `scripts/seed-superadmin.js:21` | `mysql.createConnection(...)` | **Own connection.** Standalone seeding CLI. Expected. |

**Conclusion:** **no in-server code path bypasses the shared pool.** The only direct
`createConnection` calls are the three standalone CLI entrypoints, which run outside
the server process by design. The two `pool.getConnection()` checkouts
(`enrollmentStore`, `leaderLock`) use the shared pool correctly — they are not
violations. Repositories all receive `db`/`pool` by injection (the `mysql2` mentions
in `repositories/*.js` are comments about JSON-column parsing, not new connections).

Minor note: the three CLIs each re-read `config.db` and re-specify the same six
connection params — a small duplication that a shared `createConnection(config.db)`
helper could remove without touching the pool.

---

## 4. Config reads (env vars + config files) and where they happen

**Config is not centralized.** There are **four** independent env-driven loaders, plus
a handful of stray reads.

### 4a. Primary loader — `src/config.js`
`require('dotenv').config()` then `process.env.*` for the whole server. Groups and vars:
- core: `NODE_ENV`, `PORT`, `BLUEEYE_PUBLIC_URL`/`PUBLIC_URL`, `TRUST_PROXY` *(see 4c)*
- db: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CONNECTION_LIMIT`
- auth/secrets: `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_ISSUER`, `BCRYPT_ROUNDS`,
  `SECRET_ENCRYPTION_KEY` (falls back to `JWT_SECRET`)
- LDAP: `LDAP_AUTH_ENABLED`
- OIDC: `OIDC_AUTH_ENABLED`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `OIDC_REDIRECT_URI`, `OIDC_SCOPES`, `OIDC_ROLE_CLAIM`
- SAML: `SAML_AUTH_ENABLED`, `SAML_ENTRY_POINT`/`SAML_IDP_SSO_URL`,
  `SAML_SP_ENTITY_ID`/`SAML_ISSUER`, `SAML_AUDIENCE`, `SAML_IDP_ENTITY_ID`,
  `SAML_IDP_CERT`, `SAML_CALLBACK_URL`, `SAML_ROLE_ATTRIBUTE`
- seed admin: `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`
- enrollment: `ENROLLMENT_CODE_TTL_MINUTES`, `AGENT_ARTIFACTS_DIR`, `AGENT_SOURCE_DIR`,
  `AGENT_CERT_FINGERPRINT`/`TLS_CERT_FINGERPRINT`
- ws: `WS_AGENT_PATH`, `WS_DASHBOARD_PATH`, `WS_HEARTBEAT_MS`
- license: `LICENSE_KEY`, `LICENSE_SERVER_ID`, `LICENSE_SERVER_URL`,
  `LICENSE_CACHE_PATH`, `LICENSE_GRACE_DAYS`, `LICENSE_VALIDATE_INTERVAL_HOURS`,
  `LICENSE_PLAN`, `LICENSE_FILE`, `LICENSE_MODE`
- ha: `HA_ENABLED`, `HA_NODE_ID`, `HA_LOCK_NAME`, `HA_INTERVAL_MS`,
  `HA_STEPDOWN_COOLDOWN_MS` (also reads `os.hostname()`, `process.pid` inline)
- storage: `STORAGE_DISK_PATH`
- analysis: `ANALYSIS_BASELINE_CACHE_PATH`
- geo: `GEO_ENABLED`, `GEOIP_DB_PATH`, `GEOIP_BUILD_PATH`, `GEOIP_SOURCE_URL`,
  `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `MAP_TILE_MAX_ZOOM`, `MAP_GEOCODE_URL`

### 4b. Secondary loaders — read env on their own (NOT via `config.js`)
These take `env = process.env` as a parameter (so tests can stub it), so they read
env directly and are invisible to anyone reading `config.js`:
- `src/analysis/config.js` (`loadConfig`): `ANALYSIS_ENABLED`,
  `ANALYSIS_ASSISTANT_ENABLED`, `ANALYSIS_CRIT_SIGMA`, `ANALYSIS_WARN_SIGMA`,
  `ANALYSIS_BASELINE_DAYS`, `ANALYSIS_MIN_SAMPLES`, `ANALYSIS_ASSISTANT_API_KEY`,
  `MISTRAL_API_KEY`, `ANALYSIS_ASSISTANT_MODEL`, `ANALYSIS_ASSISTANT_URL`,
  `ANALYSIS_ASSISTANT_MAX_FINDINGS`, `ANALYSIS_ASSISTANT_TIMEOUT_MS`
- `src/analysis/alerting/config.js` (`loadAlertingConfig`): `ALERTING_ENABLED`,
  `ALERT_COOLDOWN_MS`, `ALERT_EMAIL_*`, `SMTP_HOST/PORT/USER/PASS/SECURE`,
  `ALERT_WEBHOOK_*`, `ALERT_SYSLOG_*`, `SYSLOG_HOST/PORT/PROTO/APP`
- `src/analysis/retention/config.js` (`loadRetentionConfig`): `RETENTION_ENABLED`,
  `RETENTION_RAW_DAYS`, `RETENTION_ROLLUP_DAYS`, `RETENTION_FINDING_DAYS`,
  `RETENTION_ROLLUP_INTERVAL_MINUTES`, `RETENTION_JOB_INTERVAL_HOURS`,
  `RETENTION_BATCH_SIZE`

### 4c. Stray `process.env` reads outside any loader (flag)
- `src/app.js:96` — `process.env.TRUST_PROXY` read inline at app construction
  (duplicates the parsing pattern used in `config.js`; not surfaced on the `config`
  object).
- `src/middleware/errorHandler.js:33` — `process.env.NODE_ENV` (stack-trace gating).
- `src/server.js:157` — `process.env.AGENT_RELEASE_DIR` — a real config input **not
  represented anywhere in `config.js`**.

### 4d. Config files / paths read from disk
- `.env` (via `dotenv`, `config.js`)
- `package.json` (`system.js:7` for version/releaseDate)
- license cache JSON (`LICENSE_CACHE_PATH`, default `.license-cache.json`)
- offline license file (`LICENSE_FILE`)
- analysis baseline cache (`ANALYSIS_BASELINE_CACHE_PATH`, default `.analysis-baselines.json`)
- GeoIP CSV (`GEOIP_DB_PATH` / built to `GEOIP_BUILD_PATH`)
- migrations dir (`src/migrate.js`), public dir (`src/app.js:106`),
  agent source dir (`AGENT_SOURCE_DIR`)
- license signing public key (`license/publicKey.js` via `resolvePublicKey()`)

### 4e. CLI scripts (separate processes)
- `scripts/seed-demo.js`: `SEED_DEMO`, `SEED_DEMO_ENROLLMENT_CODE`, `NODE_ENV`.
- `scripts/seed-superadmin.js`: `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`
  — **note the hard-coded fallback password `'gr34tb4lls'`** (`seed-superadmin.js:18`).

**Refactor takeaway:** four loaders + three stray reads means there is no single
place that lists every input. `AGENT_RELEASE_DIR` and `TRUST_PROXY` in particular sit
outside `config.js`. Consolidating the analysis/alerting/retention loaders under (or
referenced from) `config.js` would make the config surface auditable in one place.

---

## 5. Mutating endpoints & audit coverage

### 5a. How auditing works here (6 stores)
1. **`audit_events` (global, automatic)** — `src/middleware/auditLogger.js`, mounted in
   `app.js:110` *before* the API router. On `res.on('finish')` it records **every
   successful (2xx) POST/PUT/PATCH/DELETE made by an authenticated user**, plus logins.
   **Skip-list** (`skip()` + the `!req.user && !isLogin` guard): `/api/audit*`,
   `/agents/results`, `/agents/probe-results`, `/agents/me/*`, `/agents/enroll*`, and
   anything with no `req.user` (i.e. agent-token & unauthenticated mutations). Secrets
   are redacted (`audit/actions.js redactBody`).
2. **`agent_action_audit` (TWO-STATE: requested → completed/failed)** — the pattern the
   task references. Written by `auditRepo.record()` (state *requested*, returns id) and
   closed by `auditRepo.complete()`. The **completion is echoed back by the agent over
   the WS channel** (`ws/agentSocket.js:193-194`), or flipped to *failed* synchronously
   when delivery fails (`agents.js markFailed`).
3. **`audit_log` (explicit, single-state)** — `services/auditLogger.js`, called from
   specific routes.
4. **`integration_audit`** — one row per outbound fire (`integrations/dispatcher.js:64`).
5. **`sso_login_audit`** / **`ldap_login_audit`** — login-attempt trails.
6. **NIS2 change log** (`blueeye_audit_log` via `nis2AuditRepo`, surfaced at
   `GET /api/nis2/audit`).

### 5b. Two-state pattern — exhaustive list
Only three actions use request→complete (`agent_action_audit`):

| Endpoint | Action | Where requested | Where completed |
| --- | --- | --- | --- |
| `POST /agents/:id/update` | `upgrade` | `agents.js:259` | agent WS echo (`agentSocket.js:193`) / `markFailed` |
| `POST /agents/:id/delete` | `delete` | `agents.js:300` | agent WS echo / `markFailed` |
| `POST /agents/:id/install-tool` | `install-tool` | `agents.js:342` | agent WS echo / `markFailed` |
| *(auto)* `installToolService.maybeAutoInstall` | `install-tool` | `services/installToolService.js:63` | agent WS echo / `markFailed` |

`GET /agents/:id/audit` and `GET /audit` are the readers for this store.

### 5c. Mutating endpoints and whether they write an audit record

| Endpoint(s) | Global `audit_events`? | Dedicated audit | Two-state? |
| --- | --- | --- | --- |
| `POST /auth/login` | ✅ (as `auth.login`) | `audit_log` (login_success/failure/lockout) + `ldap_login_audit` | no |
| `GET /auth/oidc/callback`, `POST /auth/saml/callback` | SAML ✅ (POST→`auth.login`); OIDC is a **GET** so not via middleware | `sso_login_audit` + `audit_log` | no |
| `POST/PUT/DELETE /users*` | ✅ | `audit_log` (user_create/update/delete) | no |
| `POST /license/refresh` | ✅ | `audit_log` (license_revalidate) | no |
| `POST /api/api-tokens`, `DELETE /api/api-tokens/:id` | ✅ | `audit_log` (api_token_create/revoke) | no |
| report export (`reports.js:109`) | ✅ | `audit_log` (report export) | no |
| `POST /api/integrations/:id/test` | ✅ | `integration_audit` (per fire) | no |
| `POST /api/integrations` · `PUT/DELETE /:id` (CRUD) | ✅ (integration.create/update/delete) | — (fires also write `integration_audit` when emitted) | no |
| `POST /agents/:id/update` · `delete` · `install-tool` | ✅ (agent.\<sub\>) | **`agent_action_audit`** | **yes** |
| `POST /agents/:id/run-test` · `probe` · `run-speedtest` · `ping` · `diagnose` | ✅ (agent.\<sub\>) | — | no |
| `POST /agents/releases`, `PUT /agents/:id`, `DELETE /agents/:id` | ✅ | DELETE also fires integration `emitAgentEvent('delete')` → `integration_audit` | no |
| `PUT /me/preferences` | ✅ (profile.update) | — | no |
| `POST/PUT/DELETE /locations*` | ✅ | — | no |
| `POST/DELETE /enrollment-codes*` | ✅ | — | no |
| `PUT /api/thresholds*` | ✅ | — | no |
| `POST /api/findings/:id/ack` | ✅ | — | no |
| `POST/PUT/DELETE /api/settings/*` (incl. `geoip/update`, `agent-release-key`) | ✅ (settings.\<area\>) | — | no |
| `PUT/POST/DELETE /api/ldap/*`, `/api/oidc/role-map*`, `/api/saml/role-map*`, `*/test` | ✅ | — | no |
| `POST /api/alerting/test`, `POST /api/ha/step-down`, `POST /system/agent-source/reload` | ✅ | — | no |
| NIS2 writes (`POST/PUT/DELETE /api/nis2/*`, `/seed`, `/reports/:id/approve`) | ✅ (nis2.\<sub\>) | NIS2 change log (`blueeye_audit_log`) | no |
| `POST/PUT/DELETE /api/test-packages/*` | ✅ (test-package.\*) | — | no |
| `POST /agents/enroll` | ⛔ skipped (`/agents/enroll*`) | `audit_events` written **explicitly** on success (`agent.enrolled`, `agentEnroll.js:74`) | no |
| `POST /agents/results` · `/probe-results` | ⛔ skipped | `audit_events` on ingest (`agent.traffic-report` / `run-test` / `probe` / `probe-failed`) | no |
| **`POST /agents/me/capabilities`** | ⛔ skipped (`/agents/me/*`) | **NONE** | no |
| **`POST /speedtest/upload` · `/speedtest/results`** | ⛔ no `req.user` (agent token) | **NONE** | no |

### 5d. Gaps / observations for the refactor
- **3 mutating endpoints write no audit record at all:** `POST /agents/me/capabilities`,
  `POST /speedtest/upload`, `POST /speedtest/results` — all agent-token writes. The
  capabilities update mutates `agents.capabilities`; the speedtest posts persist
  measurement rows. If agent-attributed audit matters, these are blind spots (other
  agent ingest paths *are* audited on ingest, so the pattern is inconsistent).
- **Audit is fragmented across 6 stores** with three different writer styles (global
  middleware, the `audit_log` service, and direct repo calls incl. the two-state
  `agent_action_audit`). `audit_events` and `audit_log` overlap heavily (login lands in
  *both*). Consolidating the two general-purpose trails, and giving the agent-token
  mutations a consistent ingest-time audit, would be a clean refactor target.
- The two-state pattern is robust but **depends on the agent echoing `auditId` back
  over WS**; a record can sit in `requested` indefinitely if the agent never reports
  (only delivery-time failures are flipped to `failed`).

---

## 6. Alerting outputs + ITSM connectors — where dispatch is duplicated

### 6a. The two output families
**Alerting channels** (analysis findings → notifications), constructed in
`server.js:311-316`, set is fixed to **{email, webhook, syslog}**:

| Output | File | Transport |
| --- | --- | --- |
| email | `analysis/alerting/channels/email.js` | SMTP via lazy nodemailer |
| webhook | `analysis/alerting/channels/webhook.js` | HTTP POST + optional HMAC, **raw `fetchImpl`** |
| syslog | `analysis/alerting/channels/syslog.js` | RFC5424 over UDP/TCP |
| **"ISE"** | *(does not exist as a channel)* | **Cisco ISE is only a downstream consumer of the syslog channel** — `syslog.js:9` maps severities so "a collector (e.g. Cisco ISE) sees the right level"; confirmed in `docs/alerting.md:17` and `.env.example:154`. No pxGrid/RADIUS/ISE-specific code exists. |

**ITSM/IPAM connectors** (domain events → external systems), registry
`integrations/connectors/index.js`:

| Connector | File | Events |
| --- | --- | --- |
| ServiceNow | `integrations/connectors/serviceNow.js` | `incident`, `anomaly` |
| Nautobot | `integrations/connectors/nautobot.js` | `agent.enroll`, `agent.delete` |
| webhook | `integrations/connectors/webhook.js` | `incident`, `anomaly`, `agent.enroll`, `agent.delete` |

### 6b. Two parallel dispatch engines (the core duplication)
`analysis/alerting/dispatcher.js` (`createDispatcher`) and
`integrations/dispatcher.js` (`createIntegrationsDispatcher`) are **distinct instances
wired separately** (`server.js:309` vs `:239`) and **both receive every finding**:

- `analysis/pipeline.js:72` → `dispatcher.dispatch(finding, group)` (alerting) **and**
  `:145` → `integrationTrigger.emitFinding(finding)` (integrations).
- `analysis/probePipeline.js:95` → `dispatcher.dispatch(...)` **and** `:104` →
  `integrationTrigger.emitFinding(...)`.

So a single CRIT finding fans out through **two independent dispatch stacks**, each of
which re-implements the same cross-cutting concerns:

| Concern | Alerting dispatcher | Integrations dispatcher | Duplicated? |
| --- | --- | --- | --- |
| Per-target fan-out + per-target error isolation + `results[]` summary | `dispatch()` loop (`:55-76`) | `emit()`/`fireOne()` (`:136-153`) | **yes** — two near-identical loops |
| Throttle / cooldown via a `Map` of last-sent timestamps | `lastSent` keyed `host\|metric\|kind\|severity` (`:20,44-49`) | `lastFired` keyed `integ\|event\|correlation` (`:35,115-126`) | **yes** — two separate throttle impls |
| "Test one target" path (bypasses throttle) | `test(channelName)` (`:103`) → `POST /api/alerting/test` | `testFire(integrationId)` (`:200`) → `POST /api/integrations/:id/test` | **yes** — two test paths + two routes |
| Enable/disable per target | `rule.enabled` | `findEnabledWithSecret()` | parallel |
| Retry w/ backoff | **absent** | `sendWithRetry()` (`:88-105`) | divergent |
| Per-fire audit | **absent** | `integration_audit` (`:63-83`) | divergent |
| Severity→target mapping | `rank()` + per-channel `minSeverity`; `SYSLOG_SEVERITY` | `findingEvent()` CRIT→incident else anomaly; `impactUrgency()` | each re-maps CRIT/WARN/INFO independently |

### 6c. Concrete code duplication: webhook implemented twice
- `analysis/alerting/channels/webhook.js` and `integrations/connectors/webhook.js`
  both POST JSON and both compute **the identical HMAC signature**
  `crypto.createHmac('sha256', secret).update(body).digest('hex')` into the **same
  header** `X-BlueEye-Signature: sha256=<hex>`. The connector's own comment says it
  signs *"exactly like the alerting webhook channel"* (`connectors/webhook.js:11-13`).
- They differ only in HTTP plumbing, and that difference is itself a defect born of the
  split: the **integration** webhook goes through `integrations/httpClient.js`
  (`requestJson` — AbortController timeout, **SSRF guard** `baseUrlBlockedReason`,
  `redirect:'manual'`), while the **alerting** webhook calls `fetchImpl` directly with
  **no timeout, no SSRF guard, no redirect control** (`channels/webhook.js:30`). So the
  two "same" outputs have different safety properties.

### 6d. Dispatch trigger points (for reference)
- Findings → alerting `dispatcher.dispatch` + integrations `emitFinding`:
  `analysis/pipeline.js`, `analysis/probePipeline.js`.
- Agent lifecycle → integrations `emitAgentEvent`: `agentEnroll.js:66` (`enroll`),
  `agents.js:588` (`delete`).
- Manual tests: `POST /api/alerting/test` (channel), `POST /api/integrations/:id/test`
  (connector).

### 6e. Refactor takeaway
The two dispatchers share ~70% of their responsibilities (enabled-target fan-out,
identity-keyed cooldown, per-target try/catch, synthetic test-fire, severity mapping)
but were built independently, so retry/audit/SSRF-guard/timeout exist on one side and
not the other, and the webhook + HMAC logic is written twice. A unified "dispatch core"
(shared throttle + fan-out + test harness + outbound HTTP with SSRF guard/timeout),
with channels and connectors as thin adapters, would remove the duplication and close
the alerting-webhook SSRF/timeout gap. "ISE" should be documented as a syslog
*consumer*, not tracked as a separate output.

---

*End of audit. No source files were modified.*
