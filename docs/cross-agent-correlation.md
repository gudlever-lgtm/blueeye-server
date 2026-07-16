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
  `incident_clusters` (migration 057). `create` / `listOpen` / `updateMembership` /
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

The advisory is stored in `incident_clusters.advisory` (migration 058, set once per
cluster, never regenerated on later sweeps) and **always surfaced with its evidence**:
the publish payload carries both `advisory` and an `evidence` array (one entry per
member finding — `findingId`, host, metric, severity, deviation, sample count), so
advice never travels without the underlying evidence list. Best-effort: the assistant
being off, a provider failure, or an "insufficient" answer simply leaves `advisory`
NULL and never affects the sweep. `low`-confidence clusters get no advisory.

## Cluster-level alerting (Step 3)

A cluster fires **one** alert (not one per member finding) through the **existing**
channels (email/webhook/syslog, and — via the integrations dispatcher — ITSM/CMDB),
gated the same way as the advisory (**medium/high** only). It must not duplicate the
alerts member findings already sent, so it **references** them instead of resending:

- **Durable alert-dispatch log** (`alert_dispatch_log`, migration 059, repo
  `src/repositories/alertDispatchLogRepository.js`). The dispatcher records every
  send: finding-level rows (`subject_type='finding'`) and cluster-level rows
  (`subject_type='cluster'`).
- **Fire once per cluster** — `dispatcher.dispatchCluster(cluster, group)` checks
  `alertLog.existsForCluster(id)` (awaited before returning) so a cluster alerts at
  most once **even across restarts** (the in-memory throttle wouldn't survive one).
- **Reference, don't resend** — the service calls `alertLog.listAlertedFindings(memberIds)`
  and passes the result as `group.alreadyAlerted`; the cluster alert names how many
  members were already notified individually. It never re-fires their alerts (it's a
  single new cluster alert). The alert carries the member evidence + the advisory.
- Channels format the cluster like a finding (email/webhook gained additive,
  backward-compatible fields for `memberFindingIds`/`alreadyAlerted`/`advisory` — the
  finding-level payload shape is unchanged). Cluster alerts bypass the per-(host,metric)
  throttle and the maintenance silencer (a cluster spans multiple hosts).

The dispatcher change is additive: `createDispatcher` gained an optional `alertLog`
(default null → no-op) and a `dispatchCluster` method; existing `dispatch` behaviour
is unchanged apart from the best-effort log write.

## UI push

Cluster events reuse the **existing** dashboard WebSocket (`/ws/dashboard`) — the
same channel findings use. The service's `publishCluster` is wired in `server.js`
to `dashboardWs.broadcast({ type: 'incident_cluster', payload })`, so no new socket
or auth path is introduced. Payloads carry `status: 'open' | 'resolved'`, and the
advisory follow-up carries `advisory` + `evidence`.

## Data model

`incident_clusters` (migration 057): `id`, `confidence` (enum low/medium/high),
`member_finding_ids` (JSON array of `findings.id`), `suspected_common_cause` (text,
nullable), `status`, `detected_at` (last activity), `resolved_at`, timestamps.
`member_finding_ids` is JSON (not a join table) to mirror how a finding's own
`correlated_with` links are stored — clusters are a lightweight derived read-model.

**Migration 060** adds the operator lifecycle: the `status` enum gains
`acknowledged` (`open` → `acknowledged` → `resolved`/`closed`), plus
`acknowledged_at`/`acknowledged_by`, `resolved_by` and `resolution_note`
(`*_by` → `users(id)`, `ON DELETE SET NULL`). Both `open` and `acknowledged` count
as **live** for dedup + auto-resolve.

## Operator lifecycle & REST API

The clustering engine creates/updates/auto-resolves clusters automatically; on top
of that, an operator can **acknowledge** and **resolve** a cluster.

`GET /api/incident-clusters` — list, newest activity first. Filters: `status`,
`from`/`to` (on `detected_at`), pagination `limit` (default 50, max 200) + `offset`;
returns `{ clusters, page: { limit, offset, total } }`. **viewer+**.

`GET /api/incident-clusters/:id` — the full cluster: hydrated **members** (each with
its evidence-sample count), **affected agents/targets**, a **confidence breakdown**
(which signals fired, their weights, the summed score vs the single-signal baseline —
`src/analysis/crossAgentCorrelator.js` `confidenceBreakdown`), a suspected
**root-cause layer** (`network-layer`/`application-layer`/`undetermined`, reusing the
L2 `isAppMetric`/`isNetMetric` classifiers from `investigation/locator.js`) and a
plain-language **evidence summary**. Pure assembly in `src/analysis/clusterView.js`.
**viewer+**.

`POST /api/incident-clusters/:id/ack` — `open` → `acknowledged` (**operator+**,
hash-chained audit via `auditLogger`). `409` if not `open`.

`POST /api/incident-clusters/:id/resolve` — requires a **free-text `note`** (`400`
without it), `open`/`acknowledged` → `resolved` stamping `resolved_by` + the note
(**operator+**, audited). `409` on a second resolve / lost race.

> The task specified `/api/incidents` for these, but that path is already the
> first-class `incident_cases` router (a distinct feature), so clusters mount at
> **`/api/incident-clusters`** with the same verbs/shapes.

Router `src/routes/incidentClusters.js`; repo methods `acknowledge`/`resolve`/`list`
(time-range + pagination)/`count` in `src/repositories/incidentClustersRepository.js`.

## Retention: never auto-close an unacknowledged CRIT

The auto-resolve sweep closes a live cluster after a configurable **quiet period**
(default **30 min** without a new member, `crossAgentClusterService` `inactivityMs`)
— **except** a cluster still holding an **unacknowledged CRIT** member finding, which
is kept open until a human acknowledges the CRIT (the existing retention rule). The
guard reads member severities via the finding store; a member that can't be read is
not treated as CRIT (a lookup failure never blocks resolution).

## Automated read-only evidence snapshot on cluster open (Fase 6)

When a cluster opens, BlueEye captures a **point-in-time, READ-ONLY** diagnostic
snapshot from each affected target — so an operator opening the incident sees "what
the network looked like when it fired" without SSHing anywhere. It reuses the
**existing** authenticated, cert-pinned, audited agent-command path
(`agentCommander.sendCommandAndWait` over `/ws/agent`) — no new transport.

### Read-only by contract (defense in depth)

`src/evidence/commandAllowlist.js` (`COMMAND_SET_VERSION = 'evidence-v1'`) is the
single source of truth for WHAT may be collected — every entry is `readOnly: true`:

| item | what |
| --- | --- |
| `iface.counters` | interface error/discard/utilisation counters |
| `arp.table` | ARP/MAC table extract for the affected segment |
| `snmp.reads` | allowlisted SNMP reads the collector already supports |
| `agent.state` | agent connection status + last collection timestamps |

There is **no** write/mutate item. The **agent enforces its own copy** of the
allowlist (`blueeye-agent` `src/evidenceCollector.js`) and hard-refuses anything not
on it **without invoking a collector** — so even a compromised or buggy server can't
make an agent act. The command is **Ed25519-signed** with the existing release key
(`releaseKeyService`) when configured; the agent verifies it and refuses a bad
signature.

### Bounded + best-effort

`src/evidence/snapshotService.js`: a hard per-target timeout (default **30s**), a
concurrency cap (default **4**), and a single **60s** retry for an offline agent
before recording `agent-offline`. Partial results are valid — each item's outcome
(`ok`/`timeout`/`refused`/`agent-offline`) is stored. Every path swallows its own
errors: the trigger is fire-and-forget from the clustering sweep and **never** blocks
clustering, alerting or the incident page.

### Evidence, not time series

One row per (cluster, target) in `cluster_evidence_snapshots` (migration 065) with a
**gzip blob** (`payload_gzip`) — not metric rows, and nothing in TimescaleDB.
`src/repositories/evidenceSnapshotsRepository.js` gzips on write / gunzips on read.
The incident timeline gains an **`evidence`** source (INFO when complete, WARN for
partial/offline/failed) linking to the raw-text viewer.

### API + retention

- `GET /api/incident-clusters/:id/evidence` (viewer+) — snapshots (metadata).
- `GET /api/incident-clusters/:id/evidence/:sid` (viewer+) — decompressed raw text
  (`text/plain`, no parsing/visualisation).
- `POST /api/incident-clusters/:id/evidence` (**operator+**) — manual re-snapshot,
  rate-limited (once/min → `429` + `Retry-After`), evidence-class audit-logged.

`src/evidence/evidenceRetention.js` ages out snapshots older than
`RETENTION_EVIDENCE_DAYS` (default **90**) on a 6h job — **except** those on a cluster
that still holds an **unacknowledged CRIT** finding (the same never-delete rule).
