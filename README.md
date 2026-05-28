# BlueEye Server

Node.js server that manages BlueEye Agents over WebSocket, exposes a REST API
for the React UI, persists test results to SQLite, and forwards results to
BlueEye RCA.

## Stack

- Node.js >= 20 (ESM)
- Express 4
- ws (WebSocket)
- better-sqlite3 (no ORM)

## Configuration

Environment variables (see `.env.example`):

| Variable      | Default                    | Description              |
|---------------|----------------------------|--------------------------|
| `PORT`        | `3000`                     | REST API port            |
| `WS_PORT`     | `4000`                     | WebSocket port           |
| `DB_PATH`     | `/data/blueeye.db`         | SQLite database file     |
| `RCA_URL`     | `http://blueeye-rca:5000`  | BlueEye RCA base URL     |
| `RCA_ENABLED` | `true`                     | Toggle RCA forwarding    |
| `LICENSE_KEY` | (unset)                    | License key; enables license enforcement when set |
| `SERVER_ID`   | (unset)                    | This server's unique id (bound into validations)  |
| `LICENSE_SERVER_URL` | `http://blueeye-licenseserver:4100` | License server base URL |
| `LICENSE_GRACE_MS`   | `1209600000` (14d)         | Offline grace on cached validation |
| `LICENSE_POLL_INTERVAL_MS` | `21600000` (6h)      | Re-validation interval   |

## Running

### Locally

```bash
npm install
DB_PATH=./data/blueeye.db node src/index.js
```

### Docker

```bash
docker compose up
```

## REST API

| Method | Path                  | Description                              |
|--------|-----------------------|------------------------------------------|
| GET    | `/health`             | Health check (`500` if DB unreachable)   |
| GET    | `/agents`             | All agents with live online/offline      |
| GET    | `/agents/:id`         | Single agent + latest 20 results         |
| POST   | `/tests`              | Create + dispatch a test to an agent     |
| GET    | `/tests`              | All tests (`?agentId=`, `?limit=50`)     |
| GET    | `/tests/:id`          | Single test + its result                 |
| GET    | `/results`            | All results (`?agentId=`,`?type=`,`?limit=100`) |
| GET    | `/results/:agentId`   | All results for one agent                |

### POST /tests body

```json
{ "agentId": "AAR-BRANCH-02", "type": "latency", "target": "8.8.8.8", "options": {} }
```

Returns `404` if the agent is not currently online, otherwise `201` with
`{ "testId": "..." }`.

## WebSocket protocol

Agents connect to `ws://host:4000` and send JSON messages:

- `register` — `{ "type": "register", "agentId", "hostname", "platform", "arch", "nodeVersion" }`
- `test_result` — `{ "type": "test_result", "testId", "agentId", "type", "target", "status", "result", "error", "durationMs" }`

The server pings agents every 30s and drops unresponsive ones after 10s.

## RCA forwarding

Each incoming `test_result` is POSTed to `${RCA_URL}/analyze` with the result
plus the agent's 10 most recent results. Forwarding is fire-and-forget with a
10s timeout; failures are logged (`[rca] Forward failed: ...`) and never block
the test flow. Set `RCA_ENABLED=false` to disable.

## License validation

When `LICENSE_KEY` is set, the server validates its license against
[`blueeye-licenseserver`](../blueeye-licenseserver) at startup and every 6 hours.
It POSTs `{licenseKey, serverId, agentCount}` to `/validate`, verifies the
**Ed25519-signed** response against an embedded public key, and requires
`payload.serverId` to match its own `SERVER_ID`. The last verified validation is
cached on disk; if the license server is unreachable the server keeps running on
the cache for a 14-day grace period, after which it hard-fails.

`max_agents` is enforced locally: once the cap is reached, new agent WebSocket
connections are refused (existing agents and re-connections are unaffected).

> The validation is a **license proof, not an access token.** Agent
> authentication (bearer tokens) is issued and validated entirely locally by
> this server (Flow 1) — the license server never sees or touches agent tokens.

If no `LICENSE_KEY` is configured, license enforcement is disabled and the
server behaves exactly as before. See
[`docs/LICENSE_VERIFICATION.md`](docs/LICENSE_VERIFICATION.md) for the embedded
key and verification details.

## Tests

```bash
node --test
```
