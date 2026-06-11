# High-availability deployment (Enterprise)

> Licence feature: **`ha_deployment`** (Enterprise+). The status/admin API
> (`/api/ha/*`) is gated by this key; running multiple replicas itself only
> needs `HA_ENABLED=true` on each node, but a valid Enterprise licence is what
> entitles the deployment.

BlueEye server is **stateless per request**: every authenticated call is
verified from the JWT (or an API token) and reads/writes only the shared MySQL
database. That makes it safe to run **several identical replicas behind a load
balancer** for redundancy and rolling upgrades. The only thing that must *not*
run on more than one node at a time is the **singleton background work**, and HA
mode coordinates exactly that.

## Topology

```
                       ┌──────────────────────────┐
        clients  ─────▶│   Load balancer / proxy  │  (round-robin / least-conn,
        + agents       │   TLS termination        │   sticky NOT required)
                       └────────────┬─────────────┘
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
       ┌────────────┐        ┌────────────┐        ┌────────────┐
       │ blueeye #1 │        │ blueeye #2 │        │ blueeye #3 │
       │  LEADER ★  │        │  follower  │        │  follower  │
       │ jobs: ON   │        │ jobs: OFF  │        │ jobs: OFF  │
       └──────┬─────┘        └──────┬─────┘        └──────┬─────┘
              └─────────────────────┼─────────────────────┘
                                    ▼
                       ┌──────────────────────────┐
                       │   MySQL (shared state)    │
                       │   + advisory leader lock  │
                       └──────────────────────────┘
```

* **All nodes** serve the HTTP API, the dashboard, the agent WebSocket
  (`/ws/agent`) and the dashboard WebSocket. Agents may connect to any node; the
  load balancer can send a reconnecting agent to a different node freely.
* **Exactly one node** is the **leader** and runs the singleton jobs. The others
  stand by and take over automatically if the leader disappears.
* **MySQL is the single source of truth.** Keep the database itself highly
  available with your standard tooling (InnoDB replication / Galera / managed
  HA) — that is outside the application's scope.

## What is coordinated (leader-only)

These jobs mutate shared state on a timer and must run on **one** node:

| Job | Module | Why it's singleton |
| --- | --- | --- |
| Retention rollup + purge | `src/analysis/retention/scheduler.js` | down-samples + deletes shared rows nightly; two runners would double the work |
| Test-package scheduler | `src/services/testPackageScheduler.js` | dispatches scheduled probe/traffic packages to agents; duplicate dispatch = duplicate load |
| GeoIP auto-update | `src/geo/geoipUpdater.js` | writes the shared GeoIP CSV on the data volume |

The leader starts them when it wins the lock and stops them the instant it loses
it; a promoted follower starts them on its next tick. See
`src/ha/coordinator.js`.

## What stays per-node (deliberately)

* **Request handling** — fully stateless; no in-process session store. JWTs are
  verified with the shared `JWT_SECRET`, so a token minted on one node is
  accepted by all. API tokens are validated against the shared `api_tokens`
  table. **Every replica must share the same `JWT_SECRET` / `SECRET_ENCRYPTION_KEY`.**
* **Licence validation** — each node validates the signed licence and resolves
  its plan independently, because every node must be able to answer "is this
  feature entitled?" for the requests it serves. The validation is read-only and
  idempotent (the licence cache file is local per node), so running it on every
  node is correct and cheap — it is *not* gated to the leader.
* **Agent WebSocket connections** — terminate on whichever node the agent
  connected to. Online/offline transitions and live counts are per node; the
  fleet view aggregates from the shared `results`/`probe_results` tables.

## How leadership works

Leader election uses MySQL's **session-scoped advisory lock**
(`src/ha/leaderLock.js`):

1. On each tick (default every `HA_INTERVAL_MS = 10000` ms) a follower runs
   `SELECT GET_LOCK('blueeye_leader', 0)`. Exactly one session gets `1`; it
   becomes leader and **holds a dedicated DB connection** for the lock's
   lifetime.
2. The leader re-confirms ownership each tick via `IS_USED_LOCK` /
   `CONNECTION_ID`. If its connection has dropped (DB restart, network blip) it
   demotes itself.
3. When the leader process stops — cleanly (`RELEASE_LOCK` on shutdown) or by
   crashing (the connection closes and MySQL frees the lock) — a follower wins
   the lock on its next tick. **Failover needs no orchestration** beyond MySQL.

Because the lock is tied to a live connection, there is never a "split brain":
two nodes cannot both hold `blueeye_leader` at the same time.

## Configuration

Set these on **every** replica (identical values except `HA_NODE_ID`):

| Env var | Default | Meaning |
| --- | --- | --- |
| `HA_ENABLED` | `false` | Turn HA on. Off ⇒ classic single node that runs every job itself. |
| `HA_NODE_ID` | `<hostname>:<pid>` | Stable identity in the cluster registry + logs. Set it to something readable (e.g. `blueeye-1`). |
| `HA_LOCK_NAME` | `blueeye_leader` | Advisory-lock name. All nodes of one cluster share it; distinct clusters on the same MySQL must differ. |
| `HA_INTERVAL_MS` | `10000` | How often a node contends/re-confirms leadership and heartbeats. |

Shared secrets that **must match** across nodes: `JWT_SECRET`,
`SECRET_ENCRYPTION_KEY` (falls back to `JWT_SECRET`), and the same `DB_*`
connection to the one shared database.

Run the migrations once (any node): `npm run migrate` creates the `ha_nodes`
cluster-registry table (migration `040`).

## Status & admin API (`/api/ha/*`, gated `ha_deployment`)

| Method & path | Role | Purpose |
| --- | --- | --- |
| `GET /api/ha/status` | viewer+ | This node's role (`leader`/`follower`), node id, host/pid, version, whether the singleton jobs are running. |
| `GET /api/ha/nodes` | viewer+ | Live cluster topology — one row per active replica from the `ha_nodes` registry (who, where, version, leader flag, last seen). |
| `POST /api/ha/step-down` | admin | The leader voluntarily releases the lock so a follower takes over (zero-downtime maintenance / draining a node before patching). `409` if HA is off or this node isn't the leader. |

All routes require an authenticated user **and** the `ha_deployment` licence
feature (otherwise `403 feature_not_available`).

## Rolling upgrade

1. Drain and upgrade the followers one at a time (the LB stops routing to a node
   while you restart it). They rejoin as followers.
2. `POST /api/ha/step-down` on the leader (or just restart it) — a freshly
   upgraded follower wins the lock and becomes leader.
3. Upgrade the former leader. Done — no maintenance window.

Keep all replicas on the **same version** during steady state; the dashboard's
**Settings → Updates** panel reads `package.json` `version`, and mixed versions
behind one LB can confuse the "update available" badge.
