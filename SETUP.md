# BlueEye setup — agent → server → licens

How the three pieces fit together, and how to set them up. For the one-host
Docker demo see [DEPLOY.md](DEPLOY.md); this document explains the **flow** and a
**production** layout.

```
   ┌────────────┐   1. validate (signed proof)    ┌──────────────┐
   │ blueeye-   │ ──────────────────────────────▶ │ blueeye-     │
   │ server     │ ◀────────────────────────────── │ licens       │
   │ (on-prem)  │      signed Ed25519 proof        │ (central)    │
   └────────────┘                                  └──────────────┘
        ▲  ▲
        │  │ 2. enroll (one-time code) → opaque token
        │  │ 3. WebSocket (live) + POST /agents/results (traffic)
   ┌────┴──┴────┐
   │ blueeye-   │   (one per customer machine / device)
   │ agent      │
   └────────────┘
```

- **blueeye-licens** (central, you host it): issues customers + licenses and
  signs license validations. One instance for all customers.
- **blueeye-server** (on-prem, one per customer): manages agents, locations,
  users and traffic; validates its own licence against blueeye-licens.
- **blueeye-agent** (on each customer machine/device): enrolls with the server,
  then reports network traffic.

Two independent trust boundaries:
- **Server ↔ licens:** an Ed25519-signed proof, verified offline. The licence
  server never sees agent tokens.
- **Agent ↔ server:** an opaque per-agent token (not a JWT), issued at
  enrollment and validated locally by the server.

---

## 1. License server (central) — one-time

```bash
cd blueeye-licens
npm install
cp .env.example .env          # set DB_*, JWT_SECRET, SEED_ADMIN_*

# Generate the signing key pair (once):
node scripts/generate-signing-key.js
```

The script prints two things:
- `LICENSE_SIGNING_KEY=<base64>` — the **private** key. Put it in the license
  server's `.env`. **Never commit it.**
- A **public** key (PEM) — not secret. You embed it in blueeye-server (step 2).

Then create the database, migrate (seeds an admin) and start:

```bash
#  CREATE DATABASE blueeye_licens CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
npm run migrate
npm start                     # serves on :4000
```

In the **licens dashboard** (`http://<licens-host>:4000`): create a **customer**,
then a **license** for that customer (set `max_agents`, optional expiry). Copy
the **license key** shown next to the customer — the customer enters it on their
server in step 2.

## 2. On-prem server (per customer)

```bash
cd blueeye-server
npm install
cp .env.example .env
```

Edit `.env`:
- `DB_*`, `JWT_SECRET`, `SEED_ADMIN_*` — as usual.
- `LICENSE_KEY` — the key issued in step 1.
- `LICENSE_SERVER_ID` — a stable id for this server (bound to the licence on
  first validation; afterwards the proof must match it).
- `LICENSE_SERVER_URL` — the licens server, e.g. `http://<licens-host>:4000`.
- `LICENSE_PUBLIC_KEY` — the public key from step 1 (PEM or base64-of-PEM).
  Alternatively embed it in `src/license/publicKey.js`.

```bash
#  CREATE DATABASE blueeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
npm run migrate               # seeds an admin
npm start                     # serves on :3000
```

On startup the server validates its licence against blueeye-licens and verifies
the signature offline. Check the **License** page in the dashboard
(`http://<server-host>:3000`) — it should read `valid`. If you renew the licence
later on the licens server, click **"Genvalidér nu"** to pick it up immediately
(otherwise it re-checks every 6 hours; a 14-day offline grace applies).

## 3. Agent (per customer machine / device)

In the **server dashboard** → **Agenter** → **"+ Ny agent"** (operator/admin):
this mints a one-time **enrollment code** and shows a ready-to-paste env snippet.

On the customer machine:

```bash
cd blueeye-agent
npm install
cp config.example.json blueeye-agent.config.json
```

Configure (env or the JSON file):
- `BLUEEYE_SERVER_URL` — the on-prem server, e.g. `http://<server-host>:3000`.
- `BLUEEYE_ENROLLMENT_CODE` — the one-time code from the dashboard.
- `BLUEEYE_REPORT_INTERVAL_MS` — how often to report traffic (default 60000).

```bash
npm start
```

First start: the agent collects hostname/platform/arch, enrolls with the code,
stores an opaque token (0600), and clears the code. It then opens a WebSocket and
reports traffic on the interval. It appears under **Agenter** with status/health
and "senest rapporteret".

### Where the agent runs (traffic source)

- **On a Linux host / VM:** measures the host's interfaces from `/proc/net/dev`.
  In Docker, run with host networking to see the host's traffic — see
  [docker-compose.host-agent.yml](docker-compose.host-agent.yml).
- **On a Cisco device (or any host without `/proc`):** use the **SNMP** source.
  In the dashboard → **Agenter** → **Rediger**, set the traffic source to `snmp`
  with the device host/community. The agent reports its capabilities
  (`proc`/`snmp`), and the server assigns the source per agent.

---

## Roles (both server and licens)

- **admin** — everything, including user administration.
- **operator** — create/edit resources (agents/locations/enrollment on the
  server; customers/licenses on licens).
- **viewer** — read-only.

The last admin can't be demoted or deleted, so you can't lock yourself out.

## Production notes

- Run each piece behind TLS (a reverse proxy); the URLs above use plain HTTP for
  brevity.
- Keep `LICENSE_SIGNING_KEY` only on the licens server; the public key is what
  goes to each on-prem server.
- Set strong `JWT_SECRET`s and admin passwords — the servers refuse to start in
  production with the default JWT secret.
- The agent normally runs on customer machines, not in the server's compose.
- For the turnkey one-host demo (auto-generated keys + demo seeds), use
  [DEPLOY.md](DEPLOY.md).
