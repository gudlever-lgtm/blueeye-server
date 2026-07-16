# Changelog

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
