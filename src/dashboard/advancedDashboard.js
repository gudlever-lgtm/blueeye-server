'use strict';

// Builds the "open issues" rollup the Overview page shows for Professional+
// licences (feature `dashboard_advanced`): the active incidents and the most
// recent unacknowledged analysis findings, composed from data the server
// already holds. Pure and dependency-free so it is unit-testable; the route
// wires the real repositories.
//
// Fleet health and the per-agent "needs attention" list used to live here too,
// but the Overview already renders those (the NOC KPI strip + status chips +
// the worst-first agent table from /api/fleet/health), so they were dropped as
// redundant — this payload is purely the incidents/findings supplement.
//
//   buildAdvancedDashboard({ incidents, findings })
//
// `incidents` — incident rows (incidentsRepo.list(), camelCase API shape).
// `findings`  — analysis findings (findingStore.list()).
function buildAdvancedDashboard({
  incidents = [],
  findings = [],
  now = Date.now(),
} = {}) {
  const activeIncidents = (incidents || []).filter((i) => i && i.status === 'active');
  const openFindings = (findings || []).filter((f) => f && !f.acked);

  return {
    generatedAt: new Date(now).toISOString(),
    widgets: {
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
