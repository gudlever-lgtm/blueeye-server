# Storage Split Audit — MySQL → MySQL + TimescaleDB

> **Audit only — no code changes.**  
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
| `flow_rollup` | MySQL | **TSDB** | LOW — nightly batch | Nedsamplingsaggregat af `flow_records`; kan være en TimescaleDB continuous aggregate |
| `metric_rollup` | MySQL | **TSDB** | LOW — nightly batch | Nedsamplingsaggregat af `results`; samme som ovenfor |
| `audit_events` | MySQL | **TSDB** | HIGH (dedupliceret) | Hvert HTTP-svar + agent-WS-event; dedup via UNIQUE `dedup_key` reducerer rækkevækst men volumen er stadig høj |
| `ha_nodes` | MySQL | MySQL | LOW-MED — upsert ~30 s/node | HA-liveness; lille tabel, streng ACID (leader election) |
| `agents` | MySQL | MySQL | HIGH (kun `last_seen`/`status`) | Statisk inventory; kun `last_seen_at` + `status` opdateres hyppigt — se TSDB-note nedenfor |
| `agent_tokens` | MySQL | MySQL | HIGH (`last_used_at` touch) | Auth-hash-tabel; kun `last_used_at` opdateres pr. request |
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
| `audit_log` | MySQL | MySQL | LOW-MED | Compliance-spor (auth/user/license CRUD); menneskestyret |
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

### Tvivlstilfælde / særlig opmærksomhed

- **`agents.last_seen_at` + `agents.status`**: Disse to kolonner opdateres ved *hvert* agent-API-kald (agentAuth-middleware → `touchLastSeen`) og ved WS connect/disconnect. Opdateringsraten matcher `results`-ingest-raten. **Anbefaling:** behold `agents`-tabellen i MySQL (inventory kræver ACID), men overvej at skrive `last_seen_at` + `status` som en separat event-række i TSDB for at eliminere hyppige UPDATE-hot-spots på en bredt læst tabel.
- **`agent_tokens.last_used_at`**: Samme mønster — en touch pr. agent-request. Overvej lazy batching (opdatering kun hvis > X sekunder siden sidst).
- **`audit_events`**: Dedup-logikken (`ON DUPLICATE KEY UPDATE occurrences`) er en elegant løsning på volumenproblemet, men den skaber UPDATE-contention på rækker med en populær `dedup_key`. Kan flyttes til TSDB hvis dedup-semantikken replikeres (TimescaleDB understøtter upsert på hyptertabeller via `INSERT … ON CONFLICT`).

---

## Trin 2 — Ingest-path-skitse

Ingen kode — kun sekvensdiagram og modulreferencer.

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
- **Split sker i collector-tieret** (agentReports.js), ikke i repositories — repositories splittes i to versioner: `*Repo` (MySQL) og `*TsdbRepo` (TimescaleDB).
- **Ingen distribueret query-motor** — join i applikationslaget.

```
Agent
  │
  ├─ POST /agents/results
  │      │
  │      ▼
  │  agentReports.js  ◄─── ingen ændring i routing
  │      │
  │      ├─ [STATIC]  agents.touchLastSeen()         ──► MySQL
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
                        (åbn/luk incident-rækker)
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
| `src/geo/flowPipeline.js` | Injicér TSDB-flowRepo i stedet for MySQL-flowRepo |
| `src/analysis/pipeline.js` | Injicér TSDB-findingStore |
| `src/incidents/incidentService.js` | Injicér TSDB-incidentsRepo |
| `src/routes/agentReports.js` | Injicér begge repo-sæt (MySQL + TSDB) |
| `src/server.js` (wire-up) | Opret TSDB-pool (pg-klient); injicér i factories |
| `src/analysis/retention/repo.js` | Rollup-queries → TimescaleDB continuous aggregates (kan erstatte nightly job) |
| `migrations/` | Tilføj TimescaleDB-skema-migrationer (CREATE TABLE + `create_hypertable`) |

### Batch/COPY-strategi

- **`results`** og **`probe_results`**: saml inden for hvert agent-POST (typisk 1–5 rækker pr. kald); brug PostgreSQL `COPY FROM STDIN` via `pg-copy-streams` eller parametriseret multi-row `INSERT`.
- **`flow_records`**: kan have mange rækker pr. kald (topTalkers × byPort × byProtocol); COPY er her særligt vigtigt.
- **Ingen row-by-row INSERT** i ingest-hot-path — det er MySQL-mønstret der *ikke* skal gentages i TSDB.

---

## Trin 3 — JOIN-inventory og applikationslags-joinmønster

### Cross-store JOINs der eksisterer i dag

Disse SQL-JOINs blander i dag statisk og tidsserie i MySQL. Alle er potentielle flaskehalse og skal håndteres i applikationslaget efter splittet.

| Forespørgsel | Tabel (TSDB) | JOIN-mål (MySQL) | Brugt af |
|---|---|---|---|
| `resultsRepository.rangeByLocation` | `results` | `agents` (location_id-filter) | Traffic view pr. lokation |
| `resultsRepository.latestByLocation` | `results` (MAX subquery) | `agents` | Fleet-status, dashboard |
| `resultsRepository.latestPerAgent` | `results` (GROUP BY MAX(id)) | — (agent-join i JS) | Fleet health rollup |
| `probeResultsRepository.availability` | `probe_results` | `agents`, `locations` | Uptime-rapport |
| `probeResultsRepository.fleetHealth` | `probe_results` | — (agent-grouping i JS) | Fleet health |
| `flowsRepository.topologyEdges` | `flow_records` | `agents` (subquery: WHERE agent_id IN SELECT) | Topologi-visning |
| `flowsRepository.selectFlows` / `sumByDest` | `flow_records` + `flow_rollup` | — | Geo-flow-rapporter |
| `incidentsRepository.list` / `findActive` | `incidents` | `agents`, `locations` | Incident-liste, dashboard |
| `auditEventsRepository.list` | `audit_events` | `agents` (hostname lookup) | Audit-log UI |

### Anbefalet mønster efter split: applikationslagsjoin

Princip: **hent statisk fra MySQL, hent telemetri fra TSDB, join i JS på `agent_id`/`location_id`.**

```
Eksempel: "Vis interface-udnyttelse for switch X"

1. MySQL:   SELECT id, hostname, display_name, location_id
            FROM agents WHERE id = :agentId
               ↓
           { agentId: 42, hostname: 'sw-aarhus-01', locationId: 7 }

2. TSDB:    SELECT ts, payload
            FROM results
            WHERE agent_id = 42
              AND ts >= :from AND ts <= :to
            ORDER BY ts
               ↓
           [{ ts, payload: { interfaces: [...] } }, ...]

3. JS:      const enriched = tsdbRows.map(r => ({
              ...r,
              hostname: agent.hostname,
              locationId: agent.locationId,
            }))
```

```
Eksempel: "Uptime-rapport for lokation Y"

1. MySQL:   SELECT id FROM agents WHERE location_id = :locationId
               ↓
           [{ id: 42 }, { id: 43 }]

2. TSDB:    SELECT agent_id, ts, type, target, ok, rtt_ms, loss_pct
            FROM probe_results
            WHERE agent_id = ANY(:agentIds)   -- psql array-binding
              AND ts >= :from AND ts <= :to
               ↓
           [rækker for begge agenter]

3. JS:      GROUP BY agent_id; beregn availability%;
            merge med agent-metadata fra trin 1.
```

```
Eksempel: "Topologi-kanter for lokation Y"

1. MySQL:   SELECT id FROM agents WHERE location_id = :locationId
               ↓ agentIds

2. TSDB:    SELECT src_ip, dst_ip, direction, SUM(bytes), SUM(flows)
            FROM flow_records
            WHERE agent_id = ANY(:agentIds)
              AND ts >= :from AND ts <= :to
            GROUP BY src_ip, dst_ip, direction
               ↓ kanter

3. JS:      returner kanter (ingen yderligere join nødvendig)
```

### Den dyre fælde der skal undgås

**`latestPerAgent`-mønstret** (`SELECT … JOIN (SELECT agent_id, MAX(id) FROM results GROUP BY agent_id)`) er en fuld-tabel-GROUP-BY. I TimescaleDB erstattes det med:

```sql
-- TimescaleDB: last() aggregate function
SELECT agent_id,
       last(payload, ts)     AS payload,
       last(ts, ts)          AS last_ts
FROM results
WHERE ts >= now() - interval '5 minutes'   -- bounded time-filter er obligatorisk
GROUP BY agent_id;
```

Altid med en tidsgrænse i WHERE — aldrig ubegrænset GROUP BY på en hypertabel.

### JOIN'er der *ikke* kræver ændring

- `agents × locations` (static × static) — forbliver i MySQL uændret.
- `enrollment_codes × locations` — forbliver i MySQL.
- `incidents × agents × locations` — når `incidents` flyttes til TSDB løsnes denne JOIN; applikationslagsjoin som vist ovenfor.
- `audit_events × agents` (hostname-lookup) — `audit_events` flyttes til TSDB; hostname slås op i MySQL og stitches i JS.

---

## Sammenfatning

### Hvad flytter til TimescaleDB

`results`, `flow_records`, `probe_results`, `findings`, `incidents`, `speedtest_results`, `audit_events`, `flow_rollup`\*, `metric_rollup`\*

\* `flow_rollup` og `metric_rollup` kan med fordel erstattes af TimescaleDB continuous aggregates, som vedligeholder nedsampling automatisk og eliminerer det nightly retention-job.

### Hvad forbliver i MySQL

Alt andet — inventory, auth, config, compliance, audit-trail (menneskestyret), NIS2-modul, SSO-konfiguration, licenser, HA-koordination.

### Næste skridt (uden for denne audits scope)

1. Definer TimescaleDB-skema + hypertabel-chunks for hver TSDB-tabel.
2. Opdel repositories i MySQL- og TSDB-varianter; injicér via DI i `server.js`.
3. Implementér applikationslagsjoin i de berørte forespørgsler (se trin 3).
4. Migrér historiske data (mysqldump → `\COPY` eller ETL-script).
5. Bump `package.json` version (minor) ved release af splittet.
