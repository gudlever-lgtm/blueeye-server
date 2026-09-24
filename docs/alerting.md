# Alerting

Phase 9. Turns findings into action by forwarding them to configurable channels.
Built on the FindingStore + correlator (phases 1–6); runs after a finding is
saved and correlated, behind the master switch `ALERTING_ENABLED` — which is
**automatic by default**: on as soon as one channel is configured (below).

## The master switch: automatic, on, off

`ALERTING_ENABLED` used to default to `false`, so a customer who configured an
e-mail or webhook channel — and nothing else — got no alert at all, and nothing
said why. The switch now has three states (`src/analysis/alerting/config.js`):

| `ALERTING_ENABLED` / Settings → Alerting | Effective |
| --- | --- |
| unset, empty or `auto` / **Automatic** | **on iff at least one channel is configured** |
| `true`/`1`/`yes`/`on` / **On** | on (even with no channel configured — nothing is sent until one is) |
| `false`/`0`/`no`/`off` / **Off** | off, even with channels configured |

A channel counts as **configured** when it is enabled *and* has somewhere to send
to: e-mail needs `to` + an SMTP host, webhook a URL, Matrix homeserver + room +
token, syslog a host. Channels come from the env (`ALERT_*`) or, once an admin has
saved Settings → Alerting, from the stored settings — whichever is in force.

The effective answer carries its **reason** — `explicit-on`, `explicit-off`,
`auto-channels` or `auto-no-channels` — returned by `GET /api/alerting/config`
(`enabled`, `enabledSetting` true/false/null, `enabledReason`,
`configuredChannels`) and shown at the top of Settings → Alerting ("Alerting is ON
— automatic, because these channels are configured: webhook."). The settings API
reports the admin's choice as `enabledMode` (`auto`/`on`/`off`) beside the
effective `enabled` boolean; `PUT /api/settings/alerting` takes `enabledMode`, or
the older boolean `enabled` (`true` → on, `false` → off, `null`/`"auto"` → auto).

**Stored settings from before the tri-state.** A stored `enabled: true` reads as
**On**. A stored `enabled: false` reads as **Automatic**: every channel-card save
used to write the then-default `false` along with the channel, so it cannot be told
apart from "never touched" — and that is exactly how a configured channel ended up
silent. An install that really wants alerting off sets **Off** (or
`ALERTING_ENABLED=false` with no stored override); the screen says which is in force.

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
- **matrix** — posts into a room on the customer's **own** Matrix homeserver
  (Synapse / Conduit / Dendrite). This is the chat channel an on-prem, EU,
  no-US-vendors product can actually ship: the homeserver runs inside the same
  network, so an alert never leaves the building. Slack or Teams would have been
  the other way round.

  It is also the one thing the other three cannot do — email is where alerts go
  to be missed, a webhook needs somebody to build the far end, and syslog is for
  machines. A room is where the people who fix this already are.

  The client-server API is used directly over `fetch`, no SDK:
  `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`. **PUT with
  a transaction id**, not POST, because it is idempotent — the id is derived from
  the finding, so a retry after a timeout cannot post the same alert twice. Both
  a plain `body` and an HTML `formatted_body` are sent, carrying the same
  information: many clients and every notification preview show only the plain
  one. Configure `homeserver`, the internal `roomId` (`!abc:example.dk` — an
  **alias** is refused, because whoever controls one can re-point it at another
  room) and a bot `accessToken`, which is write-only like the SMTP password.
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
behind the master switch. Dispatch is best-effort and never breaks ingestion.

Every finding producer reaches the dispatcher the same way — store, publish,
event case, alert, integrations. Two sources that used to bypass that:

- **Transaction tests** (`transaction.fail` / `.latency` / `.deviation`) were
  dispatched directly from the agent socket with no finding and no event case. A
  crossed threshold is now a finding raised through the finding sink
  (`src/devices/findingSink.js`), and that sink is the only thing that alerts on it.
  See `src/analysis/transactionAlerts.js`.
- **Probe outages** (`probe_outages`) were never dispatched at all. Opening (and an
  escalation) raises a `probe_outage.<metric>` finding; closing dispatches one
  recovery alert (kind `RECOVERED`). See `docs/probe-outages.md`.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/alerting/config` | Active channels + rules, **without secrets**, plus the effective master switch and why (`enabled`, `enabledSetting`, `enabledReason`, `configuredChannels`) (viewer+). |
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
secret-safe reads, live-apply to the dispatcher/channels, licence gate),
`test/alertingEnabledDefault.test.js` (the tri-state switch: unset + channel,
unset + none, explicit false, explicit true, stored legacy rows, the API). All
outgoing calls are mocked — no real emails/webhooks/syslog in tests.
