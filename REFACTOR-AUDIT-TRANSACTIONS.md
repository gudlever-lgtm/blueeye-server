# REFACTOR-AUDIT — Transaktionstest-modulet

> **Navnenote:** `REFACTOR-AUDIT.md` er allerede optaget af en tidligere
> sikkerheds-/audit-hardening-gennemgang (commit `cc44474`). For ikke at
> overskrive den ligger denne transaktionstest-audit i en separat fil.

Audit af `src/routes/`, WS-agentkanalen (`src/ws/agentSocket.js`) og
alert-pipelinen (`src/analysis/alerting/*` + `probePipeline.js`), med henblik på
hvor et transaktionstest-modul skal hooke ind. **Ingen produktionskode skrevet
endnu** — dette dokument er beslutningsgrundlaget.

> **Opdatering (Session 2 — detaljeret respec):** Efter den første leverance (PR
> #130) er der kommet en langt mere detaljeret specifikation der **reviderer**
> skemaet, tilføjer **icmp**, **baselines (MAD)**, **krypterede secrets**,
> **trend-endpoint**, **krydscheck-alerts** og **Mistral-diagnose**, samt en fuld
> **agent-executor** og **frontend**. Se **§8–§12** nedenfor. Delen §1–§7 beskriver
> tilstanden som PR #130 efterlod den; §8+ er audit for respec'en.

---

## 0. TL;DR — den vigtigste beslutning først

Der findes **allerede** en transaktionstest-implementering på denne branch (fra
merged PR #128), men den er **REST-baseret, kun `http`, ikke-normaliseret og ikke
wired i produktion**. Den nye spec beder om et **normaliseret, WS-drevet, multi-type
(http/tcp/dns)** modul under et **andet mount-punkt**. De to kan ikke leve side om
side uden forvirring. Se §5 for det konkrete valg (udvid vs. byg nyt + retire).

---

## 1. Eksisterende transaktionstest-kode (allerede på branchen)

| Artefakt | Fil | Status |
| --- | --- | --- |
| Migration | `migrations/045_create_transaction_tests.sql` | Tabeller `transaction_tests` (+ JSON `agents`, `secrets`, `secret_names`) og `transaction_test_results` |
| Repo | `src/repositories/transactionTestsRepo.js` | CRUD + `matrix`/`heatmap`/`trend`/`findResults` + secrets-stripping |
| Router | `src/routes/transactionTests.js` | Mountet **`/api/transaction-tests`** |
| Tests | `test/transactionTests.test.js` | Auth/RBAC/CRUD/validering/500 — **grønne** |
| Fake | `test-support/fakes.js` → `makeTransactionTestsRepo` | In-memory |
| Dashboard | `public/app.js` (Transaktionstests-sektion: matrix/heatmap/trend/diagnose) | UI findes |

### Gap mod spec'en

| Spec kræver | Eksisterende | Gap |
| --- | --- | --- |
| Mount `/api/transactions` | `/api/transaction-tests` | **Andet path** |
| Tabeller `transaction_tests`, `transaction_test_agents`, `transaction_results` | `transaction_tests` (JSON `agents`-kolonne) + `transaction_test_results` | **Ingen join-tabel; andet resultat-tabelnavn** |
| Typer: http / tcp / dns m. per-type config-validering | Kun `http` (validering `type !== 'http'` → fejl) | **Mangler tcp + dns** |
| `PUT /:id/agents` (tildel via join) | Agents som JSON-array på testrækken | **Ingen assign-endpoint** |
| `GET /:id/results?from&to&agent_id` | `GET /:id/results?limit` | **Mangler from/to/agent_id-filter** |
| `GET /:id/heatmap?from&to&bucket` (avg_latency, fail_count, sample_count pr. bucket pr. agent) | `GET /heatmap?test_id&bucket&hours` | **Query-form + felt-navne afviger; test_id i query, ikke path** |
| Resultat-ingest over **WS** (`transaction_result`) | REST `POST /:id/results` (agentAuth) | **REST i dag, ikke WS** |
| Config-push over **WS** (`transaction_config`) | Findes ikke (agent kender ikke sine tests) | **Mangler helt** |

### ⚠️ Kritisk: modulet er ikke wired i produktion

`transactionTestsRepo` **konstrueres aldrig i `src/server.js`** (der er intet
`createTransactionTestsRepo`-require/kald). Den threades kun som parameter gennem
`src/app.js` → `src/routes/index.js`, hvor mount er gated: `if (transactionTestsRepo)
router.use('/api/transaction-tests', …)` (index.js:274). I produktion er værdien
`undefined` → **routeren mountes aldrig**. Kun testene rammer den via faken.
Migration 045 kører dog (migrate scanner `migrations/`-mappen).

**Konsekvens:** den eksisterende REST-flade er de-facto død kode i prod. Det gør
det billigere at bygge spec'ens design "rigtigt" uden at brække en aktiv flade —
men vi skal aktivt beslutte hvad der sker med 045-tabellerne, routeren, testene og
dashboard-sektionen (§5).

---

## 2. Hvor REST-modulet skal hooke ind (spec-del 1)

Følger husets `createX(deps)`-mønster (CODEMAP "Where do I change…?").

1. **Migration** — `migrations/046_create_transaction_domain.sql`:
   - `transaction_tests` (id, name, type ∈ http|tcp|dns, config JSON, thresholds
     JSON {consecutive_fails, latency_ms}, enabled, created/updated_at).
   - `transaction_test_agents` (test_id FK→tests ON DELETE CASCADE, agent_id
     FK→agents ON DELETE CASCADE, PRIMARY KEY(test_id, agent_id)).
   - `transaction_results` (id BIGINT, test_id FK, agent_id FK, ran_at DATETIME(3),
     status, latency_ms, detail JSON, indeks `(test_id, agent_id, ran_at)` +
     `(ran_at)`).
   - MySQL 8.4-note: **ingen `DEFAULT` på JSON-kolonner** (se commit 8bc21f0 der
     netop fjernede dét — samme fælde her).
2. **Repository** — `src/repositories/transactionsRepository.js`:
   `createX(db)`, plain objekter ud. CRUD + `setAgents(testId, agentIds)` +
   `agentsFor(testId)` / `testsForAgent(agentId)` (join) + `insertResults(batch)`
   (batch-insert) + `results({testId, from, to, agentId})` +
   `heatmap({testId, from, to, bucket})` (SQL-aggregeret `avg_latency`,
   `fail_count`, `sample_count` pr. bucket pr. agent — samme
   `FLOOR(UNIX_TIMESTAMP(ran_at)/bucketSeconds)`-teknik som eksisterende repo).
3. **Validering** — `src/validation/transactionValidation.js` (ny, ren
   `{value|errors}`). **Genbrug mønstret fra `src/validation/probeValidation.js`**
   som allerede validerer næsten alt vi skal bruge:
   - `http`: `steps[]` (method ∈ HTTP_METHODS, http(s)-URL ≤512, expectStatus
     100-599, expectBody, extract{name,pattern} m. `new RegExp`-guard) — se
     `validateProbeSpec` linje 166-215, næsten copy-paste.
   - `tcp`: `host` (HOST_RE, linje 9) + `port` 1-65535 (linje 220-223).
   - `dns`: `host` + `record type` ∈ {A,AAAA,CNAME,MX,TXT,NS,SOA,PTR,SRV} (ny lille
     enum).
4. **Router** — `src/routes/transactions.js`, mountet i `src/routes/index.js`
   under `/api/transactions`. RBAC via `requireAuth` + `requireRole` (`src/auth/
   middleware.js`, `ROLES` fra `src/auth/roles.js`): skriv = `ROLES.ADMIN`, læs =
   viewer/operator/admin. `parseId` fra `validation/locationValidation.js` (samme
   som eksisterende router bruger). Endpoints: `GET /`, `POST /`, `GET /:id`,
   `PUT /:id`, `DELETE /:id`, `PUT /:id/agents`, `GET /:id/results`,
   `GET /:id/heatmap`.
5. **Wiring** — `src/server.js`: konstruér repoet (**det manglende led**) og send
   det ind i `createApp`. Thread gennem `src/app.js` (linje 62 + 168 findes
   allerede for det gamle repo — genbrug/omdøb). Fake i `test-support/fakes.js`.
6. **404/400/500-kontrakt** — `asyncHandler` → global `errorHandler` giver 500;
   ukendt id → 404; validering → 400 (som resten af huset).

---

## 3. WS-agentkanalen (spec-del 2) — hvordan den ser ud i dag

**Fil:** `src/ws/agentSocket.js` (server) · `blueeye-agent/src/agentClient.js` +
`runtime.js` (agent).

- **Auth:** opaque agent-token i `Authorization: Bearer …` valideres i
  `server.on('upgrade')` via `createAgentAuthenticator({agentTokensRepo})`; ingen
  gyldig token → 401 og socket destroyes (ingen WS oprettes). Protokolversion i
  `X-BlueEye-Protocol`-header (i dag v1, `src/protocol.js`); mismatch = warn, aldrig
  fatal (server holdes backward-compatible).
- **Server→agent push i dag:** `sendCommand(agentId, {type:'command', command})` og
  `sendCommandAndWait(...)` (correlation-id → agent svarer med `ack`/`command-result`).
  Eksponeres fra `attachAgentWebSocket(...)`-retur som `agentWs.sendCommand` og
  pakkes i **`agentCommander`** (server.js:254) der injectes i routere — **præcis
  det hook-mønster config-push skal genbruge**.
- **Agent→server frames i dag** (`ws.on('message')`, agentSocket.js:150-228):
  `ack` / `command-result` (correlation), `sflow.status`, `agent.error`,
  `action-result`. **Her tilføjes `transaction_result`.**
- **On-connect i dag:** `wss.on('connection')` sætter status online, auditerer, og
  sender ét `connected`-frame (linje 143). **Her tilføjes en `transaction_config`-push.**
- **Resultat-transport i dag:** al måledata (results/probe-results/speedtest) går
  over **REST** med agent-token (`blueeye-agent/src/apiClient.js`), IKKE over WS.
  Spec'en flytter transaktionsresultater til WS — nyt mønster i huset, men agenten
  har allerede en `client.send(obj)`-kanal (agentClient.js:206) og sender allerede
  strukturerede frames (`sflow.status`, `action-result`).
- **Agent-upgrade i dag (referencemønster for "push ved ændring"):** operator →
  `agentCommander.sendCommandAndWait(agentId, {command:'update', auditId})` →
  agent `runtime.js` kører `selfUpdate` → svarer `action-result {auditId, action:
  'upgrade', ok, version}` → agentSocket completer audit-rækken. Samme
  request/broadcast-til-alle-sockets-for-agent-mekanik som config-push skal bruge.

### Hvor WS-delen hooker ind

- **`transaction_config` (server→agent):**
  - *Ved connect:* i `wss.on('connection')` efter `connected`-framet (linje 143) →
    slå aktive, tildelte tests op (`transactionsRepo.testsForAgent(agentId)`) og
    `safeSend(ws, {type:'transaction_config', tests:[…]})`. Kræver at repoet
    **injectes i `attachAgentWebSocket`** (i dag kender socket kun agentTokens/
    agents/audit-repos).
  - *Ved ændring (create/update/delete/assign):* REST-routeren kalder en push-hook.
    Eksponér `pushTransactionConfig(agentId)` fra `attachAgentWebSocket`-returet
    (ved siden af `sendCommand`), pak den i `agentCommander` (eller en ny
    `transactionPusher`), og injicér i `transactions`-routeren. Ved assign/ændring:
    beregn berørte agent-ids (union af gammel+ny tildeling) og push til hver.
- **`transaction_result` (agent→server):** nyt `if (msg.type === 'transaction_result')`
  i `ws.on('message')`:
  1. Payload = array af resultater (buffer-flush) → **valider** hver mod agentens
     tildelte tests (`transactionsRepo.agentsFor`/`testsForAgent`); resultater for
     tests agenten IKKE har → **afvis + `logger.warn`** (og valgfrit `agent.error`-
     audit, som det eksisterende mønster linje 183).
  2. **Batch-insert** de gyldige via `transactionsRepo.insertResults(batch)`.
  3. **Alert-hook** (§4).
  Best-effort/defensivt: en dårlig frame må aldrig vælte hubben (som resten af
  handleren). Kræver `transactionsRepo` + alert-deps injiceret i socket.

---

## 4. Alert-pipelinen — hvordan den ser ud i dag & hvor threshold-hook lander

**Filer:** `src/analysis/alerting/dispatcher.js` (+ `config.js`, `channels/{email,
webhook,syslog}.js`, `maintenance.js`). Referenceforbrug: `src/analysis/
probePipeline.js`.

- **Kontrakt:** `dispatcher.dispatch(finding, group)`. `finding` skal have formen
  `{ id, hostId, metric, kind, severity ('WARN'|'CRIT'|…), explanation, evidence:[…],
  deviation, createdAt }` (se `dispatcher.test()` linje 115-118 og probeFindings).
- **Indbygget debounce/dedup:** dispatcher throttler pr.
  `` `${hostId}|${metric}|${kind}|${severity}` `` med `config.cooldownMs`
  (dispatcher.js:26,44-49). **Det er præcis den debounce spec'en efterspørger** —
  vi skal bare vælge en stabil `metric`/`kind`/`hostId` pr. (test, agent[, tærskel-
  type]), så én hændelse ikke spammer. Ekstra applikations-debounce er unødvendig
  hvis vi mapper korrekt ind i denne nøgle.
- **Gating:** `licensed()` + `config.enabled` + per-kanal `minSeverity` + maintenance-
  silencer. `probePipeline` viser mønstret: kald kun `dispatch` når
  `alertingEnabled` (kan være live getter) og der er noget at sende.

### Hvor threshold-hooket lander

Efter batch-insert i `transaction_result`-handleren (§3):

1. Læs `thresholds` fra testens config (`consecutive_fails`, `latency_ms`).
2. Evaluér pr. (test, agent): tæl seneste N på hinanden følgende fails
   (`transactionsRepo` får en lille `recentStatuses(testId, agentId, N)` eller
   genbrug `results(...)`), og/eller sammenlign `latency_ms` mod tærskel.
3. Ved overskridelse → byg et `finding` og kald `dispatcher.dispatch(finding)`.
   `hostId = agent_id`, `metric = 'transaction.'+(fail|latency)`,
   `kind`/`severity` fast → dispatcherens cooldown giver debounce.
4. Best-effort: en alert-fejl må aldrig påvirke insert (samme try/catch-disciplin
   som `probePipeline`/`agentReports`).

Dispatcheren injectes allerede i routere som `dispatcher` (index.js:192,229) og i
`probePipeline` fra server.js — samme instans genbruges her (skal injectes i
`attachAgentWebSocket`).

---

## 5. Den arkitektoniske gaffel (kræver beslutning før kode)

Spec'ens design afviger substantielt fra den eksisterende (merged) implementering.
To veje:

- **A. Byg spec'en som nyt modul (`/api/transactions`, migration 046, join-tabel,
  WS-ingest) og retire den gamle** `/api/transaction-tests`-flade. Renest ift.
  spec; den gamle flade er alligevel død i prod (§1). Koster: fjern/omskriv gammel
  router+repo+test+dashboard-sektion (ellers to overlappende transaktionsmoduler).
- **B. Udvid den eksisterende** `/api/transaction-tests` til at opfylde spec'en
  (tilføj join-tabel, tcp/dns, WS). Mindre kildeflytning, men bryder spec'ens
  path/tabelnavne og efterlader teknisk gæld (JSON-`agents` vs. join).

**Anbefaling: A**, netop fordi det gamle modul ikke er wired i produktion, så
"små diffs, kun dette domæne" kan holdes uden at brække en aktiv flade — men dette
er et bevidst valg om at pensionere merged kode, og bør bekræftes før implementering.

## 6. Filer der røres (forventet, ved vej A)

Server: `migrations/046_*.sql`, `src/repositories/transactionsRepository.js`,
`src/validation/transactionValidation.js`, `src/routes/transactions.js`,
`src/routes/index.js` (mount), `src/app.js` + `src/server.js` (wiring +
repo-konstruktion), `src/ws/agentSocket.js` (config-push + `transaction_result` +
alert-hook), `test-support/fakes.js` (fake), `test/transactions*.test.js`,
`package.json` (version-bump). Retire: `src/routes/transactionTests.js`,
`src/repositories/transactionTestsRepo.js`, `migrations/045` (data-migrering/DROP?),
`test/transactionTests.test.js`, dashboard-sektion.
Agent (senere, spec-del 2): recognizer i `src/command.js`, handler i
`src/runtime.js` (modtag `transaction_config`, buffer + flush `transaction_result`),
fake i `test-support/fakeServer.js`, version-bump i lockstep.

## 7. Kontrakt-noter / faldgruber

- **Ingen nye npm-deps**, CommonJS, DI overalt (husets konvention).
- **MySQL 8.4:** ingen JSON-DEFAULT (commit 8bc21f0).
- **Version-bump** i lockstep (server + agent) — ellers vises "update available"
  ikke; `npm version minor --no-git-tag-version`.
- **Backward-compat:** agenter opdaterer selv; `transaction_config`/`transaction_result`
  er additive frames → **ingen `PROTOCOL_VERSION`-bump** (kun ved breaking).
- **Privacy by design:** kun metadata i resultater (status/latency/step-timing),
  aldrig payload. Secrets i test-config returneres aldrig af læse-API (eksisterende
  repo har allerede `secret_names`-mønstret hvis vi vil beholde secrets).
- **Tests skal være grønne før push** (400 ugyldig config, 404 ukendt test/agent,
  500 repo-fejl; WS-ingest-validering inkl. afvisning af ikke-tildelte tests).

---

# Session 2 — detaljeret respecifikation (audit)

## 8. Delta mod PR #130 (den shippede v1)

Respec'en er **autoritativ** og reviderer skemaet fra migration 046. PR #130 er en
**ikke-merged draft** på samme branch, så skemaet kan omskrives frem for at lægge en
alter-migration ovenpå friske tabeller.

| Aspekt | PR #130 (shippet) | Respec (nu) |
| --- | --- | --- |
| Typer | http, tcp, dns | + **icmp** (4 typer) |
| Type-kolonne | `type` VARCHAR | `type` **ENUM('http','tcp','dns','icmp')** |
| Target | (i config) | egen **`target`**-kolonne |
| Interval | `interval_ms` | **`interval_sec`** DEFAULT 60 |
| created_by | — | **`created_by`** |
| Resultater | `ran_at`, `status` VARCHAR, `latency_ms`, `detail` JSON, **FK'er** | `time` DATETIME(3), `status` **ENUM(ok/fail/timeout/error)**, `latency_ms`, **`step_timings` JSON**, **`step_failed` TINYINT**, **`deviation` ENUM(normal/slower/faster)**, `detail` VARCHAR(255), **INGEN FK'er** (flytter til TimescaleDB) |
| Baselines | — | **`transaction_baselines`** (test,agent,step → median_ms, mad_ms, sample_count) + time-cron |
| Secrets | — | **`config_secrets`** AES-256-GCM, `{{secret:navn}}`, aldrig i GET |
| Endpoints | list/CRUD/agents/results/heatmap | + **`GET /:id/trend`** |
| Alert | consecutive_fails, latency_ms | + **deviation**, + **krydscheck** (multi-agent), + **Mistral** dansk diagnose, struktureret `phase`-detail |
| detail-form | fri JSON | struktureret `{phase,step,errno}` |

**Konsekvens:** migration 046, `transactionsRepository`, `transactionValidation`,
`routes/transactions.js`, WS-hooket og `transactionAlerts.js` skal **omskrives** (ikke
udvides) for at matche. `heatmap`-SQL'en og RBAC/router-stilladset kan stort set
genbruges 1:1; kolonnenavne (`ran_at`→`time`, `interval_ms`→`interval_sec`) ændres.

## 9. MAD-modulet — genbrug (ingen duplikering)

**Fil:** `src/analysis/baselines.js`. Rene, eksporterede funktioner:
- `median(arr)` — ægte median (sort + midterværdi).
- `mad(arr, med?)` — Median Absolute Deviation omkring medianen.
- `MAD_TO_SIGMA = 1.4826` — MAD→σ-konstant (detektorens z-score).
- `createBaselineStore({store,windowSize,minSamples,persistIntervalMs})` — rullende
  vinduer pr. `hostId|metric|bucket` med persistering; `get()` returnerer
  `{n, median, mad}` først når `minSamples` er nået (default 200).

**Genbrug til `transaction_baselines`:**
- Baseline-job'et beregner pr. `(test, agent, step)` **`median_ms`** og **`mad_ms`**
  direkte via `median()` + `mad()` fra `baselines.js` over de seneste 7 dages
  ok-resultaters `step_timings[step]`. **Ingen egen median/MAD** — importér dem.
- Afvigelses-tærsklen ">3 MAD" ved ingest: `Math.abs(latency - median_ms) > 3 * mad_ms`
  (med guard for `mad_ms === 0`, jf. detektorens `|| 1e-9`-mønster i
  `detector.js:39`). `deviation = latency > median ? 'slower' : 'faster'`, ellers
  `'normal'`. `sample_count < 20` → `deviation = NULL` (ingen vurdering).
- `createBaselineStore` (rullende vinduer + fil-persistering) er **ikke** det rette
  værktøj her — respec'en vil have baselines i en **DB-tabel** genberegnet af en
  cron, ikke et in-memory vindue. Så genbrug **funktionerne** `median`/`mad`, ikke
  store-klassen. Detektorens tærskel-stil (`detector.js`) er referencen for
  z-score/deviation-klassificering.

**Cron-hook:** husets scheduler-mønster findes i `src/analysis/retention/` (nightly
scheduler) og `testPackageScheduler` (server.js) — samme `setInterval`+leader-gated
mønster (HA: kun leder kører singleton-jobs, jf. `src/ha/coordinator.js`). Baseline-
job'et bør køre **leader-only** (som retention) så en HA-klynge ikke dobbeltberegner.

## 10. WS-agentprotokol + alert — udvidelser (Session 2, del 4)

Auditten i §3–§4 gælder stadig. Nye hooks:
- **Secret-dekryptering før push:** `transaction_config`-push (agentSocket connect +
  ændrings-hook) skal dekryptere `config_secrets` via `src/lib/secretBox.js`
  (AES-256-GCM, nøgle fra `SECRET_ENCRYPTION_KEY`→`JWT_SECRET`) **umiddelbart før**
  `safeSend` og aldrig logge klartekst. secretBox er allerede injiceret i app'en
  (integrations bruger den) → injicér i `attachAgentWebSocket`.
- **Baseline-evaluering ved ingest:** i `handleTransactionResult` (agentSocket),
  efter insert, slå `transaction_baselines` op pr. (test,agent,step) og sæt
  `deviation` (§9).
- **Krydscheck:** ved `fail`, slå de øvrige agenter tildelt samme test op
  (`transactionsRepo.agentsFor`) og deres seneste 2 intervallers status
  (`recentStatuses`/ny `latestStatusPerAgent`); alle fejler → "systemet er nede",
  én fejler → "problem fra agent X's site". Indgår i alert-teksten.
- **Mistral-diagnose:** genbrug `src/analysis/assistant.js` (Mistral/EU, opt-in,
  licens-gated) — formulér dansk diagnose ud fra `phase/step/krydscheck/deviation`;
  fallback til template-tekst (fase→dansk map) uden Mistral. assistant er allerede
  injiceret i routes/index (`/api/assistant`).
- **Debounce:** dispatcherens cooldown pr. `hostId|metric|kind|severity` (§4) dækker
  "debounce pr. (test, agent)" hvis `hostId=agent`, `metric=transaction.<test>`.
- **Fase→dansk map** (alerts): `dns`→"DNS-opslag mislykkedes", `connect`→"TCP-forbindelse
  fejlede (netværk/firewall/host nede)", `tls`→"TLS-håndtryk fejlede (cert?)",
  `http_status`→"uventet HTTP-status", `keyword`→"indhold manglede", `timeout`→"timeout".

## 11. Agent-audit — WS-klient, poll-scheduler, buffer (Session 2, del 1/5)

**Filer:** `src/agentClient.js`, `src/runtime.js`, `src/apiClient.js`, `src/index.js`.

- **WS-klient (`agentClient.js`):** forbinder til `/ws/agent` med opaque token i
  `Authorization: Bearer` + `X-BlueEye-Protocol`. Emitter: `open`, `connected`,
  `command`, `close`, `fatal`. `send(obj)` sender JSON-frames. **Vigtigt:** klienten
  forwarder KUN `type:'command'` (→ `command`) og `type:'connected'`. **Et
  `transaction_config`-frame ignoreres i dag** — `agentClient.js` skal udvides til at
  emitte en ny event (fx `transaction-config`) for `msg.type==='transaction_config'`.
  Det er det centrale hook-punkt agent-side.
- **Poll-scheduler (`runtime.js`):** to uafhængige `setInterval`-loops —
  `startReporting` (traffic) og `startScheduledProbes` — hver med en `running`-guard
  (ingen overlap), `unref()`-timer og **fast interval, ingen jitter**. Transaction-
  scheduleren følger samme mønster men **pr. test** med `interval_sec` + **jitter
  ±10 %** (nyt). Kommando-dispatch sker i `client.on('command')` via recognizers i
  `command.js` — transaction-config er dog IKKE en kommando (eget frame), så den
  håndteres via den nye event, ikke via `command.js`.
- **Buffer-mønster:** **findes ikke i dag.** Resultater postes via REST
  (`apiClient.postResults`/`postProbeResults`) **straks**; fejler POST'en, **droppes**
  resultatet (kun `reportError` + log). Der er **ingen offline-buffer/retry/flush**.
  Respec'ens "buffer max 1000, flush ved reconnect, ældste droppes ved overløb" er
  derfor **helt ny**: en in-memory ringbuffer i runtime, flush på `client.on('open')`
  via `client.send({type:'transaction_result', results:[…]})`.
- **Konfig-persistering:** i dag hentes kun monitor-config over REST (`getConfig`),
  ingen lokal fil. Respec vil have `transaction_config` **persisteret til JSON-fil**
  (så tests kører efter restart uden server), **secrets AES-256-GCM-krypteret med
  nøgle afledt af agent-token**, klartekst kun i memory. Nyt modul agent-side
  (fx `src/transactions/store.js`).
- **pkg-binær-krav:** ingen dynamiske `require()` — alle executor-moduler statisk
  require'et (som resten af agenten). `http/https/net/dns/child_process` er Node core.
  `ping` via `child_process.spawn` (Linux/Win/macOS output-parsing).

## 12. Frontend-audit — struktur, tabel/detalje, API-kald (Session 2, del 2/6)

**Filer:** `public/index.html` (nav + `#modal`), `public/app.js` (SPA), `public/styles.css`.

- **Struktur:** én vanilla-JS SPA. `el(tag,attrs,...kids)` DOM-helper; `views.<tab>`
  async-funktion pr. sektion returnerer en node; `render()` mounter aktuel view og
  stopper pollere; nav-knapper i `index.html` med `data-view="…"`. `PAGE_INFO.<tab>`
  = hero + hjælpetekst. Skriv-knapper gates via `data-min-role` + `isAdmin()`.
- **API-kald:** `api(path,{method,body})` (app.js:131) tilføjer Bearer, parser JSON,
  **kaster ved !ok med `err.status` + `err.data`**. 401 → auto-logout. `errText(e)`
  trækker `data.details` (valideringsfejl) ud. **404-mønster:** `try { await api(...) }
  catch (e) { return el('div',{class:'error'}, e.message) }` (jf. probeDetail
  app.js:3416) — pæn fejlside, ingen crash. Det opfylder respec'ens
  "404 ved ukendt test-id (pæn fejlside)".
- **Tabel/detalje-mønstre:** liste-views bygger `<table>` med `class:'clickable'`-rækker
  der kalder en drill-in (`openAgent(id)` app.js:4191 sætter `currentView` + `render()`).
  CRUD-med-modal: `openModal(title, fields, onSubmit)` (app.js:358) +
  `closeModal()`; `settingsIntegrationsView` er referencen for "liste + opret/redigér
  i modal + per-række test", inkl. write-only secret-felter (vis kun navn + sat/ikke-sat)
  — **præcis** mønstret transaktions-formularen skal genbruge.
- **Charts:** håndrullet SVG (`multiChart`, `historyChart`, `usageBar`, `robustBand`).
  Heatmap + trend skal være **ren SVG** (ingen chart-deps) — den slettede v1-sektion
  havde allerede `txHeatmapSvg`/`txTrendSvg` som skabelon (findes i git-historik på
  branchen før sletningen).
- **Genskabelse:** v1-dashboardet (liste/matrix/heatmap/trend/form) blev slettet i PR
  #130. Respec'ens frontend kan **delvist genbruges fra git-historikken**
  (`git show HEAD~1:public/app.js` for den slettede sektion) men skal opdateres til
  det nye API (`/api/transactions` + trend/heatmap-former, deviation-pile, secret-felt).

## 13. Åbne beslutninger (før kode)

1. **PR #130-reconciliation:** omskriv migration 046 + koden på branchen til respec'en
   (anbefalet — #130 er ikke merged), eller læg en migration 047 der ALTER'er? Da 046
   ikke er i main, er omskrivning renest og undgår ALTER-gæld.
2. **Sekvensering:** de seks workstreams (agent-executor, frontend, backend, WS/alert,
   agent igen, frontend igen) er audit-gated. Kør backend først (fundament: skema +
   secrets + baselines + REST), så WS/alert, så agent-executor, så frontend — eller en
   anden rækkefølge?
3. **icmp-privilegier:** system-`ping` kræver ikke root (bruger setuid/`ping`-binær),
   men output-parsing skal dække Linux/iputils, BSD/macOS og Windows. OK at antage
   `ping` findes (ellers `phase:'error'`)?
