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
| `WS_AGENT_SECRET` | _(unset)_              | HMAC secret for agent WS tokens. **Required** — if unset, all agent connections are rejected (fail closed). |
| `API_KEYS`    | _(unset)_                  | REST RBAC keys, comma-separated `key:role` pairs (e.g. `k1:admin,k2:operator`) |

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

## Authentication & authorization

### REST RBAC

REST callers authenticate with an API key, sent as `X-API-Key: <key>` (or
`Authorization: Bearer <key>`). Keys map to roles via `API_KEYS`. Roles are
ordered `viewer` < `operator` < `admin`.

Write endpoints require at least `operator`; an unauthenticated request gets
`401`, an authenticated request with an insufficient role gets `403`. Read
endpoints are currently open.

| Endpoint        | Minimum role |
|-----------------|--------------|
| `POST /tests`   | `operator`   |

### Agent WebSocket tokens

Agents must present a signed token on the WS upgrade, as
`Authorization: Bearer <token>` (or `?token=<token>`). Invalid, mis-signed,
expired, or missing tokens are rejected at the handshake with `401` — no
WebSocket is established.

The token is HMAC-signed against `WS_AGENT_SECRET`:

```
token   = base64url(payload) "." base64url(HMAC_SHA256(secret, base64url(payload)))
payload = "<agentId>:<exp>"        # exp = unix seconds
```

On `register`, the `agentId` in the message must match the token's `agentId`
(the token is authoritative); a mismatch closes the socket (code `4003`).

Mint a token for an agent with:

```bash
WS_AGENT_SECRET=... node src/sign-token.js <agentId> [ttlSeconds]
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

Agents connect to `ws://host:4000` with a signed bearer token (see
[Agent WebSocket tokens](#agent-websocket-tokens)) and send JSON messages:

- `register` — `{ "type": "register", "agentId", "hostname", "platform", "arch", "nodeVersion" }`
- `test_result` — `{ "type": "test_result", "testId", "agentId", "type", "target", "status", "result", "error", "durationMs" }`

The server pings agents every 30s and drops unresponsive ones after 10s.

## RCA forwarding

Each incoming `test_result` is POSTed to `${RCA_URL}/analyze` with the result
plus the agent's 10 most recent results. Forwarding is fire-and-forget with a
10s timeout; failures are logged (`[rca] Forward failed: ...`) and never block
the test flow. Set `RCA_ENABLED=false` to disable.

## Tests

```bash
node --test
```
