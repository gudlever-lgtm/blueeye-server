'use strict';

const { createCrossAgentCorrelator, DEFAULT_WINDOW_MS } = require('./crossAgentCorrelator');
const { EVENT_INSUFFICIENT_ANSWER } = require('./assistant');
const { computeBlastRadius } = require('../topology/blastRadius');
const { deviceNode } = require('../topology/nodeId');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Medium/high clusters are the ones worth an AI advisory (and, later, an alert).
const ADVISORY_CONFIDENCE = new Set(['medium', 'high']);

// Orchestrates the cross-agent correlator against the live finding store: loads the
// recent findings across ALL agents, runs the detector, then persists each candidate
// as an `event_clusters` row — DEDUPING against still-open clusters so a recurring
// pattern updates one cluster instead of spawning a new one every sweep. Also owns
// the inactivity-based resolution (mirrors eventCases/autoResolveJob.js).
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
  // Opt-in alerting: the shared alerting dispatcher + the durable alert log. When a
  // cluster reaches medium/high, ONE cluster-level alert fires through the existing
  // channels, referencing (not resending) member findings already alerted.
  alertDispatcher = null,
  alertLog = null,
  // Opt-in LLDP neighbor graph (nullable). When present, it is the topology signal
  // for findings NOT already grouped by shared site — manual/site ALWAYS wins.
  topologyGraph = null,
  // Fase 5: cluster notification orchestrator (rollup alerting + ITSM + NIS2 +
  // suppression). When present it OWNS medium/high cluster notification; low
  // clusters keep per-finding alerting (nothing to roll up). Nullable → legacy
  // single cluster-alert via maybeAlert.
  notifier = null,
  // Opt-in "upstream" topology: the blast-radius service (unified LLDP +
  // switch graph). When a finding is about a switch, the agents it cuts off are
  // downstream of it, and their findings in the same window join its
  // situation. Nullable → no upstream relation.
  blastRadiusService = null,
  // How long one read of the blast-radius graph is reused across sweeps.
  // graph() is six full-table reads (devices, links, LLDP, agents, ...) and the
  // sweep runs about once a minute whenever a device finding is in the window;
  // switch topology does not change on that scale, and a link that does change
  // is picked up within this TTL. 0 → read every sweep.
  graphTtlMs = 5 * 60 * 1000,
  // Opt-in event-case link (migration 129): the event cases of a cluster's
  // member findings are stamped with the cluster, so a case says which
  // situation it is part of and its auto-resolve waits for the situation.
  eventCasesRepo = null,
  // Fase 6: read-only evidence snapshot engine. On cluster-open it captures a
  // diagnostic snapshot from each affected target (best-effort, fire-and-forget —
  // a slow/offline agent NEVER delays clustering). Nullable → no capture.
  snapshotService = null,
  correlator = createCrossAgentCorrelator({ windowMs: DEFAULT_WINDOW_MS }),
  windowMs = DEFAULT_WINDOW_MS,
  // No new member finding within this window → the cluster is resolved (findings
  // carry no "cleared" event, so inactivity is the resolution proxy). Default is
  // the 30-min quiet period; configurable.
  inactivityMs = 30 * 60 * 1000,
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

  // The blast-radius graph, cached for graphTtlMs (see above). A failed read
  // is not cached, so the next sweep tries again.
  let graphCache = null; // { graph, at }
  async function upstreamGraph() {
    const t = now().getTime();
    if (graphCache && graphTtlMs > 0 && t - graphCache.at < graphTtlMs) return graphCache.graph;
    const graph = await blastRadiusService.graph();
    graphCache = { graph, at: t };
    return graph;
  }

  // Builds the topology resolver for a sweep: the LLDP graph (refreshed at most
  // once per TTL) as a sync `related(a, b)`, and — when findings in the window
  // are about a switch — the agents downstream of each such switch from ONE
  // read of the blast-radius graph. Returns null when neither is wired, so the
  // correlator relates on subject + site only.
  async function buildTopologyResolver(recent) {
    const out = {};
    if (topologyGraph && typeof topologyGraph.relation === 'function') {
      try {
        if (typeof topologyGraph.ensureFresh === 'function') await topologyGraph.ensureFresh();
      } catch (err) {
        logger.warn(`cross-agent: LLDP graph refresh failed (${err.message})`);
      }
      out.related = (a, b) => topologyGraph.relation(a, b);
    }
    const deviceIds = [...new Set(recent.map((f) => f.deviceId).filter((d) => d != null).map(Number))];
    if (deviceIds.length && blastRadiusService && typeof blastRadiusService.graph === 'function') {
      const downstream = new Map();
      try {
        const g = await upstreamGraph();
        for (const id of deviceIds) {
          const r = computeBlastRadius(g, deviceNode(id), { maxDepth: blastRadiusService.maxDepth });
          // Agents only: a switch cut off by a switch is not an agent's finding.
          const agents = [...r.directly_isolated, ...r.dependency_affected]
            .map((x) => x.hostId).filter((h) => typeof h === 'number' || /^\d+$/.test(String(h))).map(String);
          downstream.set(id, new Set(agents));
        }
      } catch (err) {
        logger.warn(`cross-agent: upstream graph unavailable (${err.message})`);
      }
      out.downstreamOf = (id) => downstream.get(Number(id)) || null;
    }
    return Object.keys(out).length ? out : null;
  }

  // Finds the open cluster a candidate continues: one whose member set
  // OVERLAPS the candidate's (shares >=1 finding id), or — for a recurring
  // fault whose earlier members have scrolled out of the detection window —
  // one that is about the SAME subject (a stored grouping basis names it).
  // Agent-level subjects never match on their own: "cpu on agent 3" recurring
  // is only the same situation while it still shares findings. Returns the
  // matching open cluster or null.
  const SUBJECT_MATCH = /^(target|mac|port|device|transaction):/;
  function findOverlap(candidate, open) {
    const wanted = new Set(candidate.memberFindingIds);
    const byId = open.find((c) => c.memberFindingIds.some((id) => wanted.has(id)));
    if (byId) return byId;
    const subjects = new Set(((candidate.grouping && candidate.grouping.subjects) || []).filter((k) => SUBJECT_MATCH.test(k)));
    if (!subjects.size) return null;
    return open.find((c) => c.groupingBasis && (c.groupingBasis.subjects || []).some((k) => subjects.has(k))) || null;
  }

  // The union of a stored grouping basis and a fresh candidate's: every
  // subject and every reason either one named, de-duplicated.
  function mergeGrouping(stored, fresh) {
    if (!fresh) return stored || null;
    if (!stored) return fresh;
    const reasons = [];
    const seen = new Set();
    for (const r of [...(stored.reasons || []), ...(fresh.reasons || [])]) {
      const k = `${r.kind}|${r.detail}`;
      if (seen.has(k)) continue;
      seen.add(k);
      reasons.push(r);
    }
    return {
      subjects: [...new Set([...(stored.subjects || []), ...(fresh.subjects || [])])],
      reasons,
      why: [...new Set([...(stored.why || []), ...(fresh.why || [])])],
    };
  }

  // Stamps the cluster on the event cases of its member findings (migration
  // 129). Best-effort: a failed link costs the "part of situation" label, never
  // the cluster.
  async function linkCases(clusterId, memberFindingIds, membersById) {
    if (!eventCasesRepo || typeof eventCasesRepo.linkCluster !== 'function') return;
    const caseIds = memberFindingIds
      .map((id) => membersById.get(id))
      .filter((f) => f && f.eventCaseId != null)
      .map((f) => f.eventCaseId);
    if (!caseIds.length) return;
    try {
      await eventCasesRepo.linkCluster(caseIds, clusterId);
    } catch (err) {
      logger.warn(`cross-agent: could not link event cases to cluster ${clusterId} (${err.message})`);
    }
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
  // Returns the advisory text now on the cluster (existing, freshly-generated, or
  // null) so the caller can fold it into the cluster alert.
  async function maybeAdvise(clusterId, cluster, membersById, existingAdvisory) {
    if (existingAdvisory) return existingAdvisory;                  // already advised
    if (!ADVISORY_CONFIDENCE.has(cluster.confidence)) return null;  // low = no advisory
    if (!assistant || typeof assistant.suggestClusterCause !== 'function') return null;
    if (typeof assistant.isEnabled === 'function' && !assistant.isEnabled()) return null; // opt-in
    const members = cluster.memberFindingIds.map((id) => membersById.get(id)).filter(Boolean);
    if (members.length === 0) return null;                         // no evidence -> no advice

    let answer;
    try {
      const r = await assistant.suggestClusterCause(cluster, members);
      answer = r && typeof r.answer === 'string' ? r.answer.trim() : '';
    } catch (err) {
      logger.warn(`cross-agent: advisory generation failed (${err.message})`);
      return null;
    }
    if (!answer || answer === EVENT_INSUFFICIENT_ANSWER) return null; // never surface non-advice

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
    return answer;
  }

  // Step 3: fires ONE cluster-level alert for a medium/high cluster through the
  // existing channels, referencing (not resending) the members already alerted
  // individually. The dispatcher dedups it durably (once per cluster). Best-effort.
  async function maybeAlert(clusterId, cluster, members) {
    if (!alertDispatcher || typeof alertDispatcher.dispatchCluster !== 'function') return;
    if (!ADVISORY_CONFIDENCE.has(cluster.confidence)) return; // medium/high only
    if (members.length === 0) return;                         // no evidence -> no alert

    let alreadyAlerted = [];
    if (alertLog && typeof alertLog.listAlertedFindings === 'function') {
      try { alreadyAlerted = await alertLog.listAlertedFindings(cluster.memberFindingIds); } catch { alreadyAlerted = []; }
    }
    // Finding-shaped subject so the existing channels format it unchanged.
    const clusterAlert = {
      clusterId,
      id: `cluster:${clusterId}`,
      hostId: `${Array.isArray(cluster.hostIds) ? cluster.hostIds.length : members.length} agents`,
      metric: 'event_cluster',
      kind: 'CLUSTER',
      severity: cluster.severity || 'WARN',
      explanation: cluster.advisory || cluster.suspectedCommonCause || 'Cross-agent event cluster',
      deviation: null,
      evidence: members.map(evidenceRef),
      createdAt: now(),
    };
    const group = {
      likelyCause: null,
      hint: cluster.suspectedCommonCause || null,
      confidence: cluster.confidence,
      advisory: cluster.advisory || null,
      memberFindingIds: cluster.memberFindingIds,
      alreadyAlerted,
    };
    try {
      await alertDispatcher.dispatchCluster(clusterAlert, group);
    } catch (err) {
      logger.warn(`cross-agent: cluster alert failed (${err.message})`);
    }
  }

  // Member finding objects for a cluster, from the sweep's loaded findings.
  function membersOf(memberFindingIds, membersById) {
    return memberFindingIds.map((id) => membersById.get(id)).filter(Boolean);
  }

  // Normalised cluster object for the notifier (candidate fields + persisted refs).
  function toNotifyCluster(id, cand, persisted = {}) {
    return {
      clusterId: id, id,
      confidence: cand.confidence,
      severity: cand.severity || 'WARN',
      memberFindingIds: cand.memberFindingIds || [],
      hostIds: cand.hostIds || [],
      suspectedCommonCause: cand.suspectedCommonCause || null,
      advisory: cand.advisory || null,
      firstSeen: persisted.createdAt || cand.detectedAt || null,
      itsmTicketRef: persisted.itsmTicketRef || null,
      nis2DraftId: persisted.nis2DraftId || null,
    };
  }

  // Runs one detection pass: load recent findings across all hosts, detect
  // candidate clusters, then create-or-update each (deduped). Returns a summary
  // { created, updated } for the caller/tests. Never throws.
  async function detectAndPersist() {
    const summary = { created: 0, updated: 0 };
    let recent = [];
    try {
      // TWO windows back: two related findings may sit up to one window apart,
      // and the sweep runs every ~60s, so reading only one window would see
      // such a pair together only if a sweep happened to land in the instant
      // before the older one aged out.
      const since = new Date(now().getTime() - 2 * windowMs);
      recent = await findingStore.list(undefined, since); // all hosts within the window
    } catch (err) {
      logger.warn(`cross-agent: could not load recent findings (${err.message})`);
      return summary;
    }
    if (!Array.isArray(recent) || recent.length === 0) return summary;
    const membersById = new Map(recent.map((f) => [f.id, f]));

    const siteOf = await buildSiteLookup();
    const topology = await buildTopologyResolver(recent);
    let candidates = [];
    try {
      candidates = correlator.detect(recent, { siteOf, topology });
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
          const groupingBasis = mergeGrouping(existing.groupingBasis, candidate.grouping);
          const ok = await clustersRepo.updateMembership(existing.id, {
            confidence: candidate.confidence,
            memberFindingIds: merged,
            suspectedCommonCause: candidate.suspectedCommonCause,
            groupingBasis,
            detectedAt: candidate.detectedAt,
          });
          if (ok) {
            summary.updated += 1;
            const prevMemberIds = existing.memberFindingIds; // pre-merge
            const newIds = merged.filter((mid) => !prevMemberIds.includes(mid));
            existing.memberFindingIds = merged; // keep local view consistent for later candidates
            existing.groupingBasis = groupingBasis;
            await linkCases(existing.id, merged, membersById);
            publishCluster({ ...candidate, id: existing.id, status: 'open', memberFindingIds: merged, updated: true });
            const mergedCandidate = { ...candidate, memberFindingIds: merged };
            const advisory = await maybeAdvise(existing.id, mergedCandidate, membersById, existing.advisory);
            if (notifier && ADVISORY_CONFIDENCE.has(candidate.confidence)) {
              await notifier.notify({
                event: 'updated',
                cluster: toNotifyCluster(existing.id, { ...mergedCandidate, advisory }, existing),
                prev: { alertLastAt: existing.alertLastAt, alertLastSeverity: existing.alertLastSeverity, alertMemberCount: existing.alertMemberCount },
                members: membersOf(merged, membersById),
                newMemberFindings: membersOf(newIds, membersById),
              });
            } else {
              await maybeAlert(existing.id, { ...mergedCandidate, advisory }, membersOf(merged, membersById));
            }
          }
        } else {
          const id = await clustersRepo.create({
            confidence: candidate.confidence,
            memberFindingIds: candidate.memberFindingIds,
            suspectedCommonCause: candidate.suspectedCommonCause,
            groupingBasis: candidate.grouping || null,
            status: 'open',
            detectedAt: candidate.detectedAt,
          });
          summary.created += 1;
          await linkCases(id, candidate.memberFindingIds, membersById);
          const created = { ...candidate, id, status: 'open' };
          // Seed the local open-list entry with alert state so a later candidate
          // overlapping this just-created cluster in the same sweep sees it as
          // already-opened (no duplicate opened alert).
          open.push({ id, memberFindingIds: candidate.memberFindingIds, groupingBasis: candidate.grouping || null, status: 'open', alertLastAt: now(), alertLastSeverity: candidate.severity, alertMemberCount: candidate.memberFindingIds.length });
          publishCluster(created);
          // Fase 6: capture a read-only evidence snapshot per affected target on
          // open. Fire-and-forget — never blocks the sweep, alerting or the page.
          if (snapshotService && typeof snapshotService.captureForCluster === 'function') {
            Promise.resolve().then(() => snapshotService.captureForCluster(id, candidate.hostIds, { trigger: 'auto' })).catch(() => {});
          }
          const advisory = await maybeAdvise(id, candidate, membersById, null);
          if (notifier && ADVISORY_CONFIDENCE.has(candidate.confidence)) {
            await notifier.notify({
              event: 'opened',
              cluster: toNotifyCluster(id, { ...candidate, advisory }, {}),
              prev: {},
              members: membersOf(candidate.memberFindingIds, membersById),
              newMemberFindings: membersOf(candidate.memberFindingIds, membersById),
            });
          } else {
            await maybeAlert(id, { ...candidate, advisory }, membersOf(candidate.memberFindingIds, membersById));
          }
        }
      } catch (err) {
        logger.warn(`cross-agent: could not persist cluster (${err.message})`);
      }
    }
    return summary;
  }

  // True when a cluster still holds an UNACKNOWLEDGED CRIT member finding — the
  // existing retention rule that such an event must never auto-close (a human
  // has to acknowledge the CRIT first). Best-effort: an unreadable member is not
  // treated as CRIT (the auto-resolve is not blocked by a lookup failure).
  async function hasUnacknowledgedCrit(memberFindingIds) {
    if (!findingStore || typeof findingStore.get !== 'function') return false;
    for (const id of memberFindingIds || []) {
      let f = null;
      try {
        f = await findingStore.get(id); // eslint-disable-line no-await-in-loop
      } catch (err) {
        logger.warn(`cross-agent: could not read member finding ${id} (${err.message})`);
        f = null;
      }
      if (f && f.severity === 'CRIT' && !f.acked) return true;
    }
    return false;
  }

  // How many stale clusters the retention rule held open on the previous sweep;
  // null until the first one runs. The sweep ticks every 60s and the same
  // clusters stay held until somebody acknowledges their CRIT member, so a line
  // per cluster per sweep is the same fact restated ~1 440 times a day (a fleet
  // holding 70 clusters printed ~100 000 INFO lines a day and buried every other
  // log line, including in the dashboard's Logs view). One INFO line carries the
  // count, and only when it MOVES; the per-cluster detail drops to debug.
  let lastKeptOpen = null;

  // Resolves live clusters (open + acknowledged) whose last activity (detected_at)
  // is older than the inactivity window — the members stopped recurring, so the
  // pattern has cleared. A cluster that still contains an unacknowledged CRIT
  // finding is SKIPPED (never auto-closed) per the retention rule. Returns the
  // number resolved. Never throws.
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
    let keptOpen = 0;
    for (const c of stale) {
      try {
        if (await hasUnacknowledgedCrit(c.memberFindingIds)) {
          keptOpen += 1;
          logger.debug(`cross-agent: cluster ${c.id} kept open — unacknowledged CRIT member.`);
          continue; // retention rule: never auto-close an unacknowledged CRIT
        }
        // Guard on the cluster's CURRENT status (open or acknowledged) so the
        // transition is race-safe.
        const ok = await clustersRepo.updateStatus(c.id, { from: c.status, to: 'resolved', at: now() });
        if (!ok) continue; // lost a race
        resolved += 1;
        publishCluster({ id: c.id, status: 'resolved', confidence: c.confidence, memberFindingIds: c.memberFindingIds });
        // ONE resolution alert (+ ITSM worknote) with duration. Only for clusters
        // that were notified (medium/high); best-effort, never blocks resolution.
        if (notifier && ADVISORY_CONFIDENCE.has(c.confidence)) {
          const startMs = new Date(c.createdAt || c.detectedAt || now()).getTime();
          const mins = Math.max(0, Math.round((now().getTime() - startMs) / 60000));
          await notifier.notify({
            event: 'resolved',
            cluster: { ...toNotifyCluster(c.id, { confidence: c.confidence, severity: c.alertLastSeverity || 'WARN', memberFindingIds: c.memberFindingIds, suspectedCommonCause: c.suspectedCommonCause }, c), durationText: `${mins} min`, resolvedAt: now(), resolutionNote: c.resolutionNote || 'auto-resolved after inactivity' },
            members: [],
          });
        }
      } catch (err) {
        logger.warn(`cross-agent: could not resolve cluster ${c.id} (${err.message})`);
      }
    }
    if (resolved) logger.info(`cross-agent: resolved ${resolved} inactive cluster(s).`);
    if (keptOpen !== lastKeptOpen) {
      if (keptOpen) {
        logger.info(`cross-agent: ${keptOpen} inactive cluster(s) kept open — unacknowledged CRIT member.`);
      } else if (lastKeptOpen) {
        logger.info('cross-agent: no inactive clusters are held open any more.');
      }
      lastKeptOpen = keptOpen;
    }
    return resolved;
  }

  return { detectAndPersist, resolveStale };
}

module.exports = { createCrossAgentClusterService };
