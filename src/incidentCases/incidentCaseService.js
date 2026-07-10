'use strict';

const { DEFAULT_WINDOW_MS } = require('../analysis/correlator');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Auto-creation + grouping policy for the incident_cases entity. Runs AFTER a
// finding (the system's "anomaly") has been saved by the pipeline, and decides
// which incident it belongs to:
//
//   - a new finding on the same device (host_id) within `windowMs` of an existing
//     OPEN incident's last activity is grouped into that incident (its severity
//     is escalated + last_event_at advanced);
//   - otherwise a fresh incident is opened automatically with status=open.
//
// The window reuses the correlator's default (60s) so incident grouping and
// root-cause correlation see the same "same device / same time window". State
// transitions (investigating/resolved/closed/reopen) and the read API are added
// separately — this service only opens/extends incidents.
//
// Best-effort by contract: the caller wraps every call so a failure here never
// affects ingestion.
//
//   const svc = createIncidentCaseService({ incidentCasesRepo, findingStore });
//   await svc.assignFinding(finding);
function createIncidentCaseService({
  incidentCasesRepo,
  findingStore,
  windowMs = DEFAULT_WINDOW_MS,
  now = () => new Date(),
  logger = silentLogger,
}) {
  // A short, explainable title derived from the primary finding, e.g.
  // "CRIT interface_errors on core-sw". Bounded to the column width.
  function titleFor(finding) {
    const host = finding.hostId == null ? 'unknown device' : String(finding.hostId);
    const metric = finding.metric || 'anomaly';
    const sev = finding.severity || 'INFO';
    return `${sev} ${metric} on ${host}`.slice(0, 255);
  }

  // Places one finding into an incident case. Returns
  // { incidentCaseId, created } or null when the finding can't be placed (no id
  // or host). Never throws — errors are logged and swallowed.
  async function assignFinding(finding) {
    if (!finding || !finding.id || finding.hostId == null) return null;
    const host = String(finding.hostId);
    const at = finding.createdAt ? new Date(finding.createdAt) : now();
    const severity = finding.severity || 'INFO';

    try {
      const open = await incidentCasesRepo.findOpenByHost(host);
      if (open && open.lastEventAt) {
        const withinWindow = at.getTime() - new Date(open.lastEventAt).getTime() <= windowMs;
        if (withinWindow) {
          await incidentCasesRepo.updateActivity(open.id, { lastEventAt: at, severity });
          await findingStore.setIncidentCase(finding.id, open.id);
          return { incidentCaseId: open.id, created: false };
        }
      }

      const id = await incidentCasesRepo.create({
        host_id: host,
        title: titleFor(finding),
        status: 'open',
        severity,
        primary_finding_id: finding.id,
        first_event_at: at,
        last_event_at: at,
        created_by: 'system',
      });
      await findingStore.setIncidentCase(finding.id, id);
      return { incidentCaseId: id, created: true };
    } catch (err) {
      logger.warn(`incident-cases: could not assign finding ${finding.id} (${err.message})`);
      return null;
    }
  }

  return { assignFinding };
}

module.exports = { createIncidentCaseService };
