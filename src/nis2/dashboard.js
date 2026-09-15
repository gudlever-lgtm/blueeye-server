'use strict';

const { CATEGORIES, CONTROL_SCORE, riskBand } = require('./constants');
const { createT } = require('./i18n');

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
//
// Each action carries BOTH a rendered English `text` and the `code` + `params`
// it was rendered from. `text` is what GET /dashboard has always returned and
// what the dashboard screen shows; the reports use `code`/`params` so a Danish
// report does not end up with an English sentence baked in here. Adding a
// sentence means adding an `action.*` key to src/nis2/i18n.js in both locales.
function recommendedActions({ risks, controls, incidents, categories }, now) {
  const actions = [];
  const en = createT('en');
  const add = (weight, priority, kind, code, params) => {
    actions.push({ weight, priority, kind, code, params, text: en(code, params) });
  };

  for (const r of risks) {
    if (!OPEN_RISK.has(r.status)) continue;
    const band = riskBand(r.riskScore);
    if (band === 'Critical' && !r.mitigationPlan) {
      add(100, 'critical', 'risk', 'action.risk.planCritical', { title: r.title });
    } else if (band === 'Critical') {
      add(80, 'critical', 'risk', 'action.risk.progressCritical', { title: r.title });
    } else if (band === 'High' && !r.mitigationPlan) {
      add(60, 'high', 'risk', 'action.risk.planHigh', { title: r.title });
    }
  }

  for (const c of controls) {
    if (c.status === 'Overdue') {
      add(90, 'high', 'control', 'action.control.overdue', { name: c.controlName, area: c.nis2Area });
    } else if (c.status === 'Missing') {
      add(70, 'high', 'control', 'action.control.missing', { name: c.controlName, area: c.nis2Area });
    } else if (!c.hasEvidence) {
      add(40, 'medium', 'control', 'action.control.noEvidence', { name: c.controlName, area: c.nis2Area });
    }
  }

  for (const i of incidents) {
    if (i.notificationRequired && OPEN_INCIDENT.has(i.status)) {
      add(95, 'critical', 'incident', 'action.incident.notify', { ref: i.incidentId, title: i.title });
    }
  }

  for (const cat of categories) {
    if (cat.controlCount === 0) {
      add(50, 'medium', 'category', 'action.category.empty', { category: cat.category });
    }
  }

  return actions.sort((a, b) => b.weight - a.weight).slice(0, 5);
}

// Renders one action in the requested language. The `{category}` and `{area}`
// params are NIS2 area names, so they are translated too — an otherwise Danish
// sentence must not end "... for Access Control".
function actionText(action, t) {
  if (!action || !action.code) return (action && action.text) || '';
  const params = { ...(action.params || {}) };
  if (params.category) params.category = t.enum('cat', params.category);
  if (params.area) params.area = t.enum('cat', params.area);
  return t(action.code, params);
}

module.exports = { computeDashboard, recommendedActions, actionText };
