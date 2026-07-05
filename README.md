# blueeye-server

On-prem, single-tenant API server for BlueEye. Built on **Node.js + Express**
with **MySQL** as the data store. Runs entirely on your own infrastructure —
no external SaaS, no telemetry.

## Dependencies

Open source components with permissive licences (MIT/BSD) only:

| Package       | Licence | Role                           |
| ------------- | ------- | ------------------------------ |
| express       | MIT     | HTTP framework / routing       |
| mysql2        | MIT     | MySQL driver (pool, promises)  |
| jsonwebtoken  | MIT     | Issue/verify JWT               |
| bcryptjs      | MIT     | Password hashing (pure JS)     |
| ws            | MIT     | WebSocket (agent live channel) |
| dotenv        | BSD-2   | Load `.env`                    |
| supertest     | MIT     | HTTP tests (`devDeps` only)    |

`bcryptjs` is chosen over native `bcrypt`/`argon2` because it is pure
JavaScript and therefore requires no build step — easy to deploy on-prem across
hosts. Hashing is isolated in [`src/auth/password.js`](src/auth/password.js)
so the algorithm can be swapped without touching callers.

Tests use Node's built-in test runner (`node --test`) — no extra test framework
needed.

## Requirements

- Node.js >= 20 (developed and tested on Node 22)
- A MySQL server (8.x recommended)

## Getting started

```bash
# 1) Install dependencies
npm install

# 2) Create the configuration and fill in the values
cp .env.example .env

# 3) Create the database in MySQL (one-time task)
#    CREATE DATABASE blueeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# 4) Run migrations (creates tables)
npm run migrate

# 5) Start the server
npm start          # production
npm run dev        # development, restarts on file changes
```

The server listens on port `3000` by default (can be changed with `PORT`).

## Configuration

All configuration is done via environment variables (see [`.env.example`](.env.example)):

| Variable              | Default     | Description                            |
| --------------------- | ----------- | -------------------------------------- |
| `NODE_ENV`            | development | Runtime environment                    |
| `PORT`                | 3000        | HTTP port                              |
| `DB_HOST`             | 127.0.0.1   | MySQL host                             |
| `DB_PORT`             | 3306        | MySQL port                             |
| `DB_USER`             | blueeye     | DB user                                |
| `DB_PASSWORD`         | (empty)     | DB password                            |
| `DB_NAME`             | blueeye     | Database name                          |
| `DB_CONNECTION_LIMIT` | 10          | Max connections in pool                |
| `JWT_SECRET`          | (dev value) | Key for signing JWTs                   |
| `JWT_EXPIRES_IN`      | 12h         | JWT lifetime                           |
| `JWT_ISSUER`          | blueeye-server | `iss` claim on tokens              |
| `BCRYPT_ROUNDS`       | 12          | bcrypt cost factor                     |
| `SEED_ADMIN_EMAIL`    | admin@blueeye.local | Email of the seeded admin    |
| `SEED_ADMIN_PASSWORD` | (empty)     | Password; generated if empty           |
| `ENROLLMENT_CODE_TTL_MINUTES` | 60  | Default lifetime for enrollment codes |
| `WS_AGENT_PATH`       | /ws/agent   | Path for the agent WebSocket           |
| `WS_HEARTBEAT_MS`     | 30000       | Heartbeat interval (ping) in ms        |

> In production (`NODE_ENV=production`) the server refuses to start if
> `JWT_SECRET` has not been changed from the dev default.

## Database

- [`schema.sql`](schema.sql) — complete schema snapshot. Can be loaded directly
  into a fresh database: `mysql -u <user> -p <db> < schema.sql`.
- [`migrations/`](migrations) — numbered SQL migrations, run in order.
  `migrations/` is the source of truth for incremental changes.
- [`src/migrate.js`](src/migrate.js) — simple migration runner. Tracks already-run
  migrations in the `schema_migrations` table, so `npm run migrate` is safe to run
  repeatedly. Add a new migration by placing a file `NNN_description.sql` in
  `migrations/`. After the migrations an **admin user is seeded** if none exists
  (see below).

### `locations`

| Column        | Type            | Notes                                  |
| ------------- | --------------- | -------------------------------------- |
| `id`          | INT UNSIGNED PK | Auto-increment                         |
| `name`        | VARCHAR(255)    | Required, e.g. `"Aarhus – Head Office"` |
| `description` | TEXT            | Optional (nullable)                    |
| `created_at`  | TIMESTAMP       | Set automatically                      |
| `updated_at`  | TIMESTAMP       | Updated automatically on change        |

### `users`

| Column          | Type            | Notes                                   |
| --------------- | --------------- | --------------------------------------- |
| `id`            | INT UNSIGNED PK | Auto-increment                          |
| `email`         | VARCHAR(255)    | Unique                                  |
| `password_hash` | VARCHAR(255)    | bcrypt hash (never plaintext)           |
| `role`          | ENUM            | `admin` / `operator` / `viewer`         |
| `created_at`    | TIMESTAMP       | Set automatically                       |
| `updated_at`    | TIMESTAMP       | Updated automatically on change         |

**Admin seed:** When migrations run, one admin user is created if none exists.
Email is taken from `SEED_ADMIN_EMAIL`. If `SEED_ADMIN_PASSWORD` is set it is
used; otherwise a strong password is generated and printed **once** to the
console — save it immediately.

### `agents`

Fields are split into two groups: **agent-reported** (written by the agent
itself at enrollment/heartbeat) and **server-managed** (set by operators/admins
via the API). `PUT /agents/:id` only touches the server-managed fields.

| Column          | Group           | Type            | Notes                                   |
| --------------- | --------------- | --------------- | --------------------------------------- |
| `id`            | —               | INT UNSIGNED PK | Auto-increment                          |
| `hostname`      | agent-reported  | VARCHAR(255)    | Required                                |
| `platform`      | agent-reported  | VARCHAR(64)     | e.g. `linux`, `win32`                   |
| `arch`          | agent-reported  | VARCHAR(32)     | e.g. `x64`, `arm64`                     |
| `last_seen`     | agent-reported  | DATETIME        | Nullable                                |
| `status`        | agent-reported  | ENUM            | `online` / `offline` (default `offline`)|
| `location_id`   | server-managed  | INT UNSIGNED FK | → `locations(id)` `ON DELETE SET NULL`  |
| `display_name`  | server-managed  | VARCHAR(255)    | Nullable                                |
| `notes`         | server-managed  | TEXT            | Nullable                                |
| `meta`          | server-managed  | JSON            | Nullable                                |
| `created_at`    | —               | TIMESTAMP       | Set automatically                       |
| `updated_at`    | —               | TIMESTAMP       | Updated automatically on change         |

Agents are created exclusively via **enrollment** (see [Enrollment](#enrollment))
— there is deliberately no manual `POST /agents`.

### `enrollment_codes`

One-time codes for enrolling new agents. The `code` itself is random and unique
and is returned to the operator **once** at creation — the list never shows it.

| Column        | Type            | Notes                                   |
| ------------- | --------------- | --------------------------------------- |
| `id`          | INT UNSIGNED PK | Auto-increment                          |
| `code`        | VARCHAR(64)     | Unique, random                          |
| `location_id` | INT UNSIGNED FK | Nullable → `locations(id)` `SET NULL`   |
| `created_by`  | INT UNSIGNED FK | → `users(id)`                           |
| `expires_at`  | DATETIME        | Expiry timestamp                        |
| `used_at`     | DATETIME        | Nullable; set when the code is redeemed |
| `created_at`  | TIMESTAMP       | Set automatically                       |

### `agent_tokens`

Opaque agent tokens. **Only the SHA-256 hash is stored** — never the token itself.

| Column         | Type            | Notes                                       |
| -------------- | --------------- | ------------------------------------------- |
| `id`           | INT UNSIGNED PK | Auto-increment                              |
| `agent_id`     | INT UNSIGNED FK | Nullable → `agents(id)` `ON DELETE CASCADE` |
| `token_hash`   | VARCHAR(64)     | Unique (SHA-256 hex)                        |
| `created_at`   | TIMESTAMP       | Set automatically                           |
| `last_used_at` | DATETIME        | Nullable                                    |
| `revoked_at`   | DATETIME        | Nullable                                    |

### `results`

Test results reported by agents (via REST, agent-token-authenticated).

| Column       | Type            | Notes                                   |
| ------------ | --------------- | --------------------------------------- |
| `id`         | INT UNSIGNED PK | Auto-increment                          |
| `agent_id`   | INT UNSIGNED FK | → `agents(id)` `ON DELETE CASCADE`      |
| `payload`    | JSON            | The result itself                       |
| `created_at` | TIMESTAMP       | Set automatically                       |

## API

Most endpoints require a user JWT in `Authorization: Bearer <token>` and
access is determined by role (see [Authorisation](#authorisation-rbac)).
Exceptions: `/health`, `/auth/login` and `/agents/enroll` are open, while
`/agents/results` and the WebSocket channel use an **agent token** (not a JWT)
— see [Agent communication](#agent-communication).

| Method | Path             | Description                       | Role               | Response                   |
| ------ | ---------------- | --------------------------------- | ------------------ | -------------------------- |
| GET    | `/health`        | Liveness — checks DB connection   | (open)             | `200` (DB up) / `503`      |
| POST   | `/auth/login`    | Log in, receive a JWT             | (open)             | `200` + token / `401`      |
| GET    | `/locations`     | Get all locations                 | viewer+            | `200` with array           |
| POST   | `/locations`     | Create a location                 | operator+          | `201` / `400`              |
| PUT    | `/locations/:id` | Update a location                 | operator+          | `200` / `404` / `400`      |
| DELETE | `/locations/:id` | Delete a location                 | admin              | `204` / `404` / `400`      |
| GET    | `/users`         | Get all users                     | admin              | `200` with array           |
| POST   | `/users`         | Create user (hashes password)     | admin              | `201` / `400` / `409`      |
| PUT    | `/users/:id`     | Update role (+ optional reset)    | admin              | `200` / `404` / `400` / `409` |
| DELETE | `/users/:id`     | Delete user (not last admin)      | admin              | `204` / `404` / `409`      |
| GET    | `/agents`        | Get all agents (join location)    | viewer+            | `200` with array           |
| GET    | `/agents/:id`    | Get one agent                     | viewer+            | `200` / `404` / `400`      |
| PUT    | `/agents/:id`    | Update ONLY server-managed fields | operator+          | `200` / `404` / `400`      |
| DELETE | `/agents/:id`    | Delete an agent                   | admin              | `204` / `404` / `400`      |
| POST   | `/agents/enroll` | Enroll agent with code            | (open)             | `201` / `400` / `401` / `410` |
| POST   | `/enrollment-codes` | Generate a one-time code      | operator+          | `201` (code once) / `400`  |
| GET    | `/enrollment-codes` | List with status (no code)    | operator+          | `200` with array           |
| DELETE | `/enrollment-codes/:id` | Delete a code             | admin              | `204` / `404` / `400`      |
| POST   | `/agents/results` | Submit test results             | **agent-token**    | `201` / `400` / `401`      |
| GET    | `/agents/:id/results` | Get an agent's results      | viewer+            | `200` / `404` / `400`      |
| GET    | `/license/status` | Local license status            | viewer+            | `200`                      |
| GET    | `/api/findings`  | List analysis findings            | viewer+            | `200` / `400` (invalid since) |
| POST   | `/api/findings/:id/ack` | Acknowledge a finding    | operator+          | `200` / `404`              |
| POST   | `/api/assistant/explain` | Ask the AI assistant (opt-in) | viewer+       | `200` / `400` / `403` / `500` |
| GET    | `/api/geo/config` | Map tile source for frontend    | viewer+            | `200`                      |
| GET    | `/api/geo/overview` | Internal hosts + external destinations | viewer+    | `200` / `400`              |
| GET    | `/api/geo/select/findings` | Findings for selected country/ASN | viewer+     | `200` / `400` / `404`      |
| GET    | `/api/geo/select/flows` | Flow details for selected country/ASN | viewer+   | `200` / `400` / `404`      |
| GET    | `/api/alerting/config` | Active alert channels + rules | viewer+            | `200`                      |
| POST   | `/api/alerting/test` | Send a test finding to a channel | operator+         | `200` / `400` / `404`      |
| GET    | `/license/features` | Which modules the license permits | viewer+           | `200`                      |
| GET    | `/api/export/:resource` | CSV/JSON export (`?format=csv\|json`) | viewer+    | `200` / `400` / `403` / `404` |
| WS     | `/ws/agent`      | Live channel (status/commands)    | **agent-token**    | upgrade / hard close       |
| WS     | `/ws/dashboard`  | Live findings for the dashboard   | viewer+ (JWT)      | upgrade / hard close       |

("viewer+" = viewer or higher; "operator+" = operator or admin.
"agent-token" = opaque agent token, not a user JWT.)

CSV/JSON export: `GET /api/export/<resource>?format=csv|json` for `findings`,
`geo` (license-gated), `agents`, `locations` and `traffic` (requires `agentId`).
Findings/geo respect the same `hostId`/`since` filters as their APIs.
The dashboard has "Export: CSV / JSON" buttons on the Analysis and Geo tabs.

The analysis module (local anomaly detection, correlator and opt-in AI assistant)
is described in [`docs/analysis.md`](docs/analysis.md). The geo layer (flow
records, GeoIP/ASN enrichment and map API) is described in
[`docs/geo.md`](docs/geo.md). Alerting (findings → email/webhook/syslog) is
described in [`docs/alerting.md`](docs/alerting.md). Retention + rollup
(down-sampling, purge, cross-reading of raw + aggregated data) is described in
[`docs/retention.md`](docs/retention.md). License-controlled feature gating
(features in the signed license) is described in
[`docs/license-features.md`](docs/license-features.md).

### Examples

```bash
# Log in and save token
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@blueeye.local","password":"<password>"}' | jq -r .token)

# Get all locations (requires at least viewer)
curl http://localhost:3000/locations -H "Authorization: Bearer $TOKEN"

# Create a location (requires operator+)
curl -X POST http://localhost:3000/locations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Aarhus – Head Office","description":"Headquarters"}'

# Delete a location (requires admin)
curl -X DELETE http://localhost:3000/locations/1 -H "Authorization: Bearer $TOKEN"

# Create a user (requires admin)
curl -X POST http://localhost:3000/users \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"ops@blueeye.local","password":"a-long-password","role":"operator"}'
```

### Error responses

Errors are returned as JSON. Status codes:

- `400` — validation error or invalid `:id`
- `401` — missing/invalid/expired token, or wrong login credentials
- `403` — valid token, but the role does not have access
- `404` — unknown path or resource not found
- `409` — conflict (e.g. duplicate email, or attempt to delete the last admin)
- `500` — unexpected server error (e.g. database is down during a request)
- `503` — `/health` when the database is not responding

## Authorisation (RBAC)

Login via `POST /auth/login` returns a JWT, carried in
`Authorization: Bearer <token>`. Two middleware functions enforce access
([`src/auth/middleware.js`](src/auth/middleware.js)):

- `requireAuth` — requires a valid JWT, otherwise `401`.
- `requireRole(...roles)` — requires the user's role to be among those listed,
  otherwise `403`.

Three roles with increasing permissions:

| Action                                  | viewer | operator | admin |
| --------------------------------------- | :----: | :------: | :---: |
| Read locations (GET)                    |   ✓    |    ✓     |   ✓   |
| Create/edit locations (POST/PUT)        |   –    |    ✓     |   ✓   |
| Delete locations (DELETE)               |   –    |    –     |   ✓   |
| Read agents (GET)                       |   ✓    |    ✓     |   ✓   |
| Edit agent metadata (PUT)               |   –    |    ✓     |   ✓   |
| Delete agents (DELETE)                  |   –    |    –     |   ✓   |
| User administration (`/users`)          |   –    |    –     |   ✓   |
| Create/list enrollment codes            |   –    |    ✓     |   ✓   |
| Delete enrollment codes                 |   –    |    –     |   ✓   |

JWTs are signed with HS256 and `JWT_SECRET`; the algorithm is pinned during
verification to prevent algorithm-confusion attacks. Passwords are hashed with
bcrypt and never stored in plaintext.

## Enrollment

New agents are created via enrollment — not manually. The flow:

1. **Operator/admin generates a code:** `POST /enrollment-codes` (optional
   `location_id`, optional `expiresInMinutes`, default 1 hour). The code is
   returned in plaintext **once** — store it for the agent.
2. **The agent enrolls itself:** `POST /agents/enroll { code, hostname,
   platform, arch }` — **without** auth (the agent has no token yet). The server:
   - validates the code (found → else `401`; used/expired → `410`),
   - creates an agent row with agent-reported fields + `location_id` from the code,
   - generates an **opaque token** (not a JWT), stores its SHA-256 hash and
     marks the code as used — all in one transaction with the row locked, so a
     code can never be used twice,
   - returns `{ agentId, token }` in plaintext **once**.

Agent tokens are opaque random strings. They are stored only as a hash; if the
token is lost the agent must re-enroll. The entire claim-and-enroll is atomic
([`src/services/enrollmentStore.js`](src/services/enrollmentStore.js)).

```bash
# 1) Operator generates a code (with an operator/admin token)
curl -s -X POST http://localhost:3000/enrollment-codes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"location_id":1}'
# -> { "id":1, "code":"<one-time-code>", "expires_at":"...", ... }

# 2) The agent enrolls itself (no auth)
curl -s -X POST http://localhost:3000/agents/enroll \
  -H 'Content-Type: application/json' \
  -d '{"code":"<one-time-code>","hostname":"node-01","platform":"linux","arch":"x64"}'
# -> { "agentId":7, "token":"<opaque-token>" }
```

## Agent communication

Agents use their **opaque token** (from enrollment) — not a user JWT.
Token auth and user JWT auth are kept in two separate middlewares
([`src/auth/agentAuth.js`](src/auth/agentAuth.js) and
[`src/auth/middleware.js`](src/auth/middleware.js) respectively). Incoming agent
tokens are hashed (SHA-256) and looked up in `agent_tokens`; unknown or revoked
tokens are rejected. On valid auth, `last_used_at` and `agents.last_seen` are
updated.

**WebSocket — `/ws/agent`** (live status + commands):

- The agent sends its token in `Authorization: Bearer <token>` **or** as
  `?token=<token>` in the URL at connect time.
- Without a valid token the handshake is rejected **hard** (HTTP `401` during
  upgrade — a WebSocket is never created).
- On connect `status = online` is set; on disconnect `status = offline`.
- Server ping (heartbeat) keeps `last_seen` fresh; connections without a response
  are closed.
- Server→agent: the server can push commands (e.g. `run test`) to an agent's
  active connections.

**REST** (agent token):

- `POST /agents/results { results: [ {...} ] }` — stores each element as a
  `results` row tied to the `agent_id` from the token.

Results are read back by users via `GET /agents/:id/results` (user JWT,
viewer+).

```bash
# Agent submits results with its opaque token
curl -X POST http://localhost:3000/agents/results \
  -H "Authorization: Bearer <agent-token>" -H 'Content-Type: application/json' \
  -d '{"results":[{"test":"ping","ok":true}]}'
```

## License validation (against blueeye-licens)

The server validates its own license against the central `blueeye-licens`. The
signed response is used **only** as a license proof — **never** as an access
token. Agent tokens are issued and validated exclusively locally; the license
server never touches them.

**Configuration (set at installation, not via CRUD)** — via env (see
[`.env.example`](.env.example)) or `src/license/publicKey.js`:

| Variable | Description |
| --- | --- |
| `LICENSE_KEY` | License key issued by blueeye-licens — **the only value a customer must set** |
| `LICENSE_SERVER_ID` | *Optional.* This server's ID (must match `payload.serverId`). When unset, derived from a stable host fingerprint and bound on first validation — see *Minimal customer setup* in `docs/licensing.md` |
| `LICENSE_SERVER_URL` | *Optional.* blueeye-licens URL; defaults to the vendor's hosted licens |
| `LICENSE_PUBLIC_KEY` | *Optional.* Ed25519 public key overriding `src/license/publicKey.js` (dev/test only; ignored in production without `TRUST_ANCHOR_OVERRIDE_ACK`) |
| `LICENSE_GRACE_DAYS` | Offline grace period (default 14) |
| `LICENSE_VALIDATE_INTERVAL_HOURS` | Validation interval (default 6) |

The embedded public key comes from `docs/public-key.md` in blueeye-licens. For a
customer, setting `LICENSE_KEY` alone is enough (see
[`docs/licensing.md` → *Minimal customer setup*](docs/licensing.md#minimal-customer-setup--license_key-only)).

> **This server never holds the private signing key.** `LICENSE_SIGNING_KEY`
> (and `LICENS_JWT_SECRET`) belong **only** to the vendor's blueeye-licens host;
> this server verifies with the *public* key alone. For the full "which host
> holds what" breakdown — including how `.env` is read (dotenv vs. Docker
> Compose) and how to validate a running host — see
> [`docs/licensing.md` → *Environment, secrets & deployment topology*](docs/licensing.md#environment-secrets--deployment-topology-which-host-holds-what).

**Logic:**

- At startup + every 6 hours: `POST /validate` with `{ licenseKey, serverId, agentCount }`.
- The response is verified: canonical JSON of `payload` is reproduced with the
  **same `canonicalize()`** as blueeye-licens (copied byte-for-byte into
  [`src/lib/canonicalize.js`](src/lib/canonicalize.js)) and the signature is
  checked against the embedded public key.
- The response is **rejected** if the signature is invalid **or** `payload.serverId`
  ≠ own `serverId` (falls back to cache).
- The last valid (verified) validation is cached on disk (`LICENSE_CACHE_PATH`).
- **Offline grace:** if the server cannot validate, the cached validation is used
  for up to 14 days; after that **hard failure** (unlicensed).
- **max_agents enforced locally:** new agent WebSocket connections are rejected
  (`403`) when the count would exceed the limit, or when the license is not valid.

Status can be viewed via `GET /license/status` (viewer+).

> `blueeye-server` must embed blueeye-licens' public key in
> `src/license/publicKey.js` (or `LICENSE_PUBLIC_KEY`). Until then all
> verification fails and the server is unlicensed.

## Project structure

```
blueeye-server/
├── migrations/                 # Numbered SQL migrations
│   ├── 001_create_locations.sql
│   ├── 002_create_users.sql
│   ├── 003_create_agents.sql
│   ├── 004_create_enrollment.sql
│   └── 005_create_results.sql
├── schema.sql                  # Full schema snapshot
├── src/
│   ├── app.js                  # Express app factory (without listen)
│   ├── server.js               # Entrypoint: wiring + listen + WS + shutdown
│   ├── migrate.js              # Migration runner + admin seed
│   ├── config.js               # Env-based configuration
│   ├── db.js                   # MySQL connection pool + helpers
│   ├── logger.js               # Quiet default logger for tests
│   ├── auth/                   # JWT + agent token (two separate auth systems)
│   ├── lib/                    # canonicalize (byte-identical with blueeye-licens)
│   ├── license/                # verify, publicKey, cache, licenseManager
│   ├── middleware/             # asyncHandler, error handling, request log
│   ├── repositories/           # Data access (locations, users, agents, tokens, results …)
│   ├── services/               # enrollmentStore (atomic claim-and-enroll)
│   ├── routes/                 # health, auth, users, locations, agents, enrollment, license …
│   ├── validation/             # Input validation
│   └── ws/                     # agentSocket (WebSocket live channel)
├── test/                       # Tests (node --test + supertest + ws)
└── test-support/               # Test fakes (outside test/)
```

## Tests

```bash
npm test
```

Tests run against the app factory with injected fakes — **no running database
required**. Coverage includes login (valid/wrong → `401`), protected endpoints
without a token (`401`), insufficient role (`403`), `400`/`404`/`409`/`500` for
all endpoints, enrollment (`401`/`410`), POST results with/without an agent token
(`401`), and WebSocket connect with a valid/invalid token (a real
HTTP+WebSocket server is started in the test). For license validation: valid
validation, invalid signature, wrong serverId, offline with valid cache, offline
after grace period expired, agent over limit, and that `canonicalize()` matches
blueeye-licens byte-for-byte.
