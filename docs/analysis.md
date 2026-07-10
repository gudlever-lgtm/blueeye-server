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

**Off** by default. Enable it and set the API key **either** via env
(`ANALYSIS_ASSISTANT_ENABLED=true` + `ANALYSIS_ASSISTANT_API_KEY`) **or** at
runtime in the dashboard (**Settings → Analysis → AI assistant**, admin) — the
stored setting overrides the env defaults and applies without a restart. Once
enabled you can ask a question about a host; the assistant builds a small context
from the most recent findings (summary fields only — no raw data or secrets) and
queries the configured provider. When disabled the endpoint returns `403`. The same assistant also
powers the **Explain with AI** button on an agent's **Diagnose** result — turning
the (bounded) flow-pipeline snapshot, plus the host's recent findings/probe-health,
into a plain-language read-out and next step. The API key is stored in
`app_settings` but never returned by the API (reads expose only whether a key is
set, plus a masked hint).

**Provider selection.** The assistant speaks the OpenAI-compatible
`/v1/chat/completions` API, so the provider is swappable. Pick one in **Settings →
Analysis → AI assistant**:

| Provider | Region | Endpoint | Key |
| --- | --- | --- | --- |
| `mistral` | EU | `api.mistral.ai` | required |
| `scaleway` | EU | `api.scaleway.ai` | required |
| `openai` | US | `api.openai.com` | required |
| `anthropic` | US | `api.anthropic.com` | required |
| `gemini` | US | `generativelanguage.googleapis.com` | required |
| `groq` | US | `api.groq.com` | required |
| `openrouter` | US | `openrouter.ai` | required |
| `ollama` | self-hosted | `localhost:11434` | none |
| `custom` ("Other") | any | admin-supplied | optional |

**Which LLM to use is the admin's decision, not a product constraint.** The
no-US-vendor rule in `CLAUDE.md` governs BlueEye's *own* dependencies (map tiles,
GeoIP, geocoder, fonts) — not where an admin chooses to send the assistant's
context. The assistant only ever sends **metadata-derived summaries** (never raw
data or payload), so the choice is about **data-residency preference**: each
preset shows its region (default Mistral is EU) so an admin who cares can choose
accordingly, but no option is blocked. The `custom` provider takes a base URL you
enter yourself (e.g. an Azure or self-hosted deployment); a private / loopback
target is allowed on purpose (running an LLM on-box is a supported use). The
preset catalog lives in `src/analysis/assistantProviders.js`. When
`ANALYSIS_ASSISTANT_PROVIDER` is unset the provider is inferred from
`ANALYSIS_ASSISTANT_URL` (a preset match, else `custom`), so existing env-only
installs keep working unchanged.

**API key at rest.** The key is stored **encrypted** in `app_settings`
(AES-256-GCM via `secretBox`, the same scheme integration credentials and the LDAP
bind password use, keyed by `SECRET_ENCRYPTION_KEY`). It is decrypted only in
memory to authenticate to the provider, and the API never returns it (only
`apiKeySet` + a masked hint). A pre-encryption plaintext key is read transparently
and re-encrypted on the next save.

## REST API

| Method | Path | Role | Description |
| --- | --- | --- | --- |
| `GET` | `/api/findings?hostId=&since=` | viewer+ | List findings (newest first). `400` on invalid `since`. |
| `POST` | `/api/findings/:id/ack` | operator+ | Acknowledge a finding. `404` if the ID is unknown. |
| `POST` | `/api/assistant/explain` | viewer+ | Ask the assistant. `400` empty question, `403` disabled, `500` provider error. |
| `POST` | `/api/assistant/diagnose-explain` | viewer+ | Explain a flow-pipeline diagnostic snapshot. `400` missing diagnostic, `403` disabled, `500` provider error. |

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
| `ANALYSIS_ASSISTANT_PROVIDER` | inferred from URL | Provider preset: `mistral`, `scaleway`, `ollama` or `custom`. |
| `ANALYSIS_ASSISTANT_API_KEY` | – | Key (fallback: `MISTRAL_API_KEY`); not needed for keyless self-hosted providers. |
| `ANALYSIS_ASSISTANT_MODEL` | `mistral-small-latest` | Model. |
| `ANALYSIS_ASSISTANT_URL` | Mistral chat-completions | Endpoint (used for the `custom` provider; presets use their own). |
| `ANALYSIS_ASSISTANT_MAX_FINDINGS` | `20` | Max findings in context. |
| `ANALYSIS_ASSISTANT_TIMEOUT_MS` | `20000` | Timeout for the provider call. |

> **Runtime-editable:** `ANALYSIS_ENABLED`, `ANALYSIS_CRIT_SIGMA`,
> `ANALYSIS_WARN_SIGMA`, `ANALYSIS_BASELINE_DAYS` and `ANALYSIS_MIN_SAMPLES` can
> be changed by an admin under **Settings → Analysis**
> (`PUT /api/settings/analysis`). Overrides are stored in `app_settings`, layered
> on top of env defaults and re-applied at startup; the detector reads thresholds
> **per evaluation**, so changes take effect without a restart. The AI assistant's
> enable flag, provider, API key, model and custom endpoint are runtime-editable
> the same way (`PUT /api/settings/assistant`); other secrets remain
> env-controlled.

## Probe-based findings

Active-probe results feed the same findings pipeline as traffic metrics. After an
agent posts to `POST /agents/probe-results`, `analysis/probePipeline.js` runs
`analysis/probeFindings.js` over that agent's recent rows. It reuses the **same
median+MAD verdict** the fleet-health view shows (`health/probeHealth.js`), so a
finding never claims anything the dashboard verdict doesn't:

- `probe.reachability` (CRIT) — targets not responding;
- `probe.loss` (WARN ≥2 % / CRIT ≥20 %);
- `probe.latency` (ANOMALY, z-score vs. the target's own baseline);
- `probe.jitter` (WARN ≥30 ms / CRIT ≥100 ms);
- `probe.cert` (WARN ≤14 d / CRIT ≤3 d) — TLS certificate expiry from the **http**
  probe, judged independently of reachability.

Findings are de-duplicated within a 30-min cooldown (per metric+target) so
frequent probes don't spam the list or the alert channels. Gated by the analysis
license+flag; alerts go through the existing dispatcher (alerting flag).

## AI: per-location summary

Besides per-host `/explain`, the opt-in assistant exposes
`POST /api/assistant/location-summary { locationId }` — a brief, plain-language
"what's going on at this location?" status. The context is built locally from the
location's agents: each agent's status, its probe-health verdict, and recent
findings (each already carrying an explanation). As with `/explain`, **only** that
compact, human-readable slice is sent to the provider — never raw metrics or
payload. In the dashboard it's the **Locations → "AI status"** button.

## Tests

`node --test` (Node's built-in runner). The module's tests live in
`src/analysis/__tests__/` and `test/` (HTTP + WebSocket). Error paths are tested
explicitly (empty/invalid input, 400/403/404/500, provider errors). Probe
findings: `test/probeFindings.test.js` + `test/probePipeline.test.js`; the
location summary: `test/assistantLocation.test.js` + `test/assistantApi.test.js`.
