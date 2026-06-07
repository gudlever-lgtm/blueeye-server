# Outbound API integrations (ITSM / IPAM connectors)

Pushes BlueEye events to external systems through a generic connector framework.
Integrations are configured at runtime (admin), their credentials are encrypted at
rest, and every fire is audited. This is **outbound only** — BlueEye calls the
target's REST API; nothing is pulled back, and nothing is deleted unless a
connector is explicitly told it may.

## Data model

| Table | Migration | Purpose |
| --- | --- | --- |
| `integrations` | 026 | one row per target (`type`, `name`, `base_url`, `auth_type`, `credentials_encrypted`, `enabled`, `config_json`). |
| `integration_audit` | 027 | one row per fire (event, correlation id, ok, HTTP status, attempts, actor for manual tests). |

Credentials are encrypted with **AES-256-GCM** (`src/lib/secretBox.js`, keyed by
`SECRET_ENCRYPTION_KEY` → defaults to `JWT_SECRET`) — **never** stored or returned
in plaintext. The repository (`src/repositories/integrationsRepository.js`) mirrors
the `usersRepository` split: safe reads omit the secret column; only
`findByIdWithSecret` / `findEnabledWithSecret` return it, for the dispatcher.

## Connectors (`src/integrations/connectors/`)

All share the interface `{ type, authTypes, defaultEvents, validateConfig(config),
send(integration, event), test(integration) }`, registered in `connectors/index.js`.
fetch is injected (tests run offline) and every call is bounded by a timeout
(`src/integrations/httpClient.js`).

- **servicenow** — creates/updates a ServiceNow **Incident** (REST Table API) on a
  NIS2-incident (CRIT finding) or anomaly. Auth Basic or OAuth2 (Bearer). BlueEye
  severity → impact/urgency (`CRIT→1/1`, `WARN→2/2`, `INFO→3/3`). **Idempotent via
  `correlation_id`**: it looks up an existing incident by correlation id and PATCHes
  it instead of opening a duplicate.
- **nautobot** — **one-way** sync of agents → Nautobot **devices** (REST API, token
  auth). Looks a device up by name and PATCHes or POSTs it. Required device fields
  come from `config.deviceDefaults`. **No deletion** unless `config.allowDelete:true`
  (an `agent.delete` is otherwise recorded as skipped).
- **webhook** — generic JSON POST (optionally HMAC-SHA256 signed via
  `credentials.secret`), proof that the interface is open for future targets.

## Trigger layer (`src/integrations/dispatcher.js`)

Domain events are emitted here and fanned out to every **enabled** integration whose
connector subscribes to that event type (`config.events` overrides the connector
default). Events:

- `incident` / `anomaly` — from the analysis + probe pipelines (a CRIT finding is an
  incident, anything else an anomaly). The `correlation_id` is **stable** per
  `(host, metric, kind)` so a recurring condition updates one ticket.
- `agent.enroll` / `agent.delete` — from the enrollment + agent-delete routes.

Each fire gets: **debounce** (a per-`(integration, event, correlation)` cooldown),
**retry** (bounded exponential backoff on network/5xx; a 4xx is not retried), and
**one audit row** (ok/fail + the target's HTTP status + attempt count). Credentials
are decrypted only at fire time. Firing is best-effort and fire-and-forget from the
pipelines/routes — it never slows or breaks ingestion, enrollment or deletion.

## API (`/api/integrations`, admin only)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/integrations` | list (safe; **no credentials**). |
| `GET` | `/api/integrations/meta` | connector catalogue (types + supported auth + default events). |
| `GET` | `/api/integrations/:id` | one (safe). `404` unknown. |
| `GET` | `/api/integrations/:id/audit` | recent fire history. |
| `POST` | `/api/integrations` | create. `400` invalid/unknown type/auth/config, `409` duplicate name. |
| `PUT` | `/api/integrations/:id` | update (type is immutable; credentials write-only — `clearCredentials` to wipe). |
| `DELETE` | `/api/integrations/:id` | delete. `404` unknown. |
| `POST` | `/api/integrations/:id/test` | manual **test-fire** — returns the **actual HTTP status** from the target. `404` unknown. |

## Configuration

No env config — integrations are created via the API. Credentials are encrypted with
`SECRET_ENCRYPTION_KEY` (see `.env.example`).

## Tests

`test/connectors.test.js` (payload mapping, auth headers, idempotency, 4xx/5xx),
`test/integrationsDispatcher.test.js` (debounce, retry/backoff, audit-per-call, event
routing), `test/integrationsApi.test.js` (CRUD 400/401/403/404/409/500 + credential
redaction + encryption at rest), `test/integrationsRepository.test.js` (safe vs.
with-secret SQL), `test/integrationsTrigger.test.js` (enroll/delete/pipeline wiring),
`test/secretBox.test.js`. All outgoing calls are mocked — no real network in tests.
