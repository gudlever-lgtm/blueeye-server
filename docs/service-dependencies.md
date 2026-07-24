# Service dependency graph

A **service dependency graph** shows which monitored hosts depend on which — directed
edges `host → host : port` derived from observed **TCP** traffic. It is the second edge
type of the one **unified topology graph**:

| Edge type    | Source                         | Shape                          |
| ------------ | ------------------------------ | ------------------------------ |
| `l2_link`    | LLDP/CDP (`lldp_neighbors`, migration 063) | undirected agent ↔ agent (physical adjacency) |
| `service_dep`| TCP flows (`service_dependencies`, migration 066) | directed src → dst on a `dst_port` (service dependency) |

Both are merged by a single host-keyed model — `src/topology/graph.js`
(`buildTopologyGraph`) — served at `GET /api/topology/graph`. There is no parallel
graph structure.

## v1 scope

- **TCP only.** UDP/ICMP are ignored.
- **Both endpoints must be monitored hosts.** An endpoint resolves to a host only if its
  IP is a known agent's own address (`capabilities.ips`) or an SNMP-monitored device's
  address (`monitor_config.snmp.host`). Edges with either endpoint unresolved are
  **dropped**, never stored.
- **Aggregated over a rolling 24h window** by `(src_host_id, dst_host_id, dst_port)` with
  `bytes`, `packets`, `conn_count` (flow count as the connection-count proxy),
  `first_seen`, `last_seen`.
- **Top-N edges per source host** by byte volume (`SERVICE_DEP_TOP_N`, default 50).
- **No** process-level attribution. **No** automatic service naming/classification.

## How it works

1. **Agents report** the raw material over the existing report path (no new endpoint):
   - the sFlow/NetFlow collector emits a capped per-5-tuple `traffic.flows` list carrying
     `proto` + `dstPort` (already decoded from sampled headers) — this populates
     `flow_records.proto` / `dst_port`, which were previously NULL;
   - each agent reports its own interface IPs as `capabilities.ips`, so the server can
     resolve a flow IP back to the host it belongs to.
   Both are additive and backward-compatible (an older server ignores them and keeps
   using `topTalkers`; a newer server falls back to `topTalkers` when `flows` is absent).
2. **A scheduled job** (`src/topology/serviceDependencyJob.js`, a leader-only singleton in
   `server.js` `backgroundJobs`, default every `SERVICE_DEP_JOB_INTERVAL_MINUTES` = 10)
   runs **off the ingest hot path**. Each run:
   - builds the IP→host resolver from the agent inventory (`hostResolver.js`);
   - reads TCP flow aggregates over the window (`flowsRepository.tcpServiceFlows`);
   - aggregates to host↔host edges, drops unknown/self, truncates Top-N per source host
     (`serviceDependencyAggregator.js`, pure);
   - upserts the edges and ages out any not seen within the window.
3. **The API** exposes the result (all viewer+ except the write path):
   - `GET /api/topology/dependencies` — Top-N edges fleet-wide, or `?host=<agentId>` for
     one host (`?direction=in|out|both`, `?limit`). 404 when the host is unknown.
   - `GET /api/topology/graph` — the unified graph with both edge types.
   - `POST /api/topology/dependencies/recompute` — force a recompute now (operator+).

## Storage tier

`service_dependencies` lives in **MySQL**, like `lldp_neighbors`: it is a mutable, keyed,
current-state graph-edge table maintained by upsert + age-out — not append-only
telemetry — and its natural UNIQUE key `(src_host_id, dst_host_id, dst_port)` excludes
time, which a TimescaleDB hypertable cannot enforce. It *reads from* `flow_records` but
its own shape is relational. See `docs/storage-split-audit.md`.

## Configuration

| Env var                            | Default | Meaning                              |
| ---------------------------------- | ------- | ------------------------------------ |
| `SERVICE_DEP_WINDOW_HOURS`         | 24      | rolling aggregation window           |
| `SERVICE_DEP_TOP_N`                | 50      | edges kept per source host           |
| `SERVICE_DEP_JOB_INTERVAL_MINUTES` | 10      | how often the recompute job runs     |
