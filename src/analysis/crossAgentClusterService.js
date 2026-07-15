'use strict';

const { createCrossAgentCorrelator, DEFAULT_WINDOW_MS } = require('./crossAgentCorrelator');
const { INCIDENT_INSUFFICIENT_ANSWER } = require('./assistant');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Medium/high clusters are the ones worth an AI advisory (and, later, an alert).
const ADVISORY_CONFIDENCE = new Set(['medium', 'high']);

// Orchestrates the cross-agent correlator against the live finding store: loads the
// recent findings across ALL agents, runs the detector, then persists each candidate
// as an `incident_clusters` row — DEDUPING against still-open clusters so a recurring
// pattern updates one cluster instead of spawning a new one every sweep. Also owns
// the inactivity-based resolution (mirrors incidentCases/autoResolveJob.js).
//
// Best-effort by contract: every method swallows its own errors so a failure here
// never affects ingestion or the scheduler.
//
//   const svc = createCrossAgentClusterService({
//     clustersRepo, findingStore, agentsRepo, publishCluster,
//   });
//   await svc.detectAndPersist();   // called by the sweep job (+ optionally on ingest)
//   await svc.resolveStale();       // called by the sweep job
function createCrossAgentClusterService({
  clustersRepo,
  findingStore,
  agentsRepo = null,
  // Opt-in AI assistant (nullable). When enabled and a cluster reaches medium/high
  // confidence, a cluster-level root-cause advisory is generated from the member
  // findings. Never surfaced without the member evidence.
  assistant = null,
  correlator = createCrossAgentCorrelator({ windowMs: DEFAULT_WINDOW_MS }),
  windowMs = DEFAULT_WINDOW_MS,
  // No new member finding within this window → the cluster is resolved (findings
  // carry no "cleared" event, so inactivity is the resolution proxy). Reuses the
  // incident auto-resolve default.
  inactivityMs = 15 * 60 * 1000,
  publishCluster = () => {},
  now = () => new Date(),
  logger = silentLogger,
}) {
  // hostId -> siteId (agents.location_id), or null. Built once per sweep from the
  // agent roster; a missing agent / null location is "no topology signal".
  async function buildSiteLookup() {
    const map = new Map();
    if (!agentsRepo || typeof agentsRepo.findAll !== 'function') return () => null;
    try {
      const agents = await agentsRepo.findAll();
      for (const a of Array.isArray(agents) ? agents : []) {
        map.set(String(a.id), a.location_id != null ? String(a.location_id) : null);
      }
    } catch (err) {
      logger.warn(`cross-agent: could not load agents for topology (${err.message})`);
    }
    return (hostId) => (map.has(String(hostId)) ? map.get(String(hostId)) : null);
  }

  // Finds an open cluster whose member set OVERLAPS the candidate's (shares >=1
  // finding id) — that is "the same finding set" for dedup purposes. Returns the
  // matching open cluster or null.
  function findOverlap(candidate, open) {
    const wanted = new Set(candidate.memberFindingIds);
    return open.find((c) => c.memberFindingIds.some((id) => wanted.has(id))) || null;
  }

  // Compact evidence reference for a member finding — surfaced ALONGSIDE the advisory
  // so advice never travels without its underlying evidence list (the member findings,
  // each carrying its own evidence samples).
  function evidenceRef(f) {
    return {
      findingId: f.id,
      host: f.hostId,
      metric: f.metric,
      severity: f.severity,
      deviation: f.deviation,
      samples: Array.isArray(f.evidence) ? f.evidence.length : 0,
    };
  }

  // Step 2: builds an opt-in cluster-level AI advisory (likely common root cause +
  // troubleshooting) from the member findings, stores it and publishes it WITH the
  // evidence list. Only for medium/high clusters that don't already carry advice,
  // only when the assistant is enabled. Best-effort — an assistant/provider failure
  // never affects the sweep, and an "insufficient context" / empty answer is never
  // surfaced as advice.
  async function maybeAdvise(clusterId, cluster, membersById, existingAdvisory) {
    if (existingAdvisory) return;                                   // already advised
    if (!ADVISORY_CONFIDENCE.has(cluster.confidence)) return;       // low = no advisory
    if (!assistant || typeof assistant.suggestClusterCause !== 'function') return;
    if (typeof assistant.isEnabled === 'function' && !assistant.isEnabled()) return; // opt-in
    const members = cluster.memberFindingIds.map((id) => membersById.get(id)).filter(Boolean);
    if (members.length === 0) return;                              // no evidence -> no advice

    let answer;
    try {
      const r = await assistant.suggestClusterCause(cluster, members);
      answer = r && typeof r.answer === 'string' ? r.answer.trim() : '';
    } catch (err) {
      logger.warn(`cross-agent: advisory generation failed (${err.message})`);
      return;
    }
    if (!answer || answer === INCIDENT_INSUFFICIENT_ANSWER) return; // never surface non-advice

    try {
      const ok = await clustersRepo.setAdvisory(clusterId, answer);
      if (ok) {
        publishCluster({
          id: clusterId,
          status: 'open',
          confidence: cluster.confidence,
          memberFindingIds: cluster.memberFindingIds,
          advisory: answer,
          evidence: members.map(evidenceRef),
        });
      }
    } catch (err) {
      logger.warn(`cross-agent: could not store advisory for cluster ${clusterId} (${err.message})`);
    }
  }

  // Runs one detection pass: load recent findings across all hosts, detect
  // candidate clusters, then create-or-update each (deduped). Returns a summary
  // { created, updated } for the caller/tests. Never throws.
  async function detectAndPersist() {
    const summary = { created: 0, updated: 0 };
    let recent = [];
    try {
      const since = new Date(now().getTime() - windowMs);
      recent = await findingStore.list(undefined, since); // all hosts within the window
    } catch (err) {
      logger.warn(`cross-agent: could not load recent findings (${err.message})`);
      return summary;
    }
    if (!Array.isArray(recent) || recent.length === 0) return summary;
    const membersById = new Map(recent.map((f) => [f.id, f]));

    const siteOf = await buildSiteLookup();
    let candidates = [];
    try {
      candidates = correlator.detect(recent, { siteOf });
    } catch (err) {
      logger.warn(`cross-agent: detector threw (${err.message})`);
      return summary;
    }
    if (candidates.length === 0) return summary;

    let open = [];
    try {
      open = await clustersRepo.listOpen();
    } catch (err) {
      logger.warn(`cross-agent: could not list open clusters (${err.message})`);
      open = [];
    }

    for (const candidate of candidates) {
      try {
        const existing = findOverlap(candidate, open);
        if (existing) {
          // Merge member sets (union) and re-evaluate; bump detected_at.
          const merged = [...new Set([...existing.memberFindingIds, ...candidate.memberFindingIds])];
          const ok = await clustersRepo.updateMembership(existing.id, {
            confidence: candidate.confidence,
            memberFindingIds: merged,
            suspectedCommonCause: candidate.suspectedCommonCause,
            detectedAt: candidate.detectedAt,
          });
          if (ok) {
            summary.updated += 1;
            existing.memberFindingIds = merged; // keep local view consistent for later candidates
            publishCluster({ ...candidate, id: existing.id, status: 'open', memberFindingIds: merged, updated: true });
            await maybeAdvise(existing.id, { ...candidate, memberFindingIds: merged }, membersById, existing.advisory);
          }
        } else {
          const id = await clustersRepo.create({
            confidence: candidate.confidence,
            memberFindingIds: candidate.memberFindingIds,
            suspectedCommonCause: candidate.suspectedCommonCause,
            status: 'open',
            detectedAt: candidate.detectedAt,
          });
          summary.created += 1;
          const created = { ...candidate, id, status: 'open' };
          open.push({ id, memberFindingIds: candidate.memberFindingIds, status: 'open' });
          publishCluster(created);
          await maybeAdvise(id, candidate, membersById, null);
        }
      } catch (err) {
        logger.warn(`cross-agent: could not persist cluster (${err.message})`);
      }
    }
    return summary;
  }

  // Resolves open clusters whose last activity (detected_at) is older than the
  // inactivity window — the members stopped recurring, so the pattern has cleared.
  // Returns the number resolved. Never throws.
  async function resolveStale() {
    const olderThan = new Date(now().getTime() - inactivityMs);
    let stale = [];
    try {
      stale = await clustersRepo.listStaleOpen(olderThan);
    } catch (err) {
      logger.warn(`cross-agent: could not list stale clusters (${err.message})`);
      return 0;
    }
    let resolved = 0;
    for (const c of stale) {
      try {
        const ok = await clustersRepo.updateStatus(c.id, { from: 'open', to: 'resolved', at: now() });
        if (!ok) continue; // lost a race
        resolved += 1;
        publishCluster({ id: c.id, status: 'resolved', confidence: c.confidence, memberFindingIds: c.memberFindingIds });
      } catch (err) {
        logger.warn(`cross-agent: could not resolve cluster ${c.id} (${err.message})`);
      }
    }
    if (resolved) logger.info(`cross-agent: resolved ${resolved} inactive cluster(s).`);
    return resolved;
  }

  return { detectAndPersist, resolveStale };
}

module.exports = { createCrossAgentClusterService };
