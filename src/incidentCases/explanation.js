'use strict';

// A separate, light "explanation" (what / where / why) for an incident, delivered
// on the incident response (GET /api/incidents/:id) — NOT bundled into the
// recommendation. Pure assembly, no I/O.
//
//   what  — the primary anomaly-type + the incident severity
//   where — device (+ agent label and the site it stands at), interface (if the
//           evidence carries one), and — when Fase 6 topology becomes
//           incident-scoped — topology context
//   why   — the evidence behind the confidence, reusing the finding evidence-array
//           format. When an anomaly-type has a confidence model (registered in
//           CONFIDENCE_MODELS), `why` carries the model's confidence + the evidence
//           that produced it (source: 'confidence_model'). No anomaly-type ships a
//           confidence model in this codebase yet (only an L2-loop model was ever
//           specced, and it is not here), so the registry is empty and `why` falls
//           back to the RAW trigger-data (observed/baseline/deviation + evidence
//           samples, source: 'raw_trigger'). That fallback is expected, not an error.

const { formatDeviceLabel } = require('./deviceLabel');

// anomaly-type (finding metric or kind) -> confidence model. A model exposes
// evaluate(finding) -> { confidence: 0..1, evidence: [...] }. Empty for now, and
// generalised so any future model (e.g. an L2-loop detector) registers here and
// the `why` field picks it up automatically — no change to this file's callers.
const CONFIDENCE_MODELS = Object.freeze({});

function confidenceModelFor(anomalyType) {
  if (!anomalyType) return null;
  return CONFIDENCE_MODELS[anomalyType] || null;
}

// The `why` section. Prefers a registered confidence model for the finding's
// anomaly-type; otherwise returns the raw trigger-data in the same evidence-array
// shape a model would use.
function buildWhy(finding) {
  if (!finding) {
    return { source: 'raw_trigger', available: false, evidence: [] };
  }
  const model = confidenceModelFor(finding.metric) || confidenceModelFor(finding.kind);
  if (model && typeof model.evaluate === 'function') {
    const out = model.evaluate(finding) || {};
    return {
      source: 'confidence_model',
      available: true,
      confidence: typeof out.confidence === 'number' ? out.confidence : null,
      evidence: Array.isArray(out.evidence) ? out.evidence : [],
      explanation: finding.explanation ?? null,
    };
  }
  return {
    source: 'raw_trigger',
    available: true,
    explanation: finding.explanation ?? null,
    observed: finding.observed ?? null,
    baseline: finding.baseline ?? null,
    deviation: finding.deviation ?? null,
    // Same evidence-array format a confidence model would carry, just raw.
    evidence: Array.isArray(finding.evidence) ? finding.evidence : [],
  };
}

function ifaceFromEvidence(finding) {
  const ev = finding && Array.isArray(finding.evidence) ? finding.evidence : [];
  for (const s of ev) {
    if (s && (s.iface || s.interface)) return s.iface || s.interface;
  }
  return null;
}

// The device identity for `where`. The joined incident row already carries it
// (agentName/locationName); a separately-loaded agent record is used when it
// does not, so a caller can pass either (or both).
function buildExplanation({ incident, primaryFinding = null, agent = null } = {}) {
  if (!incident) return null;
  const agentName = (agent ? (agent.display_name ?? agent.hostname ?? null) : null) ?? incident.agentName ?? null;
  const locationName = (agent ? (agent.location_name ?? null) : null) ?? incident.locationName ?? null;
  return {
    what: {
      anomalyType: primaryFinding ? primaryFinding.metric : null,
      severity: incident.severity ?? null,
    },
    where: {
      device: incident.hostId ?? null,
      deviceLabel: agentName,
      // The site the device stands at — "where" is not answered by a device id
      // alone when the fleet spans several locations. Null when the agent has no
      // location set (never mandatory) or could not be resolved.
      locationId: agent ? (agent.location_id ?? null) : (incident.locationId ?? null),
      locationName: locationName,
      // One ready-made string for headers/exports: "core-sw (Copenhagen HQ)".
      summary: formatDeviceLabel({ hostId: incident.hostId, agentName, locationName }),
      interface: ifaceFromEvidence(primaryFinding),
      // Fase-6 topology is flow-derived and not yet incident-scoped; forward-compat.
      topology: null,
    },
    why: buildWhy(primaryFinding),
  };
}

module.exports = { buildExplanation, buildWhy, confidenceModelFor, CONFIDENCE_MODELS };
