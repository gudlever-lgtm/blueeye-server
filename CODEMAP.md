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
│   └── tokens.js agentAuth.js                       # agent opaque-token side
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
├── lib/               # csv.js (RFC4180 + injection guard), canonicalize.js
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
| `/auth` | auth.js | none | login → JWT |
| `/users` | users.js | admin | user CRUD (last-admin protected) |
| `/me` | me.js | viewer+ | current user: profile + **personal UI preferences** (colour theme) |
| `/locations` | locations.js | viewer+/op/admin | sites + per-location live traffic |
| `/agents` (3 routers) | agents.js · agentReports.js · agentEnroll.js | JWT / agent-token / none | CRUD + run-test + **run-probe**; agent self-report (`/results`, `/probe-results`, `/me/config`, `/me/capabilities`); enroll |
| `/enrollment-codes` | enrollmentCodes.js | operator+ | enrollment codes (single-use or **bulk / multi-use**) |
| `/enroll` (4 routes) | enroll.js | none | **frictionless enrollment**: `/config`, `/agent-source.tgz` (agent source bundle + SHA-256, served locally — air-gap-friendly), `/agent/:platform` (legacy pre-built binary), `/:code/install.sh` (self-contained installer: verifies the source, then builds + runs via Docker/Node) |
| `/api/enroll` | enrollCommand.js | operator+ | **install-command generator** (`/command`: one-liner + manual/checksum; mints or reuses a code) |
| `/license` | license.js | viewer+ | license status + features |
| `/system` | system.js | viewer+ | storage/disk/db + ingest estimate |
| `/api/findings` | findings.js | viewer+ | analysis findings + ack |
| `/api/assistant` | assistant.js | viewer+ (gated) | opt-in AI: `/explain` (per-host Q&A) + **`/location-summary`** (per-location "what's going on?") |
| `/api/geo` | geo.js | gated | geo overview + flow selection |
| `/api/alerting` | alerting.js | admin | channel config + test |
| `/api/map` | map.js | viewer+ | effective tile/geocoder config |
| `/api/settings` | settings.js | admin | editable map / **analysis** / **retention** / **flow-categories** / **AI assistant** (enable + API key + model) |
| `/api/export` | export.js | viewer+ | CSV/JSON export + **investigation bundle** (`/investigation`: per-agent health+probes+interfaces+findings+flows, JSON or event-log CSV; print→PDF client-side) |
| `/api/flows` | flows.js | viewer+ | **traffic-type categories** (`/categories`) + **conversation explorer** (`/explore`: talkers/ports/protos/series + scan/fan-out) |
| `/api/probes` | probes.js | viewer+ | **active-probe** results (ping/tcp/dns/traceroute/**http**) |
| `/api/fleet` | fleet.js | viewer+ | **fleet health** rollup (`/health`) + per-agent verdict (`/agent/:id`) |
| `/api/interfaces` | interfaces.js | viewer+ | **interface health** (util/errors/discards/link) |
| `/api/search` | search.js | viewer+ | **global search** (agents/hosts/locations + IP/port → agents) |

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
| 020 | (column) | per-user UI preferences — `users.preferences` JSON (colour theme) |
| 021 | (column) | `agents.enrollment_code_id` → links an agent to the code it enrolled with (Enrollment page shows each code's agents + live status); `ON DELETE SET NULL` |

Interface health, traffic-type categories and **fleet health** add **no** tables — they
derive from the existing `results.payload.traffic` (and `flow_records.asn` for org
categories); fleet health is computed in `src/health/probeHealth.js` from `probe_results`.

## Dashboard (`public/app.js`)

A single vanilla-JS SPA. Key building blocks:
- `el(tag, attrs, ...kids)` — DOM helper. `api(path, opts)` — fetch + bearer + 401 handling.
- `views.<tab>` — async function per tab returning a node (`fleet` (landing),
  `overview`, `map` (UI label **“Sites”** — locations coloured by agent health),
  `geo` (UI label **“Destinations”** — external traffic by country/ASN),
  `agents`, `interfaces`, `probes`, `flows`, `findings`, `locations`, `enrollment`,
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
- Theme: a catalogue of colour themes (`THEMES`: light/dark/midnight/nord/forest/sunset/
  solarized/contrast), chosen in **Settings → Appearance** and **saved per user**
  (`/me/preferences`), cached in localStorage for instant apply; the topbar keeps a quick
  light/dark toggle. Mobile: tab bar → bottom nav.

## Where do I change…?

| Task | Start here |
| --- | --- |
| A new HTTP endpoint | `src/routes/<x>.js` + mount in `routes/index.js` + a fake in `test-support/fakes.js` |
| A DB table/column | new `migrations/NNN_*.sql` + repository in `src/repositories/` |
| Anomaly thresholds / detection | `src/analysis/detector.js`, `config.js` (editable via Settings→Analysis) |
| Alert channels | `src/analysis/alerting/channels/*` + `dispatcher.js` |
| Maintenance windows / silencing | `src/analysis/alerting/maintenance.js` (`createSilencer`) + dispatcher hook; windows in `settingsService` (`maintenance` key), route `/api/settings/maintenance` |
| Data retention | `src/analysis/retention/*` (editable via Settings→Retention) |
| Geo/ASN enrichment | `src/geo/enricher.js`, `provider.js`; flows in `flowsRepository.js` |
| Traffic-type categories | `src/flows/categories.js` (editable via Settings→Traffic types) |
| Flow/conversation explorer | `flowsRepository.exploreFlows` + `src/routes/flows.js` (`/explore`); UI `views.flows` |
| Active probes (server) | `src/routes/probes.js`, `probeResultsRepository.js`, `validation/probeValidation.js` (probe types incl. `http`) — agent side in blueeye-agent `src/probes/` |
| Probe findings + alerting | `src/analysis/probeFindings.js` (verdict→findings, reuses `health/probeHealth.js`) + `probePipeline.js` (runs on probe-results ingest in `routes/agentReports.js`) |
| AI assistant (explain + location summary) | `src/analysis/assistant.js` (Mistral/EU, opt-in; reads enable/key/model live from the analysis config) + `src/routes/assistant.js`; per-location summary UI = `showLocationSummary` in `public/app.js`. Runtime config (enable + API key + model): `settingsService.getAssistant/setAssistant` (`src/services/settings.js`), `PUT /api/settings/assistant`, UI `assistantSettingsCard` in Settings → Analysis |
| Fleet health (overview + verdicts) | `src/health/probeHealth.js` (`computeAgentHealth`/`mergeHealth`/`computeFleet`, median+MAD — folds in interface health), `src/routes/fleet.js`; UI `views.fleet`/`views.agent` |
| Interface health | `src/health/interfaceHealth.js` (`computeInterfaceHealth`/`interfaceHealthSummary`); HTTP in `src/routes/interfaces.js` — agent side in blueeye-agent |
| Agent data-quality (drops/skew/version) | `src/health/dataQuality.js` (`computeDataQuality`); surfaced via `/api/fleet/health` + `/api/fleet/agent/:id` — all signals already sent by the agent |
| A dashboard tab/view | `public/index.html` (button) + `views.<x>` in `public/app.js` + `PAGE_INFO` |
| A dashboard colour theme | `THEMES` + `[data-theme=…]` in `public/styles.css`; picker `settingsAppearanceView` in `public/app.js`; per-user persistence via `/me` (`src/routes/me.js`, `usersRepository.get/updatePreferences`) + key whitelist in `src/validation/preferencesValidation.js` |
| License / feature gating | `src/license/*` (`features.js` = fail-closed gate) |

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
