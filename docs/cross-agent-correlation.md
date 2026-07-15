# Cross-agent pattern correlation (incident clusters)

BlueEye's per-target correlator (`src/analysis/correlator.js`) links findings
**within one agent** to hint a root cause. The cross-agent correlator groups
findings across **different agents** that fire in the same time window into a
single **incident cluster** with a suspected common cause and a confidence tier —
so a fault hitting several agents at once surfaces as ONE incident, not N
look-alike findings.

Local + explainable, like the rest of the analysis stack: time clustering + a
weighted signal score, no ML, every cluster carries a plain-language cause hint.

## Matching signals & confidence

Weighted signals, in the spirit of the L2-loop-style confidence in
`investigation/locator.js`:

| Signal | Meaning |
| --- | --- |
| **Time** | findings from **≥2 distinct agents** within `windowMs` (default 5 min) |
| **Topology** | those agents share a **site** (`agents.location_id`) |
| **Type** | ≥2 members share the same finding-type (`metric`) |

| Signals present | Confidence |
| --- | --- |
| time only | **low** |
| time + topology | **medium** |
| time + topology + same type | **high** |

A **same-type-but-different-site** cluster stays **low**: medium/high require the
topology signal.

### Topology = shared site only (documented gap)

Signal 2 uses a **shared site** (`agents.location_id`) — the only cross-agent
adjacency BlueEye has today. **Subnet / VLAN / LLDP-neighbour adjacency does not
exist**: agents don't report it and there's no schema for it. A missing/`null`
site is treated as "no topology signal" — never faked. Adding subnet/VLAN/LLDP
would require agent-side collection (a `blueeye-agent` change + redeploy) plus a
schema/repository addition; until then this is a known gap, not a bug.

## Modules

- **`src/analysis/crossAgentCorrelator.js`** — pure detector. `detect(findings,
  { siteOf })` → candidate clusters (`{ memberFindingIds, hostIds, confidence,
  signals, site, commonType, severity, detectedAt, suspectedCommonCause }`). No I/O.
  Fixed-anchor time buckets across all hosts; within each bucket it peels off, in
  decreasing confidence: per-site groups (≥2 agents) → topology clusters, then
  per-metric groups → type-only clusters, then a time-only leftover.
- **`src/repositories/incidentClustersRepository.js`** — data access for
  `incident_clusters` (migration 056). `create` / `listOpen` / `updateMembership` /
  `updateStatus` (guarded) / `listStaleOpen` / `list`.
- **`src/analysis/crossAgentClusterService.js`** — orchestration + policy.
  `detectAndPersist()` loads recent findings across ALL agents
  (`findingStore.list(undefined, since)`), builds `siteOf` from the agent roster,
  runs the detector, then **dedups**: a candidate that overlaps an open cluster
  (shares ≥1 member finding) **updates** that cluster (union members, re-evaluate
  confidence, bump `detected_at`) instead of spawning a new one. `resolveStale()`
  closes open clusters gone inactive. Best-effort — never throws.
- **`src/analysis/crossAgentClusterJob.js`** — leader-only sweep (`{ runOnce, start,
  stop }`, ~60 s) wired into `server.js`'s `backgroundJobs`. Each tick runs a
  detection pass then a resolution pass. Detection lives in the sweep (not the
  ingest hot path) so it stays off the per-report critical path and still catches
  findings from **both** the traffic and probe pipelines.

## Dedup & resolution

- **Dedup**: an open cluster whose member set overlaps a fresh candidate is
  updated (member union, re-evaluated confidence/cause, advanced `detected_at`), so
  a recurring pattern never spawns duplicate clusters.
- **Resolution**: findings carry no explicit "cleared" event, so resolution is
  **inactivity-based** (mirrors `incidentCases/autoResolveJob.js`): an open cluster
  whose `detected_at` is older than the inactivity window (default 15 min, i.e. no
  member finding refreshed it) is flipped `open → resolved`.

## Cluster-level AI advisory (opt-in — Step 2)

When a cluster reaches **medium/high** confidence **and** the opt-in assistant is
enabled (Settings → AI), the service builds a prompt from the cluster's **member
findings** (not a single finding) and asks for a likely **common root cause +
troubleshooting steps** — `assistant.suggestClusterCause(cluster, members)` in
`src/analysis/assistant.js`, a NEW method that reuses the existing OpenAI-compatible
`chat()` (Mistral by default). Same guarantees as the other assistant calls: IPs are
masked before anything leaves the process, it uses ONLY the provided context, and it
pins the exact insufficient-context string (which the service treats as "no advice").

The advisory is stored in `incident_clusters.advisory` (migration 057, set once per
cluster, never regenerated on later sweeps) and **always surfaced with its evidence**:
the publish payload carries both `advisory` and an `evidence` array (one entry per
member finding — `findingId`, host, metric, severity, deviation, sample count), so
advice never travels without the underlying evidence list. Best-effort: the assistant
being off, a provider failure, or an "insufficient" answer simply leaves `advisory`
NULL and never affects the sweep. `low`-confidence clusters get no advisory.

## UI push

Cluster events reuse the **existing** dashboard WebSocket (`/ws/dashboard`) — the
same channel findings use. The service's `publishCluster` is wired in `server.js`
to `dashboardWs.broadcast({ type: 'incident_cluster', payload })`, so no new socket
or auth path is introduced. Payloads carry `status: 'open' | 'resolved'`, and the
advisory follow-up carries `advisory` + `evidence`.

## Data model

`incident_clusters` (migration 056): `id`, `confidence` (enum low/medium/high),
`member_finding_ids` (JSON array of `findings.id`), `suspected_common_cause` (text,
nullable), `status` (open/resolved/closed), `detected_at` (last activity),
`resolved_at`, timestamps. `member_finding_ids` is JSON (not a join table) to mirror
how a finding's own `correlated_with` links are stored — clusters are a lightweight
derived read-model.

## Not yet wired (later phases)

- **Cluster-level alerting** (Step 3) — fire once per cluster through the existing
  channels, referencing (not resending) alerts already sent for member findings.
- A read API / dashboard view over `incident_clusters`.
