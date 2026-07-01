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
- The public key from step 1 (PEM or base64-of-PEM) — **for production, embed
  it in `src/license/publicKey.js`** (it's not secret, so committing it is
  fine). `LICENSE_PUBLIC_KEY` in `.env` also works, but is ignored in
  production unless `TRUST_ANCHOR_OVERRIDE_ACK` is set too — that env var is
  set by the same operator the license is meant to constrain, so relying on it
  in production would let them point verification at a key of their own. See
  `docs/licensing.md`.

```bash
#  CREATE DATABASE blueeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
npm run migrate               # seeds an admin
npm start                     # serves on :3000
```

On startup the server validates its licence against blueeye-licens and verifies
the signature offline. Check the **License** page in the dashboard
(`http://<server-host>:3000`) — it should read `valid`. If you renew the licence
later on the licens server, click **"Re-validate now"** to pick it up immediately
(otherwise it re-checks every 6 hours; a 14-day offline grace applies).

## 3. Agent (per customer machine / device)

In the **server dashboard** → **Agents** → **"+ New agent"** (operator/admin):
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
reports traffic on the interval. It appears under **Agents** with status/health
and "last reported".

### Traffic sources (vendor-neutral)

The agent reports which sources it supports; you assign one per agent in the
dashboard (**Agents → Edit → Traffic source**). The agent runs on a Linux
host/VM — it does **not** have to run on the network device.

- **`proc`** — local interface bytes from `/proc/net/dev`. For the *host's* own
  traffic. In Docker, use host networking
  ([docker-compose.host-agent.yml](docker-compose.host-agent.yml)).
- **`snmp`** — polls a device's interface counters over SNMP. Works against
  almost any vendor (Cisco, Juniper, Arista, HPE, MikroTik, Fortinet, …). Set
  the device host/community in the edit form. Interface-level totals only (no
  per-port).
- **`netflow`** — a built-in UDP collector for flow exports — **NetFlow v5, v9
  and IPFIX** — so you get **per-port / per-protocol** traffic and can search it.
  Vendor-neutral: NetFlow v5/v9 (Cisco), IPFIX (Juniper/Huawei, the IETF
  standard); the collector auto-detects the version (v9/IPFIX templates are
  learned from the exporter). Default UDP port 2055.
- **`sflow`** — a built-in UDP collector for **sFlow v5** sampled exports
  (Arista, HPE, and many switches). sFlow samples 1-in-N packets; the agent
  decodes each sampled header and scales by the sampling rate, producing the
  same per-port/per-protocol data you can search. Default UDP port 6343. Set a
  representative sampling rate on the device for good accuracy.

#### Enabling NetFlow

1. In the dashboard, set the agent's source to `netflow` (optionally a UDP port;
   default 2055).
2. On the **network device**, enable flow export to the agent's IP and that
   port. The collector auto-detects v5 / v9 / IPFIX. Example (Cisco IOS, classic
   NetFlow):
   ```
   ip flow-export version 9          ! or 5
   ip flow-export destination <agent-ip> 2055
   interface GigabitEthernet0/0
     ip flow ingress
     ip flow egress
   ```
   IPFIX (e.g. Cisco Flexible NetFlow / Juniper) exports work too. For v9/IPFIX
   the device periodically resends templates; flow data is decoded once a
   template has been seen.
3. The agent must be able to receive UDP on that port (host networking or an
   exposed UDP port if containerised).
4. Search in the dashboard: **Agents → Flows** → filter by port (e.g. `443`)
   and/or protocol (`tcp`/`udp`) over a time range. You can also query
   `GET /agents/:id/flows?port=443&protocol=tcp&from=&to=` directly.

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
