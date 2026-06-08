'use strict';

// Shared vocabulary for the NIS2 Reporting Center. Kept in one place so the
// repositories, validation, dashboard scoring and the (server-rendered) reports
// all agree on the same enums and category set. Mirrored verbatim in the
// dashboard (public/app.js NIS2_* constants) — keep the two in sync.

// The ten NIS2 control/risk categories the dashboard reports status per.
const CATEGORIES = Object.freeze([
  'Governance',
  'Risk Management',
  'Incident Response',
  'Backup/Recovery',
  'Access Control',
  'Supplier Management',
  'Network Security',
  'Logging/Monitoring',
  'Vulnerability Management',
  'Documentation',
]);

const RISK_STATUSES = Object.freeze(['open', 'mitigating', 'accepted', 'closed']);
const CONTROL_STATUSES = Object.freeze(['OK', 'Partial', 'Missing', 'Overdue']);
const CONTROL_FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly', 'quarterly', 'annually', 'ad-hoc']);
const INCIDENT_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
const INCIDENT_STATUSES = Object.freeze(['open', 'investigating', 'contained', 'resolved', 'closed']);
const REPORT_TYPES = Object.freeze(['readiness', 'executive', 'risk', 'control', 'incident']);
const EVIDENCE_ENTITIES = Object.freeze(['control', 'risk', 'incident', 'report']);

// Maps a stored risk_score (likelihood * impact, 1..25) to a colour band. The
// thresholds are the conventional 5x5 risk-matrix cut-points.
function riskBand(score) {
  const s = Number(score) || 0;
  if (s >= 15) return 'Critical';
  if (s >= 8) return 'High';
  if (s >= 4) return 'Medium';
  return 'Low';
}

// How much a control's evidence status contributes to its category's readiness
// (0..100). Partial counts as half; anything missing/overdue is zero.
const CONTROL_SCORE = Object.freeze({ OK: 100, Partial: 50, Missing: 0, Overdue: 0 });

module.exports = {
  CATEGORIES,
  RISK_STATUSES,
  CONTROL_STATUSES,
  CONTROL_FREQUENCIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  REPORT_TYPES,
  EVIDENCE_ENTITIES,
  CONTROL_SCORE,
  riskBand,
};
