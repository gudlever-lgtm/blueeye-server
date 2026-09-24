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
behind `ALERTING_ENABLED`. Dispatch is best-effort and never breaks ingestion.

## What every alert carries (`src/analysis/alerting/alertContext.js`)

Before a subject reaches the channels the dispatcher adds two fields to a
**copy** of it (`enrich`), so the throttle, the alert log and the caller are
untouched:

- **`hostName`** — the agent's display name (or hostname), looked up and cached
  for a minute. A situation is named by up to five of its agents. The email
  subject reads `[BlueEyes CRIT] probe.loss on core-sw-1 (#12)`; without a name
  it keeps the old `on host 12`.
- **`link`** — an absolute URL into the dashboard for the most specific record:
  `/situations/:id` for a situation, `/events/:id` when the finding already
  belongs to an event, otherwise `/agents/:id`. Built from
  **`BLUEEYE_PUBLIC_URL`**; when it is unset (or not an absolute http(s) URL)
  alerts go out without a link rather than with one that does not open.

Email puts the link on the line after the explanation, Matrix as a link in the
formatted body, the webhook as top-level `link` / `hostName` (additive — older
receivers ignore them), syslog as `agent="…" link=…` in the message.

## Agent offline (`src/health/agentOfflineAlerter.js`)

An agent whose socket closes and does not come back within a **grace period**
(2 minutes; `AGENT_OFFLINE_ALERT_GRACE_MS` overrides it) raises one alert:
`metric: agent.connection`, `kind: OFFLINE`, severity CRIT, naming the agent
and when it went. When it reconnects a recovery (`kind: ONLINE`) follows. The
grace rides out restarts, self-updates and blips the agent's own reconnect
bridges. It goes through the same dispatcher, so channel floors, the cooldown
and **maintenance windows** apply — planned work on a site does not page.

At boot every socket is new, so the agents seen in the last ten minutes get the
same grace; one that does not reconnect is alerted. An agent that reconnected
to another server instance (its `last_seen` moved on after the disconnect) is
not alerted by this one. Polled SNMP devices never hold a socket and are never
watched.

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
channel HMAC/syslog format/email + transport rebuild, alert context: name + link
per channel), `test/agentOfflineAlerter.test.js` and `test/alertingApi.test.js`,
`test/alertingPipeline.test.js` + `test/alertingSettings.test.js` (runtime config:
secret-safe reads, live-apply to the dispatcher/channels, licence gate). All
outgoing calls are mocked — no real emails/webhooks/syslog in tests.
