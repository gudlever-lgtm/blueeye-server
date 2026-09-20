# SNMP-AUDIT — hvad findes allerede, før der besluttes noget

> Dato: 2026-09-20 · Repos: `blueeye-server`, `blueeye-agent`
> Anledning: overvejelse om en SNMP-poller i agenten til IF-MIB-tællere,
> EtherLike duplex/FCS, ARP-tabel og LLDP-naboer.
>
> **Ingen kode er skrevet. Ingen filer rørt ud over denne.**

---

## Kort version

Tre ting bør afgøre beslutningen, og de står alle tre i koden i dag:

1. **Det meste af det foreslåede findes allerede.** IF-MIB-tællere med errors,
   discards, oper-status, speed og EtherLike late collisions polles af
   `blueeye-agent/src/snmpMonitor.js`. LLDP-naboer og VLAN'er polles af
   `src/snmpTopology.js`. ARP-tabellen indsamles af `src/arpTable.js` fra
   agentens egen vært. Det der mangler er ikke indsamling — det er **at binde
   tællerne til en enhed i stedet for til en agent, og at gemme dem over tid.**
2. **`net-snmp` er ikke installeret nogen steder.** Ikke i `package.json`, ikke
   i `install.sh`, ikke i nogen Dockerfile. Hele SNMP-fladen i agenten er
   funktionel kode der kaster `SNMP_UNAVAILABLE` på enhver udrullet vært.
3. **Præmissen om L2-loop-detection via BRIDGE-MIB holder ikke.** Der findes
   ingen loop-detektor. `src/diagnose/playbooks/l2_loop.json` er en
   symptom-playbook — tekst og en testplan, ingen SNMP.

---

## 1. Eksisterende SNMP-kode

### Bibliotek

| | |
|---|---|
| Bibliotek | `net-snmp` (npm) |
| Version | **ingen** — står ikke i `blueeye-agent/package.json` |
| Installeret | **nej** — `node_modules/` indeholder kun `ws` |
| Hvor krævet | `require('net-snmp')` i fire filer, altid **lazy og i try/catch** |

`blueeye-agent/package.json` har præcis én runtime-dependency: `ws`. SNMP er
bevidst en *valgfri* afhængighed: `src/capabilities.js:27` rapporterer
`unavailable.snmp = 'net-snmp not installed (npm install net-snmp)'` til
serveren, og dashboardet viser det. Men **intet i `install.sh`, `Dockerfile`
eller `Dockerfile.slim` installerer den**, så en agent i marken kan ikke
udføre SNMP overhovedet — hverken tællere, topologi eller trap-dekodning.

Det er den første ting der skal afklares, uanset hvad der ellers besluttes.

### Hvor koden ligger — og den er isoleret

Alt SNMP er **agent-side**. Serveren indeholder ikke én eneste OID:
`grep -rn "1.3.6.1" blueeye-server/src/` giver nul træf.

| Fil | Rolle | OID-lag isoleret? |
|---|---|---|
| `blueeye-agent/src/snmpMonitor.js` | IF-MIB tællere → trafik-sample | Ja. `OID`-konstant øverst, `defaultReadCounters` er injicerbar (`readCounters`) |
| `blueeye-agent/src/snmpTopology.js` | FDB/LLDP/VLAN/ifName | Ja. `OID`-konstant, `defaultReadTables` injicerbar, `buildTopology()` er **ren** |
| `blueeye-agent/src/snmpPoller.js` | Skemalægning pr. enhed | Kender ingen OID'er — kalder `pollSnmpTopology` |
| `blueeye-agent/src/traps/translate.js` | ~40 trap-OID'er → event_type | Ja. Tabel, ikke MIB-compiler |

Mønsteret er konsekvent og værd at genbruge: **en injicerbar reader ind, rene
rækker ud.** Ingen af modulerne kræver `net-snmp` for at blive testet.

### Session, timeout, retry, concurrency

- **Session**: `net.createSession(host, community, { port, version })` pr. poll,
  lukkes i `finally`. Ingen session-pool, ingen genbrug mellem cyklusser.
- **Timeout**: `snmpPoller.js` giver hver enhed 30 s (`DEFAULT_TIMEOUT_MS`) via
  `withTimeout()`. Timeren er **bevidst ikke `unref`'d** — den findes for at
  opgive et hængt poll, så den skal holde event-loopet i live (kommentar i
  filen forklarer det; en tidligere `unref` betød at et hængt poll aldrig timede ud).
- **Retry**: ingen. En enhed der fejler venter sit eget interval ud
  (`lastAttempt`-map), i stedet for at blive prøvet hver tick.
- **Concurrency**: **sekventiel**, bevidst. Kommentaren: *"Ten simultaneous
  bridge-table walks out of one host is a burst that looks like a scan."*
  `snmpMonitor.js` kører derimod sine kolonne-walks **parallelt**
  (`Promise.all` over 10 kolonner) — mod én enhed.
- **Interval-gulv**: 60 s (`MIN_INTERVAL_SEC`), default 300 s pr. enhed.
  Tick er 30 s og spørger kun hvem der er due.

### GET / GETNEXT / GETBULK

Kun **`session.subtree()`** (GETNEXT-walk) i begge moduler. Ingen `get()`,
ingen `getBulk()`. For 20 enheder × 48 porte × 10 kolonner er det relevant:
`subtree` med default max-repetitions er markant flere round-trips end en
GETBULK-tunet walk. `net-snmp` understøtter `maxRepetitions` på subtree — det
udnyttes ikke i dag.

### SNMP-versioner

**Kun v1 og v2c.** To steder hardkoder det:

```js
const version = snmp.version === '1' ? net.Version1 : net.Version2c;
```

og databasen: `snmp_devices.version ENUM('1','2c')`. **v3 authPriv findes ikke
— hverken i kode, schema, validering eller UI.** `net-snmp` understøtter v3,
så det er en udvidelse, ikke et biblioteksskifte.

### Credentials i dag

| Trin | Hvad sker der |
|---|---|
| Indtastning | Dashboard → Settings → SNMP-enheder (`settingsSnmpDevicesView()` i `public/app.js`), admin-only |
| Validering | `src/validation/snmpDeviceValidation.js` (`COMMUNITY_MAX = 128`) |
| At rest | `snmp_devices.community_encrypted`, AES-256-GCM via `src/lib/secretBox.js` |
| Læsning | `SAFE_COLUMNS` **udelader** kolonnen; kun `listForAgentWithSecret()` henter den |
| Til agenten | `GET /agents/me/config` (`src/routes/agentReports.js:239`) dekrypterer og lægger dem i `body.snmpTargets[].community` |
| I agenten | Kun i hukommelsen (`applySnmpTargets`). **Aldrig på disk.** |

Community-strengen returneres altså aldrig til dashboardet, men går i klartekst
over TLS til agenten ved hver config-hentning. Det er det eneste sted i
systemet hvor en dekrypteret hemmelighed forlader serveren.

### Genbrugelige MIB/OID-konstanter

Ja — tre steder, ingen delt:

- `snmpMonitor.js OID` — IF-MIB + `dot3StatsLateCollisions`
- `snmpTopology.js OID` — IF-MIB (`ifName`, `ifAlias`), BRIDGE-MIB,
  Q-BRIDGE-MIB, LLDP-MIB
- `traps/translate.js` — trap-OID-tabel

`ifName` (`1.3.6.1.2.1.31.1.1.1.1`) er duplikeret ordret i de to første.

---

## 2. Device-inventory

### Findes der en device-tabel?

Ja: **`snmp_devices`** (migration 104), adskilt fra `agents` — og begrundelsen
står i migrationen: en pollet switch har ikke token, heartbeat, version eller
self-update, så at modellere den som en agent ville betyde at lære hver
fleet-rollup, hvert "agents behind"-badge og hver licens-plads at udelade den.

```sql
snmp_devices (
  id, agent_id NULL,                 -- hvem poller den (ON DELETE SET NULL)
  host VARCHAR(255), port DEFAULT 161,
  version ENUM('1','2c'),
  community_encrypted TEXT,
  display_name, location_id NULL,
  collect JSON,                      -- ['if','fdb','lldp','vlan']
  interval_sec DEFAULT 300, enabled,
  last_polled_at, last_ok_at, last_error,
  supported JSON,                    -- hvad enheden FAKTISK svarede på
  UNIQUE KEY (host, port)
)
```

### Hvordan bliver enheder kendt?

| Vej | Status |
|---|---|
| Manuel oprettelse i Settings | **Implementeret** — eneste vej ind i `snmp_devices` |
| Discovery-sweep → `discovered_devices` | **Implementeret**, men "promote" peger på `agents`, ikke på `snmp_devices` |
| LLDP-naboer → kandidat | **Ikke implementeret**. `snmp_neighbors` (mig. 106) gemmer hvad switchene ser, men ingen kode foreslår dem som nye enheder |
| CMDB-import (Nautobot) | `src/cmdb/` findes og linker **agenter** til CMDB-assets (`agent_cmdb_links`). Ingen sti til `snmp_devices` |

Der er altså **ingen automatisk vej fra "vi kan se den" til "vi poller den"**.

### Nøgling

`UNIQUE KEY uq_snmp_devices_host (host, port)` — **enheden nøgles på IP/hostnavn
og port.** Ikke sysName, ikke chassis-ID.

**Skifter IP'en, er det en ny enhed.** Den gamle række bliver stående med
`last_error`, og alle `fdb_entries` og `snmp_neighbors` hænger på det gamle
`device_id` (FK med `ON DELETE CASCADE`). Ingen kode opdager at de to er samme
fysiske switch. Det er den svageste del af den nuværende model, og den bliver
kun værre med tidsserier hængt på `device_id`.

### Interface-tabel pr. enhed?

**Nej — og her er det mest konkrete fund i hele auditten.**

Agenten **sender allerede** en interface-liste:

```js
// blueeye-agent/src/snmpTopology.js:343
interfaces.push({ ifIndex, ifName, ifAlias });
```

Serveren **validerer den allerede** (`snmpDeviceValidation.js:239-247`,
`MAX_INTERFACES_PER_DEVICE = 4096`) — og `src/devices/snmpTopologyIngest.js`
**smider den på gulvet**. Den bruges kun flygtigt i agentens hukommelse, så en
trap der siger "ifIndex 1" kan vises som "GigabitEthernet0/1".

ifIndex→ifName-tabellen krydser altså tråden ved hvert poll og kasseres.

Det der findes af interface-lagring er `interface_states`:

```sql
interface_states (agent_id, iface VARCHAR(190), status, oper_status, virtual,
                  first_seen, last_seen,
                  UNIQUE KEY (agent_id, iface),
                  FK agent_id → agents ON DELETE CASCADE)
```

Nøglet på **`agent_id` + interface-NAVN**. Ingen `device_id`, ingen `ifIndex`,
og en FK der gør det umuligt at genbruge til en pollet switch.

### Relation device ↔ agent

**Én-til-mange fra agent til enhed**, én-til-én den anden vej:
`snmp_devices.agent_id` er en enkelt nullable kolonne. En enhed har præcis én
pollende agent. Der er **ingen failover**: dør agenten, stopper poll'et, og
`agent_id` sættes til NULL hvis agenten slettes (enheden overlever, som
tilsigtet).

---

## 3. Credentials og kryptering

### Er `secretBox` generisk nok?

Ja, og den bruges allerede til SNMP. `src/lib/secretBox.js`:

- AES-256-GCM, selvbeskrivende format `v1.gcm.<iv>.<tag>.<ciphertext>`
  (base64url), så et nyt skema kan indføres uden datamigrering
- Én 256-bit datanøgle udledt med `scrypt` fra én app-hemmelighed, fast KDF-salt
- Frisk 96-bit IV pr. kryptering; GCM-tag ⇒ manipuleret ciphertext **fejler
  lukket** (kaster) i stedet for at returnere forkert klartekst
- `encrypt('')` → `''`, så "ingen credentials" kræver ingen særtilfælde

Brugt af: integrations (ServiceNow/Nautobot), LDAP bind-password,
`service_test_credentials` og `snmp_devices.community_encrypted`.

### Nøglen og rotation

Nøglematerialet kommer fra én app-hemmelighed (`src/lib/coreEnv.js:31`, med
fallback). **Der findes ingen rotationsmekanisme.** Ingen nøgle-ID i formatet,
ingen re-kryptering-job, ingen "gammel nøgle accepteres stadig"-sti. Versions-
præfikset `v1.gcm.` er forberedt til et *skema*-skifte, ikke til et
*nøgle*-skifte. Skiftes app-hemmeligheden, kaster hver dekryptering, og hver
integration, LDAP-bind og SNMP-community skal indtastes igen.

Det er allerede en eksisterende risiko. En credential-profil-model der samler
flere hemmeligheder ét sted gør konsekvensen større, ikke mindre.

### Hvordan når hemmeligheder ud til agenten?

Én vej: **`GET /agents/me/config`** over HTTPS, med agent-token. Serveren
dekrypterer og sender klartekst. Ikke over WebSocket, ikke i enrollment-pakken.

Agenten gemmer det **kun i hukommelsen**. Det eneste den skriver krypteret-agtigt
til disk er sit token (`tokenStore.js`, filrettigheder — ikke krypteret) og den
pinnede release-nøgle (`release/keyStore.js`, offentlig nøgle).

### Mønsteret "server ejer desired state, agent modtager og rapporterer"

Det findes, og **`snmpTargets` er selv det bedste eksempel** — bedre end sFlow:

```
Server (sandhed)              Agent
snmp_devices  ──GET /agents/me/config──▶  applySnmpTargets()
                                           snmpPoller.setTargets()
                                              │ pr. enheds interval
              ◀──POST /agents/me/snmp-topology─┘  { devices[], errors[] }
                 → recordPoll(ok/fejl, supported)
```

Tre egenskaber værd at kopiere:
1. Desired state hentes ved **hver reconnect** (`loadServerConfig()`), ikke kun
   ved opstart.
2. Agenten rapporterer **hvad der faktisk lykkedes** (`supported`) — ikke hvad
   den blev bedt om. `snmp_devices.supported` er NULL indtil enheden har svaret.
3. Fejl pr. enhed rejser med batchen (`errors[]`) og lander i `last_error`.

sFlow-flowet (`reconcileHsflowd`, `sflow.status`-frame) er samme mønster, men
mere primitivt: én tilstandsstreng pr. agent, ingen pr.-objekt-status.

---

## 4. WebSocket-protokollen

**`blueeye-agent/PROTOCOL.md` er det fulde skema** — 600 linjer, tabeller over
hver frame i begge retninger, med felter, typer og servergrænser. Den er
autoritativ for §2.1/§2.2 og gengives ikke her.

**Den er dog forældet:** `poll-snmp`, `burst`, `stop-burst` og
`POST /agents/me/device-events` / `/snmp-topology` mangler. Det bør rettes
uanset hvad der besluttes.

### Sådan tilføjes en beskedtype

Ingen schema-validering, intet register. To if-kæder:

- **Server → agent**: recognizer-regex i `blueeye-agent/src/command.js` +
  handler i `src/runtime.js` + evt. `fakeServer`-endpoint + tests. Gate-suiten
  `test/gate/validation.test.js` fejer alle verber og **kræver** en case for
  hver ny — den fangede `poll-snmp` og senere `burst` på pushet.
- **Agent → server**: `if (msg.type === '...')` i
  `blueeye-server/src/ws/agentSocket.js` (i dag syv grene). Ukendte frames og
  frames der fejler `JSON.parse` ignoreres stille i begge ender.

### Hvordan sendes store datamængder i dag?

**Over REST, ikke WebSocket.** Det er det etablerede valg:

| Data | Kanal | Grænse |
|---|---|---|
| Trafik + system | `POST /agents/results` | ≤ 1000 resultater/POST, hvert objekt ≤ 65 535 B |
| Probe-resultater | `POST /agents/probe-results` | ≤ 200/POST |
| SNMP-topologi | `POST /agents/me/snmp-topology` | ≤ 200 enheder/batch, ≤ 5000 FDB + ≤ 512 naboer + ≤ 4096 interfaces pr. enhed |
| Enhedshændelser | `POST /agents/me/device-events` | batch hvert 30. s |
| WebSocket ind | `/ws/agent` | **1 MiB pr. frame** |

WebSocket bærer kun kommandoer, kvitteringer, heartbeat, status og de små
live-frames (`burst_sample`). Ingen komprimering nogen steder (`permessage-deflate`
er ikke slået til).

**Svar på spørgsmålet: ja, REST er det rigtige sted for periodiske
metrik-batches**, og systemet gør det allerede konsekvent. En tællerbatch på
20 × 48 porte er ~50-200 KB JSON — det er femdobbelt over hvad der bør gå i én
WS-frame, og REST-stien har allerede batch-grænser, validering og backpressure
gennem HTTP.

### Reconnect og buffering

Ikke ensartet — tre forskellige politikker, hver med sin begrundelse:

| Kilde | Ved fejl |
|---|---|
| sFlow-collector | **Buffer 100 000 flows** i hukommelsen |
| Enhedshændelser (syslog/traps) | **Kastes væk.** Drænede events lægges ikke tilbage i køen — en udgang ville ellers hobe sig op på en vært vi ikke ejer |
| SNMP-topologi | **Kastes væk.** En forwarding-tabel er et øjebliksbillede; gensendt senere ville den påstå at en enhed er et sted den har forladt |
| Trafik-resultater | Ingen kø — næste interval måler forfra |

Reconnect: eksponentiel backoff med jitter, 1 s → 30 s loft. Ved hver genåbning
re-rapporteres capabilities og config hentes igen.

**Backpressure/rate limiting:** ingen mod agenten. Der er per-sender
token-bucket i syslog-modtageren (agent-side) og rate limiting på de
menneskelige API-ruter, men en agent kan POST'e så hurtigt den vil.

---

## 5. Storage

### TimescaleDB-status

**Implementeret og valgfri.** `config.tsdb.enabled` styrer det; er den slået
fra, passerer `server.js` `tsdb = null` og alt bliver i MySQL, som forbliver
sandhedskilde. Dual-store bag ét repository-interface.

Hypertables i `server/db/timescale/001_init.sql` (8 stk.):
`results`, `flow_records`, `probe_results`, `findings`, `probe_outages`,
`speedtest_results`, `audit_events`, `device_events`.

### Reglerne

Fra `docs/storage-split-audit.md`: **STATIC → MySQL, TELEMETRY → TSDB.**
Konkret anvendt:

- Skriver du ~1 række/minut/agent eller mere, og er rækken et *øjeblik* snarere
  end en *tilstand* → TSDB
- Har rækken en hash-kæde (`audit_log`) → MySQL, altid
- Er den inventory/konfiguration → MySQL
- Aggregater (`flow_rollup`, `metric_rollup`) → TSDB, erstattes af continuous
  aggregates

### Retention og compression

```sql
add_retention_policy('results',          INTERVAL '30 days');
add_retention_policy('flow_records',     INTERVAL '30 days');
add_retention_policy('probe_results',    INTERVAL '90 days');
add_retention_policy('speedtest_results',INTERVAL '90 days');
add_retention_policy('device_events',    INTERVAL '30 days');
-- findings / events / audit_events: bevidst INGEN retention
```

MySQL-siden: `src/analysis/retention/config.js` + `purge.js` — rå 7 dage,
rollups 90, findings 365 (kun ack'ede slettes), ARP 30, FDB 30,
device_events 30, interface-transitions 90, burst-runs 90.

**Der er ingen compression-policy på nogen hypertable.** Kun retention.
`ALTER TABLE ... SET (timescaledb.compress)` og `add_compression_policy()`
forekommer ikke i `001_init.sql`. Det er afgørende for volumenberegningen i
punkt E: "efter compression" er i dag ikke en tilstand systemet har.

### Rækkeantal og diskforbrug

**Kan ikke måles herfra.** Der er hverken MySQL (3306) eller PostgreSQL (5432)
tilgængelig i dette miljø, og ingen `mysql`-klient installeret. Tallene i punkt
E er derfor beregnede, ikke observerede, og bør verificeres mod en
produktionsinstans før der besluttes noget på dem.

### Rå counter + beregnet rate?

**Nej — der gemmes kun rates, og delta'et beregnes i agenten.**

`snmpMonitor.sampleSnmp()` læser tællerne **to gange** med `intervalMs`
mellemrum, trækker fra, dividerer med forløbet tid og sender
`rxBytesPerSec`/`txBytesPerSec` plus delta-tællere. De rå counter-værdier
forlader aldrig agenten. Det samme gælder `/proc`-sampleren.

Der findes altså **intet eksisterende mønster for counter-persistering**, og to
konsekvenser følger:

1. Et genstartet *agent*-interval mister sit delta (acceptabelt i dag — den
   måler sig selv).
2. Der er ingen måde at genberegne en rate bagud, og ingen måde at opdage en
   counter-reset efter den er sket.

`nullableDelta()` i samme fil er dog præcis det rigtige instinkt: en tæller
enheden **ikke** rapporterede bliver `null`, ikke `0` — fordi "nul late
collisions" er det der **udelukker** en duplex-mismatch, og fraværende er ikke
nul. Det princip skal med videre.

---

## 6. Scheduling og lifecycle i agenten

- **Infrastruktur**: rå `setInterval`. Intet cron-bibliotek, ingen scheduler.
  Tre timere i `runtime.js`: rapportering (`:510`), syslog-dræn (`:582`),
  planlagte prober (`:729`), plus `snmpPoller`s egen 30 s tick og
  trap-modtagerens dræn.
- **Overlap**: hvert job løser det selv. `snmpPoller.runCycle()` har
  `if (running) return { skipped: true }`; burst-runneren har samme vagt.
  Der er **ingen fælles mekanisme** — et nyt job skal huske sin egen.
- **Fejl i baggrundsjob**: logges lokalt **og** rapporteres til serveren som
  `{type:'agent.error', category, code, message}`, hvor den bliver til en
  tilbagevendende `agent.error` audit-hændelse, dedupliceret pr.
  (agent, kategori, kode). Kategorier i brug: `traffic-report`, `probe`,
  `capabilities`, `config`, `probe-targets`, `scheduled-probes`, `speedtest`.
  Agenten dør aldrig af et baggrundsjob; kun et afvist token er fatalt.
- **Hukommelse**: **ingen grænse og ingen overvågning.** `deploy/blueeye-agent.service`
  sætter `Restart=on-failure` og intet andet — ingen `MemoryMax`, ingen
  `--max-old-space-size`. Agenten rapporterer heller ikke sit eget RSS
  (`process.memoryUsage()` forekommer ikke i `src/`). De eksisterende lofter er
  pr. buffer: 100 000 flows i sFlow-collectoren, 64 interfaces pr. snapshot,
  5000 FDB-rækker pr. enhed.
- **Konfiguration**: `src/config.js`, præcedens **defaults < JSON-fil < env**.
  Serverstyret config hentes med `GET /agents/me/config` og anvendes **live** af
  `loadServerConfig()`: sampleren skiftes ud, rapporteringsintervallet
  genstartes hvis det ændrede sig, `snmpTargets` erstattes. **Ingen genstart
  nødvendig** — men reload sker kun ved (re)connect, ikke på et interval.

---

## 7. Anomali og korrelator

### Kontrakten

`src/analysis/types.js`:

```js
/** @typedef {Object} MetricSample
 *  @property {string} hostId   Stabilt id på værten/agenten
 *  @property {string} metric   Metriknavn, fx 'cpu', 'io.await'
 *  @property {number} value    Numerisk værdi
 *  @property {Date}   ts
 *  @property {Object} labels   Fri key/value, fx { iface: 'eth0' }
 */
```

`createDetector({ baselines, config, intervalMs }).evaluate(sample)` → `Finding`
eller `null`. Kaster aldrig på normale data. Baseline slås op på
`(hostId, metric, bucket)` hvor bucket er ugedag+time. Under `minSamples`
læres der kun, og der returneres `null`.

### Gauge eller delta?

**Detektoren er ligeglad** — den ser kun et `number`. Men baseline-opslaget er
pr. `(hostId, metric)`, så en counter-*værdi* ville være monotont stigende og
producere en meningsløs median. **Delta eller rate er det eneste brugbare**, og
det er også det systemet allerede fodrer den med (`rx.bytesPerSec`).

### Den faktiske flaskehals

`src/analysis/ingest.js extractSamples()` udleder **seks metrikker i alt**:

```js
push('cpu', ...); push('mem', ...); push('load1', ...); push('uptime', ...);
push('rx.bytesPerSec', totals.rxBytesPerSec);
push('tx.bytesPerSec', totals.txBytesPerSec);
```

`labels`-feltet i typedeklarationen bruges **ikke af nogen kalder**.
Per-interface-tal — errors, discards, late collisions — indsamles, gemmes i
`results.payload`, vises på skærmen, og **når aldrig detektoren**. Der er
hverken MAD, z-score eller flatline på en eneste interface-tæller i dag.

### Fra finding til korrelator

`FindingStore` afviser en finding uden `explanation` og `evidence`; `evidence`
skal være mindst ét `MetricSample`. Kolonnen er `JSON NOT NULL`.
`src/analysis/correlator.js` grupperer findings pr. `hostId` inden for et
tidsvindue og skriver `correlated_with`.

### Kan en finding pege på device+interface?

**Nej.** `findings.host_id VARCHAR(255)` og alt nedstrøms —
`idx_findings_host_created`, korrelatoren, `event_cases`, tidslinjen — antager
at det er en agent. Der er **ingen `device_id`, ingen `interface_id`**.

Der er to veje, og valget er reelt:
- Koder man device+interface ind i `host_id` som en streng, virker det med det
  samme og ødelægger enhver join til `agents`.
- Tilføjer man kolonner, rører man den mest centrale tabel i produktet.

Det er den største enkeltstående arkitekturbeslutning i hele forslaget.

---

## 8. RBAC og audit

### Admin-only i dag

Håndhæves med `requireAuth, requireRole(ROLES.ADMIN)` pr. route i 20 filer:
`users`, `locations`, `settings`, `system`, `audit`, `auditLog`, `auditEvents`,
`apiTokens`, `integrations`, `cmdb`, `discovery`, `diagnostics`, `enrollmentCodes`,
`ldap`, `oidc`, `saml`, `severityRules`, `thresholds`, `transactions`,
`reportSchedules`.

**SNMP-enheder følger allerede et finere mønster** (`src/routes/snmpDevices.js`):
viewer+ læser, **admin** skriver, operator+ må udløse et poll. Samme opdeling
som burst-mode fik: at *læse* en måling er viewer, at *starte* noget der sender
pakker er operator, at *ændre en credential* er admin.

### Hash-chained audit — skrive-API

`src/repositories/auditLogRepository.js`:

```js
await auditLogRepo.record({
  category,            // ≤ 32
  action,              // ≤ 64
  outcome,             // 'success' | 'failure' | 'denied'
  actorUserId, actorEmail, actorRole,
  target,              // ≤ 255
  detail,              // ≤ 512
  ip,
});
```

Hver række kædes: `entry_hash = sha256(prev_hash || canonical(fields))`.
Tabellen **bliver i MySQL** netop derfor (klassifikationen i
`storage-split-audit.md` siger det eksplicit). Der findes en verifikations-
funktion der genberegner kæden og returnerer `{ ok, checked, brokenAt }`.

Ved siden af ligger `audit_events` (ingen kæde, deduplikeret, TSDB-egnet) til
højfrekvente maskin-hændelser som `agent.error`.

### Passer SNMP-credentials ind?

Ja, uden ændringer. Mønsteret for en hemmelighed der ændres er allerede brugt
af integrations og LDAP: én `record()`-linje med `target` = enhedens
host:port og `detail` uden selve hemmeligheden (`redactBody`/`isSecretKey` i
`src/audit/actions.js` sørger for at en secret-agtig nøgle aldrig havner i
audit-kroppen). En credential-profil ville være samme kategori, ét niveau op.

---

## 9. Frontend

- **Device-detaljeside: nej.** Der er en agent-detaljeside (`public/views/agent.js`),
  en lokations-side, en event-side og en situation-side. SNMP-enheder har kun
  et **admin-panel under Settings** (`settingsSnmpDevicesView()` i `public/app.js`,
  ~linje 12120) med tilføj/slet/poll og en status-kolonne. Ingen drill-down,
  ingen historik, ingen grafer.
- **Hvor hører en interface-liste hjemme?** Der findes allerede en
  Interfaces-skærm (`public/views/interfaces.js` + `GET /api/interfaces`), men
  den er **pr. agent** og læser kun **den nyeste række** fra `results`
  (`src/routes/interfaces.js`: `resultsRepo.findByAgentId(agentId, { limit: 1 })`).
  Ingen historik, ingen tidsakse. En device-interface-liste hører naturligt på en
  ny device-detaljeside, med den eksisterende Interfaces-skærm som skabelon for
  tabellen.
- **Graf-komponent: ja.** `ui.chart(opts)` i `public/ui.js` (~linje 635),
  håndtegnet SVG, ingen chart-bibliotek (repo-konvention). Kontrakten:

  ```js
  ui.chart({
    series: [{ name, points: [{ y, label? }, ...] }, ...],
    labels?, form?: 'line' | 'bars',   // auto: bars ved ≤ BAR_THRESHOLD punkter
    height?, title?, emptyTitle?
  })
  ```

  Legenden tegnes altid under grafen; tom serie giver `emptyState`. Til 1440
  punkter pr. døgn skal der downsamples før den kaldes — komponenten gør det ikke.
- **Admin-sektion til credential-profiler:** Settings har allerede den rigtige
  form — en to-niveau SubTab-struktur efter Phase 3.25, med SNMP-enheder som
  egen sektion. En profil-side ville være endnu en sektion samme sted.

---

## 10. Test

- **Runner**: `node --test` (indbygget), begge repos. Ingen Jest, ingen Mocha.
  Serveren auto-opdager `test/**` og `src/**/__tests__`.
- **Mocking**: **dependency injection, ikke modul-mocking.** `createX(deps)`
  overalt; `blueeye-server/test-support/fakes.js` og
  `blueeye-agent/test-support/fakeServer.js` leverer fakes. HTTP testes med
  `supertest` mod en app bygget af fakes. Udgående kald (LLM, SMTP, geocoder)
  mockes ved injektion.
- **sFlow-dekoderen — bekræftet.** `blueeye-agent/test/sflow.test.js` indeholder
  en **programmatisk encoder i selve testfilen**: `rawPacket()` bygger en
  Ethernet II + IPv4 + TCP/UDP-header byte for byte, og `sflowDatagram()` samler
  en gyldig sFlow v5-datagram med flow-sample og raw-packet-header-record. Der
  er ingen binære fixture-filer. Mønsteret er værd at kopiere: **testen kender
  wire-formatet, så en ændring i dekoderen kan ikke stiltiende ændre hvad der
  anses for gyldigt.**
- **Eksterne netværkstjenester**: tre mønstre i brug — injiceret reader
  (`readCounters`/`readTables` i SNMP-modulerne), injiceret socket-fabrik
  (syslog- og trap-modtagerne, så ingen test binder en port), og en fuld fake
  HTTP/WS-server (`fakeServer.js`). **Ingen test kræver `net-snmp`, en switch
  eller en åben port.**

---

# A. Anbefaling

**Refaktorér det eksisterende SNMP-lag til ét delt modul, og udvid
`snmpPoller` — byg ikke noget nyt ved siden af.**

Begrundelsen er at der allerede er **to** SNMP-stier, og de deler alt undtagen
kode:

| | `snmpMonitor.js` | `snmpTopology.js` + `snmpPoller.js` |
|---|---|---|
| Binding | **1:1** — hele agenten poller én enhed *i stedet for* `/proc` | **1:mange** — enheder polles *ved siden af* agentens egen måling |
| Læser | IF-MIB tællere, errors, discards, oper-status, speed, late collisions | ifName/ifAlias, BRIDGE, Q-BRIDGE, LLDP |
| Cadence | To walks `intervalMs` fra hinanden, pr. rapport | Ét walk pr. enheds interval, gulv 60 s |
| Resultat | `results.payload.traffic` som var det agentens eget netkort | `fdb_entries`, `snmp_neighbors` |
| Duplikeret | `ifName`-OID, `walkColumn()`, session-opsætning, `toNumber()` | samme |

Det foreslåede projekt er **præcis skæringen**: tællerne fra den første sti,
leveret gennem den andens 1:mange-model. Der skal ikke skrives en poller — der
skal flyttes en aflæsning fra den ene sti til den anden.

Konkret:

1. Træk `walkColumn`, session-opsætning, `toNumber` og OID-konstanterne ud i
   `src/snmp/session.js` + `src/snmp/oids.js`. Begge eksisterende moduler
   bruger dem, med de samme injicerbare readers som i dag.
2. Tilføj `'ifcounters'` som en **collect-kind** i den eksisterende
   `collect JSON`-kolonne, ved siden af `if`/`fdb`/`lldp`/`vlan`. Ingen ny
   kommando, ingen ny route, ingen ny skemalægger, ingen ny credential-sti.
3. `snmpMonitor.js` bliver stående uændret. Agenter i marken med
   `monitorConfig.source = 'snmp'` skal blive ved med at gøre præcis hvad de gør.

At bygge nyt ved siden af ville give en **tredje** SNMP-sti med et tredje sæt
OID-konstanter, og `ifName` ville være defineret tre steder.

---

# B. Ny dependency

**Nej. `net-snmp` er det rigtige bibliotek — problemet er at det ikke er installeret.**

| | |
|---|---|
| Pakke | `net-snmp` |
| Licens | MIT |
| Native compilation | **Nej.** Ren JavaScript, bruger Nodes indbyggede `dgram` + `crypto`. Det er hele grunden til at det passer til en agent der installeres med `npm ci --omit=dev` på kundens maskiner |
| v3 authPriv | Understøttet af biblioteket, ubrugt hos os |
| GETBULK | Understøttet (`maxRepetitions` på `subtree`), ubrugt hos os |
| Seneste udgivelse | **Kan ikke verificeres herfra** — pakken er ikke installeret, og npm-registret er ikke tilgængeligt i dette miljø. Bør slås op før godkendelse |

**Det jeg foreslår du godkender er ikke et nyt bibliotek, men en beslutning om
hvordan det nuværende leveres.** Tre muligheder:

1. **Flyt `net-snmp` til `dependencies` i `blueeye-agent/package.json`.**
   Agenten går fra 1 til 2 runtime-afhængigheder. Alle agenter får SNMP-evnen,
   også dem der ikke bruger den. Enklest, og gør at stage 02/03 rent faktisk
   virker efter en `git pull && ./install.sh`.
2. **`optionalDependencies`.** Installeres automatisk, men et fejlet install
   stopper ikke agenten. Bevarer den nuværende "kan mangle"-kode uændret.
3. **Status quo + dokumentation.** `install.sh` får et flag
   (`--with-snmp`), og `capabilities.unavailable.snmp` vises tydeligere i
   dashboardet.

Min anbefaling er **(2)**: koden er allerede skrevet til at overleve et
fravær, `capabilities.js` rapporterer det allerede, og et fejlet valgfrit
install på en mærkelig kundevært må ikke forhindre agenten i at starte.

---

# C. Credential-model

**Forslaget kolliderer på ét punkt, og det punkt er vigtigt.**

Den foreslåede model: profil pr. site (default) → valgfri profil pr. subnet →
override pr. enhed, hvor agenten **prøver i rækkefølge**, husker hvad der
virkede og rapporterer `auth_failed` pr. enhed.

### Det der passer

- **Profil-hierarkiet passer fint i skemaet.** `snmp_devices` har allerede
  `location_id` (FK til `locations`), så site-niveauet findes. En
  `snmp_credential_profiles`-tabel + en nullable `profile_id` på `snmp_devices`
  er en additiv migration uden datakonvertering: NULL = "brug min egen
  `community_encrypted`", som i dag.
- **`auth_failed` pr. enhed har allerede et hjem.** `snmp_devices.last_error`
  VARCHAR(255) + `last_polled_at`/`last_ok_at` er nøjagtig den kolonne, og
  `recordPoll()` skriver den allerede fra ingest-stien.
- **"Husk hvad der virkede"** har også et hjem: `supported JSON` er allerede
  præcis dét mønster — hvad enheden *faktisk* svarede på, NULL indtil den har
  svaret.
- **UI'et passer.** Settings har en SNMP-sektion; en profil-side er endnu en
  sektion samme sted, admin-only som resten.

### Det der kolliderer

**"Agenten prøver i rækkefølge" er credential spraying, og systemet har allerede
taget stilling imod det.**

1. **Mod SNMPv3 er det direkte skadeligt.** v3 er autentificeret, og mislykkede
   authPriv-forsøg tæller — mange platforme logger dem som sikkerhedshændelser
   og nogle låser kontoen. At prøve tre profiler mod hver ukendt enhed er en
   fremgangsmåde der ligner et angreb, fordi den er teknisk identisk med et.
2. **Mod v2c producerer det tavse fejl.** En forkert community giver ofte
   ingen fejl — bare timeout. Tre profiler × 30 s timeout = 90 sekunder pr.
   enhed pr. cyklus, sekventielt, med et interval-gulv på 60 s. Pollingen
   kollapser før den finder noget.
3. **Det bryder med den eksisterende sikkerhedsholdning.** SSRF-listen tjekkes
   **to gange** for hver enhed (ved skrivning og igen før et poll udleveres),
   ejerskab håndhæves pr. agent ved ingest, og community'en udelades fra
   `SAFE_COLUMNS` så en route ikke kan lække den ved et uheld. Et lag der
   systematisk prøver hemmeligheder mod adresser er ude af trit med det.

### Anbefalet variant

Behold **profil-hierarkiet** og **drop rækkefølge-forsøget** i den løbende drift:

- Profil løses **på serveren** ved opslag (enhed-override → subnet-profil →
  site-profil), og agenten får **én** credential pr. enhed i `snmpTargets`,
  præcis som i dag. Agenten skal ikke kende til profiler overhovedet — det
  holder hemmeligheds-fladen på agenten lige så lille som nu.
- Rækkefølge-forsøget hører til **ét sted**: en eksplicit, operatør-startet
  "prøv denne enhed"-handling i UI'et, med et loft (3 profiler), en tydelig
  audit-record pr. forsøg, og aldrig automatisk mod en adresse der ikke allerede
  er i `snmp_devices`. Det er samme mønster som `POST /:id/poll` allerede er:
  operator+, 202, agenten gør arbejdet.

Subnet-niveauet er værd at spørge til: hvad er det der ikke kan udtrykkes med
site + override? `locations` findes, per-device-override findes. Et
mellemniveau der kræver CIDR-matching på serveren skal tjene et konkret behov,
ellers er det en tredje ting at holde konsistent.

---

# D. Schema-forslag

Fire tabeller. Tre i MySQL, én i Timescale.

### `device_interfaces` — MySQL

**Inventory, ikke telemetri.** Én række pr. port pr. enhed; ændrer sig kun når
nogen sætter et modul i eller omdøber en port. 20 enheder × 48 porte = 960
rækker. At lægge den i TSDB ville betyde en join over to databaser på hver
eneste aflæsning.

```sql
CREATE TABLE device_interfaces (
  id            BIGINT UNSIGNED AUTO_INCREMENT,
  device_id     INT UNSIGNED NOT NULL,
  if_name       VARCHAR(190) NOT NULL,      -- den STABILE identitet, se punkt F
  if_index      INT UNSIGNED NULL,          -- den FLYGTIGE, se punkt F
  if_alias      VARCHAR(255) NULL,          -- portbeskrivelsen fra konfigurationen
  if_descr      VARCHAR(255) NULL,
  speed_mbps    INT UNSIGNED NULL,
  admin_status  VARCHAR(16) NULL,
  oper_status   VARCHAR(16) NULL,
  phys_address  CHAR(17) NULL,
  if_index_changed_at DATETIME NULL,        -- hvornår ifIndex sidst flyttede sig
  first_seen    DATETIME NOT NULL,
  last_seen     DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_ifname (device_id, if_name),
  KEY idx_device_ifindex (device_id, if_index),
  CONSTRAINT fk_devif_device FOREIGN KEY (device_id)
    REFERENCES snmp_devices (id) ON DELETE CASCADE
);
```

**Denne tabel kan bygges i dag uden at røre agenten.** Data'en krydser allerede
tråden og kasseres i `snmpTopologyIngest.js`.

Bemærk at den **ikke** hedder `interfaces` og ikke udvider `interface_states`.
Den eksisterende tabel nøgler på `agent_id` med `ON DELETE CASCADE` til
`agents`, og en switch er ikke en agent — samme begrundelse som `snmp_neighbors`
fik sin egen tabel frem for at dele `lldp_neighbors`. To id-rum i én kolonne
kaster ikke; det tegner det forkerte netværk.

### `snmp_credential_profiles` — MySQL

```sql
CREATE TABLE snmp_credential_profiles (
  id            INT UNSIGNED AUTO_INCREMENT,
  name          VARCHAR(190) NOT NULL,
  location_id   INT UNSIGNED NULL,          -- NULL = global default
  version       ENUM('1','2c','3') NOT NULL DEFAULT '2c',
  community_encrypted TEXT NULL,            -- v1/v2c
  v3_user       VARCHAR(190) NULL,          -- v3, alle secretBox-krypteret
  v3_auth_proto ENUM('md5','sha','sha224','sha256','sha384','sha512') NULL,
  v3_auth_key_encrypted  TEXT NULL,
  v3_priv_proto ENUM('des','aes','aes256b','aes256r') NULL,
  v3_priv_key_encrypted  TEXT NULL,
  created_at, updated_at,
  PRIMARY KEY (id),
  UNIQUE KEY uq_profile_name (name),
  CONSTRAINT fk_profile_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
);
```

Plus på `snmp_devices`: `profile_id INT UNSIGNED NULL` (FK, `ON DELETE SET NULL`)
og `version` udvidet til `ENUM('1','2c','3')`. Eksisterende rækker beholder
deres `community_encrypted` og NULL profil — ingen datakonvertering.

### `device_counter_samples` — **Timescale** (hypertable)

Den eneste tabel her der er telemetri, og den er det med afstand. Klassifikation
efter reglerne i `docs/storage-split-audit.md`: HIGH skrivevolumen, rækken er et
øjeblik og ikke en tilstand, ingen hash-kæde, ingen FK-behov.

**Bred række, ikke smal** (én række pr. port pr. poll, metrikker som kolonner):

```sql
CREATE TABLE device_counter_samples (
  ts              TIMESTAMPTZ  NOT NULL,
  device_id       INTEGER      NOT NULL,
  interface_id    BIGINT       NOT NULL,   -- device_interfaces.id, IKKE ifIndex
  -- RÅ tællere, som enheden sagde dem
  in_octets       BIGINT, out_octets      BIGINT,
  in_ucast_pkts   BIGINT, out_ucast_pkts  BIGINT,
  in_errors       BIGINT, out_errors      BIGINT,
  in_discards     BIGINT, out_discards    BIGINT,
  fcs_errors      BIGINT, late_collisions BIGINT,   -- EtherLike, NULL hvis uimplementeret
  -- BEREGNEDE rater for det forløbne interval
  in_bps  DOUBLE PRECISION, out_bps  DOUBLE PRECISION,
  in_err_pps DOUBLE PRECISION, out_err_pps DOUBLE PRECISION,
  in_disc_pps DOUBLE PRECISION, out_disc_pps DOUBLE PRECISION,
  util_pct DOUBLE PRECISION,
  -- Hvorfor raten kan være NULL. Se punkt G.
  delta_sec       INTEGER,
  discontinuity   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (ts, interface_id)
);
SELECT create_hypertable('device_counter_samples', 'ts', chunk_time_interval => INTERVAL '1 day');
```

**Både rå og beregnet**, hvilket bryder med det nuværende mønster (kun rater) —
bevidst. Uden den rå tæller kan en rate aldrig genberegnes, en counter-reset kan
aldrig opdages bagud, og en manglende cyklus kan ikke skelnes fra en cyklus med
nul trafik. `discontinuity` er den kolonne der gør `NULL`-raten forståelig i
stedet for mistænkelig.

**Hvis TSDB ikke er slået til** hos en kunde: samme regel som `device_events`
fra etape 01 — dual-store bag ét repository-interface, MySQL-varianten med
samme kolonner og en `(interface_id, ts)`-nøgle. Se punkt E for hvorfor det er
ubehageligt.

### `device_interface_events` — genbrug, ingen ny tabel

Link up/down, admin-down, duplex-skift: **det findes allerede.**
`device_events` (migration 103) har `link.down`, `link.up`, `link.admin_down`,
`ifname`-kolonne, severity-bånd, tidslinje-integration og changes-feed. En
poller der ser `ifOperStatus` skifte skal skrive **dér**, ikke i en ny tabel.

---

# E. Volumen

**20 enheder × 48 porte = 960 interfaces, polled hvert 60. sekund.**

### Rækker

| Model | Rækker/cyklus | Rækker/døgn | Rækker/år |
|---|---|---|---|
| Smal (én række pr. metrik) | 9 600 | **13,8 mio.** | ~5,0 mia. |
| **Bred (én række pr. port)** | 960 | **1,38 mio.** | ~505 mio. |

Den brede model er faktor 10 billigere i rækker og er derfor den i punkt D.
Den koster fleksibilitet: en ny metrik er en `ALTER TABLE` frem for en ny
`metric_id`. Med IF-MIB er det acceptabelt — kolonnesættet er defineret af en
RFC fra 2000 og ændrer sig ikke.

### Disk (beregnet, ikke målt)

Bred række: 10 × `BIGINT` + 7 × `DOUBLE` + `INTEGER` + `BOOLEAN` + `TIMESTAMPTZ`
+ 2 × id ≈ **150 B nyttelast**, plus PostgreSQL tuple-overhead (~24 B) og
alignment ≈ **~180 B/række**.

| | Ukomprimeret | Med TimescaleDB columnar compression |
|---|---|---|
| Pr. døgn | 1,38 mio. × 180 B ≈ **250 MB** | **12-25 MB** (10-20× er typisk på monotone tællere) |
| Pr. 30 dage | ~7,4 GB | ~0,4-0,8 GB |
| Pr. år | ~90 GB | **~4,5-9 GB** |

Tællerkolonner komprimerer usædvanligt godt: `delta`-kodning på monotont
stigende `BIGINT` og RLE på de mange nuller (errors/discards er nul det meste
af tiden på et sundt net). 15× er et forsigtigt gæt, ikke et optimistisk.

**Men: der er ingen compression-policy på nogen hypertable i dag.**
`server/db/timescale/001_init.sql` sætter kun retention. Tallene i højre
kolonne kræver at der tilføjes:

```sql
ALTER TABLE device_counter_samples SET (timescaledb.compress,
  timescaledb.compress_segmentby = 'interface_id',
  timescaledb.compress_orderby = 'ts DESC');
SELECT add_compression_policy('device_counter_samples', INTERVAL '7 days');
```

Det er i sig selv en beslutning der bør tages for de eksisterende hypertables
samtidig — `results` og `flow_records` ligger ukomprimeret i 30 dage i dag.

### Samme tal i MySQL

InnoDB-række ≈ 150 B data + ~50 B per-row overhead + sekundært indeks på
`(interface_id, ts)` ≈ **~250 B effektivt**. Ingen komprimering på den måde
(`ROW_FORMAT=COMPRESSED` giver ~2×, ikke 15×).

- Pr. døgn: **~345 MB**
- Pr. 30 dage: **~10 GB**, og det er kun *én* ny tabel oven i alt det øvrige
- Pr. år uden retention: **~126 GB**

### Ændrer det anbefalingen?

**Nej — det bekræfter den, og det skærper én ting.**

`device_counter_samples` hører i Timescale. 1,38 mio. rækker/døgn er den
næststørste skrivestrøm i produktet efter `flow_records`, og det er præcis den
slags tabel klassifikationen i `docs/storage-split-audit.md` findes for.

Det skarpe punkt: **TSDB er valgfri i dag.** En kunde uden TimescaleDB får
10 GB om måneden i MySQL for 20 switche. Der er to ærlige udveje, og de bør
besluttes før der skrives kode:

1. **Kræv TSDB for denne funktion.** Tælleropsamling kan slås til pr. enhed
   (`collect`-kinden findes allerede); UI'et siger "kræver TimescaleDB" når
   `config.tsdb.enabled` er false. Ærligt, og på linje med at funktionen er
   opt-in i forvejen.
2. **Kortere MySQL-retention for netop denne tabel** — fx 7 dage i MySQL mod 90
   i TSDB, gennem den eksisterende `retention/config.js` + `purge.js`-mekanisme.
   ~2,4 GB i stedet for 30.

Jeg anbefaler **(1)**, med **(2)** som fallback. Det er de samme to muligheder
etape 01 stod i for `device_events`, hvor dual-store blev valgt fordi rækkerne
var små. 180 B × 1,38 mio./døgn er en anden størrelsesorden.

---

# F. ifIndex-ustabilitet

**Problemet**: ifIndex er kun garanteret stabil mellem re-initialiseringer af
netværkssystemet. En reboot kan omnummerere; et nyt modul i en chassis-switch
omnummererer næsten altid alt efter sig. Gemmer man tidsserier på ifIndex, får
man den 18. september's tal for Gi1/0/12 blandet med den 19.'s tal for
Gi1/0/12, som nu er en anden fysisk port.

**Løsningen i det foreslåede skema:**

1. **`UNIQUE KEY (device_id, if_name)`.** Identiteten er navnet, ikke tallet.
   `GigabitEthernet1/0/12` beskriver en fysisk placering i chassiset og
   overlever både reboot og modulindsættelse.
2. **`device_counter_samples.interface_id` peger på `device_interfaces.id`** —
   en surrogatnøgle. **ifIndex forekommer aldrig i en tidsseriefremmednøgle.**
   Omnummerering ændrer én kolonne i én inventory-række og rører ikke en eneste
   historisk måling.
3. **Hvert poll sammenligner ifIndex→ifName-kortet med det gemte.** Er `if_index`
   for et kendt `if_name` ændret, opdateres kolonnen og `if_index_changed_at`
   sættes. Det er billigt: agenten walker `ifName` i forvejen i hvert topologi-poll.
4. **Den cyklus hvor en ifIndex flytter sig, sættes `discontinuity = TRUE`** og
   raterne til NULL. Tælleren for den *nye* ifIndex er en anden tællers værdi;
   at trække forrige cyklus fra den ville give et tal, og tallet ville være
   opdigtet.
5. **Et ukendt `if_name`** er en ny række med `first_seen` = nu. Et navn der
   forsvinder beholdes med et gammelt `last_seen` — et modul der trækkes ud og
   sættes i igen skal genkende sin egen historik.

**Hjørnet der ikke er løst af ovenstående**: switche der ikke implementerer
`ifName` (nogle ældre, og de fleste der kun har `ifDescr`). Der falder man
tilbage på `ifDescr`, som er mindre stabil. `device_interfaces.if_descr` er
derfor med i skemaet, og fallback-rækkefølgen bør være eksplicit i koden:
`ifName` → `ifDescr` → `ifIndex` som sidste udvej, med en markering på rækken af
hvilken der blev brugt. Samme princip som `fdb_entries` bruger i dag: gem hvad
enheden sagde **og** hvad det blev oversat til, og lad være med at digte når
oversættelsen mangler.

---

# G. Counter-reset

**Detektion: `sysUpTime` (`1.3.6.1.2.1.1.3.0`), læst i hvert poll.**

Én ekstra GET pr. enhed pr. cyklus — 20 GETs i minuttet, forsvindende ved siden
af walk'ene. Gem den sidst sete værdi pr. enhed (i agentens hukommelse *og* på
rækken, så en agent-genstart ikke mister den).

Tre tilfælde ved hvert poll:

| Observation | Fortolkning | Hvad der sker med delta'et |
|---|---|---|
| `sysUpTime` steget med ~det forløbne interval | Normalt | Delta beregnes, rate gemmes |
| `sysUpTime` **faldet** | Enheden er rebootet | **Rate = NULL, `discontinuity = TRUE`**, rå tæller gemmes |
| `sysUpTime` steget **mindre** end den forløbne realtid | Reboot inden for intervallet (oppe igen før vi kiggede) | Samme som ovenfor |

Det tredje tilfælde er det man glemmer. En switch der rebooter kl. 03:00:10 og
er oppe igen kl. 03:00:40 har en *stigende* sysUpTime ved 03:01-pollet — bare
en der er steget med 20 sekunder i stedet for 60. Sammenligningen skal være mod
**forløbet realtid**, ikke mod nul.

**Hvad der sker i den cyklus:** den rå tæller gemmes som aflæst, alle rater
sættes NULL, `discontinuity = TRUE`. Ikke 0, ikke det clampede
`Math.max(a - b, 0)` som `snmpMonitor.js` bruger i dag. Et clamp til nul
producerer et tal der ser ud som en måling og siger "ingen trafik i det minut",
hvilket er falsk — og værre, det ville trække en flatline-detektor mod at tro
at porten var død. **NULL og et flag er forskellen mellem "vi målte ingenting"
og "vi ved det ikke."** Samme regel som `nullableDelta()` allerede følger for
en tæller enheden ikke rapporterede.

**32-bit wrap er et separat problem.** Brug 64-bit HC-tællere
(`ifHCInOctets` etc.) hvor de findes — `snmpMonitor.js` gør det allerede. For
enheder der kun har de 32-bit `ifInOctets`: et fald **uden** reboot er
sandsynligvis wrap, men kun hvis den implicerede rate er plausibel mod
`ifHighSpeed`. Er den ikke det, er det ikke wrap, og svaret er NULL. En 1 Gbit/s
port wrapper en 32-bit octet-tæller på ~34 sekunder ved fuld last, så ved
60-sekunders polling **kan wrap i praksis ikke detekteres pålideligt** på en
travl gigabit-port. Den ærlige konsekvens: rapportér `ifHCInOctets`-fravær som
en begrænsning på enheden (`supported`-kolonnen gør det allerede for andre
tabeller), frem for at gemme gæt.

---

# H. Risiko — hvad der kommer til at gøre ondt

Konkret, med filer.

### 1. `net-snmp` findes ikke i marken
`blueeye-agent/package.json` (1 dependency), `install.sh`, `Dockerfile`,
`Dockerfile.slim`. **Etape 02 og 03 er allerede udrullet som kode der ikke kan
køre.** Bygger man videre uden at løse det, bygger man en tredje funktion oven
på et fundament der kaster `SNMP_UNAVAILABLE`. Dette er den første opgave, ikke
en detalje i den sidste.

### 2. Go-porten
`blueeye-agent/blueeye-agent-go/` — en igangværende Go-port med det erklærede
mål at være *"a drop-in against a stock blueeye-server"*. Den har `sflow`,
`collector`, `upgrade`, `wsclient` — **og intet SNMP**. Hver ny Node-side
agentfunktion udvider gabet. Enten skal SNMP med i porten, eller det skal
besluttes eksplicit at SNMP forbliver Node-only. Det bør afklares **før** der
lægges en tredje SNMP-funktion i Node.

### 3. `findings.host_id` er en agent
`schema.sql` (`findings`), `src/analysis/detector.js`,
`src/analysis/correlator.js`, `src/analysis/findings.js`, `src/timeline/targetTimeline.js`,
`src/eventCases/*`. Der er ingen vej fra en finding til et device+interface.
Det er den ændring der rører flest filer i hele forslaget, og den er umulig at
lave halvt: enten bærer findings et device, eller også gør de ikke.

### 4. `extractSamples` er en flaskehals på seks metrikker
`src/analysis/ingest.js` (34 linjer). Alt hvad detektoren nogensinde ser,
kommer herfra. `labels`-feltet i `MetricSample` er defineret og ubrugt. Nye
metrikker uden en udvidelse her bliver gemt og aldrig analyseret — hvilket er
præcis hvad der sker med interface-errors i dag.

### 5. `results.payload` kan ikke bære 960 interfaces
`POST /agents/results`: ≤ 65 535 B pr. resultatobjekt.
`blueeye-agent/src/trafficMonitor.js MAX_INTERFACES = 64` pr. snapshot. Prøver
man at presse enhedstællere gennem den eksisterende trafiksti, rammer man begge
lofter på den første 48-ports switch. **Tællerne skal gå gennem
`/agents/me/snmp-topology`-stien** (som har 4096 interfaces pr. enhed og 200
enheder pr. batch), ikke gennem `results`.

### 6. `interface_states` og `computeInterfaceHealth` er agent-bundne
`schema.sql` (`interface_states`, FK til `agents` med CASCADE),
`src/routes/interfaces.js`, `src/health/interfaceHealth.js`,
`public/views/interfaces.js`. Fristelsen til at "bare tilføje `device_id`" er
stor og forkert — `ON DELETE CASCADE` til `agents` betyder at sletning af en
agent ville tage en switchs interfacehistorik med sig.
`src/routes/interfaces.js` læser desuden kun den seneste `results`-række; der
er ingen historik-sti at udvide.

### 7. SSRF-politikken skal holdes
`src/serviceTests/security/hostPolicy.js` (`denyReason`/`explainReason`), `src/routes/snmpDevices.js`. Værten tjekkes to gange
og **snævert** — loopback, link-local og metadata nægtes, RFC1918 tillades,
fordi en switch på 10.14.0.11 er hele pointen. Enhver ny sti der tager en
adresse (credential-profiler med subnet-matching, LLDP-baseret auto-opdagelse)
skal gennem samme tjek, og gate-suiten `test/gate/security.test.js` fejer efter
det.

### 8. Gate-fladerne
`scripts/gate.sh` + `test/gate/{security,ui,validation}.test.js` +
`scripts/ui-check.js`. En ny route kræver en allowlist-post, en ny validator
kræver en gate-regel, en ny skærm kræver `PAGE_INFO` + `data-view` +
`nav.*`-nøgler i **begge** i18n-kataloger, og en migrering kræver
`npm run build-schema` + en MODEL-opdatering i `scripts/build-schema.js`.
Gate'en er en hjælp, ikke en forhindring — men den skal udvides bevidst hver gang.

### 9. Dokumentation der allerede er bagud
`blueeye-agent/PROTOCOL.md` mangler `poll-snmp`, `burst`, `stop-burst`,
`/agents/me/device-events` og `/agents/me/snmp-topology`.
`docs/storage-split-audit.md` mangler alle tabeller fra migration 103-107.
Tilføjes der telemetri uden at klassifikationstabellen opdateres, mister den
sin værdi som beslutningsgrundlag.

### 10. Sekventiel polling har et loft
`blueeye-agent/src/snmpPoller.js` — sekventielt, 30 s timeout pr. enhed. Med 20
enheder og tællerwalks oveni er en cyklus i værste fald 20 × 30 s = 10 minutter,
mod et ønsket interval på 60 s. **60-sekunders polling af 20 enheder kan ikke
lade sig gøre sekventielt.** Enten skal der køres et begrænset antal parallelt
(med et eksplicit loft, ikke `Promise.all` over alt), eller også skal
tællerstien have sin egen cyklus adskilt fra topologistien, som med rimelighed
kan blive ved med at køre hver 5. minut.

Det er den enkeltstående tekniske forhindring der er mest undervurderet i
forslaget.

---

# I. Faseopdeling

Fem trin. Hvert trin er en diff der kan reviewes i én session, og hvert trin
efterlader systemet i en tilstand der virker.

### Trin 1 — Få det eksisterende til at køre, og gem det der allerede sendes

- `net-snmp` i `optionalDependencies` i `blueeye-agent/package.json`, og en
  linje i `install.sh` der ikke fejler hvis den ikke kan installeres
- Migration: `device_interfaces` (MySQL)
- `snmpTopologyIngest.js` gemmer den `interfaces`-array der allerede valideres
  og allerede kasseres
- `PROTOCOL.md` bringes ajour med etape 01-04

**Ingen agent-kodeændringer overhovedet.** Data'en krydser allerede tråden.

**Ikke med i trin 1:** tællere, nye OID'er, ny collect-kind, nyt
credential-skema, v3, device-detaljeside, grafer, detektor-integration,
Timescale-tabel. Trin 1 gør at man for første gang kan svare på "hvilke porte
har denne switch, og hvad hedder de" — og det er forudsætningen for alt andet.

### Trin 2 — Det delte SNMP-modul

- `src/snmp/session.js` + `src/snmp/oids.js` i agenten; `snmpMonitor.js` og
  `snmpTopology.js` bruger dem
- Ren refaktorering: **ingen adfærdsændring**, samme tests skal passere uændret
- `sysUpTime` tilføjes til topologi-pollet og gemmes på `snmp_devices`

Diff'en er stor i linjer og nul i adfærd, hvilket gør den let at reviewe:
enhver adfærdsændring er en fejl.

### Trin 3 — Tællere, indsamlet og gemt

- `'ifcounters'` som collect-kind; `snmpPoller` får en **separat cyklus** for
  tællere (se risiko 10) med sit eget interval og et parallelitetsloft
- Migration: `device_counter_samples` som hypertable + compression-policy, med
  MySQL-fallback bag repository-interfacet
- Counter-reset-håndtering (punkt G) og ifIndex-drift-håndtering (punkt F)
- Ingen UI, ingen detektor. Data står i en tabel, og man kan SELECT'e den

Dette er det største trin. Det kan deles i to (indsamling, så lagring) hvis
diff'en bliver for stor.

### Trin 4 — Analyse

- `extractSamples`-stien udvides, eller en `extractDeviceSamples` ved siden af,
  så error/discard/util-rater når detektoren
- Beslutningen om `findings` og device+interface (risiko 3) tages **her**,
  eksplicit, som sin egen diskussion
- Findings for en switchport lander på tidslinjen og i changes-feed'et sammen
  med de `link.down`-events fra etape 01 der beskriver samme port

### Trin 5 — UI og credential-profiler

- Device-detaljeside med interface-tabel og `ui.chart()` over tællerne
  (downsamplet før kaldet)
- `snmp_credential_profiles` + profil-opslag på serveren + v3-felter
- Settings-sektion til profiler, admin-only, med audit-record pr. ændring

Credential-profiler ligger **sidst** med vilje: den nuværende per-enhed-model
virker, og en profil-model er en forbedring af drift-ergonomien — ikke en
forudsætning for nogen af de foregående trin. Ligger den først, bliver den en
blokering for noget der kunne have målt allerede.

---

## Det åbne spørgsmål jeg ikke kan afgøre for dig

Trin 4 indeholder en beslutning der ikke kan gøres halvt: **skal en finding
kunne pege på et device og et interface, eller skal switchporte have deres eget
spor?**

- **Findings udvides** — `device_id` + `interface_id` på `findings`, og
  korrelatoren, tidslinjen, event_cases og alerting lærer om dem. Én model for
  "noget er galt", uanset om det er en server eller en switchport. Dyrt, og
  rører den mest centrale tabel i produktet.
- **Eget spor** — device-findings får deres egen tabel og deres egen skærm.
  Billigt, og produktet får to steder at kigge efter problemer, hvilket er
  præcis det `event_cases` blev bygget for at undgå.

Jeg hælder til det første, fordi `device_events` fra etape 01 allerede har vist
at enhedsdata hører hjemme på **den eksisterende** tidslinje frem for i sin
egen krog. Men det er en arkitekturbeslutning med en pris, og den hører til dig.

---

*Skrevet som audit. Ingen kode ændret. Afventer godkendelse af planen.*
