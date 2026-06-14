# Alerting

Phase 9. Turns findings into action by forwarding them to configurable channels.
Built on the FindingStore + correlator (phases 1–6); runs after a finding is
saved and correlated, behind the `ALERTING_ENABLED` flag (default off).

## Channels (`src/analysis/alerting/channels/`)

All share the interface `send(finding, group) → { ok, detail }`.

- **email** — SMTP via nodemailer (lazy-required; point at a European/self-hosted
  host). No hard dependency — if nodemailer isn't installed the channel reports
  a clean failure. Transport is injectable for tests. **To enable email in a real
  install:** `npm install nodemailer` (it is intentionally NOT a default dependency
  to keep the footprint minimal). Until it is installed, `GET /api/alerting/config`
  reports the email channel as `available: false` with `reason: "nodemailer not
  installed"`, so the dashboard shows WHY an enabled email channel isn't delivering
  rather than failing silently.
- **webhook** — `POST`s the finding (+ correlation group) as JSON to a configured
  URL, **HMAC-SHA256 signed** with a shared secret. The receiver verifies
  `X-BlueEye-Signature: sha256=<hex>` against the raw body.
- **syslog** — RFC5424 over UDP/TCP, formatted to forward to Cisco ISE. Severity
  maps `CRIT→err (3)`, `WARN→warning (4)`, `INFO→info (6)`; facility `local0`.

## Dispatcher (`src/analysis/alerting/dispatcher.js`)

- **Minimum severity per channel** — a finding only reaches a channel if its
  severity ≥ that channel's `minSeverity`.
- **Throttle / dedup** — a cooldown per `(hostId, metric, kind)` so the same
  condition on the same host doesn't spam (configurable `ALERT_COOLDOWN_MS`).
- **Isolation** — each channel send is caught individually; one failing channel
  never stops the others.

Hooked into the analysis pipeline after `findingStore.save()` + correlation,
behind `ALERTING_ENABLED`. Dispatch is best-effort and never breaks ingestion.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/alerting/config` | Active channels + rules, **without secrets** (viewer+). |
| `POST` | `/api/alerting/test` | `{ channel }` — send a test finding to one channel. `404` unknown channel, `400` missing, `200` + result (operator+). |
| `GET` | `/api/settings` | Includes `alerting` — the full editable config, **secret-safe** (admin). |
| `PUT` | `/api/settings/alerting` | Update channel config (admin, licence-gated). Partial patches merge; secrets are write-only. |

## Configuration

Two layers, DB-over-env (same pattern as the AI assistant key):

- **Env defaults** — `ALERTING_ENABLED`, `ALERT_COOLDOWN_MS`, and per channel
  `ALERT_*_ENABLED` / `ALERT_*_MIN_SEVERITY` plus channel specifics (`SMTP_*`,
  `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_SECRET`, `SYSLOG_*`). See `.env.example`.
- **Runtime overrides (Settings → Alerting)** — an admin can edit every field
  from the dashboard. Stored in `app_settings` under the `alerting` key and
  **live-applied onto the running config** (`settingsService` mutates the
  `alertingConfig` object the dispatcher + channels hold, in place), so changes
  take effect **without a restart** — including SMTP changes, which rebuild the
  mailer lazily via the `createTransport` factory. Persisted edits are re-applied
  at boot by `settingsService.applyStoredOverrides()`, so they survive restarts.

The two secrets — SMTP password and webhook HMAC — are **write-only**: stored in
`app_settings` but never returned by the API. Reads (`getAlertingSafe`) expose
only whether each is set, plus a short masked hint (`••••1234`); a blank value
on save keeps the stored secret, and a `clearSmtpPass` / `clearSecret` flag wipes
it. `setAlerting` is licence-gated with the same `alerting` entitlement as the
dispatcher, so an admin cannot configure a channel the server would refuse to
dispatch through.

## Tests

`src/analysis/alerting/__tests__/` (dispatcher rules, throttling, isolation,
channel HMAC/syslog format/email + transport rebuild) and `test/alertingApi.test.js`,
`test/alertingPipeline.test.js` + `test/alertingSettings.test.js` (runtime config:
secret-safe reads, live-apply to the dispatcher/channels, licence gate). All
outgoing calls are mocked — no real emails/webhooks/syslog in tests.
