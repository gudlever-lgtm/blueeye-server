# Changelog

## 0.82.0 — LLDP neighbor graph for incident clustering

Adds a minimal, queryable L2 topology so cross-agent clustering can group findings
by neighbor adjacency when no shared-site (manual) topology applies.

**Audit note:** the brief assumed BlueEye already collects LLDP as part of "L2 loop
detection" — it does **not** (no L2 loop detection, no SNMP/BRIDGE-MIB/LLDP
collection exists; `locator.js`'s "neighbor" means neighbor *agents*). And Fase 1's
topology signal is **shared-site** (`location_id`), not a manual dependency graph.
So this phase persists LLDP data arriving on the **existing agent report path**
(no new SNMP polling) and wires it in as a topology fallback.

### Persistence
- Migration **063** `lldp_neighbors` (`local_agent_id`, `local_chassis_id`,
  `local_port`, `remote_chassis_id`, `remote_port`, `last_seen`) + repository:
  upsert (bumps `last_seen`), batch upsert, age-out (default 24h, configurable),
  list/count. Ingested from a `capabilities.lldp` list in the agent's existing
  `POST /agents/me/capabilities` report — no new polling.

### Graph service
- Pure agent-projected graph (`src/topology/lldpGraph.js`): `adjacent` / `within-N
  hops` / `unknown`, via direct links (remote chassis = another agent's chassis)
  and shared segments (two agents on one switch). Partial coverage → partial graph;
  a pair with no path is **unknown, never "unrelated"**.
- TTL-cached service (`lldpGraphService.js`): rebuilds ≤ once/min (ageing out stale
  rows first), exposes a **sync** `relation()` for the clustering hot path.

### Fase 1 integration
- The correlator gains an LLDP topology pass **between** the site pass and the
  type pass, so **manual/site ALWAYS wins** (it consumes its findings first),
  LLDP fills the remainder, and anything else stays unknown. A cluster now records
  `topologySource` (`site`/`lldp`) and the evidence/`suspected_common_cause` names
  it ("LLDP: sw-03 adjacent to sw-04"). Wired via a background refresh/age-out job.

### API
- `GET /api/topology/neighbors` — viewer+, filter by `target` (both directions),
  pagination; 400/401/404/clean-500.

### Tests
- Graph queries (adjacent / 2-hop / unknown / partial coverage); upsert + age-out +
  TTL refresh; resolution order (site wins over LLDP); clustering integration
  (two LLDP-adjacent agents at different sites with different finding-types →
  clustered via LLDP, evidence names the source); ingest via the capabilities path;
  API 400/401/404/500.

## 0.81.0 — Recommended actions + post-remediation verification loop

Completes "not who's to blame, but what to do": a static finding-type → runbook
bridge on the incident (Situation) page, explicit operator-run playbooks, and a
verification cycle that re-checks whether the symptoms actually cleared. Queries +
UI; no new AI/ML (the Mistral advisory stays opt-in garnish).

**Audit note:** the phase brief assumed an existing playbook execution path with
retry/backoff, a `remediating` state, and playbook-success logging — none of which
existed (migration 055 explicitly deferred execution; `recordRun` was never
called; the state machine excludes playbook transitions). This phase builds the
minimal execution + verification path faithful to that schema's intent.

### Runbooks (static mapping first)
- Migration **061** `runbooks` (finding_type → title + markdown body + optional
  `linked_playbook_id`). Admin CRUD API `/api/runbooks` (+ `/playbooks` for the
  link editor); reads viewer+, writes admin. UI: **Settings → Runbooks**.

### Recommended actions on the incident page
- `GET /api/incident-clusters/:id/recommended-actions` — runbooks matching the
  cluster's dominant finding-types (rendered markdown), plus the cluster AI
  advisory **only when the assistant is enabled** (clearly AI-labelled).
- `POST /api/incident-clusters/:id/run-playbook` — operator+, confirm dialog,
  hash-chained audit, uses the run-recording execution model and **schedules a
  verification**. No auto-execution from clustering; existing auto-trigger rules
  untouched. 409 on a resolved cluster.
- Frontend: a "Recommended actions" panel (with a safe, dependency-free markdown
  renderer) + AI advisory directly below, on the Situation page.

### Verification loop
- Migration **062** `verification_runs`. After a playbook runs, a leader-only
  sweep (`verificationJob`) waits the configurable settle time (**Settings →
  Analysis → verify settle**, default 5 min) then re-checks the affected targets
  for fresh, unacknowledged findings of the relevant types:
  cleared → **passed** (suggest resolution, never auto-resolve); persists →
  **failed** with the current readings (cluster stays open). Every outcome is
  hash-chained-audited and surfaced on the cluster timeline as a new
  **`verification`** source.

### Tests
- Runbook CRUD (happy/400/401/403/404/clean-500); recommended-actions (match /
  no-match / advisory gated by Mistral) + run-playbook (202/400/403/404/409);
  verification (cleared, persisting-with-readings, settle-time respected,
  acked-ignored, error, no-reprocess, timeline emission, never auto-resolves);
  frontend jsdom (panel render, viewer vs operator, empty state, fetch-failure
  isolation, advisory placement, markdown-injection safety).

## 0.80.0 — Incident Situation View (timeline + what-changed + evidence)

One page per cross-agent situation (cluster) that answers, under pressure, what is
happening, where, since when, what changed right before, and what the evidence
says — "ét fælles billede". Queries + UI only; no new AI/ML. Builds on the Fase-1
cluster API and reuses the existing timeline, badge and advisory patterns.

### Backend
- **`GET /api/incident-clusters/:id/timeline`** — one chronologically merged event
  stream for the cluster's affected agents, from `first_seen − lookback` (default
  30 min, `?lookback=<minutes>`) to now, merging: member findings, cluster
  lifecycle transitions, playbook runs, agent connect/disconnect/enrol, and
  config-change captures. Each event carries `{ timestamp, source, target,
  severity, summary, ref_id }`. A separate **`whatChanged`** slice flags the
  sources-c–e events in the pre-incident window. viewer+; 400 on bad lookback,
  404 unknown cluster, clean 500; partial-failure tolerant (`partial` +
  `failedSources`, never a blank timeline).
- Pure merge `src/timeline/incidentTimeline.js` (reuses the per-target mappers,
  adds `target` + config/state-change sources) + fan-out
  `src/timeline/incidentTimelineService.js`. New windowed
  `configSnapshotsRepository.listForDeviceBetween`.

### Frontend
- **Situations** list (`views.clusters`) + per-situation page (`views.cluster`),
  cloning the incident list/detail patterns. Panels: header
  (status/confidence/root-cause/agents + RBAC-aware ack/resolve), a prominent
  **"What changed"** panel (explicit "no recorded changes" when empty — absence is
  diagnostic), an **Evidence** panel (Fase-1 confidence breakdown in plain
  language), the **merged timeline** (filterable by source, severity-coloured,
  rows deep-link to the affected device), and an optional AI advisory block
  (rendered read-only from the cluster; an independent failure domain — never
  breaks the page). Reuses `TimelineView`; page assembly + panels live in the pure,
  jsdom-tested `public/clusterView.js` (`window.ClusterView`). New nav entry +
  `PAGE_INFO.clusters` + a `type:'incident_cluster'` branch on the dashboard WS.

### Tests
- Backend: timeline merge ordering, lookback boundary, what-changed separation,
  400/401/404/partial/clean-500.
- Frontend (jsdom): full-data render, empty timeline, advisory disabled, advisory
  failing (page still renders), timeline failing, RBAC actions, source filter.
- Installed the declared `jsdom` devDependency so the DOM render tests (and the
  pre-existing `timelineView` suite) run.

## 0.79.1 — Cross-agent incident clusters: operator API + lifecycle

Builds the operator-facing surface on top of the existing cross-agent clustering
engine (detector + dedup/auto-resolve + AI advisory + alerting already shipped in
0.7x). No parallel correlation system — this reuses the engine as-is.

### Added
- **REST API** `/api/incident-clusters` (`src/routes/incidentClusters.js`):
  - `GET /` — list with `status` + `from`/`to` filters and `limit`/`offset`
    pagination (viewer+).
  - `GET /:id` — full cluster: hydrated member findings + evidence, affected
    agents/targets, a weighted **confidence breakdown** (signals + score vs the
    single-signal baseline), a suspected **root-cause layer**
    (network-/application-layer/undetermined, reusing the L2
    `isAppMetric`/`isNetMetric` classifiers) and a plain-language evidence
    summary (viewer+).
  - `POST /:id/ack` — acknowledge (operator+, hash-chained audit).
  - `POST /:id/resolve` — resolve with a **required free-text note** (operator+,
    audited).
- Pure read-model assembly `src/analysis/clusterView.js` and a
  `confidenceBreakdown` helper on `crossAgentCorrelator`.
- Migration **060** — `incident_clusters` gains the `acknowledged` status plus
  `acknowledged_at`/`acknowledged_by`, `resolved_by`, `resolution_note`.

### Changed
- Auto-resolve now **never closes a cluster that still holds an unacknowledged
  CRIT member finding** (existing retention rule), and the default quiet period is
  **30 min** (was 15). `open` and `acknowledged` both count as live for
  dedup/auto-resolve.
- `incidentClustersRepository` gains `acknowledge`/`resolve`/`count` and
  time-range + pagination on `list`.

### Tests
- API tests (happy path, 400/401/403/404/409, clean 500), pure unit tests for the
  confidence breakdown + root-cause classification + detail assembly, and a
  simulation test (10 agents, one shared finding-type within 3 min → exactly one
  cluster with all 10 members, confidence above the single-signal baseline).
