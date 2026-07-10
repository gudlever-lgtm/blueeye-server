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
//   buildAdvancedDashboard({ incidents, findings, incidentCases })
//
// `incidents`     — probe-outage incident rows (incidentsRepo.list()).
// `findings`      — analysis findings (findingStore.list()).
// `incidentCases` — first-class incidents (incidentCasesRepo.list()); the open
//                   (open|investigating) ones are surfaced as their own widget.
function buildAdvancedDashboard({
  incidents = [],
  findings = [],
  incidentCases = [],
  now = Date.now(),
} = {}) {
  const activeIncidents = (incidents || []).filter((i) => i && i.status === 'active');
  const openFindings = (findings || []).filter((f) => f && !f.acked);
  const openCases = (incidentCases || []).filter((c) => c && (c.status === 'open' || c.status === 'investigating'));

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
      incidentCases: {
        open: openCases.length,
        recent: openCases
          .slice()
          .sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))
          .slice(0, 10)
          .map((c) => ({
            id: c.id,
            deviceId: c.deviceId ?? null,
            title: c.title,
            severity: c.severity,
            status: c.status,
            lastEventAt: c.lastEventAt || null,
          })),
      },
    },
  };
}

module.exports = { buildAdvancedDashboard };
