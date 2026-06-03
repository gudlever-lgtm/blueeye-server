# Analysis module

Local, explainable anomaly detection for the BlueEye server. The module looks at
the measurements agents already report, and raises **findings** when something
looks abnormal — no cloud, no ML library, only robust statistics that can be
explained in plain text.

> Design principles: **local** (no data leaves the server), **explainable**
> (every finding has a plain-text `explanation` + `evidence`), and **cannot
> break ingest** (analysis runs best-effort after measurements are stored).

All code lives under `src/analysis/` (plus a route under `src/routes/` and a
WebSocket under `src/ws/`).

## Data flow

```
agent → POST /agents/results → resultsRepo.createMany (stored)
                                  └─ analysisPipeline.processResults (best-effort)
                                       ├─ extractSamples()      payload → MetricSample[]
                                       ├─ detector.evaluate()   sample → Finding | null
                                       ├─ findingStore.save()   persist finding
                                       ├─ correlator.correlate()  group + root-cause
                                       │    └─ findingStore.setCorrelations()
                                       └─ publishFinding()      → dashboard-WebSocket
findings visible in UI via:  REST  GET /api/findings   (history)
                             WS    /ws/dashboard         (live push)
```

## Components

| File | Responsibility |
| --- | --- |
| `constants.js` | `Severity` (INFO/WARN/CRIT) and `FindingKind` (ANOMALY/THRESHOLD/FLATLINE/CORRELATED). |
| `types.js` | JSDoc typedefs for `MetricSample` and `Finding`. |
| `baselines.js` | Rolling windows per `host\|metric\|UTC-hour` with **median** + **MAD**. |
| `detector.js` | Robust z-score against baseline; anomaly, flatline and threshold. |
| `ingest.js` | Maps a result payload to `MetricSample[]`. |
| `pipeline.js` | Glues everything together behind the feature flag; runs after each batch. |
| `findings.js` | `FindingStore` — persistence (reuses the server's DB pool). |
| `correlator.js` | Time-clustering + dependency graph → likely cause + hint. |
| `config.js` | Reads `ANALYSIS_*` environment variables. |
| `assistant.js` | Opt-in LLM assistant (Mistral), off by default. |
| `dependency-graph.json` | Configurable cause→effect graph for the correlator. |

### Baselines (median + MAD)

For each `${hostId}|${metric}|${bucket}` (bucket = UTC hour 0–23, so day/night
rhythms are not mixed) a rolling window of the most recent N values is
maintained. The centre is the **median** and the spread is **MAD** (Median
Absolute Deviation). MAD is multiplied by `1.4826` to correspond to one standard
deviation on normally distributed data. Robust measures are used because
individual spikes should not contaminate the baseline.

A baseline is only used once it has at least `minSamples` points (warm-up).
Windows are persisted (file cache) so they survive a restart.

### Detector

`detector.evaluate(sample)` returns a `Finding` or `null` and never throws on
normal data:

- **Warm-up:** no/too-small baseline → learn and return `null`.
- **Flatline:** same value for 10 consecutive intervals → `FLATLINE` (WARN) —
  possible sensor/agent stop.
- **Anomaly:** robust z-score `dev = (value − median) / (MAD·1.4826)`;
  `|dev| ≥ critSigma` → `CRIT`, `≥ warnSigma` → `WARN`.

The explanation contains the actual numbers, e.g.:
`cpu at 92 deviated 5.3σ from 7-day baseline (41)`.

### Correlator (root-cause hint)

`correlate(findings, windowMs)` clusters findings **per host** within a time
window and identifies a likely cause from a **configurable dependency graph**
(`dependency-graph.json`). An edge `"A": ["B"]` means A is upstream of B (A can
cause B). The most upstream metric in the cluster is chosen as `likelyCause`
(earliest observed as a tie-break). Each correlated finding is marked with
`correlatedWith` (IDs) and the link is persisted.

Edit `dependency-graph.json` to customise the dependencies — the logic
hard-codes no metric relationships.

### AI assistant (opt-in)

**Off** by default. When enabled (`ANALYSIS_ASSISTANT_ENABLED=true` + API key)
you can ask a question about a host; the assistant builds a small context from
the most recent findings (summary fields only — no raw data or secrets) and
queries Mistral. When disabled the endpoint returns `403`.

## REST API

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| `GET` | `/api/findings?hostId=&since=` | viewer+ | List findings (newest first). `400` on invalid `since`. |
| `POST` | `/api/findings/:id/ack` | operator+ | Acknowledge a finding. `404` if the ID is unknown. |
| `POST` | `/api/assistant/explain` | viewer+ | Ask the assistant. `400` empty question, `403` disabled, `500` provider error. |

## WebSocket

`/ws/dashboard` — browser channel for live findings, gated by user JWT (token in
`Authorization` header or `?token=`). The server pushes `{type:'finding',
payload}` to all connected dashboards. The agent channel (`/ws/agent`) is
separate and token-gated for agents.

## Dashboard

The **Analysis** tab shows findings (severity, deviation, explanation,
correlation), lets operators acknowledge them, and contains the AI assistant
panel. New findings appear live via WebSocket and can also be retrieved via REST.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ANALYSIS_ENABLED` | `true` | Enable/disable the entire analysis module. |
| `ANALYSIS_CRIT_SIGMA` | `4.0` | Threshold for CRIT (sigma). |
| `ANALYSIS_WARN_SIGMA` | `3.0` | Threshold for WARN (sigma). |
| `ANALYSIS_BASELINE_DAYS` | `7` | How many days the baseline covers (shown in the explanation). |
| `ANALYSIS_MIN_SAMPLES` | `200` | Points before a baseline is used. |
| `ANALYSIS_BASELINE_CACHE_PATH` | `./.analysis-baselines.json` | Where baselines are persisted. |
| `ANALYSIS_ASSISTANT_ENABLED` | `false` | Enable the AI assistant (opt-in). |
| `ANALYSIS_ASSISTANT_API_KEY` | – | Key (fallback: `MISTRAL_API_KEY`). |
| `ANALYSIS_ASSISTANT_MODEL` | `mistral-small-latest` | Model. |
| `ANALYSIS_ASSISTANT_URL` | Mistral chat-completions | Provider endpoint. |
| `ANALYSIS_ASSISTANT_MAX_FINDINGS` | `20` | Max findings in context. |
| `ANALYSIS_ASSISTANT_TIMEOUT_MS` | `20000` | Timeout for the provider call. |

> **Runtime-editable:** `ANALYSIS_ENABLED`, `ANALYSIS_CRIT_SIGMA`,
> `ANALYSIS_WARN_SIGMA`, `ANALYSIS_BASELINE_DAYS` and `ANALYSIS_MIN_SAMPLES` can
> be changed by an admin under **Settings → Analysis**
> (`PUT /api/settings/analysis`). Overrides are stored in `app_settings`, layered
> on top of env defaults and re-applied at startup; the detector reads thresholds
> **per evaluation**, so changes take effect without a restart. The AI assistant +
> secrets remain env-controlled.

## Tests

`node --test` (Node's built-in runner). The module's tests live in
`src/analysis/__tests__/` and `test/` (HTTP + WebSocket). Error paths are tested
explicitly (empty/invalid input, 400/403/404/500, provider errors).
