# BlueEye server — Code map

On-prem network‑monitoring + central‑licensing server. **Node.js + Express + MySQL**,
CommonJS (`require`/`module.exports`), **no build step**, dependency‑free vanilla‑JS
dashboard. This file is a navigation aid: what lives where, and where to change things.

> Sister repos: **blueeye-agent** (runs on customer machines, reports traffic/probes)
> and **blueeye-licens** (signs license proofs verified here).

## Boot flow

```
src/server.js      start(): builds db + repositories + services, wires createApp, listen(),
                   starts the retention scheduler + WS servers, graceful shutdown.
  └─ src/app.js    createApp({ ...deps }): Express app (no listen) — static dashboard,
                   json body, request logger, mounts the API router, 404 + error handler.
       └─ src/routes/index.js  createApiRouter({ ...deps }): mounts every feature router.
```

Everything is **dependency‑injected**: `createApp`/`createApiRouter`/`createXRouter`/
`createXRepository`/`createXService` take their deps as arguments, so the test suite
swaps in fakes (`test-support/fakes.js`). `src/server.js` is the only place that wires
the *real* MySQL pool + concrete services.

- `src/config.js` — env‑driven config (`.env`), production safety checks.
- `src/db.js` — mysql2 pool + `ping`/`close`. `src/migrate.js` — numbered migration runner (`npm run migrate`).
- `src/logger.js` — leveled logger. `package.json` scripts: `start`, `dev`, `migrate`, `test`.

## Directory map

```
src/
├── server.js, app.js, config.js, db.js, migrate.js, logger.js   # boot + infra
├── routes/            # one router per resource (HTTP API) — see table below
├── repositories/      # data access (one per table-ish); pool in, plain objects out
├── auth/              # user JWT (roles) + separate agent-token auth
│   ├── jwt.js password.js roles.js middleware.js   # user side (requireAuth/requireRole)
│   ├── provision.js                                 # shared JIT user provisioning for external auth (LDAP/OIDC/SAML)
│   ├── ldap.js                                      # external LDAP/AD auth (supplements local login)
│   ├── oidc.js saml.js samlXml.js                   # SSO: OIDC (auth-code+PKCE) + SAML 2.0 (SP-initiated, hand-rolled XML-DSig), EU/self-hosted IdPs
│   ├── apiTokenAuth.js                              # API tokens (api_access): authenticates X-API-Key / Bearer → req.user
│   └── tokens.js agentAuth.js                       # agent opaque-token side
├── integrations/      # outbound API integrations (ITSM/IPAM connectors)
│   ├── dispatcher.js  # trigger layer: events → enabled targets (debounce/retry/audit)
│   ├── httpClient.js  # shared outbound HTTP (injected fetch + timeout)
│   └── connectors/    # serviceNow.js, nautobot.js, webhook.js, customItsm.js, customCmdb.js + index.js (registry) + presets.js
├── diagnostics/       # Test area — outbound connectivity + security screening
│   ├── screening.js   # pure, explainable security-posture checks (per target)
│   └── reach.js       # injected-fetch reachability probe (no SSRF block)
├── analysis/          # local, explainable anomaly detection (NO ML, NO cloud)
│   ├── baselines.js detector.js findings.js correlator.js pipeline.js ingest.js
│   ├── probeFindings.js probePipeline.js  # probe results → findings + alerts
│   ├── assistant.js  config.js constants.js dependency-graph.json types.js
│   ├── alerting/      # email/webhook/syslog channels + dispatcher (config.js)
│   └── retention/     # rollup + purge + nightly scheduler (config.js, repo.js)
├── geo/               # flow extraction + offline GeoIP/ASN enrichment + storage
│   ├── extractFlows.js enricher.js provider.js privateIp.js flowPipeline.js
│   └── centroids.js countryCentroids.json
├── flows/             # traffic-type categories (DNS/Facebook…) — categories.js
├── enroll/            # frictionless enrollment: agentSourceStore.js (source bundle
│                      # + cached SHA-256), installScript.js (Docker/Node installer),
│                      # artifactStore.js (legacy binaries), fingerprint.js (cert pin)
├── license/           # Ed25519 license-proof verify + feature gate
│   ├── verify.js publicKey.js licenseManager.js licenseCache.js features.js
├── ws/                # WebSocket servers: agentSocket.js, dashboardSocket.js
├── services/          # settings.js, systemInfo.js, enrollmentStore.js
├── validation/        # per-resource input validation (pure, { value | errors })
├── lib/               # csv.js (RFC4180 + injection guard), canonicalize.js, secretBox.js (AES-256-GCM secrets at rest)
└── middleware/        # asyncHandler.js, errorHandler.js, requestLogger.js

public/                # dependency-free dashboard SPA
├── index.html         # shell + top tab bar (data-view buttons)
├── app.js             # the whole SPA: views.*, render(), el() DOM helper, api()
└── styles.css         # light default + [data-theme=…] palettes (dark, nord, …); hand-written CSS vars

migrations/NNN_*.sql   # numbered, tracked in schema_migrations (schema.sql = full snapshot)
docs/                  # per-feature docs (analysis, geo, alerting, retention, ...)
scripts/               # seed-superadmin.js, seed-demo.js, dev-bootstrap.js, deploy.sh
test/, test-support/   # node --test specs + fakes (makeApp, makeXRepo, authHeader)
```

## HTTP API (routers)

Mounted in `src/routes/index.js`. User endpoints use JWT + roles
(`viewer` < `operator` < `admin`); agent endpoints use the opaque agent token.

| Mount | File | Auth | Purpose |
| --- | --- | --- | --- |
| `/health` | health.js | none | liveness + db ping |
| `/auth` | auth.js | none | login → JWT (tries **LDAP/AD** first when enabled, else local); `/sso` lists live SSO methods for the login screen; **`/change-password`** (authenticated) — forced first-login change for one-time-password users + self-service change, revokes older tokens |
| `/auth/oidc` | oidc.js | none | **SSO (OIDC)** browser flow: `/login` (302 → IdP, PKCE) + `/callback` (verify id-token → JIT user → JWT). Gated by `sso_oidc` |
| `/auth/saml` | saml.js | none | **SSO (SAML)** SP-initiated flow: `/login` (302 → IdP) + `/callback` (ACS: verify signed assertion → JIT user → JWT) + `/metadata`. Gated by `sso_saml` |
| `/users` | users.js | admin | user CRUD (last-admin protected) + **local invite with a one-time password** (`POST /local`, `POST /:id/resend-temp-password`, `GET /local-availability`) — only when no SSO/LDAP is active (else 403); emails the password, forces a first-login change. See docs/user-local-otp.md |
| `/me` | me.js | viewer+ | current user: profile + **personal UI preferences** (colour theme) |
| `/locations` | locations.js | viewer+/op/admin | sites + per-location live traffic |
| `/agents` (3 routers) | agents.js · agentReports.js · agentEnroll.js | JWT / agent-token / none | CRUD + run-test + **run-probe** + **install-tool** (operator+, install a missing diagnostic tool on the host — allowlisted, audited) + **connection** (viewer+, explainable why-is-it-disconnected verdict) + **reconnect** (operator+, force a live agent to re-dial — docs/agent-connection.md); agent self-report (`/results`, `/probe-results`, `/me/config`, `/me/capabilities`); enroll |
| `/enrollment-codes` | enrollmentCodes.js | operator+ | enrollment codes (single-use or **bulk / multi-use**) |
| `/enroll` | enroll.js | none | **frictionless enrollment**: `/config`, `/agent-source.tgz` (agent source bundle + SHA-256, served locally — air-gap-friendly), `/agent-release(.tgz)` (signed release + manifest), `/agent-release-key` (release public key the agent pins for signed self-updates), `/uninstall.sh`, `/agent/:platform` (legacy pre-built binary), `/:code/install.sh` (self-contained installer: verifies the source, then installs natively via Node+systemd by default — Docker opt-in via `BLUEEYE_RUNTIME=docker`) |
| `/api/enroll` | enrollCommand.js | operator+ | **install-command generator** (`/command`: one-liner + manual/checksum; mints or reuses a code) |
| `/license` | license.js | viewer+ | license status + features + plan/usage/**matrix** (feature `status`: available/roadmap) |
| `/api/api-tokens` | apiTokens.js | admin (gated `api_access`) | **API tokens** — mint/list/revoke; secret shown once, hashed at rest |
| `/api/audit-log` | auditLog.js | admin (gated `audit_log`) | **unified audit log** — auth/user/role/license/report/api_token events; `?category=&user=&limit=` |
| `/system` | system.js | viewer+ | storage/disk + **MySQL & TimescaleDB** db sizes (split) + ingest estimate |
| `/api/findings` | findings.js | viewer+ | analysis findings + ack |
| `/api/assistant` | assistant.js | viewer+ (gated) | opt-in AI: `/explain` (per-host Q&A) + **`/location-summary`** (per-location "what's going on?") |
| `/api/geo` | geo.js | gated | geo overview + flow selection |
| `/api/alerting` | alerting.js | admin | channel config + test |
| `/api/map` | map.js | viewer+ | effective tile/geocoder config |
| `/api/settings` | settings.js | admin | editable map / **analysis** / **retention** / **flow-categories** / **AI assistant** (enable + provider + API key + model + custom endpoint) / **alerting** (channels + secrets, write-only) |
| `/api/export` | export.js | viewer+ | CSV/JSON export + **investigation bundle** (`/investigation`: per-agent health+probes+interfaces+findings+flows, JSON or event-log CSV; print→PDF client-side) |
| `/api/flows` | flows.js | viewer+ | **traffic-type categories** (`/categories`) + **conversation explorer** (`/explore`: talkers/ports/protos/series + scan/fan-out) |
| `/api/transactions` | transactions.js | viewer+ read / admin write | **transaction tests** (http/tcp/dns/icmp) — CRUD (secrets write-only, `{{secret:name}}` refs) + `PUT /:id/agents` + `GET /:id/results?from&to&agent_id` + `GET /:id/heatmap?from&to&bucket` (avg_latency/fail_count/sample_count per bucket per agent) + `GET /:id/trend?agent_id&days` (median per day per step). Agents get config + report results over `/ws/agent` (`transaction_config`/`transaction_result`); threshold alerts reuse the alerting dispatcher. Repo `src/repositories/transactionsRepository.js`, validation `src/validation/transactionValidation.js`, alert eval `src/analysis/transactionAlerts.js`, MAD baseline job `src/analysis/transactionBaselines.js` |
| `/api/probes` | probes.js | viewer+ | **active-probe** results (ping/tcp/dns/traceroute/**http**/**curl**/**pageload**/**transaction**); `/path` → **path-visualisation graph** (hop nodes+links with loss/latency/jitter + GeoIP/ASN, `src/analysis/pathGraph.js`) |
| `/api/reports` | reports.js | viewer+ / operator+ | **availability** (uptime % from probes) + **incidents** list (viewer+); CSV (`.csv`, gated `reports_csv`) + print-ready HTML→PDF (`.html`, gated `reports_pdf`); **NIS2 draft** (`/nis2-draft/:id`, operator+) |
| `/api/thresholds` | thresholds.js | viewer+ read / admin write | **incident thresholds** — global defaults + per-location overrides |
| `/api/incidents` | incidents.js | viewer+ read / operator+ write | **first-class incidents** (`incident_cases`, wraps analysis findings): `GET` (filter status/severity/device/time) + `GET /:id` (+ linked anomalies + a light `explanation` what/where/why) + `GET /:id/timeline` + `GET /:id/config-context` (op+) + `GET /:id/similar` + `GET /:id/recommendation` (combined playbook→history→AI, `?force_ai=true` op+) + `PATCH /:id` (op+, state machine, hash-chained audit) + `POST /:id/ask` (op+, opt-in EU AI over masked/aggregated context). **Distinct** from the probe-outage `incidents` surfaced by `/api/reports`. See `docs/incident-cases.md` |
| `/api/devices` | deviceConfig.js | operator+ | **device config history**: `GET /:id/config-history` (masked snapshots + risk-classified diffs) + `POST /:id/config-snapshots` (manual ingest of a raw config capture) |
| `/api/fleet` | fleet.js | viewer+ | **fleet health** rollup (`/health`) + per-agent verdict (`/agent/:id`) + **NIC firmware inventory / drift** (`/nics`) |
| `/api/dashboard` | dashboard.js | viewer+ (gated `dashboard_advanced`) | Overview **“open issues”** rollup (`/advanced`): **open `incident_cases`** + probe-outage incidents + recent findings, surfaced inline on the Overview, Professional+ |
| `/api/interfaces` | interfaces.js | viewer+ | **interface health** (util/errors/discards/link) |
| `/api/search` | search.js | viewer+ | **global search** (agents/hosts/locations + IP/port → agents) |
| `/api/integrations` | integrations.js | admin | **outbound API integrations** (ITSM ticketing + Nautobot CMDB/IPAM sync + generic/`custom` config-driven connectors): CRUD + `/meta` (types + category + presets) + manual test-fire; credentials encrypted at rest. UI = **Settings → ITSM** (`settingsIntegrationsView`) |
| `/api/diagnostics` | diagnostics.js | admin | **Test area** — consolidated connectivity + security screening of every outbound integration (email/alert channels, ITSM/IPAM, SSO, AI/map/licence). `/targets` (catalogue + posture) + `/run`. Reuses each subsystem's own test primitive; each UI row deep-links to its setup. No secrets returned |
| `/api/ldap` | ldap.js | admin | **LDAP/AD auth** config + group→role map + connectivity test + login audit (`/login-audit`); writes licence-gated (`sso_ldap`, Professional) |
| `/api/oidc` | oidc.js | admin | **SSO (OIDC)** status + claim→role map + discovery test + login audit; writes licence-gated (`sso_oidc`, Professional). Connection from env vars |
| `/api/saml` | saml.js | admin | **SSO (SAML)** status + attribute→role map + login audit; writes licence-gated (`sso_saml`, Professional). Connection from env vars |
| `/api/audit` | auditEvents.js | admin | **Reporting → Audit** — unified server-wide audit trail (user actions + agent activity); `/` (filterable list), `/actions` (distinct), `/export.csv`. Writes come from the audit middleware + agent ingest, not HTTP |
| `/api/nis2` | nis2.js | viewer+ read / operator+ write / admin approve | **Reporting** (UI tab) — **NIS2** module: `/dashboard` (readiness score + category status + top actions), `/risks` `/controls` `/incidents` `/evidence` (CRUD), `/reports` (+ `/:id/approve`), `/audit` (admin), `/seed` (starter controls), `/export/*.csv` + `/export/*.html` (print→PDF); **Report Generator**: `/custom-reports/sources` + `/custom-reports/{preview,export}` (selector-driven custom reports, HTML/CSV/JSON) |

## Data model (MySQL)

Core tables (`schema.sql` + early migrations): `users`, `locations`, `agents`,
`agent_tokens`, `enrollment_codes`, `results` (one JSON `payload` per measurement).
Later migrations add:

| Migration | Table | Used by |
| --- | --- | --- |
| 009 | `findings` | analysis |
| 010 | `flow_records` | geo (enriched flows) |
| 011 / 012 | `flow_rollup` / `metric_rollup` | retention down-sampling |
| 013 | `app_settings` | runtime-editable settings (key/JSON) |
| 014 | `probe_results` | active probes |
| 015 | (index only) | `idx_probe_ts` for the fleet-wide probe scan |
| 019 | `probe_results.status` / `.cert_expiry_days` | http probe (status + TLS cert expiry) |
| 032 | `probe_results.bytes` / `.content_type` | curl content-check probe (received byte count + content-type; pass/fail rides on `detail`) |
| 033 | `probe_results.elements` | pageload probe waterfall — JSON `[{url,kind,status,bytes,ms}]` (rtt_ms = total load time, bytes = page weight) |
| 020 | (column) | per-user UI preferences — `users.preferences` JSON (colour theme) |
| 021 | (column) | `agents.enrollment_code_id` → links an agent to the code it enrolled with (Enrollment page shows each code's agents + live status); `ON DELETE SET NULL` |
| 022 | `agent_action_audit` | server-initiated agent actions (upgrade/delete) |
| 024 | `incident_thresholds` | incident derivation — per-metric warn/crit + debounce; global default (`location_id` NULL) + per-location override; seeded |
| 025 | `incidents` | incident derivation — one row per (agent, metric, target) outage; `started_at`/`resolved_at`/`duration_seconds` |
| 026 / 027 | `integrations` / `integration_audit` | outbound API integrations + per-fire audit (credentials encrypted at rest) |
| 028 / 029 | `ldap_config` + `ldap_role_map` / `ldap_login_audit` | LDAP/AD auth config + group→role map + login audit (bind password encrypted at rest) |
| 031 | `blueeye_nis2_risks` · `blueeye_nis2_controls` · `blueeye_nis2_incidents` · `blueeye_nis2_reports` · `blueeye_nis2_evidence` · `blueeye_audit_log` | **NIS2 Reporting Center** — risk register, control evidence, security incidents, generated reports (with frozen metric snapshots for trend), evidence references + a generic change audit log |
| 033 | `audit_log` | **unified audit log** (feature `audit_log`) — auth/user/role/license/report/api_token events; metadata only, never secrets |
| 034 | `api_tokens` | **API tokens** (feature `api_access`) — programmatic access; only the SHA-256 hash stored, role-scoped |
| 035 | `audit_events` | **unified, server-wide audit** (Reporting → Audit) — user actions (audit middleware) + agent activity (on ingest); recurring activity folded onto one row via a nullable UNIQUE `dedup_key`. Agent activity includes `agent.probe-failed` — a probe the agent could not execute (e.g. `traceroute` missing), with the reason in `detail.reason` — `agent.error`, a non-fatal operational error the agent reports over the WS channel (recorded in `src/ws/agentSocket.js`, deduped per category) so agent-side failures are visible server-side, and the agent **lifecycle**: `agent.enrolled` (new agent via a code, in `src/routes/agentEnroll.js`) + `agent.online`/`agent.offline` (each WS connect/disconnect, discrete rows with source IP) |
| 036 | (column) | extends `agent_action_audit.action` with `'install-tool'` — operator- or auto-triggered request that an agent install a missing diagnostic tool (request→complete like upgrade/delete; tool in `target_version`). See `src/agentTools.js`, `services/installToolService.js` |
| 051 · 052 | `cmdb_config` · `agent_cmdb_links` | **CMDB integration** (single source of truth) — one singleton connection config for ONE CMDB source (ServiceNow, Nautobot, **or a config-driven `custom` HTTP/JSON CMDB** — migration 052 adds the `custom` type + `config_json`; credentials AES-256-GCM at rest via secretBox, never returned) + per-agent asset links (`agent_id` PK, FK cascade on agent delete; captures the asset's CMDB location, which **syncs the agent's site** — `agents.location_id` — by matching a BlueEye location by name, creating one if absent). Reuses the integrations connector registry for the connection test + asset search |
| 046 | `transaction_tests` · `transaction_test_agents` · `transaction_results` · `transaction_baselines` | **transaction tests** (http/tcp/dns/icmp journeys) — normalized: one test row (type ENUM + target + JSON config incl. thresholds + AES-256-GCM `config_secrets`), an agent-assignment join, one result row per run (`time`, status ENUM, `step_timings`, `step_failed`, `deviation`, structured `detail`; **no FKs** — TimescaleDB-bound), and per-(test,agent,step) median+MAD baselines recomputed hourly (leader-only, `src/analysis/transactionBaselines.js`, reuses `analysis/baselines.js`). Config pushed + results ingested over WS. Supersedes the dead-in-prod migration 045 (dropped here) |
| 047 | `incident_cases` | **incidents as a first-class entity** wrapping analysis findings — status (open/investigating/resolved/closed) + severity + auto-title, `primary_finding_id`→findings, `config_change_id`→config_snapshots (mig 050), `closed_by`→users, `created_by` system/manual. **Distinct** from the probe-outage `incidents` (mig 025) |
| 048 | `findings.incident_case_id` | nullable FK linking an anomaly (finding) to its incident case (`ON DELETE SET NULL`) — the grouping key |
| 049 | `config_snapshots` | raw device-config captures (`device_id`→agents, `config_text`, `captured_at`, `captured_via` manual/agent_poll/change_detected); operator/admin + secret-masked on read; retention via `RETENTION_CONFIG_SNAPSHOT_DAYS` (default 180d) |
| 050 | `incident_cases.config_change_id` | nullable FK → `config_snapshots` — the config change auto-correlated (within a configurable window, default 30m) as the suspected trigger |
| 053 | (retire) | **retire Enterprise + HA** — drops the `ha_nodes` table (HA removed) and reconciles `license_plans`/`licenses` after the plan catalogue collapsed to Pilot/Starter/Professional (Enterprise + MSP retired) |
| 056 | (columns) | **local user creation with a one-time password** — `users.must_change_password` / `.temp_password_expires_at` / `.temp_password_created_by` (FK→users, ON DELETE SET NULL). See docs/user-local-otp.md |
| 055 | `remediation_playbooks` · `incident_playbook_runs` | **remediation playbooks** — pre-defined responses keyed to an anomaly-type (`trigger_condition` matched exactly against the incident's primary finding metric; either `auto_trigger` or a `manual_action_text` runbook) + the incident↔playbook run link (outcome recorded per incident). Read by the incident **recommendation** endpoint |

Interface health, traffic-type categories and **fleet health** add **no** tables — they
derive from the existing `results.payload.traffic` (and `flow_records.asn` for org
categories); fleet health is computed in `src/health/probeHealth.js` from `probe_results`.

## Dashboard (`public/app.js`)

A single vanilla-JS SPA. Key building blocks:
- `el(tag, attrs, ...kids)` — DOM helper. `api(path, opts)` — fetch + bearer + 401 handling.
- `views.<tab>` — async function per tab returning a node (`fleet` (landing,
  UI label **“Overview”** — ends with a gated **“Open issues”** rollup
  (`fleetIssues()`, incidents + findings, `dashboard_advanced`) for Professional+),
  `overview`, `map` (UI label **“Sites”** — locations coloured by agent health),
  `geo` (UI label **“Destinations”** — external traffic by country/ASN),
  `agents`, `interfaces`, `nics` (NIC firmware inventory + drift), `probes`, `flows`, `screening` (**Test area** — admin-only outbound screening), `findings`, `locations`, `enrollment`,
  `docs` (**Documentation** — built-in handbook: getting-started + troubleshooting how-tos for everyone, admin-only setup guides; static, RBAC-gated content),
  `settings`) plus `agent` (the combined per-agent drill-down page, no tab —
  reached via `openAgent(id)`). Both maps init via the shared `createLeafletMap`
  (server-configured EU/self-hosted tiles).
- `render()` — mounts the current view + its `hero()`; stops per-view pollers
  (`stopOverview`/`stopProbes`/`stopIfaces`/`stopFleet`/`stopAgent`/`stopGeo`) when leaving.
- Shared renderers `interfaceTable()` / `probeLatestTable()` / `probeDetail()` back both
  the standalone tabs and the combined agent page.
- `PAGE_INFO` — per-page hero line + "Mere info" drawer text.
- Charts are hand-rolled SVG: `multiChart` (live, area + time ticks + brush) and
  `historyChart` (time-axis; optional `band` = robust normal-range shading via
  `robustBand`, `markers` = event lines via `findingMarkers`). `usageBar()` for utilisation bars.
- Theme: a catalogue of colour palettes (`PALETTES`: default/midnight/nord/forest/sunset/
  solarized/contrast), each in a **light + dark** variant. Pick a palette in **Settings →
  Appearance**; the **account menu**'s "Dark mode" row (topbar `#user-menu`, `#theme`)
  flips brightness within it (`dual`). **Saved per user** (`/me/preferences`), cached in
  localStorage for instant apply. Mobile: tab bar → bottom nav.

- Topbar account menu (`#user-menu` in `index.html`): one dropdown, opened from a trigger
  showing the signed-in user (`#whoami` = email + role badge) + a chevron. Houses **Refresh**
  (full `location.reload()`) with the **auto-refresh** toggle (`#autorefresh`; persisted in
  `localStorage` under `AUTOREFRESH_KEY`, restored + started on load, reload on change),
  **Dark mode** (`#theme`) and **Log out** (`#logout`). Closes on outside-click + Escape.

## Where do I change…?

| Task | Start here |
| --- | --- |
| A new HTTP endpoint | `src/routes/<x>.js` + mount in `routes/index.js` + a fake in `test-support/fakes.js` |
| A DB table/column | new `migrations/NNN_*.sql` + repository in `src/repositories/` |
| Anomaly thresholds / detection | `src/analysis/detector.js`, `config.js` (editable via Settings→Analysis) |
| Alert channels | `src/analysis/alerting/channels/*` + `dispatcher.js`; runtime-editable via Settings→Alerting (`settingsService.getAlerting/setAlerting`, `PUT /api/settings/alerting`, UI `settingsAlertingView` in `public/app.js`) — live-applied onto the running `alertingConfig`, secrets write-only |
| Maintenance windows / silencing | `src/analysis/alerting/maintenance.js` (`createSilencer`) + dispatcher hook; windows in `settingsService` (`maintenance` key), route `/api/settings/maintenance` |
| Data retention | `src/analysis/retention/*` (editable via Settings→Retention) |
| Storage backends (MySQL + optional TimescaleDB) status | `settingsService.getTsdb()` (read-only, env-driven — the pg pool is boot-time infra, no `setTsdb`) exposed on `GET /api/settings`; live sizes on `GET /system/storage` (`services/systemInfo.js`). **UI: Settings → Database** (`settingsDatabaseView`) with status + how-to. Configure via `TSDB_*` env (`src/config.js`) + `deploy/install-timescale.sh`; see `docs/storage-split-audit.md` |
| Geo/ASN enrichment | `src/geo/enricher.js`, `provider.js`; flows in `flowsRepository.js` |
| Traffic-type categories | `src/flows/categories.js` (editable via Settings→Traffic types) |
| Flow/conversation explorer | `flowsRepository.exploreFlows` + `src/routes/flows.js` (`/explore`); UI `views.flows` |
| Active probes (server) | `src/routes/probes.js`, `probeResultsRepository.js`, `validation/probeValidation.js` (probe types incl. `http` + `curl` + `pageload` + multi-step `transaction`) — agent side in blueeye-agent `src/probes/` |
| Path visualization (traceroute map) | `src/analysis/pathGraph.js` (`buildPathGraph` — aggregates traceroutes → hop graph, geo/ASN, severity), `GET /api/probes/path`; UI `pathGraph()` in `public/app.js` (traceroute detail) — SVG topology **+ a geographic Leaflet map** (`drawPathMap`/`pathGeoStops`/`renderPathStops`, source anchored at the agent site via `agentsRepo` `location_lat/lng`); also a **path picker in `views.geo`/Destinations** (`drawGeoPath`). Per-hop loss/jitter come from MTR-style agent traceroute. See `docs/path-visualization.md` |
| AS-path view + change detection (BGP-flavoured) | `src/analysis/asPath.js` (`extractAsPath`/`diffAsPath` = observed forwarding AS-path + change classification; `asGraphFromNodes` = AS-level projection of the hop graph). API: `asGraph` block on `GET /api/probes/path` (`routes/probes.js`). UI: **Hop view / AS view** toggle in `pathGraph()` (`public/app.js`). Findings: `asPathFindings` in `src/analysis/probeFindings.js`, fed a `geoProvider` via `probePipeline.js` (wired in `src/server.js`) → reroute/origin-AS-change findings (`probe.aspath`) through the normal store/alerting pipeline. Data-plane only (not BGP `AS_PATH`). See `docs/path-visualization.md` |
| Incident derivation (open/resolve) | `src/incidents/detection.js` (pure: threshold + debounce + first-failure/recovery rules), `src/incidents/incidentService.js` (reconciles vs. stored incidents, run on probe-results ingest in `routes/agentReports.js`); `incidentsRepository.js` + `incidentThresholdsRepository.js`. See `docs/incidents.md` |
| Incident reports / NIS2 draft | `src/routes/reports.js` (availability + incidents + `/nis2-draft/:id`), `src/incidents/nis2.js` (English CFCS template); availability query in `probeResultsRepository.availability` |
| Incident thresholds | `src/routes/thresholds.js` + `incidentThresholdsRepository.js` (global default vs. per-location override); validation in `validation/incidentValidation.js` |
| Incidents platform (grouped anomalies, `incident_cases`) | `src/incidentCases/` — `incidentCaseService.js` (auto-group findings per device within the correlator window + auto-correlate a config change ≤30m before), `stateMachine.js`, `autoResolveJob.js` (leader-only inactivity resolve), `timeline.js`, `similarity.js`, `askContext.js`/`askCache.js` (masked AI context) — + `repositories/incidentCasesRepository.js`; router `src/routes/incidents.js` (`/api/incidents`, incl. `POST /:id/ask` reusing `analysis/assistant.js`). Overview widget in `src/dashboard/advancedDashboard.js`. UI `views.incidents`/`views.incident` in `public/app.js`. Migrations 047/048/050. **Distinct** from probe-outage incidents above. See `docs/incident-cases.md` |
| Incident recommendation (playbook → history → AI) | `GET /api/incidents/:id/recommendation` in `src/routes/incidents.js` — one combined answer in three ordered sections: (a) `matching_playbook` (looked up by the primary anomaly-type via `remediationPlaybooksRepository.matchByAnomalyType`; shows a prior run's result when the playbook already ran on this incident), (b) `historical_matches` (reuses the Fase-4 `rankSimilar` helper, **resolved-only**), (c) `ai_suggestion` (Mistral fallback — only when a+b are empty or `?force_ai=true`, operator+; reuses the masked `gatherIncidentAskContext` + `assistant.suggestRemediation` + `askCache`, never fabricates a fix, `source:"ai_generated"`). Pure section assembly + the `shouldGenerateAi` ordering predicate in `src/incidentCases/recommendation.js`; playbook schema/data-access in `src/repositories/remediationPlaybooksRepository.js` (migration 055) |
| Incident explanation (what/where/why) | `src/incidentCases/explanation.js` (`buildExplanation`) — a light, separate section on `GET /api/incidents/:id` (NOT bundled into the recommendation): `what` = anomaly-type + severity, `where` = device/label/interface (+ Fase-6 topology, forward-compat), `why` = the finding evidence-array. `why` prefers a registered confidence model (`CONFIDENCE_MODELS`, empty today) and otherwise falls back to the RAW trigger-data (`observed`/`baseline`/`deviation` + evidence), `source:"raw_trigger"` — the documented fallback, not an error |
| Device config snapshots / diff / risk | `src/config/` — `diff.js` (uses the `diff` lib), `risk.js` (rule-based ACL/routing/interface=high), `mask.js` (IP + secret masking), `configContext.js` (masked+classified diff) — + `repositories/configSnapshotsRepository.js`; router `src/routes/deviceConfig.js` (`/api/devices/:id/config-history` + `POST /:id/config-snapshots`). Retention in `analysis/retention/` (`RETENTION_CONFIG_SNAPSHOT_DAYS`). UI = agent-page "Config history" card in `public/app.js`. Migration 049. See `docs/incident-cases.md` |
| Probe findings + alerting | `src/analysis/probeFindings.js` (verdict→findings, reuses `health/probeHealth.js`) + `probePipeline.js` (runs on probe-results ingest in `routes/agentReports.js`) |
| AI assistant (explain + location summary) | `src/analysis/assistant.js` (OpenAI-compatible; opt-in; reads enable/provider/key/model/baseUrl live from the analysis config) + `src/routes/assistant.js`; provider presets (EU: Mistral/Scaleway/OVHcloud/IONOS/Aleph Alpha · US: OpenAI/Anthropic/Gemini/Groq/Together/OpenRouter/Azure · DeepSeek · Ollama self-hosted · custom — every entry region-tagged, admin's choice) = `src/analysis/assistantProviders.js` (`azure`/`custom` need an admin base URL). Runtime config (enable + provider + API key + model + custom endpoint): `settingsService.getAssistant/setAssistant` (`src/services/settings.js`), `PUT /api/settings/assistant`, UI `assistantSettingsCard` in its own **Settings → AI** tab (`settingsAiView`) |
| Fleet health (overview + verdicts) | `src/health/probeHealth.js` (`computeAgentHealth`/`mergeHealth`/`computeFleet`, median+MAD — folds in interface health), `src/routes/fleet.js`; UI `views.fleet`/`views.agent` |
| NIC firmware inventory / drift | `src/health/nicInventory.js` (`computeNicInventory`, groups by driver+PCI id, flags firmware outliers) from agent-reported `capabilities.nic`; HTTP `GET /api/fleet/nics` in `src/routes/fleet.js`; UI `views.nics` + per-agent NIC card in `views.agent`. Agent side in blueeye-agent `src/nicInfo.js` (`ethtool -i`) |
| Interface health | `src/health/interfaceHealth.js` (`computeInterfaceHealth`/`interfaceHealthSummary`); HTTP in `src/routes/interfaces.js` — agent side in blueeye-agent |
| Agent data-quality (drops/skew/version) | `src/health/dataQuality.js` (`computeDataQuality`); surfaced via `/api/fleet/health` + `/api/fleet/agent/:id` — all signals already sent by the agent |
| Per-agent traffic source (proc/snmp/netflow/sflow) | stored in `agents.monitor_config` (JSON); validated by `validateMonitorConfig` in `src/validation/agentValidation.js`; edited via `PUT /agents/:id` (`editAgent` modal in `public/app.js`); served to the agent by `GET /agents/me/config` (`src/routes/agentReports.js`). **Fleet-wide default** for newly enrolled agents lives in Settings → Agents (`agents` app_settings key: `defaultTrafficSource`/`defaultSflowHsflowd`, `settingsService.getDefaultMonitorConfig`), stamped onto the agent row at enroll (`services/enrollmentStore.js` via `routes/agentEnroll.js`); per-agent Edit always overrides it |
| A dashboard tab/view | `public/index.html` (button) + `views.<x>` in `public/app.js` + `PAGE_INFO` |
| Documentation / how-to content (Documentation tab) | `views.docs` + the `DOCS` content array + `docs*` helpers in `public/app.js` (static, no backend); reached from a **Documentation pill in the sidebar footer** (`.foot-docs`, `data-view="docs"`) beside the version line in `public/index.html` — not a nav-rail item; `PAGE_INFO.docs`; `.docs-*` + `.foot-docs` CSS. RBAC: the `Administration & setup` section carries `admin:true` and is dropped for non-admins. Prose guide in `docs/documentation-center.md` |
| Overview “open issues” rollup (incidents + findings) | feature `dashboard_advanced` (Professional+): `src/dashboard/advancedDashboard.js` (pure `buildAdvancedDashboard`) + `src/routes/dashboard.js` (`GET /api/dashboard/advanced`, gated by `requirePlanFeature`); UI `fleetIssues()` + `refreshIssues()` inside `views.fleet`, documented in `PAGE_INFO.fleet`. Merged into the Overview — no separate tab; below Professional the rollup is omitted |
| A dashboard colour palette (light+dark) | `PALETTES` + paired `[data-theme=…]` blocks in `public/styles.css`; picker `settingsAppearanceView` in `public/app.js`; per-user persistence via `/me` (`src/routes/me.js`, `usersRepository.get/updatePreferences`) + key whitelist in `src/validation/preferencesValidation.js` |
| License / feature gating | `src/license/*` (`features.js` = fail-closed gate + `requirePlanFeature` middleware; `plans.js` = plan/feature catalogue incl. `status` available/roadmap; `planService.js` = active-plan resolution + limits) + `src/services/usageService.js` (limit enforcement). Read-only API: `/license/plan`, `/license/usage`, `/license/matrix`. Feature **status & roadmap** tracked in **`ROADMAP.md`** + the Settings → License matrix Roadmap badge. See `docs/licensing.md`. |
| API tokens (programmatic access) | feature `api_access`: `src/routes/apiTokens.js` (admin CRUD, gated) + `src/repositories/apiTokensRepository.js` + `src/lib/apiToken.js` (mint/hash) + `src/auth/apiTokenAuth.js` (authenticates `X-API-Key`/`Bearer` → `req.user`, mounted in `routes/index.js`); table `api_tokens` (migration 034) |
| Audit log (who-did-what) | feature `audit_log`: `src/routes/auditLog.js` (admin read, gated) + `src/repositories/auditLogRepository.js` + `src/services/auditLogger.js` (fail-safe recorder); recording wired in `routes/auth.js` (login), `users.js` (user admin), `license.js` (re-validate), `apiTokens.js` + `reports.js`; table `audit_log` (migration 033) |
| Report exports (CSV / PDF) | `src/routes/reports.js` `*.csv` (gated `reports_csv`) + `*.html` (gated `reports_pdf`, print→PDF) via `src/lib/reportHtml.js`; NIS2 compliance pack gated `reports_compliance` in `src/routes/nis2.js` |
| CMDB integration (single source of truth) | migrations `051_create_cmdb.sql` + `052_cmdb_custom_connector.sql` (`cmdb_config` singleton + `agent_cmdb_links`); repos `src/repositories/cmdbConfigRepository.js` + `agentCmdbLinksRepository.js`; validation `src/validation/cmdbValidation.js`; routes `src/routes/cmdb.js` — admin config + connection test (`/api/settings/cmdb`, `/test`, `/meta`), operator+ asset search (`/api/cmdb/assets/search`), and per-agent links (`/api/agents/:id/cmdb-link`). Its **own** connector registry `src/cmdb/connectors.js` (ServiceNow / Nautobot / **`custom`** config-driven `src/integrations/connectors/customCmdb.js`, incl. optional static `headers`) — separate from the integrations registry — `testConnection()`/`search()` + `secretBox`; named presets (NetBox/i-doit/GLPI + built-ins) in `src/cmdb/presets.js`, served by `/meta`. Credentials encrypted at rest, never returned. Linking an asset **syncs `agents.location_id`** (match-or-create a location by the asset's CMDB location name). Also a target in the **Test area** in its own `cmdb` diagnostics group — NOT `itsm` (`screenCmdb` + `cmdb` in `src/routes/diagnostics.js`). **UI: Settings → CMDB** (`settingsCmdbView`, System-preset dropdown) + per-agent card (`loadAgentCmdbLink`, debounced search + removable chip). Docs: `docs/cmdb.md` |
| Outbound integrations (ITSM + CMDB/IPAM sync) | connectors in `src/integrations/connectors/*` (+ `index.js` registry with per-type `category` + `customItsm.js` config-driven "bring your own ITSM"); named presets (Jira/TOPdesk/GLPI + built-ins) in `src/integrations/presets.js`; trigger/debounce/retry/audit in `src/integrations/dispatcher.js`; HTTP in `src/routes/integrations.js`; validation in `src/validation/integrationValidation.js`; tables `integrations`/`integration_audit` (migrations 026/027). Events wired in `analysis/pipeline.js` + `probePipeline.js` (findings) and the enroll/agent-delete routes. **UI: Settings → ITSM** (`settingsIntegrationsView` in `public/app.js` — preset dropdown + CRUD + per-row test, credentials write-only). See docs/integrations.md |
| Test area (outbound screening) | `src/routes/diagnostics.js` (`/api/diagnostics/targets` + `/run`, admin) orchestrates each subsystem's own test primitive (alerting `dispatcher.test`, integrations `testFire`, `ldapAuth.testConnection`, `oidcAuth.testDiscovery`, reachability for SAML/assistant); pure posture lens in `src/diagnostics/screening.js`; reachability in `src/diagnostics/reach.js`; injected `diagnosticsFetch` (server.js → app.js → routes/index.js). UI `views.screening` + `PAGE_INFO.screening` + `.screen-*` CSS; each row deep-links to its setup via `settingsLink`. See docs/diagnostics.md |
| Local user creation (one-time password) | migration `056_user_temp_password.sql`; generator `src/auth/tempPassword.js`; email `src/services/userMailer.js` (reuses alerting SMTP, wired in `src/server.js`); routes `src/routes/users.js` (`POST /users/local`, `POST /users/:id/resend-temp-password`, `GET /users/local-availability`) + `src/routes/auth.js` (`POST /auth/change-password`, login temp-password/expiry handling); forced-change gate + wiring in `src/routes/index.js`; JWT flag `src/auth/jwt.js`+`src/auth/middleware.js`; repo `usersRepository` (`setTempPassword`/`clearTempPassword`); validation `userValidation.js`; UI `public/index.html` `#force-change` + `views.users`/force-change form in `public/app.js`. Gated OFF while SSO/LDAP active (403). See docs/user-local-otp.md |
| LDAP/AD authentication | `src/auth/ldap.js` (bind + group→role; **licence-gated** via injected `featureGate` → `sso_ldap`); login flow in `src/routes/auth.js`; config CRUD + login-audit in `src/routes/ldap.js`; validation in `src/validation/ldapValidation.js`; tables `ldap_config`/`ldap_role_map`/`ldap_login_audit` (migrations 028/029); gates: env `LDAP_AUTH_ENABLED` **+** licence `sso_ldap` (Professional, `src/license/plans.js`). **Dashboard UI = `settingsAuthView` (Settings → Authentication)** in `public/app.js`. See docs/ldap-auth.md |
| SSO (OIDC) | `src/auth/oidc.js` (discovery + PKCE + id-token verify via JWK→KeyObject + `jsonwebtoken`; claim→role; **licence-gated** `sso_oidc`); browser flow `/auth/oidc/login`+`/callback` and admin role-map in `src/routes/oidc.js`; shared JIT provisioning `src/auth/provision.js`; validation `src/validation/oidcValidation.js`; tables `oidc_role_map`/`sso_login_audit` (migration 038); env vars `OIDC_*` (issuer/client id/secret/redirect). **Login-screen buttons** from `GET /auth/sso` in `public/app.js`. See docs/sso-oidc.md |
| SSO (SAML) | `src/auth/saml.js` (SP-initiated; assertion verify via hand-rolled exc-c14n + XML-DSig in `src/auth/samlXml.js` — no XML lib; signature+digest+issuer+conditions+audience+expiry; attribute→role; **licence-gated** `sso_saml`); SP flow `/auth/saml/login`+`/callback`(ACS)+`/metadata` and admin role-map in `src/routes/saml.js`; validation `src/validation/samlValidation.js`; table `saml_role_map` (migration 039) + shared `sso_login_audit`; env vars `SAML_*`. Test signer: `test-support/samlTestkit.js`. See docs/sso-saml.md |
| Encrypting a secret at rest | `src/lib/secretBox.js` (AES-256-GCM, keyed by `SECRET_ENCRYPTION_KEY`→`JWT_SECRET`); store the token in a `*_encrypted` column, decrypt only at use |
| Audit trail (Reporting → Audit) | unified server-wide audit, **admin only**: middleware `src/middleware/auditLogger.js` (records user actions in `res.on('finish')`, mounted in `src/app.js`) + pure helpers `src/audit/actions.js` (`describeRequest`/`redactBody`); agent activity recorded on ingest in `src/routes/agentReports.js`, agent-reported errors (`agent.error`) plus connect/disconnect (`agent.online`/`agent.offline`) over the WS channel in `src/ws/agentSocket.js`, and enrolment (`agent.enrolled`) in `src/routes/agentEnroll.js`; repository `src/repositories/auditEventsRepository.js` (`record` discrete / `recordRecurring` repeat-suppressed via UNIQUE `dedup_key`); read router `src/routes/auditEvents.js` (`/api/audit`); table `audit_events` (migration 035); UI `auditModule()` in `public/app.js` (Reporting → Audit). See docs/audit.md |
| Reporting (NIS2 + Report Generator) | `src/routes/nis2.js` (mounted in `routes/index.js`); pure scoring in `src/nis2/dashboard.js` (`computeDashboard`/`recommendedActions`), report build + print-ready HTML in `src/nis2/report.js`, the selector-driven custom-report engine in `src/nis2/reportBuilder.js` (`SOURCES`/`sourcesFor`/`buildCustomReport`/`customReportToCsv`), shared enums in `src/nis2/constants.js`; repositories `src/repositories/nis2{Risks,Controls,Incidents,Reports,Evidence,Audit}Repository.js`; validation `src/validation/nis2Validation.js`; tables in migration 031; UI `views.reporting` (sub-sections **NIS2** `nis2Module()` + **Report Generator** `reportGenerator()`), get-started guide `nis2GetStarted()`, + `PAGE_INFO.reporting` in `public/app.js`. See docs/nis2.md |

## Conventions

- **CommonJS only** — `require`/`module.exports`. Not TypeScript, not ESM. No build step.
- **No US-based vendors/SDKs** — tiles, GeoIP, geocoder, fonts are EU or self-hosted.
- **Privacy by design** — metadata only (5-tuple, ports, ASN, timings); never payload/DPI.
  RFC1918/private addresses are never geolocated.
- **Analysis is local + explainable** — median+MAD robust z-score, no ML libraries, no cloud.
- **Every finding/result carries an explanation + evidence.**
- **Tests:** `node --test` (auto-discovers `test/**` + `src/**/__tests__`). Express
  endpoints are tested for 400/401/403/404/500. Outbound calls (LLM/SMTP/geocoder) are
  mocked. Repos are tested with a fake `pool`; routes with `makeApp` + fakes.
