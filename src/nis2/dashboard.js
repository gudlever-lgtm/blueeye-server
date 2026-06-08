'use strict';

const { CATEGORIES, CONTROL_SCORE, riskBand } = require('./constants');

// Risk statuses that still count as "open" exposure (not accepted/closed).
const OPEN_RISK = new Set(['open', 'mitigating']);
// Incident statuses that still count as "open".
const OPEN_INCIDENT = new Set(['open', 'investigating', 'contained']);

function within(dateIso, days, now) {
  if (!dateIso) return false;
  const t = new Date(dateIso).getTime();
  return Number.isFinite(t) && t >= now - days * 86400_000;
}

// A control needs attention when it carries no evidence OR is flagged
// Missing/Overdue — the two ways assurance fails.
function controlNeedsEvidence(c) {
  return !c.hasEvidence || c.status === 'Missing' || c.status === 'Overdue';
}

// Translates a 0..100 category score into a coarse status label for badges.
function categoryLabel(score, controlCount) {
  if (controlCount === 0) return 'no-data';
  if (score >= 80) return 'good';
  if (score >= 50) return 'partial';
  return 'weak';
}

// Pure NIS2 dashboard computation. Takes already-loaded risks/controls/incidents
// (API shapes from the repositories) and a clock, and returns every headline
// metric the dashboard renders. Deterministic + explainable: the readiness score
// is the mean of the ten category scores, each the mean of its controls'
// evidence health (OK=100, Partial=50, Missing/Overdue=0).
function computeDashboard({ risks = [], controls = [], incidents = [] } = {}, now = Date.now()) {
  // Per-category control rollup.
  const categories = CATEGORIES.map((name) => {
    const inArea = controls.filter((c) => c.nis2Area === name);
    const score = inArea.length
      ? Math.round(inArea.reduce((s, c) => s + (CONTROL_SCORE[c.status] ?? 0), 0) / inArea.length)
      : 0;
    return {
      category: name,
      controlCount: inArea.length,
      score,
      status: categoryLabel(score, inArea.length),
    };
  });

  const scored = categories.filter((c) => c.controlCount > 0);
  const readinessScore = scored.length
    ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length)
    : 0;

  const openRisks = risks.filter((r) => OPEN_RISK.has(r.status));
  const openCriticalRisks = openRisks.filter((r) => riskBand(r.riskScore) === 'Critical').length;
  const openHighMediumFindings = openRisks.filter((r) => {
    const b = riskBand(r.riskScore);
    return b === 'High' || b === 'Medium';
  }).length;

  const incidentsLast30Days = incidents.filter(
    (i) => within(i.detectedAt || i.createdAt, 30, now)
  ).length;

  const controlsWithoutEvidence = controls.filter(controlNeedsEvidence).length;

  return {
    generatedAt: new Date(now).toISOString(),
    readinessScore,
    openCriticalRisks,
    openHighMediumFindings,
    incidentsLast30Days,
    controlsWithoutEvidence,
    totals: {
      risks: risks.length,
      openRisks: openRisks.length,
      controls: controls.length,
      incidents: incidents.length,
    },
    categories,
    topActions: recommendedActions({ risks, controls, incidents, categories }, now),
  };
}

// Ranks the most impactful next actions across risks/controls/incidents and
// returns the top five, each with a short reason + a priority weight so the UI
// can colour them. Higher weight = more urgent.
function recommendedActions({ risks, controls, incidents, categories }, now) {
  const actions = [];

  for (const r of risks) {
    if (!OPEN_RISK.has(r.status)) continue;
    const band = riskBand(r.riskScore);
    if (band === 'Critical' && !r.mitigationPlan) {
      actions.push({ weight: 100, priority: 'critical', kind: 'risk', text: `Define a mitigation plan for critical risk "${r.title}"` });
    } else if (band === 'Critical') {
      actions.push({ weight: 80, priority: 'critical', kind: 'risk', text: `Progress mitigation of critical risk "${r.title}"` });
    } else if (band === 'High' && !r.mitigationPlan) {
      actions.push({ weight: 60, priority: 'high', kind: 'risk', text: `Define a mitigation plan for high risk "${r.title}"` });
    }
  }

  for (const c of controls) {
    if (c.status === 'Overdue') {
      actions.push({ weight: 90, priority: 'high', kind: 'control', text: `Perform the overdue control "${c.controlName}" (${c.nis2Area})` });
    } else if (c.status === 'Missing') {
      actions.push({ weight: 70, priority: 'high', kind: 'control', text: `Establish and evidence the control "${c.controlName}" (${c.nis2Area})` });
    } else if (!c.hasEvidence) {
      actions.push({ weight: 40, priority: 'medium', kind: 'control', text: `Attach evidence to the control "${c.controlName}" (${c.nis2Area})` });
    }
  }

  for (const i of incidents) {
    if (i.notificationRequired && OPEN_INCIDENT.has(i.status)) {
      actions.push({ weight: 95, priority: 'critical', kind: 'incident', text: `Assess NIS2 notification obligation for incident ${i.incidentId} "${i.title}"` });
    }
  }

  for (const cat of categories) {
    if (cat.controlCount === 0) {
      actions.push({ weight: 50, priority: 'medium', kind: 'category', text: `Define controls for ${cat.category} — no controls recorded yet` });
    }
  }

  return actions.sort((a, b) => b.weight - a.weight).slice(0, 5);
}

module.exports = { computeDashboard, recommendedActions };
