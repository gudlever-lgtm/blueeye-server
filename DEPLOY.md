# BlueEye — Docker Compose demo & deployment

Runs the whole stack (MySQL + license server + server + agent) on one host and
exercises the end-to-end flow: **agent measures traffic → sends to server →
server validates its license against the license server**.

## Prerequisites

- Docker + Docker Compose v2.
- The three repos cloned **as siblings** (as on this server):
  ```
  /var/www/blueeye.gnf.dk/
  ├── blueeye-server     # docker-compose.yml lives here
  ├── blueeye-agent
  └── blueeye-licens
  ```

## 1) Bootstrap (once)

From `blueeye-server/`, generate the Ed25519 license key pair + demo `.env`:

```bash
cd blueeye-server
node scripts/dev-bootstrap.js     # writes .env (gitignored) with keys + demo defaults
```

This puts the **private** key in `LICENSE_SIGNING_KEY` (used by the license
server) and the matching **public** key in `LICENSE_PUBLIC_KEY` (used by the
server to verify proofs offline) — a real, matching pair.

## 2) Start everything

```bash
docker compose up --build
```

Startup order is enforced via health checks:

1. **db** (MySQL) — `mysql-init.sql` creates `blueeye` + `blueeye_licens`.
2. **licens** — migrates, seeds a demo customer + an **active license**
   (`LICENSE_KEY=DEMO-DEMO-DEMO-DEMO-DEMO`, `max_agents=100`), serves on **:4000**.
3. **server** — migrates, seeds a demo enrollment code, then **validates its
   license against licens at startup** and serves on **:3000**.
4. **agent** — enrolls with the demo code, opens the WebSocket, waits for commands.

## 3) Access the services (for config)

| Service | URL / Port | Notes |
| --- | --- | --- |
| Server API | `http://<host>:3000` | Agents, locations, users, enrollment, `GET /license/status` |
| License server API | `http://<host>:4000` | Customers, licenses, `POST /validate` |
| MySQL | `<host>:3307` | Host port 3307 by default (3306 is usually taken by a system MySQL); override with `DB_HOST_PORT`. User `blueeye`, password from `.env` (`DB_PASSWORD`); databases `blueeye`, `blueeye_licens` |
| Agent | (no port) | Outbound client; configure via env / `docker compose exec agent sh` |

Staff login (both server and licens), default admin from `.env`:
```bash
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@blueeye.local","password":"<ADMIN_PASSWORD from .env>"}'
```

## 4) Test the full flow

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@blueeye.local","password":"<ADMIN_PASSWORD>"}' | jq -r .token)

# License is valid (validated against licens):
curl -s http://localhost:3000/license/status -H "Authorization: Bearer $TOKEN" | jq

# The agent enrolled and connected — find its id:
curl -s http://localhost:3000/agents -H "Authorization: Bearer $TOKEN" | jq

# Trigger a traffic measurement on the agent (id 1 here):
curl -s -X POST http://localhost:3000/agents/1/run-test \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"intervalMs":1000}' | jq            # -> { "delivered": 1, ... }

# Read back the reported traffic:
curl -s http://localhost:3000/agents/1/results -H "Authorization: Bearer $TOKEN" | jq
```

To measure the **host's** traffic instead of the container's, run the agent with
`network_mode: host` (Linux).

## Production notes

This compose is a **demo**. For production:

- Remove the demo seeds (`SEED_DEMO=0`) and create real customers/licenses via the
  license API; set `LICENSE_KEY` to the issued key and a real `LICENSE_SERVER_ID`.
- Keep `LICENSE_SIGNING_KEY` only on the license server; embed the public key in
  blueeye-server (`src/license/publicKey.js` or `LICENSE_PUBLIC_KEY`).
- Set strong `JWT_SECRET`s and admin passwords; the server refuses to start in
  production with the default JWT secret.
- The agent normally runs on customer machines (not in this compose).
