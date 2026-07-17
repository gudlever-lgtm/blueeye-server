'use strict';

const { buildIncidentTimeline } = require('./incidentTimeline');

// Orchestrates the incident-CLUSTER timeline: resolves the cluster, hydrates its
// member findings, derives the affected agents + incident onset, fans out to
// every source per agent, and merges via the pure buildIncidentTimeline.
//
// PARTIAL-FAILURE POLICY (mirrors targetTimelineService): the sources are
// independent. One failing must NOT blank the whole timeline — we fan out with
// Promise.allSettled, merge the sources that succeed, and report the ones that
// failed in `failedSources` with `partial: true`. A hard failure only happens
// resolving the cluster itself (→ the route decides 404 vs 500).
//
// Sources merged (per the requirement):
//   a. member findings (from the finding store, by id)
//   b. cluster lifecycle transitions (hash-chained audit_log, category incident)
//   c. playbook runs on affected agents
//   d. agent connect/disconnect/enrol events
//   e. config-change captures on affected agents

const AGENT_LIFECYCLE_ACTIONS = ['agent.online', 'agent.offline', 'agent.enrolled'];
const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;

function ms(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? Infinity : t;
}

// Numeric agent id when the string host id is a plain integer; otherwise the
// original value (MySQL coerces, and the fakes filter on the numeric form).
function toNum(id) {
  const n = Number(id);
  return Number.isInteger(n) ? n : id;
}

function createIncidentClusterTimelineService({
  clustersRepo,
  findingStore = null,
  auditEventsRepo = null,
  remediationPlaybooksRepo = null,
  incidentsRepo = null,
  configSnapshotsRepo = null,
  auditLogRepo = null,
  verificationRunsRepo = null,
  evidenceRepo = null,
} = {}) {
  // Member finding objects for the cluster, by id (in member order). Rejects on a
  // store failure so the caller can flag `findings` as a failed source.
  async function fetchMembers(memberFindingIds) {
    if (!findingStore || typeof findingStore.get !== 'function') return [];
    const out = [];
    for (const id of memberFindingIds || []) {
      const f = await findingStore.get(id); // eslint-disable-line no-await-in-loop
      if (f) out.push(f);
    }
    return out;
  }

  // --- per-agent source fetchers (each rejects on its own backend failure) ----
  //
  // Target-identity note (as in targetTimelineService): findings store host_id as
  // a STRING, but audit_events.actor_id, incidents.agent_id and
  // config_snapshots.device_id are NUMERIC. Each fetcher is handed the numeric
  // agent id where the column is numeric, and the string host id where it is not
  // (playbook runs join on the string host).

  async function fetchAgentEvents(agentId, { from, to, limit }) {
    if (!auditEventsRepo || typeof auditEventsRepo.findByActor !== 'function') return [];
    return auditEventsRepo.findByActor({
      actorType: 'agent', actorId: toNum(agentId), actions: AGENT_LIFECYCLE_ACTIONS, from, to, limit,
    });
  }

  async function fetchPlaybookRuns(agentId, { from, to, limit }) {
    if (!remediationPlaybooksRepo || typeof remediationPlaybooksRepo.listRunsForHost !== 'function') return [];
    return remediationPlaybooksRepo.listRunsForHost(String(agentId), { from, to, limit });
  }

  async function fetchIncidents(agentId, { from, to, limit }) {
    if (!incidentsRepo || typeof incidentsRepo.listForAgent !== 'function') return [];
    return incidentsRepo.listForAgent(toNum(agentId), { from, to, limit });
  }

  async function fetchConfigChanges(agentId, { from, to, limit }) {
    if (!configSnapshotsRepo || typeof configSnapshotsRepo.listForDeviceBetween !== 'function') return [];
    return configSnapshotsRepo.listForDeviceBetween(toNum(agentId), from, to, { limit });
  }

  // Cluster lifecycle transitions (ack/resolve, playbook_run …) from the
  // hash-chained audit_log. Verification outcomes are ALSO audit-logged there, but
  // they are surfaced via the dedicated 'verification' source (from
  // verification_runs, which carries the readings) — so they are filtered out here
  // to avoid showing each verification twice.
  async function fetchStatusChanges(clusterId) {
    if (!auditLogRepo || typeof auditLogRepo.listByTarget !== 'function') return [];
    const rows = await auditLogRepo.listByTarget({ category: 'incident', target: String(clusterId) });
    return (Array.isArray(rows) ? rows : []).filter((r) => !String(r.action || '').startsWith('verification_'));
  }

  // Post-remediation verification runs for the cluster (the 'verification' source).
  async function fetchVerifications(clusterId) {
    if (!verificationRunsRepo || typeof verificationRunsRepo.listForCluster !== 'function') return [];
    return verificationRunsRepo.listForCluster(clusterId);
  }

  // Evidence snapshots captured for the cluster (the 'evidence' source).
  async function fetchEvidence(clusterId) {
    if (!evidenceRepo || typeof evidenceRepo.listForCluster !== 'function') return [];
    return evidenceRepo.listForCluster(clusterId);
  }

  // Returns null if the cluster does not exist (→ 404); otherwise the merged
  // timeline + what-changed slice + partial-failure metadata.
  async function getTimeline(clusterId, { lookbackMinutes = 30, now = () => new Date() } = {}) {
    const cluster = await clustersRepo.findById(clusterId); // may throw → 500 in the route
    if (!cluster) return null;

    const lookbackMs = Number.isFinite(lookbackMinutes) && lookbackMinutes > 0
      ? lookbackMinutes * 60 * 1000 : DEFAULT_LOOKBACK_MS;
    const toDate = now();

    const failedSources = [];

    // a. member findings (also the source of affected agents + incident onset).
    let members = [];
    try {
      members = await fetchMembers(cluster.memberFindingIds);
    } catch {
      failedSources.push('findings');
      members = [];
    }

    // Incident onset = earliest member finding; fall back to the cluster's own
    // first-seen (created_at) then detected_at when members are unavailable.
    const memberTimes = members.map((f) => ms(f.createdAt)).filter((t) => Number.isFinite(t));
    const firstFindingMs = memberTimes.length ? Math.min(...memberTimes)
      : ms(cluster.createdAt ?? cluster.detectedAt);
    const firstFindingAt = Number.isFinite(firstFindingMs) ? new Date(firstFindingMs) : toDate;

    const fromDate = new Date(firstFindingAt.getTime() - lookbackMs);
    const window = { from: fromDate, to: toDate, limit: 1000 };

    const agentIds = [...new Set(members.map((f) => f.hostId).filter((h) => h != null).map(String))];

    // Fan out every (agent, source) fetch + the cluster status changes. Each
    // failure is isolated and recorded per source-name.
    const jobs = [];
    const perAgent = new Map(agentIds.map((id) => [id, { agentId: id, agentEvents: [], playbookRuns: [], incidents: [], configChanges: [] }]));
    const failedNames = new Set();

    for (const id of agentIds) {
      jobs.push(['agentEvents', id, fetchAgentEvents(id, window)]);
      jobs.push(['playbookRuns', id, fetchPlaybookRuns(id, window)]);
      jobs.push(['incidents', id, fetchIncidents(id, window)]);
      jobs.push(['configChanges', id, fetchConfigChanges(id, window)]);
    }
    let statusChanges = [];
    let verifications = [];
    let evidenceSnapshots = [];
    const statusJob = fetchStatusChanges(clusterId);
    const verifyJob = fetchVerifications(clusterId);
    const evidenceJob = fetchEvidence(clusterId);

    const settled = await Promise.allSettled(jobs.map(([, , p]) => p));
    settled.forEach((res, idx) => {
      const [name, agentId] = jobs[idx];
      if (res.status === 'fulfilled') {
        perAgent.get(agentId)[name] = Array.isArray(res.value) ? res.value : [];
      } else {
        failedNames.add(name);
      }
    });

    try {
      statusChanges = await statusJob;
      statusChanges = Array.isArray(statusChanges) ? statusChanges : [];
    } catch {
      failedNames.add('statusChanges');
    }
    try {
      verifications = await verifyJob;
      verifications = Array.isArray(verifications) ? verifications : [];
    } catch {
      failedNames.add('verifications');
    }
    try {
      evidenceSnapshots = await evidenceJob;
      evidenceSnapshots = Array.isArray(evidenceSnapshots) ? evidenceSnapshots : [];
    } catch {
      failedNames.add('evidence');
    }

    for (const n of failedNames) failedSources.push(n);

    const { events, whatChanged } = buildIncidentTimeline({
      memberFindings: members,
      agentSources: [...perAgent.values()],
      statusChanges,
      verifications,
      evidenceSnapshots,
      firstFindingAt,
      lookbackMs,
    });

    return {
      clusterId: cluster.id,
      window: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        firstFindingAt: firstFindingAt.toISOString(),
        lookbackMinutes: Math.round(lookbackMs / 60000),
      },
      affectedAgents: agentIds,
      events,
      whatChanged,
      partial: failedSources.length > 0,
      failedSources,
    };
  }

  return { getTimeline };
}

module.exports = { createIncidentClusterTimelineService, AGENT_LIFECYCLE_ACTIONS };
