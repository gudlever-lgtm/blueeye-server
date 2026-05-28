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
| `LICENSE_KEY` | _(empty)_                  | License key (enables enforcement) |
| `SERVER_ID`   | _(empty)_                  | This deployment's id, bound into the license |
| `LICENSE_SERVER_URL` | `http://blueeye-licens:6000` | BlueEye License server base URL |
| `LICENSE_PUBLIC_KEY` | _(embedded)_        | Ed25519 public key used to verify validations |
| `LICENSE_ENABLED` | auto                  | Force enforcement on/off (`true`/`false`) |
| `LICENSE_GRACE_DAYS` | `14`               | Offline grace period on a cached validation |
| `LICENSE_VALIDATE_INTERVAL_MS` | `21600000` | Re-validation interval (6h)         |
| `LICENSE_CACHE_PATH` | `<dirname(DB_PATH)>/license-cache.json` | Cached validation file |

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

The server validates its license against the BlueEye License server. License
settings are fixed at install time (environment variables) and are **not**
editable through the REST API.

- **At startup and every `LICENSE_VALIDATE_INTERVAL_MS`**, the server POSTs
  `{ licenseKey, serverId }` to `${LICENSE_SERVER_URL}/validate`.
- The response is a signed token `{ signedLicense, signature, alg }`. The
  signature is verified with the **embedded Ed25519 public key**
  (`LICENSE_PUBLIC_KEY`); the claims must be bound to this `SERVER_ID` and
  `LICENSE_KEY`. An unverifiable or mismatched response is never trusted.
- The last *online-verified* validation is cached to disk
  (`LICENSE_CACHE_PATH`).
- **Offline grace period:** if the license server is unreachable, the cached
  validation keeps the server operational for `LICENSE_GRACE_DAYS` (default 14).
  After that — or with no cache — the license hard-fails.
- **Agent cap:** `maxAgents` from the cached license is enforced locally. New
  agent connections beyond the cap are refused (WS close `4002`); when the
  license is not operational, all new agents are refused (WS close `4001`).
  Already-connected agents may always reconnect.

Status is observable (read-only) at `GET /license` and under `license` in
`GET /health`. Enforcement is off until `LICENSE_KEY` is set, so local/dev runs
need no license server.

## Tests

```bash
node --test
```
