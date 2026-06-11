'use strict';

const { computeFleet } = require('../health/probeHealth');

// Builds the Advanced Dashboard payload — a set of drill-down widget panels
// composed from data the server already has (fleet health, open incidents,
// analysis findings). Pure and dependency-free so it is unit-testable; the route
// wires the real repositories. The capability is sold as `dashboard_advanced`
// (Professional+) and the route gates on it.
//
//   buildAdvancedDashboard({ agents, probeRowsByAgentId, incidents, findings })
//
// `agents`              — agent rows (agentsRepo.findAll()).
// `probeRowsByAgentId`  — agentId ⇒ recent probe rows (newest-first), for the
//                         per-agent health verdict (same shape computeFleet wants).
// `incidents`           — incident rows (incidentsRepo.list(), camelCase API shape).
// `findings`            — analysis findings (findingStore.list()).
function buildAdvancedDashboard({
  agents = [],
  probeRowsByAgentId = {},
  incidents = [],
  findings = [],
  now = Date.now(),
} = {}) {
  const { agents: fleet, summary } = computeFleet(agents, probeRowsByAgentId, { now });

  // Drill-down panel: the agents that need attention (anything not healthy and
  // actually measured), worst-first, capped so the widget stays compact.
  const attention = fleet
    .filter((a) => a.health.status !== 'ok' && a.health.status !== 'unknown')
    .slice(0, 10)
    .map((a) => ({
      agentId: a.agentId,
      displayName: a.displayName,
      locationName: a.locationName,
      status: a.health.status,
      reason: a.health.reason || null,
    }));

  const activeIncidents = (incidents || []).filter((i) => i && i.status === 'active');
  const openFindings = (findings || []).filter((f) => f && !f.acked);

  return {
    generatedAt: new Date(now).toISOString(),
    widgets: {
      // Fleet health roll-up, renamed to the dashboard's customer-facing labels.
      fleet: {
        total: summary.total,
        healthy: summary.ok,
        warning: summary.warn,
        critical: summary.bad,
        down: summary.down,
        stale: summary.stale,
        unknown: summary.unknown,
      },
      attention,
      incidents: {
        active: activeIncidents.length,
        recent: activeIncidents
          .slice()
          .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
          .slice(0, 10)
          .map((i) => ({
            id: i.id,
            agentId: i.agentId,
            agentName: i.agentName || null,
            locationName: i.locationName || null,
            metric: i.metric,
            severity: i.severity,
            startedAt: i.startedAt || null,
          })),
      },
      findings: {
        open: openFindings.length,
        recent: openFindings
          .slice()
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
          .slice(0, 10)
          .map((f) => ({
            id: f.id,
            hostId: f.hostId,
            metric: f.metric,
            severity: f.severity,
            kind: f.kind,
            explanation: f.explanation || null,
            createdAt: f.createdAt || null,
          })),
      },
    },
  };
}

module.exports = { buildAdvancedDashboard };
