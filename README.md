# BlueEye Server

The collection and troubleshooting hub for the **BlueEye** network monitoring
system. [BlueEye agents](https://github.com/gudlever-lgtm/blueeye-agent) run on
Cisco switches, register with this server over mutual TLS, poll for jobs, run
network checks, and report results. Operators use the dashboard to trace
errors and outages to specific **locations** and **connections**.

## Architecture

```
  Cisco switch                 BlueEye server                operator
 ┌──────────────┐   mTLS   ┌────────────────────┐         ┌──────────┐
 │ BlueEye agent│ ───────▶ │ Flask API + Postgres│ ◀────── │ dashboard│
 │  ping/dns/http│  jobs &  │  jobs · results     │  HTTPS  │  (web UI)│
 └──────────────┘  results └────────────────────┘         └──────────┘
```

- **Flask** API, served over mutual TLS (`serve.py`).
- **PostgreSQL** stores agents, jobs, and results (`schema.sql`, applied on
  startup).
- Agents are authenticated by their client-certificate Common Name; an
  invalid certificate or unknown CN is rejected with **403**.
- All error responses are structured JSON: `{"error": "<message>"}`.

## API

| Method & path                   | Purpose                                    |
|----------------------------------|--------------------------------------------|
| `GET  /`                         | Operator dashboard (HTML)                  |
| `GET  /health`                   | Health check                               |
| `POST /agents/register`          | Register/refresh agent (identity = cert CN)|
| `GET  /agents`                   | List agents                                |
| `GET  /agents/<id>/jobs`         | Agent polls its pending jobs               |
| `GET  /agents/<id>/results`      | Recent results for an agent                |
| `POST /jobs`                     | Queue a job (`ping` / `dns` / `http`)      |
| `GET  /jobs`                     | List jobs (optional `?agent_id=`)          |
| `POST /jobs/<id>/results`        | Agent submits a job result                 |

Error behaviour: unknown agent/job → **404**; unknown job type → **400**;
missing client certificate → **403**; malformed request body → **500**.
Every response carries a JSON `error` field.

## Environment variables

| Variable        | Default                                         |
|-----------------|-------------------------------------------------|
| `DATABASE_URL`  | `postgresql://blueeye:blueeye@localhost:5432/blueeye` |
| `CA_CERT_PATH`  | `certs/ca.crt`                                  |
| `SERVER_CERT`   | `certs/server.crt`                              |
| `SERVER_KEY`    | `certs/server.key`                              |
| `PORT`          | `8443`                                          |

## 1. Generate certificates

The stack uses mutual TLS, so a CA, a server certificate, and one client
certificate per agent are required.

```bash
./scripts/gen_certs.sh
```

This creates, under `certs/`:

- `ca.crt` / `ca.key` — the certificate authority
- `server.crt` / `server.key` — the server certificate
- `agent-001.crt` / `agent-001.key` — a client certificate for the first agent

### Add a certificate for a new agent

The agent's identity on the dashboard is its certificate Common Name, so give
each switch a descriptive name:

```bash
./scripts/gen_certs.sh agent switch-oslo-01
```

Copy `certs/switch-oslo-01.crt`, `certs/switch-oslo-01.key`, and `certs/ca.crt`
to that switch and point the agent's `CLIENT_CERT` / `CLIENT_KEY` / `CA_CERT`
at them.

## 2. Start the stack

Clone both repositories as siblings (Compose builds the agent image from
`../blueeye-agent`):

```
parent/
├── blueeye-server/   (this repo)
└── blueeye-agent/
```

Then:

```bash
./scripts/gen_certs.sh      # once
docker compose up --build
```

This starts PostgreSQL, the server (on `https://localhost:8443`), and one
agent (`agent-001`). The schema is created automatically.

## 3. Push a custom test with curl

Jobs are created against the mTLS API, so pass the client certificate:

```bash
curl --cert certs/agent-001.crt \
     --key  certs/agent-001.key \
     --cacert certs/ca.crt \
     -H "Content-Type: application/json" \
     -d '{"agent_id":"agent-001","type":"ping","target":"8.8.8.8","params":{"count":5}}' \
     https://localhost:8443/jobs
```

Built-in job types and useful `params`:

| Type   | `target`            | `params`                              |
|--------|---------------------|---------------------------------------|
| `ping` | host or IP          | `count`                               |
| `dns`  | hostname            | `record`, `nameserver`                |
| `http` | URL                 | `method`, `timeout`, `expect_status`  |

The agent picks the job up on its next poll and posts the result back.

## 4. View the dashboard

Open <https://localhost:8443/> in a browser. The dashboard groups agents by
location/connection, shows recent check results, highlights failures in red,
and refreshes every 15 seconds — so a connectivity problem at a given site is
visible at a glance.

(The server uses a private CA; accept the browser certificate warning, or
import `certs/ca.crt` as a trusted authority.)

## 5. Smoke test

With the stack running:

```bash
./scripts/smoke_test.sh
```

It registers a test agent, pushes one job of each built-in type, polls for
results, and verifies the 404 (unknown agent) and 500 (malformed job) error
paths.

## Running locally without Docker

```bash
pip install -r requirements.txt
cp .env.example .env            # set DATABASE_URL to a reachable Postgres
set -a; . ./.env; set +a
python serve.py                 # mTLS server on $PORT
```

`gunicorn wsgi:app` is also supported when TLS is terminated by an external
proxy; `serve.py` is the all-in-one mTLS entry point.
