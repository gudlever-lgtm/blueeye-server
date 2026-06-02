# Analyse-modulet

Lokal, forklarlig anomali-detektion for BlueEye-serveren. Modulet kigger på de
målinger agenterne allerede rapporterer ind, og rejser **findings** når noget
ser unormalt ud — uden cloud, uden ML-bibliotek, kun robust statistik der kan
forklares i klartekst.

> Designprincipper: **lokalt** (ingen data forlader serveren), **forklarligt**
> (hver finding har en `explanation` i klartekst + `evidence`), og **kan ikke
> vælte ingest** (analysen kører best-effort efter at målingerne er gemt).

All koden ligger under `src/analysis/` (plus en route under `src/routes/` og en
WebSocket under `src/ws/`).

## Dataflow

```
agent → POST /agents/results → resultsRepo.createMany (gemt)
                                  └─ analysisPipeline.processResults (best-effort)
                                       ├─ extractSamples()      payload → MetricSample[]
                                       ├─ detector.evaluate()   sample → Finding | null
                                       ├─ findingStore.save()   persistér finding
                                       ├─ correlator.correlate()  gruppér + root-cause
                                       │    └─ findingStore.setCorrelations()
                                       └─ publishFinding()      → dashboard-WebSocket
findings ses i UI via:  REST  GET /api/findings   (historik)
                        WS    /ws/dashboard         (live push)
```

## Komponenter

| Fil | Ansvar |
| --- | --- |
| `constants.js` | `Severity` (INFO/WARN/CRIT) og `FindingKind` (ANOMALY/THRESHOLD/FLATLINE/CORRELATED). |
| `types.js` | JSDoc-typedefs for `MetricSample` og `Finding`. |
| `baselines.js` | Rullende vinduer pr. `host\|metric\|UTC-time` med **median** + **MAD**. |
| `detector.js` | Robust z-score mod baseline; anomali, flatline og tærskel. |
| `ingest.js` | Mapper et resultat-payload til `MetricSample[]`. |
| `pipeline.js` | Limer det hele sammen bag feature-flaget; kører efter hver batch. |
| `findings.js` | `FindingStore` — persistering (genbruger serverens DB-pool). |
| `correlator.js` | Tids-klyngning + afhængighedsgraf → likely cause + dansk hint. |
| `config.js` | Læser `ANALYSIS_*`-miljøvariabler. |
| `assistant.js` | Opt-in LLM-assistent (Mistral), slået fra som standard. |
| `dependency-graph.json` | Konfigurerbar årsags→effekt-graf til korrelatoren. |

### Baselines (median + MAD)

For hver `${hostId}|${metric}|${bucket}` (bucket = UTC-time 0–23, så
dag/nat-rytmer ikke blandes) holdes et rullende vindue af de seneste N værdier.
Centrum er **medianen** og spredningen er **MAD** (Median Absolute Deviation).
MAD ganges med `1.4826` for at svare til et standardafvig på normalfordelte
data. Robuste mål vælges, fordi enkelte spikes ikke skal forurene baseline.

En baseline bruges først når den har mindst `minSamples` punkter (warm-up).
Vinduerne persisteres (fil-cache) så de overlever en genstart.

### Detektor

`detector.evaluate(sample)` returnerer en `Finding` eller `null` og kaster
aldrig på normale data:

- **Warm-up:** ingen/for lille baseline → lær og returnér `null`.
- **Flatline:** samme værdi 10 intervaller i træk → `FLATLINE` (WARN) — muligt
  sensor-/agentstop.
- **Anomali:** robust z-score `dev = (værdi − median) / (MAD·1.4826)`;
  `|dev| ≥ critSigma` → `CRIT`, `≥ warnSigma` → `WARN`.

Forklaringen indeholder de faktiske tal, fx:
`cpu på 92 afveg 5.3σ fra 7-dages baseline (41)`.

### Korrelator (root-cause-hint)

`correlate(findings, windowMs)` klynger findings **pr. host** inden for et
tidsvindue og udpeger en sandsynlig årsag ud fra en **konfigurerbar
afhængighedsgraf** (`dependency-graph.json`). En kant `"A": ["B"]` betyder at A
ligger opstrøms for B (A kan forårsage B). Den mest opstrøms-metrik i klyngen
vælges som `likelyCause` (tidligst observeret som tie-break). Hver korreleret
finding markeres med `correlatedWith` (id'er) og linket persisteres.

Rediger `dependency-graph.json` for at tilpasse afhængighederne — logikken
hardcoder ingen metrik-relationer.

### AI-assistent (opt-in)

Slået **fra** som standard. Når den er aktiveret (`ANALYSIS_ASSISTANT_ENABLED=true`
+ API-nøgle) kan man stille et spørgsmål om en host; assistenten bygger en lille
kontekst ud af de seneste findings (kun summary-felter — ingen rå data eller
hemmeligheder) og spørger Mistral. Slået fra svarer endpointet `403`.

## REST-API

| Metode | Sti | Rolle | Beskrivelse |
| --- | --- | --- | --- |
| `GET` | `/api/findings?hostId=&since=` | viewer+ | Listér findings (nyeste først). `400` på ugyldig `since`. |
| `POST` | `/api/findings/:id/ack` | operator+ | Kvittér en finding. `404` hvis id er ukendt. |
| `POST` | `/api/assistant/explain` | viewer+ | Spørg assistenten. `400` tom question, `403` slået fra, `500` provider-fejl. |

## WebSocket

`/ws/dashboard` — browser-kanal til live findings, gated af bruger-JWT (token i
`Authorization`-header eller `?token=`). Serveren pusher `{type:'finding',
payload}` til alle forbundne dashboards. Agent-kanalen (`/ws/agent`) er adskilt
og token-gated for agenter.

## Dashboard

Fanen **Analyse** viser findings (severity, afvigelse, forklaring, korrelation),
lader operatører kvittere, og indeholder AI-assistent-boksen. Nye findings
dukker op live via WebSocket og kan også hentes via REST.

## Konfiguration

| Variabel | Standard | Beskrivelse |
| --- | --- | --- |
| `ANALYSIS_ENABLED` | `true` | Slå hele analysen til/fra. |
| `ANALYSIS_CRIT_SIGMA` | `4.0` | Tærskel for CRIT (sigma). |
| `ANALYSIS_WARN_SIGMA` | `3.0` | Tærskel for WARN (sigma). |
| `ANALYSIS_BASELINE_DAYS` | `7` | Hvor mange dage baseline dækker (vises i forklaringen). |
| `ANALYSIS_MIN_SAMPLES` | `200` | Punkter før en baseline bruges. |
| `ANALYSIS_BASELINE_CACHE_PATH` | `./.analysis-baselines.json` | Hvor baselines persisteres. |
| `ANALYSIS_ASSISTANT_ENABLED` | `false` | Slå AI-assistenten til (opt-in). |
| `ANALYSIS_ASSISTANT_API_KEY` | – | Nøgle (fallback: `MISTRAL_API_KEY`). |
| `ANALYSIS_ASSISTANT_MODEL` | `mistral-small-latest` | Model. |
| `ANALYSIS_ASSISTANT_URL` | Mistral chat-completions | Provider-endpoint. |
| `ANALYSIS_ASSISTANT_MAX_FINDINGS` | `20` | Max findings i konteksten. |
| `ANALYSIS_ASSISTANT_TIMEOUT_MS` | `20000` | Timeout på provider-kaldet. |

> **Runtime-redigerbart:** `ANALYSIS_ENABLED`, `ANALYSIS_CRIT_SIGMA`,
> `ANALYSIS_WARN_SIGMA`, `ANALYSIS_BASELINE_DAYS` og `ANALYSIS_MIN_SAMPLES` kan
> ændres af en admin under **Indstillinger → Analyse**
> (`PUT /api/settings/analysis`). Overrides gemmes i `app_settings`, lægges oven
> på env-defaults og genanvendes ved opstart; detektoren læser tærsklerne **pr.
> evaluering**, så ændringer slår igennem uden genstart. AI-assistenten +
> secrets forbliver env-styret.

## Test

`node --test` (Node's indbyggede runner). Modulets tests ligger i
`src/analysis/__tests__/` og `test/` (HTTP + WebSocket). Fejl-paths testes
eksplicit (tomme/ugyldige input, 400/403/404/500, provider-fejl).
