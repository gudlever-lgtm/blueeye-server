# BlueEye License Server

Standalone FastAPI service that issues and validates BlueEye platform licenses.
Each customer's BlueEye Server installation posts its license key + server
fingerprint here every 24h; this service signs a short-lived JWT describing
the active tier, agent quota, and feature set, which BlueEye Server caches
and enforces.

## Endpoints

| Method | Path                       | Auth         | Purpose                                |
| ------ | -------------------------- | ------------ | -------------------------------------- |
| POST   | `/v1/license/activate`     | license key  | First-time bind a license to a server  |
| POST   | `/v1/license/validate`     | license key  | Returns a signed JWT                   |
| GET    | `/admin/licenses`          | admin session | List + manage licenses                 |
| POST   | `/admin/licenses/new`      | admin session | Mint a new license                     |
| POST   | `/admin/licenses/{id}/deactivate` | admin session | Revoke immediately                 |
| POST   | `/admin/licenses/{id}/rebind`     | admin session | Forget the bound fingerprint       |
| GET    | `/health`                  | none         | Health check                           |

## JWT payload

The signed JWT (algorithm `EdDSA`) contains:

```json
{
  "tier": "blackeye",
  "max_agents": 50,
  "features": ["bgp", "traceroute", "sla_reports"],
  "customer_name": "Acme Corp",
  "fingerprint": "<sha256 of caller>",
  "expires_at": "2027-05-28T00:00:00+00:00",
  "iat": 1716800000,
  "nbf": 1716800000,
  "exp": 1716807200,
  "iss": "blueeye-license-server"
}
```

`exp` is short (default 2h) so a stolen JWT can't outlive a deactivation by
long; BlueEye Server gates its own enforcement on `cached_at`, not on `exp`.

## Signing key

```bash
python -m license_server.scripts.gen_keypair
```

- **Private key** stays on the License Server. Configure via
  `LICENSE_PRIVATE_KEY_PEM` (inline) or `LICENSE_PRIVATE_KEY_FILE` (mount as
  a Docker secret in production).
- **Public key** is embedded at build time in BlueEye Server source
  (`app/licensing.py::LICENSE_SERVER_PUBLIC_KEY_PEM`). Rotating the keypair
  requires a code release of BlueEye Server.

## Local run

```bash
cd blueeye-server
python -m venv .venv && . .venv/bin/activate
pip install -r license_server/requirements.txt
export DATABASE_URL=postgresql+asyncpg://license:license@localhost:5432/licenses
export LICENSE_PRIVATE_KEY_PEM="$(python -m license_server.scripts.gen_keypair | sed -n '/BEGIN PRIVATE/,/END PRIVATE/p')"
alembic -c license_server/alembic.ini upgrade head
python -m license_server.scripts.seed
uvicorn license_server.app.main:app --port 8001
```

Then sign in at <http://localhost:8001/admin/login> with the default admin
credentials from `.env`.

## In docker-compose

The blueeye-server repo's `docker-compose.yml` runs the License Server as the
`license_server` service. The dev keypair shipped in
`app/licensing.py::LICENSE_SERVER_PUBLIC_KEY_PEM` is the one Docker Compose
will use by default; **rotate it before deploying to production.**

## Schema

```
licenses(id, key_hash, customer_name, tier, max_agents, features_json,
         fingerprint, activated_at, expires_at, last_seen, active, created_at)
admin_users(id, email, password_hash, active, created_at)
```

The plaintext license key is **never** stored — only its SHA-256 hash. After
creation, the UI shows the key once; that's the only time anyone can read it.
