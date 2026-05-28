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
| `JWT_SECRET`  | `dev-insecure-secret-…`    | HS256 signing secret for auth tokens |

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
| GET    | `/users`              | List users (admin only)                  |
| POST   | `/users`              | Create a user (admin only)               |
| PUT    | `/users/:id`          | Update role / reset password (admin only)|
| DELETE | `/users/:id`          | Delete a user (admin only)               |

### Authentication

Auth is stateless via HS256 JWTs (`src/auth/`). Protected routes expect an
`Authorization: Bearer <token>` header; tokens carry a `role` claim of
`admin`, `operator`, or `viewer`. All `/users` routes require an `admin`
token. Passwords are hashed with `scrypt` (`src/auth/password.js`) and the
hash is never returned by the API.

#### POST /users body

```json
{ "email": "alice@blueeye", "password": "s3cret", "role": "operator" }
```

`role` defaults to `viewer`. Returns `201` with the created user (without the
password hash), `400` on missing fields or an invalid role, and `409` if the
email already exists.

#### PUT /users/:id body

```json
{ "role": "viewer", "password": "new-password" }
```

Both fields are optional but at least one is required; `password` triggers a
reset. Returns `404` for an unknown id and `409` when the change would remove
the last `admin` (demotion or deletion).

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

## Tests

```bash
node --test
```
