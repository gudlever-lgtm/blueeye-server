# BlueEye Server

FastAPI backend for the BlueEye network monitoring platform: agent control plane,
customer-facing REST API, Jinja2 admin UI, multi-tenant data model, BlackEye
license gating, Mollie-driven self-service upgrade, and a separate platform
License Server (in `license_server/`).

## Stack

- Python 3.12, FastAPI, Uvicorn
- PostgreSQL 16, SQLAlchemy 2 (async), Alembic
- Jinja2 server-side templates
- APScheduler for background housekeeping
- Mollie SDK for self-service billing
- PyJWT (EdDSA / Ed25519) for License Server JWT verification

## Quick start (Docker)

```bash
cd blueeye-server
cp .env.example .env   # optionally customise
docker compose up --build
```

The server runs Alembic migrations and the seed script on startup, then listens
on http://localhost:8000. Sign in with the credentials in `.env`
(`DEFAULT_SUPERADMIN_EMAIL` / `DEFAULT_SUPERADMIN_PASSWORD`).

## Running an agent

1. Sign in, open **Agents → Create agent**, copy the one-time token.
2. Either drop it into `/etc/blueeye/agent.conf` on the agent host, or run the
   bundled sample agent service alongside docker compose:

   ```bash
   BLUEEYE_AGENT_TOKEN=<token-from-ui> docker compose --profile agent up agent
   ```

   The agent container expects the `blueeye-agent` repository to live in
   `../blueeye-agent` relative to this directory.

3. Open **Tests** for that agent and add an HTTP / Ping / DNS check.

## Data model

| Table          | Purpose                                                     |
| -------------- | ----------------------------------------------------------- |
| `customers`    | Tenants. Holds license tier + expiry.                       |
| `users`        | UI users, scoped to a customer; bcrypt password hashes.     |
| `agents`       | Probes. Token stored as SHA-256 hash, shown once at create. |
| `test_configs` | What an agent is told to run.                               |
| `test_results` | Time-series of probe outcomes.                              |
| `api_keys`     | Bearer tokens for the customer REST API (SHA-256 hashed).   |
| `licenses`     | Audit trail of BlackEye purchases / grants.                 |

Every domain table carries `customer_id`; every query filters by it.

## Authentication

- **UI** — cookie session (Starlette `SessionMiddleware`).
- **Agent API** (`/api/agent/*`) — `Authorization: Bearer <agent-token>`.
- **Customer REST API** (`/api/v1/*`) — `Authorization: Bearer <api-key>`.

Roles: `superadmin` (cross-tenant), `admin` (own customer), `viewer` (read-only).

## Endpoints

### Agent (`/api/agent`)

| Method | Path                | Body                       |
| ------ | ------------------- | -------------------------- |
| POST   | `/api/agent/checkin` | (empty) — returns test_configs |
| POST   | `/api/agent/results` | `{ "results": [...] }`     |

### Customer REST (`/api/v1`)

| Method | Path                                  | Query                            |
| ------ | ------------------------------------- | -------------------------------- |
| GET    | `/api/v1/agents`                      | —                                |
| GET    | `/api/v1/results`                     | `agent_id, test_type, since, until, limit` |
| GET    | `/api/v1/agents/{id}/status`          | —                                |

### UI

`/login`, `/logout`, `/forgot-password`, `/reset-password`, `/dashboard`,
`/agents`, `/agents/new`, `/tests/{agent_id}`, `/results`, `/admin/users`,
`/admin/customers`, `/admin/licenses`, `/admin/api-keys`, `/billing/upgrade`.

## BlackEye gating

`has_blackeye(customer)` is the single source of truth. UI pages render a blurred
"Upgrade" placeholder when the customer is on the free tier; new BlackEye-only
endpoints should call `require_blackeye(customer)` which returns HTTP 402.

## Platform licensing

The BlueEye Server installation itself is licensed by a separate **License
Server** (see `license_server/README.md`). On startup and every 24h, the
BlueEye Server posts its `LICENSE_KEY` plus a server fingerprint to
`LICENSE_SERVER_URL/v1/license/validate` and receives a short-lived JWT
signed with an Ed25519 keypair. The public key is embedded in
`app/licensing.py::LICENSE_SERVER_PUBLIC_KEY_PEM`; the matching private key
lives only on the License Server.

The verified payload is cached in `license_cache`. If the License Server is
unreachable, the cached payload is honoured for 7 days; after that the
installation degrades to the free BlueEye tier (5-agent quota, no BlackEye
features) until contact is restored.

Enforcement points:

- **`POST /api/agent/checkin`** — rejects with `402` if the count of active
  agents exceeds the licensed `max_agents`. Also filters BlackEye-only test
  types (`bgp`, `traceroute`, `throughput`) out of the returned config when
  the platform license isn't BlackEye.
- **`POST /agents/new`** — rejects with `402` if the new agent would push the
  installation over `max_agents`.
- **`GET /admin/license`** — shows tier, quota usage, fingerprint, features,
  expiry, last-verified timestamp, and a "Revalidate now" button.

Leaving `LICENSE_SERVER_URL` or `LICENSE_KEY` empty turns licensing off; the
installation operates in default free-tier mode.

## Mollie flow

`POST /billing/upgrade` creates a Mollie payment and inserts a `pending`
`licenses` row. Mollie POSTs `/billing/webhook` with the payment id; on
`is_paid()` the row flips to `active`, the customer is bumped to BlackEye
with a one-year expiry, and admins can revoke from the licenses page.

Set `MOLLIE_API_KEY` in your environment; the rest is wired by
`app.routers.ui_billing`.

## Local development without Docker

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql+asyncpg://blueeye:blueeye@localhost:5432/blueeye
alembic upgrade head
python -m scripts.seed
uvicorn app.main:app --reload
```

## Tests

A test suite is not part of this MVP cut. The seed script + docker compose form
the smoke test: the server should boot, render `/login`, accept a sign-in, and
respond to `POST /api/agent/checkin` once an agent token has been minted.

## Out of scope (post-MVP)

BGP / traceroute / throughput probes, SLA PDF reports, webhook alerting,
end-to-end AD/LDAP login, white-label theming.

## License Server

A separate FastAPI service ships in `license_server/`. It owns the Ed25519
private key, issues + tracks license keys, and serves the
`/v1/license/{activate,validate}` API that BlueEye Server polls. See
`license_server/README.md` for details, schema, and JWT payload shape.

`docker compose up` starts it as the `license_server` service on
http://localhost:8001 alongside BlueEye Server. The dev signing keypair is
checked in for convenience — **rotate it (`python -m
license_server.scripts.gen_keypair`) and update
`app/licensing.py::LICENSE_SERVER_PUBLIC_KEY_PEM` before any real
deployment.**
