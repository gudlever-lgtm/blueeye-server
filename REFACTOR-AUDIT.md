# REFACTOR-AUDIT.md — blueeye-server

Gennemgang udført 2026-06-20. **Kun observationer** — ingen kode er ændret.

---

## Resumé: Top 5 fund (risiko-rangeret)

| # | Fund | Risiko | Domæne |
|---|------|--------|--------|
| 1 | `GET /api/geocode/*` proxyer til admin-konfigureret URL **uden SSRF-blokering** — intern netværkspivot for enhver VIEWER-bruger | **HØJ** | sikkerhed |
| 2 | `DELETE /agents/:id` (force-sletning) skriver **ingen audit-record** — irreversibel, sikkerhedsrelevant handling er usynlig | **HØJ** | audit |
| 3 | Begge audit-loggers læser `X-Forwarded-For` **direkte** uanset `TRUST_PROXY` — IP-felt i login-audit-trail kan spoofes | **HØJ** | sikkerhed |
| 4 | Migration **033 er dobbelt-nummereret** (`033_add_probe_pageload_elements.sql` + `033_create_audit_log.sql`) — konventionsbrud, fremtidig rækkefølgefejl mulig | **MID** | db |
| 5 | `limit`-parameter er **ikke capped** i `/api/findings` og `/api/investigation` — ubegrænset DB-query for VIEWER | **MID** | fejlhåndtering |

---

## 1. RUTE-INVENTAR

**Domæne / auth-model / filplacering:**

### AUTH (public)
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| POST | /auth | — (rate-limited) | `src/routes/auth.js` |
| GET | /auth/sso | — | `src/routes/auth.js` |
| POST | /auth/oidc/callback | — (OIDC flow) | `src/routes/oidc.js` |
| POST | /auth/saml/acs | — (SAML ACS) | `src/routes/saml.js` |
| GET | /auth/saml/metadata | — | `src/routes/saml.js` |

### AGENTS (to auth-modeller)
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /agents | VIEWER+ | `src/routes/agents.js` |
| GET | /agents/:id | VIEWER+ | `src/routes/agents.js` |
| GET | /agents/:id/results | VIEWER+ | `src/routes/agents.js` |
| GET | /agents/:id/flows | VIEWER+ | `src/routes/agents.js` |
| GET | /agents/:id/audit | ADMIN | `src/routes/agents.js` |
| PUT | /agents/:id | OPERATOR+ | `src/routes/agents.js` |
| DELETE | /agents/:id | ADMIN | `src/routes/agents.js` |
| POST | /agents/:id/ping | VIEWER+ | `src/routes/agents.js` |
| POST | /agents/:id/diagnose | VIEWER+ | `src/routes/agents.js` |
| POST | /agents/:id/update | ADMIN | `src/routes/agents.js` |
| POST | /agents/:id/delete | ADMIN | `src/routes/agents.js` |
| POST | /agents/:id/install-tool | OPERATOR+ | `src/routes/agents.js` |
| POST | /agents/:id/run-test | OPERATOR+ | `src/routes/agents.js` |
| POST | /agents/:id/probe | OPERATOR+ | `src/routes/agents.js` |
| POST | /agents/:id/run-speedtest | OPERATOR+ | `src/routes/agents.js` |
| POST | /agents/releases | ADMIN | `src/routes/agents.js` |
| POST | /agents/results | **agent-token** | `src/routes/agentReports.js` |
| POST | /agents/probe-results | **agent-token** | `src/routes/agentReports.js` |
| GET | /agents/me/config | **agent-token** | `src/routes/agentReports.js` |
| POST | /agents/me/capabilities | **agent-token** | `src/routes/agentReports.js` |
| POST | /agents/enroll | **uauthenticated** (one-time code) | `src/routes/agentEnroll.js` |

### USERS (ADMIN)
| Metode | Sti | Rolle | Feature gate | Fil |
|--------|-----|-------|-------------|-----|
| GET | /users | ADMIN | — | `src/routes/users.js` |
| POST | /users | ADMIN | `rbac` | `src/routes/users.js` |
| PUT | /users/:id | ADMIN | `rbac` | `src/routes/users.js` |
| DELETE | /users/:id | ADMIN | `rbac` | `src/routes/users.js` |

### ME
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /me | ANY auth | `src/routes/me.js` |
| PUT | /me/preferences | ANY auth | `src/routes/me.js` |

### LOCATIONS
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /locations | VIEWER+ | `src/routes/locations.js` |
| GET | /locations/:id/traffic | VIEWER+ | `src/routes/locations.js` |
| GET | /locations/:id/traffic/history | VIEWER+ | `src/routes/locations.js` |
| POST | /locations | OPERATOR+ | `src/routes/locations.js` |
| PUT | /locations/:id | OPERATOR+ | `src/routes/locations.js` |
| DELETE | /locations/:id | ADMIN | `src/routes/locations.js` |

### LICENSE
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /license/status | VIEWER+ | `src/routes/license.js` |
| GET | /license/features | VIEWER+ | `src/routes/license.js` |
| GET | /license/plan | VIEWER+ | `src/routes/license.js` |
| GET | /license/usage | VIEWER+ | `src/routes/license.js` |
| GET | /license/matrix | VIEWER+ | `src/routes/license.js` |
| POST | /license/refresh | OPERATOR+ | `src/routes/license.js` |

### ENROLLMENT
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /enroll/config | — | `src/routes/enroll.js` |
| GET | /enroll/agent-source.tgz | — | `src/routes/enroll.js` |
| GET | /enroll/agent-release | — | `src/routes/enroll.js` |
| GET | /enroll/agent-release.tgz | — | `src/routes/enroll.js` |
| GET | /enroll/agent-release-key | — | `src/routes/enroll.js` |
| GET | /enroll/agent-binary/:arch | — | `src/routes/enroll.js` |
| GET | /enroll/agent-binary-status | — | `src/routes/enroll.js` |
| GET | /enroll/uninstall.sh | — | `src/routes/enroll.js` |
| GET | /enroll/:code/install.sh | — | `src/routes/enroll.js` |
| GET | /enroll/agent/:platform | — (legacy) | `src/routes/enroll.js` |
| GET | /api/enroll/command | OPERATOR+ | `src/routes/enrollCommand.js` |
| GET | /enrollment-codes | OPERATOR+ | `src/routes/enrollmentCodes.js` |
| POST | /enrollment-codes | OPERATOR+ | `src/routes/enrollmentCodes.js` |
| DELETE | /enrollment-codes/:id | ADMIN | `src/routes/enrollmentCodes.js` |

### FLOWS/GEO/TOPOLOGY/PROBES/FLEET
Alle VIEWER+, feature-gated (geo, dashboard_advanced).
Filer: `src/routes/flows.js`, `geo.js`, `topology.js`, `probes.js`, `fleet.js`, `map.js`, `geocode.js`, `interfaces.js`.

### ANALYSE/FINDINGS/FORECAST
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /api/findings | VIEWER+ | `src/routes/findings.js` |
| POST | /api/findings/:id/ack | OPERATOR+ | `src/routes/findings.js` |
| POST | /api/forecast | VIEWER+ | `src/routes/forecast.js` |
| GET | /api/search | VIEWER+ | `src/routes/search.js` |
| GET | /api/fleet/health | VIEWER+ | `src/routes/fleet.js` |
| GET | /api/fleet/nics | VIEWER+ | `src/routes/fleet.js` |
| GET | /api/fleet/agent/:id | VIEWER+ | `src/routes/fleet.js` |

### ALERTING
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /api/alerting/config | VIEWER+ | `src/routes/alerting.js` |
| POST | /api/alerting/test | OPERATOR+ | `src/routes/alerting.js` |

### SETTINGS (ADMIN, diverse feature gates)
Filer: `src/routes/settings.js`. Se sektion 5.

### INTEGRATIONS (ADMIN)
Fil: `src/routes/integrations.js`. Alle ruter kræver ADMIN.

### SSO (ADMIN, license-gated)
Filer: `src/routes/ldap.js`, `oidc.js` (admin-del), `saml.js` (admin-del).

### NIS2
| Metode | Sti | Rolle | Feature | Fil |
|--------|-----|-------|---------|-----|
| GET | /api/nis2/meta | VIEWER+ | `nis2` | `src/routes/nis2.js` |
| GET | /api/nis2/dashboard | VIEWER+ | `nis2` | `src/routes/nis2.js` |
| GET/POST/PUT/DELETE | /api/nis2/risks | VIEWER+/OPERATOR+ | `nis2` | `src/routes/nis2.js` |
| GET/POST/PUT/DELETE | /api/nis2/controls | VIEWER+/OPERATOR+ | `nis2` | `src/routes/nis2.js` |
| GET/POST/PUT/DELETE | /api/nis2/incidents | VIEWER+/OPERATOR+ | `nis2` | `src/routes/nis2.js` |
| GET/POST/PUT/DELETE | /api/nis2/evidence | VIEWER+/OPERATOR+ | `nis2` | `src/routes/nis2.js` |
| POST | /api/nis2/reports/generate | ADMIN | `reports_compliance` | `src/routes/nis2.js` |
| PUT | /api/nis2/reports/:id/approve | ADMIN | `reports_compliance` | `src/routes/nis2.js` |

### AUDIT (ADMIN)
Filer: `src/routes/audit.js`, `auditEvents.js`, `auditLog.js`.

### API-TOKENS (ADMIN, `api_access`)
Fil: `src/routes/apiTokens.js`.

### HA (`ha_deployment`, Enterprise+)
| Metode | Sti | Rolle | Bemærkning |
|--------|-----|-------|------------|
| GET | /api/ha/status | ANY auth* | *ingen `requireRole` |
| GET | /api/ha/nodes | ANY auth* | *ingen `requireRole` |
| POST | /api/ha/step-down | ADMIN | |

### INVESTIGATION
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| POST | /api/investigation/run | OPERATOR+ | `src/routes/investigation.js` |
| POST | /api/investigation/from-incident | OPERATOR+ | `src/routes/investigation.js` |
| GET | /api/investigation | VIEWER+ | `src/routes/investigation.js` |
| GET | /api/investigation/:id | VIEWER+ | `src/routes/investigation.js` |

### SYSTEM
| Metode | Sti | Rolle | Fil |
|--------|-----|-------|-----|
| GET | /system/version | VIEWER+ | `src/routes/system.js` |
| GET | /system/storage | VIEWER+ | `src/routes/system.js` |
| POST | /system/agent-source/reload | ADMIN | `src/routes/system.js` |

### DIAGNOSTICS (ADMIN)
Fil: `src/routes/diagnostics.js`.

### HEALTH (PUBLIC)
`GET /health` — ingen auth, returnerer DB-status.

### SPEEDTEST
| Metode | Sti | Auth | Fil |
|--------|-----|------|-----|
| POST | /speedtest/results | **agent-token** | `src/routes/speedtest.js` |
| GET | /api/speedtest/* | VIEWER+ | `src/routes/speedtest.js` |

**Samlede ruter uden eksplicit rolle-check:**
- `GET /api/ha/status` og `GET /api/ha/nodes` — requireAuth men ingen requireRole (intentionelt viewer+, men ikke kodet eksplicit)
- Alle uauthenticerede enrollment-endepunkter — korrekt by design

---

## 2. FEJLHÅNDTERING

### Generelt mønster (godt)
- `asyncHandler` wrapper fanger alle uhandlede Promise-fejl og sender dem til `errorHandler`, som returnerer 500.
- Global `notFoundHandler` er monteret allersidst og returnerer `{"error":"Not Found","path":"..."}`.
- Næsten alle ruter returnerer eksplicitte 400/404/409/503/504 via tidlig `return res.status(N).json(...)`.

### Konkrete mangler

**Fund A — `DELETE /agents/:id` returnerer stille 404 ved race condition**
`src/routes/agents.js:587-588`:
```js
const agent = await agentsRepo.findById(id);  // snapshot for integration event
const removed = await agentsRepo.remove(id);
if (!removed) return notFound(res);
```
Hvis agenten slettes af to parallelle requests, finder den første `agent != null` (snapshot), men `removed` kan returnere `null` fra den anden. Klienten får korrekt 404, men det er det eneste sted i koden der henter agenten OG fjerner den i to separate queries uden transaktion. Lav race-condition risiko, men mønsteret er inkonsistent med `POST /agents/:id/delete` (som finder + handler i ét flow).

**Fund B — `/api/geocode/*` har ingen 404 for ukendt endepunkt**
Geocode-routeren eksponerer kun `/search` og `/reverse`. En request til f.eks. `GET /api/geocode/foo` falder igennem til global 404-handler — korrekt men ikke testet specifikt.

**Fund C — `GET /api/ha/*` returnerer ikke 403 for VIEWER vs ADMIN**
`src/routes/ha.js:28-36`: GET-ruterne mangler `requireRole`, så en VIEWER-bruger kan kalde dem. Hvis dette er intentionelt (viewer+ læseadgang til HA), bør det kodes eksplicit. Fejlhåndteringen er teknisk korrekt — der er bare ikke noget 403-niveau her.

**Fund D — investigation limit returnerer ikke 400 ved for stor værdi**
`src/routes/investigation.js:181-195`: `limit` valideres kun som positiv integer, aldrig capped. En klient med VIEWER-rolle kan sende `?limit=9999999` og få en potentielt stor forespørgsel.
- Risiko: **MID**
- Fix: `limit = Math.min(n, 500)` (linje 186)
- Diff: 1 linje

**Fund E — findings limit ikke server-side capped i ruten**
`src/routes/findings.js:29-36`: Kommentaren siger "capped server-side in findingStore.list", men ruten sender brugerens `limit` direkte til `findingStore.list()`. Hvis findingStore internt ikke capper, er limit ubegrænset for VIEWER+.
- Risiko: **LAV** (afhænger af findingStore-implementering)
- Fix: Tilføj `limit = Math.min(limit, 500)` efter linje 35
- Diff: 1 linje

---

## 3. AUTH & RBAC-KONSISTENS

### Generelt (godt)
- `requireAuth` + `requireRole` er brugt konsekvent via `src/auth/middleware.js`.
- Agent-token-auth (`agentAuth`) er klart adskilt fra bruger-JWT-auth — aldrig blandet.
- API-token-middleware er monteret som første middleware i `createApiRouter` (linje 164) og sætter `req.authVerified = true`, som `requireAuth` respekterer (linje 22) — korrekt delegation.
- Revocation-check er synkron in-memory, korrekt implementeret.

### Fund F — HA GET-ruter mangler eksplicit `requireRole`
`src/routes/ha.js:26-36`:
```js
router.use(requireAuth, gate);  // gate = Enterprise license check
router.get('/status', asyncHandler(...));  // ingen requireRole
router.get('/nodes', asyncHandler(...));   // ingen requireRole
router.post('/step-down', requireRole(ROLES.ADMIN), asyncHandler(...));
```
GET-ruterne tillader enhver autentificeret bruger (VIEWER) at se HA-topologi. Alle andre sammenlignelige "infrastruktur-info"-ruter (system/storage, diagnostics) kræver minimum VIEWER eksplicit via `requireRole`. Mangler er sandsynligvis intentionel (HA-status er read-only og harmløs), men afviger fra konventionen og er udokumenteret i koden.
- Risiko: **LAV** (VIEWER kan se klyngetopologi — ikke en hemmelighed)
- Fix: Tilføj `requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN)` på GET-ruterne
- Diff: 2 linjer

### Fund G — `diagnostics.js` isLicensed() er fail-OPEN
`src/routes/diagnostics.js:56-58`:
```js
const isLicensed = (feature) => !featureGate || typeof featureGate.isFeatureEnabled !== 'function'
  || featureGate.isFeatureEnabled(feature) === true;
```
Kommentaren erkender dette: "Fail-OPEN when no gate is injected". Diagnostics-routeren er ADMIN-only, så konsekvensen er begrænset. Men mønsteret er det modsatte af alle andre feature gates (som er fail-CLOSED). Det er acceptabelt her fordi det kun bruges til at vise en "not licensed" badge i UI'et — ikke til at blokere adgang. Notat: dette er bevidst design, ikke en bug.

### Fund H — Inline rolle-kopiering er fraværende (godt)
Der er ingen steder med kopieret rolle-logik. Alle ruter bruger `requireRole` fra `src/auth/middleware.js`. Ingen `req.user.role === 'admin'`-checks inline.

---

## 4. DB-ADGANG

### Generelt (godt)
- Al DB-adgang er via repositories i `src/repositories/`. Ingen SQL i route-handlers.
- Alle SQL-queries bruger parameteriserede `?`-pladsholdere (mysql2 prepared statements).
- Migrationsrunneren (`src/migrate.js`) er velstruktureret: lexikografisk sortering, transaktions-rollback ved fejl, tracking via `schema_migrations`-tabel.

### Fund I — Migration 033 dobbelt-nummereret (KRITISK konventionsbrud)
```
migrations/033_add_probe_pageload_elements.sql   (ALTER TABLE probe_results ...)
migrations/033_create_audit_log.sql              (CREATE TABLE audit_log ...)
```
**Effekt i dag:** Begge kører — de har forskelligt filnavn, og `schema_migrations` tracker filnavn, ikke nummer. Leksikografisk rækkefølge er `033_add_...` → `033_create_...`, som tilfældigvis er korrekt (de er uafhængige).

**Fremtidig risiko:** Hvis en ny migration skal indsættes *mellem* disse to (f.eks. `033_x.sql` der afhænger af `audit_log`), er det umuligt uden at omdøbe de eksisterende — og omdøbning ville forvirre `schema_migrations`, da den ældre record er gemt under det gamle navn.

- Risiko: **MID** (ingen runtime-bug nu, men vedligeholdelsesrisiko)
- Fix: Omdøb `033_add_probe_pageload_elements.sql` → `032b_add_probe_pageload_elements.sql` eller acceptér at fremtidigt nummerere fra 045 og dokumentere hullet
- Diff: Filnavn-rename + evt. `schema_migrations`-reparation i prod

### Fund J — `migrate.js` bruger `multipleStatements: true`
`src/migrate.js:46`:
```js
multipleStatements: true,
```
Dette er nødvendigt for at afvikle migrations med flere SQL-sætninger. Men `multipleStatements` giver mysql2-forbindelsen mulighed for SQL-injektion hvis en string nogensinde interpoleres ukorrekt i en query. Forbindelsen bruges kun til migrations (ikke til runtime-queries), og den lukker straks efter. Risiko er minimal, men det er værd at bemærke at prod-pool'en IKKE må have `multipleStatements: true`.
- Risiko: **LAV** (migrations-only connection, lukkes efter brug)
- Fix: Dokumentér at runtime-pool'en (`src/db.js`) ikke må sætte `multipleStatements`

---

## 5. SIKKERHEDS-BASELINE

### HSTS / CSP / headers (godt)
`src/middleware/securityHeaders.js` er monteret som **første middleware** i `src/app.js:104` — før static files, før API-router, ubetinget. Den er ikke bag nogen feature-gate.

CSP er pre-computed (én gang ved opstart), ikke per-request — korrekt.
Bemærk: `style-src` har `'unsafe-inline'` — nødvendigt for SPA'en men en svaghed.
`connect-src 'self' https:` tillader enhver HTTPS-forbindelse fra browseren — relativt bredt.

### Brute-force lockout (godt)
Login-throttle er i `src/auth/loginThrottle.js`, aktiveret i `src/routes/auth.js`. Enrollment-throttle injiceres via `enrollRateLimiter` i `src/routes/index.js:298`.

Begge er in-memory (single-process). I multi-node HA-deployments er der ingen delt tæller — angiver risiko for brute-force på tværs af noder. Dette er dokumenteret som en known limitation.

### Fund K — Geocode-proxy mangler SSRF-blokering (KRITISK)
`src/routes/geocode.js:51, 69`:
```js
return proxy(`${base}/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, res);
return proxy(`${base}/reverse?format=jsonv2&lat=${lat}&lon=${lon}`, res);
```
`base` er `getGeocodeUrl()` — en admin-konfigureret URL. Proxy-funktionen laver en `fetch` til denne URL uden SSRF-guard (ingen kald til `isBlockedHost` eller `baseUrlBlockedReason`).

**Angrebsscenarie:** En admin konfigurerer `geocodeUrl = http://192.168.1.1/api` (et intern router-admin-panel). Enhver VIEWER-bruger kan nu lave `GET /api/geocode/search?q=...` og proxy'e requests til det interne endpoint — serveren er pivot.

Sammenlign med integrationer (`src/integrations/httpClient.js:42-43`) og `src/integrations/ssrfGuard.js`, som korrekt blokerer private IP-litteraler på request-tidspunkt.

`src/diagnostics/reach.js` undlader bevidst SSRF-guard (kommentar linje 9-10) fordi det er admin-konfigurerede endpoints til selvhostede infrastruktur-URL'er — det er en anden sikkerhedsmodel og acceptabelt. Geocode-proxyen skal derimod have SSRF-guard fordi den aktiveres af VIEWER-brugerens input.

- Risiko: **HØJ** — intern netværkspivot for VIEWER-rolle
- Fix: Kald `baseUrlBlockedReason(fullUrl)` i `proxy()`-funktionen (linje 20-38) eller ved URL-opbygning; returner 502 hvis blokeret
- Diff: ~5 linjer i `src/routes/geocode.js`

### Fund L — X-Forwarded-For læses uden TRUST_PROXY (IP-spoofing i audit-log)
To steder læses XFF-headeren direkte, uanset `TRUST_PROXY`-indstillingen:

1. `src/middleware/auditLogger.js:30`:
   ```js
   const xff = req.headers && req.headers['x-forwarded-for'];
   if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim().slice(0, 64);
   return (req.ip || ...).slice(0, 64) || null;
   ```

2. `src/services/auditLogger.js:18-19`:
   ```js
   const xff = req.headers && req.headers['x-forwarded-for'];
   if (xff) return String(xff).split(',')[0].trim().slice(0, 64);
   ```

`req.ip` fra Express respekterer `app.set('trust proxy', ...)` korrekt. Disse raw-header-læsninger gør det ikke. Resultatet: når `TRUST_PROXY=false` (standard) og serveren er direkte eksponeret, kan en angriber sende `X-Forwarded-For: 1.2.3.4` og få den IP registreret i audit-trail for loginanfald — dette skjuler den reelle kilde-IP.

- Risiko: **HØJ** — audit-trail kan vildlede incident-response
- Fix: Erstat raw XFF-læsning med `req.ip` i begge filer; Express håndterer proxy-trust korrekt
- Diff: 2-3 linjer per fil (~6 linjer i alt)

### Fund M — Enterprise-gates er korrekte (godt)
IP-allowlist og audit-retention er korrekt gated bag license-features. `requirePlanFeature()` er fail-CLOSED (returnerer 403 upgrade-prompt ved manglende feature). Intet lækker til non-Enterprise builds.

---

## 6. AUDIT-RECORDS

### Two-state mønster (requested → completed/failed)
Korrekt implementeret for: `POST /agents/:id/update`, `POST /agents/:id/delete`, `POST /agents/:id/install-tool` — alle kalder `recordRequested(...)`, og agent-ekko på completion håndteres i WS-laget.

### Fund N — `DELETE /agents/:id` mangler audit-record (KRITISK)
`src/routes/agents.js:577-597`:
```js
router.delete('/:id', requireAuth, requireRole(ROLES.ADMIN), asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return invalidId(res);
  const agent = await agentsRepo.findById(id);
  const removed = await agentsRepo.remove(id);
  if (!removed) return notFound(res);
  // ... integration trigger (bedst-effort)
  res.status(204).end();
}));
```
Der er ingen kald til `recordRequested`, `auditRepo.record`, eller `auditEventsRepo.record`. En hard-delete af en agent — en uigenkaldelig, sikkerhedsrelevant ADMIN-handling — efterlader ingen spor i hverken `agent_action_audit` eller `audit_events`.

Sammenlign med `POST /agents/:id/delete` (linje 293-323) som korrekt auditerer via `recordRequested('delete', ...)`.

- Risiko: **HØJ** — irreversibel ADMIN-handling er usynlig
- Fix: Tilføj best-effort audit-kald i delete-handlern:
  ```js
  // Best-effort audit (id + hostname kan nu snapshotes fra `agent`)
  if (auditRepo) { try { await auditRepo.record({ agentId: id, ... action: 'force-delete', state: 'completed' }); } catch {} }
  ```
  eller brug auditEventsRepo med `action: 'agent.force-delete'`
- Diff: ~5 linjer

### Fund O — Mutationer i investigation uden audit-spor
`src/routes/investigation.js:109-113` — `investigationsRepo.save(result)` køres uden audit-record og fejl swallowes stille (`catch {}`). Investigations er ikke umiddelbart en sikkerhedskritisk mutation (de er read/derive-operationer), men NIS2-udkast-oprettelse (`nis2IncidentsRepo.create` linje 63) sker uden audit-trail. En AI-genereret NIS2-hændelse oprettes i databasen uden at nogen admin ved det.
- Risiko: **MID** — NIS2-incident oprettet automatisk uden spor
- Fix: Log/audit nis2Draft-oprettelse i `maybeCreateNis2Draft`
- Diff: ~3 linjer

### Ruter med mutations uden audit (accept-level LAV):
- `PUT /me/preferences` — personlig præference, ikke sikkerhedsrelevant
- `POST /api/forecast` — stateless compute, ingen DB-write

---

## 7. DØD KODE & DUPLIKERING

### Fund P — `parseId` duplikeret i `fleet.js`
`src/routes/fleet.js:17-21`:
```js
function parseId(v) {
  if (!/^\d+$/.test(String(v))) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
```
Identisk med `parseId` i `src/validation/locationValidation.js`. Bruges på linje 112 i fleet.js.
- Risiko: **LAV** (divergens-risiko ved fremtidigt ændring af valideringslogik)
- Fix: `const { parseId } = require('../validation/locationValidation')` øverst i fleet.js; slet den lokale
- Diff: ~6 linjer (slet funktion, tilføj import)

### Fund Q — Navne-kollision: to "auditLogger"-moduler
- `src/middleware/auditLogger.js` — HTTP-middleware, auto-auditerer alle muterende requests
- `src/services/auditLogger.js` — eksplicit record()-wrapper til audit_log-tabellen (compliance-trail)

Begge eksporterer `createAuditLogger`. De løser to forskellige behov, men nav-kollisionen gør det let at importere den forkerte. `src/server.js` og tests skal holde styr på to ens navne.
- Risiko: **LAV** (ingen runtime-fejl, men kognitiv last og fejlrisiko)
- Fix: Omdøb `src/services/auditLogger.js` → `src/services/complianceLogger.js` og opdater imports
- Diff: ~4 filændringer

### Fund R — MSP-rester
`migrations/037_remove_msp_plan.sql` fjerner `msp`-planen. Ingen MSP-ruter eller MSP-logik er synlig i `src/routes/`. `src/license/plans.js` kan have MSP-referencer — ikke verificeret. Migrationen eksisterer, og det er godt, men det er uklart om `plans.js` er ryddet op tilsvarende.
- Risiko: **LAV** (hvis MSP-planchecks stadig er i plans.js, kan de producere uforventet adfærd)
- Anbefaling: Grep `plans.js` + `license/` for `msp` og fjern dead branches

### Fund S — `src/routes/enrollCommand.js` importerer direkte fra `src/config.js`
`src/routes/enrollCommand.js:10`:
```js
const { config } = require('../config');
```
Alle andre route-handlers modtager konfiguration via dependency injection. Denne direkte config-import er den eneste undtagelse og gør det sværere at teste enrollment-TTL-logikken isoleret.
- Risiko: **LAV** (testbarhed, ikke sikkerhed)
- Fix: Send `defaultTtlMinutes` som en parameter i `createEnrollCommandRouter`-factory
- Diff: ~5 linjer

---

## Foreslået refactoring-rækkefølge

Én domæne/session. Retter en konkret fejl per PR; ingen store arkitektur-ændringer.

| Session | Handling | Filer | Diff-størrelse |
|---------|----------|-------|----------------|
| 1 | **[H]** Geocode SSRF-guard (`Fund K`) | `src/routes/geocode.js` | ~5 linjer |
| 2 | **[H]** XFF-spoofing i audit-logs (`Fund L`) | `src/middleware/auditLogger.js`, `src/services/auditLogger.js` | ~8 linjer |
| 3 | **[H]** Audit DELETE /agents/:id (`Fund N`) | `src/routes/agents.js` | ~5 linjer |
| 4 | **[M]** Cap limit i investigation + findings (`Fund D + E`) | `src/routes/investigation.js`, `findings.js` | 2 linjer |
| 5 | **[M]** Migration 033 navnekonvention (`Fund I`) | Rename + schema_migrations-note | Fil-rename |
| 6 | **[M]** HA GET requireRole (`Fund F`) | `src/routes/ha.js` | 2 linjer |
| 7 | **[L]** parseId duplikat fjernes (`Fund P`) | `src/routes/fleet.js` | 6 linjer |
| 8 | **[L]** Navnekollision auditLogger → complianceLogger (`Fund Q`) | `src/services/auditLogger.js` + imports | ~4 filer |
| 9 | **[L]** enrollCommand.js config-injection (`Fund S`) | `src/routes/enrollCommand.js` | ~5 linjer |

---

*AUDIT-ONLY — ingen kode ændret, ingen migrations kørt, intet pushet.*
