# Cross-Agent Pattern Correlation — Step 0 Audit

**Status: AUDIT ONLY — no code changed, no migrations run, nothing pushed.**
Produced for the "BlueEye — Cross-Agent Pattern Correlation" task, Step 0.

> Naming note: the task said "Produce REFACTOR-AUDIT.md", but a `REFACTOR-AUDIT.md`
> already exists in the repo root — it is an **unrelated** prior security/RBAC/refactor
> audit (in Danish). I did not overwrite it; this audit lives in its own file so the
> earlier work is preserved.

---

## TL;DR / decisions needed before Step 1

1. **Finding shape & store** — well-defined, immutable event rows keyed on `host_id`
   (= agent id). No "resolved/cleared" state exists on a finding (only `acked`). This
   directly affects Step 1's **resolution** requirement (see §1, §5).
2. **Existing correlator** — pure, in-memory, **per-host** greedy time-clustering with a
   metric→metric dependency graph. Persists links back onto each finding's
   `correlated_with` JSON; it does **not** create a cluster entity. A parallel
   **incident_cases** grouping already exists (also per-device). Cross-agent module must
   mirror this style, not fork it (see §2).
3. **Topology proximity (Step 1, signal 2)** — ⚠️ **STOP-AND-REPORT TRIGGER FIRES.**
   Subnet / VLAN / LLDP-adjacency data **does not exist** in the server or in what agents
   report today. The **only** real cross-agent proximity signal that exists is a shared
   **site** (`agents.location_id`). Recommendation: use shared-site as signal 2 (honest,
   already present) and record subnet/VLAN/LLDP as an explicit gap — **do not fake a
   topology source.** Needs your approval on which way to go (see §3).
4. **WebSocket push** — findings are broadcast fleet-wide over `/ws/dashboard` via
   `publishFinding(hostId, {type:'finding', payload})`. Cluster events can reuse the exact
   same channel with a new `type` (e.g. `incident_cluster`) — no new socket (see §4).
5. **Alert dedup (Step 3)** — the dispatcher only keeps an **in-memory** throttle map; it
   has no persistent "which finding-level alerts were already sent" record. Referencing
   already-sent member alerts is possible by listing member finding ids, but a *clean*
   cross-process reference does not exist today — flagged as a Step 3 risk (see §6).

---

## 1. Exact shape of a "finding" today

### Public object shape
Produced by `src/analysis/detector.js`, mapped for reads in `src/analysis/findings.js`
(`mapRow`):

```js
{
  id:            string,          // crypto.randomUUID() (or detector-supplied)
  hostId:        <agent id>,      // DB column host_id — this IS the agent/target key
  metric:        string,          // e.g. "cpu", "interface_errors", "probe.loss", "aspath"
  severity:      "INFO"|"WARN"|"CRIT",
  kind:          "ANOMALY"|"THRESHOLD"|"FLATLINE"|"CORRELATED",  // constants.js
  observed:      number|null,
  baseline:      number|null,
  deviation:     number|null,     // MAD-robust z-score
  window:        [from, to],      // window_from / window_to
  explanation:   string,          // REQUIRED non-empty (save() throws otherwise)
  evidence:      Sample[],        // REQUIRED >= 1 (save() throws otherwise); JSON, each has ts
  correlatedWith:string[],        // ids of co-clustered findings (per-host correlator)
  incidentCaseId:number|null,     // migration 048 FK → incident_cases
  createdAt:     Date,
  acked:         boolean,
}
```

### Persistence
- Table `findings` (migration `009_*`; `048_add_incident_case_to_findings.sql` added the
  nullable `incident_case_id` FK, `ON DELETE SET NULL`).
- Store: `src/analysis/findings.js` → class `FindingStore({ db })` (uses the shared
  `db.pool`, not a new connection). Methods:
  - `save(finding)` — **validates**: `explanation` non-empty string **and** `evidence`
    length ≥ 1, else throws. This is the "every finding carries explanation + evidence"
    invariant — the cross-agent advisory (Step 2) must honour the same rule at cluster level.
  - `list(hostId, since, limit)` — newest-first, capped at `MAX_LIST=5000`. `hostId`
    optional; **omitting it lists across ALL hosts** (this is exactly what a cross-agent
    detector needs).
  - `listByIncidentCase(id)`, `get(id)`, `ack(id)`, `setCorrelations(id, ids)`,
    `setIncidentCase(id, caseId)`.
- **No mutable lifecycle**: a finding is an append-only event row. The only state you can
  change is `acked` (operator ack) and its correlation/incident linkage. There is **no
  `resolved`/`cleared` flag and no "finding cleared" event** anywhere. Consequence for
  Step 1 resolution: "when member findings clear/resolve" has to be *derived*
  (inactivity-based, or off the member findings' `incident_case` status), because findings
  never emit a clear. See §5.

### How the correlator reads/writes findings today
In `src/analysis/pipeline.js` → `correlateAndPersist(produced)`:
- reads `findingStore.list(hostId, since)` for each produced host (`since = now −
  correlationWindowMs`), merges with the freshly-produced batch;
- calls `correlator.correlate(pool, windowMs)`;
- writes links back via `findingStore.setCorrelations(f.id, f.correlatedWith)`.
- Everything is **best-effort** — wrapped so a failure never affects ingestion.

---

## 2. How the existing correlator groups findings within one target

Module: `src/analysis/correlator.js` → `createCorrelator({ graph }).correlate(findings, windowMs)`.

- **Grouping key = host.** Findings are bucketed into a `Map` keyed on
  `f.hostId` (`'∅'` when null). **Grouping never crosses hosts** — this is the exact gap
  the task addresses.
- **Data structure**: per host, sort by time, then **greedy time-clustering**: a cluster
  keeps an `anchor` = time of its first member; each next finding within `windowMs` of the
  anchor joins, otherwise the cluster flushes and a new one starts. A cluster spans at most
  `windowMs` from its earliest member (`DEFAULT_WINDOW_MS = 60000`).
- **Root-cause pick** (`pickLikelyCause`): uses a **configurable** metric→effects graph
  (`src/analysis/dependency-graph.json`, loaded via `loadDefaultGraph`, cycle-safe
  `indexGraph`). The "root" is any cluster member that nothing else in the cluster is
  upstream of; ties broken by earliest time. Graph is the primary signal, time the
  fallback.
- **Output**: `[{ findings, likelyCause, hint }]`; and it **mutates** each member's
  `correlatedWith` with the ids of the other members. The clusters themselves are **not a
  persisted entity** — only the per-finding `correlated_with` JSON survives.
- **Confidence-scoring style to mirror**: the task says "same style as L2 loop confidence
  scoring". The closest existing weighted-signal → confidence model is
  `src/investigation/locator.js` (discrete weights `0.3 / 0.5 / 0.6 / 0.7 / 0.75` chosen by
  which signals are present). The cross-agent detector should follow that shape: additive
  weighted signals → a `low|medium|high` tier, matching the task's mapping
  (time→low, time+topology→medium, time+topology+type→high).

### A second, parallel grouper already exists — do NOT add a third pattern
`src/incidentCases/incidentCaseService.js` (`assignFinding`) groups findings into the
persisted **`incident_cases`** entity — but still **per device** (`findOpenByHost(host)`),
within the same 60 s window (reuses `DEFAULT_WINDOW_MS`). It:
- opens/extends an incident per host, escalates severity, advances `last_event_at`;
- links the finding via `findingStore.setIncidentCase`;
- is resolved by the **leader-only** `src/incidentCases/autoResolveJob.js` (inactivity →
  `investigating→resolved`).

**The cross-agent cluster module is the *same idea one level up* (across hosts).** The
cleanest fit is: a **pure detector** in `src/analysis/` (mirroring `correlator.js`) + a
thin **service + repository** (mirroring `incidentCaseService.js` /
`incidentCasesRepository.js`) + a **leader-only resolve job** (mirroring
`autoResolveJob.js`). No new architectural pattern.

---

## 3. Cross-agent topology metadata — what exists, what's missing

### What EXISTS today
| Signal | Where | Cross-agent usable? |
|---|---|---|
| **Shared site** `agents.location_id` (nullable FK → `locations`, indexed `idx_agents_location_id`) | `migrations/003`, `schema.sql`; `agentsRepository.js` | **YES** — first-class, cheap join. Two agents with the same non-null `location_id` are co-located. This is the one honest topology-proximity signal available now. |
| Location coordinates `locations.latitude/longitude` (manually set, nullable) | `agentsRepository.findForGeo` | Weakly — geo distance, but manual & often null. |
| Flow-derived dependency map (`flowsRepository.topologyEdges` + `analysis/topology.js buildTopology`) | `docs/topology.md` | **NO (not reliably).** It's a who-talks-to-whom graph of **IPs** from `flow_records`. `docs/topology.md` explicitly states "the graph doesn't tie each internal IP to a site" — there is no IP→agent mapping, so it can't say "agent A and agent B share a subnet/link." |
| `agents.capabilities` (JSON, agent-reported: NIC/driver/firmware) | `schema.sql`, `nicInventory.js` | NO subnet/VLAN/LLDP inside it. |
| `agents.meta` (JSON, operator free-form) | `agentsRepository` | Unstructured; nothing guarantees subnet/VLAN/LLDP. |
| `dependency-graph.json` | `analysis/correlator.js` | It is **metric→metric**, not agent→agent. Not a network topology. |

### What is MISSING (the Step 1 signal-2 gap)
- **No subnet / CIDR** field on agents (or anywhere queryable).
- **No VLAN id** anywhere.
- **No LLDP neighbour / link-adjacency** data. Agents do **not** report LLDP today
  (`grep` for `lldp|vlan|subnet|neighbor|adjacen` across `src/` finds only flow-topology,
  path-graph, and `privateIp` helpers — none is agent-to-agent link adjacency).
- Populating any of these would require **blueeye-agent changes** (new collection + report
  fields → agent redeploy) plus a server schema migration and repository — out of scope for
  a "small diffs" server-only change, and explicitly the kind of thing the task says not to
  fake.

### ⚠️ Stop-and-report (per the task's explicit trigger)
> "If topology/adjacency data needed for Step 1 signal 2 doesn't exist → stop, report what's
> missing, do not invent a fake topology source."

**Subnet/VLAN/LLDP adjacency does not exist.** I am not going to invent it.

**Recommended path (needs your OK):** implement signal 2 as **shared-site proximity**
(`agents.location_id` equal & non-null). It is real, already present, requires no agent
change, and is a legitimate "these agents are near each other in the network" signal.
The cluster record will note *which* proximity signal fired (`site`), and subnet/VLAN/LLDP
will be documented as a future enhancement gated on agent-side reporting. Confidence tiers
would then read: time-only → low; time + same-site → medium; time + same-site + same
finding-type → high.

Alternative if you'd rather not use site: ship Step 1 with time + finding-type only, and
mark topology proximity as "unavailable" — but then no cluster ever reaches **medium** via
topology, only via type similarity. I recommend the shared-site approach.

---

## 4. WebSocket push for findings (reuse target for cluster events)

- Server: `src/ws/dashboardSocket.js` → `attachDashboardWebSocket({ server, verifyToken,
  path:'/ws/dashboard' })` returns `{ wss, broadcast, close, connectionCount }`.
  - Auth: the **user JWT** verified during the HTTP upgrade handshake (invalid token → 401,
    no socket). Push-only to browsers; history still read over REST.
  - `broadcast(message)` sends `message` to **every** connected dashboard.
- Wiring: `src/server.js` passes
  `publishFinding: (hostId, message) => dashboardWs ? dashboardWs.broadcast(message) : 0`
  into both `createAnalysisPipeline` and `createProbePipeline`. The **`hostId` argument is
  ignored** — every finding is a fleet-wide broadcast. (`notifyDashboard` at server.js:380
  is the same `broadcast`, reused elsewhere.)
- Emit format today: `publishFinding(finding.hostId, { type: 'finding', payload: finding })`
  (pipeline.js).

**Reuse plan for cluster events:** broadcast on the **same** `dashboardWs.broadcast` with a
new discriminator, e.g. `{ type: 'incident_cluster', payload: cluster }` (and/or
`incident_cluster_resolved`). The browser already holds one `/ws/dashboard` socket and
switches on `message.type`, so no new channel, no new auth path, no new server. The
detector/service just needs the same injected `publishFinding` (or a `publishCluster`
alias bound to the same `broadcast`).

---

## 5. Insertion points & the resolution problem (for Step 1 planning)

**Where the detector runs.** `createAnalysisPipeline.processResults(hostId, payloads)`
(pipeline.js) already runs, per ingest batch, in this order: save findings → publish →
`incidentCaseService.assignFinding` (per-host) → `correlateAndPersist` (per-host) →
alerting → integrations. A cross-agent pass fits **after `correlateAndPersist`**, but note
it must pull **recent findings across all hosts** (`findingStore.list(undefined, since)`),
not just the produced hosts. It is triggered by whichever agent's report arrived — that's
fine; dedup (Step 1) makes re-evaluation idempotent.

**Repository/service/job patterns to mirror** (so the new `incident_clusters` matches house
style):
- Repo → `src/repositories/incidentCasesRepository.js` (`create` / `findOpenByHost` /
  `updateActivity` / `updateStatus` guarded-transition / `list` / `listStaleInvestigating`).
- Service → `src/incidentCases/incidentCaseService.js` (best-effort `assignFinding`,
  window-based grouping, dedup into an existing open row).
- Migration → numbered `migrations/056_*.sql` (next free number; latest is `055`), tracked
  in `schema_migrations`; add the table to `schema.sql`. Columns per task: `id`,
  `confidence`, `member_finding_ids` (JSON), `suspected_common_cause` (text, nullable),
  `status` default `'open'`, `detected_at` (+ house-style `created_at`, and likely
  `updated_at`/`last_event_at` to support inactivity resolve).
- Resolve job → `src/incidentCases/autoResolveJob.js` + registration in the
  `backgroundJobs` array (server.js:557) so it runs leader-only on one node.
- Fakes → add an `incident_clusters` repo fake to `test-support/fakes.js` (every repo has a
  fake there).

**The resolution wrinkle (call it out now).** Step 1 says "when member findings
clear/resolve, close the cluster." But findings have **no clear event** (§1). Two viable
resolution definitions, both honest:
- (a) **Inactivity** — close the cluster when no member/related finding has recurred within
  an inactivity window (direct mirror of `autoResolveJob`). Simple, self-contained.
- (b) **Via incident_cases** — close the cluster when all member findings'
  `incident_case`s are `resolved/closed`. More "truthful" but couples the cluster to the
  incident-case lifecycle.
Recommendation: (a) inactivity-based auto-resolve as the primary mechanism (matches the
existing pattern and needs no new finding lifecycle), optionally reinforced by (b). Needs a
one-line confirmation in Step 1 sign-off.

---

## 6. Alerting integration (Step 3) — dedup feasibility check

- Path today: `pipeline.dispatchAlerts` → `dispatcher.dispatch(finding, group)`
  (`src/analysis/alerting/dispatcher.js`). Channels receive `(finding, group)`; e.g.
  `webhook.js` serialises `group: { likelyCause, hint }`. Channels: email / webhook /
  syslog (+ ITSM/CMDB via the separate `integrationsDispatcher.emitFinding`, and
  ISE/ServiceNow/Nautobot via connectors).
- **Throttle/dedup is in-memory only**: `lastSent` Map keyed
  `hostId|metric|kind|severity`, compared against `config.cooldownMs`. There is **no
  persistent record of which finding-level alerts were sent** and no alert-history table.
- Consequence for "cluster-level alert must not duplicate alerts already sent for member
  findings, reference them instead": we **can** build a cluster alert payload that lists
  member finding ids (and reuse the `group` shape channels already understand), and fire it
  **once per cluster** (throttle keyed on cluster id). But a *guaranteed* cross-process
  "these member alerts already went out" reference doesn't exist — after a restart the
  in-memory `lastSent` is empty. This is the Step 3 **stop-and-report risk**: if "cleanly
  reference already-sent finding-level alerts" must be durable, we'd need a small
  alert-audit record. I'll surface options at Step 3 rather than silently changing the
  dispatcher's contract. The existing `dispatch(finding, group)` signature is
  **backward-compatible** for adding a cluster alert (a cluster can be passed as a
  finding-shaped object + group), so **no breaking change to Step 2's Mistral prompt
  interface or the dispatcher is required** for the happy path.

---

## 7. Proposed module layout for Step 1 (for approval — not yet built)

```
migrations/056_create_incident_clusters.sql   # id, confidence, member_finding_ids JSON,
                                              # suspected_common_cause TEXT NULL,
                                              # status DEFAULT 'open', detected_at, timestamps
schema.sql                                    # + incident_clusters snapshot
src/analysis/crossAgentCorrelator.js          # PURE detector, mirrors correlator.js:
                                              #   weighted signals → {members, confidence,
                                              #   commonType, proximity, cause-hint}
src/repositories/incidentClustersRepository.js# mirrors incidentCasesRepository.js
src/analysis/crossAgentClusterService.js      # (or src/incidentCases/…) best-effort
                                              #   detect+dedup+persist+publish, like
                                              #   incidentCaseService.js
src/analysis/crossAgentResolveJob.js          # leader-only inactivity resolve, mirrors
                                              #   autoResolveJob.js; added to backgroundJobs
wiring in src/server.js + src/analysis/pipeline.js  # run after correlateAndPersist;
                                              #   reuse publishFinding broadcast
test-support/fakes.js                         # + incident_clusters repo fake
test/… + src/**/__tests__                     # unit tests per task's list
docs/cross-agent-correlation.md               # feature doc (house convention)
CODEMAP.md + package.json version bump         # per CLAUDE.md conventions
```

Confidence mapping (weighted, locator.js style):
`time proximity (≥2 distinct agents in window)` = base → **low**;
`+ shared site` → **medium**; `+ same finding-type/metric-class` → **high**.

---

## Open questions to confirm before I write Step 1 code
1. **Signal 2 = shared site (`location_id`)?** (Recommended.) Or defer topology entirely
   and mark it unavailable? (Subnet/VLAN/LLDP genuinely don't exist — won't be faked.)
2. **Resolution = inactivity auto-resolve** (mirror `autoResolveJob`), primary mechanism? OK?
3. Confirm the file is fine named `CROSS-AGENT-CORRELATION-AUDIT.md` (existing
   `REFACTOR-AUDIT.md` is unrelated prior work and was left intact).

*Awaiting approval before Step 1 — no code, migrations, or pushes yet.*
</content>
</invoke>
