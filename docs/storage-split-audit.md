# Storage Split Audit — MySQL → MySQL + TimescaleDB

> Date: 2026-07-02  
> Repos: `blueeye-server`, `blueeye-agent`  
> Target TSDB: TimescaleDB (PostgreSQL extension, EU-sovereign, on-prem)

---

## Trin 1 — Tabelklassifikation

Each table is classified as **STATIC** (stays in MySQL) or **TELEMETRY** (moves to TimescaleDB).
Write volume is estimated per agent at the default 60-second report interval.

| Table | Nuværende store | Mål-store | Skrivevolumen (est.) | Begrundelse |
|---|---|---|---|---|
| `results` | MySQL | **TSDB** | HIGH — ~1 row/min/agent | JSON blob med interface-trafik + system-metrics; primær tidsserie |
| `flow_records` | MySQL | **TSDB** | HIGH — mange rækker/min/agent | Geo-beriget 5-tuple; skalerer med antal flows pr. rapport |
| `probe_results` | MySQL | **TSDB** | HIGH — ~N rows/min/agent (N = probe-targets) | Aktiv probe-historik (ping/tcp/dns/http/traceroute); aldrig rullet op |
| `findings` | MySQL | **TSDB** | MEDIUM — debounced 10 s/agent | Anomali-scores (MAD/z-score/flatline); skrevet af analysepipeline ved hvert ingest |
| `incidents` | MySQL | **TSDB** | MEDIUM — én åben række pr. (agent, metric, target) | Incident-livscyklus startet/afsluttet af proberesultater |
| `speedtest_results` | MySQL | **TSDB** | LOW — on-demand | Throughput-målinger; lav frekvens men naturlig tidsserie |
| `flow_rollup` | MySQL | **TSDB** | LOW — nightly batch | Nedsamplingsaggregat af `flow_records`; erstattes af TimescaleDB continuous aggregate |
| `metric_rollup` | MySQL | **TSDB** | LOW — nightly batch | Nedsamplingsaggregat af `results`; erstattes af TimescaleDB continuous aggregate |
| `audit_events` | MySQL | **TSDB** | HIGH (dedupliceret) | Ingen hash-kæde — kan flyttes sikkert. Se beslutning Punkt 2. |
| `audit_log` | MySQL | **MySQL** | LOW-MED | Hash-kæde med `prev_hash`/`entry_hash` pr. række. Forbliver i MySQL. Se beslutning Punkt 2. |
| `ha_nodes` | MySQL | MySQL | LOW-MED — upsert ~30 s/node | HA-liveness; lille tabel, stræng ACID (leader election) |
| `agents` | MySQL | MySQL | HIGH (kun `last_seen`/`status`) | Inventory forbliver i MySQL; liveness-throttle se beslutning Punkt 1 |
| `agent_tokens` | MySQL | MySQL | HIGH (`last_used_at` touch) | Auth-hash-tabel; liveness-throttle se beslutning Punkt 1 |
| `api_tokens` | MySQL | MySQL | LOW | Admin-udstedte API-nøgler |
| `users` | MySQL | MySQL | VERY LOW | Brugerkatalog + præferencer |
| `locations` | MySQL | MySQL | VERY LOW | Fysiske sites |
| `enrollment_codes` | MySQL | MySQL | VERY LOW | Engangsbrugskoder |
| `app_settings` | MySQL | MySQL | VERY LOW | Nøgle/værdi runtime-config |
| `test_packages` | MySQL | MySQL | VERY LOW | Probe-pakkekonfiguration |
| `incident_thresholds` | MySQL | MySQL | VERY LOW | Tærskelkonfiguration |
| `integrations` | MySQL | MySQL | VERY LOW | ServiceNow/Nautobot-konfiguration (krypterede credentials) |
| `ldap_config` / `ldap_role_map` | MySQL | MySQL | VERY LOW | LDAP-konfiguration |
| `oidc_role_map` / `saml_role_map` | MySQL | MySQL | VERY LOW | SSO-rollemapping |
| `license_plans` / `licenses` | MySQL | MySQL | VERY LOW | Ed25519-signerede licensblade |
| `agent_release_key` | MySQL | MySQL | VERY LOW | Ed25519-nøglepar til agent-signering |
| `agent_action_audit` | MySQL | MySQL | LOW | Agent-upgrade/delete-forløb |
| `integration_audit` | MySQL | MySQL | LOW | Outbound integration-kald |
| `ldap_login_audit` / `sso_login_audit` | MySQL | MySQL | LOW | Login-forsøg (SSO) |
| `blueeye_nis2_risks` | MySQL | MySQL | LOW | Manuel risikoregister |
| `blueeye_nis2_controls` | MySQL | MySQL | LOW | Kontrolregister |
| `blueeye_nis2_incidents` | MySQL | MySQL | LOW | NIS2-hændelsesbog |
| `blueeye_nis2_reports` | MySQL | MySQL | LOW | Rapportarkiv |
| `blueeye_nis2_evidence` | MySQL | MySQL | LOW | Dokumentmappe |
| `blueeye_audit_log` | MySQL | MySQL | LOW | NIS2-ændringslog |
| `investigations` | MySQL | MySQL | LOW | Operatørinitierede root-cause-analyser |
| `schema_migrations` | MySQL | MySQL | VERY LOW | Migrationsbookkeeping |

---

## Trin 2 — Ingest-path-skitse

### Nuværende flow (enkelt MySQL-store)

```
Agent
  │
  ├─ POST /agents/results ──────────────────────────────────────────────────┐
  │                                                                          ▼
  │                                                               agentReports.js
  │                                                                   │
  │                                            ┌──────────────────────┤
  │                                            │                      │
  │                                            ▼                      ▼
  │                                    resultsRepo          geo/flowPipeline.js
  │                                    .createMany()         → flowsRepo.insertMany()
  │                                    → INSERT results      → INSERT flow_records
  │                                            │
  │                                            └──► analysis/pipeline.js (debounced 10s)
  │                                                  → findingStore.upsert()
  │                                                  → INSERT/UPDATE findings
  │
  └─ POST /agents/probe-results ────────────────────────────────────────────┐
                                                                             ▼
                                                                   agentReports.js
                                                                       │
                                                         ┌─────────────┤
                                                         │             │
                                                         ▼             ▼
                                                 probeResultsRepo  incidents/
                                                 .createMany()     incidentService.js
                                                 → INSERT probe_results  (debounced 10s)
                                                                   → INSERT/UPDATE incidents
```

### Målflow (MySQL + TimescaleDB)

Principper:
- **Static writes** → MySQL uændret.
- **Telemetry writes** → TSDB via `COPY` / batch `INSERT` (ikke row-by-row).
- **Split sker i collector-tieret** (agentReports.js) — repositories splittes i to varianter: `*Repo` (MySQL) og `*TsdbRepo` (TimescaleDB).
- **Ingen distribueret query-motor** — join i applikationslaget.

```
Agent
  │
  ├─ POST /agents/results
  │      │
  │      ▼
  │  agentReports.js  ◄─── ingen ændring i routing
  │      │
  │      ├─ [STATIC]  agents.touchLastSeen()         ──► MySQL   (throttled 60s)
  │      │
  │      ├─ [TSDB]    resultsRepo.createMany()       ──► TimescaleDB
  │      │            via COPY (batch pgcopy)
  │      │
  │      └─ [TSDB]    flowPipeline.processResults()
  │                   → flowsRepo.insertMany()       ──► TimescaleDB
  │                     via batch INSERT
  │
  └─ POST /agents/probe-results
         │
         ▼
     agentReports.js
         │
         ├─ [TSDB]    probeResultsRepo.createMany()  ──► TimescaleDB
         │            via batch INSERT
         │
         └─ [TSDB]    incidentService.processAgent()
                      → incidentsRepo.*               ──► TimescaleDB
```

### Berørte moduler ved split

| Modul | Ændring |
|---|---|
| `src/repositories/resultsRepository.js` | Ny TSDB-variant; SQL → psql-klient + batch COPY |
| `src/repositories/flowsRepository.js` | Ny TSDB-variant; `insertMany` → COPY |
| `src/repositories/probeResultsRepository.js` | Ny TSDB-variant; batch INSERT |
| `src/repositories/findingsRepository.js` | Ny TSDB-variant; upsert via `ON CONFLICT` |
| `src/repositories/incidentsRepository.js` | Ny TSDB-variant |
| `src/repositories/speedtestResultsRepository.js` | Ny TSDB-variant |
| `src/repositories/auditEventsRepository.js` | Ny TSDB-variant; dedup via `ON CONFLICT (dedup_key) DO UPDATE` |
| `src/geo/flowPipeline.js` | Injicér TSDB-flowRepo |
| `src/analysis/pipeline.js` | Injicér TSDB-findingStore |
| `src/incidents/incidentService.js` | Injicér TSDB-incidentsRepo |
| `src/routes/agentReports.js` | Injicér begge repo-sæt (MySQL + TSDB) |
| `src/server.js` (wire-up) | Opret TSDB-pool (pg-klient); injicér i factories |
| `src/analysis/retention/repo.js` | Rollup-queries → TimescaleDB continuous aggregates |
| `migrations/` | Tilføj TSDB-skema-migrationer (`CREATE TABLE` + `create_hypertable`) |

### Batch/COPY-strategi

- **`results`** og **`probe_results`**: typisk 1–5 rækker pr. POST; multi-row `INSERT` eller `COPY FROM STDIN`.
- **`flow_records`**: mange rækker pr. POST (topTalkers × byPort × byProtocol); `COPY` er her særligt vigtig.
- **Ingen row-by-row INSERT** i ingest-hot-path.

---

## Trin 3 — JOIN-inventory og applikationslags-joinmønster

### Cross-store JOINs der eksisterer i dag

| Forespørgsel | Tabel (TSDB) | JOIN-mål (MySQL) | Brugt af |
|---|---|---|---|
| `resultsRepository.rangeByLocation` | `results` | `agents` (location_id-filter) | Traffic view pr. lokation |
| `resultsRepository.latestByLocation` | `results` (MAX subquery) | `agents` | Fleet-status, dashboard |
| `resultsRepository.latestPerAgent` | `results` (GROUP BY MAX(id)) | — (agent-join i JS) | Fleet health rollup |
| `probeResultsRepository.availability` | `probe_results` | `agents`, `locations` | Uptime-rapport |
| `probeResultsRepository.fleetHealth` | `probe_results` | — (agent-grouping i JS) | Fleet health |
| `flowsRepository.topologyEdges` | `flow_records` | `agents` (subquery) | Topologi-visning |
| `flowsRepository.selectFlows` / `sumByDest` | `flow_records` + `flow_rollup` | — | Geo-flow-rapporter |
| `incidentsRepository.list` / `findActive` | `incidents` | `agents`, `locations` | Incident-liste, dashboard |
| `auditEventsRepository.list` | `audit_events` | `agents` (hostname lookup) | Audit-log UI |

### Anbefalet mønster efter split: applikationslagsjoin

Princip: **hent statisk fra MySQL, hent telemetri fra TSDB, join i JS på `agent_id`.**

```
Eksempel: "Vis interface-udnyttelse for switch X"

1. MySQL:   SELECT id, hostname, display_name, location_id
            FROM agents WHERE id = :agentId

2. TSDB:    SELECT ts, payload
            FROM results
            WHERE agent_id = 42
              AND ts >= :from AND ts <= :to
            ORDER BY ts

3. JS:      tsdbRows.map(r => ({ ...r, hostname: agent.hostname, locationId: agent.locationId }))
```

```
Eksempel: "Uptime-rapport for lokation Y"

1. MySQL:   SELECT id FROM agents WHERE location_id = :locationId

2. TSDB:    SELECT agent_id, ts, type, target, ok, rtt_ms, loss_pct
            FROM probe_results
            WHERE agent_id = ANY(:agentIds)
              AND ts >= :from AND ts <= :to

3. JS:      GROUP BY agent_id; beregn availability%; merge med metadata fra trin 1.
```

### Den dyre fælde der skal undgås (se også Punkt 3-beslutning)

`latestPerAgent`-mønstret (`GROUP BY MAX(id)`) er en fuld-tabel-scan i MySQL. I TimescaleDB erstattes det med `last()` på en afgrænset tidsperiode — se Punkt 3.

---

## Åbne beslutninger — afklaret 2026-07-02

### Punkt 1 — Hot-spot UPDATEs (agents.last\_seen, agent\_tokens.last\_used\_at)

**Fund:** Throttle-mønstret eksisterer allerede i `src/auth/agentAuth.js`:

```js
const TOUCH_THROTTLE_MS = 60000;   // én write pr. 60s pr. agentId
const lastTouched = new Map();
// ...
if (now - (lastTouched.get(agent.agentId) || 0) >= TOUCH_THROTTLE_MS) {
  lastTouched.set(agent.agentId, now);
  await Promise.all([
    agentTokensRepo.touchLastUsed(agent.tokenId),
    agentsRepo.touchLastSeen(agent.agentId),
  ]);
}
```

WebSocket-stien i `src/ws/agentSocket.js` har et tilsvarende 60s-throttle per socket.

**Beslutning:**
- **Ingen kodeændring.** 60s-throttlen opfylder kravet om max 1 write/30s og er allerede implementeret.
- `agents` og `agent_tokens` forbliver i MySQL. Hotspot-problemet er dermed løst i applikationslaget, ikke ved at flytte tabellerne.
- Throttlen er in-process (per `Map`-instans) og virker korrekt i single-process-deployment. I HA-multi-node-setup kan to noder skrive inden for 60s til den samme agent — acceptabelt, da `last_seen`/`last_used_at` er informative (ikke transaktionelle).

**Test:** `test/agentAuth.test.js` (8 cases: 401-no-token, 401-invalid-token, 401-null-agent, 401-wrong-scheme, throttle-100-requests, throttle-new-agentId, DB-down-best-effort, token-lookup-500).

---

### Punkt 2 — audit\_events + hash-chain integritet

**Fund ved gennemgang af kodebasen:**

| Tabel | Hash-kæde? | Detaljer |
|---|---|---|
| `audit_events` | **Ingen** | Ingen `prev_hash`/`entry_hash`-kolonner. Ingen tamper-evidence. Dedup via `ON DUPLICATE KEY UPDATE occurrences`. |
| `audit_log` | **Ja — selvbærende** | Migration 041 tilføjer `prev_hash CHAR(64)` og `entry_hash CHAR(64)` til hver række. `record()` læser forrige rækkes hash og inkorporerer den. `verifyChain()` traverserer `ORDER BY id ASC` og recomputer hash for hver række. |

**Selvbærenhed af audit\_log-kæden:** Hver række gemmer eksplicit `prev_hash` (forrige rækkes `entry_hash`). Sletning af en mellemlæggende række er detekterbar, fordi den efterfølgende rækkes `prev_hash` ikke længere matcher den nye foregåers `entry_hash`. Kæden er dermed **ikke** afhængig af storage-rækkefølge for integritetsverifikation.

**Hvorfor audit\_log alligevel forbliver i MySQL:**
1. `verifyChain` traverserer `ORDER BY id ASC` og antager, at auto-increment-id'erne er strengt sekventielle og i indsætningsrækkefølge. MySQL InnoDB garanterer dette for enkelt-node-insert. TimescaleDB-hypertabeller med parallel chunk-insert garanterer det ikke — to næsten-samtidige inserts kan få ikke-stigende BIGINT-id'er afhængigt af sekvens-caching.
2. `audit_log` er lav-medium volumen (menneskestyret compliance-hændelser). Det er ikke en hotspot-tabel; MySQL er tilstrækkelig.
3. ACID-garanti er vigtig: en hash-kæde der brydes pga. en delvist committed transaktion under crash er kritisk for compliance.

**Beslutning:**
- `audit_events` → **TSDB** bekræftet (ingen kæde, høj volumen, dedup-semantik kan replikeres via `ON CONFLICT`).
- `audit_log` → **forbliver i MySQL** (hash-kæde, lav volumen, ACID-krav).
- Tabelklassifikationen ovenfor er opdateret tilsvarende.

**Ingen kodeændring i denne session.** Beslutningen er dokumenteret.

**Implementeringsnote (skema-fase, `server/db/timescale/001_init.sql`):**
`audit_events` bevarer sin TSDB-placering, men dedup-mekanismen ændres.
MySQL-tabellen folder gentagen aktivitet på én række via `UNIQUE(dedup_key)` +
`ON DUPLICATE KEY UPDATE occurrences`. En TimescaleDB-hypertabel **kan ikke**
bære et globalt `UNIQUE(dedup_key)`: unikke indekser på en hypertabel skal
inkludere partitionsnøglen (`ts`), så en dedup-nøgle kan ikke håndhæves på
tværs af chunks. Den TSDB-native løsning er **append-only**: hver forekomst
gemmes som sin egen række, og `occurrences`/`first_seen`/`last_seen` udledes ved
læsning (`GROUP BY dedup_key, min(ts), max(ts), count(*)`). Dette er tillige
strengere audit-semantik (ingen mutation af historiske rækker). Beslutningen om
placering (`audit_events` → TSDB) står ved magt; kun mekanismen forfines.

---

### Punkt 3 — latestPerAgent MAX(id) GROUP BY → TimescaleDB last()

**Problem:** Den nuværende MySQL-query i `resultsRepository.latestPerAgent` kører en ubegrænset `GROUP BY MAX(id)` over hele `results`-tabellen. Den skalerer O(n) med rækkeantal og bliver ubrugeligt langsom når tabellen vokser.

**Løsning i TimescaleDB:**

TimescaleDB's `last(value, time)` aggregatfunktion returnerer den værdi der hører til den seneste `time` inden for gruppen. Med en tvungen tidsafgrænsning i WHERE-klæulen opnår man chunk-exclusion:

```sql
-- Erstatningsquery for resultsRepository.latestPerAgent
SELECT
  agent_id,
  last(payload, ts)  AS payload,
  last(ts, ts)       AS last_ts
FROM results
WHERE ts >= now() - INTERVAL '5 minutes'
GROUP BY agent_id;
```

**Chunk-exclusion:** Hypertabellen partitioneres på `ts` med `chunk_time_interval = '1 hour'`. En WHERE på `ts >= now() - INTERVAL '5 minutes'` scanner maksimalt ét chunk — uafhængigt af fleetstørrelse. TimescaleDB's query planner ekskluderer alle ældre chunks automatisk via constraint exclusion på partition-nøglen.

Verifikation med EXPLAIN (køres mod en real TSDB-instans ved implementering):
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT agent_id, last(payload, ts) AS payload, last(ts, ts) AS last_ts
FROM results
WHERE ts >= now() - INTERVAL '5 minutes'
GROUP BY agent_id;
-- Forvent: CustomScan (ChunkAppend) med én chunk i Append-listen.
-- Uacceptabelt: SeqScan på alle chunks (manglende tidsfilter).
```

**Invariant:** `WHERE`-klæulen på `ts` er **obligatorisk** — aldrig ubegrænset `GROUP BY` på en hypertabel.

**Fleet health-kontekst:** Fleet-health-dashboardet bruger `latestPerAgent` til at vise seneste målinger for alle agenter. 5-minutters vinduet passer til agent-rapportinterval på 60s: alle agenter med en aktiv forbindelse er repræsenteret. Agenter der ikke har rapporteret inden for 5 minutter vises med `null` telemetri (se app-layer join-mønster i trin 3 og test nedenfor).

**Latency-target:** < 50 ms for 2.600 agenter på commodity hardware. Kræver benchmark mod real TSDB-instans (`bench/latestPerAgent.bench.js`, oprettes under implementering).

**Test:** `test/storageAppLayerJoin.test.js` (6 cases: korrekt join, agent-uden-telemetri vises med null, tom fleet, ukendte TSDB-rækker ignoreres, TSDB-fejl propageres, tom TSDB giver null-rækker). Testene validerer join-logikken mod in-memory fakes — ingen real TSDB-forbindelse nødvendig.

---

## Sammenfatning

### Hvad flytter til TimescaleDB

`results`, `flow_records`, `probe_results`, `findings`, `incidents`, `speedtest_results`, `audit_events`, `flow_rollup`\*, `metric_rollup`\*

\* Kan erstattes af TimescaleDB continuous aggregates — eliminerernightly retention-job.

### Hvad forbliver i MySQL

Alt andet: inventory, auth, config, compliance (`audit_log` inkl. hash-kæde), NIS2-modul, SSO-konfiguration, licenser, HA-koordination.

### Implementeringsnoter — TSDB-skema (`server/db/timescale/001_init.sql`)

Skema-fasen er påbegyndt. Filen er idempotent og validérbar; se
`server/db/timescale/README.md`. Beslutninger truffet under skema-bygningen:

- **Tidskolonne `ts` (ikke `time`).** Alle hypertabeller bruger `ts
  TIMESTAMPTZ NOT NULL` for at Punkt 3-queryen (`last(payload, ts)`) virker
  uændret. MySQL-kildekolonner mappes: `results.created_at → ts`,
  `findings.created_at → ts`, `incidents.started_at → ts`; resten har `ts`.
- **`metric_rollup` som WIDE continuous aggregate fra `results`.** App-rollup'en
  pivoterer hver JSON-payload til mange `(metric, value)`-rækker via
  `extractSamples()`. En continuous aggregate er én `GROUP BY` og kan ikke
  pivotere én række til mange. Metric-sættet er lille og fast, så aggregatet
  materialiserer én bred række pr. `(agent, bucket)` med en avg/min/max-kolonne­
  gruppe pr. metric, udtrukket fra JSONB på samme stier som `extractSamples`
  (cpu, mem, load1, rx/tx bytes/sec). Ny metric = ny kolonnegruppe (bevidst,
  reviewet skemaændring). Læse-stien tilpasses i repository-split-fasen.
- **`flow_rollup` som continuous aggregate fra `flow_records`** (1-times buckets,
  grain `(agent, direction, country, asn)`, kun eksterne/geolokaliserede flows).
  De gamle MySQL-rollup-tabeller + nightly rollup-job pensioneres på TSDB-stien.
- **Ingen eksakt median i rollups.** Continuous aggregates kan ikke beregne
  eksakt median; aggregaterne beholder sum/min/max/avg/count. Approksimeret
  median kræver `timescaledb_toolkit` (`percentile_agg`) — bevidst holdt ude af
  basismigrationen for at være afhængigheds-let.
- **`audit_events` er append-only** (se Punkt 2-implementeringsnote ovenfor).
- **Deploy:** `deploy/install-timescale.sh` provisionerer en dedikeret
  Ubuntu-node (adskilt fra MySQL på 192.168.1.140); se `deploy/README-timescale.md`.

### Næste skridt (implementeringsfase)

1. ✅ Definér TSDB-skema: `CREATE TABLE` + `SELECT create_hypertable('results', 'ts', chunk_time_interval => INTERVAL '1 hour')`. — implementeret i `server/db/timescale/001_init.sql`.
2. Opdel repositories i MySQL- og TSDB-varianter; injicér via DI i `server.js`.
3. Implementer applikationslagsjoin i de berørte forespørgsler (trin 3).
4. Migrér historiske data (mysqldump → `\COPY` eller ETL-script).
5. Kør `EXPLAIN ANALYZE` på latestPerAgent-query for at bekræfte chunk-exclusion.
6. Kør `bench/latestPerAgent.bench.js` mod 2.600 syntetiske agenter.
7. Bump `package.json` version (minor) ved release.
