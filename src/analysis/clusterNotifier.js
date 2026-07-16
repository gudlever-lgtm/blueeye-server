'use strict';

const { decideAlert, summarize, DEFAULT_DIGEST_MS } = require('./clusterRollup');
const { classifyRootCauseLayer } = require('./clusterView');

// Cluster notification orchestrator (Fase 5). The cross-agent sweep calls
// `notify()` on each cluster lifecycle transition (opened / updated / resolved);
// this fans the ONE incident out to:
//   * alerting  — rollup engine decides opened/update/escalation/resolved, then
//                 dispatchClusterEvent (per-channel digest) + records alert state;
//   * ITSM      — one ticket per cluster (create-once, worknote appends);
//   * NIS2      — one cluster draft when the incident is CRIT.
// Plus it records per-finding alert SUPPRESSION (audit + cluster timeline) so a
// suppressed member alert is always traceable, honouring the race case (a member
// already alerted before clustering is noted, not "recalled").
//
// Every side effect is best-effort: a failure in one channel never blocks the
// others or the sweep. `notify()` never throws.

const CRIT = 'CRIT';
const silentLogger = { info() {}, warn() {} };

function createClusterNotifier({
  alertDispatcher = null,
  integrationTrigger = null,
  nis2Service = null,
  clustersRepo = null,
  alertLog = null,
  auditLogger = null,
  publishCluster = () => {},
  digestMs = DEFAULT_DIGEST_MS,
  nis2TriggerSeverity = CRIT,
  now = () => new Date(),
  logger = silentLogger,
}) {
  function agentCount(cluster) {
    return Array.isArray(cluster.hostIds) ? cluster.hostIds.length
      : (cluster.affectedAgents ? cluster.affectedAgents.length : (cluster.memberCount || 0));
  }

  // Finding-shaped subject + group for the alert channels (unchanged channel API).
  function alertSubject(cluster, members, kind, classification) {
    return {
      clusterId: cluster.clusterId ?? cluster.id,
      id: `cluster:${cluster.clusterId ?? cluster.id}`,
      hostId: `${agentCount(cluster)} agents`,
      metric: 'incident_cluster',
      kind: 'CLUSTER',
      severity: cluster.severity || 'WARN',
      explanation: summarize(kind, { ...cluster, agentCount: agentCount(cluster), classification }),
      deviation: null,
      evidence: members.map((m) => ({ findingId: m.id, host: m.hostId, metric: m.metric, severity: m.severity })),
      createdAt: now(),
    };
  }

  async function alreadyAlertedMembers(memberFindingIds) {
    if (!alertLog || typeof alertLog.listAlertedFindings !== 'function') return [];
    try { return await alertLog.listAlertedFindings(memberFindingIds); } catch { return []; }
  }

  // Fires the decided alert to the channels + records the cluster's alert state.
  async function fireAlert(cluster, members, kind, classification) {
    if (!alertDispatcher || typeof alertDispatcher.dispatchClusterEvent !== 'function') return;
    const subject = alertSubject(cluster, members, kind, classification);
    const group = {
      confidence: cluster.confidence,
      advisory: cluster.advisory || null,
      hint: cluster.suspectedCommonCause || null,
      memberFindingIds: cluster.memberFindingIds || [],
      alreadyAlerted: await alreadyAlertedMembers(cluster.memberFindingIds || []),
      classification,
      event: kind,
    };
    try {
      await alertDispatcher.dispatchClusterEvent(subject, group, { kind });
    } catch (err) {
      logger.warn(`cluster-notify: alert (${kind}) failed (${err.message})`);
    }
    if (clustersRepo && typeof clustersRepo.updateAlertState === 'function') {
      try {
        await clustersRepo.updateAlertState(cluster.clusterId ?? cluster.id, {
          at: now(), severity: cluster.severity || 'WARN', memberCount: (cluster.memberFindingIds || []).length,
        });
      } catch (err) { logger.warn(`cluster-notify: alert-state update failed (${err.message})`); }
    }
  }

  // ITSM: create the ONE ticket on open (store its ref), append worknotes after.
  async function itsmOpen(cluster, classification) {
    if (!integrationTrigger || typeof integrationTrigger.emitCluster !== 'function') return;
    if (cluster.itsmTicketRef) return; // already ticketed
    const payload = {
      clusterId: cluster.clusterId ?? cluster.id, severity: cluster.severity, confidence: cluster.confidence,
      agentCount: agentCount(cluster), classification, memberCount: (cluster.memberFindingIds || []).length,
      summary: cluster.suspectedCommonCause || 'Cross-agent incident', suspectedCommonCause: cluster.suspectedCommonCause,
    };
    try {
      const out = await integrationTrigger.emitCluster(payload);
      if (out && out.ref && clustersRepo && typeof clustersRepo.setItsmRef === 'function') {
        await clustersRepo.setItsmRef(cluster.clusterId ?? cluster.id, { ticketRef: out.ref.ticketRef, integrationId: out.ref.integrationId });
      }
    } catch (err) { logger.warn(`cluster-notify: ITSM open failed (${err.message})`); }
  }

  async function itsmNote(cluster, note) {
    if (!integrationTrigger || typeof integrationTrigger.emitClusterNote !== 'function') return;
    const payload = { clusterId: cluster.clusterId ?? cluster.id, severity: cluster.severity, confidence: cluster.confidence, summary: cluster.suspectedCommonCause };
    try { await integrationTrigger.emitClusterNote(payload, note); }
    catch (err) { logger.warn(`cluster-notify: ITSM note failed (${err.message})`); }
  }

  // Records per-finding alert suppression for NEW members (audit + cluster
  // timeline). A member already alerted before clustering is the accepted RACE
  // case — noted, never recalled.
  async function recordSuppression(clusterId, newMemberFindings) {
    if (!auditLogger || typeof auditLogger.record !== 'function') return;
    const ids = (newMemberFindings || []).map((f) => f && f.id).filter(Boolean);
    if (!ids.length) return;
    const raced = new Set(await alreadyAlertedMembers(ids));
    for (const f of newMemberFindings) {
      if (!f || !f.id) continue;
      const isRace = raced.has(String(f.id));
      try {
        await auditLogger.record(null, { // eslint-disable-line no-await-in-loop
          category: 'incident',
          action: isRace ? 'alert_race' : 'alert_suppressed',
          target: String(clusterId),
          actorEmail: 'system', actorRole: 'system',
          detail: isRace
            ? `Finding ${f.id} (${f.metric}) alert already dispatched before clustering — noted in cluster #${clusterId}.`
            : `Individual alert suppressed for finding ${f.id} (${f.metric}) — rolled into cluster #${clusterId}.`,
        });
      } catch (err) { logger.warn(`cluster-notify: suppression audit failed (${err.message})`); }
    }
  }

  // NIS2: one cluster draft when the incident is severe enough (default CRIT).
  async function maybeNis2(cluster, members) {
    if (!nis2Service || typeof nis2Service.generateForCluster !== 'function') return;
    if (cluster.nis2DraftId) return;
    const rankOf = { INFO: 1, WARN: 2, CRIT: 3 };
    if ((rankOf[cluster.severity] || 0) < (rankOf[nis2TriggerSeverity] || 3)) return;
    try { await nis2Service.generateForCluster(cluster, { members }); }
    catch (err) { logger.warn(`cluster-notify: NIS2 draft failed (${err.message})`); }
  }

  // Main entry. `event` ∈ opened|updated|resolved. `prev` is the cluster's stored
  // alert state { alertLastAt, alertLastSeverity, alertMemberCount }. Never throws.
  async function notify({ event, cluster, prev = {}, members = [], newMemberFindings = [] }) {
    try {
      const classification = classifyRootCauseLayer(members.map((m) => m.metric)).layer;

      if (event === 'resolved') {
        await fireAlert(cluster, members, 'resolved', classification);
        await itsmNote(cluster, summarize('resolved', cluster));
        return { kind: 'resolved' };
      }

      const decision = decideAlert(event, { ...cluster, memberCount: (cluster.memberFindingIds || []).length }, prev, { digestMs, now: () => now().getTime() });

      if (decision.kind === 'opened') {
        await fireAlert(cluster, members, 'opened', classification);
        await itsmOpen(cluster, classification);
        await maybeNis2(cluster, members);
      } else if (decision.kind === 'escalation') {
        await fireAlert(cluster, members, 'escalation', classification);
        await itsmNote(cluster, summarize('escalation', { ...cluster, agentCount: agentCount(cluster) }));
        await maybeNis2(cluster, members); // a fresh CRIT may now warrant a draft
      } else if (decision.kind === 'update') {
        await fireAlert(cluster, members, 'update', classification);
        await itsmNote(cluster, summarize('update', { ...cluster, agentCount: agentCount(cluster), memberCount: (cluster.memberFindingIds || []).length }, prev));
      }

      // Suppression is recorded for new members regardless of the digest decision.
      await recordSuppression(cluster.clusterId ?? cluster.id, newMemberFindings);
      return { kind: decision.kind };
    } catch (err) {
      logger.warn(`cluster-notify: notify failed (${err.message})`);
      return { kind: null };
    }
  }

  return { notify };
}

module.exports = { createClusterNotifier };
