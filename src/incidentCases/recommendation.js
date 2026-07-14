'use strict';

// Pure assembly for the unified incident recommendation
// (GET /api/incidents/:id/recommendation). The route fetches the rows; these
// helpers shape the three sections, ALWAYS in this order:
//   (a) matching_playbook  — a playbook matched on the incident's anomaly-type
//   (b) historical_matches — earlier RESOLVED incidents (Fase-4 similarity)
//   (c) ai_suggestion      — Mistral fallback (wired in a later step)
// No I/O here, so this is trivially testable for the ordering logic.

// (a) The matching_playbook section. `playbook` is the anomaly-type match (or
// null). `runs` are the runs already recorded against THIS incident (newest
// first). When the matched playbook has already been run on this incident we show
// the outcome instead of re-suggesting it; otherwise we suggest it.
function buildMatchingPlaybook(playbook, runs = []) {
  if (!playbook) return null;
  const priorRun = (Array.isArray(runs) ? runs : []).find((r) => Number(r.playbookId) === Number(playbook.id));
  if (priorRun) {
    return {
      playbook_id: playbook.id,
      name: playbook.name,
      action_type: playbook.actionType,
      already_run: true,
      // Show the result rather than proposing the same playbook again.
      run: {
        status: priorRun.status,
        result_text: priorRun.resultText ?? null,
        ran_at: priorRun.ranAt ?? null,
        ran_by: priorRun.ranBy ?? null,
      },
    };
  }
  return {
    playbook_id: playbook.id,
    name: playbook.name,
    action_type: playbook.actionType,
    already_run: false,
    // Either an automatic action or a manual runbook (never both meaningful).
    auto_trigger: !!playbook.autoTrigger,
    manual_action_text: playbook.autoTrigger ? null : (playbook.manualActionText ?? null),
  };
}

// (b) The historical_matches section. `ranked` are the scored similar incidents
// (already RESOLVED-only, from the reused similarity logic). For each we add:
//   - playbook: which playbook (if any) was used on that past incident
//   - resolutionTimeSeconds: how long it took to resolve
//   - timesSeen: how many resolved incidents share this anomaly-type (pattern
//     frequency across the historical pool)
// No re-scoring — order/score come straight from the similarity logic.
function resolutionSeconds(firstEventAt, resolvedAt) {
  if (!firstEventAt || !resolvedAt) return null;
  const a = new Date(firstEventAt).getTime();
  const b = new Date(resolvedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

// Picks the run to surface for a past incident: a succeeded run wins, else the
// most recent run. Returns a compact { playbook_id, name, action_type, status }
// or null when no playbook was run.
function playbookForHistorical(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) return null;
  const chosen = list.find((r) => r.status === 'succeeded') || list[0];
  return {
    playbook_id: chosen.playbookId,
    name: chosen.playbookName ?? null,
    action_type: chosen.playbookActionType ?? null,
    status: chosen.status,
  };
}

function buildHistoricalMatches(ranked = [], { runsByIncident = {}, resolvedCandidates = [] } = {}) {
  const pool = Array.isArray(resolvedCandidates) ? resolvedCandidates : [];
  return (Array.isArray(ranked) ? ranked : []).map((r) => {
    const timesSeen = r.primaryMetric
      ? pool.filter((c) => c.primaryMetric && c.primaryMetric === r.primaryMetric).length
      : 0;
    return {
      id: r.id,
      title: r.title ?? null,
      status: r.status ?? null,
      severity: r.severity ?? null,
      primaryMetric: r.primaryMetric ?? null,
      resolvedAt: r.resolvedAt ?? null,
      resolutionTimeSeconds: resolutionSeconds(r.firstEventAt, r.resolvedAt),
      timesSeen,
      score: r.score,
      matchedOn: r.matchedOn,
      closedBy: r.closedByEmail ?? null,
      playbook: playbookForHistorical(runsByIncident[r.id]),
    };
  });
}

// (c) Whether the AI fallback should be generated: ONLY when there is no matching
// playbook AND no historical matches, or the caller explicitly forced it. The
// actual Mistral call is wired in a later step; this predicate encodes the order.
function shouldGenerateAi({ matchingPlaybook, historicalMatches, forceAi = false } = {}) {
  if (forceAi) return true;
  const noPlaybook = !matchingPlaybook;
  const noHistory = !Array.isArray(historicalMatches) || historicalMatches.length === 0;
  return noPlaybook && noHistory;
}

module.exports = {
  buildMatchingPlaybook,
  buildHistoricalMatches,
  shouldGenerateAi,
  resolutionSeconds,
  playbookForHistorical,
};
