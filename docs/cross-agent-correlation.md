# Cross-agent pattern correlation (event clusters)

BlueEyes' per-target correlator (`src/analysis/correlator.js`) links findings
**within one agent** to hint a root cause. The cross-agent correlator groups
findings across **different agents** that fire in the same time window into a
single **event cluster** with a suspected common cause and a confidence tier —
so a fault hitting several agents at once surfaces as ONE event, not N
look-alike findings.

Local + explainable, like the rest of the analysis stack: pairwise relations with
a named reason, no ML, every cluster carries a plain-language cause hint AND the
list of reasons it was grouped on.

## What a finding is about (its subject)

Grouping used to be "same 5-minute bucket, then same site". That merged two
independent faults on one site into one situation, and left the same target
failing from two sites as a weak `low` cluster. Grouping is now **target-aware**:
every finding has a **subject** — `subjectOf()` in `src/analysis/crossAgentCorrelator.js`
— read from the finding's own columns and its first evidence sample:

| Finding | Subject key |
| --- | --- |
| `probe.*`, `probe_outage.*` | `target:<host>` — the probe target, normalised (a URL → its hostname, `host:port` → host, lower-case). A **private** address or single-label name (`10.0.0.1`, `printer`) only means one machine within one site, so it is scoped: `target:site:<id>@10.0.0.1` (or `agent:<id>@…` without a site) |
| `transaction.*` | `transaction:<testId>` |
| `device.new` | `mac:<mac>` |
| `l2.loop` (a switch) | `device:<deviceId>` |
| `if.<port>.*` (counters, link down/flapping, duplex) | `port:<deviceId>/<interfaceId>` |
| anything else (`agent.offline`, cpu, …) | `agent:<hostId>:<condition>` — the agent itself |

## Relations, reasons & confidence

Two findings within `windowMs` (default 5 min) **of each other** are related when,
in this order:

| Reason | When |
| --- | --- |
| **target** | same subject — the same target seen by several agents, **whatever their sites** |
| **switch** | both are about the same switch (two ports, or a port and the loop on it) |
| **upstream** | one is about a switch, the other comes from an agent the blast-radius graph (`src/topology/blastRadius.js`, LLDP + switch neighbours) puts downstream of it |
| **site** | both are about the **agents themselves**, share a site (`agents.location_id`) and report the same condition — N agents at one site going dark together |
| **lldp** | their agents are adjacent in the LLDP neighbour graph (`lldp_neighbors`, mig 063) |
| condition *(weak)* | agent-level findings, same condition, different/unknown sites |

Anything else stays **apart**: two unrelated subjects on one site are two
situations. The site relates agent-level findings only — the site *is* an
agent's place in the topology, whereas the place of a probe target is unknown,
so two different targets failing at one site are not related by the site alone.
A cluster is a connected component of these relations spanning **≥2 distinct
agents**.

| Relations present | Confidence |
| --- | --- |
| target / switch / upstream / site / lldp **and** ≥2 agents share a condition | **high** |
| target / switch / upstream / lldp, mixed conditions | **medium** |
| weak same-condition only | **low** |

"Condition" is the metric with a switch-port id folded out (`if.12.link.down` and
`if.40.link.down` are both `if.link.down`).

**Time: a sliding window, not buckets.** A relation needs the two findings within
`windowMs` of each other, and a cluster is the connected component — anchored on its
earliest member (`firstSeenAt`) and sliding forward (`detectedAt`) while related
findings keep arriving. A fault straddling a bucket boundary is no longer split in
two. The sweep reads **two** windows of findings, so a pair up to one window apart is
always seen together even though the sweep runs only every ~60 s.

**Why, stored.** Each cluster stores its `grouping_basis` (migration 130):
`{ subjects, reasons: [{ kind, detail, agents }], why: [...] }`. The suspected cause
ends with "Grouped because: …", the detail API's `evidenceSummary.drivers` and
`confidenceBreakdown.explanation` name the reasons, and the Changes feed summarises a
situation by them. Clusters stored before 130 have none and are explained from their
tier, as before.

## Modules

- **`src/analysis/crossAgentCorrelator.js`** — pure detector. `detect(findings,
  { siteOf, topology })` → candidate clusters (`{ memberFindingIds, hostIds,
  confidence, signals, site, topologySource, topologyDetail, commonType, grouping,
  severity, firstSeenAt, detectedAt, suspectedCommonCause }`). No I/O. `topology`
  carries `related(a, b)` (LLDP) and `downstreamOf(deviceId)` (blast radius), both
  optional. `subjectOf()` is exported for anything else that needs "what is this
  finding about".
- **`src/repositories/eventClustersRepository.js`** — data access for
  `event_clusters` (migration 057). `create` / `listOpen` / `updateMembership` /
  `updateStatus` (guarded) / `listStaleOpen` / `list`.
- **`src/analysis/crossAgentClusterService.js`** — orchestration + policy.
  `detectAndPersist()` loads recent findings across ALL agents
  (`findingStore.list(undefined, since)`), builds `siteOf` from the agent roster,
  runs the detector, then **dedups**: a candidate that overlaps an open cluster
  (shares ≥1 member finding) — or, for a recurring fault whose earlier members
  have scrolled out of the window, names the same target/port/switch/transaction
  subject in its stored grouping basis — **updates** that cluster (union members
  and reasons, re-evaluate confidence, bump `detected_at`) instead of spawning a
  new one. It then stamps the cluster onto the **event cases** of its member
  findings (`event_cases.cluster_id`, migration 129 — see `docs/event-cases.md`).
  `resolveStale()` closes open clusters gone inactive. Best-effort — never throws.
- **`src/analysis/crossAgentClusterJob.js`** — leader-only sweep (`{ runOnce, start,
  stop }`, ~60 s) wired into `server.js`'s `backgroundJobs`. Each tick runs a
  detection pass then a resolution pass. Detection lives in the sweep (not the
  ingest hot path) so it stays off the per-report critical path and still catches
  findings from **both** the traffic and probe pipelines.

## Dedup & resolution

- **Dedup**: an open cluster whose member set overlaps a fresh candidate — or
  whose stored subjects include one of the candidate's target/port/switch/
  transaction subjects — is updated (member union, merged grouping basis,
  re-evaluated confidence/cause, advanced `detected_at`), so a recurring pattern
  never spawns duplicate clusters.
- **Resolution**: findings carry no explicit "cleared" event, so resolution is
  **inactivity-based** (mirrors `eventCases/autoResolveJob.js`): an open cluster
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

The advisory is stored in `event_clusters.advisory` (migration 058, set once per
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
to `dashboardWs.broadcast({ type: 'event_cluster', payload })`, so no new socket
or auth path is introduced. Payloads carry `status: 'open' | 'resolved'`, and the
advisory follow-up carries `advisory` + `evidence`.

## Data model

`event_clusters` (migration 057): `id`, `confidence` (enum low/medium/high),
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

`GET /api/event-clusters` — list, newest activity first. Filters: `status`,
`from`/`to` (on `detected_at`), pagination `limit` (default 50, max 200) + `offset`;
returns `{ clusters, page: { limit, offset, total } }`. **viewer+**.

`GET /api/event-clusters/:id` — the full cluster: hydrated **members** (each with
its evidence-sample count), **affected agents/targets**, a **confidence breakdown**
(which signals fired, their weights, the summed score vs the single-signal baseline —
`src/analysis/crossAgentCorrelator.js` `confidenceBreakdown`), a suspected
**root-cause layer** (`network-layer`/`application-layer`/`undetermined`, reusing the
L2 `isAppMetric`/`isNetMetric` classifiers from `investigation/locator.js`) and a
plain-language **evidence summary** (naming the stored grouping reasons), the
stored `groupingBasis`, and **`eventCases`** — the event cases linked to the
situation (migration 129), listed on the Situation page with a link to each.
Pure assembly in `src/analysis/clusterView.js`. **viewer+**.

`POST /api/event-clusters/:id/ack` — `open` → `acknowledged` (**operator+**,
hash-chained audit via `auditLogger`). `409` if not `open`.

`POST /api/event-clusters/:id/resolve` — requires a **free-text `note`** (`400`
without it), `open`/`acknowledged` → `resolved` stamping `resolved_by` + the note
(**operator+**, audited). `409` on a second resolve / lost race.

> The task specified `/api/events` for these, but that path is already the
> first-class `event_cases` router (a distinct feature), so clusters mount at
> **`/api/event-clusters`** with the same verbs/shapes.

Router `src/routes/eventClusters.js`; repo methods `acknowledge`/`resolve`/`list`
(time-range + pagination)/`count` in `src/repositories/eventClustersRepository.js`.

## Retention: never auto-close an unacknowledged CRIT

The auto-resolve sweep closes a live cluster after a configurable **quiet period**
(default **30 min** without a new member, `crossAgentClusterService` `inactivityMs`)
— **except** a cluster still holding an **unacknowledged CRIT** member finding, which
is kept open until a human acknowledges the CRIT (the existing retention rule). The
guard reads member severities via the finding store; a member that can't be read is
not treated as CRIT (a lookup failure never blocks resolution).

**Logging.** The sweep ticks every 60 s and a held cluster stays held until someone
acknowledges its CRIT, so the count — not the individual clusters — is the news. One
INFO line reports how many are held, and only when that number **moves**
(`N inactive cluster(s) kept open — unacknowledged CRIT member.`, and one line when
it reaches zero). The per-cluster detail is still written at **debug** level, so
`LOG_LEVEL=debug` names them. A fleet holding 70 clusters used to print a line per
cluster per sweep — ~100 000 INFO lines a day, which buried every other log line and
filled the dashboard's Logs view.

## Automated read-only evidence snapshot on cluster open (Fase 6)

When a cluster opens, BlueEyes captures a **point-in-time, READ-ONLY** diagnostic
snapshot from each affected target — so an operator opening the event sees "what
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
clustering, alerting or the event page.

### Evidence, not time series

One row per (cluster, target) in `cluster_evidence_snapshots` (migration 065) with a
**gzip blob** (`payload_gzip`) — not metric rows, and nothing in TimescaleDB.
`src/repositories/evidenceSnapshotsRepository.js` gzips on write / gunzips on read.
The event timeline gains an **`evidence`** source (INFO when complete, WARN for
partial/offline/failed) linking to the raw-text viewer.

### API + retention

- `GET /api/event-clusters/:id/evidence` (viewer+) — snapshots (metadata).
- `GET /api/event-clusters/:id/evidence/:sid` (viewer+) — decompressed raw text
  (`text/plain`, no parsing/visualisation).
- `POST /api/event-clusters/:id/evidence` (**operator+**) — manual re-snapshot,
  rate-limited (once/min → `429` + `Retry-After`), evidence-class audit-logged.

`src/evidence/evidenceRetention.js` ages out snapshots older than
`RETENTION_EVIDENCE_DAYS` (default **90**) on a 6h job — **except** those on a cluster
that still holds an **unacknowledged CRIT** finding (the same never-delete rule).
