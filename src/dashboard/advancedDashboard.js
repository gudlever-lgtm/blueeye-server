'use strict';

// Builds the "open issues" rollup the Overview page shows for Professional+
// licences (feature `dashboard_advanced`): the active probe outages and the most
// recent unacknowledged analysis findings, composed from data the server
// already holds. Pure and dependency-free so it is unit-testable; the route
// wires the real repositories.
//
// Fleet health and the per-agent "needs attention" list used to live here too,
// but the Overview already renders those (the NOC KPI strip + status chips +
// the worst-first agent table from /api/fleet/health), so they were dropped as
// redundant — this payload is purely the outages/findings supplement.
//
//   buildAdvancedDashboard({ probeOutages, findings, eventCases })
//
// `probeOutages` — probe-outage rows (probeOutagesRepo.list()).
// `findings`     — analysis findings (findingStore.list()).
// `eventCases`   — first-class events (eventCasesRepo.list()); the open
//                  (open|investigating) ones are surfaced as their own widget.
function buildAdvancedDashboard({
  probeOutages = [],
  findings = [],
  eventCases = [],
  now = Date.now(),
} = {}) {
  const activeOutages = (probeOutages || []).filter((o) => o && o.status === 'active');
  const openFindings = (findings || []).filter((f) => f && !f.acked);
  const openCases = (eventCases || []).filter((c) => c && (c.status === 'open' || c.status === 'investigating'));

  return {
    generatedAt: new Date(now).toISOString(),
    widgets: {
      probeOutages: {
        active: activeOutages.length,
        recent: activeOutages
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
      eventCases: {
        open: openCases.length,
        recent: openCases
          .slice()
          .sort((a, b) => String(b.lastEventAt || '').localeCompare(String(a.lastEventAt || '')))
          .slice(0, 10)
          .map((c) => ({
            id: c.id,
            // `hostId` is the repository's field name; `deviceId` was read here
            // and never existed, so every row showed a blank device.
            deviceId: c.hostId ?? c.deviceId ?? null,
            // Which machine, and where it stands — same pair the probe-outage
            // widget above carries, so both rollups read alike.
            agentName: c.agentName || null,
            locationName: c.locationName || null,
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
