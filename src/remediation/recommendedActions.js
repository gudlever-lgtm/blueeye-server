'use strict';

// Pure helpers for the "Recommended actions" bridge (Fase 3): from a cluster's
// member findings to the finding-types that drive runbook matching, and the
// assembled recommendation payload. No I/O — the route reads runbooks + the
// cluster and hands the pieces here. Static runbook mapping FIRST; the opt-in AI
// advisory is garnish appended last.

// The cluster's dominant finding-types: distinct member metrics, ranked by how
// many members carry each (widest spread first; ties keep first-seen order). This
// is what runbooks are matched against — the "what is actually wrong" signal.
function dominantFindingTypes(members) {
  const counts = new Map();
  for (const f of Array.isArray(members) ? members : []) {
    const m = f && (f.metric != null ? f.metric : null);
    if (m == null || m === '') continue;
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([metric]) => metric);
}

// Assemble the recommendation. `runbooks` are the matches for the finding-types
// (from runbooksRepository.listByFindingTypes). `advisory` is the cluster-level
// AI advisory text (Fase 2), surfaced ONLY when present + the assistant is on —
// always clearly labelled AI-generated on the client. `mistralEnabled` gates
// whether the advisory is offered at all.
function buildRecommendedActions({ findingTypes = [], runbooks = [], advisory = null, mistralEnabled = false }) {
  const items = (Array.isArray(runbooks) ? runbooks : []).map((r) => ({
    id: r.id,
    findingType: r.findingType,
    title: r.title,
    bodyMarkdown: r.bodyMarkdown,
    linkedPlaybookId: r.linkedPlaybookId ?? null,
    linkedPlaybookName: r.linkedPlaybookName ?? null,
  }));
  return {
    findingTypes,
    runbooks: items,
    hasRunbooks: items.length > 0,
    advisory: mistralEnabled && advisory ? advisory : null,
    advisoryEnabled: !!mistralEnabled,
  };
}

module.exports = { dominantFindingTypes, buildRecommendedActions };
