'use strict';

const { maskIps } = require('../config/mask');

// Cluster-level NIS2 draft (Fase 5). When a cross-agent cluster would individually
// trigger N per-finding NIS2 drafts, generate ONE cluster draft instead. Reuses
// the existing blueeye_nis2_incidents pipeline and its invariants:
//   * always a DRAFT — notification_required = false (NEVER auto-submitted),
//   * AI-generated content is CLEARLY MARKED ([AI draft] title),
//   * fully functional WITHOUT Mistral — a template-based draft is persisted when
//     the assistant is off (unlike the per-finding path, which skips).
// Input is masked (same rules as the other Mistral integrations) whether or not
// AI is used.

const NIS2_SEVERITY = { CRIT: 'high', WARN: 'medium', INFO: 'low' };
const REVIEW_NOTE = 'Automatically generated DRAFT (BlueEye). Requires human review before submission; not submitted automatically.';

function nis2Severity(sev) { return NIS2_SEVERITY[String(sev || '').toUpperCase()] || 'medium'; }

// Pure builder → the nis2IncidentsRepo.create() input. `aiText` (when present)
// is the masked AI narrative; its presence flips the title to the [AI draft]
// marker. Everything user-facing is masked.
function buildClusterNis2Draft(cluster, { members = [], timelineText = null, aiText = null } = {}) {
  const id = cluster.id ?? cluster.clusterId;
  const agents = [...new Set((Array.isArray(members) ? members : []).map((m) => String(m.hostId)).filter(Boolean))];
  const affected = agents.length ? agents.map((a) => `agent ${a}`).join(', ') : `${cluster.memberCount || 0} finding(s)`;
  const cause = cluster.suspectedCommonCause || 'Cross-agent correlation';
  const marked = !!aiText;

  return {
    title: `${marked ? '[AI draft]' : '[Cluster draft]'} Cross-agent incident #${id}`,
    severity: nis2Severity(cluster.severity),
    detectedAt: cluster.firstSeen || cluster.createdAt || cluster.detectedAt || null,
    startedAt: cluster.firstSeen || cluster.createdAt || cluster.detectedAt || null,
    resolvedAt: cluster.resolvedAt || null,
    affectedSystems: maskIps(affected),
    businessImpact: maskIps(`Cross-agent incident spanning ${agents.length || cluster.memberCount || 0} monitored system(s); potential service impact under review.`),
    rootCause: maskIps(`${aiText || cause}\n\n${REVIEW_NOTE}${marked ? ' AI-generated content is clearly marked.' : ''}`),
    actionsTaken: timelineText ? maskIps(String(timelineText)) : 'See the incident timeline in BlueEye.',
    nis2Relevant: false,          // a human assesses NIS2 relevance
    notificationRequired: false,  // NEVER auto-submitted
    status: 'open',
  };
}

function createClusterNis2Service({
  nis2IncidentsRepo,
  clustersRepo = null,
  assistant = null,
  auditLogger = null,
  logger = { info() {}, warn() {} },
}) {
  // Best-effort masked AI narrative for the draft. Returns null on any problem
  // (disabled, unavailable, threw, or "insufficient") — the template still stands.
  async function aiNarrative(cluster, members) {
    if (!assistant || typeof assistant.suggestClusterCause !== 'function') return null;
    if (typeof assistant.isEnabled === 'function' && !assistant.isEnabled()) return null;
    try {
      const r = await assistant.suggestClusterCause(cluster, members);
      const text = r && typeof r.answer === 'string' ? r.answer.trim() : '';
      return text || null;
    } catch (err) {
      logger.warn(`cluster-nis2: AI narrative failed (${err.message})`);
      return null;
    }
  }

  // Generates the ONE cluster NIS2 draft (idempotent — skips if the cluster
  // already links one). Suppresses per-finding drafts for members with an audit
  // link. Returns the draft id (or the existing one). Never throws.
  async function generateForCluster(cluster, { members = [], timelineText = null } = {}) {
    const clusterId = cluster.id ?? cluster.clusterId;
    if (cluster.nis2DraftId) return cluster.nis2DraftId; // already drafted → no duplicate
    try {
      const aiText = await aiNarrative(cluster, members);
      const draftInput = buildClusterNis2Draft(cluster, { members, timelineText, aiText });
      const created = await nis2IncidentsRepo.create(draftInput);
      const draftId = created && created.id != null ? created.id : created;
      if (clustersRepo && typeof clustersRepo.setNis2Draft === 'function') {
        await clustersRepo.setNis2Draft(clusterId, draftId);
      }
      if (auditLogger && typeof auditLogger.record === 'function') {
        await auditLogger.record(null, {
          category: 'incident', action: 'nis2_cluster_draft', target: String(clusterId),
          actorEmail: 'system', actorRole: 'system',
          detail: `One cluster NIS2 draft #${draftId} generated; per-finding drafts for ${members.length} member(s) suppressed.`,
        });
      }
      return draftId;
    } catch (err) {
      logger.warn(`cluster-nis2: could not generate draft for cluster ${clusterId} (${err.message})`);
      return null;
    }
  }

  return { generateForCluster };
}

module.exports = { createClusterNis2Service, buildClusterNis2Draft, nis2Severity };
